/**
 * A guide made by the person's own agent (engine/docs/guide.md): one turn of
 * their agent through the connector on their computer, with Open Sourcebook's tools for
 * this item (chat/agent/work.ts). It reads the sources and writes the guide
 * section by section, each a list of points, each point tied to the passages
 * it rests on or marked as background, its own explanation, which the page
 * shows as such. Every check is the writing tool's answer: a quote not word
 * for word in its passage, a cite on background, a heading or a list inside
 * a point, words only the writer saw. Each kept section answers with how
 * many pages the guide fills so far against the pages asked, as information.
 * What makes a good guide is a skill it reads (skills/guide).
 *
 *   plan      no call: the passages are checked and the length is decided.
 *   generate  one turn of the agent; each section it writes is kept on the
 *             job, so a retry carries on from what was written and checked.
 *   validate  the same checks in code over the whole guide.
 *   repair    once: what failed goes back to the agent, which fixes it.
 *   produce   nothing more to make: the page is drawn from the payload.
 */
import { workPickFor } from "../agent-fields";
import { agentProblemHeard, nextTurnNumber, recordWorkUsage, workFailure, workTurnId, type AgentWork, type WorkTool } from "../../chat/agent/work";
import { outlineOf, sourceTools, type SourceWork } from "../../chat/agent/work-tools";
import { packsNote } from "../../chat/agent/work-skills";
import type { JsonSchema } from "../../chat/agent/tools";
import { JobFailure } from "../../jobs/lifecycle";
import { beyondSources } from "../../sources/beyond";
import { buildPassages, cutNotes, promptLabelLeaks, quoteInPassage, sentenceSpot, type Passage } from "../../sources/passages";
import type { EngineContext, EngineOutput, JsonValue, NodeSource, OutputEngine, ValidationIssue, ValidationReport } from "../../studio/types";
import type { ItemMaker } from "../makers";
import { PipelineError } from "../retry";
import { GUIDE_LIMITS, GUIDE_SCHEMA_VERSION, WORDS_PER_PAGE, guideWords, pagesOf, pagesWords, guideCitations, type GuideCite, type GuidePayload, type GuidePoint, type GuideSection } from "./contract";
import { fitPages, type GuideSettings } from "./settings";

export const AGENT_GUIDE_MAKER_ID = "agent";

export interface AgentGuideBlueprint {
  /** The pages asked: the item's setting, or a length fit to its sources. */
  pages: number;
}

export interface AgentGuideMakerOptions {
  work: AgentWork;
}

/** What the agent has written so far, kept on the job after every change. */
export interface GuideDraft {
  title?: string;
  about?: string;
  /** How many sections it means to write, when it said. */
  planned?: number;
  sections: GuideSection[];
  note?: string;
  finished: boolean;
}

export interface GuideWork extends SourceWork {
  byLabel: Map<string, Passage>;
  pages: number;
  draft: GuideDraft;
  save(): Promise<void>;
  progress(): number;
}

const DRAFT_KEY = "agent:guide";
const TURNS_KEY = "agent:turns";

export function createAgentGuideMaker(options: AgentGuideMakerOptions): ItemMaker<GuideSettings, AgentGuideBlueprint, GuidePayload> {
  const problem = () => agentProblemHeard(options.work.heard());
  return {
    id: AGENT_GUIDE_MAKER_ID,
    label: "Your agent",
    usesAgent: true,
    description: "Your own agent writes the guide on this computer, section by section, each point tied to the passages it rests on, and Open Sourcebook checks every quote. No model cost to Open Sourcebook. Needs the connector.",
    engine: new AgentGuideEngine(options),
    maxRepairRounds: 1,
    estimateCost: (input) => (input.sourceCount === 0 || input.sourceChars === 0 ? { usd: 0, basis: "no source text to write about" } : { usd: 0, basis: "written by your own agent: no model cost to Open Sourcebook" }),
    ready: () => (options.work.heard() ? problem() === undefined : undefined),
    issues: () => {
      const why = problem();
      return why ? [`your agent writes it, and ${why}: start it`] : [];
    },
    status: async () => {
      const status = await options.work.status();
      const why = agentProblemHeard(status);
      const agent = status.agent ? { id: status.agent.id, label: status.agent.label, ...(status.model ? { model: status.model } : {}) } : undefined;
      return why ? { available: false, problem: `Your agent writes it, and ${why}.`, ...(agent ? { agent } : {}) } : { available: true, ...(agent ? { agent } : {}) };
    },
  };
}

class AgentGuideEngine implements OutputEngine<GuideSettings, AgentGuideBlueprint, GuidePayload> {
  readonly type = "guide";
  readonly schemaVersion = GUIDE_SCHEMA_VERSION;

  constructor(private readonly options: AgentGuideMakerOptions) {}

  async plan(ctx: EngineContext<GuideSettings>): Promise<AgentGuideBlueprint> {
    const passages = requirePassages(ctx);
    await ctx.services.progress({ stage: "planning", progress: 0.02, step: "Getting the sources ready for your agent" });
    const chars = passages.reduce((total, passage) => total + passage.text.length, 0);
    return { pages: ctx.node.settings.pages > 0 ? ctx.node.settings.pages : fitPages(chars) };
  }

  async generate(ctx: EngineContext<GuideSettings>, blueprint: AgentGuideBlueprint): Promise<EngineOutput<GuidePayload>> {
    const work = this.workFor(ctx, blueprint);
    if (!work.draft.finished) await this.turn(ctx, work, writePrompt(ctx, work));
    return output(ctx, work);
  }

  async validate(ctx: EngineContext<GuideSettings>, made: EngineOutput<GuidePayload>, blueprint: AgentGuideBlueprint): Promise<ValidationReport> {
    const work = this.workFor(ctx, blueprint);
    return report(checkGuide(work, made.payload.sections, made.payload.title));
  }

  async repair(ctx: EngineContext<GuideSettings>, made: EngineOutput<GuidePayload>, validation: ValidationReport, blueprint: AgentGuideBlueprint): Promise<EngineOutput<GuidePayload>> {
    const work = this.workFor(ctx, blueprint);
    const problems = validation.issues.filter((issue) => issue.severity === "error").map((issue) => `${issue.path === "$" ? "The guide" : issue.path}: ${issue.message}`);
    work.draft.finished = false;
    await work.save();
    await this.turn(ctx, work, [...itemParts(ctx, work), `You wrote this guide (read_guide shows it), and Open Sourcebook's last check of the whole found:\n${problems.map((line) => `- ${line}`).join("\n")}\nFix those sections, then call finish_guide again.`].join("\n\n"));
    return output(ctx, work);
  }

  async produce(ctx: EngineContext<GuideSettings>, made: EngineOutput<GuidePayload>): Promise<EngineOutput<GuidePayload>> {
    await ctx.services.progress({ stage: "produced", progress: 1, step: "Done" });
    return made;
  }

  private workFor(ctx: EngineContext<GuideSettings>, blueprint: AgentGuideBlueprint): GuideWork {
    const passages = requirePassages(ctx);
    const work: GuideWork = {
      passages,
      packs: ctx.project?.packs ?? [],
      byLabel: new Map(passages.map((passage) => [passage.label, passage])),
      pages: blueprint.pages,
      draft: readDraft(ctx.services.checkpoint?.get(DRAFT_KEY)),
      save: async () => {
        await ctx.services.checkpoint?.put(DRAFT_KEY, work.draft as unknown as JsonValue);
      },
      progress: () => 0.08 + 0.75 * Math.min(1, guideWords(work.draft) / Math.max(150, work.pages * WORDS_PER_PAGE)),
    };
    return work;
  }

  private async turn(ctx: EngineContext<GuideSettings>, work: GuideWork, prompt: string): Promise<void> {
    const number = nextTurnNumber(ctx.services.checkpoint?.get(TURNS_KEY));
    await ctx.services.checkpoint?.put(TURNS_KEY, number);
    await ctx.services.progress({ stage: "writing", progress: work.progress(), step: work.draft.sections.length ? "Asking your agent to carry on" : "Asking your agent to start" });
    const end = await this.options.work.run({
      turnId: workTurnId(ctx.jobId, number),
      target: { type: ctx.node.type, id: ctx.node.id },
      pick: await workPickFor(ctx),
      systemPrompt: SYSTEM_PROMPT,
      prompt,
      instructions: "Open Sourcebook's tools for writing one guide from this item's sources. Finish with finish_guide.",
      tools: guideTools(),
      work,
      ...(ctx.services.signal ? { signal: ctx.services.signal } : {}),
      step: (label) => Promise.resolve(ctx.services.progress({ stage: "writing", progress: work.progress(), step: label })),
      heartbeat: () => Promise.resolve(ctx.services.progress({ stage: "writing", progress: work.progress() })),
    });
    await recordWorkUsage(ctx.services.usage, ctx.jobId, end, this.options.work.agent);
    if (work.draft.finished) return;
    if (end.outcome === "failed") throw workFailure(end, "guide");
    // The agent ended without saying it was finished: what it wrote stands if it passes as a whole.
    const errors = checkGuide(work, work.draft.sections, work.draft.title ?? ctx.node.title).filter((issue) => issue.severity === "error");
    if (work.draft.sections.length === 0 || errors.length > 0) throw new JobFailure("The agent ended its turn without finishing the guide.", false, "agent_dropped");
  }
}

const SYSTEM_PROMPT = `You are writing one guide in Open Sourcebook, the notebook that turns a person's own sources into things to learn from. A guide is a page or a few of notes the person keeps, prints and changes by hand afterwards: a reference to come back to, not a lesson to sit through. Every claim on it carries its cite.

You work only through Open Sourcebook's tools: read the sources with outline_sources, read_passages and search_passages; write the guide with plan_guide, write_section, change_section, remove_section and read_guide; and say it is done with finish_guide. You cannot see files, run commands or browse the web here.

Open Sourcebook's guide skill holds what makes a good guide; read it (read_skill "guide") before you plan, and the notebook skill on what the source says and what you add. Each section you write is checked as you send it, and the tool's answer says what to fix when something is wrong, and how many pages the guide fills so far against the pages asked. When the whole guide is written and you have read it back as the person would use it, call finish_guide, then end your turn.`;

function writePrompt(ctx: EngineContext<GuideSettings>, work: GuideWork): string {
  const parts = itemParts(ctx, work);
  if (work.draft.sections.length > 0) {
    parts.push(`You already wrote ${work.draft.sections.length} section${work.draft.sections.length === 1 ? "" : "s"} of this guide in an earlier turn, each checked and kept. Read them back with read_guide and carry on from there; change or remove any that should be better.`);
  }
  parts.push("Write the guide.");
  return parts.join("\n\n");
}

function itemParts(ctx: EngineContext<GuideSettings>, work: GuideWork): string[] {
  const parts: string[] = [];
  if (ctx.project?.title) parts.push(`Project: ${ctx.project.title}`);
  const packs = packsNote(ctx.project?.packs ?? []);
  if (packs) parts.push(packs);
  parts.push(`Item: ${ctx.node.title.trim() || "a guide"}`);
  parts.push(ctx.node.prompt.trim() ? `Brief (what this guide is for and what it covers; it is not a source, so nothing in it is a fact until a passage says it):\n${ctx.node.prompt.trim()}` : "Brief: none. Keep what someone would come back to in these sources, in the order they would look for it.");
  const words = Math.round(work.pages * WORDS_PER_PAGE);
  parts.push(
    ctx.node.settings.pages > 0
      ? `Length: about ${pagesWords(work.pages)} printed (about ${words} words of notes).`
      : `Length: not set, so fit to the brief and the sources; about ${pagesWords(work.pages)} printed is what their size suggests (about ${words} words of notes). Go shorter or longer when the material calls for it, and say why when you finish.`,
  );
  if (ctx.assumes.length > 0) {
    parts.push(`The person has already been through these items of the plan (the guide may gather what they covered, for keeping; what it says still comes only from the sources):\n${ctx.assumes.map((prior) => `- ${prior.type} "${prior.title}": ${prior.summary}`).join("\n")}`);
  }
  const cut = cutNotes(ctx.sources);
  if (cut.length > 0) parts.push(cut.join("\n"));
  parts.push(outlineOf(work.passages));
  return parts;
}

/** The tools for a guide: the source tools, then the writing tools. */
export function guideTools(): WorkTool<GuideWork>[] {
  return [...sourceTools<GuideWork>(), planGuide, writeSection, changeSection, removeSection, readGuide, finishGuide];
}

const POINT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    term: { type: "string", description: `A key word, name or formula the point is about, shown first and strong (at most ${GUIDE_LIMITS.term} characters). Leave it out for a plain point.` },
    text: { type: "string", description: `The point itself, a sentence or a few (at most ${GUIDE_LIMITS.pointText} characters). Inline marks are allowed: **bold**, *italic*, \`code\`, $math$, [label](https://…). No headings, lists or line breaks: a list is several points.` },
    background: { type: "boolean", description: "True when the point is your own explanation, not what the sources say: it has no cites and the page shows it as yours." },
    cites: {
      type: "array",
      description: `The passages the point rests on, each {"passage":"P3","quote":"a few words copied exactly from that passage"} (at most ${GUIDE_LIMITS.cites}). Leave it out for background.`,
      items: { type: "object", properties: { passage: { type: "string" }, quote: { type: "string" } }, required: ["passage", "quote"] },
    },
  },
  required: ["text"],
};

const SECTION_PROPERTIES: Record<string, JsonSchema> = {
  title: { type: "string", description: `The section's heading, a few words (at most ${GUIDE_LIMITS.sectionTitle} characters).` },
  points: { type: "array", description: `The section's points, in reading order (at most ${GUIDE_LIMITS.points}).`, items: POINT_SCHEMA },
};

const planGuide: WorkTool<GuideWork> = {
  name: "plan_guide",
  description: "Sets the guide's title, what it covers in a sentence (shown in lists), and how many sections you mean to write, so the person sees how far the writing is. You can call it again.",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" }, about: { type: "string" }, sections: { type: "integer", minimum: 1, maximum: GUIDE_LIMITS.sections } },
    required: ["title"],
    additionalProperties: false,
  },
  label: () => "Planning the guide",
  async run(input, work) {
    const title = text(input.title);
    if (!title) return { text: "`title` is required.", isError: true };
    work.draft.title = title.slice(0, GUIDE_LIMITS.title);
    const about = text(input.about);
    if (about) work.draft.about = about.slice(0, GUIDE_LIMITS.about);
    if (typeof input.sections === "number" && input.sections > 0) work.draft.planned = Math.min(GUIDE_LIMITS.sections, Math.round(input.sections));
    await work.save();
    return { text: `Kept: "${work.draft.title}"${work.draft.planned ? `, ${work.draft.planned} sections` : ""}, about ${pagesWords(work.pages)} asked. Write the sections with write_section, in reading order.` };
  },
};

const writeSection: WorkTool<GuideWork> = {
  name: "write_section",
  description:
    "Adds one section to the guide, after the last one (or after the section named in `after`): a heading and its points. A point is one claim, a definition, a step or a formula, a sentence or a few; it rests on passages it cites, each with a few words copied exactly from that passage, or it is background (`background`: true), your own explanation beyond the sources, with no cites. Every point is checked when you send it: plain inline text with no headings or lists, every cite's passage and quote word for word, no cite on background. Nothing of a section is kept until all of it passes. The answer says how many pages the guide fills so far against the pages asked.",
  inputSchema: { type: "object", required: ["title", "points"], additionalProperties: false, properties: { ...SECTION_PROPERTIES, after: { type: "string", description: "The id of the section to put it after (s0 for the very start); after the last when left out." } } },
  label: (_input, work) => {
    const n = work.draft.sections.length + 1;
    return work.draft.planned && n <= work.draft.planned ? `Writing section ${n} of ${work.draft.planned}` : `Writing section ${n}`;
  },
  async run(input, work) {
    if (work.draft.sections.length >= GUIDE_LIMITS.sections) return { text: `The guide has ${GUIDE_LIMITS.sections} sections, the most a guide has; join or remove some instead.`, isError: true };
    const checked = checkSection(input, work);
    if ("problems" in checked) return refuse(checked.problems);
    const after = text(input.after);
    const at = after === "s0" ? 0 : after ? work.draft.sections.findIndex((section) => section.id === after) + 1 : work.draft.sections.length;
    if (after && after !== "s0" && at === 0) return { text: `There is no section "${after}"; read_guide lists them.`, isError: true };
    work.draft.sections.splice(at, 0, checked.section);
    renumber(work.draft);
    work.draft.finished = false;
    await work.save();
    return { text: keptLine(work.draft.sections[at]!, work, checked.notes) };
  },
};

const changeSection: WorkTool<GuideWork> = {
  name: "change_section",
  description: "Replaces one section you wrote with a new version, checked the same way as write_section. Send the whole section.",
  inputSchema: { type: "object", additionalProperties: false, properties: { id: { type: "string", description: "The section's id, from read_guide." }, ...SECTION_PROPERTIES }, required: ["id", "title", "points"] },
  label: (input) => `Improving section ${String(input.id ?? "").replace(/^s/, "")}`.trim(),
  async run(input, work) {
    const at = work.draft.sections.findIndex((section) => section.id === input.id);
    if (at < 0) return { text: `There is no section "${String(input.id)}"; read_guide lists them.`, isError: true };
    const checked = checkSection(input, work);
    if ("problems" in checked) return refuse(checked.problems);
    work.draft.sections[at] = checked.section;
    renumber(work.draft);
    work.draft.finished = false;
    await work.save();
    return { text: keptLine(work.draft.sections[at]!, work, checked.notes) };
  },
};

const removeSection: WorkTool<GuideWork> = {
  name: "remove_section",
  description: "Removes one section you wrote; the ones after it move up a number.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  label: () => "Removing a section",
  async run(input, work) {
    const at = work.draft.sections.findIndex((section) => section.id === input.id);
    if (at < 0) return { text: `There is no section "${String(input.id)}"; read_guide lists them.`, isError: true };
    work.draft.sections.splice(at, 1);
    renumber(work.draft);
    work.draft.finished = false;
    await work.save();
    return { text: `Removed. The guide has ${work.draft.sections.length} section${work.draft.sections.length === 1 ? "" : "s"} and fills about ${pagesWords(pagesOf(guideWords(work.draft)))} of about ${pagesWords(work.pages)} asked.` };
  },
};

const readGuide: WorkTool<GuideWork> = {
  name: "read_guide",
  description: "Reads back the guide as written so far, in reading order: each section's id and heading, then its points with their ids, terms, whether each is background, their words and their cites. Read it as the person would, looking something up.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  label: () => "Reading the guide back",
  run: (_input, work) => ({ text: renderDraft(work) }),
};

const finishGuide: WorkTool<GuideWork> = {
  name: "finish_guide",
  description:
    "Says the guide is finished. The whole is checked once more (a title, at least one section, each as write_section checks it); when it passes it is kept and you end your turn. When it runs clearly shorter or longer than the pages asked, give `note`.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The guide's title, if not set with plan_guide or to change it." },
      about: { type: "string", description: "What it covers, in a sentence, if not set with plan_guide." },
      note: { type: "string", description: "When it runs clearly shorter or longer than asked: one plain sentence to the person on why." },
    },
    additionalProperties: false,
  },
  label: () => "Checking the whole guide",
  async run(input, work) {
    const title = text(input.title);
    if (title) work.draft.title = title.slice(0, GUIDE_LIMITS.title);
    const about = text(input.about);
    if (about) work.draft.about = about.slice(0, GUIDE_LIMITS.about);
    if (!work.draft.title) return { text: "The guide needs a title: give one here or with plan_guide.", isError: true };
    if (work.draft.sections.length === 0) return { text: "The guide has no sections yet; write them with write_section.", isError: true };
    const note = text(input.note);
    if (note) work.draft.note = note.slice(0, GUIDE_LIMITS.lengthNote);
    const errors = checkGuide(work, work.draft.sections, work.draft.title).filter((issue) => issue.severity === "error");
    if (errors.length > 0) return refuse(errors.map((issue) => `${issue.path}: ${issue.message}`));
    const words = guideWords(work.draft);
    const asked = work.pages * WORDS_PER_PAGE;
    if ((words > asked * 1.5 + 150 || words < asked * 0.4) && !work.draft.note) {
      await work.save();
      return {
        text: `The guide fills about ${pagesWords(pagesOf(words))} (${words} words) and about ${pagesWords(work.pages)} was asked; the person saw that length. If this length is right, call finish_guide again with \`note\`: why, in a sentence to them. Otherwise write or remove sections first.`,
        isError: true,
      };
    }
    work.draft.finished = true;
    await work.save();
    const points = work.draft.sections.reduce((total, section) => total + section.points.length, 0);
    return { text: `The guide is finished and kept: "${work.draft.title}", ${work.draft.sections.length} section${work.draft.sections.length === 1 ? "" : "s"}, ${points} points, about ${pagesWords(pagesOf(words))}. End your turn now.` };
  },
};

/** What does not belong inside one point: headings, list marks, line breaks, display maths. A list is several points. */
const BLOCKS = /^\s*#{1,6}\s|^\s*([-*•]|\d+[.)])\s|\n|\$\$/m;

/**
 * One point as the agent sent it, checked: inline text of a size a reader
 * takes in at a glance, and its cites (word for word) or none when it is
 * background. Notes are information for the writer, never a refusal.
 */
export function checkPoint(input: unknown, work: Pick<GuideWork, "passages" | "byLabel">, where = "point"): { point: GuidePoint; notes: string[] } | { problems: string[] } {
  if (!isRecord(input)) return { problems: [`${where}: send it as {"text":"…","cites":[…]}.`] };
  const problems: string[] = [];
  const term = text(input.term);
  const raw = typeof input.text === "string" ? input.text.trim() : "";
  const said = raw.replace(/[ \t]+/g, " ");
  const background = input.background === true;
  if (term && term.length > GUIDE_LIMITS.term) problems.push(`${where}.term: at most ${GUIDE_LIMITS.term} characters.`);
  if (!said) problems.push(`${where}.text: write the point.`);
  else if (said.length > GUIDE_LIMITS.pointText) problems.push(`${where}.text: ${said.length} characters is more than one point holds (${GUIDE_LIMITS.pointText}); split it into points.`);
  if (BLOCKS.test(raw)) problems.push(`${where}.text: one point is inline text, with no headings, list marks or line breaks; make a list several points, and a heading a section.`);
  const leaks = promptLabelLeaks(`${term ?? ""} ${said}`, work.passages);
  if (leaks.length > 0) problems.push(`${where}.text: the reader never sees passages or their labels (${leaks.join(", ")}); name the source by its title, or just say what it says.`);
  const cites = Array.isArray(input.cites) ? input.cites : typeof input.cites === "string" ? parseList(input.cites) : [];
  if (background && cites.length > 0) problems.push(`${where}.cites: a background point is your own explanation, so it cites nothing; if it says what a source says, make it a point of its own that cites it.`);
  if (!background && cites.length === 0) problems.push(`${where}.cites: name the passages this point rests on, {"passage":"P3","quote":"..."}; or, if it is your own explanation, set background to true.`);
  if (cites.length > GUIDE_LIMITS.cites) problems.push(`${where}.cites: at most ${GUIDE_LIMITS.cites}.`);
  const kept: GuideCite[] = [];
  if (!background) {
    cites.forEach((cite, index) => {
      const at = `${where}.cites[${index}]`;
      if (!isRecord(cite) || typeof cite.passage !== "string") return void problems.push(`${at}: name a passage, {"passage":"P3","quote":"..."}.`);
      const passage = work.byLabel.get(cite.passage.trim());
      if (!passage) return void problems.push(`${at}: "${cite.passage}" is not a passage of this item; its passages are ${work.passages[0]?.label}–${work.passages.at(-1)?.label}.`);
      const quote = typeof cite.quote === "string" ? cite.quote.trim() : "";
      if (!quote) return void problems.push(`${at}.quote: copy a few words from ${passage.label} that carry what this point says.`);
      if (quote.length > GUIDE_LIMITS.quote) return void problems.push(`${at}.quote: at most ${GUIDE_LIMITS.quote} characters; quote a shorter span.`);
      if (!quoteInPassage(quote, passage)) return void problems.push(`${at}.quote: not word for word in ${passage.label}; copy the words again exactly as they stand there, or quote a shorter span.`);
      kept.push(citeOf(passage, quote));
    });
  }
  if (problems.length > 0) return { problems };
  const notes: string[] = [];
  if (!background) {
    const beyond = beyondSources(`${term ? `**${term}** ` : ""}${said}`, work.passages.map((passage) => passage.text));
    const extra = [...beyond.numbers, ...beyond.terms];
    if (extra.length > 0) {
      notes.push(`${where} kept, but your sources do not contain ${extra.join(", ")}. A reader takes a cited point as the source's own: if a source says it, cite that passage; if it is yours (an example, a usual figure), make it a background point.`);
    }
  }
  return { point: { id: "p0", ...(term ? { term } : {}), text: said, background, cites: kept }, notes };
}

/** One section as the agent sent it, checked whole: nothing of it is kept until every point passes. */
export function checkSection(input: Record<string, unknown>, work: Pick<GuideWork, "passages" | "byLabel">): { section: GuideSection; notes: string[] } | { problems: string[] } {
  const problems: string[] = [];
  const title = text(input.title);
  if (!title) problems.push("title: give the section a heading of a few words.");
  else if (title.length > GUIDE_LIMITS.sectionTitle) problems.push(`title: at most ${GUIDE_LIMITS.sectionTitle} characters.`);
  const raw = Array.isArray(input.points) ? input.points : typeof input.points === "string" ? parseList(input.points) : [];
  if (raw.length === 0) problems.push('points: a section holds at least one point, {"text":"…","cites":[…]}.');
  if (raw.length > GUIDE_LIMITS.points) problems.push(`points: at most ${GUIDE_LIMITS.points} in a section; split it into two sections.`);
  const points: GuidePoint[] = [];
  const notes: string[] = [];
  raw.forEach((entry, index) => {
    const checked = checkPoint(entry, work, `points[${index}]`);
    if ("problems" in checked) problems.push(...checked.problems);
    else {
      points.push(checked.point);
      notes.push(...checked.notes);
    }
  });
  if (problems.length > 0) return { problems };
  return { section: { id: "s0", title: title!, points }, notes };
}

/** Every check of the guide in code, over these sections. */
export function checkGuide(work: Pick<GuideWork, "passages" | "byLabel">, sections: GuideSection[], title: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!title.trim()) issues.push(issue("$.title", "no_title", "the guide needs a title"));
  if (sections.length === 0) issues.push(issue("$.sections", "empty", "the guide has no sections"));
  if (sections.length > GUIDE_LIMITS.sections) issues.push(issue("$.sections", "too_many", `at most ${GUIDE_LIMITS.sections} sections`));
  const byId = new Map(work.passages.map((passage) => [passage.id, passage]));
  const label = new Map(work.passages.map((passage) => [passage.id, passage.label]));
  for (const section of sections) {
    const sent = {
      title: section.title,
      points: section.points.map((point) => ({ ...(point.term ? { term: point.term } : {}), text: point.text, background: point.background, cites: point.cites.map((cite) => ({ passage: label.get(passageIdOf(cite, byId) ?? "") ?? "?", quote: cite.quote })) })),
    };
    const checked = checkSection(sent, work);
    if ("problems" in checked) for (const problem of checked.problems) issues.push(issue(section.id, "section", problem));
  }
  return issues;
}

function passageIdOf(cite: GuideCite, byId: Map<string, unknown>): string | undefined {
  if (cite.chunkId && byId.has(cite.chunkId)) return cite.chunkId;
  const ranged = cite.locator?.charStart !== undefined ? `${cite.sourceId}@${cite.locator.charStart}-${cite.locator.charEnd}` : undefined;
  return ranged && byId.has(ranged) ? ranged : undefined;
}

function citeOf(passage: Passage, quote: string): GuideCite {
  return {
    sourceId: passage.sourceId,
    ...(passage.chunkId ? { chunkId: passage.chunkId } : {}),
    ...(passage.locator ? { locator: passage.locator } : {}),
    quote: sentenceSpot(quote, passage),
  };
}

/** Sections s1, s2, … and points p1, p2, … across the whole guide, in reading order. */
function renumber(draft: GuideDraft): void {
  let n = 0;
  draft.sections = draft.sections.map((section, at) => ({ ...section, id: `s${at + 1}`, points: section.points.map((point) => ({ ...point, id: `p${++n}` })) }));
}

function keptLine(section: GuideSection, work: GuideWork, notes: string[]): string {
  const at = work.draft.sections.findIndex((other) => other.id === section.id) + 1;
  const planned = work.draft.planned ? ` (${work.draft.planned} planned)` : "";
  const words = guideWords({ sections: [section] });
  const all = guideWords(work.draft);
  const head = `Kept as ${section.id}, section ${at} of ${work.draft.sections.length}${planned}: ${section.points.length} point${section.points.length === 1 ? "" : "s"}, ${words} words. The guide so far fills about ${pagesWords(pagesOf(all))} (${all} words) of about ${pagesWords(work.pages)} asked.`;
  return [head, ...notes].join("\n");
}

function renderDraft(work: GuideWork): string {
  const { draft } = work;
  const byId = new Map(work.passages.map((passage) => [passage.id, passage]));
  const words = guideWords(draft);
  const head = `Title: ${draft.title ?? "(none yet)"}\nAbout: ${draft.about ?? "(none yet)"}\n${draft.sections.length} section${draft.sections.length === 1 ? "" : "s"}${draft.finished ? ", finished" : ""}${draft.planned ? ` (${draft.planned} planned)` : ""}, about ${pagesWords(pagesOf(words))} (${words} words) of about ${pagesWords(work.pages)} asked.`;
  const sections = draft.sections.map((section) => {
    const points = section.points.map((point) => {
      const cites = point.cites.map((cite) => `${byId.get(passageIdOf(cite, byId) ?? "")?.label ?? cite.sourceId}: "${cite.quote}"`);
      return `- ${point.id}${point.background ? " (background)" : ""}: ${point.term ? `**${point.term}** · ` : ""}${point.text}${cites.length ? `\n  Cites: ${cites.join("; ")}` : ""}`;
    });
    return `## ${section.id} · ${section.title}\n${points.join("\n")}`;
  });
  return [head, ...sections].join("\n\n");
}

function output(ctx: EngineContext<GuideSettings>, work: GuideWork): EngineOutput<GuidePayload> {
  void ctx.services.progress({ stage: "verifying", progress: 0.86, step: "Checking the guide" });
  const title = (work.draft.title ?? ctx.node.title.trim()) || "Guide";
  const sections = work.draft.sections;
  const about = work.draft.about ?? sections.map((section) => section.title).slice(0, 4).join(", ");
  const payload: GuidePayload = { schemaVersion: GUIDE_SCHEMA_VERSION, title, about, sections, ...(work.draft.note ? { lengthNote: work.draft.note } : {}) };
  const summary = `A guide of about ${pagesWords(pagesOf(guideWords(payload)))}: ${sections.map((section) => section.title).slice(0, 6).join("; ")}${sections.length > 6 ? `; and ${sections.length - 6} more sections` : ""}.`;
  return { title, summary, payload, citations: guideCitations(sections) };
}

function readDraft(value: JsonValue | undefined): GuideDraft {
  if (isRecord(value) && Array.isArray(value.sections)) {
    const sections = (value.sections as unknown[]).filter((section): section is GuideSection => isRecord(section) && typeof section.title === "string" && Array.isArray(section.points));
    return {
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      ...(typeof value.about === "string" ? { about: value.about } : {}),
      ...(typeof value.planned === "number" ? { planned: value.planned } : {}),
      ...(typeof value.note === "string" ? { note: value.note } : {}),
      sections,
      finished: value.finished === true && sections.length > 0,
    };
  }
  return { sections: [], finished: false };
}

function readSources(sources: NodeSource[]): NodeSource[] {
  return sources.filter((source) => source.envelope.accessLevel !== "metadata" && source.envelope.accessLevel !== "none");
}

function requirePassages(ctx: EngineContext<GuideSettings>): Passage[] {
  const passages = buildPassages(readSources(ctx.sources));
  if (passages.length === 0) throw new PipelineError("A guide needs source text to write from; this item has none that could be read.", "NO_SOURCE_TEXT");
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
