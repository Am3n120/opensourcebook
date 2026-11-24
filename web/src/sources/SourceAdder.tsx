import { useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Icon } from "../design/Icon";
import { useApi } from "../app/context";
import { errorText } from "../api/errors";
import { countFiles, readableFiles } from "./fileTypes";
import { fromDataTransfer, fromFolderPick } from "./dropped";
import { fileEntry, linkEntry, textEntry, type NewEntry } from "./useAddQueue";
import { useNarrow } from "./useNarrow";
import type { QueueEntry } from "./addFiles";
import "./sourceAdder.css";

/** The ways to add something other than a file from this computer. */
export type Tile = "youtube" | "drive" | "link" | "text";

const TILES: ReadonlyArray<{ id: Tile; label: string; short: string; icon: ReactNode }> = [
  {
    id: "youtube",
    label: "YouTube",
    short: "YouTube",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="5" width="20" height="14" rx="4" fill="#FF0033" />
        <path d="M10 9l5 3-5 3z" fill="#FFFFFF" />
      </svg>
    ),
  },
  {
    id: "drive",
    label: "Google Drive",
    short: "Drive",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8.2 3h7.6l6.2 10.6h-7.6z" fill="#FFC107" />
        <path d="M8.2 3L2 13.6l3.8 6.6 6.2-10.6z" fill="#1FA463" />
        <path d="M5.8 20.2h12.4l3.8-6.6H9.6z" fill="#4285F4" />
      </svg>
    ),
  },
  { id: "link", label: "Link", short: "Link", icon: <Icon name="link" /> },
  { id: "text", label: "Paste text", short: "Paste", icon: <Icon name="context" /> },
];

const FIELD: Record<Exclude<Tile, "text">, { label: string; placeholder: string; help?: string; hosts?: RegExp }> = {
  youtube: { label: "YouTube link", placeholder: "https://www.youtube.com/watch?v=…", hosts: /(^|\.)(youtube\.com|youtu\.be)$/i },
  drive: { label: "Google Drive link", placeholder: "https://drive.google.com/…", help: "The file or folder must be shared by link.", hosts: /(^|\.)(drive|docs)\.google\.com$/i },
  link: { label: "Link", placeholder: "https://…" },
};

/** A web address as typed, or nothing when it is not one (or not on the given host). */
function readAddress(value: string, hosts?: RegExp): string | undefined {
  const raw = value.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!url.hostname.includes(".")) return undefined;
    if (hosts && !hosts.test(url.hostname)) return undefined;
    return url.href === raw || `${url.origin}/` === url.href ? raw.replace(/^(?!https?:)/i, "https://") : url.href;
  } catch {
    return undefined;
  }
}

export interface SourceAdderProps {
  /** Called with what was picked, dropped, typed or pasted. */
  onEntries: (entries: NewEntry[]) => void;
  disabled?: boolean;
  /** Opens one of the fields from the start. */
  initial?: Tile;
}

/**
 * The one way to add sources, in a new project and inside one: a big drop
 * area (Choose files, Choose a folder, drop files or folders), then YouTube,
 * Google Drive, a link, or pasted text. It hands back what the person gave;
 * what to do with it (hold it until Create, or add it now) is the caller's.
 */
export function SourceAdder({ onEntries, disabled = false, initial }: SourceAdderProps) {
  const narrow = useNarrow();
  const client = useApi();
  const ids = useId();
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<Tile | undefined>(initial);
  const [value, setValue] = useState("");
  const [title, setTitle] = useState("");
  const [bad, setBad] = useState<string>();
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string>();

  function took(found: { files: File[]; skipped: number }) {
    if (found.files.length > 0) onEntries(found.files.map(fileEntry));
    setNote(found.skipped > 0 ? `Skipped ${countFiles(found.skipped)} Open Sourcebook cannot read.` : found.files.length === 0 ? "Nothing here that Open Sourcebook can read." : undefined);
  }

  function pick(tile: Tile) {
    setOpen(open === tile ? undefined : tile);
    setValue("");
    setTitle("");
    setBad(undefined);
  }

  function submitField() {
    if (!open) return;
    if (open === "text") {
      if (!value.trim()) return;
      onEntries([textEntry(value, title)]);
    } else {
      const spec = FIELD[open];
      const address = readAddress(value, spec.hosts);
      if (!address) {
        setBad(open === "link" ? "That is not a web address." : `That is not a ${open === "youtube" ? "YouTube" : "Google Drive"} link.`);
        return;
      }
      onEntries([linkEntry(address, open)]);
    }
    setOpen(undefined);
    setValue("");
    setTitle("");
    setBad(undefined);
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    if (!disabled) setOver(true);
  }
  function onDragLeave(e: DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
  }
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    let dropped;
    try {
      dropped = await fromDataTransfer(e.dataTransfer, () => readableFiles(client));
    } catch (err) {
      setNote(errorText(err));
      return;
    }
    if (dropped.text !== undefined) {
      const address = readAddress(dropped.text);
      if (address && !/\s/.test(dropped.text.trim())) onEntries([linkEntry(address, /youtu(\.be|be\.com)/i.test(address) ? "youtube" : "link")]);
      else onEntries([textEntry(dropped.text, "")]);
      setNote(undefined);
      return;
    }
    took(dropped);
  }

  const fieldId = `${ids}-field`;
  const spec = open && open !== "text" ? FIELD[open] : undefined;

  return (
    <div className={`sadder${narrow ? " compact" : ""}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={(e) => void onDrop(e)}>
      <div className="sadder-sec">
        <span className="sadder-lbl">{narrow ? "From this phone" : "From this computer"}</span>
        <div className={`sadder-drop${over ? " over" : ""}`}>
          {!narrow && (
            <>
              <span className="sadder-up" aria-hidden="true">
                <Icon name="upload" />
              </span>
              <div className="sadder-txt">
                <b>Drop files or a whole folder here</b>
                <span>PDFs, slides, docs, spreadsheets, images, audio</span>
              </div>
            </>
          )}
          {narrow && <span className="sadder-hint">PDFs, slides, docs, images, audio</span>}
          <div className="sadder-btns">
            <button type="button" className="btn soft" disabled={disabled} onClick={() => files.current?.click()}>
              <Icon name="doc" />
              Choose files
            </button>
            <button type="button" className="btn ghost" disabled={disabled} onClick={() => folder.current?.click()}>
              <Icon name="folder" />
              Choose a folder
            </button>
          </div>
          <input
            ref={files}
            type="file"
            multiple
            hidden
            aria-label="Files"
            disabled={disabled}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (picked.length) took({ files: picked, skipped: 0 });
            }}
          />
          <input
            ref={(el) => {
              folder.current = el;
              el?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            hidden
            aria-label="Folder"
            disabled={disabled}
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = "";
              // Kept by the engine's own list of the types it takes.
              readableFiles(client).then(
                (isReadable) => took(fromFolderPick(list, isReadable)),
                (err: unknown) => setNote(errorText(err)),
              );
            }}
          />
        </div>
        {note && (
          <p className="sadder-note" role="status">
            {note}
          </p>
        )}
      </div>

      <div className="sadder-sec">
        <span className="sadder-lbl">From somewhere else</span>
        <div className="sadder-tiles">
          {TILES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`sadder-tile${open === t.id ? " on" : ""}`}
              aria-expanded={open === t.id}
              aria-controls={open === t.id ? fieldId : undefined}
              disabled={disabled}
              onClick={() => pick(t.id)}
            >
              <span className={`sadder-ic ${t.id}`}>{t.icon}</span>
              <b>{narrow ? t.short : t.label}</b>
            </button>
          ))}
        </div>
        {open && (
          <div
            className="sadder-field"
            id={fieldId}
            onKeyDown={(e) => {
              // Enter in a one-line field adds it, without sending the form this sits in.
              if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
                e.preventDefault();
                submitField();
              }
            }}
          >
            {spec ? (
              <>
                <input
                  className="ipt"
                  autoFocus
                  inputMode="url"
                  aria-label={spec.label}
                  aria-invalid={bad ? true : undefined}
                  placeholder={spec.placeholder}
                  value={value}
                  disabled={disabled}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setBad(undefined);
                  }}
                />
                {spec.help && <small className="sadder-help">{spec.help}</small>}
              </>
            ) : (
              <>
                <input className="ipt" aria-label="Title" placeholder="Title (optional)" value={title} disabled={disabled} onChange={(e) => setTitle(e.target.value)} />
                <textarea className="ipt" autoFocus aria-label="Text" rows={4} placeholder="Paste notes or any text" value={value} disabled={disabled} onChange={(e) => setValue(e.target.value)} />
              </>
            )}
            {bad && (
              <small className="sadder-bad" role="alert">
                {bad}
              </small>
            )}
            <div className="sadder-add">
              <button type="button" className="btn soft" disabled={disabled || !value.trim()} onClick={submitField}>
                Add
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The things being added, one row each: its name, what it is, where it stands; a waiting one can be taken out. */
export function AddingList({ entries, onRemove, label = "Adding" }: { entries: readonly QueueEntry[]; onRemove?: (id: string) => void; label?: string }) {
  if (entries.length === 0) return null;
  return (
    <div className="sadder-sec">
      <span className="sadder-lbl">{label}</span>
      <ul className="srows" aria-label={label}>
        {entries.map((e) => {
          const { state, text } = e.status;
          return (
            <li key={e.id} className={`srow ${state}`}>
              <span className="dot" aria-hidden="true" />
              <div className="nm">
                <b>{e.label}</b>
                <span>{state === "waiting" || !text ? e.kind : `${e.kind} · ${text}`}</span>
              </div>
              {onRemove && state === "waiting" && (
                <button type="button" className="ib" aria-label={`Remove ${e.label}`} onClick={() => onRemove(e.id)}>
                  <Icon name="x" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
