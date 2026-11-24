import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanView } from "../api/types";
import { useApi } from "../app/context";

/**
 * How long after one read of the running plans the next starts; a read is a
 * few milliseconds, and items can finish within seconds. Reads never overlap:
 * a slow engine slows the reading down instead of piling requests up.
 */
const POLL_MS = 1000;
/**
 * How often the project's list of plans is looked at, for a plan another tab, the phone or `opensourcebook` started, or one
 * that changed there: a plan this tab never knew of is read in full, and so is one whose status or time moved.
 */
const LIST_MS = 4000;
/**
 * A page the browser says is hidden still reads, slowly: some windows say hidden while they show (a pane beside
 * another app, a second window), and a page that never read again looked stuck until it was reloaded.
 */
const HIDDEN_MS = 15_000;

/** What says a plan changed in a list read: its id, status and last write. */
function stamp(plans: Array<{ id: string; status: string; updatedAt: string }>): string {
  return plans
    .map((p) => `${p.id}:${p.status}:${p.updatedAt}`)
    .sort()
    .join(",");
}

/** Every plan of a project as full views, oldest first; running plans are read again until they settle. */
export function useProjectPlans(projectId: string) {
  const client = useApi();
  const [views, setViews] = useState<PlanView[]>();
  const [error, setError] = useState<unknown>();
  const live = useRef(true);

  const fetchAll = useCallback(async () => {
    const plans = await client.listPlans(projectId);
    return Promise.all(plans.map((p) => client.getPlan(p.id)));
  }, [client, projectId]);

  useEffect(() => {
    live.current = true;
    fetchAll().then(
      (v) => live.current && setViews(v),
      (e: unknown) => live.current && setError(e),
    );
    return () => {
      live.current = false;
    };
  }, [fetchAll]);

  const load = useCallback(async () => {
    try {
      setViews(await fetchAll());
    } catch (e) {
      setError(e);
    }
  }, [fetchAll]);

  const set = useCallback((v: PlanView) => {
    setViews((cur) => {
      const list = cur ?? [];
      const was = list.find((x) => x.plan.id === v.plan.id);
      // A read that changed nothing keeps the same list, so nothing on screen is drawn again.
      if (was && JSON.stringify(was) === JSON.stringify(v)) return cur;
      return was ? list.map((x) => (x.plan.id === v.plan.id ? v : x)) : [...list, v];
    });
  }, []);

  /** A plan deleted here leaves the list at once; the next look at the engine's list agrees. */
  const remove = useCallback((planId: string) => {
    setViews((cur) => (cur?.some((x) => x.plan.id === planId) ? cur.filter((x) => x.plan.id !== planId) : cur));
  }, []);

  const running = (views ?? []).filter((v) => v.plan.status === "running").map((v) => v.plan.id).join(",");
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let timer: number | undefined;
    const next = () => {
      window.clearTimeout(timer);
      // A hidden page reads slowly, and at once when it is shown again.
      if (!stopped) timer = window.setTimeout(read, document.visibilityState === "hidden" ? HIDDEN_MS : POLL_MS);
    };
    let reading = false;
    const read = async () => {
      if (reading || stopped) return;
      reading = true;
      await Promise.all(running.split(",").map((id) => client.getPlan(id).then((v) => !stopped && set(v), () => undefined)));
      reading = false;
      next();
    };
    const shown = () => document.visibilityState === "visible" && void read();
    next();
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("focus", shown);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("focus", shown);
    };
  }, [running, client, set]);

  // The list of plans, looked at now and then (and when the tab is shown or focused): what another tab, the phone or
  // `opensourcebook` made or started appears here without a reload.
  const known = views === undefined ? undefined : stamp(views.map((v) => v.plan));
  const knownRef = useRef(known);
  useEffect(() => {
    knownRef.current = known;
  }, [known]);
  const loaded = views !== undefined;
  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    let timer: number | undefined;
    let looking = false;
    const next = () => {
      window.clearTimeout(timer);
      if (!stopped) timer = window.setTimeout(look, document.visibilityState === "hidden" ? HIDDEN_MS : LIST_MS);
    };
    const look = async () => {
      if (looking || stopped) return;
      looking = true;
      try {
        const listed = await client.listPlans(projectId);
        if (!stopped && stamp(listed) !== knownRef.current) {
          const fresh = await Promise.all(listed.map((p) => client.getPlan(p.id)));
          // A plan that reads the same keeps its old view, so nothing on screen is drawn again for it.
          if (!stopped)
            setViews((cur) => {
              const next = fresh.map((v) => cur?.find((x) => x.plan.id === v.plan.id && JSON.stringify(x) === JSON.stringify(v)) ?? v);
              return cur && next.length === cur.length && next.every((v, i) => v === cur[i]) ? cur : next;
            });
        }
      } catch {
        // The next look tries again; the engine may be restarting.
      }
      looking = false;
      next();
    };
    const shown = () => document.visibilityState === "visible" && void look();
    next();
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("focus", shown);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("focus", shown);
    };
  }, [client, projectId, loaded]);

  return { views, error, set, remove, reload: load };
}
