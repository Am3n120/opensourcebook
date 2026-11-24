/**
 * How long an audio file plays, read from the file's own header: nothing is
 * decoded and nothing is added to read it. WAV (its byte rate and data
 * size), MP3 (a Xing, Info or VBRI frame count, else the first frame's
 * bitrate over the file's size), MP4 and M4A (the movie header's time scale
 * and duration), FLAC (its stream info) and Ogg (the last page's granule
 * position, at the Vorbis rate or 48 kHz for Opus). Undefined for anything
 * else, or a header that does not say.
 */

/** The length in milliseconds, or undefined when the header does not say. */
export function audioLengthMs(bytes: Uint8Array): number | undefined {
  try {
    const ms = wav(bytes) ?? mp4(bytes) ?? flac(bytes) ?? ogg(bytes) ?? mp3(bytes);
    return ms !== undefined && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined;
  } catch {
    return undefined;
  }
}

/** A length as a running time, `m:ss` or `h:mm:ss`, the way a reading keeps one (`metadata.durationText`). */
export function runningTime(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u32le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16) + ((b[at + 3]! << 24) >>> 0);

function wav(b: Uint8Array): number | undefined {
  if (b.length < 12 || text(b, 0, 4) !== "RIFF" || text(b, 8, 4) !== "WAVE") return undefined;
  let byteRate: number | undefined;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = text(b, at, 4);
    const size = u32le(b, at + 4);
    if (id === "fmt " && at + 20 <= b.length) byteRate = u32le(b, at + 16);
    if (id === "data") {
      // A header written before the length was known says 0 or the largest size: what follows is the data.
      const data = size === 0 || size === 0xffffffff ? b.length - at - 8 : Math.min(size, b.length - at - 8);
      return byteRate ? (data / byteRate) * 1000 : undefined;
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

function mp4(b: Uint8Array): number | undefined {
  if (b.length < 8 || text(b, 4, 4) !== "ftyp") return undefined;
  const box = (from: number, to: number, want: string): { at: number; end: number } | undefined => {
    for (let at = from; at + 8 <= to; ) {
      let size = u32be(b, at);
      let head = 8;
      if (size === 1 && at + 16 <= to) {
        size = u32be(b, at + 8) * 2 ** 32 + u32be(b, at + 12);
        head = 16;
      } else if (size === 0) size = to - at;
      if (size < head) return undefined;
      if (text(b, at + 4, 4) === want) return { at: at + head, end: Math.min(to, at + size) };
      at += size;
    }
    return undefined;
  };
  const moov = box(0, b.length, "moov");
  const mvhd = moov ? box(moov.at, moov.end, "mvhd") : undefined;
  if (!mvhd) return undefined;
  const v1 = b[mvhd.at] === 1;
  const scale = u32be(b, mvhd.at + (v1 ? 20 : 12));
  const duration = v1 ? u32be(b, mvhd.at + 24) * 2 ** 32 + u32be(b, mvhd.at + 28) : u32be(b, mvhd.at + 16);
  return scale > 0 ? (duration / scale) * 1000 : undefined;
}

function flac(b: Uint8Array): number | undefined {
  if (b.length < 42 || text(b, 0, 4) !== "fLaC" || (b[4]! & 0x7f) !== 0) return undefined;
  const info = 8;
  const rate = (b[info + 10]! << 12) | (b[info + 11]! << 4) | (b[info + 12]! >> 4);
  const samples = (b[info + 13]! & 0x0f) * 2 ** 32 + u32be(b, info + 14);
  return rate > 0 && samples > 0 ? (samples / rate) * 1000 : undefined;
}

function ogg(b: Uint8Array): number | undefined {
  if (b.length < 28 || text(b, 0, 4) !== "OggS") return undefined;
  const first = 27 + b[26]!;
  const rate = text(b, first, 8) === "OpusHead" ? 48_000 : text(b, first + 1, 6) === "vorbis" ? u32le(b, first + 12) : undefined;
  if (!rate) return undefined;
  for (let at = b.length - 14; at >= 0; at--) {
    if (b[at] === 0x4f && text(b, at, 4) === "OggS") {
      const granule = u32le(b, at + 6) + u32le(b, at + 10) * 2 ** 32;
      return granule > 0 ? (granule / rate) * 1000 : undefined;
    }
  }
  return undefined;
}

const BITRATES: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, number[]> = { 1: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 2.5: [11_025, 12_000, 8_000] };

function mp3(b: Uint8Array): number | undefined {
  let at = 0;
  // An ID3v2 tag first: its size is four seven-bit bytes.
  if (b.length >= 10 && text(b, 0, 3) === "ID3") at = 10 + ((b[6]! & 0x7f) << 21) + ((b[7]! & 0x7f) << 14) + ((b[8]! & 0x7f) << 7) + (b[9]! & 0x7f);
  for (; at + 4 <= b.length && !(b[at] === 0xff && (b[at + 1]! & 0xe0) === 0xe0); at++) if (at > 64 * 1024) return undefined;
  if (at + 4 > b.length) return undefined;
  const versionBits = (b[at + 1]! >> 3) & 3;
  const layerBits = (b[at + 1]! >> 1) & 3;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : versionBits === 0 ? 2.5 : undefined;
  const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : layerBits === 1 ? 3 : undefined;
  if (!version || !layer) return undefined;
  const rate = RATES[version]![(b[at + 2]! >> 2) & 3];
  const kbps = BITRATES[version === 1 ? `1-${layer}` : layer === 1 ? "2-1" : "2-2"]![b[at + 2]! >> 4];
  if (!rate || !kbps) return undefined;
  const perFrame = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  const mono = b[at + 3]! >> 6 === 3;
  // A frame count, where a variable-rate file keeps one.
  const side = version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const xing = at + 4 + side;
  if (xing + 12 <= b.length && (text(b, xing, 4) === "Xing" || text(b, xing, 4) === "Info") && b[xing + 7]! & 1) return (u32be(b, xing + 8) * perFrame / rate) * 1000;
  const vbri = at + 36;
  if (vbri + 18 <= b.length && text(b, vbri, 4) === "VBRI") return (u32be(b, vbri + 14) * perFrame / rate) * 1000;
  // Otherwise one rate all through.
  return ((b.length - at) * 8) / kbps;
}
