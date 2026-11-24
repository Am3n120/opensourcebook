import { useMemo, type Ref } from "react";
import { Inline } from "../player/inline";
import { parseMarkdown, type MdBlock } from "./mdBlocks";

/**
 * A Markdown source drawn as formatted text. A block that holds part of the
 * marked span is marked; within it, the marked words themselves are marked
 * again when they are found there as written (`mark` gets the first block,
 * to scroll to).
 */
export function Markdown({ text, marked, mark, cite }: { text: string; marked?: [number, number]; mark?: Ref<HTMLElement>; /** The cite number the marked spot was opened from, drawn beside it. */ cite?: number }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const on = (b: MdBlock) => marked !== undefined && b.start < marked[1] && b.end > marked[0];
  const first = blocks.findIndex(on);
  const words = marked ? text.slice(marked[0], marked[1]).replace(/\s+/g, " ").trim() : "";
  return (
    <div className="md">
      {blocks.map((b, k) => {
        const props = on(b) ? { className: "spot", ...(k === first ? { ref: mark, ...(cite !== undefined ? { "data-cite": cite } : {}) } : {}) } : {};
        return <Block key={b.start} block={b} props={props} words={on(b) ? words : ""} />;
      })}
    </div>
  );
}

/** Text with its inline marks, and the cited words in it, when they are there, marked. */
function Marked({ text, words }: { text: string; words: string }) {
  const at = words ? text.toLowerCase().indexOf(words.toLowerCase()) : -1;
  if (at < 0) return <Inline text={text} />;
  return (
    <>
      <Inline text={text.slice(0, at)} />
      <mark className="exact">
        <Inline text={text.slice(at, at + words.length)} />
      </mark>
      <Inline text={text.slice(at + words.length)} />
    </>
  );
}

function Block({ block: b, props, words }: { block: MdBlock; props: { className?: string; ref?: Ref<HTMLElement>; "data-cite"?: number }; words: string }) {
  switch (b.kind) {
    case "heading": {
      // The source's own headings sit under the reader's title.
      const Tag = (["h4", "h4", "h5", "h6", "h6", "h6"] as const)[b.level - 1]!;
      return (
        <Tag {...(props as object)}>
          <Marked text={b.text} words={words} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p {...(props as object)}>
          <Marked text={b.text} words={words} />
        </p>
      );
    case "quote":
      return (
        <blockquote {...(props as object)}>
          <Marked text={b.text} words={words} />
        </blockquote>
      );
    case "list": {
      const List = b.ordered ? "ol" : "ul";
      return (
        <List {...(props as object)}>
          {b.items.map((item, k) => (
            <li key={k}>
              <Marked text={item} words={words} />
            </li>
          ))}
        </List>
      );
    }
    case "code":
      return (
        <pre {...(props as object)}>
          <code>{b.text}</code>
        </pre>
      );
    case "rule":
      return <hr />;
  }
}
