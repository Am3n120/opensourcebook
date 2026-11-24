import { useState } from "react";
import { Link } from "react-router";
import type { FormatDescriptor, JsonObject, Provider } from "../api/types";
import { useAppData, useProviders } from "../app/context";
import { ProviderMark } from "../design/ProviderMark";
import { Segmented } from "../design/ui";
import { Icon } from "../design/Icon";
import { timeBucket } from "../plan/timing";
import { choices, onRail, said, usable, type Choice } from "../project/providers";
import { timeResult, timeWords, useMakeTimes } from "./makeTime";
import { aToZ, defaultEffortId, timeKey, TIER_WORDS, turnKindOf, type MakerPick } from "./makerKey";
import { Picker } from "./Picker";
import "./make.css";

export type { MakerPick } from "./makerKey";

const OFF = "\u0000off";
/** The most effort levels drawn as a switch; more are a compact list. */
const EFFORT_SWITCH_MOST = 3;

export interface MakerPickerProps {
  /** A shape id, or "chat". */
  scope: string;
  role?: "maker" | "reviewer";
  /** The pick now; null is none picked, or off for a reviewer that can be. */
  value: MakerPick | null;
  /** A reviewer can be turned off: null then means off. */
  allowNone?: boolean;
  onChange(pick: MakerPick | null): void;
  onClose(): void;
  /** The thing's settings, so times are for its length; the shape's defaults when left out. */
  settings?: JsonObject;
  /** One line under the title on what this pick sets. */
  note?: string;
  /** The filled button's words; "Use this" when left out. */
  confirmLabel?: string;
  /** The title, when the pick is for more than the scope (Settings' "Use one for all"). */
  title?: string;
  /** No times beside the models: the pick is for several scopes at once. */
  noTimes?: boolean;
}

/**
 * Who makes (or reviews) a shape, or answers the chat: the agents on this
 * computer A to Z, each one's models by their real names with their tier in
 * plain words, its efforts, and beside each model how long it took here
 * with that effort (and length), or "no time yet". Nothing is picked for the
 * person: with no pick, the first agent A to Z is open and no model is on.
 */
export function MakerPicker({ scope, role = "maker", value, allowNone, onChange, onClose, settings, note, confirmLabel = "Use this", title: ownTitle, noTimes }: MakerPickerProps) {
  const { formats } = useAppData();
  const { providers, status, retry } = useProviders();
  const format = scope === "chat" ? undefined : formats.find((f) => f.id === scope);
  const turnKind = turnKindOf(format, role);
  const timeScope = role === "reviewer" ? `${scope}.review` : scope;
  const bucket = timeBucket(format, format ? { ...format.defaults, ...settings } : settings);
  const times = useMakeTimes(noTimes ? undefined : timeScope);
  const rail = aToZ(providers?.connector.configured ? providers.providers.filter(onRail) : []);

  const [draft, setDraft] = useState<MakerPick | null>(value);
  // Until the person opens a tab: the picked agent's, else Off for a reviewer that is off, else the first A to Z.
  const [tab, setTab] = useState<string>();
  const current = tab ?? (value && rail.some((p) => p.id === value.agent) ? value.agent : allowNone && value === null ? OFF : rail[0]?.id);
  const provider = rail.find((p) => p.id === current);

  const plural = format ? (format.plural ?? `${format.label}s`) : undefined;
  const title = ownTitle ?? (role === "reviewer" ? `Reviewed by${plural ? `, for ${plural}` : ""}` : format ? `Made by, for ${plural}` : "Answers the chat");

  const effortOn = (p: Provider) => (draft?.agent === p.id ? draft.effort : undefined) ?? defaultEffortId(p, turnKind);
  const keyOf = (p: Provider, model: string | undefined) => timeKey(timeScope, p, { model, effort: effortOn(p) }, turnKind, bucket);
  const picked = (c: Choice) => !!draft && draft.agent === c.provider.id && keyOf(c.provider, draft.model).model === keyOf(c.provider, c.model?.id).model;

  function pickModel(c: Choice) {
    const effort = effortOn(c.provider);
    setDraft({ agent: c.provider.id, ...(c.model ? { model: c.model.id } : {}), ...(effort ? { effort } : {}) });
  }
  function pickEffort(p: Provider, effort: string) {
    setDraft(draft?.agent === p.id ? { ...draft, effort } : { agent: p.id, effort });
  }

  const off = allowNone && current === OFF;
  const lengthWords = lengthOf(format, settings);

  return (
    <Picker
      className="maker-picker"
      title={title}
      note={note}
      onClose={onClose}
      primary={{
        label: confirmLabel,
        disabled: !off && !draft,
        onClick: () => {
          onChange(off ? null : draft);
          onClose();
        },
      }}
    >
      {status === "failed" && !providers ? (
        <div className="mk-empty" role="status">
          <p>Couldn't reach the engine.</p>
          <button type="button" className="mk-retry" onClick={retry}>
            Try again
          </button>
        </div>
      ) : !providers ? (
        <p className="mk-empty" role="status">
          Looking for your agents…
        </p>
      ) : rail.length === 0 ? (
        <div className="mk-empty">
          <p>{providers.connector.configured && !providers.connector.reachable ? "Your agent can't be reached." : "No agent is set up on this computer yet."}</p>
          <Link to="/settings#providers" onClick={onClose}>
            Open providers
          </Link>
        </div>
      ) : (
        <div className="mk-grid">
          <div className="mk-rail" role="tablist" aria-label="Your agents" aria-orientation="vertical">
            {allowNone && (
              <button type="button" role="tab" aria-selected={off} className={off ? "on" : ""} onClick={() => setTab(OFF)}>
                <span className="mk-off" aria-hidden="true">
                  <Icon name="x" />
                </span>
                <span className="mk-who">Off</span>
              </button>
            )}
            {rail.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={current === p.id} className={`${current === p.id ? "on" : ""}${usable(p) ? "" : " dim"}`} onClick={() => setTab(p.id)}>
                <ProviderMark mark={p.mark} label={p.label} size={16} dim={!usable(p)} />
                <span className="mk-who">{p.label}</span>
              </button>
            ))}
          </div>
          <div className="mk-main" role="tabpanel">
            {off ? (
              <p className="mk-say">Nothing reviews it: it is done once the maker finishes.</p>
            ) : provider && !usable(provider) ? (
              <div className="mk-say">
                <p>{said(provider)}</p>
                <Link to={`/settings?provider=${encodeURIComponent(provider.id)}#providers`} onClick={onClose}>
                  How to connect
                </Link>
              </div>
            ) : (
              provider && (
                <>
                  <div className="mk-sec">
                    <span className="mk-lbl">{noTimes ? "Model" : lengthWords ? `Model · time for ${lengthWords}` : "Model · time"}</span>
                    <div className="mk-models" role="listbox" aria-label="Models">
                      {choices(provider).map((c) => {
                        const on = picked(c);
                        const words = noTimes ? undefined : timeWords(timeResult(times, keyOf(provider, c.model?.id)));
                        const tier = c.model?.tier ? TIER_WORDS[c.model.tier] : undefined;
                        return (
                          <button key={c.pick} type="button" role="option" aria-selected={on} className={`mk-model${on ? " on" : ""}`} onClick={() => pickModel(c)}>
                            <span className="mk-name">
                              <b>{c.label}</b>
                              {tier && <span>{tier}</span>}
                            </span>
                            {words && (
                              <span className={`mk-time${words.muted ? " muted" : ""}`} title={words.sub}>
                                {words.text}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {provider.efforts.length > 0 && (
                    <div className="mk-sec">
                      <span className="mk-lbl">Effort</span>
                      {/* Up to three levels fit a switch on one line at any width; more is a compact list, so no label wraps. */}
                      {provider.efforts.length <= EFFORT_SWITCH_MOST ? (
                        <Segmented label="Effort" options={provider.efforts.map((e) => ({ value: e.id, label: e.label }))} value={effortOn(provider) ?? ""} onChange={(e) => pickEffort(provider, e)} />
                      ) : (
                        <select className="ipt mk-effort" aria-label="Effort" value={effortOn(provider) ?? ""} onChange={(e) => pickEffort(provider, e.target.value)}>
                          {!effortOn(provider) && <option value="">Pick an effort</option>}
                          {provider.efforts.map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </>
              )
            )}
          </div>
        </div>
      )}
    </Picker>
  );
}

/** The length the times are for: "3 min", or "Auto length". */
function lengthOf(format: FormatDescriptor | undefined, settings: JsonObject | undefined): string | undefined {
  const timing = format?.timing;
  if (!format || !timing) return undefined;
  const field = format.settings.find((f) => f.key === timing.setting);
  const own = settings?.[timing.setting];
  const n = typeof own === "number" ? own : format.defaults[timing.setting];
  if (typeof n !== "number" || field?.kind !== "number") return undefined;
  if (n === 0) return "Auto length";
  return `${n}${field.unit ? ` ${field.unit}` : ""}`;
}
