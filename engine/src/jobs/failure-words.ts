/**
 * Why making something failed, in plain words for the person. The one place
 * a job's failure becomes what an item's `errorMessage` says.
 *
 * A failing step names its cause as a code (`JobFailure.code`, a pipeline
 * error's code, a refused model account, a spent budget); the job keeps the
 * code in its state (`state.failure`) and its full technical text in its
 * stored `errorMessage`, which goes to the log and to `job.errorDetail`,
 * never to the line a person reads. A cause without a code, or a code this
 * table does not know, reads as a calm generic line.
 */
import { PipelineError } from "../engines/retry";
import { accountRefusal } from "../net";
import { BudgetExceededError } from "../providers/budget";
import type { GenerationJob, JsonObject } from "./types";
import { readChoice, readTrouble, waitOf, type VoiceTrouble, type WaitReason } from "./waits";

export const JOB_FAILURE_CODES = [
  "format_missing",
  "bad_settings",
  "bad_job",
  "source_missing",
  "no_source_text",
  "no_provider",
  "no_production",
  "maker_missing",
  "no_maker",
  "maker_unreachable",
  "agent_unreachable",
  "agent_missing",
  "no_agent",
  "pick_needed",
  "agent_signed_out",
  "agent_limit",
  "agent_dropped",
  "agent_error",
  "timed_out",
  "stopped",
  "script_refused",
  "out_of_credit",
  "key_refused",
  "over_budget",
  "voice_down",
  "not_valid",
  "gave_up",
  "draft_gone",
] as const;
export type JobFailureCode = (typeof JOB_FAILURE_CODES)[number];

/** The key in a job's state that holds its failure code. */
const STATE_KEY = "failure";
/** The key that holds the agent's own words on why it failed, when the failure carries them (`agent_error`). */
const SAID_KEY = "failureSaid";

/** Pipeline error codes that name a cause the person can act on. */
const PIPELINE_CODES: Readonly<Record<string, JobFailureCode>> = {
  NO_SOURCE_TEXT: "no_source_text",
  INVALID_SETTINGS: "bad_settings",
  NO_PRODUCTION: "no_production",
  VALIDATION_FAILED: "not_valid",
};

/** The agent's own words on why it failed, when what was thrown carries them (`JobFailure.said`). */
export function failureSaidOf(error: unknown): string | undefined {
  const said = error && typeof error === "object" && "said" in error ? (error as { said?: unknown }).said : undefined;
  return typeof said === "string" && said.trim() ? said.trim().slice(0, 300) : undefined;
}

/** The code for what was thrown, when it names one. */
export function failureCodeOf(error: unknown): JobFailureCode | undefined {
  if (error && typeof error === "object" && "failureCode" in error) {
    const code = (error as { failureCode?: unknown }).failureCode;
    if (isFailureCode(code)) return code;
  }
  if (error instanceof PipelineError) return PIPELINE_CODES[error.code];
  if (error instanceof BudgetExceededError) return "over_budget";
  const refusal = accountRefusal(error);
  if (refusal === "outOfCredit") return "out_of_credit";
  if (refusal === "keyRefused") return "key_refused";
  return undefined;
}

/** A job's state with its failure code set (and the agent's own words, when it gave some), or cleared when there is none. */
export function withFailureCode(state: JsonObject, code: JobFailureCode | undefined, said?: string): JsonObject {
  const { [STATE_KEY]: _old, [SAID_KEY]: _said, ...rest } = state;
  return code ? { ...rest, [STATE_KEY]: code, ...(said ? { [SAID_KEY]: said } : {}) } : rest;
}

/** The failure code a job recorded, if any. */
export function failureCodeOfJob(job: Pick<GenerationJob, "state">): JobFailureCode | undefined {
  const code = job.state[STATE_KEY];
  return isFailureCode(code) ? code : undefined;
}

/**
 * The line a person reads for a failed job. `thing` is what was being made,
 * in the format's own words ("quiz", "video", "set of flashcards"), else "item".
 */
export function failureWords(job: Pick<GenerationJob, "state" | "attempt" | "status">, thing = "item"): string {
  const it = `this ${thing}`;
  const code = job.status === "dead" ? "gave_up" : failureCodeOfJob(job);
  const waited = waitedOf(job);
  if (waited === "agent_limit") return `Your agent's plan was still at its limit, so Open Sourcebook stopped waiting for it. What was made of ${it} is kept: try again once it resets to carry on from there.`;
  if (waited === "restart") return `Open Sourcebook carried ${it} on after restarts as many times as it could, and it still was not finished. What was made is kept: try again to carry on from there.`;
  if (waited === "voice") {
    const waitedFor = job.state.waited as Record<string, unknown>;
    const trouble = readTrouble(waitedFor.trouble);
    const choice = readChoice(waitedFor.choice);
    return `Open Sourcebook waited a day for the voice, and it still could not speak (${lower(voiceWords(trouble).why)}). What was made of ${it} is kept: ${lower(voiceWords(trouble).todo)}, then try again to carry on${choice ? `, or ${choice.words}` : ""}.`;
  }
  switch (code) {
    case "format_missing":
      return "This kind of item can't be made here yet. Change its format, or try again later.";
    case "bad_settings":
      return `The settings on ${it} could not be used. Check them, then try again.`;
    case "bad_job":
      return `Something in how ${it} was set up could not be read. Edit it, then try again.`;
    case "source_missing":
      return `A source ${it} reads is gone or could not be read. Pick its sources again, then try again.`;
    case "no_source_text":
      return `The sources of ${it} have no text that could be read, so there was nothing to make it from. Pick a source with text, then try again.`;
    case "no_provider":
      return `Open Sourcebook has no model to write with right now, so ${it} was not made. Try again later.`;
    case "no_production":
      return `Open Sourcebook can't turn ${it} into a file here yet. Try again later.`;
    case "maker_missing":
      return `The maker ${it} asks for is not set up here. Pick another maker, then try again.`;
    case "no_maker":
      return `Nothing here can make ${it}: no agent is connected and no model API key is set. Start the connector on this computer, or add a key, then try again.`;
    case "maker_unreachable":
      return `The maker ${it} needs isn't running on this computer, so it was not made. Start it, then try again.`;
    case "agent_unreachable":
      return `Open Sourcebook couldn't reach your agent: the connector on your computer isn't running. Start it, then try again.`;
    case "agent_missing":
      return `Open Sourcebook couldn't find your agent on your computer: it doesn't look installed. Install it, then try again.`;
    case "no_agent":
      return `None of your providers can make ${it}. Add or turn one on in Settings, under Providers, then try again.`;
    case "pick_needed":
      return `More than one of your providers could make ${it}. Pick who makes it in Settings, under What makes what, then try again.`;
    case "agent_signed_out":
      return `Your agent isn't signed in on your computer, so ${it} was not made. Sign it in, then try again.`;
    case "agent_limit":
      return `Your agent's plan has reached its limit for now, so ${it} was not made. Try again once it resets.`;
    case "agent_dropped":
      return `Your agent's turn ended before ${it} was done. What it had written and checked is kept: try again to carry on from there.`;
    case "agent_error": {
      const said = typeof job.state[SAID_KEY] === "string" ? (job.state[SAID_KEY] as string) : "";
      // Its own words when it gave some: they say what is wrong (a model its account does not offer, a setting).
      if (said) return `Your agent stopped before it began on ${it}. It said: "${said.replace(/[.\s]+$/, "")}." Fix what it says, then try again.`;
      return `Your agent stopped before it began on ${it}. Check that it runs on your computer, then try again.`;
    }
    case "timed_out":
      return `Open Sourcebook stopped your agent's turn on ${it}: it reached its time limit, or did nothing for a long time. Try again to carry on from what it made.`;
    case "stopped":
      return `${capitalize(it)} was stopped before it was done. Try again to make it.`;
    case "script_refused":
      return `Your agent's script for ${it} did not pass Open Sourcebook's checks against the sources. Try again, or change its brief or sources.`;
    case "out_of_credit":
      return `The model account is out of credit, so ${it} was not made. Add credit, then try again.`;
    case "key_refused":
      return `The model key was refused, so ${it} was not made. Check the key, then try again.`;
    case "over_budget":
      return `${capitalize(it)} reached its spending limit before it was done. Raise the plan's budget, then try again.`;
    case "voice_down":
      return `The voice could not speak, so ${it} was not finished. What was made is kept: check the voice, then try again to carry on.`;
    case "not_valid":
      return `Open Sourcebook could not get ${it} right from its sources. Try again, or change its brief or sources.`;
    case "draft_gone":
      return `What ${it} was made from is no longer on this computer, so one of its scenes could not be made again. Make it again whole instead.`;
    case "gave_up":
      return job.attempt > 1 ? `Open Sourcebook tried ${job.attempt} times and could not make ${it}. Try again later.` : `Open Sourcebook could not make ${it}. Try again later.`;
    default:
      return `Something went wrong while making ${it}. Try again.`;
  }
}

/** What a waiting job shows: a short step, and a sentence with what is kept. */
export interface WaitingWords {
  reason: WaitReason;
  step: string;
  words: string;
}

/** The words for a job that waits (status `waiting`), from its kept wait; undefined when it does not wait. */
export function waitingWords(job: Pick<GenerationJob, "state" | "status">, thing = "item"): WaitingWords | undefined {
  const wait = job.status === "waiting" ? waitOf(job) : undefined;
  if (!wait) return undefined;
  const it = `this ${thing}`;
  if (wait.reason === "agent_limit") {
    // Only what the agent itself said about the reset; a time it gave is shown by the app in the person's own clock.
    const when = wait.resets ? ` It said it resets ${wait.resets}.` : "";
    return { reason: wait.reason, step: "Waiting for your agent's plan…", words: `Your agent's plan has reached its limit. Open Sourcebook will carry on when it is available again.${when} What was made of ${it} so far is kept.` };
  }
  if (wait.reason === "voice") {
    const { why, todo } = voiceWords(wait.trouble);
    const or = wait.choice ? `, or ${wait.choice.words}` : "";
    return { reason: wait.reason, step: "Waiting for the voice…", words: `${why}, so the voice cannot speak. What was made of ${it} so far is kept. ${todo} and Open Sourcebook carries on by itself${or}.` };
  }
  return { reason: wait.reason, step: "Carrying on after a restart…", words: `Something Open Sourcebook runs on this computer restarted while ${it} was being made. Open Sourcebook is carrying it on from what was already made, which is kept.` };
}

/** Why the voice cannot speak, and what the person does about it, in a sentence each. */
function voiceWords(trouble: VoiceTrouble | undefined): { why: string; todo: string } {
  switch (trouble) {
    case "credits":
      return { why: "The voice account is out of credits", todo: "Add credits to the voice account" };
    case "refused":
      return { why: "The voice account refused its key", todo: "Check the voice key" };
    case "unreachable":
      return { why: "The voice service could not be reached", todo: "Check this computer's connection" };
    default:
      return { why: "The voice is not working", todo: "Check the voice" };
  }
}

/** Why a failed job had waited before it failed, when it had. */
function waitedOf(job: Pick<GenerationJob, "state">): WaitReason | undefined {
  const waited = job.state.waited;
  if (!waited || typeof waited !== "object" || Array.isArray(waited)) return undefined;
  const reason = (waited as Record<string, unknown>).reason;
  return reason === "agent_limit" || reason === "restart" || reason === "voice" ? reason : undefined;
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function isFailureCode(value: unknown): value is JobFailureCode {
  return typeof value === "string" && (JOB_FAILURE_CODES as readonly string[]).includes(value);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
