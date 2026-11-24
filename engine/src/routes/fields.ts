/**
 * Checks for request body fields, shared by the Studio routes. Each returns
 * the value, `undefined` when the field is absent, or a `FieldError` that
 * the route turns into `400 invalid_request` (docs/api.md, "Conventions").
 */
import { errorResponse } from "../http";
import { isRecord } from "../net";
import { isDay } from "../studio/days";
import type { JsonValue } from "../studio/types";

export class FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldError";
  }
}

export function fieldErrorResponse(error: FieldError): Response {
  return errorResponse("invalid_request", error.message, 400);
}

/** Runs `read` and answers a FieldError with 400; anything else is thrown on. */
export function readFields<T>(read: () => T): { value: T } | { response: Response } {
  try {
    return { value: read() };
  } catch (error) {
    if (error instanceof FieldError) return { response: fieldErrorResponse(error) };
    throw error;
  }
}

/** Trimmed text of 1 to `max` characters. */
export function text(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new FieldError(`${key} must be non-empty text`);
  if (value.trim().length > max) throw new FieldError(`${key} is at most ${max} characters`);
  return value.trim();
}

/** Like `text`, but `null` (or blank) clears it. */
export function clearableText(body: Record<string, unknown>, key: string, max: number): string | null | undefined {
  const value = body[key];
  if (value === null || (typeof value === "string" && !value.trim())) return null;
  return text(body, key, max);
}

/** Text that may be empty (a brief). */
export function longText(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new FieldError(`${key} must be text`);
  if (value.length > max) throw new FieldError(`${key} is at most ${max} characters`);
  return value;
}

/**
 * A calendar day written YYYY-MM-DD (studio/days.ts). Required unless
 * `clearable`, when `null` clears it.
 */
export function day(body: Record<string, unknown>, key: string, clearable: boolean): string | null | undefined {
  const value = body[key];
  if (value === null && clearable) return null;
  if (value === undefined && clearable) return undefined;
  if (!isDay(value)) throw new FieldError(`${key} must be a day written YYYY-MM-DD${clearable ? ", or null" : ""}`);
  return value;
}

export function integer(body: Record<string, unknown>, key: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new FieldError(`${key} must be an integer from ${min}${max === Number.MAX_SAFE_INTEGER ? " up" : ` to ${max}`}`);
  }
  return value;
}

export function clearableInteger(body: Record<string, unknown>, key: string, min: number, max?: number): number | null | undefined {
  return body[key] === null ? null : integer(body, key, min, max);
}

export function clearableNumber(body: Record<string, unknown>, key: string, min: number): number | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new FieldError(`${key} must be a number of at least ${min}`);
  return value;
}

export function boolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new FieldError(`${key} must be true or false`);
  return value;
}

/** A JSON object of at most `maxChars` characters once serialized. */
export function object(body: Record<string, unknown>, key: string, maxChars: number): { [key: string]: JsonValue } | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new FieldError(`${key} must be an object`);
  if (JSON.stringify(value).length > maxChars) throw new FieldError(`${key} is at most ${maxChars} characters of JSON`);
  return value as { [key: string]: JsonValue };
}

export function clearableObject(body: Record<string, unknown>, key: string, maxChars: number): { [key: string]: JsonValue } | null | undefined {
  return body[key] === null ? null : object(body, key, maxChars);
}

/** A non-empty id string. */
export function id(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new FieldError(`${key} must be an id`);
  return value.trim();
}

export function clearableId(body: Record<string, unknown>, key: string): string | null | undefined {
  return body[key] === null ? null : id(body, key);
}

export function required<T>(value: T | undefined, key: string): T {
  if (value === undefined) throw new FieldError(`${key} is required`);
  return value;
}
