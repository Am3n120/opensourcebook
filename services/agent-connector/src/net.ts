import { timingSafeEqual } from "node:crypto";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True for a URL on this computer. */
export function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Compares secrets in time that does not depend on where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
