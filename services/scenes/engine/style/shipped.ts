// The fonts in services/scenes/fonts/, read from disk (Node only). Each folder is one family with a font.json; adding a
// family is adding a folder. See fonts.ts for what a style may do with them.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkFamily, type FaceToLoad, facesToLoad, type FontBook } from "./fonts.ts";

export const FONTS_DIR = resolve(import.meta.dirname, "../../fonts");

let book: FontBook | undefined;

// Every family in the folder, checked: a broken font.json, a missing file or a licence that is not open stops here.
export function readFontBook(dir: string = FONTS_DIR): FontBook {
  const families = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((folder) => {
      const meta = join(dir, folder, "font.json");
      if (!existsSync(meta)) throw new Error(`fonts/${folder} has no font.json`);
      return checkFamily(JSON.parse(readFileSync(meta, "utf8")), folder, (file) => existsSync(join(dir, folder, file)));
    });
  const seen = new Set<string>();
  for (const f of families) {
    if (seen.has(f.family.toLowerCase())) throw new Error(`fonts: two folders name the family "${f.family}"`);
    seen.add(f.family.toLowerCase());
  }
  return { families };
}

export function fontBook(): FontBook {
  return (book ??= readFontBook());
}

export const fontFile = (folder: string, file: string) => join(FONTS_DIR, folder, file);

// Every face with a file:// address, for a page opened from disk (the measuring page).
export function facesOnDisk(b: FontBook = fontBook()): FaceToLoad[] {
  return facesToLoad(b, (f, file) => pathToFileURL(fontFile(f.folder, file)).href);
}

let key: string | undefined;
// Changes whenever a font file or font.json changes, so measurements cached on disk are never from older files.
export function fontsKey(): string {
  if (key) return key;
  const h = createHash("sha256");
  for (const f of fontBook().families) {
    h.update(JSON.stringify(f));
    for (const face of f.faces) {
      const path = fontFile(f.folder, face.file);
      h.update(`${face.file}\0${statSync(path).size}\0`);
      h.update(readFileSync(path));
    }
  }
  return (key = h.digest("hex").slice(0, 16));
}
