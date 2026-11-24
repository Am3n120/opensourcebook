import type { ApiClient } from "../api/client";
import type { Project } from "../api/types";

/**
 * The finished example projects kept in the repo's `examples/` folder
 * (docs/STRUCTURE.md): each folder holds `project.json`, a project bundle
 * the engine wrote out (`GET /v1/projects/:id/export`). Nothing here names
 * one: the list is whatever folders are there, in folder-name order.
 */
export interface Example {
  /** The folder's name. */
  name: string;
  load: () => Promise<ExampleBundle>;
}

/** The part of a project bundle the app reads to describe an example; the engine reads the rest. */
export interface ExampleBundle {
  /** What marks the file as a project: written as `opensourcebook`, and as `re` by a copy from before the app had its name. */
  opensourcebook?: "project";
  re?: "project";
  version: number;
  project: { title: string };
  sources: Array<{ key: string; title?: string }>;
  chats: Array<{ key: string; title?: string; messages: Array<{ role: string }> }>;
  plans?: Array<{ items: Array<{ type: string; title: string; output?: unknown }> }>;
}

const files = import.meta.glob<ExampleBundle>("../../../examples/*/project.json", { import: "default" });

export const EXAMPLES: Example[] = Object.entries(files)
  .map(([path, load]) => ({ name: path.split("/").at(-2)!, load }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** What an example holds, counted for a line under its title. */
export function exampleCounts(bundle: ExampleBundle): { sources: number; answers: number; made: Array<{ type: string; title: string }> } {
  return {
    sources: bundle.sources.length,
    answers: bundle.chats.reduce((n, chat) => n + chat.messages.filter((m) => m.role === "assistant").length, 0),
    made: (bundle.plans ?? []).flatMap((plan) => plan.items.filter((item) => item.output !== undefined).map(({ type, title }) => ({ type, title }))),
  };
}

/**
 * Opens an example as a project of the person's own: the copy opened
 * before when there is one (archived or not), else a new one made from the
 * bundle. Answers the project.
 */
export async function openExample(client: ApiClient, example: Example): Promise<Project> {
  const projects = await client.all((q) => client.listProjects({ ...q, archived: "include" }));
  const opened = projects.find((p) => p.settings.example === example.name);
  if (opened) {
    if (opened.archivedAt) return client.unarchiveProject(opened.id);
    return opened;
  }
  return client.importProject(await example.load(), example.name);
}
