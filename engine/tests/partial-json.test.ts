/** Tool input cut off part way, read as far as it goes (chat/agent/partial-json.ts). */
import { describe, expect, it } from "vitest";
import { parsePartialJson } from "../src/chat/agent/partial-json";

describe("partial JSON", () => {
  it("keeps an unfinished string and closes what is open", () => {
    expect(parsePartialJson('{"blocks": [{"kind": "paragraph", "text": "Lecture 6 cov')).toEqual({ blocks: [{ kind: "paragraph", text: "Lecture 6 cov" }] });
  });

  it("leaves out a key or value not begun yet", () => {
    expect(parsePartialJson('{"blocks": [{"kind": "paragraph"}, {"kind"')).toEqual({ blocks: [{ kind: "paragraph" }, {}] });
    expect(parsePartialJson('{"blocks": [{"kind": "paragraph", "text": "Hi"},')).toEqual({ blocks: [{ kind: "paragraph", text: "Hi" }] });
    expect(parsePartialJson('{"more": tr')).toEqual({});
  });

  it("drops a half-written escape", () => {
    expect(parsePartialJson('{"text": "a \\"b\\" c \\')).toEqual({ text: 'a "b" c ' });
    expect(parsePartialJson('{"text": "x \\u00')).toEqual({ text: "x " });
  });

  it("reads whole JSON as it is, and nothing as nothing", () => {
    expect(parsePartialJson('{"a": [1, 2]}')).toEqual({ a: [1, 2] });
    expect(parsePartialJson("")).toBeUndefined();
  });
});
