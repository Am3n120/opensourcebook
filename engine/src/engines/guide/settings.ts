/**
 * A guide's settings: how many pages it runs, which is how far it goes, and
 * the maker when there is more than one.
 */
import type { SettingsResult, ValidationIssue } from "../../studio/types";
import { parseMakerSetting } from "../makers";
import { AGENT_SETTING_KEYS, readAgentFields } from "../agent-fields";
import { GUIDE_LIMITS } from "./contract";

export interface GuideSettings {
  /** Printed pages it runs; 0 fits it to the brief and the sources. */
  pages: number;
  /** The maker's id, or "auto" (absent) for the one Open Sourcebook picks (engines/makers.ts). */
  maker?: string;
  /** Who makes it when the person's agent does: "auto" (the default from Settings) or a pick id (engines/agent-fields.ts). */
  agent?: string;
  /** How hard that agent thinks: "auto" or an effort id. */
  effort?: string;
}

export const DEFAULT_GUIDE_SETTINGS: GuideSettings = { pages: 0 };

/**
 * A length from the size of the sources when none was set: one page for
 * every 20,000 characters (a guide keeps what matters of them, not all of
 * it), within 1 to 4 pages. A guide is one page unless there is a lot.
 */
export function fitPages(sourceChars: number): number {
  return Math.min(4, Math.max(1, Math.round(sourceChars / 20_000)));
}

export function parseGuideSettings(raw: unknown): SettingsResult<GuideSettings> {
  const settings: GuideSettings = { ...DEFAULT_GUIDE_SETTINGS };
  if (raw === undefined || raw === null) return { ok: true, settings };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issues: [issue("$", "type", "Settings must be an object")] };
  const record = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(record)) if (key !== "pages" && key !== "maker" && !AGENT_SETTING_KEYS.includes(key)) issues.push(issue(`$.${key}`, "unknown_key", `Unknown setting "${key}"`));
  if (record.pages !== undefined) {
    const value = record.pages;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= GUIDE_LIMITS.maxPages) settings.pages = value;
    else issues.push(issue("$.pages", "range", `pages must be a number from 0 to ${GUIDE_LIMITS.maxPages}`));
  }
  const maker = parseMakerSetting(record.maker);
  if (!maker.ok) issues.push(issue("$.maker", "format", maker.message));
  else if (maker.maker) settings.maker = maker.maker;
  Object.assign(settings, readAgentFields(record, issues));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, settings };
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message, severity: "error" };
}
