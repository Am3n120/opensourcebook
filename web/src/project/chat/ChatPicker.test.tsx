import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { sampleProviders } from "../../test/fakeEngine";
import { ChatPicker } from "./ChatPicker";

function open(props: Partial<Parameters<typeof ChatPicker>[0]> = {}) {
  const onPick = vi.fn();
  const onEffort = vi.fn();
  render(
    <MemoryRouter>
      <ChatPicker providers={sampleProviders} onPick={onPick} onEffort={onEffort} {...props} />
    </MemoryRouter>,
  );
  return { onPick, onEffort };
}

test("the chip says who answers the chat, and the picker says it decides nothing that is made", async () => {
  open({ picked: "agent:zeta:z-mid", effort: "low" });
  const chip = screen.getByRole("button", { name: "Chat answers with Zeta Agent, Z Mid, Low. Change" });
  expect(chip).toHaveTextContent("Chat answers withZ Mid · low");
  await userEvent.click(chip);
  const dialog = screen.getByRole("dialog", { name: "Who answers this chat" });
  expect(dialog).toHaveTextContent("It never decides what makes a video, a quiz or anything else");
  expect(within(dialog).getByRole("link", { name: "Defaults in Settings" })).toBeInTheDocument();
});

test("agents A to Z, models by their real names with their tier in plain words, and a pick and an effort go back at once", async () => {
  const { onPick, onEffort } = open({ picked: "agent:zeta:z-mid" });
  await userEvent.click(screen.getByRole("button", { name: /^Chat answers with/ }));
  expect(screen.getAllByRole("tab").map((t) => t.lastElementChild?.textContent)).toEqual(["Alpha Code", "Zeta Agent"]);
  expect(screen.getByRole("tab", { name: /Zeta Agent/ })).toHaveAttribute("aria-selected", "true");
  const models = within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option");
  expect(models.map((m) => m.textContent)).toEqual(["Z SmallQuickest", "Z MidGood", "Z BigBest"]);
  expect(models[1]).toHaveAttribute("aria-selected", "true");
  await userEvent.click(models[2]!);
  expect(onPick).toHaveBeenCalledWith("agent:zeta:z-big");
  await userEvent.click(within(screen.getByRole("group", { name: "Effort" })).getByRole("button", { name: "High" }));
  expect(onEffort).toHaveBeenCalledWith("high");
});

test("a chat that never picked shows the chat's default from Settings", () => {
  open({ providers: { ...sampleProviders, picks: { chat: { agent: "zeta", model: "z-small", effort: "high" } } } });
  expect(screen.getByRole("button", { name: "Chat answers with Zeta Agent, Z Small, High. Change" })).toBeInTheDocument();
});

test("a model's plain-words line is the tier its connector declares, for every provider; a model with none has no line", async () => {
  open({ picked: "agent:alpha:a-one" });
  await userEvent.click(screen.getByRole("button", { name: /^Chat answers with/ }));
  expect(within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option").map((m) => m.textContent)).toEqual(["A One"]);
  await userEvent.click(screen.getByRole("tab", { name: /Zeta Agent/ }));
  expect(within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option").map((m) => m.textContent)).toEqual(["Z SmallQuickest", "Z MidGood", "Z BigBest"]);
});

test("while the providers load the chip is quiet and empty, and a failed load says Couldn't reach the engine with Try again", async () => {
  const { unmount } = render(
    <MemoryRouter>
      <ChatPicker load="loading" onPick={() => undefined} onEffort={() => undefined} />
    </MemoryRouter>,
  );
  expect(screen.getByRole("status", { name: "Finding who answers the chat" })).toBeEmptyDOMElement();
  expect(screen.queryByText("Set up a provider")).not.toBeInTheDocument();
  unmount();
  const retry = vi.fn();
  render(
    <MemoryRouter>
      <ChatPicker load="failed" onPick={() => undefined} onEffort={() => undefined} onRetry={retry} />
    </MemoryRouter>,
  );
  expect(screen.queryByText("Set up a provider")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Couldn't reach the engine. Try again." }));
  expect(retry).toHaveBeenCalledTimes(1);
});
