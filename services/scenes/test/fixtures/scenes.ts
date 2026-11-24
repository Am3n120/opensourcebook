/** A small hand-written script and its scenes, for the tests: two scenes about how a lever lifts a load. */
import type { Passage } from "../../src/script.ts";

export const passages: Passage[] = [
  {
    id: "p1",
    sourceId: "src-lever",
    sourceTitle: "Notes on simple machines",
    text: "A lever is a stiff bar that turns on a fixed point called the fulcrum. A small force far from the fulcrum can lift a heavy load close to it, because the force moves through a longer distance.",
  },
];

export const script = {
  title: "How a lever lifts",
  idea: "A small push far from the pivot lifts a big load near it.",
  scenes: [
    {
      narration: "A lever is a stiff bar that turns on one fixed point, the fulcrum.",
      onScreenText: ["fulcrum"],
      visual: "A long bar balanced on a triangle; the triangle is labelled fulcrum.",
      cites: [{ passageId: "p1", quote: "A lever is a stiff bar that turns on a fixed point called the fulcrum." }],
    },
    {
      narration: "Push down far from it, and the heavy load near it rises.",
      onScreenText: ["small push", "big load"],
      visual: "A hand pushes the long end down; the box on the short end rises.",
      cites: [{ passageId: "p1", quote: "A small force far from the fulcrum can lift a heavy load close to it" }],
    },
  ],
};

export const sources = {
  s1: `@0
text title "The lever" role=title
@3 keep
program lever doc="A bar on a triangle."
  path("bar", { x: W / 2, y: H * 0.45, points: [-W * 0.45, 0, W * 0.45, 0], stroke: "ink", strokeWidth: 18 });
  path("pivot", { x: W / 2, y: H * 0.45 + 10, points: [0, 0, -70, 120, 70, 120], closed: 1, fill: "accent" });
end
run lever l1 w=900 h=900
@11 keep
tag l1 "fulcrum" side=bottom
`,
  s2: `@0
text title "Push far, lift near" role=title
box load "load" w=300 h=300
@4 keep
light load
@8 keep
text answer "the load rises" role=answer
`,
};
