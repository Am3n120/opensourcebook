import { useState } from "react";
import { Icon } from "../../design/Icon";
import { Inline } from "../inline";
import type { Response } from "../quizGrade";
import type { PieceProps } from "./piece";
import { ordinal } from "./rules";

const orderOf = (r: Response | undefined) => (r as { order?: number[] } | undefined)?.order;

/**
 * Put in order: the items start in the order the quiz chose, never the
 * right one; the person moves them up and down, then checks. Once checked,
 * each item in its right place is ticked, and each one that is not says
 * where it goes.
 */
export function Order({ q, response, reveal, onAnswer }: PieceProps) {
  const items = q.items ?? [];
  const given = orderOf(response);
  const [now, setNow] = useState<number[]>(() => (q.shown?.length === items.length ? q.shown : items.map((_, i) => i)));
  const shown = given ?? now;
  const move = (i: number, by: number) => {
    const next = [...now];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    setNow(next);
  };
  return (
    <div className="qkind">
      <ol className="order" aria-label="Your order">
        {shown.map((k, i) => {
          const state = given && reveal ? (k === i ? "right" : "wrong") : "";
          return (
            <li key={k} className={state}>
              <span className="n" aria-hidden="true">
                {i + 1}
              </span>
              <span className="t">
                <Inline text={items[k] ?? ""} />
              </span>
              {state === "right" && <Icon name="check" />}
              {state === "wrong" && <small className="goes">goes {ordinal(k + 1)}</small>}
              {!given && (
                <span className="mv">
                  <button type="button" aria-label={`Move up: ${items[k]}`} disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" aria-label={`Move down: ${items[k]}`} disabled={i === now.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {!given && (
        <button className="btn small" type="button" onClick={() => onAnswer({ order: now })}>
          Check the order
        </button>
      )}
    </div>
  );
}
