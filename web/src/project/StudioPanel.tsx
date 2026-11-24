import { useState } from "react";
import { Link } from "react-router";
import { isApiError } from "../api/errors";
import type { OutputSummary, PlanView } from "../api/types";
import { measureText } from "../api/measure";
import { useApi, useFormats } from "../app/context";
import { Confirm } from "../app/Confirm";
import { ErrorNotice, LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { OUTLINE_BUTTON, OutlineButton } from "../design/Buttons";
import { FormatTile } from "../design/FormatTile";
import { GlimpseFace } from "../design/GlimpseFace";
import { Icon } from "../design/Icon";
import { Making } from "../design/Making";
import { RowMenu, type RowMenuItem } from "../design/RowMenu";
import { ChoiceButton } from "../plan/PlanCard";
import { playLabel, plannedLine, runningFor, timeLeft } from "../plan/planModel";
import { waitingLine } from "../plan/waiting";
import { madeVerb } from "../player/verbs";
import { TalkCount } from "../thread/Thread";
import { useRemakeWatch } from "../thread/remake";
import { RemakeMaking } from "../thread/RemakeMaking";
import { useThreadCounts } from "../thread/useThread";
import { useRightPanel, useRightViewRenderer } from "./rightPanel";
import { PLAN_ROW, directState, studioRows } from "./studio";
import "./made.css";

/**
 * The right column of a project: Make on top, one tile per shape from the
 * format registry and a row to plan a whole subject; Made here below, every
 * thing made or being made in the project, in the feed's own order. A tile
 * or the plan row opens the right panel's view for it (`rightPanel.tsx`).
 * Things to watch or go through say Play, things to read and plans say
 * Open; all are outlined. Every row has a ⋯ menu that deletes it: a made
 * thing and a plan ask first, a thing that failed or was stopped before it
 * made anything goes at once, and a thing being made is stopped first. With
 * two or more of those failed or stopped, one line at the foot clears them
 * all. A thing with one scene being made again shows that under it, with
 * Stop, and the new thing once it is made. Nothing here names a shape.
 */
export function StudioPanel({
  projectId,
  views,
  error,
  onFocus,
  onPlay,
  onChange,
  onRemoved,
  archived,
  reading,
}: {
  projectId: string;
  views?: PlanView[];
  error: unknown;
  /** Shows a plan's card in its chat: where a plan opens while no plan panel is plugged in. */
  onFocus: (planId: string) => void;
  /** Plays a made thing in the panel. */
  onPlay: (outputId: string) => void;
  /** Takes a plan view an action here answered with (Stop, Try again, Go on). */
  onChange: (v: PlanView) => void;
  /** A plan or a thing made at once was deleted for good here. */
  onRemoved: (planId: string) => void;
  archived?: boolean;
  /** A source is open in the left column: Make steps aside, Made here stays. */
  reading?: boolean;
}) {
  const formats = useFormats();
  const client = useApi();
  const panel = useRightPanel();
  const planPanel = useRightViewRenderer("plan");
  // Which made things have a thread, and how many messages: read again as the list changes.
  const threads = useThreadCounts(projectId, views?.length);
  // A scene being made again is followed until the new thing is the item's.
  useRemakeWatch(views, onChange);
  const rows = studioRows(views ?? []);
  // The faces of what was made, read again whenever something more is made.
  const madeKey = (views ?? []).flatMap((v) => v.items.map((i) => i.outputId ?? "")).join(",");
  const faces = useLoad(() => (madeKey.replace(/,/g, "") ? client.all((q) => client.projectOutputs(projectId, q)) : Promise.resolve([])), [client, projectId, madeKey]);
  const byOutput = new Map((faces.data ?? []).map((o) => [o.id, o]));
  const openPlan = (planId: string) => (planPanel ? panel.open({ kind: "plan", planId }) : onFocus(planId));
  // Things that failed or were stopped before they made anything: cleared together when there are two or more.
  const unmade = rows.filter((v) => v.plan.direct && (directState(v) === "failed" || directState(v) === "stopped"));
  return (
    <section className="col studio" aria-label="Make and Made here">
      <div className="sc">
        {!archived && !reading && (
          <div className="mk">
            <h2 className="mh">Make</h2>
            <div className="mtiles" role="group" aria-label="Make">
              {/* Until the engine says what it can make, the panel says so rather than standing empty. */}
              {formats.length === 0 && <p className="empty2">Getting what Open Sourcebook can make here…</p>}
              {formats.map((f) => (
                <button key={f.id} type="button" className="mtile" disabled={!f.ready} title={f.ready ? (f.blurb ?? f.about) : (f.problem ?? "Open Sourcebook can't make this yet.")} onClick={() => panel.open({ kind: "make", shape: f.id })}>
                  <FormatTile id={f.id} formats={formats} size="sm" />
                  <span>{f.label}</span>
                </button>
              ))}
            </div>
            <button type="button" className="mplan" onClick={() => panel.open({ kind: "planNew" })}>
              <span className="pic">
                <Icon name="list" />
              </span>
              <span className="tx">
                <b>{PLAN_ROW.title}</b>
                <small>{PLAN_ROW.sub}</small>
              </span>
              <Icon name="chev-r" />
            </button>
          </div>
        )}
        <div className="madehd">
          <h2 className="mh">Made here</h2>
          {rows.length > 0 && (
            <Link className="seelib" to={`/library?project=${projectId}`}>
              See in Library
            </Link>
          )}
        </div>
        <LoadState loading={views === undefined && !error} error={error} what="what was made" />
        {views && rows.length === 0 && <p className="empty2">Nothing yet. What you make shows up here, and plays here.</p>}
        {rows.length > 0 && (
          <ul className="slist" aria-label="Made here">
            {rows.map((v) => (
              <li key={v.plan.id}>
                {v.plan.direct ? (
                  <DirectRow view={v} output={byOutput.get(v.items[0]?.outputId ?? "")} onPlay={onPlay} onChange={onChange} onRemoved={onRemoved} talks={threads.counts.get(v.items[0]?.id ?? "") ?? 0} />
                ) : (
                  <PlanRow view={v} onOpen={() => openPlan(v.plan.id)} onChange={onChange} onRemoved={onRemoved} />
                )}
              </li>
            ))}
          </ul>
        )}
        {unmade.length >= 2 && <ClearUnmade views={unmade} onRemoved={onRemoved} />}
      </div>
    </section>
  );
}

/** One thing made at once: while it is made, the one progress look with Stop; once made, its face and Play or Open. */
function DirectRow({
  view,
  output,
  onPlay,
  onChange,
  onRemoved,
  talks,
}: {
  view: PlanView;
  output: OutputSummary | undefined;
  onPlay: (outputId: string) => void;
  onChange: (v: PlanView) => void;
  onRemoved: (planId: string) => void;
  talks: number;
}) {
  const client = useApi();
  const formats = useFormats();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [asking, setAsking] = useState(false);
  const { plan } = view;
  const item = view.items[0];
  if (!item) return null;
  const label = formats.find((f) => f.id === item.type)?.label ?? item.type;
  // "This set of flashcards goes", never "This flashcards goes".
  const one = formats.find((f) => f.id === item.type)?.singular ?? label;
  const state = directState(view);
  const made = state === "made" && item.outputId;
  const failed = state === "failed";
  const making = state === "making";
  const stopped = state === "stopped";
  async function remove() {
    setBusy(true);
    setError(undefined);
    try {
      await client.deletePlan(plan.id);
      setAsking(false);
      onRemoved(plan.id);
    } catch (e) {
      setError(deleteError(e));
      setBusy(false);
    }
  }
  // Made, it asks first; made nothing, it goes at once; being made, it is stopped first.
  const items: RowMenuItem[] = making
    ? [
        { label: "Stop", run: () => void act(() => client.cancel(plan.id)) },
        { label: "Delete…", note: "stop it first", danger: true, disabled: true, run: () => undefined },
      ]
    : made
      ? [{ label: "Delete…", danger: true, run: () => (setError(undefined), setAsking(true)) }]
      : [{ label: "Delete", danger: true, run: () => void remove() }];
  const menu = <RowMenu name={item.title} items={items} />;
  const ask = asking && (
    <Confirm title={`Delete “${item.title}” for good?`} action="Delete" busy={busy} error={error} onConfirm={() => void remove()} onCancel={() => (setAsking(false), setError(undefined))}>
      <p>
        This {one} goes for good: it leaves Made here and the Library.{talks > 0 ? " What was said about it stays in the chat." : ""} This can't be undone.
      </p>
    </Confirm>
  );
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
  const lead = <FormatTile id={item.type} formats={formats} size="sm" />;
  if (!made && (making || failed || stopped)) {
    const job = item.job;
    const left = making ? timeLeft(job) : undefined;
    const step = job?.step ?? (item.status === "running" ? "being made" : undefined);
    const text = failed
      ? `Couldn't be made${item.errorMessage ? `: ${item.errorMessage}` : ""}`
      : stopped
        ? "Stopped before it was made"
        : job?.waiting
          ? ["Waiting", waitingLine(job)].filter(Boolean).join(" · ")
          : ["Making", step, left ?? runningFor(job?.startedAt)].filter(Boolean).join(" · ");
    return (
      <div className="mhrow live" role="group" aria-label={item.title}>
        <Making
          state={failed ? "failed" : stopped ? "stopped" : job?.waiting ? "waiting" : "making"}
          title={item.title}
          text={text}
          lead={lead}
          {...(job && job.progress > 0 ? { progress: job.progress } : {})}
          {...(making ? { onStop: () => void act(() => client.cancel(plan.id)) } : {})}
          menu={menu}
          action={
            failed ? (
              <OutlineButton disabled={busy} onClick={() => void act(() => client.retryItem(plan.id, item.id))}>
                Try again
              </OutlineButton>
            ) : stopped ? (
              <OutlineButton disabled={busy} onClick={() => void act(() => client.resume(plan.id))}>
                Go on
              </OutlineButton>
            ) : undefined
          }
        />
        {job?.choice && <ChoiceButton choice={job.choice} busy={busy} onChoose={(id) => act(() => client.retryItem(plan.id, item.id, id))} />}
        <ErrorNotice error={error} />
      </div>
    );
  }
  const verb = madeVerb(formats, item.type);
  return (
    <>
      <div className="mhrow" role="group" aria-label={item.title}>
        <GlimpseFace type={item.type} glimpse={output?.glimpse} formats={formats} thumb showTile={false} />
        <span className="tx">
          <b>{item.title}</b>
          <small>
            {made ? [label, measureText(output?.size)].filter(Boolean).join(" · ") : plannedLine(item, label)}
            {made && output?.done && <span className="ok"> · done</span>}
          </small>
        </span>
        {talks > 0 && <TalkCount n={talks} />}
        {made && (
          <button className={OUTLINE_BUTTON} type="button" aria-label={verb === "Play" ? playLabel(item.title) : `Open ${item.title}`} onClick={() => onPlay(item.outputId!)}>
            {verb}
          </button>
        )}
        {menu}
      </div>
      {made && item.remaking && <RemakeMaking planId={plan.id} itemId={item.id} remaking={item.remaking} onChanged={() => void act(() => client.getPlan(plan.id))} />}
      {ask}
      {!asking && <ErrorNotice error={error} />}
    </>
  );
}

/** A plan among the made things: its title, where it stands, Open, and its ⋯ (Stop while it runs, Delete once it does not). */
function PlanRow({ view, onOpen, onChange, onRemoved }: { view: PlanView; onOpen: () => void; onChange: (v: PlanView) => void; onRemoved: (planId: string) => void }) {
  const client = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [asking, setAsking] = useState(false);
  const { plan, counts } = view;
  const enabled = view.items.filter((i) => i.enabled);
  const made = enabled.filter((i) => i.outputId).length;
  const name = plan.title || "Untitled plan";
  const state = plan.status === "failed" ? "failed" : plan.status === "cancelled" ? "stopped" : plan.status === "running" ? "making" : counts.total > 0 && counts.done < counts.total ? "stopped" : "done";
  const word = { failed: "Failed", stopped: plan.status === "cancelled" ? "Stopped" : "Ready", making: "Making", done: "Done" }[state];
  const running = plan.status === "running";
  async function stop() {
    setError(undefined);
    try {
      onChange(await client.cancel(plan.id));
    } catch (e) {
      setError(e);
    }
  }
  async function remove() {
    setBusy(true);
    setError(undefined);
    try {
      await client.deletePlan(plan.id);
      setAsking(false);
      onRemoved(plan.id);
    } catch (e) {
      setError(deleteError(e));
      setBusy(false);
    }
  }
  const items: RowMenuItem[] = [
    ...(running ? [{ label: "Stop", run: () => void stop() }] : []),
    { label: "Delete…", danger: true, disabled: running, ...(running ? { note: "stop it first" } : {}), run: () => (setError(undefined), setAsking(true)) },
  ];
  const all = view.items.length;
  return (
    <>
      <div className="mhrow plan" role="group" aria-label={`Plan: ${name}`}>
        <span className="pic">
          <Icon name="list" />
        </span>
        <span className="tx">
          <b>Plan: {name}</b>
          <small className={`making-st ${state}`}>
            <span className="dot" aria-hidden="true" />
            {word}
            <span className="rest">
              {" "}
              · {made} of {enabled.length} made
            </span>
          </small>
        </span>
        <OutlineButton aria-label={`Open ${name}`} onClick={onOpen}>
          Open
        </OutlineButton>
        <RowMenu name={`plan ${name}`} items={items} />
      </div>
      {asking && (
        <Confirm title={`Delete the plan “${name}” for good?`} action="Delete plan" busy={busy} error={error} onConfirm={() => void remove()} onCancel={() => (setAsking(false), setError(undefined))}>
          <p>
            {made > 0
              ? `Its ${count(all, "item")} and the ${count(made, "thing")} made from it go for good: they leave Made here and the Library.`
              : `Its ${count(all, "item")} ${all === 1 ? "goes" : "go"} for good. Nothing was made from it yet.`}{" "}
            This can't be undone.
          </p>
        </Confirm>
      )}
      {!asking && <ErrorNotice error={error} />}
    </>
  );
}

/** "1 item", "3 things". */
function count(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** What a refused delete says: a thing still being made is stopped first. */
function deleteError(e: unknown): unknown {
  return isApiError(e, "plan_running") ? new Error("It is still being made. Stop it first, then delete it.") : e;
}

/** One line at the foot of Made here: deletes every thing that failed or was stopped before it made anything, at once. */
function ClearUnmade({ views, onRemoved }: { views: PlanView[]; onRemoved: (planId: string) => void }) {
  const client = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function clear() {
    setBusy(true);
    setError(undefined);
    const results = await Promise.allSettled(views.map(async (v) => (await client.deletePlan(v.plan.id), v.plan.id)));
    for (const r of results) if (r.status === "fulfilled") onRemoved(r.value);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) setError(deleteError(failed.reason));
    setBusy(false);
  }
  return (
    <div className="mclear">
      <button className="mclear-b" type="button" disabled={busy} onClick={() => void clear()}>
        Clear failed and stopped
      </button>
      <ErrorNotice error={error} />
    </div>
  );
}
