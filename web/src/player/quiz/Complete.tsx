import { useState } from "react";
import { Inline } from "../inline";
import { gapRight, lineParts, type Response } from "../quizGrade";
import type { PieceProps } from "./piece";

const gapsOf = (r: Response | undefined) => (r as { gaps?: string[] } | undefined)?.gaps;

type Part = { text: string } | { gap: number; answers: string[] };

/** Each line's parts, every gap numbered in reading order. */
function numbered(source: string[]): { lines: Part[][]; count: number } {
  const lines: Part[][] = [];
  let count = 0;
  for (const line of source) lines.push(lineParts(line).map((part) => ("text" in part ? part : { gap: count++, answers: part.answers })));
  return { lines, count };
}

/**
 * Fill in the working: the lines of a worked solution, each gap a box to
 * type in, checked together. Once checked, a wrong gap shows its answer
 * beside it.
 */
export function Complete({ q, response, reveal, onAnswer }: PieceProps) {
  const given = gapsOf(response);
  const [draft, setDraft] = useState<string[]>([]);
  const { lines, count } = numbered(q.lines ?? []);
  return (
    <form
      className="qkind"
      onSubmit={(e) => {
        e.preventDefault();
        if (!given) onAnswer({ gaps: Array.from({ length: count }, (_, i) => draft[i] ?? "") });
      }}
    >
      <ol className="qwork">
        {lines.map((parts, i) => (
          <li key={i}>
            {parts.map((part, k) => {
              if ("text" in part) return <Inline key={k} text={part.text} />;
              const value = given ? (given[part.gap] ?? "") : (draft[part.gap] ?? "");
              const ok = gapRight(part.answers, value);
              return (
                <span key={k} className={`qgap${given && reveal ? (ok ? " right" : " wrong") : ""}`}>
                  <input
                    className="ipt"
                    aria-label={`Gap ${part.gap + 1}`}
                    inputMode={/^-?[\d.,/ ]+$/.test(part.answers[0] ?? "") ? "decimal" : "text"}
                    size={Math.max(3, Math.min(14, (part.answers[0] ?? "").length + 1))}
                    disabled={!!given}
                    value={value}
                    onChange={(e) => {
                      const next = [...draft];
                      next[part.gap] = e.target.value;
                      setDraft(next);
                    }}
                  />
                  {given && reveal && !ok && <small>{part.answers[0]}</small>}
                </span>
              );
            })}
          </li>
        ))}
      </ol>
      {!given && (
        <button className="btn small" type="submit" disabled={draft.every((v) => !v?.trim())}>
          Check
        </button>
      )}
    </form>
  );
}
