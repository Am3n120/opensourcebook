import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Ctx } from "../app/context";
import { OutlineButton, PrimaryButton } from "../design/Buttons";
import { Icon } from "../design/Icon";
import { numberCites, type Cite } from "./blockData";
import { ChromeTools } from "./chrome";
import { CiteMarks } from "./CiteMarks";
import { asGuide, draftOf, editBody, newKey, type Draft, type DraftPoint, type DraftSection, type Guide, type GuidePoint } from "./guideData";
import { Inline } from "./inline";
import { useStageTint } from "./look";
import type { PlayerProps } from "./players";
import { useChrome } from "./useChrome";
import "./stage.css";
import "./guide.css";

/**
 * A guide (engine/docs/guide.md, "Players"): a page or a few of notes to
 * keep, filling the player's screen. Sections under headings, each a run of
 * points with a strong term when it has one and its cites at the claim,
 * numbered across the page so a printed copy lists them at the end. What the
 * maker added beyond the sources says so; what the person wrote is marked
 * theirs. Print prints only the page. Change it opens the same page to
 * change: the title, headings and sections (added, removed, moved), and any
 * point opened in place to change its term and words, or to have the
 * maker's words put back. Every change is kept together, by Save or by Done
 * changing; the engine lays it over what it keeps. Reaching the end of the
 * page ticks it done. Change it, Print and Done changing sit in the player's
 * bar (above the page, outside one); the bar moves to the thing before and
 * after.
 */
export function GuidePlayer({ output: given, sources, complete, onOpenCite, here }: PlayerProps) {
  const app = useContext(Ctx);
  // What was saved here shows until the output given is a new one (the plan reloaded it).
  const [saved, setSaved] = useState<{ from: PlayerProps["output"]; kept: PlayerProps["output"] }>();
  const output = saved?.from === given ? saved.kept : given;
  const guide = useMemo(() => asGuide(output.payload), [output.payload]);
  const title = guide.title || output.title;
  const names = useMemo(() => new Map(sources.map((s) => [s.id, s.name])), [sources]);
  const tint = useStageTint(output.type);
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const editing = draft !== undefined;
  const root = useRef<HTMLElement>(null);
  const inChrome = useChrome({});

  // Every cite on the page numbered once, in reading order, so a mark and the printed list agree.
  const marks = useMemo(() => numberCites(guide.sections.flatMap((s) => s.points.flatMap((p) => p.cites))), [guide]);
  const numberOf = useMemo(() => {
    const byKey = new Map(marks.map((m) => [citeKey(m.cite), m.n]));
    return (cite: Cite) => byKey.get(citeKey(cite)) ?? 0;
  }, [marks]);

  // Reaching the end of the page ticks it done, once.
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el || !complete || editing || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        complete();
        seen.disconnect();
      }
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [complete, editing]);

  const print = () => {
    const page = root.current;
    if (!page) return;
    document.documentElement.classList.add("gprint");
    page.setAttribute("data-printing", "");
    const done = () => {
      document.documentElement.classList.remove("gprint");
      page.removeAttribute("data-printing");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    try {
      window.print();
    } finally {
      // A browser that prints at once (or not at all) never fires afterprint.
      setTimeout(done, 1000);
    }
  };

  /** Keeps the whole page as the draft has it; `leave` closes the changing when it is kept. Nothing changed is nothing sent. */
  const keepDraft = async (d: Draft, leave: boolean) => {
    if (!app?.client) return;
    const body = editBody(d);
    if (JSON.stringify(body) === JSON.stringify(editBody(draftOf(guide, title)))) {
      if (leave) setDraft(undefined);
      return;
    }
    setSaving(true);
    setProblem(undefined);
    try {
      const kept = await app.client.editOutput(output.id, body);
      setSaved({ from: given, kept });
      setDraft(leave ? undefined : draftOf(asGuide(kept.payload), asGuide(kept.payload).title || kept.title));
    } catch (error) {
      setDraft(d);
      setProblem(error instanceof Error ? error.message : "It could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const tools = editing ? (
    <button type="button" className="gdone" disabled={saving} onClick={() => void keepDraft(draft, true)}>
      {saving ? "Saving…" : "Done changing"}
    </button>
  ) : (
    <>
      {app?.client && <OutlineButton onClick={() => setDraft(draftOf(guide, title))}>Change it</OutlineButton>}
      <OutlineButton onClick={print}>Print</OutlineButton>
    </>
  );

  return (
    <div className="pstage gstage" style={tint}>
      <div className="pstage-in">
        {inChrome ? (
          <ChromeTools>{tools}</ChromeTools>
        ) : (
          <div className="gtools" data-copy="skip">
            {tools}
          </div>
        )}
        <article className="gpage" ref={root} aria-label={title}>
          {editing && app?.client ? (
            <GuideEditor draft={draft} setDraft={setDraft} saving={saving} problem={problem} save={(d) => void keepDraft(d, false)} />
          ) : (
            <>
              <header className="ghead">
                <h2>{title}</h2>
                {guide.about && <p className="gabout">{guide.about}</p>}
                {guide.lengthNote && <p className="gnote">{guide.lengthNote}</p>}
                {guide.editedAt && differsFromMaker(guide) && <p className="gnote">Changed by you {when(guide.editedAt)}.</p>}
              </header>
              {guide.sections.length === 0 && <p className="gnote">This guide has nothing in it yet.</p>}
              {guide.sections.map((s) => (
                <section key={s.id} className="gsec" aria-label={s.title || "Section"}>
                  {s.title && <h3>{s.title}</h3>}
                  <ul>
                    {s.points.map((p) => (
                      <Point key={p.id} point={p} names={names} numberOf={numberOf} onOpenCite={onOpenCite} onHere={here ? () => here({ section: s.id, point: p.id }) : undefined} />
                    ))}
                  </ul>
                </section>
              ))}
              {marks.length > 0 && (
                <ol className="gsources" aria-label="Sources">
                  {marks.map(({ cite, n }) => (
                    <li key={n} value={n}>
                      <b>{names.get(cite.sourceId) ?? "A source"}</b>
                      {cite.locator?.page !== undefined && <span> · p. {cite.locator.page}</span>}
                      {cite.quote && <q>{cite.quote}</q>}
                    </li>
                  ))}
                </ol>
              )}
              <div ref={end} className="gend" />
            </>
          )}
        </article>
      </div>
    </div>
  );
}

function Point({ point, names, numberOf, onOpenCite, onHere }: { point: GuidePoint; names: Map<string, string>; numberOf: (c: Cite) => number; onOpenCite: PlayerProps["onOpenCite"]; onHere?: (() => void) | undefined }) {
  const marks = point.cites.map((cite) => ({ cite, n: numberOf(cite) })).filter((m, i, all) => m.n > 0 && all.findIndex((o) => o.n === m.n) === i);
  return (
    <li className={`gpt${point.background && !point.yours ? " bg" : ""}${point.yours ? " yours" : ""}`} onPointerDown={onHere} onFocus={onHere}>
      {point.term && (
        <>
          <strong className="gterm">
            <Inline text={point.term} />
          </strong>{" "}
        </>
      )}
      <Inline text={point.text} />
      <CiteMarks marks={marks} names={names} onOpen={onOpenCite} />
      {point.yours ? (
        <span className="gwhose" title={point.made ? "Changed by you" : "Written by you"}>
          yours
        </span>
      ) : (
        point.background && <span className="gwhose">Not from your sources</span>
      )}
    </li>
  );
}

/**
 * The page while it is changed: the title and every heading as fields,
 * sections moved, removed and added, and the points as they read, one opened
 * at a time to change. Nothing is kept until Save or Done changing; the
 * engine answers what is wrong when it cannot keep it.
 */
function GuideEditor({ draft, setDraft, saving, problem, save }: { draft: Draft; setDraft: (d: Draft) => void; saving: boolean; problem: string | undefined; save: (d: Draft) => void }) {
  const [open, setOpen] = useState<string>();
  const setSection = (i: number, change: (s: DraftSection) => DraftSection) => setDraft({ ...draft, sections: draft.sections.map((s, j) => (j === i ? change(s) : s)) });
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= draft.sections.length) return;
    const sections = [...draft.sections];
    [sections[i], sections[j]] = [sections[j]!, sections[i]!];
    setDraft({ ...draft, sections });
  };
  const addPoint = (i: number) => {
    const key = newKey();
    setSection(i, (x) => ({ ...x, points: [...x.points, { key, term: "", text: "", cited: false }] }));
    setOpen(key);
  };
  return (
    <div className="gedit">
      <label className="gfield">
        <span>Title</span>
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </label>
      {draft.sections.map((s, i) => (
        <fieldset key={s.key} className="gsec gsecedit" aria-label={`Section ${i + 1}`}>
          <div className="grow">
            <input className="gheading" aria-label={`Heading of section ${i + 1}`} value={s.title} placeholder="Heading" onChange={(e) => setSection(i, (x) => ({ ...x, title: e.target.value }))} />
            <button type="button" className="gmini" aria-label={`Move section ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <Icon name="up" />
            </button>
            <button type="button" className="gmini" aria-label={`Move section ${i + 1} down`} disabled={i === draft.sections.length - 1} onClick={() => move(i, 1)}>
              <Icon name="down" />
            </button>
            <button type="button" className="gmini" aria-label={`Remove section ${i + 1}`} onClick={() => setDraft({ ...draft, sections: draft.sections.filter((_, j) => j !== i) })}>
              <Icon name="x" />
            </button>
          </div>
          {s.points.map((p, k) => {
            const label = `point ${k + 1} of section ${i + 1}`;
            const setPoint = (change: Partial<DraftPoint>) => setSection(i, (x) => ({ ...x, points: x.points.map((q, m) => (m === k ? { ...q, ...change } : q)) }));
            const remove = () => {
              setSection(i, (x) => ({ ...x, points: x.points.filter((_, m) => m !== k) }));
              setOpen(undefined);
            };
            if (open === p.key)
              return (
                <PointEditor
                  key={p.key}
                  point={p}
                  label={label}
                  saving={saving}
                  onSave={(term, text) => {
                    const sections = draft.sections.map((x, j) => (j === i ? { ...x, points: x.points.map((q, m) => (m === k ? { ...q, term, text } : q)) } : x));
                    setPoint({ term, text });
                    setOpen(undefined);
                    save({ ...draft, sections });
                  }}
                  onRemove={remove}
                  onClose={() => setOpen(undefined)}
                />
              );
            return (
              <button key={p.key} type="button" className="gptbtn" aria-label={`Change ${label}`} onClick={() => setOpen(p.key)}>
                {p.term.trim() && <strong className="gterm">{p.term}</strong>} {p.text || <span className="gempty">A point with no words yet</span>}
              </button>
            );
          })}
          <button type="button" className="glink" onClick={() => addPoint(i)}>
            Add a point
          </button>
        </fieldset>
      ))}
      <button type="button" className="glink" onClick={() => setDraft({ ...draft, sections: [...draft.sections, { key: newKey(), title: "", points: [] }] })}>
        Add a section
      </button>
      {problem && (
        <p className="gproblem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** One point opened to change: its term and words, kept on Save; the maker's own words can be put back. */
function PointEditor({ point, label, saving, onSave, onRemove, onClose }: { point: DraftPoint; label: string; saving: boolean; onSave: (term: string, text: string) => void; onRemove: () => void; onClose: () => void }) {
  const [term, setTerm] = useState(point.term);
  const [text, setText] = useState(point.text);
  const made = point.made;
  const changedFromMaker = made && (made.term !== term || made.text !== text);
  const fromMaker = point.id !== undefined && (point.cited || made !== undefined);
  return (
    <div
      className="gptedit"
      role="group"
      aria-label={`Changing ${label}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <label className="gfield">
        <span>Term</span>
        <input className="gtermin" value={term} onChange={(e) => setTerm(e.target.value)} />
      </label>
      <label className="gfield">
        <span>Point</span>
        <textarea rows={3} value={text} autoFocus onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="gptnote">{fromMaker ? "What you type here has no cite; the maker's words are kept so you can put them back." : "What you type here has no cite."}</p>
      <div className="grow">
        <PrimaryButton disabled={saving} onClick={() => onSave(term, text)}>
          Save
        </PrimaryButton>
        {changedFromMaker && (
          <OutlineButton
            onClick={() => {
              setTerm(made.term);
              setText(made.text);
            }}
          >
            Put the maker's words back
          </OutlineButton>
        )}
        <span className="grow-gap" />
        <button type="button" className="glink" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="glink" onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

const citeKey = (cite: Cite) => `${cite.sourceId}|${cite.locator?.charStart ?? ""}|${cite.quote ?? ""}`;

/** "on 20 Nov 2026". */
function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `on ${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

/** Whether any point still differs from the maker's words, so a point put back no longer counts as changed. */
function differsFromMaker(guide: Guide): boolean {
  return guide.sections.some((s) => s.points.some((p) => p.yours && (!p.made || p.made.text !== p.text || p.made.term !== (p.term ?? ""))));
}
