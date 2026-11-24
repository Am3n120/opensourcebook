import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { now } from "../test/fakeEngine";
import { renderApp } from "../test/render";

const source = { id: "s1", kind: "web", title: "Week 3 notes", url: "https://example.edu/w3", status: "ready", createdAt: now, updatedAt: now };
const project = { id: "p1", title: "Calculus I", settings: {}, createdAt: now, updatedAt: now };

function inboxRoutes() {
  let inbox = [source];
  return {
    "GET /v1/inbox": () => ({ sources: inbox }),
    "GET /v1/projects": { projects: [project] },
    "POST /v1/sources/:id/file": () => {
      inbox = [];
      return { source: { ...source, projectId: "p1" } };
    },
    "POST /v1/sources": [201, { source: { id: "s2", kind: "text", title: "Pasted", createdAt: now, updatedAt: now }, extraction: { contentHash: "h", kind: "text", status: "ready", createdAt: now, updatedAt: now }, chunkCount: 1 }],
    "POST /v1/uploads": [201, { upload: { id: "u1", contentType: "application/pdf", byteLength: 4, uploadedAt: now } }],
  };
}

test("lists unfiled sources and files one into a project", async () => {
  const { calls } = renderApp("/inbox", inboxRoutes());
  const row = (await screen.findByText("Week 3 notes")).closest("li")!;
  expect(within(row).getByText(/Link · example\.edu/)).toBeInTheDocument();
  await within(row).findByRole("option", { name: "Calculus I" });
  await userEvent.selectOptions(within(row).getByRole("combobox", { name: "File Week 3 notes to a project" }), "p1");
  expect(calls.find((c) => c.path === "/v1/sources/s1/file")?.body).toEqual({ projectId: "p1" });
  expect(await screen.findByText("Inbox is empty")).toBeInTheDocument();
});

test("files several selected sources at once", async () => {
  const { calls } = renderApp("/inbox", inboxRoutes());
  await userEvent.click(await screen.findByRole("checkbox", { name: "Select all" }));
  const bulk = screen.getByRole("region", { name: "Selected sources" });
  await within(bulk).findByRole("option", { name: "Calculus I" });
  await userEvent.selectOptions(within(bulk).getByRole("combobox"), "p1");
  await userEvent.click(within(bulk).getByRole("button", { name: "File them" }));
  expect(calls.filter((c) => c.path.endsWith("/file")).map((c) => c.path)).toEqual(["/v1/sources/s1/file"]);
});

test("adds pasted text to the Inbox without a project", async () => {
  const { calls } = renderApp("/inbox", inboxRoutes());
  await userEvent.click(await screen.findByRole("button", { name: "Add to the Inbox" }));
  await userEvent.click(await screen.findByRole("button", { name: "Paste text" }));
  await userEvent.type(screen.getByLabelText("Text"), "Limits and continuity");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(await screen.findByText("Pasted text · Read")).toBeInTheDocument();
  expect(calls.find((c) => c.method === "POST" && c.path === "/v1/sources")?.body).toEqual({ text: "Limits and continuity" });
});

test("uploads a file, then adds it as a source", async () => {
  const { calls } = renderApp("/inbox", inboxRoutes());
  await userEvent.click(await screen.findByRole("button", { name: "Add to the Inbox" }));
  await userEvent.upload(await screen.findByLabelText("Files"), new File(["%PDF"], "notes.pdf", { type: "application/pdf" }));
  expect(await screen.findByText("PDF · Read")).toBeInTheDocument();
  expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("POST /v1/uploads");
  expect(calls.find((c) => c.method === "POST" && c.path === "/v1/sources")?.body).toEqual({ uploadId: "u1" });
});

test("an Inbox source is renamed from its menu, removed after saying what happens, and one that failed is read again", async () => {
  let inbox = [source, { ...source, id: "s3", title: "gone.example/x", url: "https://gone.example/x", status: "failed", errorMessage: "That page does not exist." }];
  const { calls } = renderApp("/inbox", {
    ...inboxRoutes(),
    "GET /v1/inbox": () => ({ sources: inbox }),
    "POST /v1/sources/:id/retry": { source: inbox[1], extraction: { contentHash: "h", kind: "web", status: "failed", errorMessage: "Still not there.", createdAt: now, updatedAt: now }, chunkCount: 0 },
    "PATCH /v1/sources/:id": (req: { body: unknown }) => {
      inbox = inbox.map((s) => (s.id === "s1" ? { ...s, title: (req.body as { title: string }).title } : s));
      return { source: inbox[0] };
    },
    "DELETE /v1/sources/:id": () => {
      inbox = inbox.filter((s) => s.id !== "s1");
      return { sourceId: "s1", deleted: true, changedPlanIds: [] };
    },
  });
  expect(await screen.findByText("That page does not exist.")).toBeInTheDocument();
  expect(calls.some((c) => c.method === "GET" && c.path.startsWith("/v1/sources/"))).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/v1/sources/s3/retry")).toBe(true);
  expect(await screen.findByText("Still not there.")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "More for Week 3 notes" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  await userEvent.clear(screen.getByLabelText("Source name"));
  await userEvent.type(screen.getByLabelText("Source name"), "Week 3{Enter}");
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ title: "Week 3" });
  await userEvent.click(await screen.findByRole("button", { name: "More for Week 3" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove…" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("It leaves the Inbox.");
  await userEvent.click(screen.getByRole("button", { name: "Remove source" }));
  await vi.waitFor(() => expect(screen.queryByRole("link", { name: "Week 3" })).not.toBeInTheDocument());
});
