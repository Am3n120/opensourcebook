/**
 * Which line a job is made in, so a quick thing never waits behind a slow one.
 *
 * On this computer the queue hands its consumer one batch at a time and waits
 * for that batch to finish before it hands over the next (the local Workers
 * runtime's queue does this), so a job delivered while a video was being drawn
 * waited the whole video, though the two share nothing. So there are two
 * lines, each a queue of its own with its own consumer:
 *
 *   - `heavy`: items whose format says making one uses most of this computer
 *     for many minutes (`FormatDefinition.heavy`: frames drawn in several
 *     browser tabs at once). They are made one after another, which is the
 *     reason for the line: two at once would share the processor and memory
 *     and each take about twice as long, or run out of memory on a laptop.
 *   - `shared`: everything else (writing by the person's agent or a model),
 *     side by side with the heavy line, a few at once within a batch.
 *
 * Without a second queue bound (an engine set up before it existed) every
 * job goes in the one line, as before.
 */
import type { FormatRegistry } from "../studio/registry";
import type { GenerationJob, JobQueueMessageBody } from "./types";

export type Lane = "heavy" | "shared";

export interface JobSender {
  send(body: JobQueueMessageBody): Promise<unknown>;
}

/** The line a job is made in, when there is a line for heavy work (`heavyLine`). */
export function laneOf(job: Pick<GenerationJob, "type">, registry: Pick<FormatRegistry, "get">, heavyLine: boolean): Lane {
  if (!heavyLine || !job.type) return "shared";
  return registry.get(job.type)?.heavy ? "heavy" : "shared";
}

/** Whether two jobs wait for each other: the same person's, in the same line. */
export function sameLine(a: Pick<GenerationJob, "type" | "ownerId" | "kind">, b: Pick<GenerationJob, "type" | "ownerId" | "kind">, registry: Pick<FormatRegistry, "get">, heavyLine: boolean): boolean {
  return a.ownerId === b.ownerId && a.kind === b.kind && laneOf(a, registry, heavyLine) === laneOf(b, registry, heavyLine);
}

/**
 * Sends a job to its line's queue: the heavy queue for heavy work when there is one, else the shared queue. The job
 * is read for its format; one that cannot be read goes to the shared queue, whose consumer settles it.
 */
export async function sendToLane(
  jobId: string,
  queues: { shared: JobSender; heavy?: JobSender },
  read: (id: string) => Promise<Pick<GenerationJob, "type"> | undefined>,
  registry: Pick<FormatRegistry, "get">,
): Promise<void> {
  const heavy = queues.heavy;
  if (heavy) {
    const job = await read(jobId).catch(() => undefined);
    if (job && laneOf(job, registry, true) === "heavy") {
      await heavy.send({ jobId });
      return;
    }
  }
  await queues.shared.send({ jobId });
}

/** Jobs run at once from a batch of this queue: one for the heavy line (`heavyQueue`, its name), else the consumer's own. */
export function batchConcurrency(queue: string, heavyQueue: string | undefined): number | undefined {
  return heavyQueue && queue === heavyQueue ? 1 : undefined;
}
