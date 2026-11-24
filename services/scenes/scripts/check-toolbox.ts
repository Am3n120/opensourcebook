/**
 * Checks the video agent's toolbox against the live services, with this computer's keys:
 * `npm run check-toolbox [folder]` (reads .env like `npm start`).
 *
 * It calls the tools the way the agent does (web search, a page, the archives, keeping a picture, Muse Image with and
 * without a reference, a SAM cut-out) and prints, for each, whether it worked, how long it took and the start of its
 * answer. The pictures it keeps are left in `folder/assets` (a new temporary folder when none is given) to look at.
 * It never prints a key.
 */
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_LIMITS } from "../src/script.ts";
import { listStyles } from "../src/styles.ts";
import { callTool, emptyDraft, type ToolContext } from "../src/tools.ts";
import { toolboxFromEnv } from "../src/toolbox/index.ts";
import { boxTools } from "../src/toolbox/tools.ts";
import { silentVoice } from "../src/voice.ts";
import { passages } from "../test/fixtures/scenes.ts";

const folder = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "opensourcebook-toolbox-check-"));
mkdirSync(folder, { recursive: true });
const toolbox = toolboxFromEnv(process.env);
console.log(`Keys: META_API_KEY ${process.env.META_API_KEY?.trim() ? "set" : "missing"}, META_BASE_URL ${process.env.META_BASE_URL?.trim() ? "set" : "default"}`);
console.log(`Tools offered: ${boxTools(toolbox).map((t) => t.name).join(", ")}`);
console.log(`Chrome: ${toolbox.chrome ? "found" : "missing (npm run browser fetches it)"}, yt-dlp: ${toolbox.ytdlp ? "found" : "missing"}\n`);

const ctx: ToolContext = {
  request: { id: "check", title: "Toolbox check", brief: "a check of the toolbox", assumes: [], frame: { width: 1080, height: 1920 }, targetSeconds: 12, style: "chalkboard", passages, limits: DEFAULT_LIMITS },
  draft: emptyDraft(),
  folder,
  styles: listStyles(),
  voice: silentVoice(),
  step: () => undefined,
  save: () => undefined,
  toolbox,
};

let failed = 0;
async function call(name: string, input: Record<string, unknown>): Promise<string> {
  const t0 = Date.now();
  const answer = await callTool(name, input, ctx);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  if (answer.isError) failed++;
  const text = answer.text.replace(/\s+/g, " ").slice(0, 400);
  console.log(`${answer.isError ? "FAIL" : "OK  "}  ${name} (${seconds}s${answer.images?.length ? `, ${answer.images.length} picture(s) shown` : ""})\n      ${text}\n`);
  return answer.text;
}

const found = await call("web_search", { query: "how does a lever lift a heavy load" });
const page = /https?:\/\/[^\s)\]]+/.exec(found)?.[0];
if (page) await call("open_page", { url: page });
const archives = await call("find_images", { query: "honeybee on a flower", n: 1 });
const id = /\bc\d+\b/.exec(archives)?.[0];
if (id) await call("save_image", { from: id, name: "bee_photo", about: "a honeybee on a flower" });
await call("generate_image", { prompt: "A single ripe red apple on a plain light grey background, soft studio light from the left, photographic, no text.", name: "apple", shape: "square" });
await call("generate_image", { prompt: "The same apple cut cleanly in half, both halves side by side on the same plain light grey background, same light, no text.", name: "apple_halves", shape: "square", references: ["apple"] });
await call("cut_out", { asset: "apple", thing: "the apple", name: "apple_cut" });
await call("assets", {});

const kept = (() => {
  try {
    return readdirSync(join(folder, "assets")).filter((f) => !f.startsWith("."));
  } catch {
    return [];
  }
})();
console.log(`Kept in ${join(folder, "assets")}: ${kept.join(", ") || "nothing"}`);
console.log(failed ? `${failed} call(s) failed.` : "Every call worked.");
process.exit(failed ? 1 : 0);
