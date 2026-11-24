/**
 * The devices paired to use Open Sourcebook from the home network (a phone, a tablet), kept in `.opensourcebook/devices.json`.
 *
 * Pairing gives a device a long random token, which it keeps in a cookie its scripts cannot read. This file holds
 * only a SHA-256 hash of each token, so reading it does not let anyone act as a device. A token is checked against
 * every stored hash with a constant-time comparison. The file is read again when it changes on disk, so removing a
 * device with `opensourcebook devices remove` takes effect at once in a running Open Sourcebook.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writePrivate } from "./secrets.ts";

export interface Device {
  id: string;
  /** What it is, read from its browser when it paired ("iPhone, Safari"). */
  name: string;
  pairedAt: string;
  lastSeenAt: string;
}

interface Stored extends Device {
  tokenHash: string;
}

/** A device as anyone outside this file sees it: never its token hash. */
const shown = ({ tokenHash: _hash, ...device }: Stored): Device => device;

const hash = (token: string) => createHash("sha256").update(token, "utf8").digest();

/** How often a device's "last seen" time is written to disk at most. */
const SEEN_EVERY_MS = 60_000;
/** A device not seen for this long must pair again (the door's cookie lasts as long, from the last page opened). */
export const IDLE_LIMIT_MS = 30 * 24 * 60 * 60_000;

export class DeviceStore {
  private devices: Stored[] = [];
  private mtime = -1;
  private readonly file: string;
  private readonly now: () => Date;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.file = file;
    this.now = now;
    this.reload();
  }

  /** Reads the file again when it changed on disk since the last read. */
  private reload(): void {
    const mtime = existsSync(this.file) ? statSync(this.file).mtimeMs : 0;
    if (mtime === this.mtime) return;
    this.mtime = mtime;
    if (!mtime) {
      this.devices = [];
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { devices?: unknown };
      this.devices = Array.isArray(parsed.devices) ? parsed.devices.filter(isStored) : [];
    } catch {
      // A file that cannot be read pairs nothing: every device pairs again, which is the safe way to fail.
      this.devices = [];
    }
  }

  private save(): void {
    writePrivate(this.file, `${JSON.stringify({ devices: this.devices }, null, 2)}\n`);
    this.mtime = statSync(this.file).mtimeMs;
  }

  list(): Device[] {
    this.reload();
    return this.devices.map(shown);
  }

  /** Pairs a new device. The token is returned once, to go in its cookie, and is never stored. */
  add(name: string): { device: Device; token: string } {
    this.reload();
    const token = randomBytes(32).toString("base64url");
    const at = this.now().toISOString();
    const device: Stored = { id: randomBytes(6).toString("hex"), name: name.slice(0, 80) || "A device", pairedAt: at, lastSeenAt: at, tokenHash: hash(token).toString("hex") };
    this.devices.push(device);
    this.save();
    return { device: shown(device), token };
  }

  /**
   * The device a token belongs to, or undefined. Every stored hash is compared, each in constant time, so the time
   * taken says nothing about how close a guess was or which device matched.
   */
  find(token: string | undefined): Device | undefined {
    this.reload();
    if (!token || token.length > 200) return undefined;
    const given = hash(token);
    let found: Stored | undefined;
    for (const device of this.devices) {
      const stored = Buffer.from(device.tokenHash, "hex");
      if (stored.length === given.length && timingSafeEqual(stored, given) && !found) found = device;
    }
    if (!found) return undefined;
    const now = this.now();
    // A device unused for as long as its cookie lasts is no longer paired, even if its token is still somewhere.
    if (now.getTime() - Date.parse(found.lastSeenAt) > IDLE_LIMIT_MS) return undefined;
    if (now.getTime() - Date.parse(found.lastSeenAt) > SEEN_EVERY_MS) {
      found.lastSeenAt = now.toISOString();
      this.save();
    }
    return shown(found);
  }

  /** Unpairs a device: its cookie stops working at once. False when there is no such device. */
  remove(id: string): boolean {
    this.reload();
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }
}

function isStored(value: unknown): value is Stored {
  const d = value as Partial<Stored> | null;
  return !!d && typeof d.id === "string" && typeof d.name === "string" && typeof d.tokenHash === "string" && /^[0-9a-f]{64}$/.test(d.tokenHash) && typeof d.pairedAt === "string" && typeof d.lastSeenAt === "string";
}

/** A short name for a device from its browser's user agent: what it is, then which browser. */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const kind = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet") : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows computer" : /Linux/.test(ua) ? "Linux computer" : "A device";
  const browser = /EdgA?\//.test(ua) ? "Edge" : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : undefined;
  return browser ? `${kind}, ${browser}` : kind;
}
