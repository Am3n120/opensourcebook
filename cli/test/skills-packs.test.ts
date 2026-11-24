import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { readPacks } from "../commands/packs.ts";
import { GROUPS } from "../commands/index.ts";
import { HERE, listSkills, prompter, readSkillHead } from "../commands/skills.ts";
import { runIn } from "./fake-engine.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "opensourcebook-skills-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a skill is for your own agent when its metadata says so", () => {
  const head = readSkillHead("---\nname: x\ndescription: does x\nmetadata:\n  for: your-agent\n---\n\nbody");
  assert.deepEqual(head, { name: "x", description: "does x", forYourAgent: true });
  assert.equal(readSkillHead("---\nname: y\ndescription: does y\n---\n")!.forYourAgent, false);
  assert.equal(readSkillHead("no front matter"), undefined);
  const mine = listSkills(join(ROOT, "skills")).filter((s) => s.forYourAgent);
  assert.ok(mine.length >= 1, "Open Sourcebook ships at least one skill for the person's own agent");
});

test("skill install copies into each agent's own folder in a temporary home, says what it did, and updates on a second run", async () => {
  const home = join(dir, "home");
  mkdirSync(home);
  const r = await runIn(["skill", "install", "--yes", "--agent", "claude", "--agent", "codex", "--agent", "opencode", "--home", home, "--json"], { home: join(dir, ".opensourcebook"), cwd: dir });
  assert.equal(r.code, 0, r.out + r.err);
  const a = r.json() as { installed: Array<{ agent: string; path: string }>; covered: Array<{ agent: string; by: string }> };
  const where = a.installed.map((i) => relative(home, i.path));
  const names = listSkills(join(ROOT, "skills")).filter((s) => s.forYourAgent).map((s) => s.name);
  for (const name of names) {
    assert.ok(where.includes(join(".claude", "skills", name)));
    assert.ok(where.includes(join(".agents", "skills", name)));
    assert.ok(existsSync(join(home, ".claude", "skills", name, "SKILL.md")));
    assert.match(readFileSync(join(home, ".claude", "skills", name, HERE), "utf8"), /cli[\\/]opensourcebook\.mjs/);
  }
  assert.deepEqual(a.covered, [{ agent: "opencode", by: "claude" }], "OpenCode reads the Claude Code folder, so no third copy");

  const again = await runIn(["skill", "install", "--yes", "--agent", "claude", "--home", home], { home: join(dir, ".opensourcebook"), cwd: dir });
  assert.equal(again.code, 0);
  assert.match(again.out, /Claude Code: .* copied to /);
});

test("skill install leaves a skill it did not install alone, into a project folder too, unless --force", async () => {
  const project = join(dir, "project");
  const name = listSkills(join(ROOT, "skills")).find((s) => s.forYourAgent)!.name;
  mkdirSync(join(project, ".claude", "skills", name), { recursive: true });
  writeFileSync(join(project, ".claude", "skills", name, "SKILL.md"), "someone else's");
  const r = await runIn(["skill", "install", "--yes", "--agent", "claude", "--project", project, "--json"], { home: join(dir, ".opensourcebook"), cwd: dir });
  assert.equal(r.code, 1);
  assert.match(JSON.stringify(r.json().skipped), /Open Sourcebook did not install/);
  assert.equal(readFileSync(join(project, ".claude", "skills", name, "SKILL.md"), "utf8"), "someone else's");
  const forced = await runIn(["skill", "install", "--yes", "--agent", "claude", "--project", project, "--force"], { home: join(dir, ".opensourcebook"), cwd: dir });
  assert.equal(forced.code, 0);
  assert.notEqual(readFileSync(join(project, ".claude", "skills", name, "SKILL.md"), "utf8"), "someone else's");
  const unknown = await runIn(["skill", "install", "--yes", "--agent", "nobody", "--json"], { home: join(dir, ".opensourcebook"), cwd: dir });
  assert.equal((unknown.json().error as { code: string }).code, "bad_arguments");
});

const ENV = (home: string) => ({ home: join(dir, ".opensourcebook"), cwd: dir, env: { HOME: home, PATH: process.env.PATH } });

test("skill install says what it will write first, and without a terminal or --yes it refuses and writes nothing", async () => {
  const home = join(dir, "home-refuse");
  mkdirSync(home);
  const r = await runIn(["skill", "install", "--agent", "claude", "--home", home], ENV(home));
  assert.equal(r.code, 1);
  assert.match(r.err, /This will copy opensourcebook .* into:/);
  assert.ok(r.err.includes(join(home, ".claude", "skills", "opensourcebook")));
  assert.match(r.err, /records this Open Sourcebook's folder/);
  assert.match(r.err, /Run it again with --yes/);
  assert.equal(existsSync(join(home, ".claude")), false);
  const json = await runIn(["skill", "install", "--agent", "claude", "--home", home, "--json"], ENV(home));
  assert.equal((json.json().error as { code: string }).code, "needs_confirmation");
});

test("skill install asks on a terminal: a no changes nothing, a yes writes", async () => {
  const home = join(dir, "home-ask");
  mkdirSync(home);
  const real = { isTerminal: prompter.isTerminal, ask: prompter.ask };
  const questions: string[] = [];
  let answer = false;
  prompter.isTerminal = () => true;
  prompter.ask = async (q) => (questions.push(q), answer);
  try {
    const no = await runIn(["skill", "install", "--agent", "claude", "--home", home, "--json"], ENV(home));
    assert.equal((no.json().error as { code: string }).code, "needs_confirmation", "--json never asks");
    const declined = await runIn(["skill", "install", "--agent", "claude", "--home", home], ENV(home));
    assert.equal(declined.code, 1);
    assert.match(declined.err, /Nothing was changed/);
    assert.equal(existsSync(join(home, ".claude")), false);
    answer = true;
    const yes = await runIn(["skill", "install", "--agent", "claude", "--home", home], ENV(home));
    assert.equal(yes.code, 0, yes.err);
    assert.equal(questions.length, 2);
    assert.ok(existsSync(join(home, ".claude", "skills", "opensourcebook", "SKILL.md")));
  } finally {
    Object.assign(prompter, real);
  }
});

/** A copy as `re skill install` wrote it before the rename: a folder called `re` with the old mark in its here.md. */
function oldCopy(skillsFolder: string, root = "/somewhere/Re"): string {
  const copy = join(skillsFolder, "re");
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "SKILL.md"), "---\nname: re\ndescription: the skill from before the rename\n---\n");
  writeFileSync(join(copy, HERE), `# Re on this computer\n\nRe is at \`${root}\`.\n\n<!-- re-root: ${root} -->\n`);
  return copy;
}

test("a copy installed before the rename is found by list, replaced by install, and a stranger's folder of that name is left alone", async () => {
  const home = join(dir, "home-old");
  const claude = join(home, ".claude", "skills");
  const codex = join(home, ".agents", "skills");
  const old = oldCopy(claude, ROOT);
  // Codex's folder holds something called `re` that install never wrote: no here.md, so it is not ours to remove.
  mkdirSync(join(codex, "re"), { recursive: true });
  writeFileSync(join(codex, "re", "SKILL.md"), "someone else's skill about regular expressions");

  const list = await runIn(["skill", "list", "--home", home, "--json"], ENV(home));
  const before = list.json().installed as Array<{ path: string; root: string; rootExists: boolean }>;
  assert.deepEqual(before.map((c) => c.path), [old], "the old mark is still understood");
  assert.equal(before[0]!.root, ROOT);
  assert.equal(before[0]!.rootExists, true, "a copy is recognised by its command under either name");

  const told = await runIn(["skill", "install", "--agent", "claude", "--agent", "codex", "--home", home], ENV(home));
  assert.equal(told.code, 1, "without --yes it only says what it would do");
  assert.match(told.err, /It will remove the copy installed under the old name/);
  assert.ok(told.err.includes(old));
  assert.ok(existsSync(old), "and has done nothing yet");

  const r = await runIn(["skill", "install", "--yes", "--agent", "claude", "--agent", "codex", "--home", home, "--json"], ENV(home));
  assert.equal(r.code, 0, r.out + r.err);
  const a = r.json() as { installed: Array<{ path: string }>; replaced: Array<{ path: string }> };
  assert.deepEqual(a.replaced.map((c) => c.path), [old]);
  assert.equal(existsSync(old), false, "the old copy is gone");
  assert.ok(existsSync(join(claude, "opensourcebook", "SKILL.md")), "the new one is in its place");
  assert.match(readFileSync(join(claude, "opensourcebook", HERE), "utf8"), /<!-- opensourcebook-root: /);
  assert.doesNotMatch(readFileSync(join(claude, "opensourcebook", HERE), "utf8"), /re-root/);
  assert.equal(readFileSync(join(codex, "re", "SKILL.md"), "utf8"), "someone else's skill about regular expressions", "a folder install did not write is never removed");

  const again = await runIn(["skill", "install", "--yes", "--agent", "claude", "--home", home, "--json"], ENV(home));
  assert.deepEqual(again.json().replaced, [], "nothing old is left to replace");
});

test("skill uninstall removes a copy from before the rename as well as a new one", async () => {
  const home = join(dir, "home-old-gone");
  const claude = join(home, ".claude", "skills");
  const old = oldCopy(claude, "/a/folder/that/is/gone");
  const list = await runIn(["skill", "list", "--agent", "claude", "--home", home, "--json"], ENV(home));
  assert.equal((list.json().installed as Array<{ rootExists: boolean }>)[0]!.rootExists, false);
  const gone = await runIn(["skill", "uninstall", "--yes", "--agent", "claude", "--home", home, "--json"], ENV(home));
  assert.equal(gone.code, 0, gone.out + gone.err);
  assert.deepEqual((gone.json().removed as Array<{ path: string }>).map((c) => c.path), [old]);
  assert.equal(existsSync(old), false);
});

test("skill install --dir writes into one folder only, and list and uninstall find exactly that", async () => {
  const home = join(dir, "home-dir");
  mkdirSync(home);
  const target = join(dir, "my-skills");
  const stranger = join(target, "other-skill");
  mkdirSync(stranger, { recursive: true });
  writeFileSync(join(stranger, "SKILL.md"), "not Open Sourcebook's");
  const r = await runIn(["skill", "install", "--yes", "--dir", target, "--json"], ENV(home));
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual((r.json().installed as Array<{ path: string }>).map((i) => i.path), [join(target, "opensourcebook")]);
  assert.equal(readdirSync(home).length, 0, "nothing in the home folder");
  assert.match(readFileSync(join(target, "opensourcebook", HERE), "utf8"), /no longer at/);

  const list = await runIn(["skill", "list", "--dir", target, "--json"], ENV(home));
  const copies = list.json().installed as Array<{ path: string; rootExists: boolean }>;
  assert.deepEqual(copies.map((c) => c.path), [join(target, "opensourcebook")]);
  assert.equal(copies[0]!.rootExists, true);

  const refused = await runIn(["skill", "uninstall", "--dir", target], ENV(home));
  assert.equal(refused.code, 1);
  assert.ok(existsSync(join(target, "opensourcebook")));
  const gone = await runIn(["skill", "uninstall", "--yes", "--dir", target], ENV(home));
  assert.equal(gone.code, 0);
  assert.equal(existsSync(join(target, "opensourcebook")), false);
  assert.ok(existsSync(join(stranger, "SKILL.md")), "a skill Open Sourcebook did not install stays");
  const none = await runIn(["skill", "uninstall", "--yes", "--dir", target], ENV(home));
  assert.match(none.out, /nothing to remove/);
});

test("skill list says when the Open Sourcebook a copy points at is gone", async () => {
  const home = join(dir, "home-gone");
  const fakeRoot = join(dir, "moved-re");
  mkdirSync(join(fakeRoot, "cli"), { recursive: true });
  writeFileSync(join(fakeRoot, "cli", "opensourcebook.mjs"), "");
  cpSync(join(ROOT, "skills"), join(fakeRoot, "skills"), { recursive: true });
  mkdirSync(home);
  const r = await runIn(["skill", "install", "--yes", "--agent", "codex", "--home", home], { ...ENV(home), root: fakeRoot });
  assert.equal(r.code, 0, r.err);
  rmSync(fakeRoot, { recursive: true, force: true });
  const list = await runIn(["skill", "list", "--agent", "codex", "--home", home], ENV(home));
  assert.match(list.out, /no Open Sourcebook there any more; run `opensourcebook skill install` again/);
  assert.match(readFileSync(join(home, ".agents", "skills", "opensourcebook", HERE), "utf8"), /tell the person "Open Sourcebook is no longer at /);
});

test("packs are read from the folder: a new folder with a skill is a new pack, without touching any list", () => {
  const packs = join(dir, "packs");
  mkdirSync(join(packs, "alpha", "references"), { recursive: true });
  writeFileSync(join(packs, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: for alpha work\n---\n\nKnowledge.");
  writeFileSync(join(packs, "alpha", "references", "more.md"), "More.");
  writeFileSync(join(packs, "alpha", "pack.json"), JSON.stringify({ example: "alpha-example" }));
  mkdirSync(join(packs, "not-a-pack"));
  const found = readPacks(packs);
  assert.deepEqual(found.map((p) => p.name), ["alpha"]);
  assert.equal(found[0]!.description, "for alpha work");
  assert.equal(found[0]!.example, "alpha-example");
  assert.deepEqual(found[0]!.files.sort(), ["alpha/SKILL.md", "alpha/pack.json", "alpha/references/more.md"]);
});

test("opensourcebook pack list reads Open Sourcebook's own packs folder, and works with Open Sourcebook not running", async () => {
  const r = await runIn(["pack", "list", "--json"], { home: join(dir, ".opensourcebook"), cwd: dir });
  assert.equal(r.code, 0);
  const names = (r.json().packs as Array<{ name: string; on?: boolean }>).map((p) => p.name);
  assert.deepEqual(names, readPacks(join(ROOT, "packs")).map((p) => p.name));
  assert.ok((r.json().packs as Array<{ on?: boolean }>).every((p) => p.on === undefined));
});

function mdFiles(folder: string, base: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? mdFiles(path, base) : name.endsWith(".md") ? [relative(base, path).split("\\").join("/")] : [];
  });
}

test("the engine's bundled list of pack files is exactly the .md files in packs/", () => {
  const listed = [...readFileSync(join(ROOT, "engine", "src", "chat", "agent", "pack-files.ts"), "utf8").matchAll(/^\s+"([^"]+\.md)":/gm)].map((m) => m[1]!).sort();
  const inPacks = mdFiles(join(ROOT, "packs"), join(ROOT, "packs")).filter((path) => path.includes("/"));
  assert.deepEqual(listed, inPacks.sort(),"add each pack file to engine/src/chat/agent/pack-files.ts");
});

test("the opensourcebook skill tells of opensourcebook makers and its set, set-all and review, each a command opensourcebook has", () => {
  const skill = readFileSync(join(ROOT, "skills", "opensourcebook", "SKILL.md"), "utf8");
  const group = GROUPS.find((g) => g.thing === "makers")!;
  for (const action of ["set", "set-all", "review"]) {
    assert.ok(skill.includes(`\`opensourcebook makers ${action} `), `the skill names opensourcebook makers ${action}`);
    assert.ok(group.commands.some((c) => c.action === action), `opensourcebook makers ${action} is a command`);
  }
  assert.ok(skill.includes("`opensourcebook makers` shows"));
  assert.ok(group.commands.some((c) => !c.action || c.action === "list" || c.action === "show"), "opensourcebook makers alone is a command");
});
