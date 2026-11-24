import { useState } from "react";
import { Inline } from "../inline";
import type { Response } from "../quizGrade";
import type { PieceProps } from "./piece";

const matchesOf = (r: Response | undefined) => (r as { matches?: Array<number | null> } | undefined)?.matches;

/**
 * Match pairs: each thing on the left takes one of the rights, offered in
 * the order the quiz chose; once all are picked the person checks. Once
 * checked, a wrong match shows the right one under it.
 */
export function Match({ q, response, reveal, onAnswer }: PieceProps) {
  const pairs = q.pairs ?? [];
  const rights = q.rights?.length === pairs.length ? q.rights : pairs.map((_, i) => i);
  const given = matchesOf(response);
  const [chosen, setChosen] = useState<Array<number | null>>(() => pairs.map(() => null));
  const shown = given ?? chosen;
  const all = chosen.every((k) => k !== null);
  return (
    <div className="qkind">
      <div className="match">
        {pairs.map((p, i) => (
          <label key={i} className={given && reveal ? (shown[i] === i ? "right" : "wrong") : ""}>
            <span>
              <Inline text={p.left} />
            </span>
            <select
              aria-label={`Match for ${p.left}`}
              value={shown[i] ?? ""}
              disabled={!!given}
              onChange={(e) => {
                const next = [...chosen];
                next[i] = Number(e.target.value);
                setChosen(next);
              }}
            >
              <option value="" disabled>
                Pick…
              </option>
              {rights.map((k) => (
                <option key={k} value={k}>
                  {pairs[k]!.right}
                </option>
              ))}
            </select>
            {given && reveal && shown[i] !== i && <small>{p.right}</small>}
          </label>
        ))}
      </div>
      {!given && (
        <button className="btn small" type="button" disabled={!all} onClick={() => onAnswer({ matches: chosen })}>
          Check
        </button>
      )}
    </div>
  );
}
