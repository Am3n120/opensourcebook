import { useState, type ReactNode } from "react";
import type { ApiClient } from "../api/client";
import type { FormatDescriptor, PlanView } from "../api/types";
import { useApi } from "../app/context";
import { findFormat } from "../design/formatLook";
import { pickIdOf } from "../make/madeBy";
import { agentField, type MakerPick } from "../make/makerKey";
import { MakerPicker } from "../make/MakerPicker";
import { isPickNeeded, PICK_MAKER } from "../make/pickNeeded";
import { usePlan } from "./PlanContext";

/** A shape whose items in the plan leave who makes them open, and those items: what the engine asks a pick for. */
export function openMakerScope(view: PlanView, formats: readonly FormatDescriptor[]): { scope: string; items: string[] } | undefined {
  const byScope = new Map<string, { open: string[]; all: string[] }>();
  for (const item of view.items) {
    if (!item.enabled || item.status === "done") continue;
    const format = findFormat(formats, item.type);
    const field = agentField(format, "maker");
    if (!format || !field) continue;
    const entry = byScope.get(format.id) ?? { open: [], all: [] };
    const raw = item.settings[field.key] ?? format.defaults[field.key];
    if (raw === undefined || raw === "auto") entry.open.push(item.id);
    entry.all.push(item.id);
    byScope.set(format.id, entry);
  }
  const entries = [...byScope.entries()];
  const open = entries.find(([, e]) => e.open.length > 0);
  if (open) return { scope: open[0], items: open[1].open };
  const any = entries[0];
  return any && { scope: any[0], items: any[1].all };
}

/** Start: pressing it is the approval. A pick given first goes on the items that left it open. */
export async function startPlan(client: ApiClient, view: PlanView, pick?: { pick: MakerPick; items: string[] }): Promise<PlanView> {
  const id = view.plan.id;
  const current = pick ? await client.changePlanMaker(id, { agent: pickIdOf(pick.pick), effort: pick.pick.effort ?? null, items: pick.items }) : view;
  const approved = current.plan.status === "draft" ? await client.approve(id) : current;
  return approved.plan.status === "approved" ? client.start(id) : approved;
}

/**
 * The plan's Start, and the picker it opens when several agents could make
 * its items and none is picked: the person picks who makes them and Start
 * runs again with that pick, never showing the refusal as an error.
 */
export function usePlanStart(): { start: () => Promise<void>; picker: ReactNode } {
  const { view, formats, edit } = usePlan();
  const client = useApi();
  const [asking, setAsking] = useState<{ scope: string; items: string[] }>();

  async function run(pick?: { pick: MakerPick; items: string[] }) {
    let ask: { scope: string; items: string[] } | undefined;
    await edit(async () => {
      try {
        return await startPlan(client, view, pick);
      } catch (e) {
        if (!isPickNeeded(e)) throw e;
        const now = await client.getPlan(view.plan.id);
        ask = openMakerScope(now, formats);
        if (!ask) throw e;
        return now;
      }
    });
    if (ask) setAsking(ask);
  }

  const picker = asking && (
    <MakerPicker
      scope={asking.scope}
      value={null}
      note={PICK_MAKER}
      onChange={(pick) => {
        if (pick) void run({ pick, items: asking.items });
      }}
      onClose={() => setAsking(undefined)}
    />
  );
  return { start: () => run(), picker };
}
