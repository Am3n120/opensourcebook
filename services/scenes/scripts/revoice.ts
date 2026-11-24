/**
 * Voices a finished job again with the voice this computer is set to (ElevenLabs when its key is set), builds every
 * scene on the new word times and renders it, into a copy of the job's folder; the job itself is not touched. It also
 * says how far each scene's words moved from the times the scenes were written on, which is how far the pictures were
 * from the voice before.
 *
 *   node --experimental-strip-types scripts/revoice.ts <job folder> [<out folder>]
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { useChrome } from "../src/chrome.ts";
import { carryOldNames } from "../src/old-names.ts";
import { closeRenderer } from "../pipeline/stages/scene.ts";
import { finalBuild, renderVideo, voiceAll } from "../src/produce.ts";
import { listStyles } from "../src/styles.ts";
import type { Draft, ToolContext } from "../src/tools.ts";
import { voiceFromEnv } from "../src/voice.ts";

const envFile = join(import.meta.dirname, "..", ".env");
if (existsSync(envFile)) {
  const shell = { ...process.env };
  process.loadEnvFile(envFile);
  Object.assign(process.env, shell);
}
carryOldNames();
const [from, to] = process.argv.slice(2);
if (!from) {
  console.error("usage: scripts/revoice.ts <job folder> [<out folder>]");
  process.exit(1);
}
const source = resolve(from);
const folder = resolve(to ?? `${source}-revoiced`);
cpSync(source, folder, { recursive: true, filter: (p) => !p.endsWith(".mp4") });
useChrome();
const job = JSON.parse(readFileSync(join(folder, "job.json"), "utf8"));
const draft = JSON.parse(readFileSync(join(folder, "draft.json"), "utf8")) as Draft;
const before = structuredClone(draft.timings);
const voice = voiceFromEnv(process.env, join(resolve(source, ".."), ".voice"));
const ctx: ToolContext = {
  request: job.request,
  draft,
  folder,
  styles: listStyles(),
  voice,
  step: () => undefined,
  save: () => writeFileSync(join(folder, "draft.json"), JSON.stringify(draft, null, 1)),
};
// Every scene is spoken again by this voice.
for (const t of Object.values(draft.timings)) delete t.sound;
console.log(`voice: ${voice.label}`);
const spoken = await voiceAll(ctx);
const lines: string[] = [];
for (const s of draft.script!.scenes) {
  const old = before[s.id]?.timing.words ?? [];
  const now = draft.timings[s.id]!.timing.words;
  const moved = now.map((w, i) => Math.abs(w.start - (old[i]?.start ?? w.start)));
  const worst = moved.indexOf(Math.max(...moved));
  lines.push(`${s.id}: ${before[s.id]?.timing.seconds.toFixed(1)} s -> ${draft.timings[s.id]!.timing.seconds.toFixed(1)} s; words moved ${(moved.reduce((a, b) => a + b, 0) / Math.max(1, moved.length)).toFixed(2)} s on average, most at @${worst} "${now[worst]?.text}" (${moved[worst]?.toFixed(2)} s)`);
}
console.log(lines.join("\n"));
const { placed, broken } = await finalBuild(ctx, spoken);
if (Object.keys(broken).length) console.log(`scenes that no longer build on the new times: ${JSON.stringify(broken).slice(0, 800)}`);
const out = await renderVideo(ctx, placed, spoken, () => undefined);
await closeRenderer();
writeFileSync(join(folder, "revoice.txt"), `${voice.label}\n${lines.join("\n")}\n`);
console.log(`${out.path}: ${(out.durationMs / 1000).toFixed(1)} s${out.sound ? `, ${out.sound.lufs} LUFS` : ""}`);
