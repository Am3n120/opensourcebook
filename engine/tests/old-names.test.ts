/**
 * Settings named before the rename (`RE_X`) are read as the new ones (`OPENSOURCEBOOK_X`), so an older `.dev.vars`, a
 * deployed secret and the bindings `wrangler.toml` keeps under their old names go on working.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { newNameOf, withNewNames } from "../src/old-names";
import { createSqliteD1 } from "./support/sqlite-d1";

const TOKEN = "a-long-local-client-token";

describe("old names", () => {
  it("map by their prefix, and the state folder's by name", () => {
    expect(newNameOf("RE_CLIENT_TOKEN")).toBe("OPENSOURCEBOOK_CLIENT_TOKEN");
    expect(newNameOf("RE_JOB_DB")).toBe("OPENSOURCEBOOK_JOB_DB");
    expect(newNameOf("RE_HOME")).toBe("OPENSOURCEBOOK_STATE");
    for (const other of ["RE_", "RENDER_SERVICE_URL", "CHAT_AGENT", "OPENSOURCEBOOK_CLIENT_TOKEN", "re_client_token"]) expect(newNameOf(other)).toBeUndefined();
  });

  it("are read as the new ones when those are not set, and never over them", () => {
    const db = { prepare: () => undefined };
    const read = withNewNames({ RE_CLIENT_TOKEN: "old", RE_JOB_DB: db, RE_ASSETS: undefined, GEMINI_MODEL: "g" }) as Record<string, unknown>;
    expect(read.OPENSOURCEBOOK_CLIENT_TOKEN).toBe("old");
    expect(read.OPENSOURCEBOOK_JOB_DB).toBe(db);
    expect("OPENSOURCEBOOK_ASSETS" in read).toBe(false);
    expect(read).toMatchObject({ RE_CLIENT_TOKEN: "old", GEMINI_MODEL: "g" });

    expect(withNewNames({ RE_CLIENT_TOKEN: "old", OPENSOURCEBOOK_CLIENT_TOKEN: "new" })).toMatchObject({ OPENSOURCEBOOK_CLIENT_TOKEN: "new" });
    // A new name left empty (a copied example line) does not hide an old one that is set.
    expect(withNewNames({ RE_CLIENT_TOKEN: "old", OPENSOURCEBOOK_CLIENT_TOKEN: "" })).toMatchObject({ OPENSOURCEBOOK_CLIENT_TOKEN: "old" });
  });

  it("leave settings with nothing old as they are", () => {
    const settings = { OPENSOURCEBOOK_CLIENT_TOKEN: "new", GEMINI_MODEL: "g" };
    expect(withNewNames(settings)).toBe(settings);
  });
});

describe("the worker, given its settings", () => {
  const formats = (env: Record<string, unknown>, token = TOKEN) => worker.fetch(new Request("http://engine.test/v1/formats", { headers: { "x-client-token": token } }), env as never);

  it("answers with the names from before the rename, as wrangler.toml still binds the database", async () => {
    expect((await formats({ RE_JOB_DB: createSqliteD1(), RE_CLIENT_TOKEN: TOKEN })).status).toBe(200);
  });

  it("answers with the new names", async () => {
    expect((await formats({ OPENSOURCEBOOK_JOB_DB: createSqliteD1(), OPENSOURCEBOOK_CLIENT_TOKEN: TOKEN })).status).toBe(200);
  });

  it("takes the new token over an old one left behind", async () => {
    const env = { RE_JOB_DB: createSqliteD1(), RE_CLIENT_TOKEN: "an-old-client-token-left-behind", OPENSOURCEBOOK_CLIENT_TOKEN: TOKEN };
    expect((await formats(env)).status).toBe(200);
    expect((await formats(env, "an-old-client-token-left-behind")).status).toBe(403);
  });

  it("says the database is not bound when neither name is", async () => {
    const response = await formats({ OPENSOURCEBOOK_CLIENT_TOKEN: TOKEN });
    expect(response.status).toBe(503);
  });
});

describe("the example settings files", () => {
  it("show only the new names", () => {
    for (const file of [".dev.vars.example", ".env.example"]) {
      const names = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").match(/\bRE_[A-Z_]+/g) ?? [];
      expect(names, file).toEqual([]);
    }
  });
});
