/**
 * Reminders of stages due, as this device's own notifications, while Open Sourcebook is
 * open in a tab or as an app on the home screen. Off until the person turns
 * them on in Settings (the browser asks them once). At most one a day, with
 * what is due today and what was missed; nothing leaves this computer.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router";
import type { ApiClient } from "../api/client";
import type { DueStage } from "../api/types";
import { dueName, localDay } from "../plan/days";
import { useApi } from "./context";

const ON_KEY = "opensourcebook.reminders";
const LAST_KEY = "opensourcebook.reminded";
/** How often an open Open Sourcebook looks again, so a tab left open all night reminds in the morning. */
const EVERY_MS = 30 * 60_000;

export type ReminderState = "on" | "off" | "blocked" | "unsupported";

function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage refused (a private window): reminders simply stay off.
  }
}

/** Whether reminders are on for this device, and whether the browser lets them be. */
export function reminderState(): ReminderState {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return stored(ON_KEY) === "on" && Notification.permission === "granted" ? "on" : "off";
}

/** Turns reminders on (asking the browser the first time) or off. */
export async function setReminders(on: boolean): Promise<ReminderState> {
  if (!on) {
    store(ON_KEY, null);
    return reminderState();
  }
  if (!supported()) return "unsupported";
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission === "granted") store(ON_KEY, "on");
  return reminderState();
}

/** What a day's reminder says, or nothing when nothing is due today or missed. */
export function reminderText(stages: readonly DueStage[]): { title: string; body: string; planId: string; projectId: string } | undefined {
  const now = stages.filter((s) => s.when === "today" || s.when === "missed");
  if (now.length === 0) return undefined;
  const today = now.filter((s) => s.when === "today").length;
  const missed = now.length - today;
  const count = (n: number) => `${n} stage${n === 1 ? "" : "s"}`;
  const title = today && missed ? `${count(today)} due today, ${missed} missed` : today ? `${count(today)} due today` : `${count(missed)} missed`;
  const names = now.slice(0, 3).map((s) => `${dueName(s)} (${s.planTitle || "Untitled plan"})`);
  const body = `${names.join(", ")}${now.length > 3 ? ` and ${now.length - 3} more` : ""}`;
  const first = now.find((s) => s.when === "today") ?? now[0]!;
  return { title, body, planId: first.planId, projectId: first.projectId };
}

/**
 * Reminds once on `today` when reminders are on and something is due or
 * missed. Answers what it showed, for tests.
 */
export async function remindOnce(client: Pick<ApiClient, "due">, today: string, show: (text: NonNullable<ReturnType<typeof reminderText>>) => void): Promise<boolean> {
  if (reminderState() !== "on" || stored(LAST_KEY) === today) return false;
  const text = reminderText(await client.due(today, 0));
  // Looked today: a later look today stays quiet even when something new falls due.
  store(LAST_KEY, today);
  if (!text) return false;
  show(text);
  return true;
}

/** Looks for what is due when Open Sourcebook opens, when it comes back into view, and every half hour while open. */
export function useDueReminders(): void {
  const client = useApi();
  const navigate = useNavigate();
  useEffect(() => {
    if (!supported()) return;
    const look = () =>
      void remindOnce(client, localDay(), (text) => {
        const note = new Notification(text.title, { body: text.body, tag: "opensourcebook-due" });
        note.onclick = () => {
          window.focus();
          navigate(`/projects/${text.projectId}?plan=${text.planId}`);
          note.close();
        };
      }).catch(() => undefined);
    look();
    const timer = window.setInterval(look, EVERY_MS);
    const visible = () => document.visibilityState === "visible" && look();
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [client, navigate]);
}

/** Mounted once, beside every screen. */
export function DueReminders(): null {
  useDueReminders();
  return null;
}
