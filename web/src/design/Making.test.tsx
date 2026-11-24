import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Making } from "./Making";

test("while making: the words passed in, a line with its fraction, and one Stop", async () => {
  const stop = vi.fn();
  render(<Making state="making" title="Why a cell checks itself" text="Making video · 4 min" progress={0.42} progressLabel="3 of 7 scenes" onStop={stop} />);
  expect(screen.getByRole("status")).toHaveTextContent("Why a cell checks itselfMaking video · 4 minStop");
  expect(screen.getByRole("progressbar", { name: "3 of 7 scenes" })).toHaveAttribute("aria-valuenow", "42");
  // Stop wears the small square, never an "x".
  const icon = screen.getByRole("button", { name: "Stop" }).querySelector("svg");
  expect(icon?.querySelector("rect")).not.toBeNull();
  expect(icon?.querySelector("path")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(stop).toHaveBeenCalledOnce();
});

test("with no fraction the line still moves, and carries no number", () => {
  render(<Making state="making" text="Making quiz · 2 min" />);
  expect(screen.getByRole("progressbar", { name: "Making quiz · 2 min" })).not.toHaveAttribute("aria-valuenow");
});

test("waiting can be stopped but has no line", () => {
  render(<Making state="waiting" text="Waiting · about 2 min" onStop={() => {}} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
});

test.each(["stopped", "failed", "done"] as const)("%s shows its one way on and no Stop", (state) => {
  render(<Making state={state} text="words" onStop={() => {}} action={<button type="button">Go on</button>} />);
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByRole("button", { name: "Go on" })).toBeInTheDocument();
});

test("the tag look is one line with its Stop, for the Home card", () => {
  render(<Making look="tag" state="making" text="Making video · 4 min" onStop={() => {}} />);
  expect(screen.getByRole("status")).toHaveTextContent("Making video · 4 minStop");
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("only the state's word leads in its colour class and the rest is plain; a failure is one sentence", () => {
  const { container, rerender } = render(<Making state="making" text="Making video · 4 min" progress={0.4} />);
  expect(container.querySelector(".making-st .w")).toHaveTextContent(/^Making$/);
  expect(container.querySelector(".making-line i")).not.toBeNull();
  rerender(<Making state="stopped" text="Stopped before it was made" />);
  expect(container.querySelector(".making-st .w")).toHaveTextContent(/^Stopped$/);
  rerender(<Making state="failed" text="Couldn't be made: scene 4 failed" />);
  expect(container.querySelector(".making-st .w")).toBeNull();
  expect(container.querySelector(".making-st .dot")).toBeNull();
});
