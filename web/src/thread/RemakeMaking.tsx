import { useState } from "react";
import { isApiError } from "../api/errors";
import type { JsonObject, Remaking } from "../api/types";
import { useApi } from "../app/context";
import { ErrorNotice } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { OutlineButton } from "../design/Buttons";
import { Making } from "../design/Making";
import { announceRemake, remakeLine, sceneNumber } from "./remake";
import "./remake.css";

/**
 * A scene being made again, in the one progress look: Stop while it is
 * under way, Try again (with the same note) once it failed. `payload` is the
 * remade thing's, to count its scene; without it, it is read. `onChanged`
 * hears a Stop or a new try.
 */
export function RemakeMaking({ planId, itemId, remaking, payload, title, onChanged }: { planId: string; itemId: string; remaking: Remaking; payload?: JsonObject; title?: string; onChanged: () => void }) {
  const client = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const read = useLoad(() => (payload ? Promise.resolve(undefined) : client.getOutput(remaking.outputId)), [client, payload, remaking.outputId]);
  const n = sceneNumber(payload ?? read.data?.payload, remaking.scene);
  const { state, text } = remakeLine(remaking, n);
  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await run();
      onChanged();
    } catch (e) {
      // Stopped already, or done meanwhile: what it is now is read again.
      if (isApiError(e, "already_done")) onChanged();
      else setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="remaking">
      <Making
        state={state}
        text={text}
        {...(title ? { title } : {})}
        {...(remaking.job.progress > 0 && state === "making" ? { progress: remaking.job.progress } : {})}
        onStop={() => void act(() => client.cancelJob(remaking.job.id))}
        action={
          state === "failed" ? (
            <OutlineButton disabled={busy} onClick={() => void act(async () => (await client.remakeScene(remaking.outputId, remaking.scene, remaking.note ? { note: remaking.note } : {}), announceRemake(planId, itemId)))}>
              Try again
            </OutlineButton>
          ) : undefined
        }
      />
      <ErrorNotice error={error} />
    </div>
  );
}
