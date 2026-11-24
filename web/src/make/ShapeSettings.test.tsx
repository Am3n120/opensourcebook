import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { FormatDescriptor, JsonObject } from "../api/types";
import { renderWithEngine } from "../test/renderWithEngine";
import { sampleVideoFormat } from "../test/fakeEngine";
import { ShapeSettings } from "./ShapeSettings";

const video: FormatDescriptor = {
  ...sampleVideoFormat,
  settings: [
    ...sampleVideoFormat.settings.slice(0, 1),
    {
      key: "aspect",
      label: "Shape",
      kind: "choice",
      options: [
        { value: "portrait", label: "Tall 9:16" },
        { value: "landscape", label: "Wide 16:9" },
      ],
    },
    ...sampleVideoFormat.settings.slice(1),
  ],
  defaults: { ...sampleVideoFormat.defaults, aspect: "portrait" },
};

const quiz: FormatDescriptor = {
  id: "quiz",
  label: "quiz",
  plural: "quizzes",
  colorSlot: 3,
  icon: "check",
  ready: true,
  settings: [
    { key: "questions", label: "Questions", kind: "number", min: 0, max: 60, step: 1, specialValues: [{ value: 0, means: "auto", label: "Fit to the brief" }] },
    {
      key: "kinds",
      label: "Question kinds",
      kind: "choices",
      minItems: 1,
      maxItems: 3,
      options: [
        { value: "choice", label: "A choice" },
        { value: "steps", label: "Worked in steps" },
        { value: "order", label: "Put in order" },
      ],
    },
    {
      key: "difficulty",
      label: "Difficulty",
      kind: "choice",
      options: [
        { value: "auto", label: "From the brief" },
        { value: "easy", label: "Easier" },
        { value: "hard", label: "Harder" },
      ],
    },
    { key: "passMark", label: "Pass mark", kind: "number", min: 0, max: 100, step: 5, unit: "%" },
    { key: "timeLimit", label: "Time limit", kind: "number", min: 0, max: 180, step: 5, unit: "min", specialValues: [{ value: 0, means: "none", label: "No time limit", description: "Take as long as you need." }] },
    { key: "agent", label: "Agent & model", kind: "agent", role: "make", effortKey: "effort" },
  ],
  defaults: { questions: 0, kinds: ["choice", "steps"], difficulty: "auto", passMark: 70, timeLimit: 0 },
};

function Harness({ format, start = {}, seen }: { format: FormatDescriptor; start?: JsonObject; seen: (s: JsonObject) => void }) {
  const [settings, setSettings] = useState<JsonObject>(start);
  return (
    <ShapeSettings
      format={format}
      settings={settings}
      onChange={(next) => {
        seen(next);
        setSettings(next);
      }}
    />
  );
}

test("a length is Auto with no number until Custom, then steps within the field's own range", async () => {
  const seen = vi.fn();
  renderWithEngine(<Harness format={video} seen={seen} />);
  const length = screen.getByRole("group", { name: "Length" });
  expect(within(length).getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("group", { name: "Length, min" })).toBeNull();
  await userEvent.click(within(length).getByRole("button", { name: "Custom" }));
  expect(seen).toHaveBeenLastCalledWith({ minutes: 1 });
  const stepper = screen.getByRole("group", { name: "Length, min" });
  expect(within(stepper).getByRole("button", { name: "Less" })).toBeDisabled();
  await userEvent.click(within(stepper).getByRole("button", { name: "More" }));
  expect(seen).toHaveBeenLastCalledWith({ minutes: 2 });
  await userEvent.click(within(length).getByRole("button", { name: "Auto" }));
  expect(seen).toHaveBeenLastCalledWith({});
});

test("a two-way choice is a segmented switch, a style with pictures is the style row, and who makes it is not here", async () => {
  const seen = vi.fn();
  renderWithEngine(<Harness format={video} seen={seen} />);
  const shape = screen.getByRole("group", { name: "Shape" });
  expect(within(shape).getByRole("button", { name: "Tall 9:16" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(within(shape).getByRole("button", { name: "Wide 16:9" }));
  expect(seen).toHaveBeenLastCalledWith({ aspect: "landscape" });
  expect(await screen.findByRole("button", { name: /Style: Maker's pick\. Change/ })).toBeInTheDocument();
  expect(screen.queryByText("Agent & model")).toBeNull();
  expect(screen.queryByText("Reviewed by")).toBeNull();
});

test("every shape the engine offers is one part of the switch, in its own words; a fifth option, or long ones, make it a list", async () => {
  const choice = (labels: string[]): FormatDescriptor => ({
    ...video,
    settings: [{ key: "aspect", label: "Shape", kind: "choice", options: labels.map((label, i) => ({ value: `o${i}`, label })) }],
    defaults: { aspect: "o0" },
  });
  const seen = vi.fn();
  const a = renderWithEngine(<Harness format={choice(["Portrait (9:16)", "Landscape (16:9)", "Square (1:1)"])} seen={seen} />);
  const shape = screen.getByRole("group", { name: "Shape" });
  expect(within(shape).getAllByRole("button").map((b) => b.textContent)).toEqual(["Portrait (9:16)", "Landscape (16:9)", "Square (1:1)"]);
  await userEvent.click(within(shape).getByRole("button", { name: "Square (1:1)" }));
  expect(seen).toHaveBeenLastCalledWith({ aspect: "o2" });
  a.unmount();
  const b = renderWithEngine(<Harness format={choice(["One", "Two", "Three", "Four", "Five"])} seen={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "Shape" })).toBeInTheDocument();
  b.unmount();
  renderWithEngine(<Harness format={choice(["After each question", "At the end"])} seen={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "Shape" })).toBeInTheDocument();
});

test("a limit whose zero means none is off or on with a number, not Auto or Custom", async () => {
  const seen = vi.fn();
  renderWithEngine(<Harness format={quiz} seen={seen} />);
  const limit = screen.getByRole("group", { name: "Time limit" });
  expect(within(limit).queryByRole("button", { name: "Auto" })).toBeNull();
  expect(within(limit).getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("No time limit")).toBeInTheDocument();
  expect(screen.getByText("Take as long as you need.")).toBeInTheDocument();
  await userEvent.click(within(limit).getByRole("button", { name: "On" }));
  expect(seen).toHaveBeenLastCalledWith({ timeLimit: 5 });
  expect(within(screen.getByRole("group", { name: "Time limit, min" })).getByText("5 min")).toBeInTheDocument();
  // The count of questions is still Auto | Custom.
  expect(within(screen.getByRole("group", { name: "Questions" })).getByRole("button", { name: "Auto" })).toBeInTheDocument();
});

test("a plain number steps with its unit, kinds are chips that keep the fewest allowed, other choices are a list", async () => {
  const seen = vi.fn();
  renderWithEngine(<Harness format={quiz} seen={seen} />);
  const pass = screen.getByRole("group", { name: "Pass mark" });
  expect(within(pass).getByText("70%")).toBeInTheDocument();
  await userEvent.click(within(pass).getByRole("button", { name: "More" }));
  expect(seen).toHaveBeenLastCalledWith({ passMark: 75 });

  const kinds = screen.getByRole("group", { name: "Question kinds" });
  await userEvent.click(within(kinds).getByRole("button", { name: "Put in order" }));
  expect(seen).toHaveBeenLastCalledWith({ passMark: 75, kinds: ["choice", "steps", "order"] });

  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Difficulty" }), "hard");
  expect(seen).toHaveBeenLastCalledWith({ passMark: 75, kinds: ["choice", "steps", "order"], difficulty: "hard" });
});

test("the last kind left cannot be taken off", () => {
  renderWithEngine(<Harness format={quiz} start={{ kinds: ["choice"] }} seen={vi.fn()} />);
  expect(within(screen.getByRole("group", { name: "Question kinds" })).getByRole("button", { name: "A choice" })).toBeDisabled();
});

test("what a zero means is read from the engine, not from its label", () => {
  const field = (means: "auto" | "none" | undefined, label: string): FormatDescriptor => ({
    ...video,
    settings: [{ key: "n", label: "Amount", kind: "number", min: 0, max: 10, step: 1, specialValues: [{ value: 0, ...(means ? { means } : {}), label }] }],
    defaults: { n: 0 },
  });
  // A label that starts with "No" but means the sources decide: Auto | Custom.
  const a = renderWithEngine(<Harness format={field("auto", "No fixed number")} seen={vi.fn()} />);
  expect(within(screen.getByRole("group", { name: "Amount" })).getByRole("button", { name: "Auto" })).toBeInTheDocument();
  a.unmount();
  // A label that says nothing about a limit but means none: a limit that is off.
  const b = renderWithEngine(<Harness format={field("none", "Unlimited")} seen={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Auto" })).toBeNull();
  b.unmount();
  // No `means` (an older engine): the old reading of the words.
  renderWithEngine(<Harness format={field(undefined, "No limit")} seen={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Auto" })).toBeNull();
});

test("two short fields share a row and wide ones take the whole row, by each field's kind", () => {
  const field = (key: string) => screen.getByText(key, { selector: ".ss-lbl" }).closest(".ss-field");
  renderWithEngine(<Harness format={quiz} seen={vi.fn()} />);
  // Counts, limits and lists to pick from are short; chips are wide.
  for (const short of ["Questions", "Difficulty", "Pass mark", "Time limit"]) expect(field(short)).not.toHaveClass("wide");
  expect(field("Question kinds")).toHaveClass("wide");
});
