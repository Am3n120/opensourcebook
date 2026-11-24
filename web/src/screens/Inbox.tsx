import { useState } from "react";
import { useTitle } from "../app/useTitle";
import { Link, useNavigate } from "react-router";
import type { Project, Source } from "../api/types";
import { useApi, useAppData } from "../app/context";
import { ErrorNotice, LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { Icon } from "../design/Icon";
import { Checkbox } from "../design/ui";
import { AddSources } from "../sources/AddSources";
import { RemoveSource, RenameSource, SourceMenu } from "../sources/SourceActions";
import { useRetrySource, useSourceNotes, type SourceNote } from "../sources/useSourceNotes";
import { extractionText, readMark } from "../sources/sourceText";
import "../sources/sources.css";
import "./inbox.css";

/** Sources not filed into a project yet. */
export function Inbox() {
  useTitle("Inbox");
  const client = useApi();
  const { refreshInbox } = useAppData();
  const sources = useLoad(() => client.all((q) => client.inbox(q)), [client]);
  const projects = useLoad(() => client.all((q) => client.listProjects(q)), [client]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<unknown>();
  const list = sources.data ?? [];
  const { notes, set: setNote } = useSourceNotes(list);
  const { retrying, retry } = useRetrySource(setNote, () => sources.reload());

  function changed() {
    setPicked(new Set());
    void sources.reload();
    refreshInbox();
  }
  async function fileMany() {
    try {
      for (const id of picked) await client.fileSource(id, bulkTarget);
      changed();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="inbox">
      <div className="page-h">
        <h1>Inbox</h1>
        <button className="btn ghost" type="button" aria-label="Add to the Inbox" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          <Icon name="plus" />
          Add
        </button>
      </div>
      <p className="page-lead">Sources you saved that are not in a project yet, such as a link shared from your phone. File one into a project to ask about it and make things from it.</p>
      {adding && (
        <div className="card addcard">
          <AddSources onAdded={changed} />
        </div>
      )}
      <LoadState loading={sources.loading && !sources.data} error={sources.error} what="the Inbox" onRetry={() => void sources.reload()} />
      <ErrorNotice error={error} />
      {sources.data && list.length === 0 && (
        <div className="empty-big">
          <b>Inbox is empty</b>
        </div>
      )}
      {list.length > 0 && (
        <>
          {picked.size > 0 ? (
            <div className="bulk" role="region" aria-label="Selected sources">
              <b>{picked.size} selected</b>
              <select aria-label="File selected into" value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value)}>
                <option value="">Choose project…</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
              <button className="btn sm" type="button" disabled={!bulkTarget} onClick={fileMany}>
                File them
              </button>
              <span className="sp" />
              <button className="btn ghost sm" type="button" onClick={() => setPicked(new Set())}>
                Clear
              </button>
            </div>
          ) : (
            <div className="selrow">
              <Checkbox checked={false} label="Select all" onChange={() => setPicked(new Set(list.map((s) => s.id)))} />
              Select all
            </div>
          )}
          <ul className="card rows">
            {list.map((s) => (
              <InboxRow
                key={s.id}
                source={s}
                projects={projects.data ?? []}
                picked={picked.has(s.id)}
                onPick={(on) => {
                  const next = new Set(picked);
                  if (on) next.add(s.id);
                  else next.delete(s.id);
                  setPicked(next);
                }}
                onFiled={changed}
                note={notes.get(s.id)}
                retrying={retrying === s.id}
                onRetry={() => void retry(s)}
              />
            ))}
          </ul>
        </>
      )}
      <p className="foot">Things you share or upload without picking a project wait here until you file them.</p>
    </div>
  );
}

/** Where a source came from, in the prototype's "via" line. */
function via(source: Source): { icon: string; text: string } {
  if (source.url) {
    let host = source.url;
    try {
      host = new URL(source.url).hostname.replace(/^www\./, "");
    } catch {
      /* keep the raw link */
    }
    return { icon: "link", text: `Link · ${host}` };
  }
  if (source.uploadId) return { icon: "upload", text: "Uploaded" };
  return { icon: "paste", text: "Pasted" };
}

/** The option that makes a new project from the source. */
const NEW = "__new__";

function InboxRow({
  source,
  projects,
  picked,
  onPick,
  onFiled,
  note,
  retrying,
  onRetry,
}: {
  source: Source;
  projects: Project[];
  picked: boolean;
  onPick: (on: boolean) => void;
  /** The source left the Inbox (filed, renamed or removed): the list reads again. */
  onFiled: () => void;
  note?: SourceNote | undefined;
  retrying: boolean;
  onRetry: () => void;
}) {
  const client = useApi();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const status = extractionText(source.status);
  const v = via(source);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const mark = readMark(source);
  const failed = source.status === "failed";

  async function file(projectId: string) {
    setBusy(true);
    try {
      await client.fileSource(source.id, projectId);
      onFiled();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  async function newProject() {
    setBusy(true);
    try {
      const p = await client.createProject({ title: source.title.slice(0, 200) });
      await client.fileSource(source.id, p.id);
      onFiled();
      navigate(`/projects/${p.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <li className={`row${picked ? " sel" : ""}`}>
      <span className="pick">
        <Checkbox checked={picked} label={`Select ${source.title}`} onChange={onPick} />
      </span>
      <span className="ic">
        <Icon name={v.icon} />
      </span>
      <div className="src">
        {renaming ? (
          <RenameSource source={source} onDone={(renamed) => (setRenaming(false), renamed && onFiled())} />
        ) : (
          <Link className="t" to={`/sources/${source.id}`}>
            {source.title}
          </Link>
        )}
        <div className="via">
          {v.text} · {new Date(source.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          {source.status !== "ready" && !(failed && note?.error && !retrying) && (
            <>
              {" · "}
              <span className={`st ${status.tone}`}>{retrying ? "Reading…" : status.text}</span>
            </>
          )}
          {mark && (
            <span className="mark" title={note?.limitations?.join(" ")}>
              {" "}
              · {mark}
            </span>
          )}
        </div>
        {failed && !retrying && (
          <div className="why">
            {note?.error && <span>{note.error}</span>}
            {source.retryable !== false && (
              <button className="link small" type="button" onClick={onRetry}>
                Try again
              </button>
            )}
            <button className="link small" type="button" onClick={() => setRemoving(true)}>
              Remove
            </button>
          </div>
        )}
        <ErrorNotice error={error} />
      </div>
      <select
        className="fileto"
        aria-label={`File ${source.title} to a project`}
        value=""
        disabled={busy}
        onChange={(e) => (e.target.value === NEW ? void newProject() : e.target.value && void file(e.target.value))}
      >
        <option value="">File to project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
        <option value={NEW}>A new project from this</option>
      </select>
      <SourceMenu source={source} onRename={() => setRenaming(true)} onRemove={() => setRemoving(true)} />
      {removing && (
        <RemoveSource
          source={source}
          place="the Inbox"
          onCancel={() => setRemoving(false)}
          onDone={() => {
            setRemoving(false);
            onFiled();
          }}
        />
      )}
    </li>
  );
}
