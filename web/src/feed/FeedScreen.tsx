import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router";
import { useApi, useAppData, useFormats } from "../app/context";
import { ErrorNotice, LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { useTitle } from "../app/useTitle";
import { FormatBadge } from "../design/FormatBadge";
import { FormatTile } from "../design/FormatTile";
import { Icon } from "../design/Icon";
import { Logo } from "../design/ui";
import { lookFor } from "../design/formatLook";
import { ChromeLine, ChromeSlot, ChromeToolsHere, type ChromeReport } from "../player/chrome";
import { EndCard } from "../player/EndCard";
import { Finish } from "../player/PlayerScreen";
import { placeProps, usePlace, useSources } from "../player/place";
import { citeLink } from "../player/progress";
import { renderPlayer } from "../player/registry";
import { loadFeed, reachOf, type Reach } from "./load";
import type { Json } from "../api/types";
import { AskHere, Thread } from "../thread/Thread";
import { useThreadCounts } from "../thread/useThread";
import { orderFeed, type FeedEntry } from "./order";
import { dueCount, feedProjects, inScope, type FeedProject } from "./scope";
import { TopBar } from "../app/TopBar";
import "../player/player.css";
import "./feed.css";

/** How often a feed that lost the computer asks again. */
const RETRY_MS = 3000;

/**
 * The feed (docs/VISION.md, "The phone"): everything made, one thing per screen,
 * scrolled down to the next. Sideways moves inside a thing, through a set's
 * cards or a quiz's questions. The thing in view and its neighbours are drawn
 * by their format's player; a video in view plays muted until a tap. Scrolling
 * past a thing ticks it done on its plan, as finishing it does. The order is
 * one function from `FEED_ORDERS` (order.ts). It holds every project at once,
 * and can be narrowed to one project, or to what has cards due, by the chips
 * under the bar; the bar's search finds a thing by its words. It is the
 * Library tab on a phone (`/library`; `/feed` still opens it). Each player
 * sits in the player chrome's slot: its line along the foot of the thing and
 * its own tools in the line under it are the chrome's, as in the player, and
 * the feed ends on the end card.
 */
export function FeedScreen() {
  useTitle("Library");
  const client = useApi();
  const { formats } = useAppData();
  const loaded = useLoad(async () => orderFeed(await loadFeed(client)), [client]);
  const [params, setParams] = useSearchParams();
  const scope = params.get("project");
  const due = params.get("due") === "1";
  const search = params.get("q") ?? "";
  const all = loaded.data;
  const projects = useMemo(() => (all ? feedProjects(all) : []), [all]);
  const dueNow = useMemo(() => (all ? dueCount(all) : 0), [all]);
  const entries = useMemo(() => (all ? inScope(all, scope, { due, search }) : undefined), [all, scope, due, search]);
  const reach: Reach = loaded.error ? reachOf(loaded.error) : "ok";
  const error = reach === "ok" ? loaded.error : undefined;
  const load = loaded.reload;
  const [at, setAt] = useState(0);
  const feed = useRef<HTMLElement>(null);
  // How many messages each thing's thread holds, for its button.
  const threads = useThreadCounts();
  // Where the person is in each thing, as its player reports it: what a thread message is written about.
  const spots = useRef(new Map<string, Json>());

  // Another project picked: start again at its first thing.
  const pick = useCallback(
    (projectId: string | null, onlyDue = false) => {
      const next = new URLSearchParams(params);
      if (projectId) next.set("project", projectId);
      else next.delete("project");
      if (onlyDue) next.set("due", "1");
      else next.delete("due");
      setAt(0);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  const showAll = useCallback(() => {
    const next = new URLSearchParams(params);
    for (const name of ["project", "due", "q"]) next.delete(name);
    setAt(0);
    setParams(next, { replace: true });
  }, [params, setParams]);
  const find = useCallback(
    (value: string) => {
      const next = new URLSearchParams(params);
      if (value) next.set("q", value);
      else next.delete("q");
      setAt(0);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  // Away: ask again every few seconds, and carry on by itself once the computer answers.
  useEffect(() => {
    if (reach !== "away") return;
    const timer = window.setInterval(() => {
      client.formats().then(
        () => {
          // The formats the whole app reads were missed while it was away: start the page again.
          if (formats.length === 0) window.location.reload();
          else void load();
        },
        () => undefined,
      );
    }, RETRY_MS);
    return () => window.clearInterval(timer);
  }, [reach, client, formats.length, load]);

  // Scrolling past a thing ticks it done, the same as finishing it.
  const passed = useCallback(
    (entry: FeedEntry | undefined) => {
      const o = entry?.output;
      if (!entry || entry.done || !o?.planId || !o.itemId) return;
      entry.done = true;
      void client.markDone(o.planId, o.itemId, { done: true, outputId: o.id }).catch(() => (entry.done = false));
    },
    [client],
  );

  const settle = useRef<number | undefined>(undefined);
  function onScroll() {
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const box = feed.current;
      if (!box || !box.clientHeight) return;
      const i = Math.max(0, Math.min(entries?.length ?? 0, Math.round(box.scrollTop / box.clientHeight)));
      if (i === at) return;
      if (i > at) for (let k = at; k < i; k++) passed(entries?.[k]);
      setAt(i);
    }, 100);
  }
  const goTo = useCallback(
    (i: number) => {
      const box = feed.current;
      // The end card is one past the last thing.
      if (!entries || i < 0 || i > entries.length) return;
      if (i > at) for (let k = at; k < i; k++) passed(entries[k]);
      setAt(i);
      box?.scrollTo?.({ top: i * box.clientHeight, behavior: "smooth" });
    },
    [entries, at, passed],
  );

  // A keyboard (a tablet's, or the computer opening the feed) moves the same way: ↓ the next thing, ↑ the one before.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      if (e.key === "ArrowDown") goTo(at + 1);
      else if (e.key === "ArrowUp") goTo(at - 1);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, goTo]);

  if (reach === "away") return <Away />;
  if (reach === "unpaired") return <Unpaired />;
  return (
    <div className="pfeed-wrap">
      <div className="pfeed-top">
        <TopBar search={{ value: search, onChange: find, placeholder: "Search what you made", label: "Search the Library" }} />
        {all && all.length > 0 && <Chips projects={projects} due={dueNow} scope={scope} onlyDue={due} onPick={pick} />}
      </div>
      {!entries ? (
        <main className="pfeed-note">
          <LoadState loading={!error} error={error} what="the feed" onRetry={() => void load()} />
        </main>
      ) : entries.length === 0 && (scope || due || search) && all && all.length > 0 ? (
        <main className="pfeed-note">
          <h1>{search ? `Nothing matches “${search}”` : due ? "Nothing is due" : "Nothing here from this project"}</h1>
          <p>{search ? "Try fewer words." : due ? "No flashcards are waiting to be gone over." : "It has nothing made yet, or it is gone. Everything else you made is in the whole feed."}</p>
          <button className="btn" type="button" onClick={showAll}>
            Show all projects
          </button>
        </main>
      ) : entries.length === 0 ? (
        <main className="pfeed-note">
          <h1>Nothing made yet</h1>
          <p>Videos, flashcards and quizzes you make on your computer show up here, one per screen. Add a source there and start a plan.</p>
        </main>
      ) : (
        <main className="pfeed" ref={feed} onScroll={onScroll} aria-label="Feed" key={`${scope ?? "all"}|${due}|${search}`}>
          <h1 className="sr-only">Feed</h1>
          {entries.map((entry, i) =>
            Math.abs(i - at) <= 1 ? (
              <section key={entry.output.id} className="pslide" aria-label={entry.output.title} aria-current={i === at}>
                <Slide entry={entry} active={i === at} onNext={() => goTo(i + 1)} talks={entry.output.itemId ? (threads.counts.get(entry.output.itemId) ?? 0) : 0}
                  onTalked={threads.bump}
                  onHere={(spot) => spots.current.set(entry.output.id, spot)}
                  spotOf={() => spots.current.get(entry.output.id)}
                />
              </section>
            ) : (
              <section key={entry.output.id} className="pslide cover" aria-label={entry.output.title}>
                <FormatTile id={entry.output.type} formats={formats} size="lg" solid done={entry.done} />
                <b>{entry.output.title}</b>
              </section>
            ),
          )}
          <div className="pslide" aria-current={at === entries.length}>
            <EndCard
              whole="feed"
              total={entries.length}
              done={entries.filter((e) => e.done).length}
              back={{ label: "Back to the first", onClick: () => goTo(0) }}
              left={entries.some((e) => !e.done) ? { onClick: () => goTo(entries.findIndex((e) => !e.done)) } : undefined}
            />
          </div>
        </main>
      )}
    </div>
  );
}

/** One thing, filling the screen: its player, then a line with its title, its project, its sources and the chat. */
function Slide({
  entry,
  active,
  onNext,
  talks,
  onTalked,
  onHere,
  spotOf,
}: {
  entry: FeedEntry;
  active: boolean;
  onNext: () => void;
  /** Messages in its thread. */
  talks: number;
  onTalked: () => void;
  /** Hears where the person is in it, as its player reports it. */
  onHere: (at: Json) => void;
  /** Where the person is in it now, as last heard. */
  spotOf: () => Json | undefined;
}) {
  const client = useApi();
  const formats = useFormats();
  const output = useLoad(() => client.getOutput(entry.output.id), [client, entry.output.id]);
  const place = usePlace(output.data);
  const sources = useSources(output.data);
  const [sheet, setSheet] = useState(false);
  // The thread: a sheet over the lower part, the thing still in view above it.
  const [talk, setTalk] = useState(false);
  const [ask, setAsk] = useState<{ n: number; at: Json }>();
  const [jump, setJump] = useState<{ at: Json; n: number }>();
  // What the player in view tells the chrome: its line, and where its own tools go.
  const [report, setReport] = useState<ChromeReport>();
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const note = onHere;
  const o = output.data;
  const s = entry.output;
  const go = useCallback(() => onNext(), [onNext]);
  // In the feed, up and down are the feed's own (the next thing in it), not the plan's neighbours.
  const here = placeProps(place);
  delete here.prev;
  delete here.next;
  delete here.prevWaiting;
  delete here.nextWaiting;
  if (jump) here.progress = jump.at;
  const kept = here.keep;
  if (kept) here.keep = (p: Json) => (note(p), kept(p));
  const planId = s.planId;
  const itemId = s.itemId;
  return (
    <>
      <div
        className={`pplay fmt-${s.type}${report?.behind === "dark" ? " dark" : ""}`}
        style={{ "--pc-tone": `var(--fmt-${lookFor(formats, s.type).colorSlot}-fg)` } as CSSProperties}
        key={jump ? `at-${jump.n}` : "play"}
      >
        {!o || !place.ready ? (
          <LoadState loading={output.loading || !place.ready} error={output.error} what="this item" onRetry={() => void output.reload()} />
        ) : (
          <ChromeToolsHere target={tools}>
            <ChromeSlot active={active} onReport={setReport}>
              {renderPlayer(formats, o.type, {
                output: o,
                sources,
                go,
                active,
                autoplay: true,
                ...here,
                here: note,
                ...(planId && itemId ? { aboutHere: (at: Json) => <AskHere onAsk={() => (note(at), setAsk({ n: Date.now(), at }), setTalk(true))} /> } : {}),
                finish: place.known ? <Finish done={place.done} error={place.error} onDone={(result) => place.set(true, result)} /> : null,
              }) ?? <p className="pnone">This format has no player here yet.</p>}
            </ChromeSlot>
          </ChromeToolsHere>
        )}
        <ChromeLine report={report} />
      </div>
      <footer className="pmeta">
        <div className="pwho">
          <div className="pt">
            <FormatBadge id={s.type} formats={formats} />
            <b>{s.title}</b>
          </div>
          {s.projectId ? (
            <Link className="pproj" to={`/projects/${s.projectId}`}>
              {entry.projectTitle ?? "Project"}
              {entry.planTitle && ` · ${entry.planTitle}`}
            </Link>
          ) : (
            <span className="pproj">No project</span>
          )}
        </div>
        <div className="pc-tools ptools" ref={setTools} />
        <button className="fbtn" type="button" aria-expanded={sheet} onClick={() => setSheet(true)}>
          <Icon name="doc" />
          <span>Sources</span>
        </button>
        {s.projectId && planId && itemId && (
          <button className="fbtn ptalk" type="button" aria-expanded={talk} aria-label={talks ? `Talk about ${s.title}: ${talks} message${talks === 1 ? "" : "s"}` : `Talk about ${s.title}`} onClick={() => setTalk(true)}>
            <span className="picon">
              <Icon name="chat" />
              {talks > 0 && <span className="tcount">{talks}</span>}
            </span>
            <span>Talk</span>
          </button>
        )}
      </footer>
      {talk && s.projectId && planId && itemId && (
        <Thread
          planId={planId}
          itemId={itemId}
          projectId={s.projectId}
          title={s.title}
          kind={formats.find((f) => f.id === s.type)?.label ?? s.type}
          where={() => spotOf() ?? place.progress}
          variant="sheet"
          onClose={() => setTalk(false)}
          onJump={(at) => setJump({ at, n: Date.now() })}
          {...(ask ? { ask } : {})}
          onSent={onTalked}
        />
      )}
      {sheet && (
        <div className="psheet-back" onClick={() => setSheet(false)}>
          <div className="psheet" role="dialog" aria-label="Sources" onClick={(e) => e.stopPropagation()}>
            <div className="psheet-h">
              <b>Made from</b>
              <button className="fbtn" type="button" aria-label="Close" onClick={() => setSheet(false)}>
                <Icon name="x" />
              </button>
            </div>
            {sources.length === 0 && <p className="d">No sources recorded.</p>}
            {sources.map((src) => (
              <Link key={src.id} className="psrc" to={citeLink(src.id)}>
                <Icon name="doc" />
                {src.name}
              </Link>
            ))}
            <ErrorNotice error={place.error} />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * What the feed holds, as chips under the bar: every project, one project, or
 * what has flashcards due. The Due chip shows only while something is due.
 */
function Chips({
  projects,
  due,
  scope,
  onlyDue,
  onPick,
}: {
  projects: FeedProject[];
  due: number;
  scope: string | null;
  onlyDue: boolean;
  onPick: (projectId: string | null, onlyDue?: boolean) => void;
}) {
  return (
    <div className="pchips" role="group" aria-label="Show">
      <button type="button" className="pchip" aria-pressed={!scope && !onlyDue} onClick={() => onPick(null)}>
        All projects
      </button>
      {projects.map((p) => (
        <button key={p.id} type="button" className="pchip" aria-pressed={scope === p.id && !onlyDue} onClick={() => onPick(p.id)}>
          {p.title}
        </button>
      ))}
      {due > 0 && (
        <button type="button" className="pchip" aria-pressed={onlyDue} onClick={() => onPick(null, true)}>
          Due · {due}
        </button>
      )}
    </div>
  );
}

function Away() {
  return (
    <div className="pfeed-note pfeed-away" role="status">
      <Logo />
      <h1>Open Sourcebook runs on your computer. It isn't reachable right now.</h1>
      <p>Check that the computer is on, Open Sourcebook is running there, and this phone is on the same Wi-Fi. This page tries again by itself.</p>
    </div>
  );
}

function Unpaired() {
  return (
    <div className="pfeed-note" role="status">
      <Logo />
      <h1>Scan the code on your computer</h1>
      <p>This device is not paired with Open Sourcebook any more. On your computer, choose Open on your phone in Settings and scan the code it shows.</p>
    </div>
  );
}
