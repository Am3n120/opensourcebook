/** `opensourcebook update`: the new version of this copy of Open Sourcebook, with only what changed installed again (cli/update.ts). */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { install, linkedLine, linkedModules, packagesAnswer } from "../install.ts";
import { PROGRAMS } from "../programs.ts";
import { findLauncher } from "../record.ts";
import { Refusal, canFastForward, fastForward, fetchBranch, gitIn, inspect, plan, safeUrl, target, versionOf, type Change, type Plan } from "../update.ts";
import { COMMAND_FILE, mustBeThisCopy, run as runGroup } from "./run.ts";
import { Problem, flagOn, type Ctx, type Group } from "./table.ts";
import { plural } from "./util.ts";

/** The steps that act beyond git, so a test can stand in for them. */
export interface UpdateHooks {
  /** Installs each folder again; resolves with the folders that did not finish. */
  install(ctx: Ctx, dirs: string[]): Promise<string[]>;
  /** Stops the running Open Sourcebook (`opensourcebook stop`: only what its launcher recorded). */
  stop(ctx: Ctx): Promise<void>;
  /** Starts Open Sourcebook again in the background with these launcher flags; resolves with its address, or why it did not start. */
  start(ctx: Ctx, flags: string[]): Promise<{ ok: true; url: string } | { ok: false; why: string }>;
}

const nameOf = (dir: string) => (dir ? (PROGRAMS.find((p) => p.dir === dir)?.label ?? dir) : "The opensourcebook command's own tools");
const logOf = (ctx: Ctx, dir: string) => join(ctx.home, "logs", `install-${(dir || "root").replace(/[\\/]/g, "-")}.log`);

export const defaultHooks: UpdateHooks = {
  async install(ctx, dirs) {
    mkdirSync(join(ctx.home, "logs"), { recursive: true });
    const results = await Promise.all(
      dirs.map(async (dir) => {
        const target = linkedModules(join(ctx.root, dir));
        if (target) ctx.progress(linkedLine(nameOf(dir), { dir: dir || ".", target, answers: packagesAnswer(join(ctx.root, dir)) }).trim());
        const ok = await install(join(ctx.root, dir), logOf(ctx, dir), ctx.home);
        ctx.progress(`${nameOf(dir)}: ${ok ? "installed" : "did not finish"}`);
        return ok ? undefined : dir;
      }),
    );
    return results.filter((d): d is string => d !== undefined);
  },
  async stop(ctx) {
    await runGroup.commands.find((c) => c.action === "stop")!.run(ctx);
  },
  start(ctx, flags) {
    return new Promise((resolve) => {
      // The new version's own launcher: a fresh process reads the files the update just brought. (A copy from before
      // the rename runs cli/re.mjs here, which is why that file is still there and passes everything on.)
      const child = spawn(process.execPath, [join(ctx.root, "cli", COMMAND_FILE), "start", "--background", "--json", ...flags], { cwd: ctx.root, env: ctx.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => d.toString().split("\n").filter((l) => l.trim()).forEach((l) => ctx.progress(l.trim())));
      child.once("error", (error) => resolve({ ok: false, why: error.message }));
      child.once("exit", () => {
        try {
          const answer = JSON.parse(out.trim().split("\n").pop() ?? "") as { ok: boolean; url?: string; error?: { message: string } };
          resolve(answer.ok && answer.url ? { ok: true, url: answer.url } : { ok: false, why: answer.error?.message ?? "it gave no reason" });
        } catch {
          resolve({ ok: false, why: "it gave no answer" });
        }
      });
    });
  },
};

/**
 * The launcher flags that start Open Sourcebook on the ports it had: --ports-from when it was not on the usual ones. Never --dev:
 * the restart is the start a person gets, from the build, which the start makes again for what the update changed.
 */
export function restartFlags(ports: Record<string, number>): string[] {
  const first = PROGRAMS[0]!;
  const had = ports[first.id];
  return had && had !== first.port ? ["--no-open", "--ports-from", String(had)] : ["--no-open"];
}

const SHOWN = 8;

function whatIsNew(changes: Change[], commits: number): string[] {
  if (!changes.length) return [`  ${plural(commits, "change")}; CHANGES.md says nothing new for them ("git log" lists each one).`];
  const lines = changes.slice(0, SHOWN).map((c) => `  - ${c.text}`);
  if (changes.length > SHOWN) lines.push(`  and ${changes.length - SHOWN} more in CHANGES.md`);
  return ["What is new:", ...lines];
}

function dataLine(p: Plan): string {
  const steps = p.migrations.length ? ` The database where your projects are kept takes ${plural(p.migrations.length, "new step")} by itself the next time Open Sourcebook starts, with your projects in it.` : "";
  return `Your projects, your settings and the keys in .opensourcebook/ and your .env files stay as they are: an update changes only the files that come with Open Sourcebook.${steps}`;
}

/** Everything `opensourcebook update` does, in order. Throws a Problem when it changed nothing and says why. */
export async function runUpdate(ctx: Ctx, hooks: UpdateHooks = defaultHooks): Promise<{ data: Record<string, unknown>; text: string; exit?: number }> {
  mustBeThisCopy(ctx, "update");
  const git = gitIn(ctx.root);
  try {
    const c = inspect(ctx.root, git);
    ctx.progress(`Fetching the newest version from ${safeUrl(c.url)}`);
    const unfetched = fetchBranch(git, c);
    if (unfetched) throw new Refusal("fetch_failed", `Could not fetch from ${safeUrl(c.url)} (git said: ${unfetched}). Nothing was changed; check the network and run opensourcebook update again.`);
    const to = target(git, c);
    if (!to) {
      const here = versionOf(git, c.head);
      return { data: { updated: false, version: here }, text: `Open Sourcebook is up to date (version ${here}).` };
    }
    if (!canFastForward(git, c.head, to)) {
      throw new Refusal(
        "own_commits",
        `This copy's ${c.branch} has commits of its own that the new version does not have (or the two have gone separate ways), so it cannot simply move forward, and opensourcebook update changed nothing. Keep them on a branch (git branch my-work), put ${c.branch} back on the published version (git reset --keep ${c.remote}/${c.branch}), then run opensourcebook update again.`,
      );
    }
    const dirs = ["", ...PROGRAMS.map((p) => p.dir)].filter((dir) => dir || existsSync(join(ctx.root, "node_modules")));
    const p = plan(git, ctx.root, c.head, to, dirs);
    const summary = { from: p.from, to: p.to, commits: p.commits, installs: p.installs, migrations: p.migrations, changes: p.changes };
    if (flagOn(ctx, "check")) {
      const installs = p.installs.length ? `It would install again: ${p.installs.map(nameOf).join(", ")}.` : "Nothing would need installing again.";
      return { data: { updated: false, available: true, ...summary }, text: [`A newer version is out: ${p.to} (you have ${p.from}).`, ...whatIsNew(p.changes, p.commits), installs, 'Run "opensourcebook update" to get it.'].join("\n") };
    }

    const running = findLauncher(ctx.home);
    if (running) {
      ctx.progress("Stopping Open Sourcebook to update it");
      await hooks.stop(ctx);
    }
    const moved = fastForward(git, to);
    if (!moved.ok) {
      const back = running ? await hooks.start(ctx, restartFlags(running.ports)) : undefined;
      const again = back ? (back.ok ? ` Open Sourcebook was started again as it was, at ${back.url}.` : ` Open Sourcebook did not start again (${back.why}); start it with "opensourcebook start".`) : "";
      throw new Problem("merge_failed", `git could not move this copy forward (${moved.err.split("\n")[0] || "no reason given"}), so nothing was changed.${again}`);
    }

    const lines = [`Open Sourcebook is updated: ${p.from} -> ${p.to} (${plural(p.commits, "change")}).`, ...whatIsNew(p.changes, p.commits)];
    let exit = 0;
    if (p.installs.length) {
      ctx.progress(`Installing again what changed: ${p.installs.map(nameOf).join(", ")}`);
      const failed = await hooks.install(ctx, p.installs);
      const done = p.installs.filter((d) => !failed.includes(d));
      if (done.length) lines.push(`Installed again because their packages changed: ${done.map(nameOf).join(", ")}. The rest was left as it was.`);
      for (const dir of failed) lines.push(`${nameOf(dir)} could not be installed; npm's own words are in ${logOf(ctx, dir)}. "opensourcebook start" tries again.`);
      if (failed.length) exit = 1;
    } else lines.push("No packages changed, so nothing was installed again.");
    lines.push(dataLine(p));

    let url: string | undefined;
    if (running) {
      ctx.progress("Starting Open Sourcebook again");
      const back = await hooks.start(ctx, restartFlags(running.ports));
      if (back.ok) {
        url = back.url;
        lines.push(`Open Sourcebook was running, so it was stopped and started again with the new version, in the background: ${back.url} ("opensourcebook open" opens it, "opensourcebook stop" stops it).`);
      } else {
        lines.push(`Open Sourcebook was running and was stopped, but did not start again (${back.why}). Start it with "opensourcebook start".`);
        exit = 1;
      }
    } else lines.push('Start Open Sourcebook to use the new version: open it with its shortcut, or run "opensourcebook start" (or "npm start" in its folder).');
    return { data: { updated: true, ...summary, restarted: Boolean(url), ...(url ? { url } : {}) }, text: lines.join("\n"), exit };
  } catch (error) {
    if (error instanceof Refusal) throw new Problem(error.code, error.message);
    throw error;
  }
}

export const update: Group = {
  thing: "",
  about: "Keeping Open Sourcebook up to date:",
  commands: [
    {
      thing: "",
      action: "update",
      summary: "get the newest version of Open Sourcebook: only what changed is installed again, Open Sourcebook restarts if it was running, and it says what is new",
      flags: [{ name: "check", help: "only say whether a newer version is out and what it brings; change nothing" }],
      shape: "{ updated: boolean, version?: string, available?: boolean, from?: string, to?: string, commits?: number, installs?: string[], migrations?: string[], changes?: [{ date, text }], restarted?: boolean, url?: string }",
      more: "The newest commit on the branch this copy was cloned from, by a fast-forward only; a shallow clone stays shallow. It changes nothing when this copy has changes of its own to Open Sourcebook's files, is on another branch, is not a git checkout, or has commits of its own, and says what to do. Your projects, .opensourcebook/, .env files and git-ignored files are never touched. The database where your projects are kept takes any new steps by itself the next time Open Sourcebook starts. At start Open Sourcebook says in one quiet line when a newer version is out (OPENSOURCEBOOK_UPDATE_CHECK=0 turns that off).",
      run: (ctx) => runUpdate(ctx),
    },
  ],
};
