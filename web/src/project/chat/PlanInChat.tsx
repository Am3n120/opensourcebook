import type { ReactNode } from "react";
import type { PlanView } from "../../api/types";
import { Icon } from "../../design/Icon";
import { useRightPanel, useRightViewRenderer } from "../rightPanel";

/**
 * A plan in the chat. Once a plan view is plugged into the right column it
 * is a compact card, its title, where it stands and Open, which opens the
 * plan there; until then the plan's own card, as it has always been drawn.
 */
export function PlanInChat({ view, card }: { view: PlanView; card: ReactNode }) {
  const panel = useRightPanel();
  const hasPanel = useRightViewRenderer("plan") !== undefined;
  if (!hasPanel) return <>{card}</>;
  const title = view.plan.title || "Untitled plan";
  const made = view.items.filter((i) => i.status === "done").length;
  return (
    <div className="cplan" role="group" aria-label={`Plan: ${title}`} id={`plan-${view.plan.id}`}>
      <span className="cplan-ic" aria-hidden="true">
        <Icon name="list" />
      </span>
      <span className="cplan-tx">
        <b>Plan: {title}</b>
        <small>{standing(view, made)}</small>
      </span>
      <button type="button" className="obtn" onClick={() => panel.open({ kind: "plan", planId: view.plan.id })}>
        Open
      </button>
    </div>
  );
}

/** Where a plan stands, in a few words. */
function standing(view: PlanView, made: number): string {
  const n = view.items.length;
  const items = `${n} item${n === 1 ? "" : "s"}`;
  switch (view.plan.status) {
    case "draft":
    case "approved":
      return `${items} · Not started`;
    case "running":
      return `Making · ${made} of ${n} made`;
    case "cancelled":
      return `Stopped · ${made} of ${n} made`;
    case "failed":
      return `Failed · ${made} of ${n} made`;
    case "done":
      return `${items} · All made`;
    case "discarded":
      return `${items} · Discarded`;
    default:
      return items;
  }
}
