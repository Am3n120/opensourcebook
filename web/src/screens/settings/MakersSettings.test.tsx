import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { formats, redesignRoutes, sampleProviders, sampleVideoFormat, sampleVoiceSetup, type FakeRequest } from "../../test/fakeEngine";
import { renderApp } from "../../test/render";

// The picker tests click through several dialogs; they get more than the default time on a busy machine.

/** The video at 3 minutes by default, so its times are kept under "le4" like the sample runs. */
const video3 = { ...sampleVideoFormat, defaults: { ...sampleVideoFormat.defaults, minutes: 3 } };
const routes = {
  ...redesignRoutes,
  "GET /v1/formats": { formats: [video3, ...formats.filter((f) => f.id !== "video")] },
  "GET /v1/providers": { ...sampleProviders, picks: { ...sampleProviders.picks, chat: { agent: "zeta", model: "z-mid", effort: "low" } } },
};

const table = async () => screen.findByRole("table");
const row = async (name: RegExp) => within(await table()).getByRole("row", { name });

test("a row for the chat and for each shape from the format registry, with who makes it, who reviews it, its voice and how long it usually takes", async () => {
  renderApp("/settings", routes);
  const t = await table();
  expect(within(t).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["For", "Made by", "Reviewed by", "Voice", "Usually takes?"]);
  const rows = within(t).getAllByRole("row").slice(1);
  expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual(["The chat", "video", "flashcards", "quiz"]);

  const chat = rows[0]!;
  expect(chat).toHaveTextContent("Z MidZeta Agent · low");
  expect(chat).toHaveTextContent("Not for the chat");
  expect(chat).toHaveTextContent("about 10 secper reply · from your last 12");

  const video = rows[1]!;
  expect(within(video).getByRole("button", { name: "Made by, video" })).toHaveTextContent("Z MidZeta Agent · medium");
  // The sample keeps the video's reviewer off.
  expect(within(video).getByRole("button", { name: "Reviewed by, video" })).toHaveTextContent("Noneadd one");
  expect(video).toHaveTextContent("Hosted AWarm");
  expect(video).toHaveTextContent("about 4 minfor 3 min · from your last 5");

  // A shape whose format declares no reviewer, voice or agent has a dash, never a cell that pretends.
  const quiz = rows[3]!;
  expect(within(quiz).queryByRole("button")).not.toBeInTheDocument();
  expect(within(quiz).getAllByText("—")).toHaveLength(4);
});

test("a pick that has never run says no time yet, never a guess", async () => {
  renderApp("/settings", { ...routes, "GET /v1/make-times": { times: [] } });
  expect(await row(/^video/)).toHaveTextContent("no time yetnone made here");
});

test("a shape not switched on keeps its problem in its row", async () => {
  renderApp("/settings", { ...routes, "GET /v1/formats": { formats: [{ ...video3, ready: false, problem: "Needs the scene maker running." }] } });
  expect(await row(/^video/)).toHaveTextContent("videoNeeds the scene maker running.");
});

test("a maker cell opens the maker picker and saves only that shape's pick", async () => {
  const { calls } = renderApp("/settings", routes);
  await userEvent.click(within(await row(/^video/)).getByRole("button", { name: "Made by, video" }));
  const dialog = screen.getByRole("dialog", { name: "Made by, for videos" });
  await userEvent.click(within(dialog).getByRole("option", { name: /Z Big/ }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Use for videos" }));
  const put = calls.filter((c) => c.method === "PUT" && c.path.startsWith("/v1/providers/picks"));
  expect(put).toHaveLength(1);
  expect(put[0]).toMatchObject({ path: "/v1/providers/picks/video", body: { agent: "zeta", model: "z-big", effort: "medium" } });
  expect(await row(/^video/)).toHaveTextContent("Z Big");
}, 15_000);

test("a reviewer cell can turn the reviewer on with its own pick, or off", async () => {
  const { calls } = renderApp("/settings", {
    ...routes,
    "PUT /v1/providers/picks/:scope": (req: FakeRequest) => ({ ok: true, scope: req.params.scope, pick: (req.body as { off?: boolean }).off ? { off: true } : req.body }),
  });
  await userEvent.click(within(await row(/^video/)).getByRole("button", { name: "Reviewed by, video" }));
  let dialog = screen.getByRole("dialog", { name: "Reviewed by, for videos" });
  await userEvent.click(within(dialog).getByRole("tab", { name: "Zeta Agent" }));
  await userEvent.click(within(dialog).getByRole("option", { name: /Z Small/ }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Use this" }));
  expect(calls.filter((c) => c.method === "PUT").at(-1)).toMatchObject({ path: "/v1/providers/picks/video.review", body: { agent: "zeta", model: "z-small", off: null } });
  expect(within(await row(/^video/)).getByRole("button", { name: "Reviewed by, video" })).toHaveTextContent("Z Small");

  await userEvent.click(within(await row(/^video/)).getByRole("button", { name: "Reviewed by, video" }));
  dialog = screen.getByRole("dialog", { name: "Reviewed by, for videos" });
  await userEvent.click(within(dialog).getByRole("tab", { name: "Off" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Use this" }));
  expect(calls.filter((c) => c.method === "PUT").at(-1)).toMatchObject({ path: "/v1/providers/picks/video.review", body: { off: true, agent: null } });
  expect(within(await row(/^video/)).getByRole("button", { name: "Reviewed by, video" })).toHaveTextContent("None");
}, 15_000);

test("Use one for all sets the chat and every shape that has a maker in one write, and never a reviewer", async () => {
  const { calls } = renderApp("/settings", routes);
  await table();
  await userEvent.click(screen.getByRole("button", { name: "Use one for all" }));
  const dialog = screen.getByRole("dialog", { name: "Use one for all" });
  await userEvent.click(within(dialog).getByRole("tab", { name: "Alpha Code" }));
  await userEvent.click(within(dialog).getByRole("option", { name: /A One/ }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Use for all" }));
  const put = calls.find((c) => c.method === "PUT" && c.path === "/v1/providers/picks");
  const patch = { agent: "alpha", model: "a-one", effort: null };
  expect(put?.body).toEqual({ picks: { chat: patch, video: patch } });
  expect(await row(/^The chat/)).toHaveTextContent("A OneAlpha Code");
}, 15_000);

test("with no voice set up, a voiced shape says so, and its cell opens the voice picker with the way to set one up", async () => {
  renderApp("/settings", { ...routes, "GET /v1/voice": { ...sampleVoiceSetup, service: undefined, voice: undefined, from: "none" } });
  const cell = await vi.waitFor(async () => within(await row(/^video/)).getByRole("button", { name: "Voice, video" }));
  expect(cell).toHaveTextContent("Not set up");
  await userEvent.click(cell);
  const picker = await screen.findByRole("dialog", { name: "Voice" });
  expect(await within(picker).findByRole("link", { name: /On this computer, not set up/ })).toHaveAttribute("href", "/settings?voice=local-b#voice");
});

test("the voice cell opens a dropdown of the voice services, and a pick there changes the voice in every row at once", async () => {
  const { calls } = renderApp("/settings", routes);
  const cell = await vi.waitFor(async () => within(await row(/^video/)).getByRole("button", { name: "Voice, video" }));
  expect(cell).toHaveTextContent("Hosted AWarm");
  await userEvent.click(cell);
  const picker = await screen.findByRole("dialog", { name: "Voice" });
  expect(picker).toHaveTextContent("One voice speaks every video and audio.");
  await userEvent.click(await within(picker).findByRole("radio", { name: /Bright/ }));
  expect(calls.find((c) => c.method === "PUT" && c.path === "/v1/voice")?.body).toEqual({ service: "hosted-a", voice: "v2" });
  await vi.waitFor(async () => expect(within(await row(/^video/)).getByRole("button", { name: "Voice, video" })).toHaveTextContent("Hosted ABright"));
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Voice" })).toBeNull();
});

test("the ? says why the time changes", async () => {
  renderApp("/settings", routes);
  await table();
  await userEvent.click(screen.getByRole("button", { name: "Why the time changes" }));
  expect(screen.getByRole("note")).toHaveTextContent("A pick that has never run shows \"no time yet\" instead of a guess.");
});

test("a failed load says it could not reach the engine and offers a retry, never an empty list", async () => {
  let up = false;
  renderApp("/settings", { ...routes, "GET /v1/providers": () => (up ? [200, routes["GET /v1/providers"]] : [502, { error: "bad_gateway", message: "down" }]) });
  expect(await screen.findByText("Couldn't reach the engine. Try again.")).toBeInTheDocument();
  expect(screen.queryByText(/No agent is connected/)).not.toBeInTheDocument();
  expect(screen.queryByText("Not picked")).not.toBeInTheDocument();
  up = true;
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await table()).toBeInTheDocument();
});

test("the rows keep the engine's order after the chat, and the voice cell is the service over the voice's name", async () => {
  renderApp("/settings", routes);
  const t = await table();
  const order = within(t).getAllByRole("row").slice(1).map((r) => within(r).getByRole("rowheader").textContent);
  expect(order).toEqual(["The chat", ...routes["GET /v1/formats"].formats.map((f) => f.label)]);
  expect(await row(/^video/)).toHaveTextContent("Hosted AWarm");
});
