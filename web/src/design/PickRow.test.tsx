import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PickRow } from "./PickRow";

test("a row that opens a picker is one button with its title, sub line and time", async () => {
  const open = vi.fn();
  render(<PickRow mark={<span>M</span>} title="Reviewed by" sub="a model · low effort" time="no time yet" timeSub="first run with these" timeMuted onClick={open} />);
  const row = screen.getByRole("button");
  expect(row).toHaveTextContent("Reviewed bya model · low effortno time yetfirst run with these");
  expect(row.querySelector(".pick-chev")).not.toBeNull();
  await userEvent.click(row);
  expect(open).toHaveBeenCalledOnce();
});

test("a row with nothing to pick is plain words with no chevron", () => {
  const { container } = render(<PickRow title="Voice" sub="the voice you picked" />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(container.querySelector(".pick-chev")).toBeNull();
});
