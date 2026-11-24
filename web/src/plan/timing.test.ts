import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonObject } from "../api/types";
import { timeBucket } from "./timing";

interface Case {
  name: string;
  timing: { setting: string; edges: number[] } | null;
  settings: JsonObject;
  bucket: string | null;
}

// The engine's case file (engine/tests/fixtures/time-buckets.json), copied here until it is on this branch, then read from there.
const SHARED = resolve(__dirname, "../../../engine/tests/fixtures/time-buckets.json");
const OWN: Case[] = [
  { name: "zero is auto", timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] }, settings: { minutes: 0 }, bucket: "auto" },
  { name: "below the first edge", timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] }, settings: { minutes: 1 }, bucket: "le2" },
  { name: "exactly the first edge", timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] }, settings: { minutes: 2 }, bucket: "le2" },
  { name: "just over an edge", timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] }, settings: { minutes: 2.5 }, bucket: "le4" },
  { name: "a middle edge", timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] }, settings: { minutes: 7 }, bucket: "le7" },
  { name: "the last edge", timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] }, settings: { minutes: 20 }, bucket: "le20" },
  { name: "over the last edge", timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] }, settings: { minutes: 21 }, bucket: "gt20" },
  { name: "other settings do not matter", timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] }, settings: { minutes: 5, voice: "x" }, bucket: "le7" },
  { name: "another setting name and edges", timing: { setting: "length", edges: [10] }, settings: { length: 11 }, bucket: "gt10" },
  { name: "the length is missing", timing: { setting: "minutes", edges: [2, 4] }, settings: {}, bucket: null },
  { name: "the length is not a number", timing: { setting: "minutes", edges: [2, 4] }, settings: { minutes: "5" }, bucket: null },
  { name: "a negative length", timing: { setting: "minutes", edges: [2, 4] }, settings: { minutes: -1 }, bucket: null },
  { name: "no timing declared", timing: null, settings: { minutes: 5 }, bucket: null },
];
const cases: Case[] = existsSync(SHARED) ? (JSON.parse(readFileSync(SHARED, "utf8")) as { cases: Case[] }).cases : OWN;

test.each(cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
  expect(timeBucket(c.timing ? { timing: c.timing } : {}, c.settings) ?? null).toBe(c.bucket);
});

test("a length the engine filled in for Auto still counts as Auto, and one changed since does not", () => {
  const format = { timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] } };
  expect(timeBucket(format, { minutes: 3, autoLength: 3 })).toBe("auto");
  expect(timeBucket(format, { minutes: 5, autoLength: 3 })).toBe("le7");
});
