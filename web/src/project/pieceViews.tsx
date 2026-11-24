import { useState, type ReactNode } from "react";
import type { Cite, Cited, CodePiece, HeadingPiece, ListPiece, MathPiece, Message, NotePiece, PlanPiece, QuestionPiece, Source, TablePiece, TextPiece } from "../api/types";
import { Inline } from "../player/inline";
import { quoteWords } from "../player/inlineMarks";
import { TeX } from "../player/TeX";
import type { PieceProps } from "./pieces";

/**
 * The citation chips at the end of a block, list item or table row, each
 * opening the exact spot. Pointing at a chip (or tabbing to it) shows which
 * source it is and the words it quotes, in a small card kept inside the
 * window. Chips are left out of copied text.
 */
export function Cites({ of, message, sourceById, citeNumber, onOpenCite }: { of: Cited } & Pick<PieceProps, "message" | "sourceById" | "citeNumber" | "onOpenCite">) {
  const cites = message.cites ?? [];
  const shown = (of.cites ?? []).filter((c) => cites[c]);
  if (shown.length === 0 && !of.unchecked) return null;
  return (
    <span className="cites" data-copy="skip">
      {shown.map((c) => (
        <CiteChip key={c} index={c} cite={cites[c]!} number={citeNumber.get(c)} message={message} sourceById={sourceById} onOpenCite={onOpenCite} />
      ))}
      {of.unchecked && (
        <small className="unchecked" title="This cited your sources, but the quote wasn't found word for word, so it isn't shown as cited.">
          not checked against your sources
        </small>
      )}
    </span>
  );
}

function CiteChip({ index, cite, number, message, sourceById, onOpenCite }: { index: number; cite: Cite; number: number | undefined; message: Message; sourceById: Map<string, Source>; onOpenCite: (cite: Cite, n?: number) => void }) {
  const [tip, setTip] = useState<{ x: number; y: number; below: boolean }>();
  const source = sourceById.get(cite.sourceId);
  const name = source ? source.title : "a source";
  const quote = cite.quote ? quoteWords(cite.quote) : "";
  const tipId = `cite-${message.id}-${index}`;
  const show = (e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const below = r.top < 160;
    setTip({ x: Math.min(Math.max(r.left + r.width / 2, 156), window.innerWidth - 156), y: below ? r.bottom + 8 : r.top - 8, below });
  };
  const hide = () => setTip(undefined);
  return (
    <>
      <button
        type="button"
        className="cite"
        aria-label={`Source ${number}: ${name}`}
        aria-describedby={tip ? tipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => {
          hide();
          onOpenCite(cite, number);
        }}
      >
        {number}
      </button>
      {tip && (
        <span id={tipId} role="tooltip" className={`citetip${tip.below ? " below" : ""}`} style={{ left: tip.x, top: tip.y }}>
          <b>{name}</b>
          {cite.locator?.page !== undefined && <small> · p. {cite.locator.page}</small>}
          {quote && <q>{quote}</q>}
          <small className="go">Click to open the spot</small>
        </span>
      )}
    </>
  );
}

/** Words with their inline marks; words linked to a cited spot open it. */
export function Words({ text, message, onOpenCite }: { text: string } & Pick<PieceProps, "message" | "onOpenCite">) {
  const cites = message.cites ?? [];
  return (
    <Inline
      text={text}
      spot={(c, words, key) => {
        const cite = cites[c];
        if (!cite) return words;
        return (
          <button key={key} type="button" className="spot" title="Open the spot in your source" onClick={() => onOpenCite(cite)}>
            {words}
          </button>
        );
      }}
    />
  );
}

/** A paragraph, its cites at its end. */
export function TextPieceView(props: PieceProps<TextPiece>) {
  const { piece } = props;
  return (
    <p className="blk">
      <Words text={piece.text} {...props} />
      <Cites of={piece} {...props} />
    </p>
  );
}

export function HeadingPieceView({ piece }: PieceProps<HeadingPiece>) {
  return <h3 className="blk hd3">{piece.text}</h3>;
}

/** A list; each item ends with its own cites, and the last also with the list's. */
export function ListPieceView(props: PieceProps<ListPiece>) {
  const { piece } = props;
  const items = Array.isArray(piece.items) ? piece.items : [];
  const Tag = piece.ordered ? "ol" : "ul";
  return (
    <Tag className="blk lst">
      {items.map((item, k) => (
        <li key={k}>
          <Words text={item.text} {...props} />
          <Cites of={item} {...props} />
          {k === items.length - 1 && <Cites of={piece} {...props} />}
        </li>
      ))}
    </Tag>
  );
}

/** A table that scrolls sideways on its own when it is wider than the reply; each row ends with its cites. */
export function TablePieceView(props: PieceProps<TablePiece>) {
  const { piece } = props;
  const header = Array.isArray(piece.header) ? piece.header : [];
  const rows = Array.isArray(piece.rows) ? piece.rows : [];
  return (
    <div className="blk tbl" role="region" aria-label="Table" tabIndex={0}>
      <table>
        <thead>
          <tr>
            {header.map((cell, k) => (
              <th key={k} scope="col">
                <Words text={cell} {...props} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.cells.map((cell, k) => (
                <td key={k}>
                  <Words text={cell} {...props} />
                  {k === row.cells.length - 1 && <Cites of={row} {...props} />}
                  {k === row.cells.length - 1 && r === rows.length - 1 && <Cites of={piece} {...props} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NotePieceView(props: PieceProps<NotePiece>) {
  const { piece } = props;
  return (
    <div className="blk callout" role="note">
      <Words text={piece.text} {...props} />
      <Cites of={piece} {...props} />
    </div>
  );
}

export function MathPieceView(props: PieceProps<MathPiece>) {
  const { piece } = props;
  return (
    <div className="blk mathb">
      <TeX source={piece.text} display />
      <Cites of={piece} {...props} />
    </div>
  );
}

/** What the writer added that the sources do not say: marked as such, never cited. */
export function BackgroundPieceView(props: PieceProps) {
  const { piece } = props;
  return (
    <div className="blk bg" role="note" aria-label="Background, not from your sources">
      <span className="bgtag">Background · not from your sources</span>
      <Words text={String(piece.text ?? "")} {...props} />
    </div>
  );
}

export function CodePieceView({ piece }: PieceProps<CodePiece>) {
  return (
    <pre className="blk codeb" data-lang={piece.lang}>
      <code>{piece.text}</code>
    </pre>
  );
}

/** What a change did to a plan, and the plan card when this is the newest piece about it. */
export function PlanPieceView({ piece, planCard }: PieceProps<PlanPiece>) {
  return (
    <>
      {!piece.made && piece.changes && piece.changes.length > 0 && (
        <ul className="changes" aria-label="What changed">
          {piece.changes.map((c, k) => (
            <li key={k}>{c}</li>
          ))}
        </ul>
      )}
      {planCard(piece)}
    </>
  );
}

/** A question with options to pick. The person can always type an answer instead. */
export function QuestionPieceView({ piece, picked, answered, onPick, disabled }: PieceProps<QuestionPiece>) {
  const on = picked(piece);
  return (
    <div className="ask" role="group" aria-label={piece.text}>
      <div className="q">{piece.text}</div>
      {piece.options.length > 0 && (
        <div className="picks">
          {piece.options.map((o) => (
            <button key={o.id} type="button" className={`pick${on.includes(o.id) ? " on" : ""}`} aria-pressed={on.includes(o.id)} disabled={disabled || Boolean(answered)} onClick={() => onPick(piece, o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      )}
      {piece.multiple && !answered && <small className="muted">Pick any that fit.</small>}
    </div>
  );
}

/** A kind of piece this app does not know yet: its words if it has them, else a plain note. Never dropped. */
export function UnknownPieceView({ piece }: PieceProps): ReactNode {
  return typeof piece.text === "string" ? <p className="blk plain">{piece.text}</p> : <p className="blk muted">This part of the reply can't be shown here yet.</p>;
}
