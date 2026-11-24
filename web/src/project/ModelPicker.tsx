import { useContext, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { Provider, Providers } from "../api/types";
import { Ctx } from "../app/context";
import { Icon } from "../design/Icon";
import { ProviderMark } from "../design/ProviderMark";
import { useDismiss } from "../design/useDismiss";
import { choiceMark, choices, makerOf, onRail, said, shownChoice, shownEffort, usable, type Choice, type TurnKind } from "./providers";

/** How many models a provider's list shows before "Show more". */
const FEW = 6;
const FAVORITES = "favorites";

/**
 * Which agent, model, and effort run a turn (engine/docs/api.md, "Providers";
 * DECISIONS #58). A chip names the model and effort; it opens on a rail of the
 * providers turned on in Settings with a star for favorites, a searchable list
 * of the picked provider's shown models (each can be starred), and the efforts
 * that provider takes. When `placement` is `"down"`, the popover renders in a
 * viewport-clamped portal so forms inside scrolling panels do not clip it.
 */
export function ModelPicker({
  providers,
  picked,
  effort,
  disabled,
  placement = "up",
  turnKind = "chat",
  onPick,
  onEffort,
  onFavorite,
}: {
  providers?: Providers;
  picked?: string;
  effort?: string;
  disabled?: boolean;
  placement?: "up" | "down";
  turnKind?: TurnKind;
  onPick: (pick: string) => void;
  onEffort: (effort: string) => void;
  onFavorite: (provider: Provider, favoriteModels: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>();
  const [query, setQuery] = useState("");
  const [more, setMore] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number }>();
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setQuery("");
    setMore(false);
  };
  const box = useDismiss<HTMLDivElement>(open, close, placement === "down" ? popRef : undefined);
  // Where the app's own load of the providers stands, so "not answered yet" and "couldn't reach it" never read as "none set up".
  const app = useContext(Ctx);
  const loadState = providers ? "ready" : (app?.providersStatus ?? (app?.providers ? "ready" : "loading"));

  const rail = providers?.connector.configured ? providers.providers.filter(onRail) : [];
  const shown = providers?.connector.configured ? shownChoice(rail, picked, turnKind) : undefined;
  const effortsCount = shown?.provider.efforts.length ?? 0;

  useLayoutEffect(() => {
    if (!open || placement !== "down") return;
    function position() {
      const chip = chipRef.current;
      if (!chip) return;
      const rect = chip.getBoundingClientRect();
      const vw = window.innerWidth || 1024;
      const vh = window.innerHeight || 768;
      const pop = popRef.current;
      const popW = pop?.offsetWidth || (effortsCount > 0 ? 640 : 460);
      const popH = pop?.offsetHeight || 360;
      const maxLeft = Math.max(8, vw - popW - 8);
      const left = Math.min(Math.max(8, rect.left), maxLeft);
      const below = rect.bottom + 8;
      const above = rect.top - 8 - popH;
      const top = below + popH <= vh - 8 || above < 8 ? Math.max(8, below) : Math.max(8, above);
      setCoords({ top, left });
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, placement, shown?.provider.id, effortsCount]);

  if (!providers && app && loadState === "failed") {
    return (
      <button type="button" className="mp-chip warn" onClick={() => app.retryProviders?.()}>
        <span className="dot warn" aria-hidden="true" />
        <span>Couldn't reach the engine. Try again.</span>
      </button>
    );
  }
  if (!providers && app && loadState === "loading") {
    return (
      <span className="mp-chip quiet" role="status">
        Looking for your agents…
      </span>
    );
  }
  if (!providers?.connector.configured) return null;
  if (!providers.connector.reachable || !shown || !rail.some(usable)) {
    return (
      <Link className="mp-chip warn" to="/settings#providers">
        <span className="dot warn" aria-hidden="true" />
        <span>{providers.connector.reachable ? "Set up a provider" : "Your agent can't be reached"}</span>
      </Link>
    );
  }
  const effortNow = shownEffort(shown.provider, effort, turnKind);
  const defaultEffortId = turnKind === "work" ? (shown.provider.workDefaultEffort ?? shown.provider.defaultEffort) : shown.provider.defaultEffort;
  const current = tab ?? shown.provider.id;
  const tabProvider = rail.find((p) => p.id === current);
  const all = rail.flatMap(choices);
  const q = query.trim().toLowerCase();
  const list: Choice[] = q
    ? all.filter((c) => `${c.label} ${c.model?.id ?? ""} ${c.provider.label} ${makerOf(c)?.label ?? ""}`.toLowerCase().includes(q))
    : current === FAVORITES
      ? all.filter((c) => c.model?.favorite)
      : tabProvider
        ? choices(tabProvider)
        : [];
  const cut = !q && !more && list.length > FEW + 1;
  const rows = cut ? list.slice(0, FEW) : list;
  const needsSetup = !q && tabProvider && !usable(tabProvider) ? tabProvider : undefined;

  function star(c: Choice) {
    if (!c.model) return;
    const now = c.provider.models.filter((m) => m.favorite).map((m) => m.id);
    onFavorite(c.provider, c.model.favorite ? now.filter((id) => id !== c.model!.id) : [...now, c.model.id]);
  }

  const chipAria =
    turnKind === "work"
      ? `Model and effort: ${shown.provider.label}, ${shown.label}${effortNow ? `, ${effortNow.label}` : ""}. Change`
      : `Who answers: ${shown.provider.label}, ${shown.label}${effortNow ? `, ${effortNow.label}` : ""}. Change`;
  const chipTitle =
    turnKind === "work"
      ? `Made with your own ${shown.provider.label} (${shown.label}). Click to pick another model or effort.`
      : `Answered by your own ${shown.provider.label} (${shown.label}). Click to see why and to pick another.`;
  const dialogAria = turnKind === "work" ? "Model and effort" : "Who answers this chat";
  const sayText =
    turnKind === "work"
      ? `Made by your own ${shown.provider.label}, signed in on this computer. A stronger model and higher effort usually give a better result, take longer, and use more of your plan.`
      : `This chat is answered by your own ${shown.provider.label}, signed in on this computer. A stronger model thinks longer and uses more of your plan, so the quick one is the usual pick. Choose another here to change who answers.`;

  const pop = open && (
    <div
      ref={placement === "down" ? popRef : undefined}
      className={`mp-pop${placement === "down" ? " down" : ""}`}
      role="dialog"
      aria-label={dialogAria}
      style={placement === "down" && coords ? { top: coords.top, left: coords.left } : undefined}
    >
      <p className="mp-say">{sayText}</p>
      <div className="mp-rail" role="tablist" aria-label="Providers">
        <button type="button" role="tab" aria-selected={current === FAVORITES} aria-label="Favorites" title="Favorites" className={current === FAVORITES ? "on" : ""} onClick={() => setTab(FAVORITES)}>
          <Icon name="star" />
        </button>
        {rail.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={current === p.id}
            aria-label={usable(p) ? p.label : `${p.label}: ${said(p)}`}
            title={usable(p) ? p.label : `${p.label}: ${said(p)}`}
            className={`${current === p.id ? "on" : ""}${usable(p) ? "" : " dim"}`}
            onClick={() => setTab(p.id)}
          >
            <ProviderMark mark={p.mark} label={p.label} size={20} dim={!usable(p)} />
          </button>
        ))}
      </div>
      <div className="mp-list">
        <label className="mp-search">
          <Icon name="search" />
          <input autoFocus type="search" placeholder="Search models…" aria-label="Search models" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="mp-rows" role="listbox" aria-label="Models">
          {rows.map((c) => (
            <div key={c.pick} className={`mp-row${c.pick === shown.pick ? " on" : ""}`}>
              <button
                type="button"
                role="option"
                aria-selected={c.pick === shown.pick}
                className="mp-pick"
                onClick={() => {
                  close();
                  if (c.pick !== shown.pick) onPick(c.pick);
                }}
              >
                <ProviderMark mark={choiceMark(c)} label={c.provider.label} size={15} />
                <span>{c.label}</span>
                {(q || current === FAVORITES) && <small>{c.provider.label}</small>}
                {c.pick === shown.pick && <Icon name="check" />}
              </button>
              {c.model && (
                <button
                  type="button"
                  className={`mp-star${c.model.favorite ? " on" : ""}`}
                  aria-pressed={c.model.favorite}
                  aria-label={`${c.model.favorite ? "Unstar" : "Star"} ${c.label}`}
                  onClick={() => star(c)}
                >
                  <Icon name="star" />
                </button>
              )}
            </div>
          ))}
          {cut && (
            <button type="button" className="mp-more" onClick={() => setMore(true)}>
              Show more
            </button>
          )}
          {needsSetup ? (
            <div className="mp-setup">
              <p>{said(needsSetup)}</p>
              <Link to={`/settings?provider=${encodeURIComponent(needsSetup.id)}#providers`} onClick={close}>
                Open provider setup
              </Link>
            </div>
          ) : (
            rows.length === 0 && <p className="mp-empty">{q ? `No model matches “${query.trim()}”.` : current === FAVORITES ? "No favorites yet. Star a model to keep it here." : "No models shown. Pick which show in Settings."}</p>
          )}
        </div>
      </div>
      {shown.provider.efforts.length > 0 && (
        <div className="mp-effort" role="listbox" aria-label="Effort">
          <div className="mp-h">
            <span>Effort</span>
            <small>{shown.label}</small>
          </div>
          {shown.provider.efforts.map((e) => (
            <button
              key={e.id}
              type="button"
              role="option"
              aria-selected={e.id === effortNow?.id}
              className={e.id === effortNow?.id ? "on" : ""}
              onClick={() => e.id !== effortNow?.id && onEffort(e.id)}
            >
              <span>{e.label}</span>
              {e.id === defaultEffortId && <small>default</small>}
              {e.id === effortNow?.id && <Icon name="check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="mp" ref={box}>
      <button
        ref={chipRef}
        type="button"
        className="mp-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={chipAria}
        title={chipTitle}
        disabled={disabled}
        onClick={() => (open ? close() : (setTab(undefined), setOpen(true)))}
      >
        <ProviderMark mark={shown.provider.mark} label={shown.provider.label} size={15} />
        {shown.label !== shown.provider.label && <span className="mp-who">{shown.provider.label}</span>}
        <span className="mp-name">{shown.label}</span>
        {effortNow && <span className="mp-eff">{effortNow.label}</span>}
        <Icon name="down" />
      </button>
      {pop && (placement === "down" ? createPortal(pop, document.body) : pop)}
    </div>
  );
}
