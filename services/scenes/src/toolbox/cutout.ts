/**
 * A thing cut out of a picture along its own edge: SAM finds it by a short phrase, and ffmpeg lays its mask over the
 * picture as transparency and crops to it, so the scene can place the thing on its own surface. Masks are worked
 * with ffmpeg alone.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { size } from "./assets.ts";
import type { Mask } from "./meta.ts";

const run = promisify(execFile);
/** SAM is sent pictures this size at most on the long side; its masks come back at most 1024 pixels. */
const SAM_SIDE = 1600;

/** The picture as SAM is sent it: a JPEG at most 1600 pixels on its long side, with its size. */
export async function samCopy(src: string, out: string): Promise<{ jpeg: Buffer; width: number; height: number }> {
  await run("ffmpeg", ["-y", "-v", "error", "-i", src, "-frames:v", "1", "-vf", `scale='min(${SAM_SIDE},iw)':'min(${SAM_SIDE},ih)':force_original_aspect_ratio=decrease,format=yuvj444p`, "-q:v", "3", "-update", "1", out], { timeout: 60_000 });
  const [width, height] = await size(out);
  return { jpeg: readFileSync(out), width, height };
}

/** How much of the picture the mask covers, and its box, as shares of the picture. */
export function coverage(m: Mask, width: number, height: number): { area: number; w: number; h: number } {
  const w = (m.bounds.right - m.bounds.left) / width;
  const h = (m.bounds.bottom - m.bounds.top) / height;
  const on = m.raster.reduce((n, v) => n + (v ? 1 : 0), 0) / Math.max(1, m.raster.length);
  return { area: on * w * h, w, h };
}

/** Writes the masked thing, cropped to its box, as a PNG with a see-through background. */
export async function cutWith(sam: string, width: number, height: number, m: Mask, out: string): Promise<void> {
  const left = Math.max(0, Math.floor(m.bounds.left));
  const top = Math.max(0, Math.floor(m.bounds.top));
  const bw = Math.max(2, Math.min(width - left, Math.ceil(m.bounds.right) - left));
  const bh = Math.max(2, Math.min(height - top, Math.ceil(m.bounds.bottom) - top));
  const pgm = `${out}.mask.pgm`;
  writeFileSync(pgm, Buffer.concat([Buffer.from(`P5\n${m.width} ${m.height}\n255\n`), Buffer.from(m.raster.map((v) => (v ? 255 : 0)))]));
  const filter = `[1:v]scale=${bw}:${bh}:flags=bilinear,format=gray[m];[0:v]crop=${bw}:${bh}:${left}:${top},format=rgba[i];[i][m]alphamerge[o]`;
  await run("ffmpeg", ["-y", "-v", "error", "-i", sam, "-i", pgm, "-filter_complex", filter, "-map", "[o]", "-frames:v", "1", "-update", "1", out], { timeout: 60_000 });
}

/** A cut-out shown on a mid grey, so the agent sees its edge. */
export async function onGrey(png: string, out: string): Promise<void> {
  await run("ffmpeg", ["-y", "-v", "error", "-i", png, "-filter_complex", "color=c=0x808080:s=16x16[bg];[bg][0:v]scale2ref[bg2][fg];[bg2][fg]overlay=format=auto,scale='min(512,iw)':-2", "-frames:v", "1", "-q:v", "4", "-update", "1", out], { timeout: 60_000 });
}
