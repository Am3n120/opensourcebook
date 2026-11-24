/**
 * How long an uploaded audio file plays, from its own header (src/extract/audio-length.ts), and the source's length
 * that comes of it (sources/detail.ts).
 */
import { describe, expect, it } from "vitest";
import { AssetStore } from "../src/assets";
import { extractAudioModule } from "../src/extract/audio";
import { audioLengthMs, runningTime } from "../src/extract/audio-length";
import { sourceDetail } from "../src/sources/detail";
import { FakeR2Bucket } from "./support/fake-r2";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

/** A WAV header for `seconds` of 16-bit mono at 8 kHz, with its data. */
function wav(seconds: number): Uint8Array {
  const byteRate = 16_000;
  const data = byteRate * seconds;
  const fmt = [...ascii("fmt "), ...le32(16), 1, 0, 1, 0, ...le32(8_000), ...le32(byteRate), 2, 0, 16, 0];
  return new Uint8Array([...ascii("RIFF"), ...le32(4 + fmt.length + 8 + data), ...ascii("WAVE"), ...fmt, ...ascii("data"), ...le32(data), ...new Array(data).fill(0)]);
}

function box(type: string, body: number[]): number[] {
  return [...be32(8 + body.length), ...ascii(type), ...body];
}

/** An M4A with a version 0 movie header: `duration` units at `scale` a second. */
function m4a(scale: number, duration: number): Uint8Array {
  const mvhd = box("mvhd", [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(scale), ...be32(duration), ...new Array(80).fill(0)]);
  return new Uint8Array([...box("ftyp", [...ascii("M4A "), ...be32(0)]), ...box("free", [1, 2, 3]), ...box("moov", mvhd)]);
}

function flac(rate: number, samples: number): Uint8Array {
  const info = new Array(34).fill(0);
  info[10] = (rate >> 12) & 255;
  info[11] = (rate >> 4) & 255;
  info[12] = ((rate & 15) << 4) | (0 << 1);
  info[13] = Math.floor(samples / 2 ** 32) & 15;
  info.splice(14, 4, ...be32(samples >>> 0));
  return new Uint8Array([...ascii("fLaC"), 0, 0, 0, 34, ...info]);
}

function oggPage(granule: number, packet: number[]): number[] {
  return [...ascii("OggS"), 0, 0, ...le32(granule), ...le32(0), ...le32(1), ...le32(0), ...le32(0), 1, packet.length, ...packet];
}

function opus(seconds: number): Uint8Array {
  return new Uint8Array([...oggPage(0, [...ascii("OpusHead"), 1, 1, 0, 0, ...le32(48_000), 0, 0, 0]), ...oggPage(0, ascii("OpusTags")), ...oggPage(48_000 * seconds, [1, 2, 3])]);
}

/** An MP3 at one rate all through: MPEG 1 layer 3, 128 kbps, 44.1 kHz, with an ID3 tag first. */
function mp3(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes + 20);
  out.set([...ascii("ID3"), 4, 0, 0, 0, 0, 0, 10]);
  out.set([0xff, 0xfb, 0x90, 0x00], 20);
  return out;
}

describe("audio length from the file's own header", () => {
  it("reads WAV, M4A, FLAC, Ogg Opus and a constant-rate MP3", () => {
    expect(audioLengthMs(wav(3))).toBe(3000);
    expect(audioLengthMs(m4a(44_100, 44_100 * 125))).toBe(125_000);
    expect(audioLengthMs(flac(48_000, 48_000 * 61))).toBe(61_000);
    expect(audioLengthMs(opus(42))).toBe(42_000);
    // 16,000 bytes of frames at 128 kbps is one second.
    expect(audioLengthMs(mp3(16_000))).toBe(1000);
  });

  it("says nothing for what it cannot read", () => {
    expect(audioLengthMs(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(audioLengthMs(new TextEncoder().encode("<html>not audio</html>"))).toBeUndefined();
    expect(audioLengthMs(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]))).toBeUndefined();
  });

  it("writes a running time as a reading keeps one", () => {
    expect(runningTime(65_000)).toBe("1:05");
    expect(runningTime(3_725_000)).toBe("1:02:05");
    expect(runningTime(400)).toBe("0:01");
  });

  it("gives an uploaded audio file its length as its source's detail", async () => {
    const bytes = m4a(1000, 185_000);
    const result = await extractAudioModule({
      bytes: bytes.buffer.slice(0) as ArrayBuffer,
      contentType: "audio/mp4",
      sourceText: "",
      fetchImpl: async () => new Response(null, { status: 404 }),
      assetStore: new AssetStore(new FakeR2Bucket()),
      timeoutMs: 1000,
      maxBytes: 10_000_000,
      maxTextChars: 10_000,
    });
    expect(result?.metadata?.durationText).toBe("3:05");
    expect(sourceDetail(result?.metadata)).toEqual({ count: 3, unit: "min" });
  });
});
