import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Item, PlanView, Provider } from "../api/types";
import { Link } from "react-router";
import { ApiError } from "../api/errors";
import { useApi, useAppData } from "../app/context";
import { Confirm } from "../app/Confirm";
import { ErrorNotice, LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { OutlineButton, PrimaryButton } from "../design/Buttons";
import { FormatTile } from "../design/FormatTile";
import { findFormat, lookFor } from "../design/formatLook";
import { Icon } from "../design/Icon";
import { Making } from "../design/Making";
import { MadeByBox } from "../make/MadeByBox";
import { MakerPicker } from "../make/MakerPicker";
import { pickIdOf } from "../make/madeBy";
import type { LoadedTimes } from "../make/makeTime";
import { agentField, turnKindOf } from "../make/makerKey";
import { ShapeSettings } from "../make/ShapeSettings";
import { madeVerb } from "../player/verbs";
import { dayWords, hasLeft, localDay, missedStages, whenOf } from "./days";
import { AddItem } from "./ItemForm";
import { draftOf, itemKey, toPatch, type Draft } from "./itemDraft";
import { usePlan } from "./PlanContext";
import { PlanProvider } from "./PlanProvider";
import { allDefaults, itemMaker, itemTimeWords, leftToMake, makersByShape, phaseOf, pickWords, planTimeWords, statusWords, watchMinutes, type ItemMaker, type Phase } from "./panelModel";
import { buildStages, conditionText, durationText, issueFix, newStageLevel, plannedLine, plannedLineByAgent, playLabel, splitIssues, timeLeft, withBranches, type Row, type StageGroup } from "./planModel";
import { usePlanStart } from "./usePlanStart";
import { waitingLine } from "./waiting";
import "./planPanel.css";

/** How often a running plan is read again while its panel is open. */
const POLL_MS = 2000;

export interface PlanPanelProps {
  planId: string;
  projectId: string;
  /** Back to Make and Made here. */
  onClose: () => void;
  /** Every view the panel reads or an action answers with, so the project's own copy follows. */
  onPlanChange: (view: PlanView) => void;
  onPlay: (outputId: string) => void;
}

/**
 * A plan in the right panel: before Start, the items to tick and change and
 * one Start; while it runs, one progress line per item and one Stop all;
 * stopped, Resume and who makes what is left. Each item the engine is
 * making (queued, running, or its job waiting) has its own Stop, as
 * `POST .../items/:itemId/stop` takes only those; one it stopped has Go on
 * (`.../retry`). It reads the plan itself, again while it runs.
 */
export function PlanPanel({ planId, projectId, onClose, onPlanChange, onPlay }: PlanPanelProps) {
  const client = useApi();
  const plan = useLoad(() => client.getPlan(planId), [client, planId]);
  const sources = useLoad(() => client.all((q) => client.projectSources(projectId, q)), [client, projectId]);
  const running = plan.data?.plan.status === "running";
  const { reload, set, data } = plan;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(t);
  }, [running, reload]);
  // Handed on by a ref: a caller that passes a new function each render never makes this run again.
  const tell = useRef(onPlanChange);
  useEffect(() => {
    tell.current = onPlanChange;
  });
  useEffect(() => {
    if (data) tell.current(data);
  }, [data]);
  const change = useCallback((v: PlanView) => set(v), [set]);

  if (!data)
    return (
      <section className="plp" aria-label="Plan">
        <header className="plp-head">
          <div className="plp-top">
            <BackButton onClose={onClose} />
            <h2>Plan</h2>
          </div>
        </header>
        <div className="plp-body">
          <LoadState loading={plan.loading} error={plan.error} what="this plan" onRetry={() => void reload()} />
        </div>
      </section>
    );
  return (
    <PlanProvider view={data} onChange={change} sources={sources.data ?? []}>
      <PanelView onClose={onClose} onPlay={onPlay} />
    </PlanProvider>
  );
}

function BackButton({ onClose }: { onClose: () => void }) {
  return (
    <button className="ib" type="button" aria-label="Back to Made here" onClick={onClose}>
      <Icon name="chev-l" />
    </button>
  );
}

/** Every making time kept on this computer, for all shapes at once. An engine without the route has none. */
function useAllTimes(): LoadedTimes {
  const client = useApi();
  const loaded = useLoad(async () => {
    try {
      return await client.makeTimes();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    }
  }, [client]);
  if (loaded.error) return null;
  return loaded.data;
}

/** Who makes each item and how long that takes, by item id. */
function useMakers(items: readonly Item[]): Map<string, ItemMaker> {
  const { formats, providers } = useAppData();
  const times = useAllTimes();
  const rail = providers?.providers ?? [];
  return new Map(items.map((i) => [i.id, itemMaker(i, formats, rail, providers?.picks, times)]));
}

type Open = { kind: "item"; id: string } | { kind: "add" } | { kind: "maker"; id?: string } | null;

function PanelView({ onClose, onPlay }: { onClose: () => void; onPlay: (outputId: string) => void }) {
  const { view, error } = usePlan();
  const heading = useId();
  const [open, setOpen] = useState<Open>(null);
  const [said, setSaid] = useState<string>();
  const phase = phaseOf(view);
  const stages = buildStages(view.items, view.stages);
  const makers = useMakers(view.items);
  const dated = stages.some((s) => s.dueOn);
  const status = statusWords(phase);
  return (
    <section className={`plp ${phase}`} aria-labelledby={heading}>
      <header className="plp-head">
        <div className="plp-top">
          <BackButton onClose={onClose} />
          <h2 id={heading}>Plan: {view.plan.title || "Untitled plan"}</h2>
          <span className={`making-st ${status.state}`}>
            <span className="dot" aria-hidden="true" />
            {status.text}
          </span>
        </div>
        <div className="plp-sub">
          <Summary phase={phase} makers={makers} onChangeAll={() => setOpen({ kind: "maker" })} />
          <CatchUp stages={stages} />
          {said && (
            <p className="plp-line" role="status">
              {said}
            </p>
          )}
          {phase !== "draft" && <ErrorNotice error={error} />}
        </div>
      </header>
      <div className="plp-body">
        {view.items.length === 0 && <p className="plp-note">Nothing in this plan yet.</p>}
        {stages.map((stage) => (
          <StageBlock key={stage.level} stage={stage} count={stages.length} phase={phase} makers={makers} open={open} setOpen={setOpen} onPlay={onPlay} />
        ))}
        {open?.kind === "add" && (
          <div className="plp-add">
            <AddItem level={stages.at(-1)?.level ?? newStageLevel(view.items)} onDone={(id) => setOpen(id ? { kind: "item", id } : null)} />
          </div>
        )}
        {dated && (
          <p className="plp-note">
            Days only show when you gave one. A day never changes what is made or in what order. Reminders for due stages are in <Link to="/settings#reminders">Settings</Link>.
          </p>
        )}
      </div>
      {phase === "draft" && <DraftFoot makers={makers} adding={open?.kind === "add"} onAdd={() => setOpen({ kind: "add" })} />}
      {open?.kind === "maker" && <ChangeMaker {...(open.id ? { itemId: open.id } : {})} onSaid={setSaid} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** The plan in one line under its title, and what can be done to it as a whole. */
function Summary({ phase, makers, onChangeAll }: { phase: Phase; makers: Map<string, ItemMaker>; onChangeAll: () => void }) {
  const { view, formats, edit, busy } = usePlan();
  const client = useApi();
  const { items } = view;
  const ticked = items.filter((i) => i.enabled);
  const watch = watchMinutes(items, formats);
  const watchText = watch !== undefined ? `${durationText(watch)} to watch` : undefined;
  if (phase === "draft") {
    const make = planTimeWords(ticked.map((i) => makers.get(i.id)));
    return (
      <>
        <p className="plp-line">
          {items.length} item{items.length === 1 ? "" : "s"}, {ticked.length} ticked
          {watchText && (
            <>
              {" · "}
              <b>{watchText}</b>
            </>
          )}
          {make && (
            <>
              {" · "}
              {make.muted ? "no time yet to make" : <b>{make.text} to make</b>}
            </>
          )}
        </p>
        <Defaults makers={makers} onChangeAll={onChangeAll} />
      </>
    );
  }
  const made = ticked.filter((i) => i.outputId).length;
  const left = leftToMake(items);
  const rest = planTimeWords(left.map((i) => makers.get(i.id)));
  const pct = ticked.length ? Math.round((made / ticked.length) * 100) : 0;
  const bar = (
    <div className="making-line" role="progressbar" aria-label={`${made} of ${ticked.length} made`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
  const madeWords = <b>{`${made} of ${ticked.length} made`}</b>;
  if (phase === "running")
    return (
      <>
        {bar}
        <div className="plp-row">
          <p className="plp-line">
            {madeWords}
            {rest && !rest.muted && ` · ${rest.text} left`}
            {made > 0 && " · you can play what's made"}
          </p>
          <OutlineButton icon="x" disabled={busy} onClick={() => void edit(() => client.cancel(view.plan.id))}>
            Stop all
          </OutlineButton>
        </div>
      </>
    );
  if (phase === "stopped")
    return (
      <>
        {bar}
        <p className="plp-line">
          {madeWords}
          {watchText && ` · ${watchText} in all`}
          {rest && left.length > 0 && ` · ${rest.muted ? "no time yet for the rest" : `${rest.text} to make the rest`}`}
        </p>
        <div className="plp-acts">
          {view.plan.status === "cancelled" && (
            <PrimaryButton icon="play" disabled={busy} onClick={() => void edit(() => client.resume(view.plan.id))}>
              Resume
            </PrimaryButton>
          )}
          {left.some((i) => makers.get(i.id)?.maker) && (
            <OutlineButton disabled={busy} onClick={onChangeAll}>
              Change maker for what's left
            </OutlineButton>
          )}
        </div>
      </>
    );
  if (phase === "done")
    return (
      <>
        {bar}
        <p className="plp-line">
          {madeWords}
          {watchText && ` · ${watchText} in all`}
        </p>
      </>
    );
  return <p className="plp-line">Discarded before Start. Nothing was made from it.</p>;
}

/** Who makes the ticked items, by shape, with Change for all. */
function Defaults({ makers, onChangeAll }: { makers: Map<string, ItemMaker>; onChangeAll: () => void }) {
  const { view, formats } = usePlan();
  const { providers } = useAppData();
  const shapes = makersByShape(view.items, makers, providers?.providers ?? []);
  if (shapes.length === 0) return null;
  return (
    <div className="plp-defaults">
      <span>
        <b>{allDefaults(view.items, formats, providers?.picks) ? "Made by your defaults:" : "Made by:"}</b> {shapes.map((s) => `${s.shape} ${s.words}`).join("; ")}
      </span>
      <OutlineButton onClick={onChangeAll}>Change for all</OutlineButton>
    </div>
  );
}

/** When stages' days passed with something left in them: one line, and a press moves the days on from today. */
function CatchUp({ stages }: { stages: StageGroup[] }) {
  const { view, edit, busy } = usePlan();
  const client = useApi();
  const today = localDay();
  const missed = missedStages(stages, today);
  if (missed.length === 0 || view.plan.status === "discarded" || view.plan.status === "cancelled") return null;
  const due = stages.filter((s) => s.dueOn && whenOf(s.dueOn, today) === "today" && hasLeft(s)).length;
  const words = `${missed.length} stage${missed.length === 1 ? "" : "s"} missed${due > 0 ? `, ${due} due today` : ""}.`;
  return (
    <div className="plp-catchup" role="status">
      <span>
        <b>{words}</b> Moving the days on keeps the same gaps and starts from today.
      </span>
      <PrimaryButton disabled={busy} onClick={() => void edit(() => client.catchUp(view.plan.id, today))}>
        Move the days on
      </PrimaryButton>
    </div>
  );
}

/** A stage's day at the right of its name, with how it stands: done, missed, Today. */
function StageDay({ stage }: { stage: StageGroup }) {
  if (!stage.dueOn) return null;
  const today = localDay();
  const words = dayWords(stage.dueOn, today);
  if (!hasLeft(stage)) return <span className="plp-day done">{words} · done</span>;
  const when = whenOf(stage.dueOn, today);
  return <span className={`plp-day ${when}`}>{when === "missed" ? `${words} · missed` : words}</span>;
}

function StageBlock({ stage, count, phase, makers, open, setOpen, onPlay }: { stage: StageGroup; count: number; phase: Phase; makers: Map<string, ItemMaker>; open: Open; setOpen: (o: Open) => void; onPlay: (outputId: string) => void }) {
  const name = stage.label ? `${stage.number} · ${stage.label}` : count > 1 ? `Stage ${stage.number}` : "To make";
  return (
    <section className="plp-stage" aria-label={name}>
      <div className="plp-lbl">
        <span>{name}</span>
        <StageDay stage={stage} />
      </div>
      {stage.rows.map((row) => {
        const maker = makers.get(row.item.id) ?? { reviewer: null };
        return (
          <div key={row.item.id} className="plp-slot" data-testid="item" data-depth={row.depth} style={row.depth > 0 ? { marginLeft: row.depth * 28 } : undefined}>
            {phase === "draft" ? (
              <DraftRow row={row} maker={maker} open={open?.kind === "item" && open.id === row.item.id} onOpen={(on) => setOpen(on ? { kind: "item", id: row.item.id } : null)} />
            ) : (
              <StartedRow row={row} phase={phase} maker={maker} onPlay={onPlay} onChangeMaker={() => setOpen({ kind: "maker", id: row.item.id })} />
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Who makes an item and how long that takes: "Z Mid · medium · about 6 min". */
function makerWords(m: ItemMaker, rail: readonly Provider[]): string[] {
  const time = itemTimeWords(m);
  const who = m.maker && m.format ? [pickWords(m.maker, rail, turnKindOf(m.format, "maker"))] : [];
  return [...who, ...(time ? [time.text] : [])];
}

/** A branch's condition, said on its row: "If you score under 70% on “Practice exam”". */
function branchWords(row: Row): string[] {
  if (row.depth === 0 && !row.item.condition) return [];
  const words = conditionText(row.item.condition, row.parent?.title);
  return words ? [words] : [];
}

function DraftRow({ row, maker, open, onOpen }: { row: Row; maker: ItemMaker; open: boolean; onOpen: (on: boolean) => void }) {
  const { view, formats, edit, busy } = usePlan();
  const { providers } = useAppData();
  const client = useApi();
  const { item } = row;
  const issues = splitIssues(view).byItem.get(item.id) ?? [];
  const fix = issues[0] && issueFix(issues[0].code);
  // Who makes it is said by its model and effort, as on the make sheet, in place of the maker's own word.
  const label = lookFor(formats, item.type).label;
  const what = maker.format && agentField(maker.format, "maker") ? plannedLineByAgent(item, label) : plannedLine(item, label);
  const line = [what, ...branchWords(row), ...makerWords(maker, providers?.providers ?? [])].join(" · ");
  return (
    <div className={`plp-item${open ? " open" : ""}${item.enabled ? "" : " off"}`}>
      <div className="plp-it">
        <button
          type="button"
          role="checkbox"
          aria-checked={item.enabled}
          aria-label={`Make ${item.title}`}
          title={item.enabled ? "Will be made. Untick to leave it out." : "Left out. Tick to make it."}
          className={`plp-tick${item.enabled ? " on" : ""}`}
          disabled={busy}
          onClick={() => void edit(() => client.updateItem(view.plan.id, item.id, { enabled: !item.enabled }))}
        >
          {item.enabled && <Icon name="check" />}
        </button>
        <FormatTile id={item.type} formats={formats} size="sm" />
        <div className="plp-nm">
          <b>{item.title}</b>
          <span>{line}</span>
        </div>
        {open ? (
          <button className="ib" type="button" aria-label={`Close ${item.title}`} aria-expanded onClick={() => onOpen(false)}>
            <Icon name="up" />
          </button>
        ) : (
          <OutlineButton aria-label={`Change ${item.title}`} aria-expanded={false} onClick={() => onOpen(true)}>
            Change
          </OutlineButton>
        )}
      </div>
      {!open && issues.length > 0 && (
        <p className="plp-issue" role="status">
          {issues.map((i) => i.short || i.message).join(" ")}
          {fix && (
            <button type="button" className="plp-link" onClick={() => onOpen(true)}>
              {fix.label}
            </button>
          )}
        </p>
      )}
      {open && <ItemEditor key={itemKey(item)} item={item} onClose={() => onOpen(false)} />}
    </div>
  );
}

/** An item's settings before Start: its title, shape, brief and sources, then the same settings and Made by box as the make sheet. */
function ItemEditor({ item, onClose }: { item: Item; onClose: () => void }) {
  const { view, formats, sources, edit, busy, error } = usePlan();
  const client = useApi();
  const before = draftOf(item);
  const [draft, setDraft] = useState<Draft>(before);
  const [problem, setProblem] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const format = findFormat(formats, draft.type);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const chosen = new Set(draft.sources.map((s) => s.sourceId));
  const removes = withBranches(view.items, item.id);
  const ids = useId();

  async function save(e: FormEvent) {
    e.preventDefault();
    const patch = toPatch(before, draft);
    if ("error" in patch) return setProblem(patch.error);
    setProblem(undefined);
    if (Object.keys(patch.value).length === 0) return onClose();
    if (await edit(() => client.updateItem(view.plan.id, item.id, patch.value))) onClose();
  }

  return (
    <form className="plp-ed" onSubmit={save} aria-label={`Change ${item.title}`}>
      <div className="plp-two">
        <label className="plp-f">
          <span>Title</span>
          <input className="ipt" required maxLength={200} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="plp-f">
          <span>Made as</span>
          <select className="ipt" value={draft.type} onChange={(e) => set({ type: e.target.value, settings: {} })}>
            {!format && <option value={draft.type}>{draft.type}</option>}
            {formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="plp-f">
        <span>What it covers</span>
        <textarea className="ipt" rows={3} maxLength={20000} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} />
      </label>
      <div className="plp-f" role="group" aria-labelledby={`${ids}-reads`}>
        <span id={`${ids}-reads`}>Reads</span>
        <div className="chips">
          {sources.length === 0 && <small>The project has no sources yet.</small>}
          {/* A source that could not be read is offered only if the item already reads it, so it can be taken off. */}
          {sources
            .filter((s) => s.status !== "failed" || chosen.has(s.id))
            .map((s) => (
              <button
                key={s.id}
                type="button"
                className={`chip${chosen.has(s.id) ? " on" : ""}`}
                aria-pressed={chosen.has(s.id)}
                onClick={() => set({ sources: chosen.has(s.id) ? draft.sources.filter((x) => x.sourceId !== s.id) : [...draft.sources, { sourceId: s.id }] })}
              >
                {s.title}
              </button>
            ))}
        </div>
      </div>
      {format && <ShapeSettings format={format} settings={draft.settings} onChange={(settings) => set({ settings })} />}
      {format && <MadeByBox format={format} settings={draft.settings} onChange={(settings) => set({ settings })} />}
      {format && !format.ready && <small className="plp-note">{format.problem ?? `${format.label} can't be made yet: an item in it blocks Start while it is ticked.`}</small>}
      {problem && <div className="notice error">{problem}</div>}
      <ErrorNotice error={error} />
      <div className="plp-edf">
        <button className="plp-link danger" type="button" onClick={() => setRemoving(true)}>
          Remove
        </button>
        <span className="sp" />
        <OutlineButton onClick={onClose}>Cancel</OutlineButton>
        <PrimaryButton type="submit" disabled={busy || !draft.title.trim()}>
          Save
        </PrimaryButton>
      </div>
      {removing && (
        <Confirm title={`Remove “${item.title}”?`} action="Remove" busy={busy} onConfirm={() => void edit(() => client.deleteItem(view.plan.id, item.id)).then((ok) => ok && onClose())} onCancel={() => setRemoving(false)}>
          <p>{removes.length > 1 ? `The ${removes.length - 1} item${removes.length > 2 ? "s" : ""} under it go too.` : "It is taken out of the plan."}</p>
        </Confirm>
      )}
    </form>
  );
}

/** An item once the plan has started: made, being made, waiting, failed or not made. */
function StartedRow({ row, phase, maker, onPlay, onChangeMaker }: { row: Row; phase: Phase; maker: ItemMaker; onPlay: (outputId: string) => void; onChangeMaker: () => void }) {
  const { view, formats, edit, act, busy } = usePlan();
  const { providers } = useAppData();
  const client = useApi();
  const { item } = row;
  const tile = <FormatTile id={item.type} formats={formats} size="sm" solid={Boolean(item.outputId)} done={item.done} />;
  const label = lookFor(formats, item.type).label;
  // An item the person's agent makes says its maker by model and effort, or not at all once made; never "Your agent".
  const what = maker.format && agentField(maker.format, "maker") ? plannedLineByAgent(item, label) : plannedLine(item, label);
  const retry = (choice?: string) => void edit(() => client.retryItem(view.plan.id, item.id, choice));

  if (item.outputId) {
    const verb = madeVerb(formats, item.type);
    return (
      <div className="plp-item made">
        <div className="plp-it">
          {tile}
          <div className="plp-nm">
            <b>{item.title}</b>
            <span>{[what, ...(item.done ? ["gone through"] : [])].join(" · ")}</span>
          </div>
          <OutlineButton aria-label={verb === "Play" ? playLabel(item.title) : `Open ${item.title}`} onClick={() => onPlay(item.outputId!)}>
            {verb}
          </OutlineButton>
        </div>
      </div>
    );
  }
  if (item.status === "failed") {
    const canRetry = view.plan.status === "running" || view.plan.status === "failed";
    return (
      <Making
        state="failed"
        title={item.title}
        text={`Couldn't be made: ${item.errorMessage ?? "it stopped part way"}`}
        lead={tile}
        action={
          canRetry ? (
            <OutlineButton icon="retry" disabled={busy} onClick={() => retry()}>
              Try again
            </OutlineButton>
          ) : undefined
        }
      />
    );
  }
  if (phase === "running" && item.asking) {
    return (
      <div className="plp-item wait">
        <div className="plp-it">
          {tile}
          <div className="plp-nm">
            <b>{item.title}</b>
            <span>{item.asking.question || "Make this one?"}</span>
          </div>
          <OutlineButton disabled={busy} onClick={() => void act(() => client.answer(view.plan.id, item.id, false))}>
            Skip
          </OutlineButton>
          <PrimaryButton disabled={busy} onClick={() => void act(() => client.answer(view.plan.id, item.id, true))}>
            Yes
          </PrimaryButton>
        </div>
      </div>
    );
  }
  // Stopped on its own while the rest of the plan goes on: Go on makes it again.
  if (phase === "running" && item.status === "cancelled") {
    return (
      <Making
        state="stopped"
        title={item.title}
        text="Stopped"
        lead={tile}
        action={
          <OutlineButton icon="play" disabled={busy} onClick={() => retry()}>
            Go on
          </OutlineButton>
        }
      />
    );
  }
  if (phase === "running" && item.enabled && item.status !== "skipped") {
    const job = item.job;
    const live = item.status === "running" && !job?.waiting;
    const branch = branchWords(row);
    const time = itemTimeWords(maker);
    const text = live
      ? ["Making", job?.step, timeLeft(job)].filter(Boolean).join(" · ")
      : job?.waiting
        ? ["Waiting", job.step, waitingLine(job)].filter(Boolean).join(" · ")
        : branch.length > 0
          ? ["waits", ...branch].join(" · ")
          : ["waiting", ...(time && !time.muted ? [time.text] : [])].join(" · ");
    return (
      <>
        <Making
          state={live ? "making" : "waiting"}
          title={item.title}
          text={text}
          lead={tile}
          {...(item.status === "queued" || item.status === "running" ? { onStop: () => void edit(() => client.stopItem(view.plan.id, item.id)) } : {})}
          {...(live && job && job.progress > 0 ? { progress: job.progress, progressLabel: `${item.title}: ${Math.round(job.progress * 100)}%` } : {})}
        />
        {job?.choice && (
          <div className="plp-choice">
            <OutlineButton disabled={busy} onClick={() => retry(job.choice!.id)}>
              {job.choice.label}
            </OutlineButton>
          </div>
        )}
      </>
    );
  }
  const words = !item.enabled ? ["left out"] : item.status === "skipped" ? ["skipped"] : phase === "done"
        ? branchWords(row)
        : ["Not made", ...branchWords(row), ...makerWords(maker, providers?.providers ?? [])];
  const canChange = phase === "stopped" && item.enabled && item.status !== "skipped" && maker.maker !== undefined;
  return (
    <div className={`plp-item wait${item.enabled ? "" : " off"}`}>
      <div className="plp-it">
        {tile}
        <div className="plp-nm">
          <b>{item.title}</b>
          <span>{[what, ...words].join(" · ")}</span>
        </div>
        {canChange && (
          <OutlineButton aria-label={`Change who makes ${item.title}`} disabled={busy} onClick={onChangeMaker}>
            Change
          </OutlineButton>
        )}
      </div>
    </div>
  );
}

/** Discard, Add an item, and one Start with the time to make the ticked items. */
function DraftFoot({ makers, adding, onAdd }: { makers: Map<string, ItemMaker>; adding: boolean; onAdd: () => void }) {
  const { view, edit, busy, error } = usePlan();
  const client = useApi();
  const [discarding, setDiscarding] = useState(false);
  const ticked = view.items.filter((i) => i.enabled);
  const time = planTimeWords(ticked.map((i) => makers.get(i.id)));
  const issues = splitIssues(view).plan;

  // Pressing Start is the approval; with several agents ready and none picked, it asks who makes them first.
  const { start, picker } = usePlanStart();

  return (
    <footer className="plp-foot">
      {issues.length > 0 && view.items.length > 0 && (
        <div className="notice warn" role="status">
          Before it can start: {issues.join(" ")}
        </div>
      )}
      <ErrorNotice error={error} />
      <div className="plp-ft">
        <OutlineButton disabled={busy} onClick={() => setDiscarding(true)}>
          Discard
        </OutlineButton>
        <span className="sp" />
        {!adding && (
          <OutlineButton icon="plus" disabled={busy} onClick={onAdd}>
            Add an item
          </OutlineButton>
        )}
        {/* The time sits on Start's own line, the way "Start · about 22 min" reads; with none yet, a quiet note to its right. */}
        <span className="plp-go">
          <PrimaryButton icon="play" disabled={busy || ticked.length === 0} onClick={() => void start()}>
            {time && !time.muted ? `Start · ${time.text}` : "Start"}
          </PrimaryButton>
          {time?.muted && (
            <span className="plp-notime" title="Some of it has not been made here with these picks.">
              no time yet
            </span>
          )}
        </span>
      </div>
      {discarding && (
        <Confirm title={`Discard “${view.plan.title || "Untitled plan"}”?`} action="Discard plan" busy={busy} onConfirm={() => void edit(() => client.cancel(view.plan.id)).then(() => setDiscarding(false))} onCancel={() => setDiscarding(false)}>
          <p>It stays in the chat, marked discarded, and can't be edited or started. Nothing has been made from it yet.</p>
        </Confirm>
      )}
      {picker}
    </footer>
  );
}

/**
 * Who makes the items not made yet: every one ("Change for all", "Change
 * maker for what's left") or one item. Before Start it is an edit; on a
 * stopped plan only what is left changes, and Resume makes it with the new maker.
 */
function ChangeMaker({ itemId, onSaid, onClose }: { itemId?: string; onSaid: (words: string | undefined) => void; onClose: () => void }) {
  const { view, formats, edit } = usePlan();
  const client = useApi();
  const { providers } = useAppData();
  const phase = phaseOf(view);
  const which = itemId ? view.items.filter((i) => i.id === itemId) : phase === "draft" ? view.items.filter((i) => i.enabled) : leftToMake(view.items);
  const makers = which.map((i) => ({ item: i, m: itemMaker(i, formats, providers?.providers ?? [], providers?.picks, []) })).filter((x) => x.m.maker);
  const first = makers[0];
  if (!first?.m.format) return null;
  // For the whole plan, the picker is titled for it, not for the first item's shape, and shows times only when every item is one shape.
  const whole = itemId ? undefined : phase === "draft" ? { title: "Made by, for every item in this plan", note: "Each item's own settings change; your defaults stay." } : { title: "Made by, for every item not made yet", note: "Resume makes them with it." };
  const shapes = new Set(makers.map((x) => x.m.format?.id));
  return (
    <MakerPicker
      scope={first.m.format.id}
      value={first.m.maker ?? null}
      settings={first.item.settings}
      {...(whole ? { title: whole.title, note: whole.note } : {})}
      {...(shapes.size > 1 ? { noTimes: true } : {})}
      onClose={onClose}
      onChange={(pick) => {
        if (!pick) return;
        onSaid(undefined);
        void edit(async () => {
          const r = await client.changePlanMaker(view.plan.id, { agent: pickIdOf(pick), effort: pick.effort ?? null, ...(itemId ? { items: [itemId] } : {}) });
          const kept = [...new Set(r.unchanged.map((u) => u.why))];
          if (r.unchanged.length > 0) onSaid(`${r.unchanged.length} left as ${r.unchanged.length === 1 ? "it was" : "they were"}: ${kept.join("; ")}.`);
          return r;
        });
      }}
    />
  );
}
