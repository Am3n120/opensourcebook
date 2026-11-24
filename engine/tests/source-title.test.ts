import { describe, expect, it } from "vitest";
import { sourceTitle } from "../src/sources/title";

describe("a source's title", () => {
  it("is the person's own name, else the read title, else a fallback from what it is", () => {
    expect(sourceTitle({ own: " Week 3 ", read: "Lecture 3", kind: "pdf" })).toBe("Week 3");
    expect(sourceTitle({ own: "  ", read: "Lecture 3", kind: "pdf" })).toBe("Lecture 3");
    expect(sourceTitle({ own: null, read: null, kind: "web", url: "https://www.example.com/notes/week%203/", origin: "link" })).toBe("example.com/notes/week 3");
    expect(sourceTitle({ kind: "web", url: "https://example.com/" })).toBe("example.com");
    expect(sourceTitle({ kind: "pdf", origin: "upload" })).toBe("PDF file");
    expect(sourceTitle({ kind: "pdf", read: "Lecture 3", fileName: "week3.pdf", origin: "upload" })).toBe("Lecture 3");
    expect(sourceTitle({ kind: "recipe", origin: "upload" })).toBe("File");
    expect(sourceTitle({ kind: "text", origin: "paste" })).toBe("Pasted text");
    expect(sourceTitle({ kind: "unknown" })).toBe("Untitled source");
  });

  it("names an upload by the file it came as, without folders, and without the extension when the rest is a name", () => {
    expect(sourceTitle({ kind: "text", fileName: "Memory notes.md", origin: "upload" })).toBe("Memory notes");
    expect(sourceTitle({ kind: "pdf", fileName: "C:\\Users\\me\\Desktop\\week-3 slides.pdf", origin: "upload" })).toBe("week-3 slides");
    expect(sourceTitle({ kind: "pdf", fileName: "/tmp/uploads/2024.pdf", origin: "upload" })).toBe("2024.pdf");
    expect(sourceTitle({ kind: "pdf", fileName: "  ", origin: "upload" })).toBe("PDF file");
    expect(sourceTitle({ kind: "text", fileName: `${"n".repeat(200)}.txt`, origin: "upload" }).length).toBeLessThanOrEqual(80);
  });

  it("keeps a name made from a long link short", () => {
    const name = sourceTitle({ kind: "web", url: `https://example.com/${"a".repeat(200)}` });
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith("…")).toBe(true);
  });
});
