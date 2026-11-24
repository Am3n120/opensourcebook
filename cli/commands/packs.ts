/**
 * Packs: a folder in `packs/` for one kind of work, holding its skill (SKILL.md with references beside it), any
 * pieces of its own, and `pack.json` naming its finished example in `examples/`. Packs are read from the folder; a
 * pack is on for a project when the project's settings list it (`settings.packs`), and then its skill is offered to
 * the agents making that project's items. Nothing outside a pack's folder names it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { connect, projectOf } from "./connect.ts";
import type { Project } from "./projects.ts";
import { readSkillHead } from "./skills.ts";
import { PROJECT_FLAG, Problem, type Ctx, type Group } from "./table.ts";

export interface Pack {
  name: string;
  description: string;
  /** The folder in `examples/` holding its finished example, once one is kept. */
  example?: string;
  /** Every file of the pack, by its path inside `packs/`. */
  files: string[];
}

function filesUnder(dir: string, base: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.name.startsWith(".")) return [];
    return e.isDirectory() ? filesUnder(path, base) : [relative(base, path).split("\\").join("/")];
  });
}

/** The packs in a `packs/` folder: each subfolder with a SKILL.md whose front matter has a name and a description. */
export function readPacks(dir: string): Pack[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, "SKILL.md")))
    .flatMap((name) => {
      const head = readSkillHead(readFileSync(join(dir, name, "SKILL.md"), "utf8"));
      if (!head) return [];
      let meta: { example?: unknown } = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, name, "pack.json"), "utf8")) as { example?: unknown };
      } catch {
        // pack.json is optional.
      }
      return [{ name, description: head.description, ...(typeof meta.example === "string" && meta.example ? { example: meta.example } : {}), files: filesUnder(join(dir, name), dir) }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const packsDir = (ctx: Ctx) => join(ctx.root, "packs");

export function packsOn(project: Project): string[] {
  const on = project.settings?.packs;
  return Array.isArray(on) ? on.filter((p): p is string => typeof p === "string") : [];
}

async function setPacks(ctx: Ctx, change: (on: string[]) => string[]): Promise<{ project: Project; on: string[] }> {
  const engine = connect(ctx);
  const id = projectOf(ctx);
  const { project } = await engine.call<{ project: Project }>("GET", `/v1/projects/${encodeURIComponent(id)}`);
  const on = change(packsOn(project));
  const { project: after } = await engine.call<{ project: Project }>("PATCH", `/v1/projects/${encodeURIComponent(id)}`, { json: { settings: { ...(project.settings ?? {}), packs: on } } });
  return { project: after, on };
}

function known(ctx: Ctx, name: string): Pack {
  const all = readPacks(packsDir(ctx));
  const pack = all.find((p) => p.name === name);
  if (!pack) throw new Problem("not_found", `There is no pack "${name}"; the packs are: ${all.map((p) => p.name).join(", ") || "none"}.`);
  return pack;
}

export const packs: Group = {
  thing: "pack",
  aliases: ["packs"],
  about: "bundles for one kind of work (a skill, its pieces, a finished example), turned on per project",
  commands: [
    {
      thing: "pack",
      action: "list",
      summary: "the packs, and which are on for the project",
      flags: [PROJECT_FLAG],
      shape: "{ packs: [{ name, description, example?, on?: boolean }] }",
      more: "on is left out when no project is picked or Open Sourcebook is not running.",
      async run(ctx) {
        const all = readPacks(packsDir(ctx));
        let on: string[] | undefined;
        try {
          const { project } = await connect(ctx).call<{ project: Project }>("GET", `/v1/projects/${encodeURIComponent(projectOf(ctx))}`);
          on = packsOn(project);
        } catch {
          on = undefined;
        }
        const list = all.map(({ files: _files, ...p }) => ({ ...p, ...(on ? { on: on.includes(p.name) } : {}) }));
        return { data: { packs: list }, text: list.length ? list.map((p) => `${p.name}${p.on ? " (on)" : ""}: ${p.description}`).join("\n") : "No packs in this copy of Open Sourcebook." };
      },
    },
    {
      thing: "pack",
      action: "show",
      summary: "a pack's skill and what it holds",
      args: [{ name: "pack", help: "the pack's name" }],
      shape: "{ pack: { name, description, example?, files: string[] }, skill: string }",
      async run(ctx) {
        const pack = known(ctx, ctx.args.pack!);
        const skill = readFileSync(join(packsDir(ctx), pack.name, "SKILL.md"), "utf8");
        return { data: { pack, skill }, text: `${pack.name}: ${pack.description}\nFiles: ${pack.files.join(", ")}\nExample: ${pack.example ?? "none kept yet"}` };
      },
    },
    {
      thing: "pack",
      action: "on",
      summary: "turn a pack on for the project, so what is made in it gets the pack's skill",
      args: [{ name: "pack", help: "the pack's name" }],
      flags: [PROJECT_FLAG],
      shape: "{ project: Project, packs: string[] }",
      async run(ctx) {
        const pack = known(ctx, ctx.args.pack!);
        const { project, on } = await setPacks(ctx, (now) => [...new Set([...now, pack.name])]);
        return { data: { project, packs: on }, text: `${pack.name} is on for "${project.title}".` };
      },
    },
    {
      thing: "pack",
      action: "off",
      summary: "turn a pack off for the project",
      args: [{ name: "pack", help: "the pack's name" }],
      flags: [PROJECT_FLAG],
      shape: "{ project: Project, packs: string[] }",
      async run(ctx) {
        const name = ctx.args.pack!;
        const { project, on } = await setPacks(ctx, (now) => now.filter((p) => p !== name));
        return { data: { project, packs: on }, text: `${name} is off for "${project.title}".` };
      },
    },
  ],
};
