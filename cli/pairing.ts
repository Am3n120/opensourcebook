/**
 * One-time pairing codes. The QR code the launcher shows carries one; opening it on a phone pairs that phone.
 *
 * A code is 128 random bits, works once, and runs out after a few minutes. Only one code is open at a time: making a
 * new one closes the old. Wrong codes are counted: a device address that sends a few wrong ones is refused for a
 * while. Wrong codes never close the open code, so nobody on the network can shut the pairing step by guessing from
 * many addresses; a 128-bit code cannot be guessed in any number of tries. Codes live only in the launcher's memory
 * and are compared in constant time.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CODE_LIFE_MS = 10 * 60_000;
/** Wrong codes one address may send in a window before it is refused until the window passes. */
export const TRIES_PER_ADDRESS = 5;
/** At most this many wrong tries are remembered at once, so a flood of addresses cannot grow the launcher's memory. */
const REMEMBERED = 10_000;
export const TRY_WINDOW_MS = 10 * 60_000;

export type Redeemed = "paired" | "wrong" | "expired" | "used" | "limited";

interface Open {
  digest: Buffer;
  expiresAt: number;
  used: boolean;
}

const digest = (code: string) => createHash("sha256").update(code, "utf8").digest();

export class PairingCodes {
  private open: Open | undefined;
  private failures: Array<{ address: string; at: number }> = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Makes a new code and closes any open one. */
  issue(): { code: string; expiresAt: number } {
    const code = randomBytes(16).toString("base64url");
    const expiresAt = this.now() + CODE_LIFE_MS;
    // Wrong tries are kept across codes, so making a new code does not give a guesser fresh tries.
    this.open = { digest: digest(code), expiresAt, used: false };
    return { code, expiresAt };
  }

  /** Closes the open code without making a new one. */
  close(): void {
    this.open = undefined;
  }

  /** When the open code runs out, or undefined when none is open (used, run out, closed). */
  openUntil(): number | undefined {
    const o = this.open;
    return o && !o.used && o.expiresAt > this.now() ? o.expiresAt : undefined;
  }

  /** Tries a code from one address. "paired" happens once per code. */
  redeem(code: unknown, address: string): Redeemed {
    const now = this.now();
    this.failures = this.failures.filter((f) => now - f.at < TRY_WINDOW_MS);
    if (this.failures.filter((f) => f.address === address).length >= TRIES_PER_ADDRESS) return "limited";
    const o = this.open;
    const given = typeof code === "string" && code.length <= 64 ? digest(code) : undefined;
    const match = !!o && !!given && timingSafeEqual(o.digest, given);
    if (match && o.used) return "used";
    if (match && o.expiresAt <= now) return "expired";
    if (match) {
      o.used = true;
      return "paired";
    }
    this.failures.push({ address, at: now });
    if (this.failures.length > REMEMBERED) this.failures.splice(0, this.failures.length - REMEMBERED);
    return "wrong";
  }
}
