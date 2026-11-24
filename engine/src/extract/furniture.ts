/**
 * Page furniture: what a web page carries around its text that is not what
 * the page says. Reader mode drops it before Readability picks the article,
 * so it never reaches a source's text.
 *
 * Rules, structure and roles first:
 *
 * 1. Roles and elements: `<nav>`, role navigation, note (hatnotes such as
 *    "X redirects here"), doc-toc, doc-bibliography, doc-endnotes,
 *    doc-footnote, doc-noteref and doc-backlink (WAI-ARIA DPUB roles).
 * 2. Footnote marks: a `<sup>` whose whole text is bracketed ("[1]", "[a]",
 *    "[citation needed]"), or that only holds a short link to an anchor on
 *    the same page ("1" pointing at "#fn1"). A `<sup>` without such a link
 *    (an exponent) stays.
 * 3. Reference lists: a list most of whose items link back up to the text
 *    ("^", "↑", "↩" pointing at "#…", or a doc-backlink). A plain ordered
 *    list has no such links and stays.
 * 4. Edit marks: a heading's "[edit]" / "edit source" link.
 * 5. Back-matter sections: a heading named in BACK_MATTER_HEADINGS, with
 *    everything up to the next heading of its level or higher, but only when
 *    every later section at that level in the same article is back matter
 *    too, so a "See also" in the middle of an article body stays. The words
 *    match the heading's whole text, never part of it ("References in
 *    fiction" stays). A bare "Notes" is not on the list: a recipe's or a
 *    guide's notes are content; footnotes go by rule 3 instead.
 * 6. A section that had text and has none left after the rules above (a
 *    "Notes" heading over a removed footnote list) loses its heading.
 *
 * MediaWiki-generated pages (any wiki on MediaWiki, not one site) mark the
 * same furniture with classes; FURNITURE_CLASSES covers those.
 */

/** Back-matter heading words, lower case, in the languages Open Sourcebook's people read most. One list, one place. */
export const BACK_MATTER_HEADINGS = new Set([
  // English
  "see also", "references", "external links", "further reading", "bibliography", "footnotes", "endnotes",
  "citations", "works cited", "cited works", "notes and references", "references and notes", "sources and references",
  // French, Spanish, Portuguese, Italian, German
  "voir aussi", "références", "notes et références", "liens externes", "bibliographie",
  "véase también", "referencias", "enlaces externos", "bibliografía", "notas y referencias",
  "ver também", "referências", "ligações externas", "bibliografia",
  "voci correlate", "collegamenti esterni",
  "siehe auch", "einzelnachweise", "weblinks", "literatur",
]);

const FURNITURE_SELECTOR = [
  "nav",
  '[role="navigation"]',
  '[role="note"]',
  '[role="doc-toc"]',
  '[role="doc-bibliography"]',
  '[role="doc-endnotes"]',
  '[role="doc-footnote"]',
  '[role="doc-noteref"]',
  '[role="doc-backlink"]',
].join(",");

/** MediaWiki's markers for navigation boxes, reference lists, edit links, the contents box and category links. */
const FURNITURE_CLASSES = [
  "navbox", "vertical-navbox", "reflist", "references", "mw-references-wrap", "mw-editsection",
  "mw-jump-link", "toc", "catlinks", "printfooter",
];

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const BRACKETED = /^\[[^\[\]]{1,40}\]$/;
const SHORT_MARK = /^[\p{L}\p{N}*†‡§]{1,4}$/u;
const BACK_LINK_TEXT = /^[\^↑↩︎⤴\s]*[\p{L}\p{N}]{0,2}$/u;
const EDIT_MARK = /^\[?\s*(edit|edit source|modifier|bearbeiten|editar)\s*\]?$/i;

export function dropPageFurniture(doc: Document): void {
  const body = doc.body ?? doc.documentElement;
  if (!body) return;
  const hadText = new Map(headings(body).map((heading) => [heading, sectionHasContent(heading)]));
  removeAll(body.querySelectorAll(FURNITURE_SELECTOR));
  removeAll(body.querySelectorAll(FURNITURE_CLASSES.map((name) => `.${name}`).join(",")));
  for (const sup of elements(body.querySelectorAll("sup"))) if (isFootnoteMark(sup)) sup.remove();
  for (const list of elements(body.querySelectorAll("ol,ul"))) if (isReferenceList(list)) list.remove();
  for (const heading of headings(body)) {
    for (const child of elements(heading.querySelectorAll("a,span"))) if (EDIT_MARK.test(text(child))) child.remove();
  }
  for (const heading of headings(body).reverse()) {
    if (hadText.get(heading) && !sectionHasContent(heading)) sectionAnchor(heading).remove();
  }
  dropBackMatter(body);
}

function isFootnoteMark(sup: Element): boolean {
  const words = text(sup);
  if (BRACKETED.test(words)) return true;
  const links = elements(sup.querySelectorAll("a"));
  return links.length === 1 && (links[0].getAttribute("href") ?? "").startsWith("#") && SHORT_MARK.test(words.replace(/[\[\]\s]/g, ""));
}

/** Most items link back up to the text: endnotes, not a list the page is making. */
function isReferenceList(list: Element): boolean {
  const items = elements(list.children).filter((child) => child.tagName === "LI");
  if (items.length === 0) return false;
  const backLinked = items.filter((item) =>
    elements(item.querySelectorAll('a[href^="#"]')).some((link) => BACK_LINK_TEXT.test(text(link)) && /[\^↑↩⤴]/.test(text(link) + text(link.parentElement))),
  );
  return backLinked.length * 3 >= items.length * 2;
}

/** Removes back-matter sections that run to the end of their level. */
function dropBackMatter(body: Element): void {
  const all = headings(body);
  const isBackMatter = all.map((heading) => BACK_MATTER_HEADINGS.has(headingWords(heading)));
  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (!isBackMatter[index]) continue;
    const level = headingLevel(all[index]);
    const scope = all[index].closest("article,main,[role=main]") ?? body;
    const later = all
      .slice(index + 1)
      .filter((heading, offset) => scope.contains(heading) && headingLevel(heading) <= level && !isBackMatter[index + 1 + offset]);
    if (later.length === 0) removeSection(all[index]);
  }
}

/** Whether anything with text or media follows the heading before the next heading of its level or higher. */
function sectionHasContent(heading: Element): boolean {
  const anchor = sectionAnchor(heading);
  const level = headingLevel(heading);
  for (let next = anchor.nextElementSibling; next; next = next.nextElementSibling) {
    const nextLevel = wrappedHeadingLevel(next);
    if (nextLevel !== undefined && nextLevel <= level) return false;
    if (text(next) || next.querySelector("img,figure,table,video,audio,math,pre")) return true;
  }
  return false;
}

function removeSection(heading: Element): void {
  const anchor = sectionAnchor(heading);
  const level = headingLevel(heading);
  let next = anchor.nextElementSibling;
  while (next) {
    const nextLevel = wrappedHeadingLevel(next);
    if (nextLevel !== undefined && nextLevel <= level) break;
    const after = next.nextElementSibling;
    next.remove();
    next = after;
  }
  anchor.remove();
}

/** The heading, or the wrapper that holds only it (MediaWiki's `div.mw-heading`). */
function sectionAnchor(heading: Element): Element {
  let anchor = heading;
  const words = text(heading);
  while (anchor.parentElement && anchor.parentElement.tagName !== "BODY" && anchor.parentElement.children.length === 1 && text(anchor.parentElement) === words) {
    anchor = anchor.parentElement;
  }
  return anchor;
}

function wrappedHeadingLevel(element: Element): number | undefined {
  if (HEADING_TAGS.has(element.tagName)) return headingLevel(element);
  const inner = element.children.length === 1 ? element.children[0] : undefined;
  return inner && HEADING_TAGS.has(inner.tagName) && text(inner) === text(element) ? headingLevel(inner) : undefined;
}

function headings(root: Element): Element[] {
  return elements(root.querySelectorAll("h1,h2,h3,h4,h5,h6"));
}

function headingLevel(heading: Element): number {
  return Number(heading.tagName.slice(1));
}

/** The heading's own words, lower case, without edit marks or a closing colon. */
function headingWords(heading: Element): string {
  return text(heading).replace(/\[\s*edit[^\]]*\]/gi, "").replace(/[:：.\s]+$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function text(element: Element | null | undefined): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function elements(list: ArrayLike<Element> | HTMLCollection | NodeListOf<Element>): Element[] {
  return Array.from(list as ArrayLike<Element>);
}

function removeAll(list: ArrayLike<Element>): void {
  for (const element of elements(list)) element.remove();
}
