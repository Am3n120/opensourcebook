import { useId, useState } from "react";
import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";
import { Icon } from "../design/Icon";
import { Sheet } from "../design/Sheet";
import "./planPanel.css";

export interface PlanNewProps {
  projectId: string;
  /** The ticked sources' ids: what the plan reads. */
  sources: string[];
  /** Sends the ask to the chat, where plans are written. */
  onAsk: (text: string) => void;
  onClose: () => void;
}

/**
 * "Plan a whole subject": what to get through, and what it reads. The plan
 * is asked for the way it always is, as `/plan …` in the chat; the chat
 * writes it, and nothing is made until it is looked over and started.
 */
export function PlanNew({ projectId, sources, onAsk, onClose }: PlanNewProps) {
  const client = useApi();
  const [text, setText] = useState("");
  const id = useId();
  const all = useLoad(() => client.all((q) => client.projectSources(projectId, q)), [client, projectId]);
  const names = new Map((all.data ?? []).map((s) => [s.id, s.title]));
  const reads = sources.flatMap((s) => {
    const name = names.get(s);
    return name ? [{ id: s, name }] : [];
  });
  function write() {
    onAsk(`/plan ${text.trim()}`.trim());
    onClose();
  }
  return (
    <Sheet
      title="Plan a whole subject"
      icon={
        <span className="plp-mark" aria-hidden="true">
          <Icon name="plan" />
        </span>
      }
      onClose={onClose}
      closeLabel="Back to Made here"
      primary={{ label: "Write the plan", onClick: write }}
    >
      <div className="plp-f">
        <label htmlFor={`${id}-ask`}>What do you want to get through?</label>
        <textarea id={`${id}-ask`} aria-describedby={`${id}-help`} className="ipt plp-ask" rows={3} placeholder="What do you want to get through, and by when?" value={text} autoFocus onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && write()} />
        <small id={`${id}-help`}>Say a day if there is one, and the plan's stages get days. Leave it blank and it plans from the sources.</small>
      </div>
      <div className="plp-f" role="group" aria-labelledby={`${id}-reads`}>
        <span id={`${id}-reads`}>Reads</span>
        {sources.length === 0 ? (
          <small>No sources are ticked. Tick the ones to plan from.</small>
        ) : (
          <div className="chips">
            {reads.map((r) => (
              <span key={r.id} className="chip">
                {r.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="plp-writer">
        <b>Written in the chat</b>, by the model that answers it. The items are made by your defaults, and you can change them before Start.
      </p>
      <p className="plp-after">Nothing is made yet. You look the plan over before Start.</p>
    </Sheet>
  );
}
