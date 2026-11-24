/**
 * Making one scene of a made thing again (docs/api.md, "Remaking one scene").
 *
 *   POST /v1/outputs/:id/scenes/:scene/remake   { note?, agent?, model?, effort? }   → 202 { job, remakeOf }
 *
 * Only a format that declares it can (`FormatDefinition.remakeScene`; today video) takes it, and only for a made
 * output whose maker can. It starts an ordinary job of that format on the output's own item, with `remakeOf` in its
 * input, on the agent, model and effort the thing was made with unless the request names another; the job writes a
 * new output on that item, so the old one stays (and plays) until the new one is there, and the new one is the item's
 * newest. Its progress, Stop (`POST /v1/jobs/:id/cancel`) and times are any job's. Nothing here names a format.
 */
import { pickId } from "../chat/providers";
import { authenticate, errorResponse, json, notFound, readJsonObject } from "../http";
import { isRecord } from "../net";
import type { GenerationJob, JsonObject } from "../jobs/types";
import { KEPT_KEY, CHECKPOINTS_KEY } from "../studio/output-runner";
import type { JsonValue } from "../studio/types";
import type { WorkerExecutionContext } from "../types";
import { scheduleJob, type EngineDeps } from "../wiring";

const MAX_NOTE = 2_000;
/** Jobs of an item that are still being made. */
const MAKING: readonly string[] = ["queued", "running", "waiting"];

export async function remakeScene(request: Request, outputId: string, scene: string, deps: EngineDeps, ctx: WorkerExecutionContext): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const stored = await deps.repos.outputs.getPlaced(outputId);
  if (!stored || stored.ownerId !== auth.ownerId || stored.archivedAt) return notFound("Output not found");
  const output = deps.registry.served(stored);
  const format = deps.registry.get(output.type);
  const thing = format?.descriptor.singular ?? output.type;
  const remake = format?.remakeScene;
  if (!format || !remake) return errorResponse("cannot_remake", `No part of a ${thing} can be made again on its own; make it again whole instead.`, 409);
  const scenes = remake.scenes(output.payload);
  if (scenes.length === 0) return errorResponse("cannot_remake", `A scene of this ${thing} can't be made again: the way it was made has no way to. Make it again whole instead.`, 409);
  if (!scenes.includes(scene)) return notFound(`This ${thing} has no scene ${scene}`);

  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const body = read.body;
  const problems: string[] = [];
  const text = (key: string, max = 200): string | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.length > max) {
      problems.push(`${key} must be text of at most ${max} characters`);
      return undefined;
    }
    return value.trim() || undefined;
  };
  const note = text("note", MAX_NOTE);
  const agent = text("agent");
  const model = text("model");
  const effort = text("effort");
  if (problems.length > 0) return errorResponse("invalid_request", problems.join("; "), 400);

  // One making at a time on an item: its own job, or a remake of what it made, still under way.
  if (output.nodeId) {
    const busy = ((await deps.jobs.listByNode?.(output.nodeId, 20)) ?? []).find((job) => MAKING.includes(job.status));
    if (busy) return errorResponse("being_made", `This ${thing} is being made now. Wait for it to finish, or stop it, then try again.`, 409);
  }

  // What made it: the job that wrote it, and what its maker kept there to find its work again.
  const madeBy = await deps.jobs.findByOutput?.(output.id);
  const kept = keptOf(madeBy);
  const refused = await remake.check({ payload: output.payload, scene, ...(madeBy ? { madeBy: madeBy.id } : {}), kept, signal: request.signal });
  if (refused) return errorResponse("cannot_remake", refused, 409);

  // Made the way it was made, unless the person names another agent (with its own model and effort) or another model or effort.
  const settings: Record<string, JsonValue> = { ...((isRecord(output.settings) ? output.settings : {}) as Record<string, JsonValue>) };
  const field = format.descriptor.settings.find((candidate) => candidate.kind === "agent" && candidate.role !== "review");
  if (field?.kind === "agent") {
    const made = remake.madeWith?.(output.payload);
    const pick = agent ? { agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}) } : made ? { agent: made.agent, ...((model ?? made.model) ? { model: model ?? made.model } : {}), ...((effort ?? made.effort) ? { effort: effort ?? made.effort } : {}) } : undefined;
    if (pick) {
      settings[field.key] = pickId(pick);
      if (field.effortKey) {
        if (pick.effort) settings[field.effortKey] = pick.effort;
        else delete settings[field.effortKey];
      }
    }
  }
  const parsed = format.parseSettings(settings);
  if (!parsed.ok) return errorResponse("invalid_request", parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "), 400);

  const node = output.nodeId ? await deps.repos.plans.getNode(output.nodeId) : undefined;
  const key = request.headers.get("idempotency-key")?.trim();
  const { job, created } = await deps.jobs.create({
    ownerId: auth.ownerId,
    idempotencyKey: `remake:${output.id}:${scene}:${key && key.length <= 200 ? key : crypto.randomUUID()}`,
    kind: "output",
    type: output.type,
    ...(output.projectId ? { projectId: output.projectId } : {}),
    ...(output.planId ? { planId: output.planId } : {}),
    ...(output.nodeId ? { nodeId: output.nodeId } : {}),
    input: {
      sources: output.sources.map((source) => ({ sourceId: source.sourceId, ...(source.range ? { range: source.range } : {}) })),
      title: node?.title ?? output.title,
      ...(output.prompt !== undefined ? { prompt: output.prompt } : {}),
      settings,
      remakeOf: { outputId: output.id, scene, ...(note ? { note } : {}), ...(madeBy ? { madeBy: madeBy.id } : {}), kept },
    } as unknown as JsonObject,
  });
  if (created) scheduleJob(deps, job.id, ctx);
  return json({ job: { id: job.id, status: job.status, stage: job.stage, progress: job.progress }, remakeOf: { outputId: output.id, scene } }, 202);
}

/** What a finished job's maker kept to find its work again; on a job from before that was kept, its saved pieces. */
function keptOf(job: GenerationJob | undefined): Record<string, JsonValue> {
  const kept = job?.state[KEPT_KEY] ?? job?.state[CHECKPOINTS_KEY];
  return isRecord(kept) ? (kept as Record<string, JsonValue>) : {};
}

/** The remake a job is, as its input says: the output and its scene. */
export function remakeOfJob(job: Pick<GenerationJob, "input">): { outputId: string; scene: string; note?: string } | undefined {
  const of = job.input.remakeOf;
  if (!isRecord(of) || typeof of.outputId !== "string" || typeof of.scene !== "string") return undefined;
  return { outputId: of.outputId, scene: of.scene, ...(typeof of.note === "string" && of.note ? { note: of.note } : {}) };
}
