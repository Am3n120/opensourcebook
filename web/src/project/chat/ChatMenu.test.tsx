import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Chat } from "../../api/types";
import { ChatMenu } from "./ChatMenu";

const chats = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}`, updatedAt: "2026-01-01T00:00:00Z" }) as unknown as Chat);

test("with many chats only the list scrolls: New chat, Rename and Delete stay together at the foot", async () => {
  render(<ChatMenu chats={chats} chatId="c0" title="Chat 0" onOpen={() => undefined} onRename={() => undefined} onDelete={() => undefined} />);
  await userEvent.click(screen.getByRole("button", { name: /Chat 0/ }));
  const list = document.querySelector(".cmenu-list") as HTMLElement;
  const foot = document.querySelector(".cmenu-foot") as HTMLElement;
  expect(within(list).getAllByRole("button")).toHaveLength(12);
  expect(within(foot).getAllByRole("button").map((b) => b.textContent)).toEqual(["New chat", "Rename this chat", "Delete this chat…"]);
  expect(list.contains(foot)).toBe(false);
});
