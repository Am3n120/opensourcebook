import { useState } from "react";
import { Link } from "react-router";
import type { PlanView } from "../api/types";
import { measureText } from "../api/measure";
import { useApi, useFormats } from "../app/context";
import { useLoad } from "../app/useLoad";
import { ErrorNotice } from "../app/Status";
import { FormatTile } from "../design/FormatTile";
import { OUTLINE_BUTTON } from "../design/Buttons";
import { madeVerb } from "../player/verbs";
import { playLabel, plannedLine, runningFor, timeLeft } from "../plan/planModel";
import { waitingLine } from "../plan/waiting";
import { ChoiceButton } from "../plan/PlanCard";
import "./made.css";
import { TalkCount } from "../thread/Thread";
import { useRemakeWatch } from "../thread/remake";
import { RemakeMaking } from "../thread/RemakeMaking";

/**
 * One thing made at once (a plan of one item marked `direct`), as it shows
 * in the chat: its face, title and what it will be; while it is made, its
 * live step with the time left where known, and Stop; once made, Play and a
 * quiet line saying it can be changed by just asking. It is not a plan card:
 * there is nothing to approve and no Start. Nothing here names a format.
 */
export function MadeRow({
  view,
  onPlay,
  onChange,
  remakeOf,
  compact,
  talks = 0,
}: {
  view: PlanView;
  onPlay?: (outputId: string) => void;
  /** Takes the view an action here answered with (Stop, Try again, Go on). */
  onChange: (view: PlanView) => void;
  /** The title of the thing this one remakes, when it is a remake. */
  remakeOf?: string;
  /** In a list (the Studio): no hint about the chat. */
  compact?: boolean;
  /** Messages in its thread, when it has one. */
  talks?: number;
}) {
  const client = useApi();
  const formats = useFormats();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const { plan } = view;
  const item = view.items[0];
  const made = item?.status === "done" && item.outputId;
  // What was made says how big it is and whether it was ticked done; read once it exists.
  // A scene being made again is followed until the new thing is the item's.
  useRemakeWatch([view], onChange);
  const output = useLoad(async () => (made && item ? (await client.planOutputs(plan.id).catch(() => [])).find((o) => o.id === item?.outputId) : undefined), [client, plan.id, item?.outputId, made]).data;
  if (!item) return null;
  const label = formats.find((f) => f.id === item.type)?.label ?? item.type;
  const verb = madeVerb(formats, item.type);
  const making = plan.status === "running" && !made && item.status !== "failed";
  const stopped = plan.status === "cancelled" && !made;
  const failed = item.status === "failed";
  const left = making ? timeLeft(item.job) : undefined;
  const step = making ? (item.job?.step ?? (item.status === "running" ? "Being made" : "Waiting to start")) : undefined;

  async function act(run: () => Promise<PlanView>) {
    setBusy(true);
    setError(undefined);
    try {
      onChange(await run());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`made${compact ? " compact" : ""}${made ? " ready" : ""}`} role="group" aria-label={item.title} id={`plan-${plan.id}`}>
      <div className="mrow">
        <FormatTile id={item.type} formats={formats} size="md" solid={Boolean(made)} done={item.done} />
        <div className="mtx">
          <b>{item.title}</b>
          <small>
            {made ? [label, measureText(output?.size)].filter(Boolean).join(" · ") : plannedLine(item, label)}
            {made && output?.done && <span className="ok"> · done</span>}
          </small>
          {remakeOf && <small className="from">Remade from “{remakeOf}”</small>}
        </div>
        {talks > 0 && <TalkCount n={talks} />}
        {made &&
          (onPlay ? (
            <button className={OUTLINE_BUTTON} type="button" aria-label={verb === "Play" ? playLabel(item.title) : `Open ${item.title}`} onClick={() => onPlay(item.outputId!)}>
              {verb}
            </button>
          ) : (
            <Link className={OUTLINE_BUTTON} to={`/outputs/${item.outputId}`} aria-label={playLabel(item.title)}>
              {verb}
            </Link>
          ))}
      </div>
      {making && (
        <div className="mstate live" role="status">
          {item.job?.waiting ? (
            <>
              <span>
                {step} <small className="waitwhy">{waitingLine(item.job)}</small>
              </span>
              {item.job.choice && <ChoiceButton choice={item.job.choice} busy={busy} onChoose={(id) => act(() => client.retryItem(plan.id, item.id, id))} />}
            </>
          ) : (
            <span>
              {step}
              {left ? ` · ${left}` : runningFor(item.job?.startedAt)}
            </span>
          )}
          <button className="mini" type="button" disabled={busy} onClick={() => void act(() => client.cancel(plan.id))}>
            Stop
          </button>
        </div>
      )}
      {failed && (
        <div className="mstate fail" role="status">
          <span>{item.errorMessage ?? "It could not be made."}</span>
          <button className="mini" type="button" disabled={busy} onClick={() => void act(() => client.retryItem(plan.id, item.id))}>
            Try again
          </button>
          {item.job?.choice && <ChoiceButton choice={item.job.choice} busy={busy} onChoose={(id) => act(() => client.retryItem(plan.id, item.id, id))} />}
        </div>
      )}
      {stopped && (
        <div className="mstate" role="status">
          <span>Stopped before it was made.</span>
          <button className="mini" type="button" disabled={busy} onClick={() => void act(() => client.resume(plan.id))}>
            Go on
          </button>
        </div>
      )}
      {made && item.remaking && <RemakeMaking planId={plan.id} itemId={item.id} remaking={item.remaking} onChanged={() => void act(() => client.getPlan(plan.id))} />}
      {made && !compact && <small className="mhint">Want it different? Just say so here: shorter, simpler, another look, more of it.</small>}
      <ErrorNotice error={error} />
    </div>
  );
}
