import { useCallback, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { Json } from "../api/types";
import { useApi, useFormats } from "../app/context";
import { ErrorNotice, LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { useTitle } from "../app/useTitle";
import { lookFor } from "../design/formatLook";
import { Icon } from "../design/Icon";
import { Empty } from "../design/ui";
import { AskHere, Thread } from "../thread/Thread";
import { RemakeReady } from "../thread/RemakeReady";
import { useNarrow } from "../thread/useNarrow";
import { rememberOpen, rememberedOpen, useThreadCounts } from "../thread/useThread";
import { ChromeSlot, PlayerChrome, type ChromeReport } from "./chrome";
import { EndCard } from "./EndCard";
import { placeProps, usePlace, useSources } from "./place";
import type { PlayerProps } from "./players";
import { renderPlayer } from "./registry";
import "./player.css";

/**
 * One thing made, filling the window in its format's player, inside the
 * chrome every player wears (chrome.tsx). On a wide window this is the full
 * view, left by "Exit full view" for the project's panel; on a phone it is
 * the whole screen. Opened from a plan, scrolling goes on to the next made
 * thing and, after the last, to the plan's end card.
 */
export function PlayerScreen() {
  const { id = "" } = useParams();
  const client = useApi();
  const formats = useFormats();
  const navigate = useNavigate();
  const output = useLoad(() => client.getOutput(id), [client, id]);
  useTitle(output.data?.title);
  const place = usePlace(output.data);
  const sources = useSources(output.data);
  const project = useLoad(
    () => (output.data?.projectId ? client.getProject(output.data.projectId) : Promise.resolve(undefined)),
    [client, output.data?.projectId],
  );
  const narrow = useNarrow();
  const go = useCallback((outputId: string) => navigate(`/outputs/${outputId}`), [navigate]);
  const [report, setReport] = useState<ChromeReport>();
  // The plan's end card, shown after the last made thing; per thing, so moving on puts it away.
  const [endedAt, setEndedAt] = useState<string>();
  const ended = endedAt === id;

  // The thread on this thing: beside it on a wide window, a sheet over its lower part on a narrow one; left open per thing.
  const o = output.data;
  const itemId = o?.itemId;
  const [talkFor, setTalkFor] = useState(itemId);
  const [talk, setTalk] = useState(() => (itemId ? rememberedOpen(itemId) : false));
  if (itemId !== talkFor) {
    setTalkFor(itemId);
    setTalk(itemId ? rememberedOpen(itemId) : false);
  }
  const threads = useThreadCounts(o?.projectId);
  const [ask, setAsk] = useState<{ n: number; at: Json }>();
  const [jump, setJump] = useState<{ at: Json; n: number }>();
  // Where the person is in the thing, as its player reports it: what a thread message is written about.
  const spot = useRef<Json | undefined>(undefined);
  const note = useCallback((at: Json) => {
    spot.current = at;
  }, []);
  const openTalk = (open: boolean) => {
    setTalk(open);
    if (itemId) rememberOpen(itemId, open);
  };

  if (!o)
    return (
      <main className="main">
        <LoadState loading={output.loading} error={output.error} what="this item" onRetry={() => void output.reload()} page />
      </main>
    );

  // A thing asked for on its own is made as a one-item plan the person never sees as a plan, so it goes back to its project.
  const direct = place.view?.plan.direct === true;
  const inPlan = place.known && !direct && place.total > 1;
  const back = direct && o.projectId
    ? { to: `/projects/${o.projectId}`, label: "Back to the project" }
    : o.planId && o.projectId
      ? { to: `/projects/${o.projectId}?plan=${o.planId}`, label: "Back to the plan" }
      : { to: "/library", label: "Back to the Library" };
  const full = { label: "Exit full view", to: o.projectId ? `/projects/${o.projectId}?play=${encodeURIComponent(o.id)}` : back.to };

  // Down goes to the next made thing, and after the last to the end card; up comes back.
  const next = place.next;
  const prev = place.prev;
  const onNext = ended ? undefined : next ? () => go(next.outputId) : inPlan ? () => setEndedAt(id) : undefined;
  const onPrev = ended ? () => setEndedAt(undefined) : prev ? () => go(prev.outputId) : undefined;

  const planId = o.planId;
  const projectId = o.projectId;
  const talkable = projectId && planId && itemId ? { projectId, planId, itemId } : undefined;
  const base = placeProps(place);
  const kept = base.keep;
  const placed = { ...base, ...(jump ? { progress: jump.at } : {}), ...(kept ? { keep: (p: Json) => (note(p), kept(p)) } : {}) };
  const look = lookFor(formats, o.type);

  let body;
  if (ended) body = <PlanEnd view={place.view} onBack={() => navigate(back.to)} go={go} />;
  else if (!place.ready) body = <LoadState loading error={undefined} what="this item" page />;
  else
    body = (
      <ChromeSlot key={`${o.id}-${jump?.n ?? 0}`} onReport={setReport}>
        <Played
          type={o.type}
          props={{
            output: o,
            sources,
            go,
            ...placed,
            here: note,
            ...(talkable ? { aboutHere: (at: Json) => <AskHere onAsk={() => (note(at), setAsk((a) => ({ n: (a?.n ?? 0) + 1, at })), openTalk(true))} /> } : {}),
            finish: place.known ? <Finish done={place.done} error={place.error} onDone={(result) => place.set(true, result)} /> : null,
          }}
        />
        <RemakeReady key={o.id} output={o} onPlay={go} />
      </ChromeSlot>
    );

  return (
    <div className="player">
      <PlayerChrome
        variant={narrow ? "phone" : "full"}
        tone={look.colorSlot}
        title={ended ? (place.view?.plan.title ?? o.title) : o.title}
        sub={project.data?.title}
        back={back}
        full={narrow ? undefined : full}
        talk={talkable && !ended ? { count: threads.counts.get(talkable.itemId) ?? 0, open: talk, onToggle: () => openTalk(!talk) } : undefined}
        done={
          place.known && !ended
            ? { done: place.done, onToggle: () => (place.done ? void place.set(false) : report?.onDone ? report.onDone() : void place.set(true)) }
            : undefined
        }
        report={ended ? undefined : report}
        onNext={onNext}
        onPrev={onPrev}
        aside={
          talk && talkable && !ended ? (
            <Thread
              key={talkable.itemId}
              planId={talkable.planId}
              itemId={talkable.itemId}
              outputId={o.id}
              projectId={talkable.projectId}
              title={o.title}
              kind={look.label}
              where={() => spot.current ?? place.progress}
              variant={narrow ? "sheet" : "side"}
              onClose={() => openTalk(false)}
              onJump={(at) => setJump((j) => ({ at, n: (j?.n ?? 0) + 1 }))}
              {...(ask ? { ask } : {})}
              onSent={threads.bump}
            />
          ) : undefined
        }
      >
        {body}
        {place.error !== undefined && (
          <div className="pc-error">
            <ErrorNotice error={place.error} />
          </div>
        )}
      </PlayerChrome>
    </div>
  );
}

/** A thing in its format's player, or a word that the web has none for it yet. */
function Played({ type, props }: { type: string; props: PlayerProps }) {
  const formats = useFormats();
  return (
    renderPlayer(formats, type, props) ?? (
      <div className="main">
        <Empty title="No web player for this format yet">It was made; its player comes with that format.</Empty>
      </div>
    )
  );
}

/** The end card of the plan this thing is in: how many, how many done, whether more is coming, and the first one left. */
function PlanEnd({ view, onBack, go }: { view: ReturnType<typeof usePlace>["view"]; onBack: () => void; go: (outputId: string) => void }) {
  // What was let go (skipped, cancelled) is not part of the count.
  const items = (view?.items ?? []).filter((i) => i.enabled && i.status !== "skipped" && i.status !== "cancelled");
  const left = items.find((i) => i.outputId && !i.done);
  const coming = items.some((i) => !i.outputId && i.status !== "failed");
  return (
    <EndCard
      whole="plan"
      total={items.length}
      done={items.filter((i) => i.done).length}
      coming={coming}
      back={{ label: "Back to the project", onClick: onBack }}
      left={left?.outputId ? { onClick: () => go(left.outputId!) } : undefined}
    />
  );
}

/** The end of a thing: mark it done on the plan (a quiz sends its graded result with it). */
export function Finish({ done, error, onDone, label = "Mark done" }: { done: boolean; error: unknown; onDone: (result?: Json) => void; label?: string }) {
  return (
    <div className="finish">
      {done ? (
        <span className="st done">
          <Icon name="check" /> Marked done.
        </span>
      ) : (
        <button className="btn" type="button" onClick={() => onDone()}>
          <Icon name="check" />
          {label}
        </button>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
