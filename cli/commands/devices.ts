/**
 * The devices paired to use Open Sourcebook from the home network (phone.ts, devices.ts). Listing and removing read
 * `.opensourcebook/devices.json` directly, so they work whether Open Sourcebook is running or not; pairing asks the running launcher for a
 * new code. `npm run devices` is `opensourcebook devices`, which lists them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceStore } from "../devices.ts";
import { DEVICES_FILE, type PhoneStatus } from "../phone.ts";
import { encodeQr, terminalQr } from "../qr.ts";
import { Problem, type Ctx, type Group } from "./table.ts";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const store = (ctx: Ctx) => new DeviceStore(join(ctx.home, DEVICES_FILE));
/** What turns the phone on: said in the app's own terms first, then as a command. */
const START_PHONE = 'In Open Sourcebook on this computer, go to Settings and turn on "Open on your phone" (or start it with "opensourcebook start --phone")';

function readJson<T>(file: string): T | undefined {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
  } catch {
    return undefined;
  }
}

export const devices: Group = {
  thing: "device",
  aliases: ["devices"],
  about: "the phones and other devices paired to use Open Sourcebook on the home network",
  default: "list",
  commands: [
    {
      thing: "device",
      action: "list",
      summary: "the paired devices, with when each paired and was last seen",
      shape: "{ devices: [{ id, name, pairedAt, lastSeenAt }] }",
      async run(ctx) {
        const list = store(ctx).list();
        if (!list.length) return { data: { devices: [] }, text: `No devices are paired. To pair a phone: ${START_PHONE.charAt(0).toLowerCase()}${START_PHONE.slice(1)}, then scan the code it shows with the phone's camera.` };
        const text = [`${list.length} paired device${list.length === 1 ? "" : "s"}:`, ...list.map((d) => `  ${d.id}  ${d.name}, paired ${when(d.pairedAt)}, last seen ${when(d.lastSeenAt)}`), 'Unpair one with "opensourcebook device remove <id>".'];
        return { data: { devices: list }, text: text.join("\n") };
      },
    },
    {
      thing: "device",
      action: "remove",
      summary: "unpair a device; its cookie stops working at once, in a running Open Sourcebook too",
      args: [{ name: "device", help: "the device's id (\"opensourcebook device list\" shows them)" }],
      shape: "{ removed: string }",
      async run(ctx) {
        const id = ctx.args.device!;
        if (!store(ctx).remove(id)) throw new Problem("not_found", `No paired device has the id ${id}; "opensourcebook device list" shows them.`);
        return { data: { removed: id }, text: `Unpaired ${id}. It sees only the pairing page now.` };
      },
    },
    {
      thing: "device",
      action: "pair",
      summary: "show a new pairing code in this terminal (Open Sourcebook must be running with the phone on)",
      shape: "{ url: string, address?: string }",
      async run(ctx) {
        const running = readJson<{ ports?: Record<string, number> }>(join(ctx.home, "running.json"));
        const secrets = readJson<{ PHONE_TOKEN?: string }>(join(ctx.home, "secrets.json"));
        const port = running?.ports?.["phone-control"];
        if (!port || !secrets?.PHONE_TOKEN) throw new Problem("not_running", `Open Sourcebook is not running. Start it first. ${START_PHONE}.`);
        let status: PhoneStatus & { message?: string };
        let ok: boolean;
        try {
          const answer = await fetch(`http://127.0.0.1:${port}/phone/code`, { method: "POST", headers: { "x-phone-token": secrets.PHONE_TOKEN } });
          ok = answer.ok;
          status = (await answer.json()) as PhoneStatus & { message?: string };
        } catch {
          throw new Problem("not_running", `Open Sourcebook is not answering. Start it again. ${START_PHONE}.`);
        }
        if (!ok || !status.code) throw new Problem("phone_off", status.message ?? `Open on your phone is off. ${START_PHONE}.`);
        const ansi = Boolean(process.stdout.isTTY) && !ctx.env.CI;
        const qr = terminalQr(encodeQr(status.code.url), ansi).map((line) => `  ${line}`);
        return {
          data: { url: status.code.url, ...(status.address ? { address: status.address } : {}) },
          text: [...qr, `  Open Sourcebook on your phone: ${status.address ?? ""}. The code works once, for ten minutes.`].join("\n"),
        };
      },
    },
  ],
};
