import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Activity as ActivityData, ActivityMaking, ActivityTotals, ActivityTurn } from "../api/types";
import { useApi, useFormats } from "../app/context";
import { LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { useTitle } from "../app/useTitle";
import { OUTLINE_BUTTON, OutlineButton } from "../design/Buttons";
import { FormatTile } from "../design/FormatTile";
import { lookFor, type FormatLike } from "../design/formatLook";
import { Icon } from "../design/Icon";
import { Making } from "../design/Making";
import { Empty } from "../design/ui";
import { ACTIVITY_REFRESH_MS, duration, linkOf, tokens } from "./activityWords";
import "./activity.css";

/**
 * Settings › Advanced › Activity: what the agents are doing and what each run took, on this computer. What is being
 * made now on top, then every finished agent turn, newest first. Time and tokens only: no screen shows money
 * (docs/DECISIONS.md #45).
 */
export function Activity() {
  useTitle("Activity");
  const client = useApi();
  const formats = useFormats();
  const [params, setParams] = useSearchParams();
  const shape = params.get("shape") ?? "";
  const project = params.get("project") ?? "";
  const filter = { ...(shape ? { shape } : {}), ...(project ? { project } : {}) };
  const key = `${shape}|${project}`;
  const first = useLoad(() => client.activity({ ...filter, dayStart: startOfToday() }), [client, key]);
  const [older, setOlder] = useState<{ key: string; turns: ActivityTurn[]; nextCursor?: string }>();
  const [olderError, setOlderError] = useState<unknown>();
  const data = first.data;
  const making = data?.making ?? [];
  const live = making.length > 0;

  // A quiet read again every few seconds while something is being made, only while the page is in view.
  const reload = first.reload;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void reload();
    }, ACTIVITY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [live, reload]);

  const extra = older?.key === key ? older : undefined;
  const turns = merged(data?.turns ?? [], extra?.turns ?? []);
  const cursor = extra ? extra.nextCursor : data?.nextCursor;

  function setFilter(name: "shape" | "project", value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }
  async function showOlder() {
    if (!cursor) return;
    setOlderError(undefined);
    try {
      const page = await client.activity({ ...filter, cursor, dayStart: startOfToday() });
      setOlder({ key, turns: [...(extra?.turns ?? []), ...page.turns], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
    } catch (e) {
      setOlderError(e);
    }
  }

  return (
    <div className="act">
      <Link className="sx-back" to="/settings#advanced" aria-label="Back to Settings">
        <Icon name="chev-l" />
        Settings
      </Link>
      <header className="act-head">
        <div>
          <h1>Activity</h1>
          <p>What your agents are doing and what each run took, on this computer.</p>
        </div>
        <OutlineButton icon="retry" disabled={first.loading} onClick={() => void first.reload()}>
          {first.loading && data ? "Refreshing…" : "Refresh"}
        </OutlineButton>
      </header>

      {!data && <LoadState loading={first.loading} error={first.error} what="the activity" onRetry={() => void first.reload()} />}
      {data && (
        <>
          {data.totals && <Totals today={data.totals.today} week={data.totals.week} />}
          <Filters data={data} formats={formats} shape={shape} project={project} onChange={setFilter} />

          <section className="act-sec" aria-labelledby="act-making">
            <h2 id="act-making">Being made now</h2>
            {making.length === 0 ? (
              <p className="act-quiet">Nothing is being made right now.</p>
            ) : (
              <ul className="act-making">
                {making.map((thing) => (
                  <li key={thing.jobId}>
                    <MakingRow thing={thing} formats={formats} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="act-sec" aria-labelledby="act-turns">
            <h2 id="act-turns">Agent turns</h2>
            <ConnectorWords data={data} />
            {data.connector === "ready" && turns.length === 0 && (
              <Empty title={shape || project ? "No turns for this filter" : "No agent turns yet"}>
                {shape || project ? "Try all shapes or all projects." : "Each chat reply and each thing made shows up here once your agent finishes its turn."}
              </Empty>
            )}
            {turns.length > 0 && <TurnTable turns={turns} formats={formats} />}
            {olderError !== undefined && (
              <p className="notice error" role="alert">
                The older turns couldn't be loaded. Try again.
              </p>
            )}
            {cursor && (
              <div className="act-more">
                <OutlineButton onClick={() => void showOlder()}>Show older turns</OutlineButton>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Today and the last 7 days, in three small numbers each. */
function Totals({ today, week }: { today: ActivityTotals; week: ActivityTotals }) {
  return (
    <section className="act-totals" aria-label="Totals">
      {[
        { label: "Today", totals: today },
        { label: "Last 7 days", totals: week },
      ].map(({ label, totals }) => (
        <div key={label} className="act-total card">
          <span className="act-total-l">{label}</span>
          <dl>
            <div>
              <dt>Turns</dt>
              <dd>{totals.turns}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>{duration(totals.seconds)}</dd>
            </div>
            <div>
              <dt>Tokens read</dt>
              <dd>{tokens(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens)}</dd>
            </div>
            <div>
              <dt>Tokens written</dt>
              <dd>{tokens(totals.outputTokens)}</dd>
            </div>
          </dl>
        </div>
      ))}
    </section>
  );
}

function Filters({ data, formats, shape, project, onChange }: { data: ActivityData; formats: readonly FormatLike[]; shape: string; project: string; onChange: (name: "shape" | "project", value: string) => void }) {
  // A filter picked from a link keeps its option, even when nothing of it is listed now.
  const shapes = shape && !data.shapes.some((s) => s.id === shape) ? [...data.shapes, { id: shape, label: shape }] : data.shapes;
  const projects = project && !data.projects.some((p) => p.id === project) ? [...data.projects, { id: project, title: "This project" }] : data.projects;
  return (
    <div className="act-filters" role="group" aria-label="Filter">
      <select className="ipt" aria-label="Shape" value={shape} onChange={(e) => onChange("shape", e.target.value)}>
        <option value="">All shapes</option>
        {shapes.map((s) => (
          <option key={s.id} value={s.id}>
            {shapeWords(formats, s.id, s.label)}
          </option>
        ))}
      </select>
      <select className="ipt" aria-label="Project" value={project} onChange={(e) => onChange("project", e.target.value)}>
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>
    </div>
  );
}

function MakingRow({ thing, formats }: { thing: ActivityMaking; formats: readonly FormatLike[] }) {
  const so = duration(thing.seconds);
  const lead = thing.status === "running" ? `Making · ${so} so far` : thing.status === "waiting" ? "Waiting" : "Waiting to start";
  const words = [lead, thing.waiting?.words ?? thing.step].filter(Boolean).join(" · ");
  const maker = thing.maker ? [thing.maker.agent, thing.maker.model, thing.maker.effort && `${thing.maker.effort} effort`].filter(Boolean).join(", ") : undefined;
  const title = thing.title ?? `A ${lookFor(formats, thing.shape).label}`;
  const href = linkOf(thing.open);
  return (
    <div className="act-mk">
      <Making
        state={thing.status === "running" ? "making" : "waiting"}
        title={title}
        text={words}
        lead={<FormatTile id={thing.shape} formats={formats} size="sm" />}
        {...(thing.status === "running" && thing.progress > 0 ? { progress: thing.progress, progressLabel: `${title}: ${Math.round(thing.progress * 100)}%` } : {})}
      />
      <div className="act-mk-meta">
        <span>{[thing.project?.title, maker && `on ${maker}`].filter(Boolean).join(" · ")}</span>
        {href && (
          <Link className={OUTLINE_BUTTON} to={href}>
            Open
          </Link>
        )}
      </div>
    </div>
  );
}

/** Why there are no turns to show, when it is the connector. */
function ConnectorWords({ data }: { data: ActivityData }) {
  if (data.connector === "notSetUp")
    return (
      <p className="notice">
        The agent connector isn't set up, so there are no agent turns to show. <Link to="/settings#advanced">Settings › Advanced</Link> says how to start it.
      </p>
    );
  if (data.connector === "unreachable")
    return (
      <p className="notice warn">
        The agent connector can't be reached right now, so its turns aren't shown. Start Open Sourcebook again, then Refresh.
      </p>
    );
  if (data.log === "off")
    return (
      <p className="notice">
        The connector keeps no record of its turns: <code>OPENSOURCEBOOK_USAGE_LOG</code> is off where it runs.
      </p>
    );
  return null;
}

const ENDED: Record<ActivityTurn["outcome"], string> = { done: "Done", stopped: "Stopped", failed: "Didn't finish" };

/** The finished turns: a plain table on a computer, stacked rows on a phone (activity.css). */
function TurnTable({ turns, formats }: { turns: ActivityTurn[]; formats: readonly FormatLike[] }) {
  return (
    <div className="act-tablewrap card">
      <table className="act-table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">What for</th>
            <th scope="col">Agent</th>
            <th scope="col" className="num">
              Took
            </th>
            <th scope="col" className="num">
              Tokens read
            </th>
            <th scope="col" className="num">
              Tokens written
            </th>
            <th scope="col" className="num">
              Tool calls
            </th>
            <th scope="col">How it ended</th>
          </tr>
        </thead>
        <tbody>
          {turns.map((turn) => (
            <TurnRow key={turn.turnId} turn={turn} formats={formats} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TurnRow({ turn, formats }: { turn: ActivityTurn; formats: readonly FormatLike[] }) {
  const href = linkOf(turn.open);
  const what = turn.shape ? shapeWords(formats, turn.shape) : "an agent turn";
  const kind = turn.review ? `fresh look at a ${what}` : what;
  const title = turn.title ?? (turn.shape ? `A ${kind}` : "Not named");
  const read = (turn.inputTokens ?? 0) + (turn.cacheReadTokens ?? 0) + (turn.cacheWriteTokens ?? 0);
  const anyRead = turn.inputTokens !== undefined || turn.cacheReadTokens !== undefined || turn.cacheWriteTokens !== undefined;
  const spec = [turn.model, turn.effort && `${turn.effort} effort`].filter(Boolean).join(" · ");
  return (
    <tr>
      <td data-label="When" className="act-when">
        <time dateTime={turn.at} title={new Date(turn.at).toLocaleString()}>
          {when(turn.at)}
        </time>
      </td>
      <td data-label="What for" className="act-what">
        <span className="act-what-in">
          {turn.shape && <FormatTile id={turn.shape} formats={formats} size="sm" />}
          <span className="act-two">
            {href ? <Link to={href}>{title}</Link> : <b>{title}</b>}
            <span>{[turn.title || !turn.shape ? kind : undefined, turn.project?.title].filter(Boolean).join(" · ")}</span>
          </span>
        </span>
      </td>
      <td data-label="Agent">
        <span className="act-two">
          <b>{turn.agentLabel ?? turn.agent}</b>
          {spec && <span>{spec}</span>}
        </span>
      </td>
      <td data-label="Took" className="num">
        <span className="act-ph">took </span>
        {duration(turn.seconds)}
      </td>
      <td data-label="Tokens read" className="num">
        {anyRead ? (
          <span className="act-two">
            <span className="act-strong">
              {tokens(read)}
              <span className="act-ph"> tokens read</span>
            </span>
            {turn.cacheReadTokens ? <span>{tokens(turn.cacheReadTokens)} from cache</span> : null}
          </span>
        ) : (
          <NotReported what="tokens read" />
        )}
      </td>
      <td data-label="Tokens written" className="num">
        {turn.outputTokens !== undefined ? (
          <>
            {tokens(turn.outputTokens)}
            <span className="act-ph"> tokens written</span>
          </>
        ) : (
          <NotReported what="tokens written" />
        )}
      </td>
      <td data-label="Tool calls" className="num">
        {turn.toolCalls}
        <span className="act-ph"> {turn.toolCalls === 1 ? "tool call" : "tool calls"}</span>
      </td>
      <td data-label="How it ended">
        <span className={`act-end ${turn.outcome}`}>{ENDED[turn.outcome]}</span>
      </td>
    </tr>
  );
}

/** A count the agent did not report: the column says what on a computer, the words do on a phone. */
function NotReported({ what }: { what: string }) {
  return (
    <span className="act-none">
      <span className="act-dt">Not reported</span>
      <span className="act-ph">{what} not reported</span>
    </span>
  );
}

/** A shape in words: the format's own label, "chat" for a chat reply, else the id as it came. */
function shapeWords(formats: readonly FormatLike[], id: string, fallback?: string): string {
  if (id === "chat") return "chat reply";
  const look = lookFor(formats, id);
  return look.label !== id ? look.label : (fallback ?? id);
}

/** The newer page first, then the older ones, each turn once. */
function merged(newest: ActivityTurn[], older: ActivityTurn[]): ActivityTurn[] {
  const seen = new Set(newest.map((turn) => turn.turnId));
  return [...newest, ...older.filter((turn) => !seen.has(turn.turnId))];
}

function startOfToday(): string {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
}

/** The time today, else the day and the time. */
function when(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  if (at.toDateString() === today.toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
