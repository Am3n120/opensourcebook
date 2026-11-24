import type { IsReadable } from "./fileTypes";

/** Files found in a drop or a folder pick, and how many were left out as unreadable. */
export interface Found {
  files: File[];
  skipped: number;
}

/** What a drop held: files and folders, or a web address or text. */
export interface DroppedContent extends Found {
  text?: string;
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(out);
        out.push(...batch);
        next();
      }, reject);
    next();
  });
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, found: Found, inFolder: boolean, readable: () => Promise<IsReadable>): Promise<void> {
  if (entry.isFile) {
    const file = await fileOf(entry as FileSystemFileEntry);
    // A file dropped by itself is always taken; one found inside a folder must be of a type the engine takes.
    if (!inFolder || (await readable())(file.name)) {
      if (inFolder) Object.defineProperty(file, "webkitRelativePath", { value: entry.fullPath.replace(/^\//, ""), configurable: true });
      found.files.push(file);
    } else found.skipped += 1;
    return;
  }
  if (entry.isDirectory) {
    for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) await walk(child, found, true, readable);
  }
}

/** The files a folder pick returned (`webkitdirectory`), unreadable ones counted and left out. */
export function fromFolderPick(list: FileList | File[], isReadable: IsReadable): Found {
  const found: Found = { files: [], skipped: 0 };
  for (const file of Array.from(list)) {
    if (isReadable(file.name)) found.files.push(file);
    else found.skipped += 1;
  }
  return found;
}

/**
 * Everything a drop carries: files, whole folders (walked), or else a pasted
 * address or text. `readable` is asked only when a folder is walked.
 */
export async function fromDataTransfer(dt: DataTransfer, readable: () => Promise<IsReadable>): Promise<DroppedContent> {
  const found: DroppedContent = { files: [], skipped: 0 };
  // The entries must all be taken before the first await: the browser empties the drop afterwards.
  const entries = Array.from(dt.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null));
  if (entries.length > 0 && entries.every((e) => e)) {
    for (const entry of entries) await walk(entry!, found, false, readable);
  } else {
    found.files.push(...Array.from(dt.files ?? []));
  }
  if (found.files.length === 0 && found.skipped === 0) {
    const raw = dt.getData("text/uri-list") || dt.getData("text/plain");
    if (raw.trim()) found.text = raw;
  }
  return found;
}
