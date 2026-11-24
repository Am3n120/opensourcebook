import { LETTERS, type PieceProps } from "./piece";

/** One right option among several: tap it, or press its letter. */
export function Choice({ q, response, reveal: afterEach, onAnswer }: PieceProps) {
  const picked = (response as { choice?: number } | undefined)?.choice;
  // Right and wrong show once an option is picked, when the quiz gives feedback after each question.
  const reveal = afterEach && picked !== undefined;
  const onPick = (i: number) => onAnswer({ choice: i });
  return (
    <div className="qopts" role="group" aria-label="Options">
      {(q.options ?? []).map((o, i) => {
        const cls = reveal ? (i === q.answer ? " right" : i === picked ? " wrong" : "") : i === picked ? " on" : "";
        return (
          <button key={i} type="button" className={`qo${cls}`} disabled={reveal} aria-pressed={i === picked} onClick={() => onPick(i)}>
            <span className="k">{LETTERS[i]}</span>
            <span className="ot">{o}</span>
          </button>
        );
      })}
    </div>
  );
}
