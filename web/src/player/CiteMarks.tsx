import { useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { citeLink } from "./progress";
import type { Cite } from "./blockData";
import { quoteWords } from "./inlineMarks";

/** Opens a cited spot where the player is shown (a project opens it beside the Studio); without it a mark is a link. */
export type OpenCite = (cite: Cite) => void;

/**
 * One cite as a small number at the claim it supports, as the chat shows
 * them: pointing at it (or tabbing to it) shows the source and the words it
 * quotes; clicking opens the source at those words.
 */
export function CiteMark({ n, cite, name, onOpen }: { n: number; cite: Cite; name: string; onOpen?: OpenCite | undefined }) {
  const [tip, setTip] = useState<{ x: number; y: number; below: boolean }>();
  const show = (e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const below = r.top < 160;
    setTip({ x: Math.min(Math.max(r.left + r.width / 2, 156), window.innerWidth - 156), y: below ? r.bottom + 8 : r.top - 8, below });
  };
  const hide = () => setTip(undefined);
  const page = cite.locator?.page;
  const quote = cite.quote ? quoteWords(cite.quote) : "";
  const label = `Source ${n}: ${name}${quote ? `, “${quote}”` : ""}`;
  const events = { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide };
  return (
    <>
      {onOpen ? (
        <button
          type="button"
          className="pcite"
          aria-label={label}
          {...events}
          onClick={(e) => {
            e.stopPropagation();
            hide();
            onOpen(cite);
          }}
        >
          {n}
        </button>
      ) : (
        <Link className="pcite" to={citeLink(cite.sourceId, cite.quote, cite.locator)} aria-label={label} {...events} onClick={(e) => e.stopPropagation()}>
          {n}
        </Link>
      )}
      {tip &&
        createPortal(
          <span role="tooltip" className={`pcitetip${tip.below ? " below" : ""}`} style={{ left: tip.x, top: tip.y }}>
            <b>{name}</b>
            {page !== undefined && <small> · p. {page}</small>}
            {quote && <q>{quote}</q>}
            <small className="go">Click to open the spot</small>
          </span>,
          document.body,
        )}
    </>
  );
}

/** The marks for some cites, side by side. */
export function CiteMarks({ marks, names, onOpen }: { marks: Array<{ cite: Cite; n: number }>; names: Map<string, string>; onOpen?: OpenCite | undefined }) {
  if (marks.length === 0) return null;
  return (
    <span className="pcites" data-copy="skip">
      {marks.map(({ cite, n }) => (
        <CiteMark key={n} n={n} cite={cite} name={names.get(cite.sourceId) ?? "a source"} onOpen={onOpen} />
      ))}
    </span>
  );
}
