/** A settings check's issue, as `400 invalid_settings` lists them. */
export interface SettingsIssue {
  path: string;
  code: string;
  message: string;
  severity?: string;
}

/**
 * Any failed call: an error body from the engine (`{ error, message,
 * issues? }`), an answer that is not JSON, or no answer at all (status 0).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Plan checks give strings; settings checks give objects. */
  readonly issues: ReadonlyArray<string | SettingsIssue>;

  constructor(status: number, code: string, message: string, issues: ReadonlyArray<string | SettingsIssue> = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  /** The issues as lines a screen can list. */
  get issueLines(): string[] {
    return this.issues.map((issue) => (typeof issue === "string" ? issue : `${issue.path}: ${issue.message}`));
  }
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

/**
 * Open Sourcebook's server did not answer at all: the request never got through, or the
 * site's proxy could not reach the engine. Nothing was lost; the same call
 * can simply be made again later.
 */
export function isUnreachable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 0 || error.code === "engine_unreachable";
}

/** What a screen says when Open Sourcebook's server does not answer, in the person's words rather than ours. */
export const UNREACHABLE_TEXT = "Open Sourcebook can't reach its server right now. Your work is safe.";

/** What a screen shows for any thrown value. */
export function errorText(error: unknown): string {
  if (isUnreachable(error)) return UNREACHABLE_TEXT;
  if (error instanceof ApiError) return error.message || error.code;
  if (error instanceof Error) return error.message;
  return String(error);
}
