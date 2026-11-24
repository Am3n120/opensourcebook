/**
 * A cited spot ends on whole sentences: a quote that passed the word-for-word
 * check is widened to the sentences it sits in, within its passage and a
 * bounded length, for every way a chat reply is written.
 */
import { describe, expect, it } from "vitest";
import { readAnswer } from "../src/chat/answer";
import { MAX_CITE_SPOT, quoteInPassage, sentenceSpot, type Passage } from "../src/sources/passages";

const passage = (text: string): Passage => ({ id: "c1", label: "P1", sourceId: "s1", chunkId: "c1", text });

describe("a cited spot", () => {
  const text =
    "The testing effect is well known. Much of the research on memory is devoted to retrieval practice, which beats rereading. Spacing helps too!\n\n- Sleep matters for memory\n- So does attention";

  it("widens a quote cut mid-sentence to its whole sentence, in the passage's own words", () => {
    const spot = sentenceSpot("Much of the research on memory is devoted to", passage(text));
    expect(spot).toBe("Much of the research on memory is devoted to retrieval practice, which beats rereading.");
    expect(quoteInPassage(spot, passage(text))).toBe(true);
    // A quote that starts mid-sentence starts at the sentence.
    expect(sentenceSpot("memory is devoted to retrieval", passage(text))).toBe("Much of the research on memory is devoted to retrieval practice, which beats rereading.");
    // Quote marks, case and spacing that differ still find the spot.
    expect(sentenceSpot("MUCH   of the research", passage(text))).toBe("Much of the research on memory is devoted to retrieval practice, which beats rereading.");
  });

  it("keeps a whole sentence as it is, spans sentences it crosses, and ends a line where it ends", () => {
    expect(sentenceSpot("The testing effect is well known.", passage(text))).toBe("The testing effect is well known.");
    expect(sentenceSpot("well known. Much of the research", passage(text))).toBe(
      "The testing effect is well known. Much of the research on memory is devoted to retrieval practice, which beats rereading.",
    );
    expect(sentenceSpot("Spacing helps", passage(text))).toBe("Spacing helps too!");
    // A list item is its own line, without its list mark.
    expect(sentenceSpot("matters for", passage(text))).toBe("Sleep matters for memory");
  });

  it("stays bounded: a sentence too long to fit keeps the quote as it was", () => {
    const long = `Intro. ${"word ".repeat(120)}the middle words ${"more ".repeat(120)}end.`;
    expect(sentenceSpot("the middle words", passage(long))).toBe("the middle words");
    const spot = sentenceSpot("the middle words", passage(`Intro. Start ${"word ".repeat(40)}the middle words ${"more ".repeat(100)}end.`));
    expect(spot.length).toBeLessThanOrEqual(MAX_CITE_SPOT);
    expect(spot.startsWith("Start")).toBe(true);
    expect(sentenceSpot("not in it at all", passage(text))).toBe("not in it at all");
  });

  it("is what a chat reply stores, checked or strict", () => {
    for (const strict of [false, true]) {
      const read = readAnswer({ parts: [{ text: "Research is about retrieval.", cites: [{ passage: "P1", quote: "is devoted to" }] }] }, [passage(text)], [], { strict });
      expect(read.badQuotes).toEqual([]);
      expect(read.reply.cites?.[0]?.quote).toBe("Much of the research on memory is devoted to retrieval practice, which beats rereading.");
    }
  });
});
