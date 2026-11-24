import { Navigate, useParams, useSearchParams } from "react-router";
import { useApi } from "../app/context";
import { LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { SourceReader } from "./SourceReader";
import "./project.css";

/** A plan lives in its project's chat; an old plan link opens it there. */
export function PlanLink() {
  const { id = "" } = useParams();
  const client = useApi();
  const plan = useLoad(() => client.getPlan(id), [client, id]);
  if (plan.data) return <Navigate replace to={`/projects/${plan.data.plan.projectId}?plan=${id}`} />;
  return <LoadState loading={plan.loading} error={plan.error} what="this plan" onRetry={() => void plan.reload()} />;
}

/** A source in a project opens beside that project's chat; one in the Inbox opens here on its own. */
export function SourcePage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const client = useApi();
  const detail = useLoad(() => client.getSource(id), [client, id]);
  if (!detail.data) return <LoadState loading={detail.loading} error={detail.error} what="this source" onRetry={() => void detail.reload()} />;
  const pid = detail.data.source.projectId;
  // A cite's spot (`at`, `quote`) goes along, so the passage opens marked.
  const spot = new URLSearchParams();
  for (const name of ["at", "quote"]) {
    const value = params.get(name);
    if (value) spot.set(name, value);
  }
  if (pid) return <Navigate replace to={`/projects/${pid}?source=${id}${spot.size ? `&${spot}` : ""}`} />;
  return (
    <div className="lonereader">
      <SourceReader sourceId={id} views={[]} />
    </div>
  );
}
