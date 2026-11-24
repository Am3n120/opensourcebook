import { useEffect, useLayoutEffect, useRef } from "react";
import { Link } from "react-router";
import { errorText, isApiError, isUnreachable } from "../api/errors";
import { Icon } from "../design/Icon";

/** How often a screen that could not reach Open Sourcebook asks again by itself. */
const RECONNECT_MS = 10_000;

/**
 * Loading, or how a load ended badly, in the screens' notice style. Something
 * that is not there (404) says so calmly with a way home; Open Sourcebook's server not
 * answering says the work is safe and, given `onRetry`, asks again by itself
 * (every few seconds and when the device is back online), so the screen comes
 * back without the person doing anything; any other failure says what went
 * wrong and, given `onRetry`, offers to load again. `page` is for a load that
 * is the whole screen, which then keeps a way home.
 */
export function LoadState({ loading, error, what, onRetry, page }: { loading: boolean; error: unknown; what: string; onRetry?: () => void; page?: boolean }) {
  const offline = isUnreachable(error);
  useReconnect(offline ? onRetry : undefined);
  if (error && isApiError(error) && error.status === 404) return <Missing what={what} />;
  if (offline && page) return <Unreachable onRetry={onRetry} busy={loading} />;
  if (offline)
    return (
      <div className="loadfail">
        <div className="notice" role="status">
          {errorText(error)}
        </div>
        {onRetry && (
          <button className="btn ghost small" type="button" disabled={loading} onClick={onRetry}>
            <Icon name="retry" />
            {loading ? "Trying…" : "Try again"}
          </button>
        )}
      </div>
    );
  if (error)
    return (
      <div className="loadfail">
        <ErrorNotice error={error} />
        {onRetry && (
          <button className="btn ghost small" type="button" onClick={onRetry}>
            <Icon name="retry" />
            Try again
          </button>
        )}
      </div>
    );
  if (loading)
    return (
      <div className="loading" role="status">
        Loading {what}…
      </div>
    );
  return null;
}

/** Asks again by itself while Open Sourcebook's server does not answer: on a timer, and as soon as the device is back online. */
function useReconnect(retry: (() => void) | undefined) {
  const latest = useRef(retry);
  useLayoutEffect(() => {
    latest.current = retry;
  });
  const on = retry !== undefined;
  useEffect(() => {
    if (!on) return;
    const again = () => latest.current?.();
    const timer = window.setInterval(again, RECONNECT_MS);
    window.addEventListener("online", again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", again);
    };
  }, [on]);
}

/** A whole screen that could not reach Open Sourcebook: calm words, the work is safe, and it comes back by itself. */
function Unreachable({ onRetry, busy }: { onRetry?: (() => void) | undefined; busy: boolean }) {
  return (
    <div className="gone" role="status">
      <span className="gi">
        <Icon name="clock" />
      </span>
      <b>Can't reach Open Sourcebook right now</b>
      <p>Your work is safe. This page comes back by itself as soon as Open Sourcebook answers again.</p>
      <div className="gone-acts">
        {onRetry && (
          <button className="btn ghost" type="button" disabled={busy} onClick={onRetry}>
            {busy ? "Trying…" : "Try now"}
          </button>
        )}
        <Link className="btn ghost" to="/">
          Go home
        </Link>
      </div>
    </div>
  );
}

/** A page or a thing that is not there: plain words and a way back. */
export function Missing({ what }: { what?: string }) {
  return (
    <div className="gone" role="status">
      <span className="gi">
        <Icon name="search" />
      </span>
      <b>{what ? `Can't find ${what}` : "Nothing here"}</b>
      <p>It may have been removed, or the link is not quite right.</p>
      <Link className="btn ghost" to="/">
        Go home
      </Link>
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const lines = isApiError(error) ? error.issueLines : [];
  return (
    <div className="notice error" role="alert">
      <div>
        {errorText(error)}
        {lines.length > 0 && (
          <ul>
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
