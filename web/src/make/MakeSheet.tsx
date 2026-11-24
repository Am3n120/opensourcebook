import { useEffect, useId, useMemo, useState } from "react";
import type { JsonObject, PlanView, Source } from "../api/types";
import { useApi, useFormats, useProviders } from "../app/context";
import { Confirm } from "../app/Confirm";
import { ErrorNotice } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { findFormat } from "../design/formatLook";
import { FormatTile } from "../design/FormatTile";
import { Icon } from "../design/Icon";
import { Sheet } from "../design/Sheet";
import { usable } from "../project/ticks";
import { MadeByBox } from "./MadeByBox";
import { noAgentSetUp, withPick } from "./madeBy";
import { MakerPicker } from "./MakerPicker";
import { isPickNeeded, PICK_MAKER } from "./pickNeeded";
import { makeLabel, proposalOf, readPrefill, sheetTitle } from "./prefill";
import { agentField } from "./makerKey";
import { ShapeSettings } from "./ShapeSettings";
import "./sheet.css";

export interface MakeSheetProps {
  projectId: string;
  /** The shape's format id. */
  shape: string;
  /** The ticked sources. */
  sources: string[];
  /** Filled in by a chat proposal or a plan item (`MakePrefill`). */
  prefill?: Record<string, unknown>;
  onClose(): void;
  /** The plan the made thing is in, once its button is pressed. */
  onMade(outputOrJob: PlanView): void;
}

/**
 * One way to make one thing: what it covers, the sources it reads, the
 * shape's settings and who makes it, starting from the person's defaults
 * and from what asked for it. Nothing is made until its button is pressed.
 */
export function MakeSheet({ projectId, shape, sources, prefill, onClose, onMade }: MakeSheetProps) {
  const client = useApi();
  const formats = useFormats();
  const format = findFormat(formats, shape);
  const filled = useMemo(() => readPrefill(prefill), [prefill]);
  const proposal = proposalOf(filled);
  const aboutId = useId();
  const { providers, status } = useProviders();

  const [about, setAbout] = useState(filled.about ?? "");
  const [settings, setSettings] = useState<JsonObject>(filled.settings ?? {});
  const [reads, setReads] = useState<string[]>(filled.sources ?? sources);
  // What the sheet opened with, so closing asks first only when something here was typed or changed.
  const [opened] = useState(() => ({ about: filled.about ?? "", settings: JSON.stringify(filled.settings ?? {}), reads: (filled.sources ?? sources).join(",") }));
  const [leaving, setLeaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  // Several agents are ready and none is picked: the picker asks who makes it, then it is made with that pick.
  const [asking, setAsking] = useState(false);
  const [check, setCheck] = useState<{ issues: string[]; notices: string[] }>({
    issues: filled.issues ?? [],
    notices: filled.notices ?? [],
  });

  const all = useLoad(() => client.all((q) => client.projectSources(projectId, q)), [client, projectId]);
  const list: Source[] = usable(all.data ?? []);
  const named = new Map(list.map((s) => [s.id, s.title]));

  // What would stop it being made from these sources now, as the engine checks it.
  const readsKey = reads.join(",");
  const formatId = format?.id;
  useEffect(() => {
    if (!formatId || !readsKey) return;
    let live = true;
    client
      .settleMake(projectId, { format: formatId, sources: readsKey.split(",") })
      .then((r) => live && setCheck({ issues: r.issues, notices: r.notices ?? [] }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, projectId, formatId, readsKey]);

  if (!format) return null;

  const changed = about !== opened.about || JSON.stringify(settings) !== opened.settings || reads.join(",") !== opened.reads;

  function leave() {
    if (proposal) void client.closeProposal(proposal.chatId, proposal.messageId, proposal.piece).catch(() => undefined);
    onClose();
  }
  function close() {
    if (changed && !busy) setLeaving(true);
    else leave();
  }

  async function make(using: JsonObject = settings) {
    if (!format) return;
    setBusy(true);
    setError(undefined);
    try {
      const view = await client.make(projectId, {
        format: format.id,
        ...(about.trim() ? { about: about.trim() } : {}),
        sources: reads,
        settings: using,
        ...(proposal
          ? {
              chatId: proposal.chatId,
              proposal: {
                messageId: proposal.messageId,
                piece: proposal.piece,
              },
            }
          : {}),
        ...(filled.remakes ? { remakes: filled.remakes } : {}),
      });
      onMade(view);
    } catch (e) {
      if (isPickNeeded(e) && agentField(format, "maker")) setAsking(true);
      else setError(e);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) => setReads((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));
  const others = list.filter((s) => !reads.includes(s.id));
  // Nothing made by a stand-in: with no agent set up, a shape an agent makes waits for one.
  const noMaker = !!agentField(format, "maker") && noAgentSetUp(providers, status);
  const blocked = !format.ready || reads.length === 0 || check.issues.length > 0 || noMaker;

  return (
    <Sheet
      title={sheetTitle(format)}
      icon={<FormatTile id={format.id} formats={formats} size="sm" />}
      onClose={close}
      closeLabel="Back to Made here"
      primary={{
        label: busy ? "Starting…" : makeLabel(format),
        onClick: () => void make(),
        disabled: busy || blocked,
      }}
    >
      {format.problem && (
        <div className="notice warn ms-problem" role="status">
          <Icon name="alert" />
          <span>{format.problem}</span>
        </div>
      )}
      {format.blurb && <p className="ms-blurb">{format.blurb.charAt(0).toUpperCase() + format.blurb.slice(1)}.</p>}
      <label className="field ms-about" htmlFor={aboutId}>
        <span>What it covers</span>
        <textarea id={aboutId} className="ipt" rows={2} value={about} placeholder="Leave blank and it covers what the ticked sources hold" onChange={(e) => setAbout(e.target.value)} />
      </label>
      <div className="ss-field ms-reads">
        <span className="ss-lbl" id={`${aboutId}-reads`}>
          Reads
        </span>
        <div className="chips" role="group" aria-labelledby={`${aboutId}-reads`}>
          {reads.map((id) => {
            const name = named.get(id) ?? (all.loading ? "…" : "A removed source");
            return (
              <span key={id} className="chip ms-read">
                <span className="ms-read-name">{name}</span>
                <button type="button" className="ms-x" aria-label={`Take ${name} out`} title="Take it out" onClick={() => toggle(id)}>
                  <Icon name="x" />
                </button>
              </span>
            );
          })}
          {adding
            ? others.map((s) => (
                <button key={s.id} type="button" className="chip ms-add" aria-label={`Add ${s.title}`} onClick={() => toggle(s.id)}>
                  + {s.title}
                </button>
              ))
            : others.length > 0 && (
                <button type="button" className="chip ms-add" onClick={() => setAdding(true)}>
                  + Add
                </button>
              )}
        </div>
        {reads.length === 0 && <small className="ss-help">Pick at least one source to make it from.</small>}
      </div>
      <ShapeSettings format={format} settings={settings} onChange={setSettings} />
      <div className="ms-madeby">
        <MadeByBox format={format} settings={settings} onChange={setSettings} />
      </div>
      {check.issues.length > 0 && (
        <div className="notice warn" role="status">
          <div>
            It can't be made here now:
            <ul>
              {check.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {check.issues.length === 0 && check.notices.length > 0 && <small className="ss-help">{check.notices.join(" ")}</small>}
      <ErrorNotice error={error} />
      {leaving && (
        <Confirm title="Discard what you filled in?" action="Discard" onConfirm={leave} onCancel={() => setLeaving(false)}>
          <p>What you typed and changed here is not kept.</p>
        </Confirm>
      )}
      {asking && (
        <MakerPicker
          scope={format.id}
          value={null}
          note={PICK_MAKER}
          settings={{ ...format.defaults, ...settings }}
          onChange={(pick) => {
            if (!pick) return;
            const next = withPick(format, settings, "maker", pick);
            setSettings(next);
            void make(next);
          }}
          onClose={() => setAsking(false)}
        />
      )}
    </Sheet>
  );
}
