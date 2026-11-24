import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { databaseFile, databaseFiles, databaseId, databaseIdIn, earlierDatabases, earlierLine, needsMigrations, projectCounts } from "../database.ts";

const dir = mkdtempSync(join(tmpdir(), "opensourcebook-database-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const toml = (id: string, extra = "") => `name = "x"\n[vars]\nA = "1"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "db"\ndatabase_id = "${id}"\n${extra}migrations_dir = "migrations"\n[[r2_buckets]]\nbinding = "R"\n`;

function engine(name: string, id: string): string {
  const e = join(dir, name);
  mkdirSync(join(e, "migrations"), { recursive: true });
  writeFileSync(join(e, "migrations", "0001_a.sql"), "");
  writeFileSync(join(e, "wrangler.toml"), toml(id));
  return e;
}

/** A local D1 file for an id, with this many projects in it (or no projects table at all). */
function database(e: string, id: string, projects: number | "none"): string {
  mkdirSync(databaseFiles(e), { recursive: true });
  const file = databaseFile(e, id);
  const db = new DatabaseSync(file);
  if (projects !== "none") {
    db.exec("create table projects (id text)");
    for (let i = 0; i < projects; i++) db.exec(`insert into projects values ('p${i}')`);
  }
  db.close();
  return file;
}

test("the database id is the one local D1 uses: preview_database_id, else database_id, from the d1 block only", () => {
  assert.equal(databaseIdIn(toml("abc")), "abc");
  assert.equal(databaseIdIn(toml("abc", 'preview_database_id = "local-1"\n')), "local-1");
  assert.equal(databaseIdIn('database_id = "elsewhere"\n[[d1_databases]]\nbinding = "DB"\n'), undefined);
});

test("the file local D1 keeps an id in is named the way the Workers runtime names it", () => {
  // Pinned from real files the local engine wrote for these ids, so a change in the naming is caught.
  const e = join(dir, "names");
  assert.equal(databaseFile(e, "00000000-0000-0000-0000-000000000000"), join(databaseFiles(e), "9ba2b04bf514d9facfd57ed57d849e77241a7adc99d1c1545d06688b43d84248.sqlite"));
  assert.equal(databaseFile(e, "558fbbc1-8e4e-4574-a73c-436ae1d3b975"), join(databaseFiles(e), "aba5aa4af54f88251c6133ce42efdcacf211755b87a5e34192eba6e24e0157e2.sqlite"));
});

test("migrations are kept per database id, and a database that is not there is never taken as set up", () => {
  const e = engine("per-id", "old-id");
  database(e, "old-id", 1);
  const applied = { "old-id": ["0001_a.sql"] };
  assert.equal(needsMigrations(e, applied), false);
  // The settings file's id changes (an update's placeholder): the record of the old id says nothing about it.
  writeFileSync(join(e, "wrangler.toml"), toml("new-id"));
  assert.equal(databaseId(e), "new-id");
  assert.equal(needsMigrations(e, applied), true);
  assert.equal(needsMigrations(e, { ...applied, "new-id": ["0001_a.sql"] }), true, "recorded, but its file is gone: set up again");
  database(e, "new-id", 0);
  assert.equal(needsMigrations(e, { ...applied, "new-id": ["0001_a.sql"] }), false);
  // A wrangler.local.toml with the old id is used when it is there, and its database is the one that was set up.
  writeFileSync(join(e, "wrangler.local.toml"), toml("old-id"));
  assert.equal(databaseId(e), "old-id");
  assert.equal(needsMigrations(e, applied), false);
  rmSync(join(e, "wrangler.local.toml"));
  assert.equal(databaseId(e), "new-id");
});

test("a new, empty database beside one with projects is said in one plain line, and nothing is moved or deleted", () => {
  const e = engine("earlier", "new-id");
  const old = database(e, "old-id", 2);
  const now = database(e, "new-id", 0);
  database(e, "never-used", "none");
  const before = readdirSync(databaseFiles(e)).sort();
  assert.deepEqual(projectCounts([old, now]), { [old]: 2, [now]: 0 });

  const known = earlierDatabases(e, ["old-id", "something-else"]);
  assert.deepEqual(known, [{ file: old, projects: 2, id: "old-id" }]);
  const line = earlierLine(e, dir, known)!;
  assert.match(line, /^ {2}Open Sourcebook is using a new, empty database \(the database_id in engine\/wrangler\.toml\)\. Your earlier projects are kept as they were in the database with id old-id; to go back to them, put database_id = "old-id" in engine\/wrangler\.local\.toml \(a copy of engine\/wrangler\.toml\) and start Open Sourcebook again\.$/);
  assert.equal(line.split("\n").length, 1);

  // An id it cannot tell: the line says where the file is instead.
  const unknown = earlierDatabases(e, []);
  assert.equal(unknown[0]!.id, undefined);
  assert.match(earlierLine(e, dir, unknown)!, /another database file \(earlier[\\/]\.wrangler[\\/]state[\\/]v3[\\/]d1[\\/]miniflare-D1DatabaseObject[\\/][0-9a-f]{64}\.sqlite\).*the database_id you used before/);

  // The database in use has projects: nothing to say. And no other database: nothing to say.
  const withData = engine("in-use", "a");
  database(withData, "a", 1);
  database(withData, "b", 3);
  assert.deepEqual(earlierDatabases(withData, ["b"]), []);
  const alone = engine("alone", "a");
  database(alone, "a", 0);
  assert.deepEqual(earlierDatabases(alone, []), []);
  assert.equal(earlierLine(alone, dir, []), undefined);

  assert.deepEqual(readdirSync(databaseFiles(e)).sort(), before, "no database file was moved or deleted");
  assert.ok(existsSync(old));
});
