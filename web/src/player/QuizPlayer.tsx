import { useEffect, useRef, useState } from "react";
import type { Json } from "../api/types";
import { OutlineButton, PrimaryButton } from "../design/Buttons";
import { becauseWords, branchesTaken } from "./branches";
import { useKindLabel, useStageTint } from "./look";
import type { PlayerProps } from "./players";
import { numberCites } from "./blockData";
import { CiteMarks } from "./CiteMarks";
import { isNumber, progressField } from "./progress";
import { useSwipe } from "./swipe";
import { verdictWord, withoutVerdict } from "./verdict";
import { TeX } from "./TeX";
import { asQuiz, gradeQuiz, outcomeOf, type Outcome, type Question, type Quiz, type Responses } from "./quizGrade";
import { pieceOf } from "./quiz/pieces";
import { clockNow, clockWords, minutesWords, msLeft, timing, warningFor } from "./quizClock";
import { useChrome } from "./useChrome";
import "./stage.css";
import "./quiz.css";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isResponses = (v: unknown): v is Responses => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A quiz (engine quiz payload, version 1): one question at a time on the
 * screen the player is given, with nothing else on it. Feedback after each
 * answer or at the end, as the quiz says. The end is the result: the score
 * against the pass mark and what was missed, and the graded result goes with
 * the done tick, so a branch can read the score. From there the quiz starts
 * again, or each question is shown again with its answer.
 *
 * A quiz with a time limit opens on a Start screen; the clock runs from
 * Start, here or while the person is elsewhere, and at zero the quiz ends as
 * it stands. Once it has ended its answers are fixed, and looking back
 * through it shows each one's feedback.
 */
export function QuizPlayer({ output, sources, active = true, record, done, progress, keep, here, aboutHere, onOpenCite, branches }: PlayerProps) {
  const quiz = asQuiz(output.payload);
  const tint = useStageTint(output.type);
  // It opens where the person stopped, here or on another device: the question, the answers given, the result.
  const [at, setAt] = useState(() => Math.max(0, Math.min(quiz.questions.length - 1, Math.floor(progressField(progress, "at", isNumber) ?? 0))));
  const [responses, setResponses] = useState<Responses>(() => progressField(progress, "responses", isResponses) ?? {});
  const limit = quiz.timeLimit;
  const [startedAt, setStartedAt] = useState(() => (limit ? progressField(progress, "startedAt", isNumber) : undefined));
  const [now, setNow] = useState(() => clockNow());
  // Reopened after its time ran out, here or elsewhere: it ended at the limit.
  const [endedAt, setEndedAt] = useState(() => {
    const kept = limit ? progressField(progress, "endedAt", isNumber) : undefined;
    if (kept !== undefined || startedAt === undefined || !limit) return kept;
    return msLeft(startedAt, limit, clockNow()) === 0 ? startedAt + limit * 60_000 : undefined;
  });
  const [ended, setEnded] = useState(() => (progressField(progress, "ended", isBoolean) ?? false) || (endedAt !== undefined && progressField(progress, "endedAt", isNumber) === undefined));
  const clock = { ...(startedAt !== undefined ? { startedAt } : {}), ...(endedAt !== undefined ? { endedAt } : {}) };
  const kept = useRef(JSON.stringify({ at, responses, ended, ...clock }));
  useEffect(() => {
    const now = JSON.stringify({ at, responses, ended, ...clock });
    if (now === kept.current) return;
    kept.current = now;
    keep?.({ at, responses: responses as Json, ended, ...clock });
  });
  // The clock ticks while it runs, and at zero the quiz ends as it stands.
  const running = limit !== undefined && startedAt !== undefined && endedAt === undefined;
  const left = running ? msLeft(startedAt, limit, now) : undefined;
  useEffect(() => {
    if (!running) return;
    const deadline = startedAt + limit * 60_000;
    const tick = window.setInterval(() => {
      const t = clockNow();
      setNow(t);
      if (t < deadline) return;
      setEndedAt(deadline);
      setEnded(true);
    }, 1_000);
    return () => window.clearInterval(tick);
  }, [running, startedAt, limit]);
  // Looking back at the answers from the result: each question with its answer and feedback, nothing to change.
  const [looking, setLooking] = useState(false);
  // Each run through the quiz from the start; its end is recorded once.
  const [sitting, setSitting] = useState(0);
  const recordedFor = useRef(ended && done ? 0 : -1);
  useEffect(() => {
    if (!ended || !record || recordedFor.current === sitting) return;
    recordedFor.current = sitting;
    const graded = gradeQuiz(quiz, responses);
    // A timed quiz's result keeps the time it took and whether the time ran out.
    const time = limit !== undefined && startedAt !== undefined && endedAt !== undefined ? timing(startedAt, endedAt, limit) : undefined;
    record((time ? { ...graded, ...time } : graded) as Json);
  });
  // Waiting for Start; and, once a timed quiz has ended, its answers are fixed and each shows its feedback.
  const waiting = limit !== undefined && startedAt === undefined && !ended;
  const locked = (limit !== undefined && endedAt !== undefined) || looking;
  // Where the person is, for a thread on the quiz: the question and the answers given, as it is kept.
  useEffect(() => {
    here?.({ at, responses: responses as Json, ended });
  }, [at, responses, ended, here]);
  const names = new Map(sources.map((s) => [s.id, s.name]));
  const count = quiz.questions.length;
  const q = quiz.questions[at];
  const piece = q ? pieceOf(q.kind) : undefined;
  const kind = useKindLabel(output.type, q?.kind);
  const answered = q && piece ? responses[q.id] !== undefined && (piece.done ? piece.done(q, responses[q.id]) : true) : false;
  const reveal = quiz.feedback === "afterEach" || locked;
  useChrome(quiz.questions.length > 0 ? { progress: ended ? 1 : waiting ? 0 : (at + (answered ? 1 : 0)) / quiz.questions.length } : {});
  const showFeedback = (quiz.feedback === "afterEach" && answered) || locked;
  // Feedback that lands below the card's fold is brought into view, with the button to go on.
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showFeedback && active && feedback.current) bringIntoView(feedback.current);
  }, [showFeedback, active, at]);

  function finish() {
    setEnded(true);
    if (running) setEndedAt(Math.min(clockNow(), startedAt + limit * 60_000));
  }
  function again() {
    setResponses({});
    setAt(0);
    setLooking(false);
    setStartedAt(undefined);
    setEndedAt(undefined);
    setEnded(false);
    setSitting((n) => n + 1);
  }
  function advance() {
    if (at + 1 < count) setAt(at + 1);
    else finish();
  }
  const canGo = answered || locked;
  function answer(r: Responses[string]) {
    if (q && !locked) setResponses({ ...responses, [q.id]: r });
  }
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      if (e.key === "ArrowRight" && canGo && !ended && !waiting) advance();
      else if (q && piece?.key && !answered && !locked && !waiting && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const r = piece.key(q, e.key);
        if (!r) return;
        answer(r);
      } else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Sideways through the questions: on once this one is answered, back any time.
  const swipe = useSwipe(
    () => canGo && !ended && !waiting && advance(),
    () => !ended && !waiting && at > 0 && setAt(at - 1),
  );

  if (count === 0)
    return (
      <div className="pstage qz" style={tint}>
        <div className="pstage-in">
          <p className="qznone">This quiz has no questions.</p>
        </div>
      </div>
    );
  const outcomes: Outcome[] = quiz.questions.map((x) => outcomeOf(x, responses[x.id]));
  const right = outcomes.filter((o) => o === "right").length;
  const sofar = quiz.questions.slice(0, ended ? count : at + (answered ? 1 : 0)).length;
  const last = at + 1 >= count;

  return (
    <div className="pstage qz" style={tint}>
      <div className="pstage-in">
        {ended ? (
          <Result
            quiz={quiz}
            outcomes={outcomes}
            names={names}
            onOpenCite={onOpenCite}
            note={typeof output.payload.sizeNote === "string" ? output.payload.sizeNote : undefined}
            responses={responses}
            branches={branches}
            time={limit !== undefined && startedAt !== undefined && endedAt !== undefined ? timing(startedAt, endedAt, limit) : undefined}
            onAgain={again}
            onAnswers={() => {
              setLooking(true);
              setEnded(false);
              setAt(0);
            }}
          />
        ) : waiting ? (
          <div className="qzstart" aria-label="Before you start">
            {quiz.title && <p className="qzkick">{quiz.title}</p>}
            <h2>
              {count} question{count === 1 ? "" : "s"} in {limit} minute{limit === 1 ? "" : "s"}
            </h2>
            <p className="qzd">
              The clock starts when you press Start and keeps running if you leave. When it runs out, the quiz ends with the answers you have given.
              {quiz.feedback === "atEnd" ? " Feedback comes at the end." : ""}
            </p>
            <span className="pstage-gap" />
            <div className="pstage-foot">
              <PrimaryButton
                onClick={() => {
                  const t = clockNow();
                  setNow(t);
                  setStartedAt(t);
                }}
              >
                Start
              </PrimaryButton>
            </div>
          </div>
        ) : (
          q && (
            <div className="qzq" aria-label={`Question ${at + 1} of ${count}`} {...swipe}>
              <div className="pline">
                <span>
                  {locked ? "Looking back · " : ""}Question {at + 1} of {count}
                </span>
                <span className="grow" />
                {left !== undefined ? (
                  <span className={left < 60_000 ? "warn" : undefined} role="timer" aria-label={`${clockWords(left)} left`}>
                    {clockWords(left)} left
                  </span>
                ) : locked || quiz.feedback !== "afterEach" ? null : sofar > 0 ? (
                  <span>{right} right so far</span>
                ) : null}
                {limit !== undefined && (
                  <span className="sr" aria-live="polite">
                    {left !== undefined ? warningFor(left, limit) : ""}
                  </span>
                )}
              </div>
              {kind && <span className="pkind">{kind}</span>}
              <h2 className="qzprompt">{q.prompt}</h2>
              {q.display && (
                <div className="qdisplay">
                  <TeX source={q.display} display />
                </div>
              )}
              {piece ? (
                // Keyed by question, so what one question's piece holds while answering never carries to the next.
                <piece.View key={q.id} q={q} response={responses[q.id]} reveal={reveal} onAnswer={answer} />
              ) : (
                <p className="qzd">This kind of question ({q.kind}) has no web view yet; it counts as not answered.</p>
              )}
              {showFeedback && (
                <div ref={feedback} className={`fb2 ${outcomes[at]}`}>
                  <Verdict q={q} outcome={outcomes[at]!} response={responses[q.id]} />
                  <CiteMarks marks={numberCites(q.cites)} names={names} onOpen={onOpenCite} />
                  {aboutHere?.({ at, responses: responses as Json, ended: false })}
                </div>
              )}
              {quiz.feedback !== "afterEach" && !locked && <p className="qzd">Feedback comes at the end</p>}
              <span className="pstage-gap" />
              <div className="pstage-foot">
                <PrimaryButton disabled={!!piece && !canGo} onClick={advance}>
                  {!last ? "Next question" : locked ? "Back to your result" : "See your result"}
                </PrimaryButton>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

/**
 * Scrolls the quiz's own card (or the screen holding it) so `el` is in view,
 * and never a feed around it: moving a feed would move to another thing.
 * On a page of its own, the page scrolls.
 */
function bringIntoView(el: HTMLElement) {
  const box = el.closest<HTMLElement>(".pstage, .screen9");
  const scrolls = box && box.scrollHeight > box.clientHeight + 1;
  if (!scrolls) {
    if (!el.closest(".feed9, .pplay")) el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    return;
  }
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  // Room for the button to go on, under it.
  const below = r.bottom - (b.bottom - 96);
  if (below > 0) box.scrollTo?.({ top: box.scrollTop + below, behavior: "smooth" });
}

/**
 * The verdict, said once in the player's own voice, then the explanation: the
 * picked option's own line when the quiz has one, then the question's
 * feedback. A verdict the written feedback opens with is left out
 * (verdict.ts), so the two never both speak.
 */
function Verdict({ q, outcome, response }: { q: Question; outcome: Outcome; response: Responses[string] | undefined }) {
  const piece = pieceOf(q.kind);
  const own = piece?.said?.(q, response) ?? "";
  const said = withoutVerdict(outcome === "right" ? q.feedback.correct : q.feedback.incorrect);
  const lines = [own, said].filter((line, i, all) => line && all.indexOf(line) === i);
  return (
    <>
      <b>{piece?.verdict?.(q, response, outcome) ?? verdictWord(outcome)}</b> {lines.join(" ")}
    </>
  );
}

interface Time {
  seconds: number;
  timedOut: boolean;
}

/**
 * The end of a quiz: how many were right against the pass mark, what was
 * missed with why and where it is in the sources, and two ways on: the quiz
 * again from the start, or each question again with its answer.
 */
function Result({ quiz, outcomes, names, onOpenCite, note, responses, branches, time, onAgain, onAnswers }: { quiz: Quiz; outcomes: Outcome[]; names: Map<string, string>; onOpenCite: PlayerProps["onOpenCite"]; note?: string | undefined; responses: Responses; branches: PlayerProps["branches"]; time?: Time | undefined; onAgain: () => void; onAnswers: () => void }) {
  const graded = gradeQuiz(quiz, responses);
  const result = graded as unknown as { score: number; correct: number; count: number; passed: boolean };
  const taken = branchesTaken(branches, graded);
  const missed = quiz.questions.filter((_, i) => outcomes[i] !== "right");
  return (
    <div className="qzres" aria-label="Your result">
      <h2 className="qzbig">
        {result.correct} of {result.count}
      </h2>
      <p className={`qzpct${result.passed ? " good" : ""}`}>
        {Math.round(result.score * 100)}% · the pass mark is {Math.round(quiz.passMark * 100)}%
      </p>
      {time && quiz.timeLimit !== undefined && (
        <p className="qzd qzc">{time.timedOut ? `Time ran out after ${quiz.timeLimit} minute${quiz.timeLimit === 1 ? "" : "s"}; what was left unanswered counts as skipped.` : `Done in ${minutesWords(time.seconds)} of ${quiz.timeLimit}.`}</p>
      )}
      {missed.length > 0 && (
        <div className="qzmiss">
          <h3 id="qz-missed">What you missed</h3>
          <ul aria-labelledby="qz-missed">
            {missed.map((x) => (
              <li key={x.id}>
                <b>{sentence(x.topic || x.prompt)}</b> {withoutVerdict(x.feedback.incorrect) || withoutVerdict(x.feedback.correct)}
                <CiteMarks marks={numberCites(x.cites)} names={names} onOpen={onOpenCite} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {taken.map((b) => (
        <p key={b.title} className="qzd qznext">
          Since {becauseWords(b.condition)}, your plan goes on to <b>{b.title}</b>
          {b.made ? ", ready now." : ", made from this result."}
        </p>
      ))}
      {note && <p className="qzd qznote">{note}</p>}
      <span className="pstage-gap" />
      <div className="pstage-foot two">
        <OutlineButton onClick={onAgain}>Try again</OutlineButton>
        <PrimaryButton onClick={onAnswers}>See the answers</PrimaryButton>
      </div>
    </div>
  );
}

/** A short line as the start of a sentence: a full stop after it unless it ends in its own. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.?!:]$/.test(t) ? t : `${t}.`;
}
