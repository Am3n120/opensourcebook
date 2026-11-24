// Stage 6: timeline. Deterministic: word times become frame-exact caption pages.
// Only caption pages are made here: the clips of an Open Sourcebook video (one
// engine scene per scene of the script, then the end card) are laid out by src/timeline.ts, and the credits, title
// shots and picture paths of older routes are left out with those routes.
import type { Project, Timeline } from "../../schemas/project.ts";

const FPS = 30;

/**
 * Words a phrase does not end on: a page that ends on one ("the shape of the", "a cylinder called the") leaves the
 * viewer holding half a phrase until the next page. English for now, the language Open Sourcebook's voices speak; in any language a
 * page also avoids ending on a word of one or two letters.
 */
const LEANS_ON_NEXT = new Set(
  "a an the of to in on at by for with from into onto upon about over under between through across after before during without within than as and or but nor so if then that which who whom whose what when where while because although though its their his her my your our this these those is are was were be been being has have had do does did can could will would shall should may might must not no very more most such each every both either neither called named".split(" "),
);

/**
 * Short words written with a full stop that always lead into what follows (a title before a name, a label before its
 * number, "for example"): the stop is not a sentence's end, and a page never ends on one. English, like the list above.
 */
const LEADS_INTO_NEXT = new Set("mr mrs ms dr prof sr jr st mt ft vs v cf eg ie gen gov sen rep pres lt col capt sgt no nos fig figs vol ch sec art pp p pt approx ca".split(" "));

const bare = (text: string) => text.replace(/^["'“‘(]+|["'”’),;:]+$/g, "");
/** Letters each with its stop, like U.S., H.R., e.g. or S. */
const isInitialism = (text: string) => /^(\p{L}\.)+$/u.test(bare(text));
/** A known short word with its stop, like Dr. or Fig. */
const isLeadingWord = (text: string) => /^\p{L}+\.$/u.test(bare(text)) && LEADS_INTO_NEXT.has(bare(text).slice(0, -1).toLowerCase());
/** A word whose full stop belongs to it rather than to the sentence. */
export const isAbbreviation = (text: string) => isInitialism(text) || isLeadingWord(text);
/** A short label written before a number: H.R. 1234, S. 12, No. 5, Fig. 3, page 12. */
const isLabel = (text: string) => isAbbreviation(text) || /^\p{L}{1,4}$/u.test(bare(text));
const startsNumber = (text: string) => /^["'“‘(]*[#№]?\d/.test(text);

/**
 * Whether a word ends its sentence. A stop after an abbreviation does not when the next word goes on in lower case or
 * with a number ("H.R. in the House", "the U.S. in 1990", "S. 12"), and never after a word that leads into the next
 * ("Dr. Smith"); a stop after any word followed by lower case is read the same way. A question or an exclamation mark
 * always ends it.
 */
export function endsSentence(text: string, next: string | undefined): boolean {
  if (/[!?]["'”’)]*$/.test(text)) return true;
  if (!/\.["'”’)]*$/.test(text)) return false;
  if (next === undefined) return true;
  if (isLeadingWord(text)) return false;
  const goesOn = /^["'“‘(]*(\p{Ll}|\d)/u.test(next);
  return !goesOn;
}

/** Two words a page must not part: an abbreviation that leads into the next word, or a short label and its number. */
export const keptTogether = (word: string, next: string) => isLeadingWord(word) || (isLabel(word) && startsNumber(next));

/**
 * Words a number is said in ("seven and a half", "two hundred and fifty", "three point five", "two thirds"). English,
 * like the lists above.
 */
const NUMBER_WORDS = new Set(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred hundreds thousand thousands million millions billion billions trillion trillions dozen dozens half halves quarter quarters third thirds".split(" "),
);
const FRACTIONS = new Set("half halves quarter quarters third thirds".split(" "));
const SIZES = new Set("hundred hundreds thousand thousands million millions billion billions trillion trillions dozen dozens".split(" "));
const TENS = new Set("twenty thirty forty fifty sixty seventy eighty ninety".split(" "));
const ONES = new Set("one two three four five six seven eight nine".split(" "));
const said = (text: string) => bare(text).toLowerCase().replace(/[.!?]+$/, "");
/** A number written in digits ("7.5", "1,000", "$3", "40%") or said in words ("seven", "twenty-five"). */
export const isNumber = (text: string) => startsNumber(bare(text).replace(/^[$£€]/, "")) || (said(text) !== "" && said(text).split("-").every((w) => NUMBER_WORDS.has(w)));
/** A dash standing alone between two numbers, as in "5 - 7.5": a range, not a pause. */
const isDash = (text: string) => /^[-–—]$/.test(text);
/** A short unit written after a number in digits: km, km/s, kg, %, °C, m². */
const isUnit = (text: string) => /^[\p{L}/%°²³µ]{1,5}$/u.test(bare(text).replace(/[.!?]+$/, "")) && /[/%°²³]|^\p{L}{1,3}$/u.test(bare(text));

/**
 * What it costs to break a page between `at` and the word after it, by the number around it: one number said in words
 * ("seven | and a half", "three point | five") or a number in digits and its unit ("7.5 | km/s") is never parted, and a
 * range ("five to seven", "5 - 7.5") is parted only at its "to" or dash when nothing better fits. Zero when no number
 * is there.
 */
export function numberCost(words: { text: string }[], at: number): number {
  const w = (i: number) => words[i]?.text ?? "";
  const a = w(at);
  const b = w(at + 1);
  if (!a || !b) return 0;
  const num = (i: number) => i >= 0 && i < words.length && isNumber(w(i));
  const joiner = (i: number) => ["and", "point"].includes(said(w(i)));
  // Inside one number: a number and the size or fraction it counts ("two hundred", "5 million", "two thirds"), tens and
  // ones ("twenty five"), a number and its "and" or "point" before another, "a" before a fraction. Numbers one after
  // another ("one two three") are a list and part like words.
  if (num(at) && (SIZES.has(said(b)) || FRACTIONS.has(said(b)) || (TENS.has(said(a)) && ONES.has(said(b))))) return 40;
  if (num(at) && joiner(at + 1) && (num(at + 2) || (said(w(at + 2)) === "a" && FRACTIONS.has(said(w(at + 3)))))) return 40;
  if (joiner(at) && num(at - 1) && (num(at + 1) || (said(b) === "a" && FRACTIONS.has(said(w(at + 2)))))) return 40;
  if (said(a) === "a" && FRACTIONS.has(said(b))) return 40;
  if (startsNumber(bare(a)) && isUnit(b)) return 40;
  // A range: its two ends each kept whole, parted only at the word that joins them.
  const ranged = (i: number) => (said(w(i)) === "to" || isDash(w(i))) && num(i - 1) && num(i + 1);
  if (ranged(at + 1) || ranged(at)) return 6;
  return 0;
}

/** A caption's word as shown: a closing comma, colon or full stop dropped, except the stop an abbreviation is written with. */
export const shownWord = (text: string) => (isAbbreviation(text.replace(/[,;:]+$/, "")) ? text.replace(/[,;:]+$/, "") : text.replace(/[.,;:]$/, ""));

/**
 * One clause broken into pages of at most `most` words, at the places a reader would pause: pages near even in length,
 * none of one word where the clause has more, none ending on a word that leans on the next, an emphasis phrase kept on
 * one page, and a number never parted from itself or its unit (numberCost). The cheapest set of breaks by those costs (a small search over every way to break the clause).
 */
export function breakClause<T extends { text: string }>(clause: T[], most: number, isEmph: (w: T) => boolean = () => false): T[][] {
  const n = clause.length;
  if (n <= most) return [clause];
  const pagesNeeded = Math.ceil(n / most);
  const ideal = n / pagesNeeded;
  const plain = (w: T) => w.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const leans = (w: T) => LEANS_ON_NEXT.has(plain(w)) || plain(w).length <= 2;
  const cost = (a: number, b: number) => {
    const len = b - a;
    let c = (len - ideal) ** 2;
    if (len === 1) c += 12;
    if (b < n && leans(clause[b - 1]!)) c += 8;
    if (b < n && keptTogether(clause[b - 1]!.text, clause[b]!.text)) c += 40;
    if (b < n) c += numberCost(clause, b - 1);
    if (b < n && isEmph(clause[b - 1]!) && isEmph(clause[b]!)) c += 6;
    return c;
  };
  const best: { cost: number; from: number }[] = [{ cost: 0, from: -1 }];
  for (let b = 1; b <= n; b++) {
    best[b] = { cost: Infinity, from: -1 };
    // One word more than a page holds only to keep an emphasis phrase or a number whole.
    for (let a = Math.max(0, b - most - 1); a < b; a++) {
      const extra = b - a > most ? 10 : 0;
      const c = best[a]!.cost + cost(a, b) + extra + 1;
      if (c < best[b]!.cost) best[b] = { cost: c, from: a };
    }
  }
  const out: T[][] = [];
  for (let b = n; b > 0; b = best[b]!.from) out.unshift(clause.slice(best[b]!.from, b));
  return out;
}

// Caption pages: 1 to `most` words (3 unless the style says otherwise), broken at phrase boundaries: a sentence's end,
// a hold and a beat change always; a comma unless it leaves one word alone; inside a clause where a reader would pause
// (breakClause). A style may set longer pages (render.caption.words): pages of a few words changed every second,
// which viewers read as flicker.
// Only the emphasis words are highlighted, and pages that start during a title card are dropped: the title is the text.
// A page never runs across a hold, so no word shows before it is said and nothing hangs through the silence.
export function captions(p: Project, titles: [number, number][], most = 3): Timeline["captions"] {
  const words = p.narration!.words;
  const held = new Set((p.narration!.holds ?? []).map((h) => h.afterWord));
  const emphasis = new Map(p.script!.beats.map((b) => [b.id, new Set(b.emphasis.flatMap((e) => e.toLowerCase().split(/\s+/)))]));
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const isEmph = (w: (typeof words)[number]) => !!emphasis.get(w.beatId)?.has(norm(w.text));
  // Runs of words between the places a page must end: a sentence's end, a hold, a cut to the next beat, and a comma or
  // colon unless that would leave one word alone on a page.
  type W = (typeof words)[number];
  const hard = (i: number) => held.has(i) || i === words.length - 1 || words[i + 1]!.beatId !== words[i]!.beatId || endsSentence(words[i]!.text, words[i + 1]!.text);
  const soft = (i: number) => /[,;:—–]["'”’)]*$/.test(words[i]!.text) && !(isDash(words[i]!.text) && i > 0 && isNumber(words[i - 1]!.text) && isNumber(words[i + 1]?.text ?? ""));
  const runs: W[][] = [];
  let cur: W[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    if (hard(i)) {
      runs.push(cur);
      cur = [];
    }
  });
  const pages: { words: W[] }[] = [];
  for (const run of runs) {
    // Clauses inside the run: split at its commas, then a clause of one word joins its neighbour when they fit a page.
    const clauses: W[][] = [];
    let c: W[] = [];
    run.forEach((w) => {
      c.push(w);
      if (soft(words.indexOf(w))) {
        clauses.push(c);
        c = [];
      }
    });
    if (c.length) clauses.push(c);
    for (let k = 0; k < clauses.length; k++) {
      const one = clauses[k]!;
      if (one.length !== 1 || clauses.length === 1) continue;
      const before = clauses[k - 1];
      const after = clauses[k + 1];
      if (before && before.length + 1 <= most) clauses.splice(k - 1, 2, [...before, ...one]), (k -= 1);
      else if (after && after.length + 1 <= most) clauses.splice(k, 2, [...one, ...after]);
    }
    for (const clause of clauses) for (const page of breakClause(clause, most, isEmph)) pages.push({ words: page });
  }
  return pages
    .map((pg, i) => {
      const last = pg.words.at(-1)!;
      const nextStart = pages[i + 1]?.words[0]!.start;
      const end = nextStart !== undefined ? Math.min(nextStart, last.end + 0.4) : last.end + 0.4;
      return {
        words: pg.words.map((w) => ({ text: shownWord(w.text), highlight: isEmph(w) })),
        startFrame: Math.round(pg.words[0]!.start * FPS),
        endFrame: Math.round(end * FPS),
      };
    })
    .filter((c) => !titles.some(([a, b]) => c.startFrame >= a && c.startFrame < b));
}
