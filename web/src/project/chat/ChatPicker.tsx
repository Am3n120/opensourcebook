import { useState } from "react";
import { Link } from "react-router";
import type { Providers } from "../../api/types";
import { aToZ, TIER_WORDS } from "../../make/makerKey";
import { Icon } from "../../design/Icon";
import { ProviderMark } from "../../design/ProviderMark";
import { Segmented } from "../../design/ui";
import { useDismiss } from "../../design/useDismiss";
import { chatDefault, choices, onRail, said, shownChoice, shownEffort, usable } from "../providers";
import { pickerState, type ProviderLoad } from "./providerLoad";
import { useScrollFade } from "./scrollFade";

/**
 * "Chat answers with": the model that answers this chat, and only that.
 * It opens on the agents on this computer A to Z, the picked one's models
 * by their real names with their tier in plain words, and its efforts. What
 * makes a video or anything else is set in its own make sheet; the picker
 * says so. A pick is kept on the chat (or on a new chat's first message).
 * While the providers load the chip is a quiet empty one; "Set up a provider"
 * shows only once the engine has answered that none can answer; a load that
 * failed says Couldn't reach the engine with Try again; a connector out of
 * reach is said above the box, so the chip shows nothing.
 */
export function ChatPicker({
  providers,
  load = providers ? "ready" : "loading",
  picked,
  effort,
  disabled,
  onPick,
  onEffort,
  onRetry,
}: {
  providers?: Providers;
  /** How far loading the providers got; without it, providers given are an answer. */
  load?: ProviderLoad;
  /** The chat's pick (a provider pick); unset is the chat's default. */
  picked?: string;
  effort?: string;
  disabled?: boolean;
  onPick: (pick: string) => void;
  onEffort: (effort: string) => void;
  /** Asks the engine for the providers again, after a failed load. */
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>();
  const box = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const [watchFade, faded] = useScrollFade<HTMLDivElement>(open ? (tab ?? "shown") : undefined);
  const rail = providers ? aToZ(providers.providers.filter(onRail)) : [];
  const dflt: { pick?: string; effort?: string } = providers ? chatDefault(providers) : {};
  const shown = shownChoice(rail, picked ?? dflt.pick, "chat");
  const state = pickerState(providers, load, Boolean(shown) && rail.some(usable));
  if (state === "waiting") return <span className="cpick cpick-wait" role="status" aria-label="Finding who answers the chat" />;
  if (state === "failed")
    return (
      <button type="button" className="cpick warn" onClick={() => onRetry?.()}>
        <span className="dot" aria-hidden="true" />
        <span>Couldn&apos;t reach the engine. Try again.</span>
      </button>
    );
  if (state === "setUp")
    return (
      <Link className="cpick warn" to="/settings#providers">
        <span className="dot" aria-hidden="true" />
        <span>Set up a provider</span>
      </Link>
    );
  if (state !== "picker" || !shown) return null;
  const now = shownEffort(shown.provider, effort ?? (picked ? undefined : dflt.effort), "chat");
  const current = rail.find((p) => p.id === (tab ?? shown.provider.id)) ?? shown.provider;
  const words = `${shown.label}${now ? ` · ${now.label.toLowerCase()}` : ""}`;

  return (
    <div className="cpick-at" ref={box}>
      <button
        type="button"
        className="cpick"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Chat answers with ${shown.provider.label}, ${shown.label}${now ? `, ${now.label}` : ""}. Change`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : (setTab(undefined), setOpen(true)))}
      >
        <span className="cpick-lead">Chat answers with</span>
        <ProviderMark mark={shown.provider.mark} label={shown.provider.label} size={14} />
        <b>{words}</b>
        <Icon name="down" />
      </button>
      {open && (
        <div className="cpop chatpick" role="dialog" aria-label="Who answers this chat">
          <header className="chatpick-hd">
            <b>Who answers this chat</b>
            <p>Only the chat. It never decides what makes a video, a quiz or anything else: each is set in its own make sheet.</p>
          </header>
          <div className="chatpick-body">
            <div className="chatpick-rail" role="tablist" aria-label="Providers" aria-orientation="vertical">
              <span className="chatpick-lbl">Providers</span>
              {rail.map((p) => (
                <button key={p.id} type="button" role="tab" aria-selected={p.id === current.id} className={`${p.id === current.id ? "on" : ""}${usable(p) ? "" : " dim"}`} onClick={() => setTab(p.id)}>
                  <ProviderMark mark={p.mark} label={p.label} size={16} dim={!usable(p)} />
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
            <div className={`chatpick-main${faded}`} ref={watchFade} role="tabpanel" aria-label={current.label}>
              {!usable(current) ? (
                <div className="chatpick-setup">
                  <p>{said(current)}</p>
                  <Link to={`/settings?provider=${encodeURIComponent(current.id)}#providers`} onClick={() => setOpen(false)}>
                    How to connect
                  </Link>
                </div>
              ) : (
                <>
                  <span className="chatpick-lbl">Model</span>
                  <div className="chatpick-models" role="listbox" aria-label="Models">
                    {choices(current).map((c) => {
                      const on = c.pick === shown.pick;
                      // The tier its connector declares for the model, in plain words; none declared, no line.
                      const tier = c.model?.tier ? TIER_WORDS[c.model.tier] : undefined;
                      return (
                        <button key={c.pick} type="button" role="option" aria-selected={on} className={on ? "on" : undefined} onClick={() => !on && onPick(c.pick)}>
                          <span>
                            <b>{c.label}</b>
                            {tier && <small>{tier}</small>}
                          </span>
                          {on && <Icon name="check" />}
                        </button>
                      );
                    })}
                  </div>
                  {current.id === shown.provider.id && current.efforts.length > 0 && (
                    <>
                      <span className="chatpick-lbl">Effort</span>
                      <Segmented label="Effort" options={current.efforts.map((e) => ({ value: e.id, label: e.label }))} value={now?.id ?? ""} onChange={(e) => e !== now?.id && onEffort(e)} />
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          <footer className="chatpick-ft">
            <span>Kept for this chat. New chats start from your default.</span>
            <Link to="/settings#makers" onClick={() => setOpen(false)}>
              Defaults in Settings
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}
