import { useCallback, useState, type ReactNode } from "react";
import type { PlanView, Source } from "../api/types";
import { useApi, useFormats } from "../app/context";
import { PlanContext, type PlanCtx } from "./PlanContext";
import { canEditItems } from "./planModel";

/** Gives one plan card its edits and its errors. */
export function PlanProvider({ view, onChange, sources, ticked, children }: { view: PlanView; onChange: (v: PlanView) => void; sources: Source[]; ticked?: string[]; children: ReactNode }) {
  const client = useApi();
  const formats = useFormats();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const planId = view.plan.id;

  const edit = useCallback(
    async (run: () => Promise<PlanView>) => {
      setBusy(true);
      setError(undefined);
      try {
        onChange(await run());
        return true;
      } catch (e) {
        setError(e);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onChange],
  );
  const act = useCallback(
    (run: () => Promise<unknown>) =>
      edit(async () => {
        await run();
        return client.getPlan(planId);
      }),
    [edit, client, planId],
  );

  const ctx: PlanCtx = { view, formats, sources, ...(ticked ? { ticked } : {}), editable: canEditItems(view.plan.status), edit, act, busy, error };
  return <PlanContext.Provider value={ctx}>{children}</PlanContext.Provider>;
}
