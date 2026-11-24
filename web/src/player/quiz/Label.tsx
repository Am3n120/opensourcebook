import { useState } from "react";
import { mediaUrl } from "../media";
import { nameRight, type Response } from "../quizGrade";
import type { PieceProps } from "./piece";

const labelsOf = (r: Response | undefined) => (r as { labels?: Array<number | null> } | undefined)?.labels;

/**
 * Label a picture: the picture from the source with its own marks, and for
 * each mark a pick among the names offered. Once checked, a wrong name shows
 * the right one beside it. A picture Open Sourcebook does not keep is not drawn; its
 * marks can still be named from the caption.
 */
export function Label({ q, response, reveal, onAnswer }: PieceProps) {
  const marks = q.marks ?? [];
  const names = q.names ?? [];
  const given = labelsOf(response);
  const [chosen, setChosen] = useState<Array<number | null>>(() => marks.map(() => null));
  const shown = given ?? chosen;
  const all = chosen.every((k) => k !== null);
  const src = mediaUrl(q.picture?.url);
  const caption = q.picture?.caption;
  return (
    <div className="qkind">
      <figure className="qpic">
        {src && <img src={src} alt={caption ?? `A picture with the marks ${marks.map((m) => m.mark).join(", ")}`} />}
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
      <div className="match">
        {marks.map((m, i) => {
          const name = shown[i] === null || shown[i] === undefined ? undefined : names[shown[i]!];
          return (
            <label key={i} className={given && reveal ? (nameRight(m, name) ? "right" : "wrong") : ""}>
              <span className="mark">{m.mark}</span>
              <select
                aria-label={`What ${m.mark} is`}
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
                {names.map((n, k) => (
                  <option key={k} value={k}>
                    {n}
                  </option>
                ))}
              </select>
              {given && reveal && !nameRight(m, name) && <small>{m.answer}</small>}
            </label>
          );
        })}
      </div>
      {!given && (
        <button className="btn small" type="button" disabled={!all} onClick={() => onAnswer({ labels: chosen })}>
          Check
        </button>
      )}
    </div>
  );
}
