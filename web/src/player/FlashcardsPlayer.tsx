import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Json } from "../api/types";
import { OutlineButton, PrimaryButton } from "../design/Buttons";
import { Blocks } from "./Blocks";
import { CardSideContext } from "./cardSide";
import { asCards, cited, markOf, placedMarks, type Card } from "./blockData";
import { CiteMarks } from "./CiteMarks";
import { useKindLabel, useStageTint } from "./look";
import type { PlayerProps } from "./players";
import { isNumber, progressField } from "./progress";
import { putBack, queueFor, segmentsOf, type Mode, type Sitting } from "./sitting";
import { SCHEDULE, agoWords, comingBack, memoriesOf, standing, whenWords, type CardMemory, type Mark } from "./spacing";
import { useSwipe } from "./swipe";
import { useChrome } from "./useChrome";
import "./stage.css";
import "./flashcards.css";

/**
 * A set of flashcards (engine/docs/flashcards.md): one card per screen, the
 * screen the player is given and nothing else on it. A click on the card, the
 * Turn over button or space turns it over; the person marks it got it or not
 * yet (keys 1 and 2 too), or answers it when it asks. A missed card comes
 * back a few cards later in the same sitting, and every mark sets when the
 * card is due again (spacing.ts), kept on the plan item. The set opens on
 * what is due when it has been through before, as a review of only those
 * cards; "Review N due" starts one whenever cards are due. Sideways (a swipe
 * or the arrow keys) moves through the cards. The end of a sitting says where
 * the set stands and ticks its plan item done with what was got. The player's
 * line is the sitting in pieces, one per card, green for got it and amber for
 * not yet; up and down are the player's, to the thing before and after.
 */
export function FlashcardsPlayer({ output, sources, active = true, progress, keep, record, onOpenCite, aboutHere }: PlayerProps) {
  const cards = useMemo(() => asCards(output.payload), [output.payload]);
  const markable = useMemo(() => cards.filter((c) => markOf(c) !== "none").map((c) => c.id), [cards]);
  const [memories, setMemories] = useState<Record<string, CardMemory>>(() => memoriesOf(progress));
  const [now, setNow] = useState(() => Date.now());
  const [sitting, setSitting] = useState<Sitting>(() => {
    const kept = memoriesOf(progress);
    const at = Date.now();
    const known = standing(markable, kept, at);
    // Once the set has been through, it opens on what is due; a first time goes through it all, from where the person stopped.
    if (known.due > 0 && known.new === 0) return { mode: "review", queue: queueFor(cards, kept, "review", at), at: 0, marked: {}, ended: false };
    const stopped = Math.floor(progressField(progress, "card", isNumber) ?? progressField(progress, "bit", isNumber) ?? 0);
    return { mode: "all", queue: queueFor(cards, kept, "all", at), at: Math.max(0, Math.min(cards.length - 1, stopped)), marked: {}, ended: false };
  });
  const [flipped, setFlipped] = useState(false);
  const names = useMemo(() => new Map(sources.map((s) => [s.id, s.name])), [sources]);
  const tint = useStageTint(output.type);

  const index = sitting.queue[sitting.at];
  const card = index === undefined ? undefined : cards[index];
  const kind = useKindLabel(output.type, card?.kind);
  const mark = card ? markOf(card) : "none";
  const markedHere = sitting.marked[sitting.at];
  const known = standing(markable, memories, now);
  useChrome(cards.length > 0 ? { segments: segmentsOf(sitting) } : {});

  // What is kept: where the person is, and every card's memory. Kept when it changes, never on every render.
  const keepNow = useCallback(
    (cardIndex: number | undefined, mems: Record<string, CardMemory>) => keep?.({ card: cardIndex ?? 0, cards: mems as unknown as Json } as Json),
    [keep],
  );
  const keptAt = useRef(index);
  useEffect(() => {
    if (index === undefined || index === keptAt.current) return;
    keptAt.current = index;
    keepNow(index, memories);
  }, [index, memories, keepNow]);

  // The end of a sitting ticks the plan item done with what was got, once for each sitting that ends.
  const recorded = useRef<Sitting>(undefined);
  useEffect(() => {
    if (!sitting.ended || !record || recorded.current === sitting) return;
    recorded.current = sitting;
    const marks = Object.values(sitting.marked);
    const at = standing(markable, memories, Date.now());
    record({ cards: markable.length, learned: at.learned, got: marks.filter((m) => m === "got").length, missed: marks.filter((m) => m === "missed").length, due: at.due });
  }, [sitting, record, markable, memories]);

  const move = useCallback((delta: number) => {
    setFlipped(false);
    setSitting((s) => {
      const at = s.at + delta;
      if (at < 0) return s;
      if (at >= s.queue.length) return { ...s, ended: true };
      return { ...s, at };
    });
  }, []);

  const markCard = useCallback(
    (m: Mark, advance: boolean) => {
      if (!card || index === undefined) return;
      const at = Date.now();
      const nextMems = { ...memories, [card.id]: SCHEDULE.next(memories[card.id], m, at) };
      setMemories(nextMems);
      setNow(at);
      keepNow(index, nextMems);
      setSitting((s) => {
        const queue = m === "missed" ? putBack(s.queue, s.at, index) : s.queue;
        const marked = { ...s.marked, [s.at]: m };
        if (!advance) return { ...s, queue, marked };
        return s.at + 1 >= queue.length ? { ...s, queue, marked, ended: true } : { ...s, queue, marked, at: s.at + 1 };
      });
      if (advance) setFlipped(false);
    },
    [card, index, memories, keepNow],
  );

  const start = useCallback(
    (mode: Mode) => {
      const at = Date.now();
      setNow(at);
      setFlipped(false);
      setSitting({ mode, queue: queueFor(cards, memories, mode, at), at: 0, marked: {}, ended: false });
    },
    [cards, memories],
  );

  const swipe = useSwipe(() => move(1), () => move(-1));

  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (sitting.ended) return;
      else if (k === "ArrowRight") move(1);
      else if (k === "ArrowLeft") move(-1);
      else if ((k === " " || k === "Enter") && !(e.target instanceof HTMLButtonElement && k === "Enter")) {
        if (mark === "self" && !flipped && !markedHere) setFlipped(true);
        else if (mark !== "self" || markedHere) move(1);
        else return;
      } else if ((k === "1" || k === "n" || k === "N") && mark === "self" && flipped && !markedHere) markCard("missed", true);
      else if ((k === "2" || k === "g" || k === "G") && mark === "self" && flipped && !markedHere) markCard("got", true);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, move, mark, flipped, markedHere, markCard, sitting.ended]);

  if (cards.length === 0)
    return (
      <div className="pstage fc" style={tint}>
        <div className="pstage-in">
          <p className="fcnone">This set has no cards.</p>
        </div>
      </div>
    );

  const onCardClick = (e: MouseEvent) => {
    // Links, buttons and fields on the card do their own thing; anywhere else turns it over.
    if (e.target instanceof HTMLElement && e.target.closest("a, button, input, select, textarea, label")) return;
    if (mark === "self" && !markedHere) setFlipped((f) => !f);
  };

  const review = sitting.mode === "review";
  const position = Math.min(sitting.at + 1, sitting.queue.length);
  const sideBlocks = card ? cited(card) : undefined;
  const marks = sideBlocks ? placedMarks(sideBlocks) : new Map();
  const frontCount = card?.front.length ?? 0;
  const showBack = mark === "self" && (flipped || !!markedHere);
  const answer = (right: boolean) => {
    if (!markedHere) markCard(right ? "got" : "missed", false);
  };
  const memory = card ? memories[card.id] : undefined;
  const lastTime = review && memory?.last !== undefined ? `You ${memory.box === 0 ? "missed" : "got"} this one ${agoWords(memory.last, now)}.` : undefined;

  const face = card && (
    <CardSideContext.Provider value={{ revealed: showBack, answered: answer }}>
      <article
        key={`${sitting.at}-${card.id}`}
        className={`fccard${showBack ? " back" : ""}${mark === "self" && !markedHere ? " turns" : ""}${review ? " boxed" : ""}`}
        aria-label={`Card ${position} of ${sitting.queue.length}${showBack ? ", turned over" : ""}`}
        aria-live="polite"
        onClick={onCardClick}
      >
        {(kind || card.section) && (
          <div className="fchead">
            {kind && <span className="pkind">{kind}</span>}
            {card.section && <span className="fcsec">{card.section}</span>}
          </div>
        )}
        <div className="fcface">
          <Blocks blocks={card.front} marks={(i) => (showBack || mark !== "self" ? <CiteMarks marks={marks.get(i) ?? []} names={names} onOpen={onOpenCite} /> : null)} />
        </div>
        {showBack && card.back.length > 0 && (
          <div className="fcback">
            <Blocks blocks={card.back} marks={(i) => <CiteMarks marks={marks.get(frontCount + i) ?? []} names={names} onOpen={onOpenCite} />} />
          </div>
        )}
        {/* The player's slot under what it just showed: a way to ask about this card, at this card. */}
        {(showBack || mark !== "self") && aboutHere?.({ card: index ?? 0, cards: memories as unknown as Json })}
        {lastTime && <p className="fclast">{lastTime}</p>}
      </article>
    </CardSideContext.Provider>
  );

  return (
    <div className="pstage fc" style={tint}>
      <div className="pstage-in">
        {sitting.ended || !card ? (
          <End
            cards={cards}
            markable={markable}
            memories={memories}
            now={now}
            sitting={sitting}
            note={typeof output.payload.sizeNote === "string" ? output.payload.sizeNote : undefined}
            onAgain={() => start("all")}
            onReview={known.due > 0 ? () => start("review") : undefined}
          />
        ) : (
          <>
            {review ? (
              <div className="pline">
                <span className="fcreview">Review · {sitting.queue.length} due</span>
                <span className="fccount">
                  card {position} of {sitting.queue.length}
                </span>
                <span className="grow" />
                <button type="button" className="plink" onClick={() => start("all")}>
                  All {cards.length} cards
                </button>
              </div>
            ) : (
              <div className="pline">
                <span className="fccount">
                  Card {position} of {sitting.queue.length}
                </span>
                {known.learned > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="good">{known.learned} learned</span>
                  </>
                )}
                <span className="grow" />
                {known.due > 0 && <OutlineButton onClick={() => start("review")}>Review {known.due} due</OutlineButton>}
              </div>
            )}
            <div className="fcstage" {...swipe}>
              {face}
            </div>
            <div className={`pstage-foot${mark === "self" && showBack && !markedHere ? " two" : ""}`}>
              {mark === "self" && !showBack && <OutlineButton onClick={() => setFlipped(true)}>Turn over</OutlineButton>}
              {mark === "self" && showBack && !markedHere && (
                <>
                  <OutlineButton onClick={() => markCard("missed", true)}>Not yet</OutlineButton>
                  <PrimaryButton onClick={() => markCard("got", true)}>Got it</PrimaryButton>
                </>
              )}
              {(mark !== "self" || markedHere) && (
                <>
                  {markedHere && (
                    <p className={`fcsaid ${markedHere}`}>
                      {markedHere === "got" ? `Got it: back ${whenWords(memories[card.id]?.due ?? now, now)}` : "Not yet: it comes back in a few cards"}
                    </p>
                  )}
                  <PrimaryButton onClick={() => move(1)}>{sitting.at + 1 >= sitting.queue.length ? "Finish" : "Next"}</PrimaryButton>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The end of a sitting: what was got, what is learned, and when the cards come back. */
function End({
  cards,
  markable,
  memories,
  now,
  sitting,
  note,
  onAgain,
  onReview,
}: {
  cards: Card[];
  markable: string[];
  memories: Record<string, CardMemory>;
  now: number;
  sitting: Sitting;
  note: string | undefined;
  onAgain: () => void;
  onReview: (() => void) | undefined;
}) {
  const known = standing(markable, memories, now);
  const back = comingBack(markable, memories, now);
  const marks = Object.values(sitting.marked);
  const got = marks.filter((m) => m === "got").length;
  const missed = marks.filter((m) => m === "missed").length;
  return (
    <section className="fcend" aria-label="Where the set stands">
      <h2>{sitting.mode === "review" ? "Review done" : got + missed > 0 ? "That's the set, for now" : "The end of the set"}</h2>
      {got + missed > 0 && (
        <p className="fcbig">
          {got} got it{missed > 0 && ` · ${missed} not yet, each brought back until you got it`}
        </p>
      )}
      {known.cards > 0 && (
        <p className="fcstand">
          <span className="good">
            {known.learned} of {known.cards} learned
          </span>
          {` · ${known.due} due · ${known.new} not seen yet`}
        </p>
      )}
      {back.length > 0 && <p className="fcwhen">Coming back: {back.map(([when, n]) => `${n} ${when}`).join(" · ")}.</p>}
      <p className="fcrule">{SCHEDULE.about} A card is learned once you have got it on three reviews spread over days.</p>
      {cards.length > markable.length && <p className="fcrule">{cards.length - markable.length} of the cards are to read, and are not brought back.</p>}
      {note && <p className="fcrule">{note}</p>}
      <span className="pstage-gap" />
      <div className={`pstage-foot${onReview ? " two" : ""}`}>
        <OutlineButton onClick={onAgain}>Go through all {cards.length} again</OutlineButton>
        {onReview && <PrimaryButton onClick={onReview}>Review {known.due} due</PrimaryButton>}
      </div>
    </section>
  );
}
