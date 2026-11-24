/**
 * Audio: a spoken walk-through with no picture (`engine/docs/audio.md`, "The scenes service's audio calls"). The
 * person's agent wrote the parts in the engine; here every part is spoken with the video's voice (which gives a time
 * for every word), the parts are joined with a short pause between them, the sound is mastered with the video's
 * mastering (no music, no effects) and encoded as AAC in MP4. One folder each under `<dataDir>/audio/<id>/` with a
 * `job.json` written on every change, so a finished audio is still there after a restart.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { wordsOf } from "./script.ts";
import { FADE_OUT, mix } from "./sound.ts";
import { VOICE_HOW } from "./voice-choice.ts";
import { spread, voiceNow, type Segment, type Spoken, type Voice, type VoiceSource } from "./voice.ts";

const run = promisify(execFile);

export type AudioState = "voicing" | "mastering" | "done" | "failed" | "stopped";
export type AudioFailureCode = "noVoice" | "voiceRefused" | "stopped" | "error";

export interface AudioRequest {
  id: string;
  title: string;
  parts: { id: string; text: string }[];
}

export interface AudioWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface AudioResult {
  durationMs: number;
  bytes: number;
  contentType: "audio/mp4";
  voice: { id: string; label: string; real: boolean };
  loudness: { lufs: number; truePeak: number };
  parts: { id: string; startMs: number; endMs: number; words: AudioWord[] }[];
}

export interface AudioFailure {
  code: AudioFailureCode;
  message: string;
  detail?: string;
}

export interface AudioJob {
  id: string;
  title: string;
  parts: { id: string; text: string }[];
  state: AudioState;
  progress: number;
  step: string;
  failure?: AudioFailure;
  result?: AudioResult;
  createdAt: string;
  updatedAt: string;
}

/** The extra quiet between two parts, on top of the voice's own TAIL and LEAD: a part break is a little longer than a sentence break. */
export const PART_GAP = 0.5;
export const MAX_PARTS = 60;
export const MAX_PART_CHARS = 2500;
/** Parts given to the voice at once: enough for a voice that speaks several together, few enough to say how far it is. */
const BATCH = 3;

// The same words as the video's note on how to get a voice (voice-choice.ts), so Open Sourcebook says it one way.
const NO_VOICE = `Audio needs a voice, and this computer has none set up: ${VOICE_HOW}.`;
const MESSAGES: Record<AudioFailureCode, string> = {
  noVoice: NO_VOICE,
  voiceRefused: "The voice could not speak it.",
  stopped: "Stopped.",
  error: "Something went wrong while voicing this audio. Try again.",
};

/** Whether this computer can voice audio now: it can when its voice makes sound. */
export function audioStatus(voice: Voice): { ready: true } | { ready: false; problem: string } {
  return voice.real ? { ready: true } : { ready: false, problem: NO_VOICE };
}

/** Reads a POST /audio body. Problems are in words the engine can log and act on; none means it is taken. */
export function readAudioRequest(body: unknown): { request: AudioRequest } | { problems: string[] } {
  const problems: string[] = [];
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : "";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) problems.push("id: 1 to 128 letters, digits, dots, dashes or underscores.");
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) problems.push("title: a non-empty string.");
  const parts: { id: string; text: string }[] = [];
  if (!Array.isArray(b.parts) || b.parts.length < 1 || b.parts.length > MAX_PARTS) problems.push(`parts: a list of 1 to ${MAX_PARTS} parts, each { id, text }.`);
  else {
    const seen = new Set<string>();
    b.parts.forEach((p: unknown, i) => {
      const part = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      const pid = typeof part.id === "string" ? part.id : "";
      const text = typeof part.text === "string" ? part.text.trim() : "";
      if (!/^[a-z0-9-]{1,32}$/.test(pid)) problems.push(`parts[${i}].id: 1 to 32 lower-case letters, digits or dashes.`);
      else if (seen.has(pid)) problems.push(`parts[${i}].id: "${pid}" is used twice.`);
      seen.add(pid);
      if (!text) problems.push(`parts[${i}].text: what the voice says, not empty.`);
      else if (text.length > MAX_PART_CHARS) problems.push(`parts[${i}].text: ${text.length} characters; at most ${MAX_PART_CHARS}.`);
      parts.push({ id: pid, text });
    });
  }
  return problems.length ? { problems } : { request: { id, title, parts } };
}

async function seconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  return Number(stdout.trim());
}

/** A part's words as the contract keeps them: its text split on spaces, with the voice's times when they line up word for word. */
function partWords(text: string, spoken: Spoken): { text: string; start: number; end: number }[] {
  const words = wordsOf(text);
  if (spoken.words.length === words.length) return words.map((w, i) => ({ text: w, start: spoken.words[i]!.start, end: spoken.words[i]!.end }));
  // A voice that split the words its own way: spread the text over the speech it measured.
  const from = spoken.words[0]?.start ?? 0.25;
  const to = spoken.words.at(-1)?.end ?? Math.max(from + 0.1, spoken.seconds - 0.45);
  return spread(words, from, Math.max(0.1, to - from));
}

export class AudioError extends Error {
  readonly code: AudioFailureCode;
  constructor(code: AudioFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Voices one audio into `folder`: speaks the parts, joins them, masters and encodes `audio.m4a`. `onStep` hears how far
 * it is. Throws an AudioError: `voiceRefused` when the voice threw (its message kept), `noVoice` when it gave no sound,
 * `stopped` when the signal ended it.
 */
export async function voiceAudio(o: {
  request: AudioRequest;
  voice: Voice;
  folder: string;
  kitDir: string;
  signal?: AbortSignal;
  onStep?: (state: "voicing" | "mastering", progress: number, step: string) => void;
}): Promise<AudioResult> {
  const { parts } = o.request;
  const stopped = () => {
    if (o.signal?.aborted) throw new AudioError("stopped", MESSAGES.stopped);
  };
  mkdirSync(o.folder, { recursive: true });
  const segments: Segment[] = parts.map((p, i) => {
    const previous = parts[i - 1]?.text;
    const next = parts[i + 1]?.text;
    return { id: p.id, text: p.text, ...(previous ? { previous } : {}), ...(next ? { next } : {}) };
  });

  const spoken: Spoken[] = [];
  for (let i = 0; i < segments.length; i += BATCH) {
    stopped();
    o.onStep?.("voicing", +(0.8 * (i / segments.length)).toFixed(3), `Voicing part ${i + 1} of ${segments.length}`);
    let said: Spoken[];
    try {
      said = await o.voice.speak(segments.slice(i, i + BATCH), join(o.folder, "voice"), o.signal);
    } catch (e) {
      stopped();
      throw new AudioError("voiceRefused", (e as Error).message || MESSAGES.voiceRefused);
    }
    for (const s of said) if (!s.audio) throw new AudioError("noVoice", MESSAGES.noVoice);
    spoken.push(...said);
  }
  stopped();

  // Join: each part's WAV in order, PART_GAP of quiet between two parts. Each part's span is its WAV's span in the file.
  o.onStep?.("mastering", 0.82, "Joining the parts");
  const lengths: number[] = [];
  for (const s of spoken) lengths.push(await seconds(s.audio!));
  const joined = join(o.folder, "voice.wav");
  const chain = spoken.map((_, i) => `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,apad=whole_dur=${(lengths[i]! + (i < spoken.length - 1 ? PART_GAP : 0)).toFixed(3)}[p${i}]`);
  const filter = `${chain.join(";")};${spoken.map((_, i) => `[p${i}]`).join("")}concat=n=${spoken.length}:v=0:a=1[out]`;
  await run("ffmpeg", ["-y", "-v", "error", ...spoken.flatMap((s) => ["-i", s.audio!]), "-filter_complex", filter, "-map", "[out]", "-ar", "48000", "-ac", "1", joined], { signal: o.signal, maxBuffer: 16 * 1024 * 1024 }).catch((e) => {
    stopped();
    throw e;
  });

  const out: AudioResult["parts"] = [];
  let offset = 0;
  let lastMs = 0;
  let speechEnd = 0;
  for (const [i, s] of spoken.entries()) {
    const startMs = Math.round(offset * 1000);
    const endMs = Math.round((offset + lengths[i]!) * 1000);
    const words = partWords(parts[i]!.text, s).map((w) => {
      // Never back in time, and never outside the part's span.
      const a = Math.min(endMs, Math.max(lastMs, startMs, Math.round((offset + w.start) * 1000)));
      const b = Math.min(endMs, Math.max(a, Math.round((offset + w.end) * 1000)));
      lastMs = a;
      return { text: w.text, startMs: a, endMs: b };
    });
    if (words.length) speechEnd = words.at(-1)!.endMs / 1000;
    out.push({ id: s.id, startMs, endMs, words });
    offset += lengths[i]! + PART_GAP;
  }
  stopped();

  // Master: quiet after the last word long enough that the fade-out lands on silence, never on the last words.
  o.onStep?.("mastering", 0.88, "Mastering the sound");
  const total = speechEnd + FADE_OUT + 0.5;
  let mixed: Awaited<ReturnType<typeof mix>>;
  try {
    mixed = await mix({ voice: joined, hits: [], music: [], seconds: +total.toFixed(3), folder: o.folder, kitDir: o.kitDir, ...(o.signal ? { signal: o.signal } : {}) });
  } catch (e) {
    stopped();
    throw e;
  }
  stopped();
  o.onStep?.("mastering", 0.96, "Mastering the sound");
  const file = join(o.folder, "audio.m4a");
  await run("ffmpeg", ["-y", "-v", "error", "-i", mixed.file, "-ac", "1", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", file], { signal: o.signal }).catch((e) => {
    stopped();
    throw e;
  });
  return {
    durationMs: Math.round((await seconds(file)) * 1000),
    bytes: statSync(file).size,
    contentType: "audio/mp4",
    voice: { id: o.voice.id, label: o.voice.label, real: o.voice.real },
    loudness: { lufs: +mixed.lufs.toFixed(2), truePeak: +mixed.truePeak.toFixed(2) },
    parts: out,
  };
}

/** What GET /audio/:id answers. */
export function audioView(job: AudioJob) {
  return {
    id: job.id,
    state: job.state,
    progress: job.progress,
    step: job.step,
    ...(job.failure ? { failure: { code: job.failure.code, message: job.failure.message } } : {}),
    ...(job.result ? { result: job.result } : {}),
  };
}

/** The audio jobs: made one at a time, off the request, each kept in its own folder. */
export class AudioJobs {
  private readonly jobs = new Map<string, AudioJob>();
  private readonly running = new Map<string, AbortController>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly o: { dataDir: string; voice: VoiceSource; log?: (line: string) => void };
  private readonly root: string;

  /** `voice`: the voice, or what gives the voice of the moment; an audio keeps the voice it started with. */
  constructor(o: { dataDir: string; voice: VoiceSource; log?: (line: string) => void }) {
    this.o = o;
    this.root = join(o.dataDir, "audio");
    mkdirSync(this.root, { recursive: true });
    this.load();
  }

  /** Reads every audio on disk. One that was being voiced when the service stopped is failed now. */
  private load(): void {
    for (const id of readdirSync(this.root)) {
      const file = join(this.root, id, "job.json");
      if (!existsSync(file)) continue;
      try {
        const job = JSON.parse(readFileSync(file, "utf8")) as AudioJob;
        this.jobs.set(job.id, job);
        if (job.state === "voicing" || job.state === "mastering") {
          this.fail(job, { code: "error", message: "The scenes service stopped while voicing it.", detail: `was ${job.state}` });
        }
      } catch {
        this.o.log?.(`audio ${id}: job.json could not be read; left as it is`);
      }
    }
  }

  get(id: string): AudioJob | undefined {
    return this.jobs.get(id);
  }

  folder(id: string): string {
    return join(this.root, id);
  }

  /** The m4a once done. */
  file(id: string): string {
    return join(this.folder(id), "audio.m4a");
  }

  /** Starts an audio. The same id while it is being made or done is the same audio; after it failed or stopped, it starts again. */
  create(request: AudioRequest): AudioJob {
    const had = this.jobs.get(request.id);
    if (had && had.state !== "failed" && had.state !== "stopped") return had;
    rmSync(this.folder(request.id), { recursive: true, force: true });
    mkdirSync(this.folder(request.id), { recursive: true });
    const now = new Date().toISOString();
    const job: AudioJob = { id: request.id, title: request.title, parts: request.parts, state: "voicing", progress: 0, step: "Waiting to be voiced", createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    this.save(job);
    const abort = new AbortController();
    this.running.set(job.id, abort);
    this.queue = this.queue.then(() => this.make(job, abort)).catch(() => undefined);
    return job;
  }

  /** Stops an audio being made; one already finished is left as it is. */
  stop(id: string): AudioJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const abort = this.running.get(id);
    if (abort && (job.state === "voicing" || job.state === "mastering")) {
      abort.abort();
      this.running.delete(id);
      job.state = "stopped";
      job.step = "Stopped";
      job.failure = { code: "stopped", message: MESSAGES.stopped };
      this.save(job);
      this.o.log?.(`audio ${id}: stopped`);
    }
    return job;
  }

  /** Resolves when every audio started so far has finished (for tests and a clean shutdown). */
  idle(): Promise<unknown> {
    return this.queue;
  }

  private async make(job: AudioJob, abort: AbortController): Promise<void> {
    if (abort.signal.aborted || this.jobs.get(job.id) !== job) return;
    const request: AudioRequest = { id: job.id, title: job.title, parts: job.parts };
    try {
      const voice = voiceNow(this.o.voice);
      if (!voice.real) throw new AudioError("noVoice", NO_VOICE);
      const result = await voiceAudio({
        request,
        voice,
        folder: this.folder(job.id),
        kitDir: join(this.o.dataDir, ".kit"),
        signal: abort.signal,
        onStep: (state, progress, step) => {
          if (abort.signal.aborted) return;
          job.state = state;
          job.progress = Math.max(job.progress, progress);
          job.step = step;
          this.save(job);
        },
      });
      if (abort.signal.aborted) return;
      job.state = "done";
      job.progress = 1;
      job.step = "Done";
      job.result = result;
      this.save(job);
      this.o.log?.(`audio ${job.id}: done, ${(result.durationMs / 1000).toFixed(1)} s`);
    } catch (e) {
      if (abort.signal.aborted) return;
      const err = e as Error;
      const failure: AudioFailure = e instanceof AudioError ? { code: e.code, message: e.message } : { code: "error", message: MESSAGES.error, detail: err.message?.slice(0, 2000) };
      this.fail(job, failure);
    } finally {
      if (this.running.get(job.id) === abort) this.running.delete(job.id);
    }
  }

  private fail(job: AudioJob, failure: AudioFailure): void {
    if (job.state === "stopped") return;
    job.state = "failed";
    job.failure = failure;
    job.step = "Failed";
    this.save(job);
    this.o.log?.(`audio ${job.id}: failed (${failure.code})${failure.detail ? `: ${failure.detail.slice(0, 200)}` : ""}`);
  }

  private save(job: AudioJob): void {
    job.updatedAt = new Date().toISOString();
    const file = join(this.folder(job.id), "job.json");
    mkdirSync(this.folder(job.id), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(job, null, 1));
    renameSync(`${file}.tmp`, file);
  }
}
