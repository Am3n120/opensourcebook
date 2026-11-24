/**
 * JSON cut off part way, as an agent's tool input is while it is still
 * being written: read as far as it goes. An unfinished string keeps what it
 * has so far ("Lecture 6 cov" reads as that), open objects and lists are
 * closed, and a key or value not begun yet is left out. Undefined when
 * nothing can be read.
 */
export function parsePartialJson(text: string): unknown {
  const scan = scanJson(text);
  const attempts = [text.length, ...scan.cuts.slice().reverse()];
  for (const end of attempts.slice(0, 40)) {
    const closed = closeAt(text, end);
    if (closed === undefined) continue;
    try {
      return JSON.parse(closed);
    } catch {
      // Cut back further.
    }
  }
  return undefined;
}

interface Scan {
  /** Places to cut back to, outside strings: just after `{` or `[`, and just before `,`. */
  cuts: number[];
}

function scanJson(text: string): Scan {
  const cuts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") cuts.push(i + 1);
    else if (ch === ",") cuts.push(i);
  }
  return { cuts };
}

/** `text` up to `end`, with an open string ended and open objects and lists closed. */
function closeAt(text: string, end: number): string | undefined {
  let body = text.slice(0, end);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of body) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) {
    // A half-written escape (\ or \u00) is dropped before the string is ended.
    body = body.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
    body += '"';
  }
  body = body.replace(/[\s,]+$/, "");
  if (!body) return undefined;
  return body + stack.reverse().join("");
}
