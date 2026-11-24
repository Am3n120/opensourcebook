/**
 * The August `/v1/jobs` API, kept as a thin wrapper so the iOS app works
 * unchanged (engine/docs/api.md).
 *
 *   POST /v1/jobs              { sourceText, sourceURL?, sourceKind?, requestedDepth?, uploadId?,
 *                                projectId?, exemplarSummaries? } + Idempotency-Key → 202 { job }
 *   GET  /v1/jobs/:id          → { job }
 *   POST /v1/jobs/:id/retry    → 202 { job } | 409 not_retryable
 *   POST /v1/jobs/:id/cancel   → { job } | 409 already_done
 *
 * Inside, a POST adds the source (Inbox, or the project when the engine
 * knows it) and creates a `generation_jobs` row of kind 'output', type
 * 'flashcards'. The response is the August job JSON: one stage from August's
 * set, status queued | running | done | failed, progress, and on success
 * `result` (the set laid out as one version 1 page, for the phone build
 * that only knows pages), `cards` (the set itself, engine/docs/flashcards.md)
 * and `resultByteID` (their shared id; the name the old phone build reads).
 */
import { failureWords } from "../jobs/failure-words";
import { JobNotFoundError, cancelJob, retryJob } from "../jobs/lifecycle";
import type { GenerationJob } from "../jobs/types";
import { authenticate, errorResponse, json, notFound, readJsonObject } from "../http";
import { isHTTPURL, isRecord } from "../net";
import { SourceInputError } from "../sources/service";
import { GENERATION_DEPTHS, type GenerationDepth } from "../cards/blocks";
import type { CardSet } from "../cards/contract";
import { cardsToPage, isPagePayload, toCardSet } from "../cards/upgrade";
import { SOURCE_KINDS, type SourceKind } from "../types/source";
import type { WorkerExecutionContext } from "../types";
import { scheduleJob, type EngineDeps } from "../wiring";

/** The format quick mode makes (DECISIONS #3, #33). */
const QUICK_MODE_TYPE = "flashcards";
const MAX_EXEMPLAR_SUMMARIES = 12;
const MAX_EXEMPLAR_CHARS = 4_000;

/** August's stage names; the iOS client refuses any other. */
export const LEGACY_STAGES = ["queued", "extracting", "researching", "structuring", "writing", "verifying", "done", "failed"] as const;
export type LegacyStage = (typeof LEGACY_STAGES)[number];

/** The request as August stored it, echoed back on the job. */
interface LegacyRequest {
  sourceText: string;
  sourceURL?: string;
  uploadId?: string;
  sourceKind: SourceKind;
  requestedDepth: GenerationDepth;
  projectId?: string;
}

export async function createJob(request: Request, deps: EngineDeps, ctx: WorkerExecutionContext): Promise<Response> {
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const { body } = read;
  const auth = await authenticate(request, deps.clientToken, typeof body.clientToken === "string" ? body.clientToken : undefined);
  if ("response" in auth) return auth.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || (typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "");
  if (idempotencyKey.length < 8 || idempotencyKey.length > 256) {
    return errorResponse("idempotency_required", "An idempotency key of 8–256 characters is required", 401);
  }

  // A repeat of the same request (a relaunch, a retried POST) gets the first job back.
  const existing = await deps.jobs.findByKey(auth.ownerId, idempotencyKey);
  if (existing) return json({ job: await legacyJobView(deps, existing) }, 202);

  const parsed = parseCreateBody(body);
  if ("error" in parsed) return json(parsed.error, 400);
  const { legacy, exemplarSummaries } = parsed;

  const projectId = legacy.projectId ? await deps.sources.projectFor(auth.ownerId, legacy.projectId) : undefined;
  let sourceId: string;
  try {
    const added = await deps.sources.add({
      ownerId: auth.ownerId,
      ...(projectId ? { projectId } : {}),
      ...(legacy.uploadId ? { uploadId: legacy.uploadId } : {}),
      ...(legacy.sourceURL ? { url: legacy.sourceURL } : {}),
      ...(!legacy.uploadId && !legacy.sourceURL ? { text: legacy.sourceText } : {}),
      kind: legacy.sourceKind,
      origin: "share",
    });
    sourceId = added.source.id;
  } catch (error) {
    if (error instanceof SourceInputError) return errorResponse(error.code, error.message, error.status);
    throw error;
  }

  const caption = legacy.uploadId || legacy.sourceURL ? legacy.sourceText : "";
  const { job, created } = await deps.jobs.create({
    ownerId: auth.ownerId,
    idempotencyKey,
    kind: "output",
    type: QUICK_MODE_TYPE,
    // The phone's project id is kept on the job even when the engine has no such project yet.
    ...(legacy.projectId ? { projectId: legacy.projectId } : {}),
    sourceId,
    input: {
      sources: [{ sourceId }],
      settings: { depth: legacy.requestedDepth, ...(exemplarSummaries.length > 0 ? { exemplarSummaries } : {}) },
      ...(caption ? { contextText: caption } : {}),
      request: { ...legacy },
    },
  });
  if (created) scheduleJob(deps, job.id, ctx);
  return json({ job: await legacyJobView(deps, job) }, 202);
}

export async function getJob(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedJob(request, id, deps);
  if ("response" in owned) return owned.response;
  return json({ job: await legacyJobView(deps, owned.job) });
}

export async function retryLegacyJob(request: Request, id: string, deps: EngineDeps, ctx: WorkerExecutionContext): Promise<Response> {
  const owned = await ownedJob(request, id, deps);
  if ("response" in owned) return owned.response;
  const outcome = await retryJob(deps.jobs, id);
  if (outcome.kind === "refused") {
    const failed = outcome.job.status === "failed";
    return errorResponse(
      "not_retryable",
      failed ? "This job failed validation and is not retryable" : "Only failed jobs can be retried",
      409,
    );
  }
  scheduleJob(deps, id, ctx);
  return json({ job: await legacyJobView(deps, outcome.job) }, 202);
}

export async function cancelLegacyJob(request: Request, id: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedJob(request, id, deps);
  if ("response" in owned) return owned.response;
  try {
    const outcome = await cancelJob(deps.jobs, id);
    if (outcome.kind === "done") return errorResponse("already_done", "A completed job cannot be cancelled", 409);
    // A plan item's job: its plan hears about it as it would from the consumer.
    if (outcome.kind === "cancelled") await deps.consumer?.onFinished?.(outcome.job);
    return json({ job: await legacyJobView(deps, outcome.job) });
  } catch (error) {
    if (error instanceof JobNotFoundError) return notFound("Job not found");
    throw error;
  }
}

async function ownedJob(request: Request, id: string, deps: EngineDeps): Promise<{ job: GenerationJob } | { response: Response }> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth;
  const job = await deps.jobs.get(id);
  if (!job || job.ownerId !== auth.ownerId) return { response: notFound("Job not found") };
  return { job };
}

/**
 * The August job JSON for a generation job.
 *
 * A retryable failure is shown as still running while a queue will
 * redeliver it, so the phone keeps polling instead of latching a failure
 * the next attempt may clear; once the queue gives up the job is `dead` and
 * shows as failed. Cancelled and dead jobs show as failed, as August
 * showed a cancel.
 */
/** Why a job failed in plain words (jobs/failure-words.ts), and its technical text apart. */
function failedWords(deps: EngineDeps, job: GenerationJob): { errorMessage: string; errorDetail?: string } {
  const descriptor = job.type ? deps.registry.descriptor(job.type) : undefined;
  const thing = descriptor?.singular ?? descriptor?.label ?? "item";
  return { errorMessage: failureWords(job, thing), ...(job.errorMessage ? { errorDetail: job.errorMessage } : {}) };
}

export async function legacyJobView(deps: EngineDeps, job: GenerationJob): Promise<Record<string, unknown>> {
  const legacy = isRecord(job.input.request) ? (job.input.request as unknown as LegacyRequest) : undefined;
  const base: Record<string, unknown> = {
    id: job.id,
    sourceText: legacy?.sourceText ?? "",
    ...(legacy?.sourceURL ? { sourceURL: legacy.sourceURL } : {}),
    ...(legacy?.uploadId ? { uploadId: legacy.uploadId } : {}),
    sourceKind: legacy?.sourceKind ?? "unknown",
    requestedDepth: legacy?.requestedDepth ?? "auto",
    ...(job.projectId ? { projectId: job.projectId } : {}),
    progress: job.progress,
    retryCount: Math.max(0, job.attempt - 1),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };

  switch (job.status) {
    case "queued":
      return { ...base, stage: "queued", status: "queued", progress: 0, retryable: false };
    case "running":
    case "waiting":
      return { ...base, stage: legacyStage(job.stage), status: "running", retryable: false };
    case "failed":
      if (job.retryable && deps.queue) return { ...base, stage: legacyStage(job.stage), status: "running", retryable: false };
      return { ...base, stage: "failed", status: "failed", retryable: job.retryable, ...failedWords(deps, job) };
    case "cancelled":
      return { ...base, stage: "failed", status: "failed", retryable: false, errorMessage: "Cancelled by user" };
    case "dead":
      return { ...base, stage: "failed", status: "failed", retryable: true, ...failedWords(deps, job) };
    case "done": {
      const output = job.outputId ? await deps.repos.outputs.get(job.outputId) : undefined;
      const views = output ? payloadViews(output.payload) : undefined;
      return {
        ...base,
        stage: "done",
        status: "done",
        progress: 1,
        retryable: false,
        ...(views ? { resultByteID: views.cards.id, result: views.page, cards: views.cards } : {}),
      };
    }
  }
}

/** Engine stage names onto August's; anything new reads as writing. */
export function legacyStage(stage: string): LegacyStage {
  switch (stage) {
    case "queued":
      return "queued";
    case "starting":
    case "extracting":
      return "extracting";
    case "researching":
    case "structuring":
    case "writing":
    case "verifying":
      return stage;
    case "repairing":
      return "verifying";
    case "done":
      return "done";
    default:
      return "writing";
  }
}

type ParsedCreate = { legacy: LegacyRequest; exemplarSummaries: string[] } | { error: Record<string, unknown> };

/** August's parseCreateInput: the same fields, defaults and error codes. */
function parseCreateBody(body: Record<string, unknown>): ParsedCreate {
  const rawSourceText = typeof body.sourceText === "string" ? body.sourceText.trim() : "";
  let sourceURL = typeof body.sourceURL === "string" && body.sourceURL.trim() ? body.sourceURL.trim() : undefined;
  const uploadId = typeof body.uploadId === "string" && body.uploadId.trim() ? body.uploadId.trim() : undefined;
  const projectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : undefined;

  // Share sheets hand a link over as text; the first http(s) URL becomes the
  // source and any caption stays as context.
  let sourceText = rawSourceText;
  if (!sourceURL && rawSourceText) {
    const promoted = promoteURLFromText(rawSourceText);
    if (promoted) {
      sourceURL = promoted.url;
      sourceText = promoted.remainder;
    }
  }
  if (!sourceText && !sourceURL && !uploadId) {
    return { error: { error: "source_required", message: "sourceText, sourceURL, or uploadId is required" } };
  }
  if (sourceText.length > 100_000) {
    return { error: { error: "source_too_large", message: "sourceText must be at most 100000 characters" } };
  }
  if (sourceURL && !isHTTPURL(sourceURL)) {
    return { error: { error: "invalid_source_url", message: "sourceURL must be an absolute HTTP(S) URL" } };
  }
  if (body.sourceKind !== undefined && !isSourceKind(body.sourceKind)) {
    return { error: { error: "invalid_source_kind", message: `sourceKind must be one of ${SOURCE_KINDS.join(", ")}` } };
  }
  const sourceKind: SourceKind = isSourceKind(body.sourceKind) ? body.sourceKind : sourceURL ? "web" : "text";
  const rawDepth = body.requestedDepth ?? body.depth ?? "auto";
  if (typeof rawDepth !== "string" || !(GENERATION_DEPTHS as readonly string[]).includes(rawDepth)) {
    return { error: { error: "invalid_depth", message: `depth must be one of ${GENERATION_DEPTHS.join(", ")}` } };
  }

  const exemplarSummaries: string[] = [];
  if (body.exemplarSummaries !== undefined) {
    const list = body.exemplarSummaries;
    if (!Array.isArray(list)) {
      return { error: { error: "invalid_exemplars", message: "exemplarSummaries must be an array of caller-supplied strings" } };
    }
    if (list.length > MAX_EXEMPLAR_SUMMARIES) {
      return { error: { error: "too_many_exemplars", message: `exemplarSummaries must contain at most ${MAX_EXEMPLAR_SUMMARIES} entries` } };
    }
    for (const entry of list) {
      if (typeof entry !== "string" || !entry.trim() || entry.length > MAX_EXEMPLAR_CHARS) {
        return {
          error: {
            error: "invalid_exemplars",
            message: `Each exemplar summary must be a non-empty string of at most ${MAX_EXEMPLAR_CHARS} characters`,
          },
        };
      }
      exemplarSummaries.push(entry.trim());
    }
  }

  return {
    legacy: {
      sourceText,
      ...(sourceURL ? { sourceURL: new URL(sourceURL).toString() } : {}),
      ...(uploadId ? { uploadId } : {}),
      sourceKind,
      requestedDepth: rawDepth as GenerationDepth,
      ...(projectId ? { projectId } : {}),
    },
    exemplarSummaries,
  };
}

function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && (SOURCE_KINDS as readonly string[]).includes(value);
}

/** The first http(s) URL in free text, trailing prose punctuation stripped, and the rest. */
function promoteURLFromText(text: string): { url: string; remainder: string } | undefined {
  const match = /https?:\/\/[^\s]+/i.exec(text);
  if (!match) return undefined;
  const candidate = match[0].replace(/[),.;'"\]]+$/, "");
  if (!isHTTPURL(candidate)) return undefined;
  const remainder = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.replace(/\s+/g, " ").trim();
  return { url: candidate, remainder };
}

/** A finished job's output as the page the old phone build reads and as the set of cards. */
function payloadViews(payload: unknown): { page: Record<string, unknown>; cards: CardSet } | undefined {
  if (!isRecord(payload) || typeof payload.id !== "string") return undefined;
  if (isPagePayload(payload)) return { page: payload as unknown as Record<string, unknown>, cards: toCardSet(payload, 1)! };
  const cards = toCardSet(payload, Array.isArray(payload.cards) ? 3 : 2);
  return cards ? { page: cardsToPage(cards) as unknown as Record<string, unknown>, cards } : undefined;
}
