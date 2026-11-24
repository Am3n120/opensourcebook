/** Body text with its inline marks drawn (inlineMarks.ts has the grammar). */
import type { ReactNode } from "react";
import { parseInline } from "./inlineMarks";
import { TeX } from "./TeX";

/**
 * `spot` draws words linked to a cited spot (a chat reply's `[words](cite:N)`);
 * without it, those words read as plain text.
 */
export function Inline({ text, spot }: { text: string | undefined; spot?: (cite: number, words: string, key: number) => ReactNode }): ReactNode {
  if (!text) return null;
  return parseInline(text).map((run, index) => {
    switch (run.kind) {
      case "bold":
        return <strong key={index}>{run.text}</strong>;
      case "italic":
        return <em key={index}>{run.text}</em>;
      case "code":
        return <code key={index}>{run.text}</code>;
      case "math":
        return <TeX key={index} source={run.text} />;
      case "link":
        return (
          <a key={index} href={run.href} target="_blank" rel="noreferrer noopener">
            {run.text}
          </a>
        );
      case "spot":
        return spot ? spot(run.cite, run.text, index) : run.text;
      default:
        return run.text;
    }
  });
}
