// Asks a running scenes service for a video from an example file (examples/*.json), prints each step as it happens,
// and saves the mp4. Run with SCENES_TOKEN set: node --experimental-strip-types scripts/try-video.ts examples/x.json [out.mp4] [id]
import { readFileSync, writeFileSync } from "node:fs";

const [file, out = "video.mp4", given] = process.argv.slice(2);
if (!file) throw new Error("Usage: try-video.ts <example.json> [out.mp4] [id]");
const base = process.env.SCENES_URL ?? `http://127.0.0.1:${process.env.SCENES_PORT ?? 8670}`;
const headers = { authorization: `Bearer ${process.env.SCENES_TOKEN ?? ""}`, "content-type": "application/json" };
const example = JSON.parse(readFileSync(file, "utf8"));
const id = given ?? `try-${Date.now().toString(36)}`;
const started = await fetch(`${base}/videos`, { method: "POST", headers, body: JSON.stringify({ id, frame: { width: 1080, height: 1920 }, ...example }) });
if (started.status !== 202) throw new Error(`start: ${started.status} ${await started.text()}`);
console.log(`${new Date().toISOString()} started ${id}`);
let seen = 0;
const t0 = Date.now();
for (;;) {
  const job = (await (await fetch(`${base}/videos/${id}`, { headers })).json()) as { state: string; progress: number; steps: { label: string; at: string }[]; failure?: unknown; result?: unknown };
  for (const s of job.steps.slice(seen)) console.log(`${s.at} ${s.label} (${Math.round(job.progress * 100)}%)`);
  seen = job.steps.length;
  if (job.state === "done") {
    writeFileSync(out, Buffer.from(await (await fetch(`${base}/videos/${id}/file`, { headers })).arrayBuffer()));
    console.log(`done in ${((Date.now() - t0) / 60_000).toFixed(1)} min: ${out}`);
    console.log(JSON.stringify(job.result, null, 1));
    break;
  }
  if (job.state === "failed" || job.state === "stopped") {
    console.log(`${job.state}: ${JSON.stringify(job.failure)}`);
    process.exitCode = 1;
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
