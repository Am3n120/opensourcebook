// Caption pages break where a reader would pause: never mid-phrase on a word that leans on the next, never one word
// left alone where its clause has more, and always at a sentence's end, a hold and a cut.
import assert from "node:assert/strict";
import { test } from "node:test";
import { breakClause, captions, endsSentence } from "../pipeline/stages/timeline.ts";

const pagesOf = (text: string, most: number, holds: number[] = []) => {
  const words = text.split(" ").map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.3, beatId: "s1" }));
  const p = { narration: { words, holds: holds.map((afterWord, i) => ({ id: `h${i}`, afterWord, start: 0, seconds: 1 })) }, script: { beats: [{ id: "s1", emphasis: [] }] } } as never;
  return captions(p, [], most).map((c) => c.words.map((w) => w.text).join(" "));
};

test("a page does not end on a word that leans on the next", () => {
  for (const most of [3, 6]) {
    const pages = pagesOf("Inside is a cylinder called the plug, and around it is the housing. They remember the shape of the germ for years.", most);
    for (const page of pages.slice(0, -1)) assert.doesNotMatch(page, /\b(the|a|of|called|and)$/i, `${most}: ${JSON.stringify(pages)}`);
    assert.ok(pages.every((p) => p.split(" ").length <= most), JSON.stringify(pages));
  }
});

test("no word is left alone on a page when its sentence has more", () => {
  const pages = pagesOf("The right key lifts each pin by just the right amount. Too high or too low, it stays shut.", 6);
  assert.ok(pages.every((p) => p.split(" ").length > 1), JSON.stringify(pages));
  // A sentence still ends its page.
  assert.ok(pages.some((p) => p.endsWith("amount")), JSON.stringify(pages));
});

test("pages still end at a hold and every word is shown once, in order", () => {
  const text = "Water climbs up the tree without any pump at all pulled from the leaves above";
  const pages = pagesOf(text, 6, [4]);
  assert.equal(pages.join(" "), text);
  assert.ok(pages.some((p) => p.endsWith("tree")), JSON.stringify(pages));
});

test("a clause is cut into near even pages", () => {
  const words = "one two three four five six seven".split(" ").map((text) => ({ text }));
  const sizes = breakClause(words, 6).map((p) => p.length);
  assert.deepEqual(sizes.sort(), [3, 4]);
});

test("a page never breaks inside an abbreviation, and the abbreviation keeps its stops", () => {
  // The line that broke as "AND IT GETS A NUMBER H.R" / "IN THE HOUSE S".
  for (const most of [3, 4, 6]) {
    const pages = pagesOf("But only a member of Congress can introduce it, and it gets a number: H.R. in the House, S. in the Senate.", most);
    assert.ok(pages.some((p) => p.startsWith("H.R. in")), `${most}: ${JSON.stringify(pages)}`);
    assert.ok(pages.some((p) => p.startsWith("S. in")), `${most}: ${JSON.stringify(pages)}`);
    for (const page of pages) assert.doesNotMatch(page, /(H\.R|\bS)$/, `${most}: ${JSON.stringify(pages)}`);
  }
  for (const most of [3, 6]) {
    const text = "Laws in the U.S. are written in Congress, e.g. by a senator. Dr. Smith filed H.R. 1234 and S. 12 on the same day, and No. 5 came later. The tax rose 3.5 percent in the U.S. The rest stayed.";
    const pages = pagesOf(text, most);
    const joined = pages.join(" | ");
    assert.doesNotMatch(joined, /U\.S(?!\.)/, joined);
    assert.match(joined, /e\.g\. by/, joined);
    assert.match(joined, /Dr\. Smith/, joined);
    assert.match(joined, /H\.R\. 1234/, joined);
    assert.match(joined, /S\. 12/, joined);
    assert.match(joined, /No\. 5/, joined);
    assert.match(joined, /3\.5 percent/, joined);
    // A real sentence's end after an abbreviation still ends the page.
    assert.ok(pages.some((p) => p.endsWith("U.S.")) && pages.at(-1) === "The rest stayed", joined);
    // Every word shown once, in order.
    assert.equal(pages.join(" ").replace(/[.,]/g, ""), text.replace(/[.,]/g, ""));
  }
});

test("a full stop is a sentence's end by what follows it", () => {
  assert.equal(endsSentence("shut.", "Slice"), true);
  assert.equal(endsSentence("H.R.", "in"), false);
  assert.equal(endsSentence("S.", "12"), false);
  assert.equal(endsSentence("Dr.", "Smith"), false);
  assert.equal(endsSentence("U.S.", "The"), true);
  assert.equal(endsSentence("C.", undefined), true);
  assert.equal(endsSentence("why?", "because"), true);
  assert.equal(endsSentence("3.5", "percent"), false);
});

test("a page never breaks inside a number, between a number and its unit, or inside a range but at its joining word", () => {
  // The line that showed "5 - 7.5 KM/S" above "AND A HALF KILOMETRES PER SECOND".
  for (const most of [3, 4, 5, 6]) {
    const text = "Rockets leave at 5 - 7.5 km/s. That is five to seven and a half kilometres per second, or about two hundred and fifty times a car. The tank is three point five metres wide and holds two thirds of the fuel.";
    const pages = pagesOf(text, most);
    const joined = pages.join(" | ");
    for (const whole of ["seven and a half", "two hundred and fifty", "three point five", "two thirds", "7.5 km/s"]) assert.match(joined, new RegExp(whole), `${most}: ${joined}`);
    // Where a page has room, a range parts before its "to" or dash, not after it.
    if (most >= 5) for (const page of pages.slice(0, -1)) assert.doesNotMatch(page, /(\bto| -)$/, `${most}: ${joined}`);
    assert.ok(pages.every((p) => p.split(" ").length <= most + 1), `${most}: ${joined}`);
    assert.equal(pages.join(" ").replace(/[.,]/g, ""), text.replace(/[.,]/g, ""));
  }
});

test("a dash between two numbers is a range, not a pause that ends a page", () => {
  const pages = pagesOf("Speeds of 5 – 7.5 km/s are typical", 6);
  assert.ok(pages.some((p) => /5 – 7\.5/.test(p)), JSON.stringify(pages));
});
