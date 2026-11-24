// Loads every shipped font into the page that draws a video, before its first frame is taken. Imported once by each
// Remotion entry. The bundler finds the folder's font.json files and font files itself, so a family added to
// services/scenes/fonts/ is drawn without touching this file; nothing is left to the fonts the computer has.
import { cancelRender, continueRender, delayRender } from "remotion";
import { checkFamily, facesToLoad } from "./fonts.ts";

type Context = { keys(): string[]; (id: string): unknown };
declare global {
  interface ImportMeta {
    webpackContext?: (dir: string, o: { recursive: boolean; regExp: RegExp }) => Context;
  }
}

function shippedFaces() {
  const meta = import.meta.webpackContext!("../../fonts", { recursive: true, regExp: /font\.json$/ });
  const files = import.meta.webpackContext!("../../fonts", { recursive: true, regExp: /\.(ttf|otf|woff2?)$/ });
  const known = new Set(files.keys());
  const families = meta.keys().map((key) => {
    const folder = key.split("/").slice(-2, -1)[0]!;
    const raw = meta(key) as Record<string, unknown>;
    // Licence files are checked on disk when a style is resolved; here only the fonts are loaded.
    return checkFamily(raw, folder, (file) => known.has(`./${folder}/${file}`) || /\.(txt|md)$/i.test(file));
  });
  const url = (folder: string, file: string) => {
    const v = files(`./${folder}/${file}`);
    return typeof v === "string" ? v : (v as { default: string }).default;
  };
  return facesToLoad({ families }, (f, file) => url(f.folder, file));
}

/**
 * One face, asked for again a few times when its request fails: every font is fetched from the local server on each
 * page, and a busy computer (Windows most of all) now and then drops one of those connections.
 */
async function loadFace(f: ReturnType<typeof shippedFaces>[number]): Promise<FontFace> {
  const waits = [250, 1_000, 2_500];
  for (let attempt = 0; ; attempt++) {
    try {
      return await new FontFace(f.family, `url(${JSON.stringify(f.url)})`, f.descriptors).load();
    } catch (e) {
      if (attempt >= waits.length) throw e;
      await new Promise((r) => setTimeout(r, waits[attempt]));
    }
  }
}

const handle = delayRender("loading the shipped fonts");
Promise.all(
  shippedFaces().map(async (f) => {
    document.fonts.add(await loadFace(f));
  }),
).then(
  () => continueRender(handle),
  (e) => cancelRender(new Error(`a shipped font did not load: ${(e as Error).message}`)),
);
