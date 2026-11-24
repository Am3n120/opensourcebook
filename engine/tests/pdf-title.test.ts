import { describe, expect, it } from "vitest";
import { headingFromItems, isPlaceholderTitle, pdfTitle } from "../src/extract/pdf";

describe("a PDF's name", () => {
  it("keeps a real title written into the file", () => {
    expect(pdfTitle("Attention Is All You Need", "Abstract")).toBe("Attention Is All You Need");
  });

  it("uses the first page's heading when the file has no title", () => {
    expect(pdfTitle(undefined, "Lecture 7: Cellular respiration")).toBe("Lecture 7: Cellular respiration");
    expect(pdfTitle("   ", "Lecture 7: Cellular respiration")).toBe("Lecture 7: Cellular respiration");
  });

  it("passes over a title an app filled in by itself", () => {
    expect(pdfTitle("Microsoft Word - lec08_final_v2.docx", "Lecture 8: Photosynthesis")).toBe("Lecture 8: Photosynthesis");
    expect(pdfTitle("Presentation1", "Week 3: Supply and demand")).toBe("Week 3: Supply and demand");
    for (const title of ["(anonymous)", "(untitled)", "untitled", "Untitled document", "Document1", "PowerPoint Presentation", "Slide 1", "notes.pdf", "Microsoft PowerPoint - week3.pptx"]) {
      expect(isPlaceholderTitle(title)).toBe(true);
    }
    expect(isPlaceholderTitle("The Krebs cycle")).toBe(false);
  });

  it("gives no title when there is only an app's filler and no heading, so the file's own name is used", () => {
    expect(pdfTitle("Presentation1", undefined)).toBeUndefined();
    expect(pdfTitle(undefined, "1 2 3")).toBeUndefined();
  });

  it("finds the heading as the first page's clearly largest text, in reading order", () => {
    const items = [
      { str: "BIOL 2010 - Fall 2026", size: 9 },
      { str: "Lecture 7:", size: 22 },
      { str: "Cellular respiration", size: 22 },
      { str: "Cellular respiration turns the energy in glucose into ATP.", size: 11 },
      { str: "It runs in four stages.", size: 11 },
      { str: "Glycolysis splits glucose.", size: 11 },
    ];
    expect(headingFromItems(items)).toBe("Lecture 7: Cellular respiration");
  });

  it("finds the heading on a short page of one heading and one line", () => {
    expect(headingFromItems([{ str: "Lecture 8: Photosynthesis", size: 20 }, { str: "Light reactions make ATP.", size: 11 }])).toBe("Lecture 8: Photosynthesis");
  });

  it("finds no heading on a page whose text is all one size", () => {
    expect(headingFromItems([{ str: "one", size: 11 }, { str: "two", size: 11 }, { str: "three", size: 11 }])).toBeUndefined();
  });
});
