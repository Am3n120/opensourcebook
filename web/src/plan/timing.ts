import type { FormatDescriptor, JsonObject } from "../api/types";

/**
 * The length group a thing's making time is kept under, from its format's
 * own `timing` (engine/src/studio/timing.ts holds the same rule; both test
 * engine/tests/fixtures/time-buckets.json): "auto" while the length setting
 * holds 0 (the sources decide) or the length the engine filled in for Auto
 * (`autoLength`), "le<edge>" for the first edge it does not
 * pass, else "gt<last edge>". No group (undefined) for a format that
 * declares no `timing`, or when the length is missing, not a number or
 * below 0. Pass the settings as made, the format's defaults filled in.
 */
export function timeBucket(format: Pick<FormatDescriptor, "timing"> | undefined, settings: JsonObject | undefined): string | undefined {
  const timing = format?.timing;
  if (!timing || timing.edges.length === 0) return undefined;
  const value = settings?.[timing.setting];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  // A length the engine filled in for Auto is kept beside it as `autoLength`: still Auto while the two agree.
  if (value === 0 || value === settings?.autoLength) return "auto";
  const edge = timing.edges.find((e) => value <= e);
  return edge !== undefined ? `le${edge}` : `gt${timing.edges[timing.edges.length - 1]}`;
}
