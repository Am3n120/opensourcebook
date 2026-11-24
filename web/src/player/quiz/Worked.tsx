import { useState } from "react";
import { entryBoxes, stepRight, type EntryStep } from "../quizGrade";
import { LETTERS, type PieceProps } from "./piece";
import type { WorkedResponse } from "./rules";

/** The answer a typed step takes, as the person would write it: "52.5 cm". */
function answerText(s: EntryStep): string {
  return `${entryBoxes(s)
    .map((answers) => answers[0])
    .join(", ")}${s.unit ? ` ${s.unit}` : ""}`;
}

/**
 * A worked problem: each step is checked before the next opens; a hint or a
 * reveal is there when stuck. A typed step is one box, with its unit beside
 * it and the shape its answer takes under it. Showing a step costs that step,
 * and the step says so.
 */
export function Worked({ q, response, reveal, onAnswer: onChange }: PieceProps) {
  const value = response as WorkedResponse | undefined;
  const steps = q.steps ?? [];
  const given = value?.steps ?? [];
  const [draft, setDraft] = useState<string[]>([]);
  const open = given.filter((s) => (s as { checked?: boolean }).checked).length;
  function check(i: number, v: number | string[], revealed = false) {
    const next = [...given];
    next[i] = { value: v, ...(revealed ? { revealed: true } : {}), checked: true } as WorkedResponse["steps"][number];
    setDraft([]);
    onChange({ steps: next });
  }
  return (
    <ol className="qsteps">
      {steps.map((s, i) => {
        const g = given[i] as (WorkedResponse["steps"][number] & { checked?: boolean }) | undefined;
        if (i > open) return null;
        const done = g?.checked === true;
        const shown = g?.revealed === true;
        const ok = done && !shown && stepRight(s, g?.value);
        const boxes = s.input === "entries" ? entryBoxes(s) : [];
        return (
          <li key={i} className={done ? (ok ? "right" : shown ? "shown" : "wrong") : ""}>
            <p>{s.prompt}</p>
            {s.input === "choice" ? (
              <div className="qopts small">
                {s.options.map((o, k) => (
                  <button key={k} type="button" className={`qo${done ? (k === s.answer ? " right" : k === g?.value ? " wrong" : "") : ""}`} disabled={done} onClick={() => check(i, k)}>
                    <span className="k">{LETTERS[k]}</span>
                    <span className="ot">{o}</span>
                  </button>
                ))}
              </div>
            ) : (
              <form
                className="qentries"
                onSubmit={(e) => {
                  e.preventDefault();
                  check(i, boxes.map((_, k) => draft[k] ?? ""));
                }}
              >
                {boxes.map((_, k) => (
                  <span key={k} className="qbox">
                    <input
                      className="ipt"
                      // The next step's box takes the typing once the one before is checked.
                      autoFocus={!done && k === 0 && i > 0 && i === open}
                      inputMode={/^-?[\d.,/ ]+$/.test(boxes[k]![0] ?? "") ? "decimal" : "text"}
                      aria-label={boxes.length === 1 ? `Step ${i + 1} answer` : `Step ${i + 1} answer ${k + 1}`}
                      disabled={done}
                      value={done ? (shown ? "" : ((g?.value as string[])[k] ?? "")) : (draft[k] ?? "")}
                      onChange={(e) => {
                        const d = [...draft];
                        d[k] = e.target.value;
                        setDraft(d);
                      }}
                    />
                    {s.unit && <span className="unit">{s.unit}</span>}
                  </span>
                ))}
                {!done && (
                  <button className="btn small" type="submit">
                    Check
                  </button>
                )}
              </form>
            )}
            {s.input === "entries" && s.form && !done && <small className="d">{s.form}</small>}
            {done && ok && <small className="d">Right.</small>}
            {done && shown && (
              <small className="d">
                Shown: <b>{s.input === "choice" ? s.options[s.answer] : answerText(s)}</b>. This step doesn&apos;t count; the others still do.
              </small>
            )}
            {done && !shown && !ok && reveal && (
              <small className="d">
                Not quite. The answer: <b>{s.input === "choice" ? s.options[s.answer] : answerText(s)}</b>.
              </small>
            )}
            {!done && (
              <span className="qhelp">
                {s.hint && <small className="d">Hint: {s.hint}</small>}
                <button className="link small" type="button" onClick={() => check(i, s.input === "choice" ? -1 : boxes.map(() => ""), true)}>
                  Show this step (it won&apos;t count)
                </button>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
