/**
 * Audio made by the person's own agent (engine/docs/audio.md): one turn of
 * their agent through the connector on their computer, with Open Sourcebook's tools for
 * this item (chat/agent/work.ts). It reads the sources and writes the script
 * part by part, each part tied to the passages it draws on, or marked as
 * background, its own explanation, which it says aloud as such. Every check
 * is the writing tool's answer: a quote not word for word in its passage, a
 * cite on background, markup a voice would read out, words only the writer
 * saw. Each kept part answers with how long it will run spoken against the
 * length asked, as information. What makes something good to listen to is a
 * skill it reads (skills/listening). Then the scenes service on the same
 * computer voices it with the voice videos use, which times every word, and
 * masters the sound; the engine keeps the file.
 *
 *   plan      no call: the passages are checked and the length is decided.
 *   generate  one turn of the agent; each part it writes is kept on the job,
 *             so a retry carries on from what was written and checked.
 *   validate  the same checks in code over the whole script.
 *   repair    once: what failed goes back to the agent, which fixes it.
 *   produce   the scenes service voices and masters it; the file is kept.
 */
import { workPickFor } from "../agent-fields";
import { agentProblemHeard, nextTurnNumber, recordWorkUsage, workFailure, workTurnId, type AgentWork, type WorkTool } from "../../chat/agent/work";
import { outlineOf, sourceTools, type SourceWork } from "../../chat/agent/work-tools";
import { packsNote } from "../../chat/agent/work-skills";
import type { JsonSchema } from "../../chat/agent/tools";
import { JobFailure } from "../../jobs/lifecycle";
import { beyondSources } from "../../sources/beyond";
import { buildPassages, cutNotes, promptLabelLeaks, quoteInPassage, sentenceSpot, type Passage } from "../../sources/passages";
import type { Citation, EngineContext, EngineOutput, JsonValue, NodeSource, OutputEngine, ValidationIssue, ValidationReport } from "../../studio/types";
import type { ItemMaker } from "../makers";
import { PipelineError } from "../retry";
import { AUDIO_LIMITS, AUDIO_SCHEMA_VERSION, clock, minutesWords, spokenSeconds, spokenWords, type AudioCite, type AudioPart, type AudioPayload } from "./contract";
import type { AudioSettings } from "./settings";
import { fitMinutes } from "./settings";
import { AudioVoiceClient, NoVoiceError, VoiceUnreachableError, type VoicingJob } from "./voice-client";

export const AGENT_AUDIO_MAKER_ID = "agent";

export interface AgentAudioBlueprint {
  /** The length asked, in minutes: the item's setting, or one fit to its sources. */
  minutes: number;
}

export interface AgentAudioMakerOptions {
  work: AgentWork;
  voice: AudioVoiceClient;
  /** Wait between reads of the voicing. */
  pollMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Longest the engine follows one voicing. */
  maxMinutes?: number;
  clock?: () => number;
}

/** What the agent has written so far, kept on the job after every change. */
export interface ScriptDraft {
  title?: string;
  about?: string;
  /** How many parts it means to write, when it said. */
  planned?: number;
  parts: AudioPart[];
  note?: string;
  finished: boolean;
}

export interface ScriptWork extends SourceWork {
  byLabel: Map<string, Passage>;
  minutes: number;
  draft: ScriptDraft;
  save(): Promise<void>;
  progress(): number;
}

const DRAFT_KEY = "agent:audio";
const TURNS_KEY = "agent:turns";
const VOICING_KEY = "audio:voicing";

export function createAgentAudioMaker(options: AgentAudioMakerOptions): ItemMaker<AudioSettings, AgentAudioBlueprint, AudioPayload> {
  const problem = () => agentProblemHeard(options.work.heard());
  return {
    id: AGENT_AUDIO_MAKER_ID,
    label: "Your agent",
    usesAgent: true,
    description:
      "Your own agent writes what is said on this computer, part by part, each tied to the passages it draws on, and Open Sourcebook checks every quote; then this computer voices it, with a time for every word. No model cost to Open Sourcebook. Needs the connector and a voice on this computer.",
    engine: new AgentAudioEngine(options),
    maxRepairRounds: 1,
    estimateCost: (input) =>
      input.sourceCount === 0 || input.sourceChars === 0 ? { usd: 0, basis: "no source text to talk about" } : { usd: 0, basis: "written by your own agent and voiced on this computer: no model cost to Open Sourcebook" },
    ready: () => (options.work.heard() ? problem() === undefined : undefined),
    issues: () => {
      const why = problem();
      return why ? [`your agent writes it, and ${why}: start it`] : [];
    },
    status: async () => {
      const status = await options.work.status();
      const why = agentProblemHeard(status);
      const agent = status.agent ? { id: status.agent.id, label: status.agent.label, ...(status.model ? { model: status.model } : {}) } : undefined;
      const voice = options.voice.heard();
      if (voice && !voice.ready) return { available: false, problem: voice.problem ?? "There is no voice on this computer.", ...(agent ? { agent } : {}) };
      return why ? { available: false, problem: `Your agent writes it, and ${why}.`, ...(agent ? { agent } : {}) } : { available: true, ...(agent ? { agent } : {}) };
    },
  };
}

class AgentAudioEngine implements OutputEngine<AudioSettings, AgentAudioBlueprint, AudioPayload> {
  readonly type = "audio";
  readonly schemaVersion = AUDIO_SCHEMA_VERSION;

  constructor(private readonly options: AgentAudioMakerOptions) {}

  async plan(ctx: EngineContext<AudioSettings>): Promise<AgentAudioBlueprint> {
    const passages = requirePassages(ctx);
    await ctx.services.progress({ stage: "planning", progress: 0.02, step: "Getting the sources ready for your agent" });
    const chars = passages.reduce((total, passage) => total + passage.text.length, 0);
    return { minutes: ctx.node.settings.minutes > 0 ? ctx.node.settings.minutes : fitMinutes(chars) };
  }

  async generate(ctx: EngineContext<AudioSettings>, blueprint: AgentAudioBlueprint): Promise<EngineOutput<AudioPayload>> {
    const work = this.workFor(ctx, blueprint);
    if (!work.draft.finished) await this.turn(ctx, work, writePrompt(ctx, work));
    return output(ctx, work);
  }

  async validate(ctx: EngineContext<AudioSettings>, made: EngineOutput<AudioPayload>, blueprint: AgentAudioBlueprint): Promise<ValidationReport> {
    const work = this.workFor(ctx, blueprint);
    return report(checkScript(work, made.payload.parts, made.payload.title));
  }

  async repair(ctx: EngineContext<AudioSettings>, made: EngineOutput<AudioPayload>, validation: ValidationReport, blueprint: AgentAudioBlueprint): Promise<EngineOutput<AudioPayload>> {
    const work = this.workFor(ctx, blueprint);
    const problems = validation.issues.filter((issue) => issue.severity === "error").map((issue) => `${issue.path === "$" ? "The script" : issue.path}: ${issue.message}`);
    work.draft.finished = false;
    await work.save();
    await this.turn(ctx, work, [...itemParts(ctx, work), `You wrote this script (read_script shows it), and Open Sourcebook's last check of the whole found:\n${problems.map((line) => `- ${line}`).join("\n")}\nFix those parts, then call finish_audio again.`].join("\n\n"));
    return output(ctx, work);
  }

  async produce(ctx: EngineContext<AudioSettings>, made: EngineOutput<AudioPayload>): Promise<EngineOutput<AudioPayload>> {
    const client = this.options.voice;
    const kept = ctx.services.checkpoint?.get(VOICING_KEY);
    let id = typeof kept === "string" ? kept : ctx.jobId;
    let job = await this.call(() => client.get(id, ctx.services.signal));
    if (!job || job.state === "failed" || job.state === "stopped") {
      // A voicing that ended without a file is not taken up again: a retry voices it anew.
      if (job) id = `${ctx.jobId}-${Date.now().toString(36)}`;
      await ctx.services.checkpoint?.put(VOICING_KEY, id);
      await ctx.services.progress({ stage: "voicing", progress: 0.9, step: "Voicing it" });
      try {
        await this.call(() => client.start({ id, title: made.payload.title, parts: made.payload.parts.map((part) => ({ id: part.id, text: part.text })) }, ctx.services.signal));
      } catch (error) {
        if (error instanceof NoVoiceError) throw new JobFailure(error.message, false, "maker_unreachable");
        throw error;
      }
      job = undefined;
    }
    const done = await this.follow(ctx, id);
    const result = done.result!;
    const file = await this.call(() => client.file(id, ctx.services.signal));
    const asset = await ctx.services.assets.putAsset(file.bytes, { kind: "audio", contentType: result.contentType || file.contentType });
    if (!asset) throw new PipelineError("No asset store is bound, so the audio file cannot be kept.", "NO_PRODUCTION");
    const times = new Map(result.parts.map((part) => [part.id, part]));
    const parts = made.payload.parts.map((part) => {
      const timed = times.get(part.id);
      return timed ? { ...part, startMs: Math.round(timed.startMs), endMs: Math.round(timed.endMs), words: timed.words.map((word) => ({ text: word.text, startMs: Math.round(word.startMs), endMs: Math.round(word.endMs) })) } : part;
    });
    const heard = this.options.work.heard();
    const payload: AudioPayload = {
      ...made.payload,
      parts,
      file: {
        assetId: asset.id,
        url: asset.url,
        contentType: asset.contentType ?? "audio/mp4",
        bytes: result.bytes || file.bytes.byteLength,
        durationMs: Math.round(result.durationMs),
        voice: { id: result.voice.id, label: result.voice.label },
        ...(result.loudness ? { loudness: result.loudness } : {}),
        madeAt: ctx.services.now(),
        by: { maker: AGENT_AUDIO_MAKER_ID, agent: heard?.agent?.id ?? this.options.work.agent, ...(heard?.model ? { model: heard.model } : {}) },
      },
    };
    await ctx.services.progress({ stage: "produced", progress: 1, step: "Done" });
    return { ...made, payload };
  }

  /** Reads the voicing until it is done, its steps shown on the item; stops it when the job is stopped. */
  private async follow(ctx: EngineContext<AudioSettings>, id: string): Promise<VoicingJob & { result: NonNullable<VoicingJob["result"]> }> {
    const signal = ctx.services.signal;
    const sleep = this.options.sleep ?? wait;
    const now = this.options.clock ?? Date.now;
    const deadline = now() + (this.options.maxMinutes ?? 30) * 60_000;
    let last = "";
    try {
      for (;;) {
        signal?.throwIfAborted();
        const job = await this.call(() => this.options.voice.get(id, signal));
        if (!job) throw new JobFailure(`Open Sourcebook's scene maker has no audio ${id}; it may have been restarted.`, true, "maker_unreachable");
        if (job.step && job.step !== last) {
          last = job.step;
          await ctx.services.progress({ stage: job.state, progress: 0.9 + 0.09 * job.progress, step: job.step });
        }
        if (job.state === "done") {
          if (!job.result) throw new JobFailure(`Open Sourcebook's scene maker finished audio ${id} without its times.`, false, "maker_unreachable");
          return job as VoicingJob & { result: NonNullable<VoicingJob["result"]> };
        }
        if (job.state === "failed" || job.state === "stopped") {
          throw new JobFailure(job.failure?.message || `The voicing of this audio ended as ${job.state}.`, job.failure?.code === "error", job.state === "stopped" ? "stopped" : "maker_unreachable");
        }
        if (now() > deadline) {
          await this.options.voice.stop(id);
          throw new JobFailure(`Voicing audio ${id} ran past ${this.options.maxMinutes ?? 30} minutes, so Open Sourcebook stopped it.`, false, "timed_out");
        }
        await sleep(this.options.pollMs ?? 1_500, signal).catch(() => undefined);
      }
    } catch (error) {
      if (signal?.aborted) await this.options.voice.stop(id);
      throw error;
    }
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VoiceUnreachableError) throw new JobFailure(error.message, true, "maker_unreachable");
      throw error;
    }
  }

  private workFor(ctx: EngineContext<AudioSettings>, blueprint: AgentAudioBlueprint): ScriptWork {
    const passages = requirePassages(ctx);
    const work: ScriptWork = {
      passages,
      packs: ctx.project?.packs ?? [],
      byLabel: new Map(passages.map((passage) => [passage.label, passage])),
      minutes: blueprint.minutes,
      draft: readDraft(ctx.services.checkpoint?.get(DRAFT_KEY)),
      save: async () => {
        await ctx.services.checkpoint?.put(DRAFT_KEY, work.draft as unknown as JsonValue);
      },
      progress: () => 0.08 + 0.75 * Math.min(1, scriptSeconds(work.draft.parts) / Math.max(30, work.minutes * 60)),
    };
    return work;
  }

  private async turn(ctx: EngineContext<AudioSettings>, work: ScriptWork, prompt: string): Promise<void> {
    const number = nextTurnNumber(ctx.services.checkpoint?.get(TURNS_KEY));
    await ctx.services.checkpoint?.put(TURNS_KEY, number);
    await ctx.services.progress({ stage: "writing", progress: work.progress(), step: work.draft.parts.length ? "Asking your agent to carry on" : "Asking your agent to start" });
    const end = await this.options.work.run({
      turnId: workTurnId(ctx.jobId, number),
      target: { type: ctx.node.type, id: ctx.node.id },
      pick: await workPickFor(ctx),
      systemPrompt: SYSTEM_PROMPT,
      prompt,
      instructions: "Open Sourcebook's tools for writing one audio walk-through from this item's sources. Finish with finish_audio.",
      tools: audioTools(),
      work,
      ...(ctx.services.signal ? { signal: ctx.services.signal } : {}),
      step: (label) => Promise.resolve(ctx.services.progress({ stage: "writing", progress: work.progress(), step: label })),
      heartbeat: () => Promise.resolve(ctx.services.progress({ stage: "writing", progress: work.progress() })),
    });
    await recordWorkUsage(ctx.services.usage, ctx.jobId, end, this.options.work.agent);
    if (work.draft.finished) return;
    if (end.outcome === "failed") throw workFailure(end, "audio");
    // The agent ended without saying it was finished: what it wrote stands if it passes as a whole.
    const errors = checkScript(work, work.draft.parts, work.draft.title ?? ctx.node.title).filter((issue) => issue.severity === "error");
    if (work.draft.parts.length === 0 || errors.length > 0) throw new JobFailure("The agent ended its turn without finishing the audio.", false, "agent_dropped");
  }
}

const SYSTEM_PROMPT = `You are writing one audio walk-through in Open Sourcebook, the notebook that turns a person's own sources into things to learn from. It is something they listen to with no picture, while walking, commuting or doing something else: one voice, speaking what you write word for word.

You work only through Open Sourcebook's tools: read the sources with outline_sources, read_passages and search_passages; write the script with plan_audio, write_part, change_part, remove_part and read_script; and say it is done with finish_audio. You cannot see files, run commands or browse the web here.

Open Sourcebook's listening skill holds what makes something good to listen to; read it (read_skill "listening") before you plan, and the notebook skill on what the source says and what you add. Each part you write is checked as you send it, and the tool's answer says what to fix when something is wrong, and how long the script runs so far against the length asked. When the whole script is written and you have read it back as a listener would hear it, call finish_audio, then end your turn.`;

function writePrompt(ctx: EngineContext<AudioSettings>, work: ScriptWork): string {
  const parts = itemParts(ctx, work);
  if (work.draft.parts.length > 0) {
    parts.push(`You already wrote ${work.draft.parts.length} part${work.draft.parts.length === 1 ? "" : "s"} of this script in an earlier turn, each checked and kept. Read them back with read_script and carry on from there; change or remove any that should be better.`);
  }
  parts.push("Write the audio.");
  return parts.join("\n\n");
}

function itemParts(ctx: EngineContext<AudioSettings>, work: ScriptWork): string[] {
  const parts: string[] = [];
  if (ctx.project?.title) parts.push(`Project: ${ctx.project.title}`);
  const packs = packsNote(ctx.project?.packs ?? []);
  if (packs) parts.push(packs);
  parts.push(`Item: ${ctx.node.title.trim() || "an audio walk-through"}`);
  parts.push(ctx.node.prompt.trim() ? `Brief (what this audio is for and what it covers; it is not a source, so nothing in it is a fact until a passage says it):\n${ctx.node.prompt.trim()}` : "Brief: none. Walk through the main ideas of the sources, in the order a listener needs them.");
  parts.push(
    ctx.node.settings.minutes > 0
      ? `Length: about ${minutesWords(work.minutes)} spoken (about ${Math.round(work.minutes * 140)} words at a speaking pace).`
      : `Length: not set, so fit to the brief and the sources; about ${minutesWords(work.minutes)} spoken is what their size suggests (about ${Math.round(work.minutes * 140)} words). Go shorter or longer when the material calls for it, and say why when you finish.`,
  );
  if (ctx.assumes.length > 0) {
    parts.push(`The person has already been through these items of the plan (build on them, do not repeat them; what you say still comes only from the sources):\n${ctx.assumes.map((prior) => `- ${prior.type} "${prior.title}": ${prior.summary}`).join("\n")}`);
  }
  const cut = cutNotes(ctx.sources);
  if (cut.length > 0) parts.push(cut.join("\n"));
  parts.push(outlineOf(work.passages));
  return parts;
}

/** The tools for an audio: the source tools, then the writing tools. */
export function audioTools(): WorkTool<ScriptWork>[] {
  return [...sourceTools<ScriptWork>(), planAudio, writePart, changePart, removePart, readScript, finishAudio];
}

const PART_PROPERTIES: Record<string, JsonSchema> = {
    title: { type: "string", description: `A few words naming the part (at most ${AUDIO_LIMITS.partTitle} characters), shown above it in the transcript; it is not spoken.` },
    text: { type: "string", description: `Exactly what the voice says, as plain spoken words: no markup, lists, symbols to read out or labels (at most ${AUDIO_LIMITS.partText} characters).` },
    background: { type: "boolean", description: "True when the part is your own explanation, not what the sources say: it has no cites, and its words must tell the listener it is an aside of yours." },
    cites: {
      type: "array",
      description: `The passages the part draws on, each {"passage":"P3","quote":"a few words copied exactly from that passage"} (at most ${AUDIO_LIMITS.cites}). Leave it out for background.`,
    items: { type: "object", properties: { passage: { type: "string" }, quote: { type: "string" } }, required: ["passage", "quote"] },
  },
};
const PART_REQUIRED = ["title", "text"];

const planAudio: WorkTool<ScriptWork> = {
  name: "plan_audio",
  description: "Sets the audio's title, what it walks through in a sentence (shown in lists), and how many parts you mean to write, so the person sees how far the writing is. You can call it again.",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" }, about: { type: "string" }, parts: { type: "integer", minimum: 1, maximum: AUDIO_LIMITS.parts } },
    required: ["title"],
    additionalProperties: false,
  },
  label: () => "Planning the audio",
  async run(input, work) {
    const title = text(input.title);
    if (!title) return { text: "`title` is required.", isError: true };
    work.draft.title = title.slice(0, AUDIO_LIMITS.title);
    const about = text(input.about);
    if (about) work.draft.about = about.slice(0, AUDIO_LIMITS.about);
    if (typeof input.parts === "number" && input.parts > 0) work.draft.planned = Math.min(AUDIO_LIMITS.parts, Math.round(input.parts));
    await work.save();
    return { text: `Kept: "${work.draft.title}"${work.draft.planned ? `, ${work.draft.planned} parts` : ""}, about ${minutesWords(work.minutes)} asked. Write the parts with write_part, in speaking order.` };
  },
};

const writePart: WorkTool<ScriptWork> = {
  name: "write_part",
  description: `Adds one part to the script, after the last one (or after the part named in \`after\`). A part is one stretch of what the voice says, usually one idea, a few sentences to a minute or two spoken. It draws on passages it cites, each with a few words copied exactly from that passage; or it is background (\`background\`: true), your own explanation beyond the sources, with no cites, whose words tell the listener it is your aside. It is checked when you send it: plain spoken words with no markup, every cite's passage and quote word for word, no cite on background. The answer says how long it runs spoken and how long the script is so far against the length asked.`,
  inputSchema: { type: "object", required: PART_REQUIRED, additionalProperties: false, properties: { ...PART_PROPERTIES, after: { type: "string", description: "The id of the part to put it after (p0 for the very start); after the last when left out." } } },
  label: (_input, work) => {
    const n = work.draft.parts.length + 1;
    return work.draft.planned && n <= work.draft.planned ? `Writing part ${n} of ${work.draft.planned}` : `Writing part ${n}`;
  },
  async run(input, work) {
    if (work.draft.parts.length >= AUDIO_LIMITS.parts) return { text: `The script has ${AUDIO_LIMITS.parts} parts, the most an audio has; join or remove some instead.`, isError: true };
    const checked = checkPart(input, work);
    if ("problems" in checked) return refuse(checked.problems);
    const after = text(input.after);
    const at = after === "p0" ? 0 : after ? work.draft.parts.findIndex((part) => part.id === after) + 1 : work.draft.parts.length;
    if (after && after !== "p0" && at === 0) return { text: `There is no part "${after}"; read_script lists them.`, isError: true };
    work.draft.parts.splice(at, 0, checked.part);
    renumber(work.draft);
    work.draft.finished = false;
    await work.save();
    return { text: keptLine(work.draft.parts[at]!, work, checked.notes) };
  },
};

const changePart: WorkTool<ScriptWork> = {
  name: "change_part",
  description: "Replaces one part you wrote with a new version, checked the same way as write_part. Send the whole part.",
  inputSchema: { type: "object", additionalProperties: false, properties: { id: { type: "string", description: "The part's id, from read_script." }, ...PART_PROPERTIES }, required: ["id", ...PART_REQUIRED] },
  label: (input) => `Improving part ${String(input.id ?? "").replace(/^p/, "")}`.trim(),
  async run(input, work) {
    const at = work.draft.parts.findIndex((part) => part.id === input.id);
    if (at < 0) return { text: `There is no part "${String(input.id)}"; read_script lists them.`, isError: true };
    const checked = checkPart(input, work);
    if ("problems" in checked) return refuse(checked.problems);
    work.draft.parts[at] = { ...checked.part, id: work.draft.parts[at]!.id };
    work.draft.finished = false;
    await work.save();
    return { text: keptLine(work.draft.parts[at]!, work, checked.notes) };
  },
};

const removePart: WorkTool<ScriptWork> = {
  name: "remove_part",
  description: "Removes one part you wrote; the ones after it move up a number.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  label: () => "Removing a part",
  async run(input, work) {
    const at = work.draft.parts.findIndex((part) => part.id === input.id);
    if (at < 0) return { text: `There is no part "${String(input.id)}"; read_script lists them.`, isError: true };
    work.draft.parts.splice(at, 1);
    renumber(work.draft);
    work.draft.finished = false;
    await work.save();
    return { text: `Removed. The script has ${work.draft.parts.length} part${work.draft.parts.length === 1 ? "" : "s"} and runs about ${clock(scriptSeconds(work.draft.parts) * 1000)} spoken, of about ${minutesWords(work.minutes)} asked.` };
  },
};

const readScript: WorkTool<ScriptWork> = {
  name: "read_script",
  description: "Reads back the script as written so far, in speaking order: each part's id, title, how long it runs spoken, whether it is background, its words and its cites. Read it as a listener would hear it, start to end.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  label: () => "Reading the script back",
  run: (_input, work) => ({ text: renderDraft(work) }),
};

const finishAudio: WorkTool<ScriptWork> = {
  name: "finish_audio",
  description:
    "Says the script is finished. The whole is checked once more (a title, at least one part, each as write_part checks it); when it passes it is kept, this computer voices it, and you end your turn. When it runs clearly shorter or longer than the length asked, give `note`.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The audio's title, if not set with plan_audio or to change it." },
      about: { type: "string", description: "What it walks through, in a sentence, if not set with plan_audio." },
      note: { type: "string", description: "When it runs clearly shorter or longer than asked: one plain sentence to the person on why." },
    },
    additionalProperties: false,
  },
  label: () => "Checking the whole script",
  async run(input, work) {
    const title = text(input.title);
    if (title) work.draft.title = title.slice(0, AUDIO_LIMITS.title);
    const about = text(input.about);
    if (about) work.draft.about = about.slice(0, AUDIO_LIMITS.about);
    if (!work.draft.title) return { text: "The audio needs a title: give one here or with plan_audio.", isError: true };
    if (work.draft.parts.length === 0) return { text: "The script has no parts yet; write them with write_part.", isError: true };
    const note = text(input.note);
    if (note) work.draft.note = note.slice(0, AUDIO_LIMITS.lengthNote);
    const errors = checkScript(work, work.draft.parts, work.draft.title).filter((issue) => issue.severity === "error");
    if (errors.length > 0) return refuse(errors.map((issue) => `${issue.path}: ${issue.message}`));
    const seconds = scriptSeconds(work.draft.parts);
    const asked = work.minutes * 60;
    if (Math.abs(seconds - asked) > Math.max(60, asked * 0.3) && !work.draft.note) {
      await work.save();
      return {
        text: `The script runs about ${clock(seconds * 1000)} spoken and about ${minutesWords(work.minutes)} was asked; the person saw that length. If this length is right, call finish_audio again with \`note\`: why, in a sentence to them. Otherwise write or remove parts first.`,
        isError: true,
      };
    }
    work.draft.finished = true;
    await work.save();
    return { text: `The script is finished and kept: "${work.draft.title}", ${work.draft.parts.length} part${work.draft.parts.length === 1 ? "" : "s"}, about ${clock(seconds * 1000)} spoken. This computer voices it next. End your turn now.` };
  },
};

/** Marks a voice would read out or trip on: markdown emphasis, code, headings, list marks. */
const MARKUP = /\*\*|__|`|^\s*#{1,6}\s|^\s*[-*•]\s|\$\$|\\\(|\\\[/m;

/**
 * One part as the agent sent it, checked: a title, plain spoken words of a
 * size one request can voice, and its cites (word for word) or none when it
 * is background. Notes are information for the writer, never a refusal.
 */
export function checkPart(input: Record<string, unknown>, work: Pick<ScriptWork, "passages" | "byLabel">): { part: AudioPart; notes: string[] } | { problems: string[] } {
  const problems: string[] = [];
  const title = text(input.title);
  const said = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
  const background = input.background === true;
  if (!title) problems.push("title: name the part in a few words.");
  else if (title.length > AUDIO_LIMITS.partTitle) problems.push(`title: at most ${AUDIO_LIMITS.partTitle} characters.`);
  if (!said) problems.push("text: write what the voice says.");
  else if (said.length > AUDIO_LIMITS.partText) problems.push(`text: ${said.length} characters is more than one part holds (${AUDIO_LIMITS.partText}); split it into two parts.`);
  const raw = typeof input.text === "string" ? input.text : "";
  if (MARKUP.test(raw)) problems.push("text: it is read aloud word for word, so it holds no markup, list marks, headings or maths notation; write it as you would say it.");
  const leaks = promptLabelLeaks(said, work.passages);
  if (leaks.length > 0) problems.push(`text: the listener never hears of passages or their labels (${leaks.join(", ")}); name the source by its title, or just say what it says.`);
  const cites = Array.isArray(input.cites) ? input.cites : typeof input.cites === "string" ? parseList(input.cites) : [];
  if (background && cites.length > 0) problems.push("cites: a background part is your own explanation, so it cites nothing; if it says what a source says, make it a part of its own that cites it.");
  if (!background && cites.length === 0) problems.push('cites: name the passages this part draws on, {"passage":"P3","quote":"..."}; or, if it is your own explanation, set background to true.');
  if (cites.length > AUDIO_LIMITS.cites) problems.push(`cites: at most ${AUDIO_LIMITS.cites}.`);
  const kept: AudioCite[] = [];
  if (!background) {
    cites.forEach((cite, index) => {
      if (!isRecord(cite) || typeof cite.passage !== "string") return void problems.push(`cites[${index}]: name a passage, {"passage":"P3","quote":"..."}.`);
      const passage = work.byLabel.get(cite.passage.trim());
      if (!passage) return void problems.push(`cites[${index}]: "${cite.passage}" is not a passage of this item; its passages are ${work.passages[0]?.label}–${work.passages.at(-1)?.label}.`);
      const quote = typeof cite.quote === "string" ? cite.quote.trim() : "";
      if (!quote) return void problems.push(`cites[${index}].quote: copy a few words from ${passage.label} that carry what this part says.`);
      if (quote.length > AUDIO_LIMITS.quote) return void problems.push(`cites[${index}].quote: at most ${AUDIO_LIMITS.quote} characters; quote a shorter span.`);
      if (!quoteInPassage(quote, passage)) return void problems.push(`cites[${index}].quote: not word for word in ${passage.label}; copy the words again exactly as they stand there, or quote a shorter span.`);
      kept.push(citeOf(passage, quote));
    });
  }
  if (problems.length > 0) return { problems };
  const notes: string[] = [];
  if (!background) {
    const beyond = beyondSources(said, work.passages.map((passage) => passage.text));
    if (beyond.numbers.length > 0) {
      notes.push(`Kept, but your sources do not contain ${beyond.numbers.join(", ")}. A listener cannot tell what their source says from what you add unless you say it: if a source says it, cite that passage; if it is yours (an example, a usual figure), say so in the words, or make it a background part.`);
    }
  } else {
    notes.push("Kept as background. A listener cannot see that it is marked: make sure its words say it is your explanation, not what their sources say.");
  }
  return { part: { id: "p0", title: title!, text: said, background, cites: kept }, notes };
}

/** Every check of the script in code, over these parts. */
export function checkScript(work: Pick<ScriptWork, "passages" | "byLabel">, parts: AudioPart[], title: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!title.trim()) issues.push(issue("$.title", "no_title", "the audio needs a title"));
  if (parts.length === 0) issues.push(issue("$.parts", "empty", "the script has no parts"));
  if (parts.length > AUDIO_LIMITS.parts) issues.push(issue("$.parts", "too_many", `at most ${AUDIO_LIMITS.parts} parts`));
  const byId = new Map(work.passages.map((passage) => [passage.id, passage]));
  const label = new Map(work.passages.map((passage) => [passage.id, passage.label]));
  parts.forEach((part, at) => {
    const sent = {
      title: part.title,
      text: part.text,
      background: part.background,
      cites: part.cites.map((cite) => ({ passage: label.get(passageIdOf(cite, byId) ?? "") ?? "?", quote: cite.quote })),
    };
    const checked = checkPart(sent, work);
    if ("problems" in checked) for (const problem of checked.problems) issues.push(issue(`${part.id}`, "part", problem));
    void at;
  });
  return issues;
}

function passageIdOf(cite: AudioCite, byId: Map<string, unknown>): string | undefined {
  if (cite.chunkId && byId.has(cite.chunkId)) return cite.chunkId;
  const ranged = cite.locator?.charStart !== undefined ? `${cite.sourceId}@${cite.locator.charStart}-${cite.locator.charEnd}` : undefined;
  return ranged && byId.has(ranged) ? ranged : undefined;
}

function citeOf(passage: Passage, quote: string): AudioCite {
  return {
    sourceId: passage.sourceId,
    ...(passage.chunkId ? { chunkId: passage.chunkId } : {}),
    ...(passage.locator ? { locator: passage.locator } : {}),
    quote: sentenceSpot(quote, passage),
  };
}

function renumber(draft: ScriptDraft): void {
  draft.parts = draft.parts.map((part, at) => ({ ...part, id: `p${at + 1}` }));
}

function scriptSeconds(parts: AudioPart[]): number {
  // Each part break is a short pause beside the words.
  return parts.reduce((total, part) => total + spokenSeconds(part.text), 0) + Math.max(0, parts.length - 1) * 1.2;
}

function keptLine(part: AudioPart, work: ScriptWork, notes: string[]): string {
  const at = work.draft.parts.findIndex((other) => other.id === part.id) + 1;
  const planned = work.draft.planned ? ` (${work.draft.planned} planned)` : "";
  const words = spokenWords(part.text).length;
  const head = `Kept as ${part.id}, part ${at} of ${work.draft.parts.length}${planned}${part.background ? ", background" : ""}: ${words} words, about ${clock(spokenSeconds(part.text) * 1000)} spoken. The script so far runs about ${clock(scriptSeconds(work.draft.parts) * 1000)} of about ${minutesWords(work.minutes)} asked.`;
  return [head, ...notes].join("\n");
}

function renderDraft(work: ScriptWork): string {
  const { draft } = work;
  const byId = new Map(work.passages.map((passage) => [passage.id, passage]));
  const head = `Title: ${draft.title ?? "(none yet)"}\nAbout: ${draft.about ?? "(none yet)"}\n${draft.parts.length} part${draft.parts.length === 1 ? "" : "s"}${draft.finished ? ", finished" : ""}${draft.planned ? ` (${draft.planned} planned)` : ""}, about ${clock(scriptSeconds(draft.parts) * 1000)} spoken of about ${minutesWords(work.minutes)} asked.`;
  const parts = draft.parts.map((part) => {
    const cites = part.cites.map((cite) => `${byId.get(passageIdOf(cite, byId) ?? "")?.label ?? cite.sourceId}: "${cite.quote}"`);
    return `## ${part.id} · ${part.title}${part.background ? " · background" : ""} · about ${clock(spokenSeconds(part.text) * 1000)}\n${part.text}${cites.length ? `\nCites: ${cites.join("; ")}` : ""}`;
  });
  return [head, ...parts].join("\n\n");
}

function output(ctx: EngineContext<AudioSettings>, work: ScriptWork): EngineOutput<AudioPayload> {
  void ctx.services.progress({ stage: "verifying", progress: 0.86, step: "Checking the script" });
  const title = (work.draft.title ?? ctx.node.title.trim()) || "Audio";
  const parts = work.draft.parts;
  const about = work.draft.about ?? parts.find((part) => !part.background)?.text.split(/(?<=[.!?])\s/)[0] ?? title;
  const payload: AudioPayload = { schemaVersion: AUDIO_SCHEMA_VERSION, title, about, parts, ...(work.draft.note ? { lengthNote: work.draft.note } : {}) };
  const citations: Citation[] = parts.flatMap((part, at) =>
    part.cites.map((cite) => ({ sourceId: cite.sourceId, ...(cite.chunkId ? { chunkId: cite.chunkId } : {}), ...(cite.locator ? { locator: cite.locator } : {}), quote: cite.quote, anchor: `parts[${at}]` })),
  );
  const summary = `An audio walk-through of about ${clock(scriptSeconds(parts) * 1000)}: ${parts.map((part) => part.title).slice(0, 6).join("; ")}${parts.length > 6 ? `; and ${parts.length - 6} more parts` : ""}.`;
  return { title, summary, payload, citations };
}

function readDraft(value: JsonValue | undefined): ScriptDraft {
  if (isRecord(value) && Array.isArray(value.parts)) {
    const parts = (value.parts as unknown[]).filter((part): part is AudioPart => isRecord(part) && typeof part.text === "string" && typeof part.title === "string" && Array.isArray(part.cites));
    return {
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      ...(typeof value.about === "string" ? { about: value.about } : {}),
      ...(typeof value.planned === "number" ? { planned: value.planned } : {}),
      ...(typeof value.note === "string" ? { note: value.note } : {}),
      parts,
      finished: value.finished === true && parts.length > 0,
    };
  }
  return { parts: [], finished: false };
}

function readSources(sources: NodeSource[]): NodeSource[] {
  return sources.filter((source) => source.envelope.accessLevel !== "metadata" && source.envelope.accessLevel !== "none");
}

function requirePassages(ctx: EngineContext<AudioSettings>): Passage[] {
  const passages = buildPassages(readSources(ctx.sources));
  if (passages.length === 0) throw new PipelineError("An audio needs source text to talk about; this item has none that could be read.", "NO_SOURCE_TEXT");
  return passages;
}

function parseList(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function refuse(problems: string[]): { text: string; isError: true } {
  return { text: `Not kept. Fix this and send it again:\n${problems.map((line) => `- ${line}`).join("\n")}`, isError: true };
}

function report(issues: ValidationIssue[]): ValidationReport {
  return { valid: !issues.some((entry) => entry.severity === "error"), issues };
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message, severity: "error" };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
