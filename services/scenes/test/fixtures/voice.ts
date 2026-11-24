/**
 * A stand-in for the ElevenLabs call, so the voice's own code (cutting, placing, timing, caching) runs for real with no
 * account: a tone for the words with quiet on either side, and character times spread evenly over the tone.
 */
import { execFileSync } from "node:child_process";
import type { Tts } from "../../src/eleven.ts";

export const QUIET_BEFORE = 0.4;
export const QUIET_AFTER = 0.6;

/** What ElevenLabs really answered for a malformed key (Nov 19, 2026, from a real run's log): status 400, not 401. */
export const BAD_KEY_400 = `{"detail":{"type":"authentication_error","code":"invalid_api_key","message":"API key must start with 'sk_'.","status":"invalid_api_key_prefix","request_id":"d7c2ed5c0ceaf87b24b3c925f90249d8","param":"api_key"}}`;

/**
 * Makes every call to ElevenLabs answer `status` with `body`, so the real call and the real check read it; every other
 * address goes through as before. Returns how to put it back, and counts the calls that reached it.
 */
export function elevenAnswers(status: number, body: string): { restore: () => void; calls: string[] } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.elevenlabs.io/")) return real(input, init);
    calls.push(new URL(url).pathname);
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { restore: () => void (globalThis.fetch = real), calls };
}

export function fakeTts(calls: { text: string; previous_text?: string; next_text?: string }[] = []): Tts {
  return async (_voice, req) => {
    calls.push(req);
    const speech = Math.max(0.5, req.text.length * 0.06);
    const mp3 = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=220:duration=${speech}`, "-af", `adelay=${QUIET_BEFORE * 1000},apad=pad_dur=${QUIET_AFTER},volume=0.5`, "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-f", "mp3", "pipe:1"]);
    const characters = [...req.text];
    const step = speech / characters.length;
    // Like ElevenLabs, the last character is stretched to the end of the audio.
    const ends = characters.map((_, i) => (i === characters.length - 1 ? QUIET_BEFORE + speech + QUIET_AFTER : QUIET_BEFORE + (i + 1) * step));
    return { audio: mp3, alignment: { characters, character_start_times_seconds: characters.map((_, i) => QUIET_BEFORE + i * step), character_end_times_seconds: ends } };
  };
}
