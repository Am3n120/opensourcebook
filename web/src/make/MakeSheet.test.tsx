import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormatDescriptor, PlanView } from "../api/types";
import { renderWithEngine } from "../test/renderWithEngine";
import { formats, now, sampleMakePiece, sampleProviders, sampleVideoFormat } from "../test/fakeEngine";
import { MakeSheet } from "./MakeSheet";
import { makeLabel, sheetTitle } from "./prefill";

const src = (id: string, title: string) => ({
  id,
  projectId: "p1",
  kind: "pdf",
  title,
  status: "ready",
  createdAt: now,
  updatedAt: now,
});
const view = {
  plan: {
    id: "pl9",
    projectId: "p1",
    title: "Made",
    version: 1,
    status: "running",
    createdAt: now,
    updatedAt: now,
  },
  stages: [],
  items: [],
  edges: [],
  counts: { total: 1, done: 0 },
  issues: [],
} as unknown as PlanView;

const audio: FormatDescriptor = {
  id: "audio",
  label: "audio",
  colorSlot: 4,
  icon: "listen",
  blurb: "a spoken walk-through",
  settings: [
    {
      key: "minutes",
      label: "Length",
      kind: "number",
      min: 0,
      max: 40,
      step: 1,
      unit: "min",
      specialValues: [{ value: 0, label: "Fit to the brief" }],
    },
  ],
  defaults: { minutes: 0 },
  ready: false,
  problem: "Audio needs a voice. None is set up on this computer, so it can't be made yet.",
  voiced: true,
};

function routes(more: Record<string, unknown> = {}) {
  return {
    "GET /v1/formats": {
      formats: [sampleVideoFormat, ...formats.filter((f) => f.id !== "video"), audio],
    },
    "GET /v1/projects/:id/sources": {
      sources: [src("s1", "Lecture 7 slides"), src("s2", "Chapter 12"), src("s3", "Lab notes")],
    },
    "POST /v1/projects/:id/make/settle": {
      settings: {},
      plannedAs: "",
      issues: [],
    },
    "POST /v1/projects/:id/make": view,
    ...more,
  };
}

function open(props: Partial<Parameters<typeof MakeSheet>[0]> = {}, more: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const onMade = vi.fn();
  const utils = renderWithEngine(<MakeSheet projectId="p1" shape="video" sources={["s1", "s2"]} onClose={onClose} onMade={onMade} {...props} />, routes(more));
  return { ...utils, onClose, onMade };
}

test("the title and button come from the shape's own words", () => {
  expect(sheetTitle(sampleVideoFormat)).toBe("Make a video");
  expect(makeLabel(sampleVideoFormat)).toBe("Make the video");
  expect(sheetTitle({ ...audio })).toBe("Make an audio");
  const flashcards = {
    ...formats[1]!,
    settings: [],
    defaults: {},
  } as FormatDescriptor;
  expect(sheetTitle(flashcards)).toBe("Make a set of flashcards");
  expect(makeLabel(flashcards)).toBe("Make the flashcards");
});

test("it reads the ticked sources, draws the shape's settings and who makes it, and makes nothing until its button", async () => {
  const { calls, onMade } = open();
  expect(await screen.findByRole("heading", { name: "Make a video" })).toBeInTheDocument();
  const reads = screen.getByRole("group", { name: "Reads" });
  await waitFor(() => expect(within(reads).getByText("Lecture 7 slides")).toBeInTheDocument());
  // A plain list of names, each with a small × to take it out; not a row of switches.
  expect(within(reads).queryByRole("button", { pressed: true })).toBeNull();
  expect(within(reads).getByRole("button", { name: "Take Chapter 12 out" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Length" })).toBeInTheDocument();
  expect(await screen.findByText("Your default for videos")).toBeInTheDocument();
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/projects/p1/make")).toBe(false);

  await userEvent.type(screen.getByRole("textbox", { name: "What it covers" }), "The spindle checkpoint");
  await userEvent.click(
    within(screen.getByRole("group", { name: "Length" })).getByRole("button", {
      name: "Custom",
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Make the video" }));
  await waitFor(() => expect(onMade).toHaveBeenCalledWith(view));
  const made = calls.find((c) => c.method === "POST" && c.path === "/v1/projects/p1/make")!;
  expect(made.body).toEqual({
    format: "video",
    about: "The spindle checkpoint",
    sources: ["s1", "s2"],
    settings: { minutes: 1 },
  });
  // Nothing was written as a default.
  expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
});

test("the sources it reads can be changed on the sheet", async () => {
  const { calls, onMade } = open();
  const reads = await screen.findByRole("group", { name: "Reads" });
  await waitFor(() => expect(within(reads).getByRole("button", { name: "Take Chapter 12 out" })).toBeInTheDocument());
  await userEvent.click(within(reads).getByRole("button", { name: "Take Chapter 12 out" }));
  expect(within(reads).queryByText("Chapter 12")).toBeNull();
  await userEvent.click(within(reads).getByRole("button", { name: "+ Add" }));
  await userEvent.click(within(reads).getByRole("button", { name: "Add Lab notes" }));
  await userEvent.click(screen.getByRole("button", { name: "Make the video" }));
  await waitFor(() => expect(onMade).toHaveBeenCalled());
  expect(
    (
      calls.find((c) => c.path === "/v1/projects/p1/make")!.body as {
        sources: string[];
      }
    ).sources,
  ).toEqual(["s1", "s3"]);
});

test("opened from a chat proposal it starts filled in, marks the proposal made, and closes it on Cancel", async () => {
  const prefill = {
    ...sampleMakePiece,
    chatId: "c1",
    messageId: "m1",
    piece: 0,
  };
  const first = open({ prefill });
  expect(await screen.findByDisplayValue(sampleMakePiece.about)).toBeInTheDocument();
  expect(within(screen.getByRole("group", { name: "Length, min" })).getByText("3 min")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Make the video" }));
  await waitFor(() => expect(first.onMade).toHaveBeenCalled());
  expect(first.calls.find((c) => c.path === "/v1/projects/p1/make")!.body).toEqual({
    format: "video",
    about: sampleMakePiece.about,
    sources: ["s1"],
    settings: sampleMakePiece.settings,
    chatId: "c1",
    proposal: { messageId: "m1", piece: 0 },
  });
  first.unmount();

  const second = open({ prefill });
  await screen.findByDisplayValue(sampleMakePiece.about);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(second.onClose).toHaveBeenCalled();
  await waitFor(() => expect(second.calls.some((c) => c.method === "POST" && c.path === "/v1/chats/c1/messages/m1/pieces/0/close")).toBe(true));
});

test("what stops it is shown and its button stays off", async () => {
  open(
    {},
    {
      "POST /v1/projects/:id/make/settle": {
        settings: {},
        plannedAs: "",
        issues: ["No video maker is set up here."],
      },
    },
  );
  expect(await screen.findByText("No video maker is set up here.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Make the video" })).toBeDisabled();
});

test("a shape that needs a voice says so, links to Settings, and cannot be made yet", async () => {
  open({ shape: "audio" }, { "GET /v1/voice": { service: undefined, from: "none", services: [] } });
  expect(await screen.findByRole("heading", { name: "Make an audio" })).toBeInTheDocument();
  expect(screen.getByText(audio.problem!)).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "Set up voice" })).toHaveAttribute("href", "/settings#voice");
  expect(screen.getByRole("button", { name: "Make the audio" })).toBeDisabled();
});

test("with several agents ready and none picked, the button asks who makes it and makes it with that pick", async () => {
  let tries = 0;
  const { calls, onMade } = open({}, {
    "GET /v1/providers": { ...sampleProviders, picks: {} },
    "POST /v1/projects/:id/make": () => (++tries === 1 ? [409, { error: "pick_needed", message: "Pick who makes it in Settings, What makes what." }] : view),
  });
  await userEvent.click(await screen.findByRole("button", { name: "Make the video" }));
  const picker = await screen.findByRole("dialog", { name: "Made by, for videos" });
  expect(within(picker).getByText("Pick who makes this")).toBeInTheDocument();
  expect(screen.queryByText(/What makes what/)).not.toBeInTheDocument();
  expect(onMade).not.toHaveBeenCalled();
  await userEvent.click(within(picker).getByRole("option", { name: /A One/ }));
  await userEvent.click(within(picker).getByRole("button", { name: "Use this" }));
  await waitFor(() => expect(onMade).toHaveBeenCalledWith(view));
  const made = calls.filter((c) => c.method === "POST" && c.path === "/v1/projects/p1/make");
  expect(made).toHaveLength(2);
  expect((made[1]!.body as { settings: object }).settings).toEqual({ agent: "agent:alpha:a-one" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("Escape with the Made by picker open closes only the picker, and what was typed stays", async () => {
  const { onClose } = open();
  await userEvent.type(await screen.findByRole("textbox", { name: "What it covers" }), "my note");
  await userEvent.click(await screen.findByRole("button", { name: /Zeta Agent/ }));
  expect(await screen.findByRole("dialog", { name: "Made by, for videos" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Made by, for videos" })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "What it covers" })).toHaveValue("my note");
});

test("closing a sheet with something typed asks first, and closes at once when nothing changed", async () => {
  const first = open();
  await userEvent.type(await screen.findByRole("textbox", { name: "What it covers" }), "my note");
  await userEvent.keyboard("{Escape}");
  const ask = await screen.findByRole("alertdialog", { name: "Discard what you filled in?" });
  // Escape on the question cancels it and keeps the sheet.
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(first.onClose).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
  expect(first.onClose).toHaveBeenCalledOnce();
  expect(ask).not.toBeInTheDocument();
  first.unmount();

  const second = open();
  await screen.findByRole("heading", { name: "Make a video" });
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(second.onClose).toHaveBeenCalledOnce();
});

test("with no agent set up the sheet says so with Set one up, and its button stays off", async () => {
  open({}, { "GET /v1/providers": { connector: { configured: true, reachable: true }, providers: [] } });
  expect(await screen.findByText("No agent is set up yet")).toBeInTheDocument();
  expect(screen.getByText("Add the coding agent you use, signed in on this computer.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Set one up" })).toHaveAttribute("href", "/settings#providers");
  expect(screen.getByRole("button", { name: "Make the video" })).toBeDisabled();
});

test("while the providers can't be read, Made by says so with Try again instead of asking who makes it", async () => {
  let calls = 0;
  open({}, { "GET /v1/providers": () => (++calls === 1 ? [503, { error: "unreachable", message: "down" }] : sampleProviders) });
  expect(await screen.findByText("Couldn't reach the engine")).toBeInTheDocument();
  expect(screen.queryByText("Pick who makes it")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Your default for videos")).toBeInTheDocument();
});
