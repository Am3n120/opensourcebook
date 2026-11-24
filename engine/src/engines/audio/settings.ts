/**
 * An audio's settings: how long it runs, which is how far it goes, and the
 * maker when there is more than one. One voice speaks every audio; the voice
 * is the computer's (the scenes service's), the same one videos use.
 */
import { AUTO_LENGTH_KEY } from "../../studio/timing";
import type { SettingsResult, ValidationIssue } from "../../studio/types";
import { parseMakerSetting } from "../makers";
import { AGENT_SETTING_KEYS, readAgentFields } from "../agent-fields";
import { AUDIO_LIMITS } from "./contract";

export interface AudioSettings {
  /** Minutes it runs; 0 fits it to the brief and the sources. */
  minutes: number;
  /** The length `settle` filled in for minutes left on Auto (0), so its time is kept under "auto" (studio/timing.ts). */
  autoLength?: number;
  /** The maker's id, or "auto" (absent) for the one Open Sourcebook picks (engines/makers.ts). */
  maker?: string;
  /** Who makes it when the person's agent does: "auto" (the default from Settings) or a pick id (engines/agent-fields.ts). */
  agent?: string;
  /** How hard that agent thinks: "auto" or an effort id. */
  effort?: string;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = { minutes: 0 };

/**
 * A length from the size of the sources when none was set: about a minute
 * for every 2,500 characters (a walk-through says less than it reads, and
 * says it slower), within 2 to 20 minutes.
 */
export function fitMinutes(sourceChars: number): number {
  return Math.min(20, Math.max(2, Math.round(sourceChars / 2_500)));
}

export function parseAudioSettings(raw: unknown): SettingsResult<AudioSettings> {
  const settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  if (raw === undefined || raw === null) return { ok: true, settings };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issues: [issue("$", "type", "Settings must be an object")] };
  const record = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(record)) if (key !== "minutes" && key !== AUTO_LENGTH_KEY && key !== "maker" && !AGENT_SETTING_KEYS.includes(key)) issues.push(issue(`$.${key}`, "unknown_key", `Unknown setting "${key}"`));
  if (record.minutes !== undefined) {
    const value = record.minutes;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= AUDIO_LIMITS.maxMinutes) settings.minutes = value;
    else issues.push(issue("$.minutes", "range", `minutes must be a number from 0 to ${AUDIO_LIMITS.maxMinutes}`));
  }
  const autoLength = record[AUTO_LENGTH_KEY];
  if (typeof autoLength === "number" && Number.isFinite(autoLength) && autoLength > 0) settings.autoLength = autoLength;
  const maker = parseMakerSetting(record.maker);
  if (!maker.ok) issues.push(issue("$.maker", "format", maker.message));
  else if (maker.maker) settings.maker = maker.maker;
  Object.assign(settings, readAgentFields(record, issues));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, settings };
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message, severity: "error" };
}
