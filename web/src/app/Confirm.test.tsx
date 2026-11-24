import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Confirm } from "./Confirm";

test("Cancel takes focus when it opens; a later render leaves focus where the person moved it; Escape cancels", async () => {
  const cancelled: number[] = [];
  const view = (text: string) => (
    <Confirm title="Delete it?" action="Delete" onConfirm={() => undefined} onCancel={() => cancelled.push(1)}>
      <p>{text}</p>
    </Confirm>
  );
  const { rerender } = render(view("Counting…"));
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.tab();
  expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
  rerender(view("Everything in it goes."));
  expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(cancelled).toHaveLength(1);
});
