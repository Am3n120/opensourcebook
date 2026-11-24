import { useEffect, useState } from "react";

/**
 * Maths written as LaTeX, drawn with KaTeX: a card's `math` block, `$…$` in
 * body text (engine/docs/flashcards.md, "Inline marks") and a quiz question's
 * `display`. Only text the contract marks as maths comes here; nothing is
 * guessed from plain words.
 *
 * KaTeX, its stylesheet and its fonts load the first time maths is on
 * screen, never with the app. Until then, and for a formula KaTeX cannot
 * read, the source is shown as written in a code style. Once loaded, every
 * later formula draws at once.
 */
type Katex = typeof import("katex").default;

let katex: Katex | undefined;
let loading: Promise<Katex> | undefined;

function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => (katex = m.default));
  return loading;
}

const drawn = new Map<string, string | null>();

/** The formula as HTML, or null when KaTeX cannot read it. */
function draw(k: Katex, source: string, display: boolean): string | null {
  const key = `${display ? "D" : "I"}${source}`;
  if (!drawn.has(key)) {
    let html: string | null;
    try {
      // The source is a maker's words: `trust: false` keeps \href, \url, \includegraphics and \html… from making a link, a picture or an attribute.
      html = k.renderToString(source, { displayMode: display, throwOnError: true, strict: "ignore", trust: false, output: "htmlAndMathml" });
    } catch {
      html = null;
    }
    if (drawn.size > 500) drawn.clear();
    drawn.set(key, html);
  }
  return drawn.get(key)!;
}

export function TeX({ source, display = false }: { source: string; display?: boolean }) {
  const [, setLoaded] = useState(katex !== undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (katex) return;
    let live = true;
    loadKatex().then(
      () => live && setLoaded(true),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);

  const html = katex ? draw(katex, source, display) : undefined;
  const Tag = display ? "div" : "span";
  if (html) return <Tag className={display ? "tex tex-d" : "tex"} dangerouslySetInnerHTML={{ __html: html }} />;
  // Not loaded yet, or not drawable: the source as written.
  const raw = html === null || failed;
  return (
    <Tag className={`tex-src${display ? " tex-d" : ""}${raw ? "" : " wait"}`} {...(raw ? { title: "Shown as written: this formula could not be drawn" } : { "aria-busy": true })}>
      {source}
    </Tag>
  );
}
