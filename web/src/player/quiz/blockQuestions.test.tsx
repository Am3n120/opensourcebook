import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import kindCases from "../../../../engine/src/engines/quiz/kind-cases.json";
import { Blocks } from "../Blocks";
import { markOf, type Block } from "../blockData";
import { CardSideContext } from "../cardSide";
import { gradeQuestion, type Question } from "../quizGrade";
import { blockQuestion } from "./blockQuestions";

const label = {
  type: "labelPicture",
  prompt: "Name the chambers.",
  url: "/v1/assets/heart",
  caption: "A section through the heart",
  marks: [
    { mark: "A", answer: "right atrium" },
    { mark: "B", answer: "left ventricle" },
  ],
  extra: ["aorta"],
  explanation: "The key under the figure names each mark.",
} as unknown as Block;

const line = {
  type: "drawLine",
  prompt: "From 5 litres, 5 more each minute.",
  axes: { x: { min: 0, max: 10, step: 1, label: "minutes" }, y: { min: 0, max: 60, step: 5, label: "litres" } },
  line: [[0, 5], [8, 45]],
} as unknown as Block;

/** A shared case's question as the card block that asks it. */
function asBlock(q: Record<string, unknown>): Block {
  if (q.kind === "label") {
    const picture = q.picture as { url: string; caption?: string };
    return { type: "labelPicture", prompt: q.prompt, url: picture.url, ...(picture.caption ? { caption: picture.caption } : {}), marks: q.marks, ...(q.extra ? { extra: q.extra } : {}) } as unknown as Block;
  }
  return { type: "drawLine", prompt: q.prompt, axes: q.axes, line: q.line } as unknown as Block;
}

const shared = kindCases.cases.filter((c) => c.question.kind === "label" || c.question.kind === "graph");

test.each(shared.map((c) => [c.name, c] as const))("a card grades as the quiz kind does: %s", (_name, c) => {
  const q = blockQuestion(asBlock(c.question as Record<string, unknown>))!.question;
  // The case's responses pick among the names in the case's own order.
  const asked: Question = { ...q, ...(c.question.kind === "label" ? { names: (c.question as { names: string[] }).names } : {}) };
  const g = gradeQuestion(asked, c.response);
  expect(g.answered).toBe(c.answered);
  expect(g.fraction).toBeCloseTo(c.fraction, 9);
});

test("a picture's names are offered mixed, the extra ones among them, the same each time", () => {
  const names = blockQuestion(label)!.question.names!;
  expect([...names].sort()).toEqual(["aorta", "left ventricle", "right atrium"]);
  expect(names.slice(0, 2)).not.toEqual(["right atrium", "left ventricle"]);
  expect(blockQuestion(label)!.question.names).toEqual(names);
});

test("both are questions, so a card holding one is marked by its answer", () => {
  expect(markOf({ front: [label], back: [] })).toBe("answer");
  expect(markOf({ front: [line], back: [] })).toBe("answer");
});

function onCard(block: Block, answers: boolean[]) {
  return render(
    <CardSideContext.Provider value={{ revealed: true, answered: (right) => void answers.push(right) }}>
      <Blocks blocks={[block]} />
    </CardSideContext.Provider>,
  );
}

test("labelling a picture: each mark named, checked, the card told; a part right says how many", async () => {
  const answers: boolean[] = [];
  onCard(label, answers);
  expect(screen.getByRole("img").getAttribute("alt")).toBe("A section through the heart");
  expect(screen.queryByRole("status")).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText("What A is"), "right atrium");
  await userEvent.selectOptions(screen.getByLabelText("What B is"), "aorta");
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(screen.getByRole("status").textContent).toBe("1 of 2 named. The key under the figure names each mark.");
  expect(answers).toEqual([false]);
  // The right name shows beside the wrong one.
  expect(screen.getByText("left ventricle", { selector: "small" })).toBeTruthy();
});

test("labelling every mark right marks the card got it", async () => {
  const answers: boolean[] = [];
  onCard(label, answers);
  await userEvent.selectOptions(screen.getByLabelText("What A is"), "right atrium");
  await userEvent.selectOptions(screen.getByLabelText("What B is"), "left ventricle");
  await userEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(screen.getByRole("status").textContent).toMatch(/^Right\./);
  expect(answers).toEqual([true]);
});

test("drawing a line: two points placed, checked, any two points on the right line are right", async () => {
  const answers: boolean[] = [];
  onCard(line, answers);
  const check = screen.getByRole("button", { name: "Check the line" });
  expect(check).toBeDisabled();
  await userEvent.type(screen.getByLabelText("Point 1 minutes"), "2");
  await userEvent.type(screen.getByLabelText("Point 1 litres"), "15");
  await userEvent.type(screen.getByLabelText("Point 2 minutes"), "10");
  await userEvent.type(screen.getByLabelText("Point 2 litres"), "55");
  await userEvent.click(check);
  expect(screen.getByRole("status").textContent).toBe("Right.");
  expect(answers).toEqual([true]);
});

test("a wrong line says so and the right one is drawn beside it", async () => {
  const answers: boolean[] = [];
  const { container } = onCard(line, answers);
  await userEvent.type(screen.getByLabelText("Point 1 minutes"), "0");
  await userEvent.type(screen.getByLabelText("Point 1 litres"), "0");
  await userEvent.type(screen.getByLabelText("Point 2 minutes"), "10");
  await userEvent.type(screen.getByLabelText("Point 2 litres"), "50");
  await userEvent.click(screen.getByRole("button", { name: "Check the line" }));
  expect(screen.getByRole("status").textContent).toBe("Not quite. The right line is drawn beside yours.");
  expect(container.querySelector("line.rl")).not.toBeNull();
  expect(answers).toEqual([false]);
});

test("two grids on one page keep their own drawing areas", () => {
  const { container } = render(<Blocks blocks={[line, line]} />);
  const ids = [...container.querySelectorAll("clipPath")].map((c) => c.id);
  expect(new Set(ids).size).toBe(2);
});
