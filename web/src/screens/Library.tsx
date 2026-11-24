import { useEffect, useState } from "react";
import { useTitle } from "../app/useTitle";
import { Link, useSearchParams } from "react-router";
import type { FormatDescriptor, OutputSummary, Page, PageQuery } from "../api/types";
import { isApiError } from "../api/errors";
import { Confirm } from "../app/Confirm";
import { RowMenu } from "../design/RowMenu";
import { measureText } from "../api/measure";
import { useApi, useFormats } from "../app/context";
import { ErrorNotice, LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { GlimpseFace } from "../design/GlimpseFace";
import { findFormat, lookFor } from "../design/formatLook";
import { Empty } from "../design/ui";
import "./library.css";

type View = "gallery" | "list";

/** Everything made, newest first, filtered by format and project and found by its words. */
export function Library() {
  useTitle("Library");
  const client = useApi();
  const formats = useFormats();
  const [params, setParams] = useSearchParams();
  const type = params.get("type") ?? "";
  const project = params.get("project") ?? "";
  const view: View = params.get("view") === "list" ? "list" : "gallery";
  const rawSearch = (params.get("q") ?? "").trim();
  // What is typed in the top bar shows at once; the query runs once typing pauses.
  const [search, setSearch] = useState(rawSearch);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(rawSearch), rawSearch ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [rawSearch]);
  const projects = useLoad(() => client.all((q) => client.listProjects({ ...q, archived: "include" })), [client]);
  const [more, setMore] = useState<{ rows: OutputSummary[]; nextCursor?: string; key: string }>();
  const [moreError, setMoreError] = useState<unknown>();
  const key = `${type}|${project}|${search}`;

  const load = (q: PageQuery): Promise<Page<OutputSummary>> => {
    const t = { ...(type ? { type } : {}), ...(search ? { q: search } : {}) };
    if (project === "none") return client.listOutputs({ ...q, ...t, project: "none" });
    if (project) return client.projectOutputs(project, { ...q, ...t });
    return client.listOutputs({ ...q, ...t });
  };
  const first = useLoad(() => load({ limit: 50 }), [client, type, project, search]);
  // How many of each shape there are under the same project and words, for the chips.
  const counts = useLoad(async () => {
    const t = search ? { q: search } : {};
    const every = await client.all((q) => (project === "none" ? client.listOutputs({ ...q, ...t, project: "none" }) : project ? client.projectOutputs(project, { ...q, ...t }) : client.listOutputs({ ...q, ...t })), 500);
    const by = new Map<string, number>();
    for (const o of every) by.set(o.type, (by.get(o.type) ?? 0) + 1);
    return { total: every.length, by };
  }, [client, project, search]).data;

  const extra = more?.key === key ? more : undefined;
  // Things deleted here: gone from the list at once.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const rows = [...(first.data?.rows ?? []), ...(extra?.rows ?? [])].filter((o) => !gone.has(o.id));
  // Only a thing made at once can be deleted on its own: its plan is that one thing. One inside a larger plan goes only with the whole plan.
  const planProjects = [...new Set(rows.filter((o) => o.planId && o.projectId).map((o) => o.projectId!))].sort();
  const direct = useLoad(async () => {
    const lists = await Promise.all(planProjects.map((id) => client.listPlans(id).catch(() => [])));
    return new Set(lists.flat().filter((p) => p.direct).map((p) => p.id));
  }, [client, planProjects.join(",")]).data;
  const cursor = extra ? extra.nextCursor : first.data?.nextCursor;
  const titleOf = new Map((projects.data ?? []).map((p) => [p.id, p.title]));

  function setFilter(name: "type" | "project" | "view" | "q", value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }
  async function loadMore() {
    if (!cursor) return;
    try {
      const page = await load({ limit: 50, cursor });
      setMore({ key, rows: [...(extra?.rows ?? []), ...page.rows], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
    } catch (e) {
      setMoreError(e);
    }
  }

  return (
    <>
      <h1 className="sr-only">Library</h1>
      <div className="libtop">
        <div className="chips" role="group" aria-label="Format">
          <button type="button" className="chip" aria-pressed={type === ""} onClick={() => setFilter("type", "")}>
            All{counts ? ` · ${counts.total}` : ""}
          </button>
          {formats.map((f) => (
            <button key={f.id} type="button" className="chip" aria-pressed={type === f.id} onClick={() => setFilter("type", f.id)}>
              {f.label}
              {counts ? ` · ${counts.by.get(f.id) ?? 0}` : ""}
            </button>
          ))}
        </div>
        <span className="sp" />
        <select className="libproject" aria-label="Project" value={project} onChange={(e) => setFilter("project", e.target.value)}>
          <option value="">All projects</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
          <option value="none">No project</option>
        </select>
        <div className="views" role="group" aria-label="Layout">
          <button type="button" aria-pressed={view === "gallery"} onClick={() => setFilter("view", "")}>
            Grid
          </button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setFilter("view", "list")}>
            List
          </button>
        </div>
      </div>
      <LoadState loading={first.loading && !first.data} error={first.error} what="the Library" onRetry={() => void first.reload()} />
      {first.data && rows.length === 0 && !search && <Empty title="Nothing here yet">Things show up here once a plan makes them.</Empty>}
      {first.data && rows.length === 0 && search && (
        <Empty title={`Nothing matches “${search}”`}>
          Try fewer words, or{" "}
          <button className="link" type="button" onClick={() => setFilter("q", "")}>
            clear the search
          </button>
          .
        </Empty>
      )}
      {rows.length > 0 && (
        <ul className={`libitems ${view}`}>
          {rows.map((o) => (
            <li key={o.id} className="lit">
              <Link className="go" to={`/outputs/${o.id}`}>
                <GlimpseFace type={o.type} glimpse={o.glimpse} formats={formats} thumb={view === "list"} />
                <span className="tx">
                  <span className="tt">{o.title}</span>
                  {view === "list" && o.glimpse?.text && <span className="gl">{o.glimpse.text}</span>}
                  <span className="sb">
                    <span className="sbl">{[lookFor(formats, o.type).label, o.projectId ? (titleOf.get(o.projectId) ?? "A project") : "No project"].join(" · ")}</span>
                    {(measureText(o.size) || o.done) && (
                      <span className="sbr">
                        {measureText(o.size) && <span className="sz"> · {measureText(o.size)}</span>}
                        {o.done && <span className="ok"> · done</span>}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
              {o.planId && direct?.has(o.planId) && <DeleteMade output={o} planId={o.planId} formats={formats} onDeleted={() => setGone((g) => new Set([...g, o.id]))} />}
            </li>
          ))}
        </ul>
      )}
      <ErrorNotice error={moreError} />
      {cursor && (
        <button className="btn ghost more" type="button" onClick={loadMore}>
          Load more
        </button>
      )}
    </>
  );
}

/** The ⋯ on a thing made at once, with Delete…: asks first, then deletes its one-item plan for good. */
function DeleteMade({ output, planId, formats, onDeleted }: { output: OutputSummary; planId: string; formats: FormatDescriptor[]; onDeleted: () => void }) {
  const client = useApi();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const format = findFormat(formats, output.type);
  // "This set of flashcards goes", never "This flashcards goes".
  const one = format?.singular ?? format?.label ?? output.type;
  async function remove() {
    setBusy(true);
    setError(undefined);
    try {
      await client.deletePlan(planId);
      setAsking(false);
      onDeleted();
    } catch (e) {
      setError(isApiError(e, "plan_running") ? new Error("It is still being made. Stop it first, then delete it.") : e);
      setBusy(false);
    }
  }
  return (
    <>
      <RowMenu name={output.title} items={[{ label: "Delete…", danger: true, run: () => (setError(undefined), setAsking(true)) }]} />
      {asking && (
        <Confirm title={`Delete “${output.title}” for good?`} action="Delete" busy={busy} error={error} onConfirm={() => void remove()} onCancel={() => (setAsking(false), setError(undefined))}>
          <p>This {one} goes for good: it leaves Made here and the Library. This can't be undone.</p>
        </Confirm>
      )}
    </>
  );
}
