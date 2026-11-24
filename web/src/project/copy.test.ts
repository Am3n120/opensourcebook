import { describe, expect, it } from "vitest";
import { plainText } from "./copy";
import { citeNumbers, copyText } from "./pieces";

describe("copying a reply", () => {
  it("lays a copied piece of a reply out as text: lists as lists, rows as rows, no chips", () => {
    const box = document.createElement("div");
    box.innerHTML =
      '<p class="blk">Two files<span class="cites" data-copy="skip"><button>1</button></span></p>' +
      '<ol class="blk"><li>Week 3 <b>notes</b></li><li>The syllabus</li></ol>' +
      "<div><table><thead><tr><th>Exam</th><th>Covers</th></tr></thead><tbody><tr><td>Midterm</td><td>1–6</td></tr></tbody></table></div>";
    box.querySelectorAll("[data-copy='skip']").forEach((node) => node.remove());
    expect(plainText(box).replace(/\n{3,}/g, "\n\n").trim()).toBe("Two files\n\n1. Week 3 notes\n2. The syllabus\n\nExam | Covers\nMidterm | 1–6");
  });

  it("copies a whole reply from its blocks, without plan cards, questions or the failure words", () => {
    const text = copyText([
      { kind: "text", text: "See [the dates](cite:0).", cites: [0] },
      { kind: "list", ordered: true, items: [], text: "1. One\n2. Two" },
      { kind: "plan", planId: "p1", action: "created" },
      { kind: "math", text: "x^2" },
      { kind: "poll", text: "A kind added later." },
      { kind: "text", text: "You stopped this reply.", cites: [], failure: true },
    ]);
    expect(text).toBe("See the dates.\n\n1. One\n2. Two\n\n$$x^2$$\n\nA kind added later.");
  });

  it("copies a teach-back grouped under its headings, in the order shown", () => {
    const text = copyText([
      {
        kind: "teachback",
        items: [
          { verdict: "right", text: "Glucose comes from [carbon dioxide](cite:0) and water.", cites: [0] },
          { verdict: "wrong", text: "The energy is from sunlight.", cites: [1] },
          { verdict: "right", text: "Oxygen is given off.", cites: [] },
        ],
        text: "",
      },
    ]);
    expect(text).toBe("What you got right:\n- Glucose comes from carbon dioxide and water.\n- Oxygen is given off.\n\nWhat the sources say differently:\n- The energy is from sunlight.");
  });

  it("numbers cites in the order a reader meets them: items and rows before the block's own", () => {
    const numbers = citeNumbers([
      { kind: "text", text: "a", cites: [2] },
      { kind: "list", ordered: false, items: [{ text: "x", cites: [0] }, { text: "y", cites: [2, 1] }], cites: [3], text: "" },
    ]);
    expect([...numbers]).toEqual([
      [2, 1],
      [0, 2],
      [1, 3],
      [3, 4],
    ]);
  });
});
