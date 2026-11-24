import type { ItemStatus, PlanStatus, PlanView } from "../api/types";
import { findFormat, type FormatLike } from "../design/formatLook";

export type Tone = "run" | "done" | "fail" | "idle";

/** What a project is making right now, for its Home card. */
export interface MakingNow {
  /** The plan doing it; stopping it stops that plan. */
  planId: string;
  /** The shape's own word, from its descriptor: "video". Absent while only waiting for a turn. */
  what?: string;
  /** Still queued behind other work, not yet running. */
  waiting: boolean;
  /** Whole minutes left, only when the maker says when it expects to be done. */
  minutes?: number;
}

/** The thing being made in a project: the running item of a running plan, else the first queued one. Nothing when nothing is. */
export function makingNow(plans: readonly PlanView[], formats: readonly FormatLike[], now: number = Date.now()): MakingNow | undefined {
  const running = plans.filter((v) => v.plan.status === "running");
  for (const view of running) {
    const active = view.items.find((i) => i.enabled && i.status === "running") ?? view.items.find((i) => i.enabled && i.status === "queued");
    if (!active) continue;
    const doneBy = active.status === "running" && !active.job?.leftUnknown && active.job?.doneBy ? Date.parse(active.job.doneBy) : NaN;
    return {
      planId: view.plan.id,
      what: findFormat(formats, active.type)?.label ?? active.type,
      waiting: active.status !== "running",
      ...(Number.isFinite(doneBy) ? { minutes: Math.max(1, Math.ceil((doneBy - now) / 60_000)) } : {}),
    };
  }
  const first = running[0];
  return first ? { planId: first.plan.id, waiting: true } : undefined;
}

/** How a plan's status reads on screen. */
export function planStatusText(status: PlanStatus): { text: string; tone: Tone } {
  switch (status) {
    case "draft":
      return { text: "Draft", tone: "idle" };
    case "approved":
      return { text: "Approved, not started", tone: "idle" };
    case "running":
      return { text: "Plan running", tone: "run" };
    case "done":
      return { text: "Done", tone: "done" };
    case "failed":
      return { text: "Failed", tone: "fail" };
    case "cancelled":
      return { text: "Stopped", tone: "idle" };
    case "discarded":
      return { text: "Discarded", tone: "idle" };
    default:
      return { text: status, tone: "idle" };
  }
}

export function itemStatusText(status: ItemStatus): { text: string; tone: Tone } {
  switch (status) {
    case "pending":
      return { text: "Not started", tone: "idle" };
    case "queued":
      return { text: "Queued", tone: "run" };
    case "running":
      return { text: "Making", tone: "run" };
    case "done":
      return { text: "Ready", tone: "done" };
    case "failed":
      return { text: "Failed", tone: "fail" };
    case "skipped":
      return { text: "Skipped", tone: "idle" };
    case "cancelled":
      return { text: "Cancelled", tone: "idle" };
    default:
      return { text: status, tone: "idle" };
  }
}
