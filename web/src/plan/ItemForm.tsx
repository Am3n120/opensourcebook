import { useContext, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import type { Condition, FormatDescriptor, Item } from "../api/types";
import { Ctx, useApi, useEdgeKinds } from "../app/context";
import { useLoad } from "../app/useLoad";
import { findFormat, lookFor } from "../design/formatLook";
import { Icon } from "../design/Icon";
import { draftOf, EMPTY, toInput, toPatch, type Draft } from "./itemDraft";
import { usePlan } from "./PlanContext";
import {
  briefLine,
  buildStages,
  byRunOrder,
  conditionText,
  edgeSources,
  edgesOf,
  edgeKindLabel,
  moveToStage,
  moveWithinStage,
  neighbourLevel,
  parentOptions,
  parseCondition,
  resultText,
  seedRememberedPicks,
  settingsLines,
  withBranches,
} from "./planModel";
import { SettingsForm } from "./SettingsForm";

/**
 * An item's details under its row: what it is for (the brief's first
 * sentence, the line written for people), what it reads and its settings.
 * Before Start, Edit opens the editor; the whole brief is one more tap.
 */
export function ItemDetails({ item, onClose, edit = false, toSources = false }: { item: Item; onClose: () => void; /** Opens straight in the editor. */ edit?: boolean; /** And brings its sources into view. */ toSources?: boolean }) {
  const { editable } = usePlan();
  const [editing, setEditing] = useState(edit);
  return editable && editing ? <ItemEditor item={item} toSources={toSources} onClose={() => setEditing(false)} /> : <ItemSummary item={item} onEdit={editable ? () => setEditing(true) : undefined} onClose={onClose} />;
}

function ItemEditor({ item, onClose, toSources = false }: { item: Item; onClose: () => void; /** Brings its source picker into view, opened to pick sources. */ toSources?: boolean }) {
  const { view, edit, busy } = usePlan();
  const client = useApi();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (toSources) form.current?.querySelector('[aria-label="Sources"]')?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [toSources]);
  const before = draftOf(item);
  const [draft, setDraft] = useState(before);
  const [problem, setProblem] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const removes = withBranches(view.items, item.id);
  const move = (placements: ReturnType<typeof moveWithinStage>) => placements.length > 0 && edit(() => client.reorder(view.plan.id, placements));
  const up = moveWithinStage(view.items, item.id, -1);
  const down = moveWithinStage(view.items, item.id, 1);
  const earlier = neighbourLevel(view.items, item.id, -1);
  const later = neighbourLevel(view.items, item.id, 1);

  async function save(e: FormEvent) {
    e.preventDefault();
    const patch = toPatch(before, draft);
    if ("error" in patch) return setProblem(patch.error);
    setProblem(undefined);
    if (Object.keys(patch.value).length === 0) return onClose();
    await edit(() => client.updateItem(view.plan.id, item.id, patch.value));
  }

  return (
    <form ref={form} className="ed" onSubmit={save} aria-label="Item details">
      <Fields item={item} draft={draft} setDraft={setDraft}>
        <Edges item={item} />
        <div className="fl">Place in the plan</div>
        <div className="moves">
          <button className="mini" type="button" disabled={busy || up.length === 0} aria-label={`Move ${item.title} up`} onClick={() => move(up)}>
            <Icon name="up" />
            Up
          </button>
          <button className="mini" type="button" disabled={busy || down.length === 0} aria-label={`Move ${item.title} down`} onClick={() => move(down)}>
            <Icon name="down" />
            Down
          </button>
          <button className="mini" type="button" disabled={busy || earlier === undefined} aria-label={`Move ${item.title} to an earlier stage`} onClick={() => earlier !== undefined && move(moveToStage(view.items, item.id, earlier))}>
            <Icon name="chev-l" />
            Earlier stage
          </button>
          <button className="mini" type="button" disabled={busy || later === undefined} aria-label={`Move ${item.title} to a later stage`} onClick={() => later !== undefined && move(moveToStage(view.items, item.id, later))}>
            Later stage
            <Icon name="chev-r" />
          </button>
        </div>
        <RunsIn item={item} />
      </Fields>
      {problem && <div className="notice error">{problem}</div>}
      <div className="ef">
        <div>
          {removing ? (
            <span className="confirm">
              {removes.length > 1 ? `Remove it and ${removes.length - 1} branch${removes.length > 2 ? "es" : ""} under it?` : "Remove this item?"}
              <button className="mini" type="button" onClick={() => setRemoving(false)}>
                Keep
              </button>
              <button className="mini go" type="button" onClick={() => edit(() => client.deleteItem(view.plan.id, item.id)).then((ok) => ok && onClose())}>
                Remove
              </button>
            </span>
          ) : (
            <>
              <button className="quiet" type="button" onClick={() => setRemoving(true)}>
                Remove
              </button>
              <span className="sp" />
              <button className="btn ghost" type="button" onClick={onClose}>
                Cancel
              </button>
              <button className="btn" type="submit" disabled={busy}>
                Save
              </button>
            </>
          )}
        </div>
      </div>
    </form>
  );
}

/** Adds an item to a stage, in the editor's shape. */
export function AddItem({ level, onDone }: { level: number; onDone: (id?: string) => void }) {
  const { view, formats, edit, busy, sources, ticked } = usePlan();
  const client = useApi();
  const app = useContext(Ctx);
  // A new item reads what the chat has ticked, so it starts able to run.
  const known = new Set(sources.map((s) => s.id));
  const initialType = formats.find((f) => f.ready)?.id ?? formats[0]?.id ?? "";
  const [draft, setDraft] = useState<Draft>({
    ...EMPTY,
    type: initialType,
    settings: seedRememberedPicks(findFormat(formats, initialType), app?.providers?.picks),
    sources: (ticked ?? []).filter((id) => known.has(id)).map((sourceId) => ({ sourceId })),
  });
  const [problem, setProblem] = useState<string>();
  const ghost = { id: "", level, ord: 0, type: draft.type, title: "", settings: {}, enabled: true, status: "pending", sources: [], done: false } satisfies Item;

  async function add(e: FormEvent) {
    e.preventDefault();
    const input = toInput(draft, level);
    if ("error" in input) return setProblem(input.error);
    setProblem(undefined);
    const before = new Set(view.items.map((i) => i.id));
    let added: string | undefined;
    const ok = await edit(async () => {
      const next = await client.addItem(view.plan.id, input.value);
      added = next.items.find((i) => !before.has(i.id))?.id;
      return next;
    });
    if (ok) onDone(added);
  }

  return (
    <form className="ed" onSubmit={add} aria-label="Add an item">
      <Fields item={ghost} draft={draft} setDraft={setDraft} focusTitle>
        <RunsIn item={ghost} />
      </Fields>
      {problem && <div className="notice error">{problem}</div>}
      <div className="ef">
        <div>
          <span className="sp" />
          <button className="btn ghost" type="button" onClick={() => onDone()}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !draft.title.trim() || !draft.type}>
            Add item
          </button>
        </div>
      </div>
    </form>
  );
}

function RunsIn({ item }: { item: Item }) {
  const { view } = usePlan();
  const stage = buildStages(view.items, view.stages).find((s) => s.level === item.level);
  const name = stage ? (stage.label ?? `Stage ${stage.number}`) : "a new stage";
  return (
    <span>
      Runs in <b>{name}</b> · can assume <b>stages above</b>
    </span>
  );
}

function Fields({ item, draft, setDraft, children, focusTitle = false }: { item: Item; draft: Draft; setDraft: (d: Draft) => void; children?: ReactNode; /** A new item starts at its title. */ focusTitle?: boolean }) {
  const { view, formats, sources } = usePlan();
  const app = useContext(Ctx);
  const format = findFormat(formats, draft.type);
  const parents = parentOptions(view.items, item).sort(byRunOrder);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const chosen = new Set(draft.sources.map((s) => s.sourceId));
  const known = new Set(sources.map((s) => s.id));
  const parentTitle = view.items.find((i) => i.id === draft.parentId)?.title;
  const parsed = parseCondition(draft.conditionText);

  return (
    <>
      <label className="fld">
        <span>Title</span>
        <input required autoFocus={focusTitle} maxLength={200} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <div className="fl">Made as</div>
      <div className="types" role="group" aria-label="Format">
        {!format && draft.type && <FormatChoice f={undefined} id={draft.type} on onPick={() => undefined} />}
        {formats.map((f) => (
          <FormatChoice key={f.id} f={f} id={f.id} on={f.id === format?.id} onPick={() => set({ type: f.id, settings: seedRememberedPicks(f, app?.providers?.picks) })} />
        ))}
      </div>
      {format && !format.ready && <small className="d">{format.problem ? `${format.problem} An item in it blocks Start while it is included.` : `${format.label} is not made yet: an item in it blocks Start while it is included.`}</small>}
      <div className="fl">Reads</div>
      <div className="chips" role="group" aria-label="Sources">
        {sources.length === 0 && <small className="d">The project has no sources yet.</small>}
        {/* A source that could not be read is offered only if the item already reads it, so it can be taken off. */}
        {sources.filter((s) => s.status !== "failed" || chosen.has(s.id)).map((s) => (
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
        {draft.sources
          .filter((s) => !known.has(s.sourceId))
          .map((s) => (
            <span key={s.sourceId} className="chip">
              a source no longer in this project
            </span>
          ))}
      </div>
      <SettingsForm format={format} settings={draft.settings} onChange={(settings) => set({ settings })} />
      <details className="more">
        <summary>Brief, condition and place in the plan</summary>
        <label className="fld">
          <span>Brief</span>
          <textarea rows={5} maxLength={20000} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} />
        </label>
        <label className="fld">
          <span>Branch under</span>
          <select value={draft.parentId} onChange={(e) => set({ parentId: e.target.value })}>
            <option value="">Not a branch</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        {draft.parentId && (
          <label className="fld" style={{ marginTop: 10 }}>
            <span>Condition</span>
            <textarea className="mono" rows={2} placeholder='{"kind": "…"}' value={draft.conditionText} onChange={(e) => set({ conditionText: e.target.value })} />
            <small>
              {parsed.ok ? (parsed.condition ? conditionText(parsed.condition as Condition, parentTitle) : "No condition: it always runs after its parent.") : parsed.message} A tagged
              object the engine's condition registry reads.
            </small>
          </label>
        )}
        {children}
      </details>
    </>
  );
}

function FormatChoice({ f, id, on, onPick }: { f: FormatDescriptor | undefined; id: string; on: boolean; onPick: () => void }) {
  const { formats } = usePlan();
  const look = lookFor(formats, id);
  return (
    <button
      type="button"
      className={`b${f && !f.ready ? " notready" : ""}`}
      aria-pressed={on}
      title={f && !f.ready ? `${look.label}: not made yet` : look.label}
      style={{ "--fmt-bg": `var(--fmt-${look.colorSlot}-bg)`, "--fmt-fg": `var(--fmt-${look.colorSlot}-fg)` } as CSSProperties}
      onClick={onPick}
    >
      <Icon name={look.icon} />
      {look.label}
    </button>
  );
}

function ItemSummary({ item, onEdit, onClose }: { item: Item; onEdit?: () => void; onClose: () => void }) {
  const { view, formats, sources, edit, act, busy } = usePlan();
  const client = useApi();
  const [whole, setWhole] = useState(false);
  // Something made is mostly done by being gone through; marking it by hand is here, a step away from a stray click.
  const markable = view.plan.kickedOffAt !== undefined && Boolean(item.outputId);
  const format = findFormat(formats, item.type);
  // A source no longer in the project (removed, still read by a started plan) is read by id for its name.
  const missing = item.sources.map((s) => s.sourceId).filter((id) => !sources.some((s) => s.id === id));
  const gone = useLoad(() => Promise.all(missing.map((id) => client.getSource(id).then((d) => [id, `${d.source.title}${d.source.removedAt ? " (removed)" : ""}`] as const, () => [id, "A source"] as const))), [client, missing.join(",")]);
  const names = new Map([...sources.map((s) => [s.id, s.title] as const), ...(gone.data ?? [])]);
  const settings = settingsLines(format, item.settings);
  const result = resultText(item.result, format);
  const { into } = edgesOf(view.edges, item.id);
  const kinds = useEdgeKinds();
  const titleOf = (id: string) => view.items.find((i) => i.id === id)?.title ?? id;
  const why = briefLine(item.prompt);
  const more = (item.prompt ?? "").trim() !== why;
  return (
    <div
      className="px"
      role="region"
      aria-label="Item details"
      onKeyDown={(e) => {
        // Escape folds the details away and puts focus back on the item's row.
        if (e.key !== "Escape") return;
        onClose();
        requestAnimationFrame(() => document.getElementById(`item-${item.id}`)?.focus());
      }}
    >
      {whole ? <p className="brief">{item.prompt}</p> : <p className="why">{why || "No brief yet."}</p>}
      {item.sources.length > 0 && (
        <>
          <div className="fl">Reads</div>
          <div className="chips">
            {item.sources.map((s) => (
              <Link key={s.sourceId} className="chip" to={`/sources/${s.sourceId}`}>
                {names.get(s.sourceId) ?? "A source"}
              </Link>
            ))}
          </div>
        </>
      )}
      {into.length > 0 && (
        <>
          <div className="fl">Uses</div>
          <div className="chips">
            {into.map((e) => (
              <span key={`${e.from}-${e.kind}`} className="chip" title={kinds.find((k) => k.id === e.kind)?.about}>
                {edgeKindLabel(kinds, e.kind)} “{titleOf(e.from)}”
              </span>
            ))}
          </div>
        </>
      )}
      {settings.length > 0 && (
        <div className="set">
          {settings.map((l, k) => (
            <span key={l.label}>
              {k > 0 && " · "}
              {l.label}: <b>{l.text}</b>
            </span>
          ))}
        </div>
      )}
      {result && <div className="set">Result: {result}</div>}
      <div className="acts">
        {onEdit && (
          <button className="mini go" type="button" onClick={onEdit}>
            Edit
          </button>
        )}
        {onEdit && (
          <button className="mini" type="button" disabled={busy} title={item.enabled ? "Skip this one when the plan starts. You can put it back." : "Make this one again when the plan starts."} onClick={() => edit(() => client.updateItem(view.plan.id, item.id, { enabled: !item.enabled }))}>
            {item.enabled ? "Leave out of the plan" : "Put back in the plan"}
          </button>
        )}
        {markable && (
          <button className="mini" type="button" disabled={busy} onClick={() => act(() => client.markDone(view.plan.id, item.id, item.done ? { done: false } : { done: true, outputId: item.outputId! }))}>
            {item.done ? "Mark not done" : "Mark done"}
          </button>
        )}
        <span className="sp" />
        {more && (
          <button className="quiet" type="button" onClick={() => setWhole(!whole)}>
            {whole ? "Less" : "Full brief"}
          </button>
        )}
        <button className="x" type="button" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
    </div>
  );
}

function Edges({ item }: { item: Item }) {
  const { view, edit, busy } = usePlan();
  const client = useApi();
  const known = useEdgeKinds();
  const { into } = edgesOf(view.edges, item.id);
  const from = edgeSources(view.items, item);
  const [source, setSource] = useState("");
  const [kind, setKind] = useState("");
  // The engine's kinds, then any other kind this plan already uses (the planner may write one the engine reads as an input).
  const kinds = [...known, ...[...new Set(view.edges.map((e) => e.kind))].filter((k) => !known.some((x) => x.id === k)).map((id) => ({ id, label: edgeKindLabel(known, id), about: "" }))];
  const picked = kinds.find((k) => k.id === (kind || kinds[0]?.id));
  const titleOf = (id: string) => view.items.find((i) => i.id === id)?.title ?? id;
  if (from.length === 0 && into.length === 0) return null;
  return (
    <>
      <div className="fl">Uses earlier items</div>
      <div className="edges">
        {into.map((e) => (
          <div className="row" key={`${e.from}-${e.kind}`}>
            <span className="chip">{edgeKindLabel(known, e.kind)}</span> {titleOf(e.from)}
            <button className="x" type="button" aria-label={`Stop using ${titleOf(e.from)}`} disabled={busy} onClick={() => edit(() => client.deleteEdge(view.plan.id, e))}>
              <Icon name="x" />
            </button>
          </div>
        ))}
        {from.length > 0 && picked && (
          <div className="edgeadd">
            <label className="fld">
              <span>Earlier item</span>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Choose…</option>
                {from.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>How it uses it</span>
              <select value={picked.id} onChange={(e) => setKind(e.target.value)}>
                {kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="mini"
              type="button"
              disabled={!source || busy}
              onClick={async () => {
                if (await edit(() => client.addEdge(view.plan.id, { from: source, to: item.id, kind: picked.id }))) {
                  setSource("");
                  setKind("");
                }
              }}
            >
              Use it
            </button>
            <small className="d">Pick an earlier item and how this one uses it, then press Use it.</small>
            {picked.about && <small className="d">{picked.about}</small>}
          </div>
        )}
      </div>
    </>
  );
}
