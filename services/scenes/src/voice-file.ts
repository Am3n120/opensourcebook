/**
 * The private voice file: where the voice chosen in the app, and its key, are kept on this computer. It is a small JSON
 * object with the same names as `services/scenes/.env` (`SCENES_VOICE`, a service's key, a service's voice), laid over
 * the environment so a choice made in the app wins and a `.env` keeps working without it.
 *
 * `SCENES_VOICE_FILE` says where it is (the launcher keeps it in `.opensourcebook/voice.json`); by default it is `voice.json` in the
 * data folder. It is written for its owner alone (0600, in a folder made 0700), whole or not at all, and never logged:
 * nothing here prints a value.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VoiceService, VoiceSettings } from "./voices.ts";

/** Where the voice file is for these settings. */
export function voiceFilePath(env: Record<string, string | undefined>, dataDir: string): string {
  return env.SCENES_VOICE_FILE?.trim() || join(dataDir, "voice.json");
}

/** The names the file may hold: the choice, and each service's key and voice. Anything else in it is ignored. */
export function voiceFileNames(services: VoiceService[]): Set<string> {
  return new Set(["SCENES_VOICE", ...services.flatMap((s) => [s.key?.name, s.voiceSetting].filter((n): n is string => !!n))]);
}

/** What the file holds, kept to the names it may hold; nothing when it is missing or unreadable. */
export function readVoiceFile(file: string, names: Set<string>): Record<string, string> {
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => names.has(k) && typeof v === "string" && v.trim()).map(([k, v]) => [k, (v as string).trim()]));
  } catch {
    return {};
  }
}

/** Writes the file whole, for its owner alone: a new file beside it (0600), then moved over it. */
export function writeVoiceFile(file: string, values: Record<string, string>): void {
  const folder = dirname(file);
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const next = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(next, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, file);
  chmodSync(file, 0o600);
}

/** The settings a voice is built from: the environment, with the file over it. */
export function layered(env: Record<string, string | undefined>, file: Record<string, string>): VoiceSettings {
  return { ...env, ...file };
}
