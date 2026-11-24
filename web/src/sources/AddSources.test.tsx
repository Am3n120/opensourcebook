import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ApiProvider } from "../app/api";
import { fakeEngine, now } from "../test/fakeEngine";
import { AddSourcesDialog } from "./AddSources";

const added = (id: string, title: string, status: string) => ({
  source: { id, kind: "pdf", title, createdAt: now, updatedAt: now },
  extraction: { status },
  chunkCount: 1,
});

function setup(status = "ready") {
  const engine = fakeEngine({
    "POST /v1/uploads": [201, { upload: { id: "u1", contentType: "application/pdf", byteLength: 4, uploadedAt: now } }],
    "POST /v1/sources": [201, added("s1", "Notes", status)],
  });
  const onAdded = vi.fn();
  const onClose = vi.fn();
  render(
    <ApiProvider client={engine.client}>
      <AddSourcesDialog projectId="p1" projectTitle="Cell biology" onAdded={onAdded} onClose={onClose} />
    </ApiProvider>,
  );
  return { ...engine, onAdded, onClose };
}

test("names the project, adds a chosen file at once into it, shows where it stands, then hands it over", async () => {
  const { calls, onAdded } = setup();
  expect(screen.getByRole("dialog", { name: "Add sources to Cell biology" })).toBeInTheDocument();
  await userEvent.upload(screen.getByLabelText("Files"), new File(["%PDF"], "lecture8.pdf", { type: "application/pdf" }));
  expect(await screen.findByText("PDF · Read")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Adding" })).toBeInTheDocument();
  expect(calls.find((c) => c.path === "/v1/sources")?.body).toEqual({ uploadId: "u1", projectId: "p1" });
  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
});

test("a source still being read says so, and a Google Drive link goes in as a link to the project", async () => {
  const { calls } = setup("pending");
  await userEvent.click(screen.getByRole("button", { name: "Google Drive" }));
  await userEvent.type(screen.getByLabelText("Google Drive link"), "https://drive.google.com/drive/folders/abc");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(await screen.findByText("Google Drive link · Reading")).toBeInTheDocument();
  expect(calls.find((c) => c.path === "/v1/sources")?.body).toEqual({ url: "https://drive.google.com/drive/folders/abc", projectId: "p1" });
});

test("Done and Escape both close it", async () => {
  const { onClose } = setup();
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(2);
});
