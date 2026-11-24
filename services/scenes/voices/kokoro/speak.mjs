// Kokoro's own process (src/kokoro.ts starts it): it loads the model once and speaks each phrase it is sent to a WAV
// file. It runs apart from the scenes service so the model's memory and its speech code never touch the service's own.
// Each message is { n, text, voice, speed, file }; each answer is { n } or { n, error }.
import { writeFile } from "node:fs/promises";
import { KokoroTTS } from "kokoro-js";

const [model, dtype] = process.argv.slice(2);
let tts;
let queue = Promise.resolve();

process.on("message", (m) => {
  queue = queue.then(async () => {
    try {
      tts ??= await KokoroTTS.from_pretrained(model, { dtype, device: "cpu" });
      if (!(m.voice in tts.voices)) throw new Error(`Kokoro has no voice "${m.voice}". Its voices: ${Object.keys(tts.voices).join(", ")}.`);
      const audio = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
      await writeFile(m.file, Buffer.from(audio.toWav()));
      process.send({ n: m.n });
    } catch (error) {
      process.send({ n: m.n, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
process.on("disconnect", () => process.exit(0));
