import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { now } from "../test/fakeEngine";
import { renderApp } from "../test/render";

const project = (id: string, title: string) => ({ id, title, settings: {}, createdAt: now, updatedAt: now });
const source = (id: string, title: string) => ({ source: { id, kind: "pdf", title, createdAt: now, updatedAt: now }, extraction: { status: "ready" }, chunkCount: 3 });
const upload = [201, { upload: { id: "u1", contentType: "application/pdf", byteLength: 4, uploadedAt: now } }];

const base = {
  "GET /v1/projects": { projects: [] },
  "GET /v1/inbox": { sources: [] },
  "POST /v1/projects": [201, { project: project("p9", "Made") }],
  "GET /v1/projects/:id": { project: project("p9", "Made") },
  "POST /v1/sources/:id/file": { source: { id: "s9" } },
};

async function open(routes: Record<string, unknown> = {}) {
  const app = renderApp("/", { ...base, ...routes } as never);
  await userEvent.click(await screen.findByRole("button", { name: "New project" }));
  return { ...app, dialog: screen.getByRole("dialog", { name: "New project" }) };
}

const posted = (calls: { method: string; path: string; body: unknown }[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path).map((c) => c.body);

test("shows the drop area with both choosers and the four other ways, and Create works with nothing added", async () => {
  const { dialog, calls } = await open();
  expect(within(dialog).getByText("Drop files or a whole folder here")).toBeInTheDocument();
  expect(within(dialog).getByText("From this computer")).toBeInTheDocument();
  for (const name of ["Choose files", "Choose a folder", "YouTube", "Google Drive", "Link", "Paste text"]) {
    expect(within(dialog).getByRole("button", { name })).toBeInTheDocument();
  }
  expect(within(dialog).getByText("You can add sources later too.")).toBeInTheDocument();
  expect(within(dialog).getByLabelText("Folder")).toHaveAttribute("webkitdirectory");
  await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await vi.waitFor(() => expect(calls.some((c) => c.method === "GET" && c.path === "/v1/projects/p9")).toBe(true));
  expect(posted(calls, "/v1/projects")).toEqual([{ title: "Untitled project" }]);
});

test("a typed name makes an empty project with that name", async () => {
  const { dialog, calls } = await open();
  await userEvent.type(within(dialog).getByLabelText("Name"), "Spanish");
  await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await vi.waitFor(() => expect(posted(calls, "/v1/projects")).toEqual([{ title: "Spanish" }]));
});

test("a dropped file is listed, and on Create it is read first and names the project", async () => {
  const { dialog, calls } = await open({
    "POST /v1/uploads": upload,
    "POST /v1/sources": [201, source("s9", "BIO 110 Lecture 7")],
  });
  const file = new File(["%PDF"], "lecture7.pdf", { type: "application/pdf" });
  fireEvent.drop(within(dialog).getByText("Drop files or a whole folder here"), { dataTransfer: { files: [file], getData: () => "" } });
  expect(await within(dialog).findByText("lecture7.pdf")).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/sources/s9/file")).toBe(true));
  expect(posted(calls, "/v1/sources")).toEqual([{ uploadId: "u1" }]);
  expect(posted(calls, "/v1/projects")).toEqual([{ title: "BIO 110 Lecture 7" }]);
  expect(posted(calls, "/v1/sources/s9/file")).toEqual([{ projectId: "p9" }]);
});

test("a folder pick adds what Open Sourcebook can read, skips the rest and says how many", async () => {
  const { dialog, calls } = await open({ "POST /v1/uploads": upload, "POST /v1/sources": [201, source("s9", "Notes")] });
  const pdf = new File(["%PDF"], "week1.pdf", { type: "application/pdf" });
  const hidden = new File(["x"], ".DS_Store");
  const bin = new File(["x"], "app.exe");
  await userEvent.upload(within(dialog).getByLabelText("Folder"), [pdf, hidden, bin], { applyAccept: false });
  expect(await within(dialog).findByText("week1.pdf")).toBeInTheDocument();
  expect(within(dialog).getByRole("status")).toHaveTextContent("Skipped 2 files Open Sourcebook cannot read.");
  await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/sources/s9/file")).toBe(true));
  expect(posted(calls, "/v1/uploads")).toHaveLength(1);
});

test("a folder pick keeps what the engine's own list of types takes", async () => {
  const { dialog, calls } = await open({ "GET /v1/uploads/types": { maxBytes: 1000, types: [{ contentType: "text/*", extensions: ["md"], group: "docs" }] } });
  const notes = new File(["# Notes"], "notes.md", { type: "text/markdown" });
  const pdf = new File(["%PDF"], "week1.pdf", { type: "application/pdf" });
  await userEvent.upload(within(dialog).getByLabelText("Folder"), [notes, pdf], { applyAccept: false });
  expect(await within(dialog).findByText("notes.md")).toBeInTheDocument();
  expect(within(dialog).queryByText("week1.pdf")).not.toBeInTheDocument();
  expect(within(dialog).getByRole("status")).toHaveTextContent("Skipped 1 file Open Sourcebook cannot read.");
  expect(calls.filter((c) => c.path === "/v1/uploads/types")).toHaveLength(1);
});

test("a dropped folder is walked and its unreadable files are skipped", async () => {
  const { dialog } = await open();
  const pdf = new File(["%PDF"], "a.pdf");
  const junk = new File(["x"], "b.exe");
  const fileEntry = (file: File) => ({ isFile: true, isDirectory: false, fullPath: `/Course/${file.name}`, file: (ok: (f: File) => void) => ok(file) });
  const kids = [fileEntry(pdf), fileEntry(junk)];
  let given = false;
  const dir = {
    isFile: false,
    isDirectory: true,
    createReader: () => ({ readEntries: (ok: (b: unknown[]) => void) => ok(given ? [] : ((given = true), kids)) }),
  };
  fireEvent.drop(within(dialog).getByText("Drop files or a whole folder here"), {
    dataTransfer: { items: [{ kind: "file", webkitGetAsEntry: () => dir }], files: [], getData: () => "" },
  });
  expect(await within(dialog).findByText("Course/a.pdf")).toBeInTheDocument();
  expect(within(dialog).getByRole("status")).toHaveTextContent("Skipped 1 file Open Sourcebook cannot read.");
});

test("a YouTube link goes through the link path and only a YouTube link is taken", async () => {
  const { dialog, calls } = await open({ "POST /v1/sources": [201, source("s9", "A talk")] });
  await userEvent.click(within(dialog).getByRole("button", { name: "YouTube" }));
  await userEvent.type(within(dialog).getByLabelText("YouTube link"), "https://example.com/x");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  expect(within(dialog).getByRole("alert")).toHaveTextContent("That is not a YouTube link.");
  await userEvent.clear(within(dialog).getByLabelText("YouTube link"));
  await userEvent.type(within(dialog).getByLabelText("YouTube link"), "https://youtu.be/abc123");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  expect(await within(dialog).findByText("YouTube link")).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/sources/s9/file")).toBe(true));
  expect(posted(calls, "/v1/sources")).toEqual([{ url: "https://youtu.be/abc123" }]);
});

test("a shared Google Drive link says it must be shared by link and is sent like a link", async () => {
  const { dialog, calls } = await open({ "POST /v1/sources": [201, source("s9", "Shared notes")] });
  await userEvent.click(within(dialog).getByRole("button", { name: "Google Drive" }));
  expect(within(dialog).getByText("The file or folder must be shared by link.")).toBeInTheDocument();
  await userEvent.type(within(dialog).getByLabelText("Google Drive link"), "https://drive.google.com/file/d/abc/view");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/sources/s9/file")).toBe(true));
  expect(posted(calls, "/v1/sources")).toEqual([{ url: "https://drive.google.com/file/d/abc/view" }]);
});

test("a link and pasted text are added with the typed name winning", async () => {
  const { dialog, calls } = await open({ "POST /v1/sources": [201, source("s9", "Read name")] });
  await userEvent.type(within(dialog).getByLabelText("Name"), "Calc notes");
  await userEvent.click(within(dialog).getByRole("button", { name: "Link" }));
  await userEvent.type(within(dialog).getByLabelText("Link"), "https://example.com/notes");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Paste text" }));
  await userEvent.type(within(dialog).getByLabelText("Text"), "Limits and continuity");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await vi.waitFor(() => expect(posted(calls, "/v1/projects")).toEqual([{ title: "Calc notes" }]));
  expect(posted(calls, "/v1/sources")).toEqual([{ url: "https://example.com/notes" }, { text: "Limits and continuity" }]);
});

test("a queued entry can be taken out before Create", async () => {
  const { dialog, calls } = await open();
  await userEvent.click(within(dialog).getByRole("button", { name: "Link" }));
  await userEvent.type(within(dialog).getByLabelText("Link"), "https://example.com/notes");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove https://example.com/notes" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await vi.waitFor(() => expect(posted(calls, "/v1/projects")).toHaveLength(1));
  expect(posted(calls, "/v1/sources")).toEqual([]);
});
