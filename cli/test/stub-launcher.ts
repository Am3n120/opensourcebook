// The launcher's running part with one stand-in program, for tests (a fixture): node stub-launcher.ts <root> <port>
// Settings in the environment: STUB_EXIT_FIRST (how many starts of the program exit at once), STUB_RESTART_MAX.
import { join } from "node:path";
import type { Program, Wiring } from "../programs.ts";
import { run } from "../runner.ts";

// A Windows program cannot open a network socket without SystemRoot, and finds its temporary folder by TEMP and TMP.
const windowsBasics = process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {};
const [root, portText] = process.argv.slice(2) as [string, string];
const port = Number(portText);
const stub: Program = {
  id: "stub",
  label: "Stub program",
  about: "a stand-in for the test",
  dir: ".",
  port,
  readyWithinMs: 10_000,
  start: () => ({ args: [join(import.meta.dirname, "stub-program.ts")], env: { STUB_PORT: String(port), STUB_COUNTER: join(root, "starts.txt"), STUB_EXIT_FIRST: process.env.STUB_EXIT_FIRST ?? "0" } }),
  health: () => ({ path: "/up" }),
};
const w: Wiring = { root, home: join(root, ".opensourcebook"), ports: { stub: port }, secrets: {} as Wiring["secrets"], env: { PATH: process.env.PATH, ...windowsBasics } };
await run(w, { open: false }, [stub], { max: Number(process.env.STUB_RESTART_MAX ?? 3), windowMs: 60_000, backoffMs: [100] }, "stub");
