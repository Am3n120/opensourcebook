import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Cite, Json, PlanView } from "../api/types";
import { useApi, useFormats } from "../app/context";
import { LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { FormatTile } from "../design/FormatTile";
import { lookFor } from "../design/formatLook";
import { ChromeSlot, PlayerChrome, type ChromeReport } from "../player/chrome";
import { EndCard } from "../player/EndCard";
import { placeProps, usePlace, useSources } from "../player/place";
import type { OpenCite } from "../player/CiteMarks";
import { Finish } from "../player/PlayerScreen";
import { renderPlayer } from "../player/registry";
import "../player/player.css";
import "./made.css";
import { playOrder } from "./studio";
import { AskHere, Thread } from "../thread/Thread";
import { rememberOpen, rememberedOpen, useThreadCounts } from "../thread/useThread";
import { useNarrow } from "../thread/useNarrow";
import { useRemakeWatch } from "../thread/remake";
import { RemakeReady } from "../thread/RemakeReady";

/**
 * What was made, playing in the Studio panel (docs/DECISIONS.md #47): every
 * made thing of the project in the Studio's order (the feed's), plans and
 * things made at once alike, one full-height 9:16 screen each, in a feed that
 * scrolls and snaps like the phone's, inside the chrome every player wears
 * (player/chrome.tsx). Down is the next thing, up the one before, and after
 * the last comes the end card; sideways moves inside a thing. The screen in
 * view and its neighbours are drawn by their format's player (from the
 * registry), so the next one is really there as you scroll into it; only the
 * one in view takes keys and speaks to the chrome. Screens further away wait
 * as covers.
 */
export function StudioPlayer({
  outputId,
  projectId,
  views,
  onGo,
  onClose,
  onPlanChange,
  onOpenCite,
  startAt,
  onOpenChat,
  onThreadSent,
  onMoment,
}: {
  outputId: string;
  projectId: string;
  views: PlanView[];
  onGo: (outputId: string) => void;
  onClose: () => void;
  /** A done tick changed the plan. */
  onPlanChange?: (view: PlanView) => void;
  /** Opens a cited spot in the Sources panel, the Studio kept playing behind it. */
  onOpenCite?: OpenCite;
  /** Opens a thing at a spot (a thread message's link back in the chat), once per `n`. */
  startAt?: { outputId: string; at: Json; n: number };
  /** Opens the chat a thread lives in. */
  onOpenChat?: (chatId: string) => void;
  /** A thread wrote into that chat. */
  onThreadSent?: (chatId: string) => void;
  /** Where the person is in a thing playing, each time its player says (a video's time, a quiz's question). */
  onMoment?: (outputId: string, at: Json) => void;
}) {
  const formats = useFormats();
  const feed = useRef<HTMLDivElement>(null);
  // Everything made in the project, in the Studio's (and the feed's) order: down is the next thing, whichever plan it is in.
  const entries = playOrder(views);
  const made = entries.map((entry) => entry.item);
  // Which item each made thing belongs to, kept as items move on: a thing playing stays put when a scene of it is
  // made again and its item's newest becomes the new one, and the new one plays in that item's place.
  const [owners, setOwners] = useState<Record<string, string>>({});
  const unknown = made.filter((i) => i.outputId && owners[i.outputId] !== i.id);
  if (unknown.length > 0) setOwners({ ...owners, ...Object.fromEntries(unknown.map((i) => [i.outputId!, i.id])) });
  const found = made.findIndex((i) => i.outputId === outputId || owners[outputId] === i.id);
  // The thing in view is held by its item's id, not its place in the list: things added or moved around it
  // keep it in view (and its open thread on it), even while what is playing is not in the list for a moment.
  const [shown, setShown] = useState<string>();
  const kept = found < 0 && shown ? made.findIndex((i) => i.id === shown) : -1;
  const at = found >= 0 ? found : Math.max(0, kept);
  const prev = at > 0 ? made[at - 1] : undefined;
  const next = at < made.length - 1 ? made[at + 1] : undefined;
  const current = entries[at];
  if (current && current.item.id !== shown) setShown(current.item.id);

  // The thread on the thing in view: beside it, or a sheet over its lower part on a narrow window; left open per thing.
  const narrow = useNarrow();
  const itemId = current?.item.id;
  const [talk, setTalk] = useState(() => (itemId ? rememberedOpen(itemId) : false));
  const [talkFor, setTalkFor] = useState(itemId);
  if (itemId !== talkFor) {
    setTalkFor(itemId);
    setTalk(itemId ? rememberedOpen(itemId) : false);
  }
  const [ask, setAsk] = useState<{ n: number; at: Json }>();
  const threads = useThreadCounts(projectId);
  // A scene being made again is followed here too, so the item's new thing comes in when it is made.
  useRemakeWatch(views, (v) => onPlanChange?.(v));
  // Where the person is in each screen, as its player reports it: what a thread message is written about.
  const spots = useRef(new Map<string, Json>());
  // A spot to open a screen at: a thread's link back, or a message's spot tapped in the thread.
  const [jump, setJump] = useState<{ outputId: string; at: Json; n: number } | undefined>(startAt);
  const [started, setStarted] = useState(startAt?.n);
  if (startAt && startAt.n !== started) {
    setStarted(startAt.n);
    setJump(startAt);
  }
  function openTalk(open: boolean) {
    setTalk(open);
    if (itemId) rememberOpen(itemId, open);
  }
  // What the player in view tells the chrome, and how each screen ticks its plan item done.
  const [report, setReport] = useState<ChromeReport>();
  const ticks = useRef(new Map<string, (done: boolean, result?: Json) => void>());
  // Scrolled past the last thing, onto the end card.
  const [atEnd, setAtEnd] = useState(false);
  const askHere = (forOutput: string) => (spot: Json) => <AskHere onAsk={() => (spots.current.set(forOutput, spot), setAsk({ n: Date.now(), at: spot }), openTalk(true))} />;

  // Keep the screen in view in step with what is playing (a key, a link, a reload).
  useEffect(() => {
    const box = feed.current;
    if (!box || !box.clientHeight) return;
    const want = at * box.clientHeight;
    if (Math.abs(box.scrollTop - want) > 4) box.scrollTo?.({ top: want, behavior: box.scrollTop === 0 && at > 0 ? "auto" : "smooth" });
  }, [at]);
  const toSlide = (i: number) => {
    const box = feed.current;
    if (box?.clientHeight) box.scrollTo?.({ top: i * box.clientHeight, behavior: "smooth" });
    setAtEnd(i >= made.length);
  };

  // When the panel changes height (a window resize, a narrow window's tab
  // shown again) the screens change height too: stay on the same screen,
  // and do not take the jump for a scroll to another one.
  const atRef = useRef(at);
  useEffect(() => {
    atRef.current = at;
  }, [at]);
  const resizing = useRef(false);
  // The list changed under the thing in view (something made or added before it): move with it at once, before
  // it is painted, so the screen never shows another thing and the move is not taken for a scroll to it.
  const placed = useRef({ id: itemId, at });
  const moving = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const was = placed.current;
    placed.current = { id: itemId, at };
    const box = feed.current;
    if (!box || !box.clientHeight || was.id !== itemId || was.at === at) return;
    resizing.current = true;
    window.clearTimeout(moving.current);
    moving.current = window.setTimeout(() => (resizing.current = false), 300);
    box.scrollTop = at * box.clientHeight;
  }, [at, itemId]);
  useEffect(() => () => window.clearTimeout(moving.current), []);
  useEffect(() => {
    const box = feed.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    let height = box.clientHeight;
    let calm: number | undefined;
    const watch = new ResizeObserver(() => {
      if (!box.clientHeight || box.clientHeight === height) return;
      height = box.clientHeight;
      resizing.current = true;
      window.clearTimeout(calm);
      calm = window.setTimeout(() => (resizing.current = false), 300);
      box.scrollTop = atRef.current * box.clientHeight;
    });
    watch.observe(box);
    return () => {
      watch.disconnect();
      window.clearTimeout(calm);
    };
  }, []);

  // A trackpad scrolls the feed itself: the next screen follows the fingers and
  // the feed snaps when they lift. A mouse wheel moves in coarse steps, so one
  // notch glides to the next or previous screen and the rest of that spin is
  // ignored. Content taller than its screen scrolls first.
  useEffect(() => {
    const box = feed.current;
    if (!box) return;
    let lockedUntil = 0;
    let swept = 0;
    function onWheel(e: WheelEvent) {
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      const notch = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
      if (!notch) return;
      const down = e.deltaY > 0;
      const inner = (e.target as HTMLElement).closest(".screen9");
      if (inner && (down ? inner.scrollTop + inner.clientHeight < inner.scrollHeight - 2 : inner.scrollTop > 2)) return;
      e.preventDefault();
      const now = Date.now();
      if (now < lockedUntil) {
        lockedUntil = now + 250;
        return;
      }
      swept += e.deltaY;
      if (Math.abs(swept) < 30) return;
      swept = 0;
      lockedUntil = now + 550;
      const i = Math.round(box!.scrollTop / box!.clientHeight) + (down ? 1 : -1);
      if (i < 0 || i >= box!.scrollHeight / box!.clientHeight) return;
      box!.scrollTo({ top: i * box!.clientHeight, behavior: "smooth" });
    }
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []);

  /** Scrolling settles on a screen; that screen is what is playing. */
  const settle = useRef<number | undefined>(undefined);
  function onScroll() {
    window.clearTimeout(settle.current);
    if (resizing.current) return;
    settle.current = window.setTimeout(() => {
      const box = feed.current;
      if (!box || !box.clientHeight) return;
      const i = Math.round(box.scrollTop / box.clientHeight);
      setAtEnd(made.length > 0 && i >= made.length);
      const to = made[i]?.outputId;
      if (to && to !== outputId) onGo(to);
    }, 120);
  }
  const go = (id: string) => onGo(id);

  const currentId = found >= 0 ? outputId : current?.outputId;
  const done = current?.item.done === true;
  const left = made.find((i) => !i.done);
  const coming = views.some((v) => v.items.some((i) => i.enabled && !i.outputId && i.status !== "skipped" && i.status !== "cancelled" && i.status !== "failed"));
  const onNext = atEnd ? undefined : next ? () => onGo(next.outputId!) : made.length > 0 ? () => toSlide(made.length) : undefined;
  const onPrev = atEnd ? () => toSlide(at) : prev ? () => onGo(prev.outputId!) : undefined;
  const look = lookFor(formats, current?.item.type ?? "");
  function jumpTo(spot: Json) {
    const to = current?.outputId;
    if (to) setJump((j) => ({ outputId: to, at: spot, n: (j?.n ?? 0) + 1 }));
  }
  const talking = talk && !!currentId && !atEnd;

  return (
    <aside className={`immerse${talking && !narrow ? " threading" : ""}`} aria-label="Playing">
      <PlayerChrome
        variant="panel"
        tone={look.colorSlot}
        title={current?.item.title ?? ""}
        back={{ label: "Back to the project", onClick: onClose }}
        full={narrow || !currentId || atEnd ? undefined : { label: "Full view", to: `/outputs/${encodeURIComponent(currentId)}` }}
        talk={currentId && !atEnd ? { count: threads.counts.get(current?.item.id ?? "") ?? 0, open: talk, onToggle: () => openTalk(!talk) } : undefined}
        done={
          currentId && !atEnd
            ? { done, onToggle: () => (!done && report?.onDone ? report.onDone() : ticks.current.get(currentId)?.(!done)) }
            : undefined
        }
        report={atEnd ? undefined : report}
        onNext={onNext}
        onPrev={onPrev}
        aside={
          talking && current && currentId ? (
            <Thread
              key={current.item.id}
              planId={current.view.plan.id}
              itemId={current.item.id}
              outputId={currentId}
              projectId={projectId}
              title={current.item.title}
              kind={look.label}
              where={() => spots.current.get(currentId)}
              variant={narrow ? "sheet" : "side"}
              onClose={() => openTalk(false)}
              onJump={jumpTo}
              {...(onOpenChat ? { onOpenChat } : {})}
              {...(onOpenCite ? { onOpenCite: (c: Cite) => onOpenCite(c) } : {})}
              {...(ask ? { ask } : {})}
              onSent={(chatId) => (threads.bump(), onThreadSent?.(chatId))}
            />
          ) : undefined
        }
      >
        <div className="feed9" ref={feed} onScroll={onScroll}>
          {made.length === 0 && (
            <ChromeSlot onReport={setReport}>
              <Screen outputId={outputId} go={go} onPlanChange={onPlanChange} onOpenCite={onOpenCite} onTick={(set) => ticks.current.set(outputId, set)} />
            </ChromeSlot>
          )}
          {made.map((item, i) => {
            const o = i === found ? outputId : item.outputId!;
            const start = jump?.outputId === o ? jump : undefined;
            return Math.abs(i - at) <= 1 ? (
              <section key={item.id} className="slide" aria-label={item.title} aria-current={i === at && !atEnd}>
                <ChromeSlot active={i === at && !atEnd} onReport={setReport}>
                  <Screen
                    key={start ? `at-${start.n}` : "screen"}
                    outputId={o}
                    go={go}
                    active={i === at && !atEnd}
                    onPlanChange={onPlanChange}
                    onOpenCite={onOpenCite}
                    {...(start ? { startAt: start.at } : {})}
                    onHere={(spot) => (spots.current.set(o, spot), onMoment?.(o, spot))}
                    aboutHere={askHere(o)}
                    onTick={(set) => ticks.current.set(o, set)}
                    onPlayNew={(id, itemId) => (setOwners((was) => ({ ...was, [id]: itemId })), onGo(id))}
                  />
                </ChromeSlot>
              </section>
            ) : (
              <section key={item.id} className="slide cover" aria-label={item.title}>
                <FormatTile id={item.type} formats={formats} size="lg" solid done={item.done} />
                <b>{item.title}</b>
              </section>
            );
          })}
          {made.length > 0 && (
            <section className="slide" aria-label="The end" aria-current={atEnd}>
              <EndCard
                whole="project"
                total={made.length}
                done={made.filter((i) => i.done).length}
                coming={coming}
                back={{ label: "Back to the project", onClick: onClose }}
                left={left ? { onClick: () => (setAtEnd(false), onGo(left.outputId!)) } : undefined}
              />
            </section>
          )}
        </div>
      </PlayerChrome>
    </aside>
  );
}

/** One made thing, drawn by its format's player. */
function Screen({
  outputId,
  go,
  active = true,
  onPlanChange,
  onOpenCite,
  startAt,
  onHere,
  aboutHere,
  onTick,
  onPlayNew,
}: {
  outputId: string;
  go: (outputId: string) => void;
  active?: boolean;
  onPlanChange?: ((view: PlanView) => void) | undefined;
  onOpenCite?: OpenCite | undefined;
  /** Opens at this spot instead of where the person stopped. */
  startAt?: Json;
  /** Hears where the person is, as the player reports it (or keeps it). */
  onHere?: (at: Json) => void;
  /** What the player may draw in its slot about a spot. */
  aboutHere?: (at: Json) => ReactNode;
  /** Hears how to tick this thing's plan item done or not, for the chrome's done tick. */
  onTick?: (set: (done: boolean, result?: Json) => void) => void;
  /** Plays the new thing made from this one (a scene of it made again), in its item's place. */
  onPlayNew?: (outputId: string, itemId: string) => void;
}) {
  const client = useApi();
  const formats = useFormats();
  const output = useLoad(() => client.getOutput(outputId), [client, outputId]);
  const place = usePlace(output.data, onPlanChange);
  const sources = useSources(output.data);
  const o = output.data;
  onTick?.((done, result) => void place.set(done, result));
  const placed = placeProps(place);
  if (startAt !== undefined) placed.progress = startAt;
  // Where it opens is where the person is until the player says otherwise.
  const opened = placed.progress;
  useEffect(() => {
    if (opened !== undefined) onHere?.(opened);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place.ready]);
  const kept = placed.keep;
  if (kept) placed.keep = (p: Json) => (onHere?.(p), kept(p));
  return (
    <div className="screen9">
      {!o || !place.ready ? (
        <LoadState loading={output.loading || !place.ready} error={output.error} what="this item" />
      ) : (
        (renderPlayer(formats, o.type, {
          output: o,
          sources,
          go,
          active,
          ...(onOpenCite ? { onOpenCite } : {}),
          ...placed,
          ...(onHere ? { here: onHere } : {}),
          ...(aboutHere ? { aboutHere } : {}),
          finish: place.known ? <Finish done={place.done} error={place.error} onDone={(result) => place.set(true, result)} /> : null,
        }) ?? <p className="none">This format has no web player yet.</p>)
      )}
      {o && active && <RemakeReady key={o.id} output={o} onPlay={onPlayNew ?? go} />}
    </div>
  );
}
