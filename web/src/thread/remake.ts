import { useCallback, useEffect, useRef, useState } from "react";
import type { Json, JsonObject, PlanView, Remaking } from "../api/types";
import { useApi } from "../app/context";
import type { MakingState } from "../design/Making";
import { runningFor, timeLeft } from "../plan/planModel";
import { waitingLine } from "../plan/waiting";

/**
 * One scene of a made thing made again (engine/docs/api.md, "Remaking one
 * scene"): the words for it, and the reading that follows it until it is
 * done (the one progress look with Stop is `RemakeMaking.tsx`). A thing says whether it
 * can (`remakesScene`) and lists its scenes by id in `payload.scenes`; its
 * player says which scene is playing (`scene` in where the person is).
 * Nothing here names a format.
 */

/** How often a scene being made again is read. */
const POLL_MS = 1500;
const LIVE: ReadonlySet<string> = new Set(["queued", "running", "waiting"]);
/** Said on the page when a remake starts, so every place showing that item reads it again at once. */
const STARTED = "opensourcebook:remake";

/** Whether a remake is still under way: queued, running or waiting. A failed one stays, with Try again. */
export function remakeLive(remaking: Remaking | undefined): boolean {
  return !!remaking && LIVE.has(remaking.job.status);
}

/** The scene a spot names, as the player says it (`{ time, scene }`); undefined when it names none. */
export function sceneOf(at: Json | undefined): string | undefined {
  if (!at || typeof at !== "object" || Array.isArray(at)) return undefined;
  return typeof at.scene === "string" && at.scene ? at.scene : undefined;
}

/** Which scene that is, counted from 1, in a made thing's `payload.scenes`. */
export function sceneNumber(payload: JsonObject | undefined, scene: string): number | undefined {
  const list = Array.isArray(payload?.scenes) ? payload.scenes : [];
  const i = list.findIndex((s) => !!s && typeof s === "object" && !Array.isArray(s) && s.id === scene);
  return i >= 0 ? i + 1 : undefined;
}

/** "scene 3", or "this scene" when it cannot be counted. */
export function sceneWords(n: number | undefined): string {
  return n ? `scene ${n}` : "this scene";
}

/** The one progress look's state and words for a remake. */
export function remakeLine(remaking: Remaking, n: number | undefined, now: number = Date.now()): { state: MakingState; text: string } {
  const job = remaking.job;
  const scene = sceneWords(n);
  if (job.status === "failed") return { state: "failed", text: `Couldn't make ${scene} again${job.errorMessage ? `: ${job.errorMessage}` : ""}` };
  if (job.waiting) return { state: "waiting", text: ["Waiting", waitingLine(job)].filter(Boolean).join(" · ") };
  if (job.status === "queued") return { state: "waiting", text: `Waiting to make ${scene} again` };
  const left = timeLeft(job, now);
  return { state: "making", text: `Making ${scene} again${left ? ` · ${left}` : runningFor(job.startedAt, now)}` };
}

/** Tells every place on the page showing this item that a remake of it started. */
export function announceRemake(planId: string, itemId: string): void {
  window.dispatchEvent(new CustomEvent(STARTED, { detail: { planId, itemId } }));
}

function useStarted(heard: (planId: string, itemId: string) => void) {
  const ref = useRef(heard);
  useEffect(() => {
    ref.current = heard;
  });
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ planId: string; itemId: string }>).detail;
      if (d) ref.current(d.planId, d.itemId);
    };
    window.addEventListener(STARTED, on);
    return () => window.removeEventListener(STARTED, on);
  }, []);
}

/**
 * A remake of one item's scene, read from its plan's progress: on opening,
 * when one starts on the page, and again and again while it is under way.
 * With `outputId` (the one being watched), `newer` is the item's new output
 * once it is written, when it is a remake of that one.
 */
export function useRemake(planId: string | undefined, itemId: string | undefined, outputId?: string) {
  const client = useApi();
  const [remaking, setRemaking] = useState<Remaking>();
  const [newer, setNewer] = useState<string>();
  const [tick, setTick] = useState(0);
  const read = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!planId || !itemId) return;
    let live = true;
    client
      .progress(planId)
      .then(async (p) => {
        if (!live) return;
        const item = p.items.find((i) => i.id === itemId);
        setRemaking(item?.remaking);
        const made = item?.outputId;
        if (!outputId || !made || made === outputId || item?.remaking) return;
        const fresh = await client.getOutput(made).catch(() => undefined);
        if (live && fresh?.remakeOf?.outputId === outputId) setNewer(made);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, planId, itemId, outputId, tick]);

  const going = remakeLive(remaking);
  useEffect(() => {
    if (!going) return;
    const timer = window.setTimeout(read, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [going, tick, read]);

  useStarted((plan, item) => plan === planId && item === itemId && read());

  /** A remake just started here: shown at once, then read. */
  const begin = useCallback((r: Remaking) => {
    setRemaking(r);
    setNewer(undefined);
  }, []);
  return { remaking, newer, read, begin };
}

/**
 * Plans with a scene being made again are read again while it is under way,
 * and a plan is read at once when one starts on the page, so a list of them
 * (Made here, the chat's rows, the Studio playing them) shows it and then
 * the new thing as the item's.
 */
export function useRemakeWatch(views: PlanView[] | undefined, onChange: (view: PlanView) => void) {
  const client = useApi();
  const change = useRef(onChange);
  const known = useRef(new Set<string>());
  useEffect(() => {
    change.current = onChange;
    known.current = new Set((views ?? []).map((v) => v.plan.id));
  });
  const going = (views ?? [])
    .filter((v) => v.items.some((i) => remakeLive(i.remaking)))
    .map((v) => v.plan.id)
    .join(",");
  useEffect(() => {
    if (!going) return;
    const timer = window.setInterval(() => {
      for (const id of going.split(",")) void client.getPlan(id).then((v) => change.current(v), () => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [client, going]);
  useStarted((planId) => {
    if (known.current.has(planId)) void client.getPlan(planId).then((v) => change.current(v), () => undefined);
  });
}
