/** Projects: a notebook of one person's sources, chats, plans and what was made from them. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { connect, projectOf, rememberProject } from "./connect.ts";
import { PRINT_FLAG, PROJECT_FLAG, Problem, flagOn, flagString, type Ctx, type Group } from "./table.ts";
import { browserAddress, openUrl, plural, table } from "./util.ts";

export interface Project {
  id: string;
  title: string;
  settings?: Record<string, unknown>;
  archivedAt?: string;
  updatedAt?: string;
  createdAt?: string;
}

const PROJECT_ARG = { name: "project", help: "the project's id (default: the one used last)", optional: true };

/** The project named by the positional argument, or by --project, or the one used last. */
export function pickedProject(ctx: Ctx): string {
  return ctx.args.project ?? projectOf(ctx);
}

export const projectUrl = (web: string, id: string) => `${web}/projects/${encodeURIComponent(id)}`;

export async function getProject(ctx: Ctx, id: string): Promise<{ project: Project; counts?: Record<string, number> }> {
  return connect(ctx).call("GET", `/v1/projects/${encodeURIComponent(id)}`, { query: { counts: 1 } });
}

const line = (p: Project) => `${p.title}  (${p.id})${p.archivedAt ? ", archived" : ""}`;

export const projects: Group = {
  thing: "project",
  aliases: ["projects"],
  about: "a notebook: its sources, chats, plans and what was made",
  commands: [
    {
      thing: "project",
      action: "list",
      summary: "the projects, most recently changed first",
      flags: [{ name: "archived", help: "list the archived ones instead" }],
      shape: "{ projects: Project[] }  (Project: { id, title, createdAt, updatedAt, archivedAt?, settings })",
      async run(ctx) {
        const engine = connect(ctx);
        const all: Project[] = [];
        let cursor: string | undefined;
        do {
          const page = await engine.call<{ projects: Project[]; nextCursor?: string }>("GET", "/v1/projects", { query: { limit: 200, cursor, archived: flagOn(ctx, "archived") ? "only" : undefined } });
          all.push(...page.projects);
          cursor = page.nextCursor;
        } while (cursor);
        return { data: { projects: all }, text: all.length ? table(all.map((p) => [p.id, p.title, p.archivedAt ? "archived" : ""])) : 'No projects yet. Make one with "opensourcebook project make <title>".' };
      },
    },
    {
      thing: "project",
      action: "make",
      summary: "make a new project and use it from now on",
      args: [{ name: "title", help: "what it is called", rest: true }],
      shape: "{ project: Project, url: string }",
      async run(ctx) {
        const engine = connect(ctx);
        const { project } = await engine.call<{ project: Project }>("POST", "/v1/projects", { json: { title: ctx.args.title } });
        rememberProject(ctx, project.id);
        const url = projectUrl(engine.web, project.id);
        return { data: { project, url }, text: `Made "${project.title}" (${project.id}); the next commands use it. In the app: ${url}` };
      },
    },
    {
      thing: "project",
      action: "show",
      summary: "a project and what it holds",
      args: [PROJECT_ARG],
      shape: "{ project: Project, counts: { chats, plans, outputs, sources }, url: string }",
      async run(ctx) {
        const engine = connect(ctx);
        const id = pickedProject(ctx);
        const { project, counts } = await getProject(ctx, id);
        const c = counts ?? {};
        const url = projectUrl(engine.web, project.id);
        return {
          data: { project, counts: c, url },
          text: `${line(project)}\n${plural(c.sources ?? 0, "source")}, ${plural(c.chats ?? 0, "chat")}, ${plural(c.plans ?? 0, "plan")}, ${plural(c.outputs ?? 0, "thing")} made\nIn the app: ${url}`,
        };
      },
    },
    {
      thing: "project",
      action: "use",
      summary: "use this project for the next commands",
      args: [{ name: "project", help: "the project's id" }],
      shape: "{ project: Project }",
      async run(ctx) {
        const { project } = await getProject(ctx, ctx.args.project!);
        rememberProject(ctx, project.id);
        return { data: { project }, text: `Using "${project.title}" (${project.id}).` };
      },
    },
    {
      thing: "project",
      action: "open",
      summary: "open the project in the app, in the browser",
      args: [PROJECT_ARG],
      flags: [PRINT_FLAG],
      shape: "{ url: string, opened: boolean }",
      async run(ctx) {
        const engine = connect(ctx);
        const id = pickedProject(ctx);
        await getProject(ctx, id);
        const url = projectUrl(engine.web, id);
        // The browser is let in by a one-time address (cli/opener.ts), which then shows the project.
        const entry = await browserAddress(ctx, new URL(url).pathname);
        const opened = !flagOn(ctx, "print") && openUrl(ctx, entry);
        return { data: { url, opened, ...(opened ? {} : { open: entry }) }, text: opened ? `Opened ${url} in the browser on this computer.` : `${entry}\n(works once, for ten minutes, in this computer's browser; then the project is at ${url})` };
      },
    },
    {
      thing: "project",
      action: "rename",
      summary: "give the project a new title",
      args: [{ name: "title", help: "the new title", rest: true }],
      flags: [PROJECT_FLAG],
      shape: "{ project: Project }",
      async run(ctx) {
        const id = projectOf(ctx);
        const { project } = await connect(ctx).call<{ project: Project }>("PATCH", `/v1/projects/${encodeURIComponent(id)}`, { json: { title: ctx.args.title } });
        return { data: { project }, text: `Renamed to "${project.title}".` };
      },
    },
    {
      thing: "project",
      action: "archive",
      summary: "hide the project from the list, keeping everything in it",
      args: [PROJECT_ARG],
      shape: "{ project: Project }",
      async run(ctx) {
        const { project } = await connect(ctx).call<{ project: Project }>("POST", `/v1/projects/${encodeURIComponent(pickedProject(ctx))}/archive`);
        return { data: { project }, text: `Archived "${project.title}"; "opensourcebook project unarchive ${project.id}" brings it back.` };
      },
    },
    {
      thing: "project",
      action: "unarchive",
      summary: "bring an archived project back",
      args: [PROJECT_ARG],
      shape: "{ project: Project }",
      async run(ctx) {
        const { project } = await connect(ctx).call<{ project: Project }>("POST", `/v1/projects/${encodeURIComponent(pickedProject(ctx))}/unarchive`);
        return { data: { project }, text: `"${project.title}" is back in the list.` };
      },
    },
    {
      thing: "project",
      action: "export",
      summary: "write the project out to one file (its sources' text, chats, plans and what was made)",
      args: [PROJECT_ARG],
      flags: [{ name: "to", value: "file", help: "where to write it (default: <project id>.opensourcebook.json in this folder)" }],
      shape: "{ file: string }",
      more: "A made thing that points at a stored file (a video's file) is not carried in the file yet; on import its item comes back waiting to be made.",
      async run(ctx) {
        const id = pickedProject(ctx);
        const { bundle } = await connect(ctx).call<{ bundle: unknown }>("GET", `/v1/projects/${encodeURIComponent(id)}/export`);
        const file = resolve(ctx.cwd, flagString(ctx, "to") ?? `${id}.opensourcebook.json`);
        writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
        return { data: { file }, text: `Wrote ${file}` };
      },
    },
    {
      thing: "project",
      action: "import",
      summary: "read a project in from a file written by export, as a new project",
      args: [{ name: "file", help: "the file" }],
      shape: "{ project: Project, droppedCites: number, droppedOutputs: number }",
      async run(ctx) {
        const file = resolve(ctx.cwd, ctx.args.file!);
        let bundle: unknown;
        try {
          bundle = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          throw new Problem("bad_file", `${file} is not a project file (it could not be read as JSON).`);
        }
        const answer = await connect(ctx).call<{ project: Project; droppedCites: number; droppedOutputs: number }>("POST", "/v1/projects/import", { json: { bundle } });
        rememberProject(ctx, answer.project.id);
        const dropped = answer.droppedCites || answer.droppedOutputs ? ` (${plural(answer.droppedCites, "cite")} and ${plural(answer.droppedOutputs, "made thing")} could not be carried over)` : "";
        return { data: { ...answer }, text: `Read in "${answer.project.title}" (${answer.project.id})${dropped}; the next commands use it.` };
      },
    },
  ],
};
