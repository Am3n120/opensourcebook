import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { Provider, Providers } from "../api/types";
import { Ctx } from "../app/context";
import { ModelPicker } from "./ModelPicker";

const AGENT = { path: "M0 0h24v24H0z", color: "#123456" };
const MAKER = { path: "M1 1h22v22H1z" };

function provider(over: Partial<Provider>): Provider {
  return { id: "a", label: "Agent A", added: true, enabled: true, state: "ready", headline: "Ready", pick: "agent:a", models: [], efforts: [], ...over };
}

const providers: Providers = {
  connector: { configured: true, reachable: true },
  providers: [
    provider({
      mark: AGENT,
      default: true,
      makers: { m: { label: "Maker M", mark: MAKER } },
      models: [
        { id: "one", pick: "agent:a:one", label: "One", shown: true, favorite: false, maker: "m" },
        { id: "two", pick: "agent:a:two", label: "Two", shown: true, favorite: false },
      ],
    }),
    provider({ id: "b", label: "Bee", pick: "agent:b" }),
  ],
};

function open() {
  const { container } = render(
    <MemoryRouter>
      <ModelPicker providers={providers} picked="agent:a:one" onPick={() => undefined} onEffort={() => undefined} onFavorite={() => undefined} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Who answers/ }));
  return container;
}

const pathOf = (el: Element | null) => el?.querySelector("svg.pmark path")?.getAttribute("d");

test("the chip and the rail show each agent's own logo, and one with none its initial", () => {
  const container = open();
  expect(pathOf(container.querySelector(".mp-chip"))).toBe(AGENT.path);
  expect(container.querySelector(".mp-chip svg.pmark")?.getAttribute("style")).toContain("color: rgb(18, 52, 86)");
  expect(pathOf(screen.getByRole("tab", { name: "Agent A" }))).toBe(AGENT.path);
  expect(screen.getByRole("tab", { name: "Bee" }).querySelector(".pmark.mono")?.textContent).toBe("B");
});

test("a model shows its maker's logo, else its agent's, and its maker's name finds it", () => {
  open();
  expect(pathOf(screen.getByRole("option", { name: "One" }))).toBe(MAKER.path);
  expect(pathOf(screen.getByRole("option", { name: "Two" }))).toBe(AGENT.path);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search models" }), { target: { value: "maker m" } });
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["OneAgent A"]);
});

test("placement='down' renders in document.body portal and clicking inside does not dismiss it", () => {
  render(
    <MemoryRouter>
      <div data-testid="wrapper">
        <ModelPicker providers={providers} picked="agent:a:one" placement="down" onPick={() => undefined} onEffort={() => undefined} onFavorite={() => undefined} />
      </div>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Who answers/ }));
  const dialog = screen.getByRole("dialog", { name: "Who answers this chat" });
  expect(dialog.className).toContain("down");
  expect(dialog.parentElement).toBe(document.body);
  expect(screen.getByTestId("wrapper").contains(dialog)).toBe(false);
  fireEvent.mouseDown(screen.getByRole("searchbox", { name: "Search models" }));
  expect(screen.getByRole("dialog", { name: "Who answers this chat" })).toBeInTheDocument();
});

test("turnKind='work' uses work defaults and work wording", () => {
  const workProviders: Providers = {
    connector: { configured: true, reachable: true },
    providers: [
      provider({
        default: true,
        defaultModel: "one",
        defaultEffort: "low",
        models: [
          { id: "one", pick: "agent:a:one", label: "One", shown: true, favorite: false, tier: "fast" },
          { id: "two", pick: "agent:a:two", label: "Two", shown: true, favorite: false, tier: "balanced" },
        ],
        efforts: [
          { id: "low", label: "Low", weight: "light" },
          { id: "high", label: "High", weight: "high" },
        ],
      }),
      provider({
        id: "b",
        label: "Bee",
        pick: "agent:b",
        workDefault: true,
        workDefaultModel: "bee-work",
        workDefaultEffort: "high",
        models: [
          { id: "bee-chat", pick: "agent:b:bee-chat", label: "Bee Chat", shown: true, favorite: false, tier: "fast" },
          { id: "bee-work", pick: "agent:b:bee-work", label: "Bee Work", shown: true, favorite: false, tier: "balanced" },
        ],
        efforts: [
          { id: "low", label: "Low", weight: "light" },
          { id: "high", label: "High", weight: "high" },
        ],
      }),
    ],
  };
  render(
    <MemoryRouter>
      <ModelPicker providers={workProviders} turnKind="work" onPick={() => undefined} onEffort={() => undefined} onFavorite={() => undefined} />
    </MemoryRouter>,
  );
  const chip = screen.getByRole("button", { name: /Model and effort: Bee, Bee Work, High/ });
  fireEvent.click(chip);
  const dialog = screen.getByRole("dialog", { name: "Model and effort" });
  expect(dialog).toHaveTextContent(/Made by your own Bee.*A stronger model and higher effort/);
  expect(screen.getByRole("option", { name: /High/ })).toHaveTextContent("Highdefault");
});

test("with no providers yet it reads the app's load: quiet while loading, Try again when the engine can't be reached", () => {
  const retry = vi.fn();
  const app = (status: "loading" | "failed") => ({ client: {} as never, formats: [], edgeKinds: [], refreshInbox: () => undefined, providersStatus: status, retryProviders: retry });
  const draw = (status: "loading" | "failed") => (
    <MemoryRouter>
      <Ctx.Provider value={app(status)}>
        <ModelPicker onPick={() => undefined} onEffort={() => undefined} onFavorite={() => undefined} />
      </Ctx.Provider>
    </MemoryRouter>
  );
  const { rerender } = render(draw("loading"));
  expect(screen.getByRole("status")).toHaveTextContent("Looking for your agents…");
  expect(screen.queryByText(/Set up a provider/)).toBeNull();
  rerender(draw("failed"));
  fireEvent.click(screen.getByRole("button", { name: "Couldn't reach the engine. Try again." }));
  expect(retry).toHaveBeenCalled();
});
