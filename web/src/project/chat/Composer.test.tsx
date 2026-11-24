import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { Mentionable } from "../mentions";
import { Composer } from "./Composer";

const all: Mentionable[] = [
  { group: "Sources", key: "s:1", name: "Cell cycle checkpoints", detail: "text · ticked" },
  { group: "Chats", key: "c:1", name: "Mitosis", detail: "this chat · 4 messages" },
];

function box() {
  render(
    <MemoryRouter>
      <Composer all={all} commands={[]} formats={[]} onSend={() => undefined} onOpen={() => undefined} disabled={false} archived={false} manySources />
    </MemoryRouter>,
  );
  return screen.getByRole("textbox", { name: "Message" });
}

test("Esc closes the @ list and keeps what was typed; typing opens it again", async () => {
  const text = box();
  await userEvent.type(text, "about @che");
  expect(screen.getByRole("listbox", { name: "Mention" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox", { name: "Mention" })).not.toBeInTheDocument();
  expect(text).toHaveValue("about @che");
  await userEvent.type(text, "c");
  expect(screen.getByRole("listbox", { name: "Mention" })).toBeInTheDocument();
});
