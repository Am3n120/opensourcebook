import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApiClient } from "../api/client";
import { ApiProvider } from "../app/api";
import { baseRoutes, fakeEngine, redesignRoutes, sampleProviders } from "../test/fakeEngine";
import userEvent from "@testing-library/user-event";
import { renderWithEngine } from "../test/renderWithEngine";
import { MakerPicker } from "./MakerPicker";

async function open(props: Partial<Parameters<typeof MakerPicker>[0]> = {}) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  const utils = renderWithEngine(<MakerPicker scope="video" value={null} onChange={onChange} onClose={onClose} {...props} />);
  await screen.findByRole("tab", { name: /Alpha Code/ });
  return { ...utils, onChange, onClose };
}

test("agents are listed A to Z with nothing picked, and Use waits for a pick", async () => {
  await open();
  expect(await screen.findByRole("dialog", { name: "Made by, for videos" })).toBeInTheDocument();
  expect(screen.getAllByRole("tab").map((t) => t.querySelector(".mk-who")?.textContent)).toEqual(["Alpha Code", "Zeta Agent"]);
  expect(screen.getByRole("tab", { name: "Alpha Code" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("option", { selected: true })).toBeNull();
  expect(screen.getByRole("button", { name: "Use this" })).toBeDisabled();
});

test("models show their tier in plain words beside the real name, and the time for that exact pick", async () => {
  await open({ value: { agent: "zeta", model: "z-mid", effort: "medium" }, settings: { minutes: 3 } });
  expect(await screen.findByText("Model · time for 3 min")).toBeInTheDocument();
  const mid = screen.getByRole("option", { name: /Z Mid/ });
  expect(mid).toHaveAttribute("aria-selected", "true");
  expect(mid).toHaveTextContent("Good");
  await waitFor(() => expect(mid).toHaveTextContent("about 4 min"));
  expect(screen.getByRole("option", { name: /Z Small/ })).toHaveTextContent("Quickest");
  expect(screen.getByRole("option", { name: /Z Small/ })).toHaveTextContent("about 3 min");
  expect(screen.getByRole("option", { name: /Z Big/ })).toHaveTextContent("Best");
  expect(screen.getByRole("option", { name: /Z Big/ })).toHaveTextContent("no time yet");
});

test("another effort or length has its own time, never a neighbour's", async () => {
  await open({ value: { agent: "zeta", model: "z-mid", effort: "medium" }, settings: { minutes: 3 } });
  await screen.findByText("Model · time for 3 min");
  const mid = screen.getByRole("option", { name: /Z Mid/ });
  await waitFor(() => expect(mid).toHaveTextContent("about 4 min"));
  await userEvent.click(within(screen.getByRole("group", { name: "Effort" })).getByRole("button", { name: "High" }));
  expect(mid).toHaveTextContent("no time yet");
});

test("Use sends the agent, model and effort picked, then closes", async () => {
  const { onChange, onClose } = await open({ settings: { minutes: 3 } });
  await userEvent.click(screen.getByRole("tab", { name: "Zeta Agent" }));
  await userEvent.click(screen.getByRole("option", { name: /Z Big/ }));
  await userEvent.click(within(screen.getByRole("group", { name: "Effort" })).getByRole("button", { name: "High" }));
  await userEvent.click(screen.getByRole("button", { name: "Use this" }));
  expect(onChange).toHaveBeenCalledWith({ agent: "zeta", model: "z-big", effort: "high" });
  expect(onClose).toHaveBeenCalled();
});

test("a reviewer can be off, and its times are the review's own", async () => {
  const { onChange, calls } = await open({ role: "reviewer", allowNone: true, value: null });
  expect(await screen.findByRole("dialog", { name: "Reviewed by, for videos" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Off" })).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(calls.some((c) => c.path === "/v1/make-times" && c.query.get("scope") === "video.review")).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: "Use this" }));
  expect(onChange).toHaveBeenCalledWith(null);
});

test("the chat's picker reads the chat's times; Cancel and Escape change nothing", async () => {
  const { onChange, onClose } = await open({ scope: "chat", value: { agent: "zeta" } });
  expect(screen.getByRole("dialog", { name: "Answers the chat" })).toBeInTheDocument();
  const mid = screen.getByRole("option", { name: /Z Mid/ });
  expect(mid).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(mid).toHaveTextContent("about 10 sec"));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(onChange).not.toHaveBeenCalled();
});

test("with no agent set up it says so and points to Settings", async () => {
  renderWithEngine(<MakerPicker scope="video" value={null} onChange={() => {}} onClose={() => {}} />, {
    "GET /v1/providers": { connector: { configured: true, reachable: true }, providers: [] },
  });
  expect(await screen.findByText("No agent is set up on this computer yet.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open providers" })).toHaveAttribute("href", "/settings#providers");
});

test("while the providers are on their way it says so quietly, never that no agent is set up", async () => {
  const engine = fakeEngine({ ...baseRoutes, ...redesignRoutes });
  // Every call answers but the providers', which never does.
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/v1/providers") ? new Promise<Response>(() => undefined) : engine.fetch(input, init));
  render(
    <MemoryRouter>
      <ApiProvider client={new ApiClient({ fetch: fetchImpl as typeof fetch })}>
        <MakerPicker scope="video" value={null} onChange={vi.fn()} onClose={vi.fn()} />
      </ApiProvider>
    </MemoryRouter>,
  );
  expect(await screen.findByText("Looking for your agents…")).toBeInTheDocument();
  expect(screen.queryByText(/No agent is set up/)).toBeNull();
  expect(screen.queryByText(/Couldn't reach/)).toBeNull();
});

test("when the engine can't be reached it says so with Try again, and Try again loads them", async () => {
  let calls = 0;
  renderWithEngine(<MakerPicker scope="video" value={null} onChange={vi.fn()} onClose={vi.fn()} />, {
    "GET /v1/providers": () => (++calls === 1 ? [503, { error: "unreachable", message: "down" }] : { connector: { configured: true, reachable: true }, providers: [] }),
  });
  expect(await screen.findByText("Couldn't reach the engine.")).toBeInTheDocument();
  expect(screen.queryByText(/No agent is set up/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No agent is set up on this computer yet.")).toBeInTheDocument();
});

test("more than three efforts are a compact list, so no level's name wraps", async () => {
  const five = [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra high" },
    { id: "max", label: "Max" },
  ];
  const onChange = vi.fn();
  renderWithEngine(<MakerPicker scope="video" value={{ agent: "zeta", model: "z-mid", effort: "medium" }} onChange={onChange} onClose={vi.fn()} />, {
    "GET /v1/providers": { ...sampleProviders, providers: sampleProviders.providers.map((p) => (p.id === "zeta" ? { ...p, efforts: five } : p)) },
  });
  const effort = await screen.findByRole("combobox", { name: "Effort" });
  expect(screen.queryByRole("group", { name: "Effort" })).toBeNull();
  expect([...effort.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
  await userEvent.selectOptions(effort, "xhigh");
  await userEvent.click(screen.getByRole("button", { name: "Use this" }));
  expect(onChange).toHaveBeenCalledWith({ agent: "zeta", model: "z-mid", effort: "xhigh" });
});
