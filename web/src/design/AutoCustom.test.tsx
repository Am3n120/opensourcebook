import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { AutoCustom } from "./AutoCustom";

function Harness({ start = null as number | null }) {
  const [value, setValue] = useState<number | null>(start);
  return <AutoCustom label="Length" value={value} onChange={setValue} min={0} max={30} step={1} unit="min" start={3} />;
}

test("Auto shows no number; Custom shows − number + from where it starts", async () => {
  render(<Harness />);
  expect(screen.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(/min$/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Custom" }));
  expect(screen.getByText("3 min")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  expect(screen.getByText("4 min")).toBeInTheDocument();
});

test("the number stays within min and max, and Custom comes back to the last number", async () => {
  render(<Harness start={30} />);
  expect(screen.getByRole("button", { name: "More" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Less" }));
  await userEvent.click(screen.getByRole("button", { name: "Auto" }));
  expect(screen.queryByText(/min$/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Custom" }));
  expect(screen.getByText("29 min")).toBeInTheDocument();
});
