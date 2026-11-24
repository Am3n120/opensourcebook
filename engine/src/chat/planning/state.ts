/**
 * A plan's state in the words every planner is told it in: the turn's
 * prompt, read_plan and every tool that touches a plan. One place, so the
 * agent never meets a raw status code ("approved" reads like "started")
 * and never has to work out from the conversation whether Start was
 * pressed.
 */
import type { Plan } from "../../studio/repositories";

/** Whether a plan may still change: not started and not discarded. */
export function isOpen(plan: Pick<Plan, "kickedOffAt" | "status">): boolean {
  return !plan.kickedOffAt && plan.status !== "discarded";
}

/** The plan's state now, in a short clause. */
export function planState(plan: Pick<Plan, "kickedOffAt" | "status">): string {
  if (plan.status === "discarded") return "discarded before it started: it can't change or start";
  if (!plan.kickedOffAt) return "not started: it can still change, and nothing is made until the person presses Start";
  switch (plan.status) {
    case "done":
      return "started, and everything in it is made: its items can't change";
    case "failed":
      return "started, and it stopped because items failed: its items can't change, failed ones can be tried again";
    case "cancelled":
      return "started, then stopped part way: its items can't change, and Resume makes the rest";
    default:
      return "started: Open Sourcebook is making its items stage by stage, and they can't change";
  }
}
