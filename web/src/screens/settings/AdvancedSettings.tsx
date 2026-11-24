import { useId } from "react";
import { Link } from "react-router";
import type { VideoMaker } from "../../api/types";
import { useAppData } from "../../app/context";
import { useLoad } from "../../app/useLoad";
import { SectionHead } from "./SectionHead";

/** Settings › Advanced: how this site and the engine are wired, for whoever runs it. */
export function AdvancedSettings() {
  const heading = useId();
  const { client, providers } = useAppData();
  const makers = useLoad(() => client.videoMakers(), [client]);
  const list = makers.data ?? [];
  const decides = list.find((m) => m.default);
  // Makers that run on this computer with the person's own agent; the others need nothing from them.
  const local = list.filter((m) => m.local);
  const connector = providers?.connector;
  return (
    <section className="sx-sec" aria-labelledby={heading}>
      <SectionHead id={heading} title="Advanced">
        For whoever runs it. Nothing here needs changing to use it.
      </SectionHead>
      <div className="card sx-rows">
        <section className="sx-arow" aria-label="Activity">
          <b>What your agents are doing</b>
          <p>Each thing being made, and every agent turn with how long it took, its tokens and its tool calls, on this computer.</p>
          <Link className="mini" to="/settings/activity">
            See what the agents are doing
          </Link>
        </section>
        <section className="sx-arow" aria-label="How this site reaches the engine">
          <b>How this site reaches the engine</b>
          <p>
            This site talks to the engine only through its own <code>/api</code> proxy, which holds the client token on the server. It has no sign-in of its own: it must sit
            behind a login gate (Cloudflare Access) before anyone else can reach it.
          </p>
        </section>
        <section className="sx-arow" aria-label="The agent connector">
          <b>The agent connector</b>
          <p>
            Runs your agents for it, on this computer. When it isn't connected, Providers says so and points here: start <code>services/agent-connector</code> and give the
            engine <code>CHAT_AGENT_URL</code> and <code>CHAT_AGENT_TOKEN</code>.
          </p>
          {connector && (
            <span className={`sx-state ${connector.configured && connector.reachable ? "on" : "warn"}`}>
              <span className="dot" aria-hidden="true" />
              {!connector.configured ? "Not set up" : connector.reachable ? "Connected" : "Can't be reached"}
            </span>
          )}
        </section>
        <section className="sx-arow" aria-label="Video makers">
          <b>Which video maker is used when none is picked</b>
          <p>
            {makers.loading && !makers.data
              ? "Checking…"
              : decides
                ? <>{decides.label}. <code>VIDEO_MAKER_DEFAULT</code>, where the engine is set up, changes it; shown here so it isn't hidden.</>
                : "None: this engine has no video maker set up."}
          </p>
          {local.map((maker) => (
            <MakerRow key={maker.id} maker={maker} loading={makers.loading} onCheck={() => void makers.reload()} />
          ))}
        </section>
      </div>
    </section>
  );
}

/** A video maker that runs on this computer with the person's agent: whether it can make videos now, and if not, what to do. */
function MakerRow({ maker, loading, onCheck }: { maker: VideoMaker; loading: boolean; onCheck: () => void }) {
  const spec = [maker.agent?.model, maker.agent?.effort && `${maker.agent.effort} effort`].filter(Boolean).join(", ");
  const by = maker.agent?.label ? ` ${maker.agent.label} writes them${spec ? ` (${spec})` : ""}.` : "";
  return (
    <div className="agentrow">
      <span className={`dot ${maker.available ? "on" : "off"}`} aria-hidden="true" />
      <span className="ab">
        <b>Videos: {maker.label}</b>
        <span>{maker.available ? `Ready. Pick it as a video's maker.${by}` : (maker.problem ?? "Not available right now.")}</span>
        {maker.notice && <span className="quiet-note">{maker.notice}</span>}
      </span>
      <button className="mini" type="button" disabled={loading} onClick={onCheck}>
        {loading ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}
