/**
 * Reader mode keeps what a page says and leaves out what is around it:
 * navigation, reference lists, footnote marks, edit links and back-matter
 * sections (src/extract/furniture.ts). The pages below are small,
 * hand-written stand-ins for a MediaWiki article and an ordinary article
 * with a footnotes section; none is a copy of a real page.
 */
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { BACK_MATTER_HEADINGS, dropPageFurniture } from "../src/extract/furniture";
import { extractWebModule } from "../src/extract/web";
import type { FetchLike } from "../src/types";

const BODY = "A linear map is a function between two vector spaces that keeps vector addition and scalar multiplication. ";
const MORE = "Every linear map between finite spaces can be written as a matrix once a basis is chosen for each space. ";

/** Shaped like MediaWiki output: heading wrappers, edit links, reference marks, reflist, navbox, categories. */
const WIKI_PAGE = `<!doctype html><html><head><title>Linear map - Example Wiki</title></head><body>
<a class="mw-jump-link" href="#content">Jump to content</a>
<nav id="site-nav"><ul><li><a href="/">Main page</a></li><li><a href="/random">Random article</a></li></ul></nav>
<main id="content"><h1 id="firstHeading">Linear map</h1>
<div class="mw-parser-output">
<div role="note" class="hatnote">"Linear transformation" redirects here.</div>
<p>${BODY.repeat(3)}<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup> It is also called a linear operator.<sup class="noprint Inline-Template"><i><a href="/wiki/Help:Citation">[citation needed]</a></i></sup></p>
<div id="toc" class="toc" role="navigation"><h2>Contents</h2><ul><li><a href="#Definition"><span class="tocnumber">1</span> Definition</a></li></ul></div>
<div class="mw-heading mw-heading2"><h2 id="Definition">Definition</h2><span class="mw-editsection"><span class="mw-editsection-bracket">[</span><a href="/edit?section=1">edit</a><span class="mw-editsection-bracket">]</span></span></div>
<p>${MORE.repeat(3)}<sup id="cite_ref-2" class="reference"><a href="#cite_note-2">[2]</a></sup></p>
<ol><li>Pick a basis for the first space.</li><li>Pick a basis for the second space.</li><li>Write the image of each basis vector as a column.</li></ol>
<p>Some references in the theory call this the matrix of the map.</p>
<div class="mw-heading mw-heading2"><h2 id="See_also">See also</h2><span class="mw-editsection">[<a href="/edit?section=2">edit</a>]</span></div>
<ul><li><a href="/wiki/Affine_map">Affine map</a></li><li><a href="/wiki/Bilinear_map">Bilinear map</a></li></ul>
<div class="mw-heading mw-heading2"><h2 id="Notes">Notes</h2><span class="mw-editsection">[<a href="/edit?section=3">edit</a>]</span></div>
<ol><li id="cite_note-1"><span class="mw-cite-backlink"><b><a href="#cite_ref-1">^</a></b></span> <span class="reference-text">Footnote one names a textbook.</span></li>
<li id="cite_note-2"><span class="mw-cite-backlink">^ <a href="#cite_ref-2a"><sup><i><b>a</b></i></sup></a> <a href="#cite_ref-2b"><sup><i><b>b</b></i></sup></a></span> <span class="reference-text">Footnote two names a lecture.</span></li></ol>
<div class="mw-heading mw-heading2"><h2 id="References">References</h2><span class="mw-editsection">[<a href="/edit?section=4">edit</a>]</span></div>
<div class="reflist"><ul><li>Author, A. Linear Algebra Done Somewhere. Publisher.</li></ul></div>
<div class="mw-heading mw-heading2"><h2 id="External_links">External links</h2><span class="mw-editsection">[<a href="/edit?section=5">edit</a>]</span></div>
<ul><li><a href="https://example.org/lecture">A lecture on linear maps</a></li></ul>
<div role="navigation" class="navbox"><table><tr><th>Linear algebra</th><td><a href="/wiki/Vector_space">Vector space</a> · <a href="/wiki/Matrix">Matrix</a></td></tr></table></div>
</div>
<div id="catlinks" class="catlinks"><a href="/wiki/Category:Linear_algebra">Category: Linear algebra</a></div>
</main></body></html>`;

/** An ordinary article: a site menu, breadcrumbs, numbered footnotes with back-links, a further-reading tail. */
const BLOG_PAGE = `<!doctype html><html><head><title>Why bread rises</title></head><body>
<header><nav aria-label="Site"><a href="/">Home</a> <a href="/about">About</a> <a href="/archive">Archive</a></nav></header>
<article>
<nav aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/food">Food</a></li></ol></nav>
<h1>Why bread rises</h1>
<p>Yeast eats the sugars in flour and breathes out carbon dioxide, which the gluten traps as small bubbles.<sup id="fnref:1"><a href="#fn:1" class="footnote-ref" role="doc-noteref">1</a></sup> ${"The dough rises as the bubbles grow, and baking sets them in place. ".repeat(6)}</p>
<h2>Steps</h2>
<ol><li>Mix flour, water, salt and yeast.</li><li>Knead until smooth.</li><li>Leave to rise for an hour.</li></ol>
<p>The area of a round loaf grows with r<sup>2</sup>, so a wider tin needs more dough.</p>
<h2>Notes</h2>
<p>Use lukewarm water: hot water kills yeast.</p>
<h2>Further reading</h2>
<ul><li><a href="https://example.org/yeast">A book about yeast</a></li></ul>
<section class="footnotes" role="doc-endnotes"><hr><ol><li id="fn:1"><p>Some breads use a sourdough starter instead. <a href="#fnref:1" class="reversefootnote" role="doc-backlink">&#8617;</a></p></li></ol></section>
</article>
<footer><h2>Follow us</h2><p>Newsletter every week.</p></footer>
</body></html>`;

function readerText(html: string): Promise<string> {
  const fetchImpl: FetchLike = async () => new Response(html, { headers: { "content-type": "text/html" } });
  return extractWebModule({ url: "https://example.org/page", sourceText: "", fetchImpl, timeoutMs: 1000, maxBytes: 1_000_000, maxTextChars: 400_000 })
    .then((result) => result?.text ?? "");
}

describe("reader mode on a MediaWiki-shaped article", () => {
  it("keeps the body and leaves out navigation, marks, edit links and back matter", async () => {
    const text = await readerText(WIKI_PAGE);
    expect(text).toContain("A linear map is a function between two vector spaces");
    expect(text).toContain("Definition");
    expect(text).toContain("written as a matrix");
    expect(text).toContain("Write the image of each basis vector as a column.");
    expect(text).toContain("Some references in the theory call this the matrix of the map.");
    for (const furniture of [
      "redirects here", "[1]", "[2]", "[citation needed]", "[edit]", "edit]", "Contents", "Random article", "Jump to content",
      "See also", "Affine map", "Footnote one", "Footnote two", "Linear Algebra Done Somewhere", "External links",
      "A lecture on linear maps", "Vector space", "Category", "Notes",
    ]) {
      expect(text, furniture).not.toContain(furniture);
    }
  });
});

describe("reader mode on an ordinary article", () => {
  it("keeps the steps, an exponent and a notes section with text, and leaves out menus, footnotes and further reading", async () => {
    const text = await readerText(BLOG_PAGE);
    expect(text).toContain("Yeast eats the sugars in flour");
    expect(text).toContain("Knead until smooth.");
    expect(text).toContain("grows with r2");
    expect(text).toContain("Use lukewarm water");
    for (const furniture of ["Archive", "Food", "small bubbles.1", "sourdough starter", "↩", "Further reading", "A book about yeast"]) {
      expect(text, furniture).not.toContain(furniture);
    }
  });
});

describe("page furniture rules", () => {
  function dropped(html: string): string {
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    dropPageFurniture(document as unknown as Document);
    return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  it("keeps a back-matter heading in the middle of the body", () => {
    const text = dropped("<article><h2>See also</h2><p>Earlier work.</p><h2>Results</h2><p>The results.</p></article>");
    expect(text).toContain("Earlier work.");
    expect(text).toContain("The results.");
  });

  it("matches back-matter headings by their whole words, not part of them", () => {
    const text = dropped("<article><h2>Body</h2><p>Text.</p><h2>References in fiction</h2><p>A novel mentions it.</p></article>");
    expect(text).toContain("A novel mentions it.");
  });

  it("drops a trailing back-matter section in another language", () => {
    const text = dropped("<article><h2>Geschichte</h2><p>Text.</p><h2>Einzelnachweise</h2><p>Quelle eins.</p><h2>Weblinks</h2><p>Link.</p></article>");
    expect(text).toContain("Text.");
    expect(text).not.toContain("Quelle eins.");
    expect(text).not.toContain("Weblinks");
  });

  it("keeps an ordered list with in-page links that are not back-links", () => {
    const text = dropped('<ol><li><a href="#one">Chapter one</a></li><li><a href="#two">Chapter two</a></li></ol>');
    expect(text).toContain("Chapter one");
  });

  it("keeps one list of heading words in one place, lower case", () => {
    for (const words of BACK_MATTER_HEADINGS) expect(words).toBe(words.toLowerCase());
    expect(BACK_MATTER_HEADINGS.has("notes")).toBe(false);
  });
});
