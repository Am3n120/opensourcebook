// An agent's TeX may name the parts of a formula and nothing more: no link, picture, raw HTML, class, style or id.
import assert from "node:assert/strict";
import { test } from "node:test";
import { html } from "./math-layout.ts";

test("TeX can't add a link, a picture, a class, a style or an id", () => {
  for (const tex of [
    "\\href{javascript:alert(1)}{x}",
    "\\href{http://127.0.0.1:14004/api/v1/projects}{x}",
    "\\url{http://127.0.0.1:14004/}",
    "\\includegraphics[height=1em]{http://127.0.0.1:14004/api/v1/projects}",
    "\\htmlClass{evil}{x}",
    "\\htmlStyle{background:url(http://127.0.0.1:14004/)}{x}",
    "\\htmlId{evil}{x}",
    "\\htmlData{onerror=alert(1)}{x}",
  ]) {
    const out = html(tex);
    assert.doesNotMatch(out, /<a\b|<img\b|\bhref=|\bsrc=|url\(|class="[^"]*evil|id="evil|onerror=/i, tex);
    assert.match(out, /katex/, `${tex} is still typeset, its command shown as text`);
  }
});

test("a part of a formula is still named, as the layout reads it", () => {
  assert.match(html("\\part{num}{a} + b"), /data-part="num"/);
});
