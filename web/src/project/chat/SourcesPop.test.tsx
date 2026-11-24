import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { sampleSources } from "../../test/fakeEngine";
import { SourcesChip } from "./SourcesPop";

afterEach(() => vi.unstubAllGlobals());

function phoneWidth() {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} }));
}

test("on a phone the chip is the count, and it opens the same list of what the chat reads", async () => {
  phoneWidth();
  const onChange = vi.fn();
  render(<SourcesChip sources={sampleSources} unselected={new Set(["s2"])} onChange={onChange} />);
  const chip = screen.getByRole("button", { name: "This chat reads 1 of 2 sources. Change" });
  expect(chip).toHaveTextContent("1/2");
  await userEvent.click(chip);
  const list = screen.getByRole("dialog", { name: "This chat reads" });
  await userEvent.click(within(list).getByRole("button", { name: "Use all 2" }));
  expect(onChange).toHaveBeenCalledWith(new Set());
});

test("on a wide screen the chip says it in words", () => {
  render(<SourcesChip sources={sampleSources} unselected={new Set()} onChange={() => undefined} />);
  expect(screen.getByRole("button", { name: "This chat reads 2 sources. Change" })).toHaveTextContent("2 sources");
});
