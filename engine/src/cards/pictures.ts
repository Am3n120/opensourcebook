/**
 * Where a picture in a made thing may come from. A card, a page or any other
 * set of blocks shows only pictures Open Sourcebook itself keeps (`/v1/assets/<id>`,
 * stored with their credit when a source was read) or a small picture
 * embedded as data. Never a web address: a picture drawn from a remote
 * server is a request the person's device makes without a click, and an
 * agent that read something it should not pass on could put it in that
 * address. A link a person clicks (a link card, a link preview's page, a
 * clip's video) is not a picture and is not checked here.
 *
 * The block schema (schema.ts) refuses a remote picture from a maker; an
 * output is stored and served through `withoutRemotePictures`, so an older
 * output or an imported project draws without that picture instead.
 */
import { isAssetPath } from "../assets";
import { isRecord } from "../net";

/** A raster picture embedded as base64 data; never SVG, which can carry script. */
const DATA_PICTURE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i;

/** True for a picture Open Sourcebook keeps (`/v1/assets/<id>`) or a raster picture embedded as data. */
export function isKeptPicture(value: unknown): value is string {
  return typeof value === "string" && (isAssetPath(value) || DATA_PICTURE.test(value));
}

/** The plain words a maker reads when it sends any other picture address. */
export const KEPT_PICTURE_RULE =
  "a picture must be one Open Sourcebook keeps: a /v1/assets/<id> address from the source's pictures (or a small picture embedded as data:image/...;base64). A web address is never shown; leave the picture out or use one of the source's pictures";

/**
 * Per block type: fields that hold one picture, lists whose items each hold
 * one in `url`, and fields never kept (an embed's own HTML, which the phone
 * would load in a web view with everything it names).
 */
const PICTURE_FIELDS: Record<string, { optional?: string[]; required?: string[]; lists?: string[]; never?: string[] }> = {
  embed: { never: ["html"] },
  image: { optional: ["url"] },
  figure: { required: ["url"] },
  labelPicture: { required: ["url"] },
  hero: { required: ["url"] },
  gallery: { lists: ["images"] },
  carousel: { lists: ["items"] },
  clip: { optional: ["posterURL"] },
  linkPreview: { optional: ["imageURL"] },
};

/**
 * A copy of any JSON value with every picture that is not kept taken out:
 * an optional picture field is dropped, a required one is left empty (the
 * block draws without its picture), and a gallery or carousel item goes.
 * Blocks are found by their `type` anywhere in the value, so card sets,
 * pages and blocks nested in a reveal are all covered.
 */
export function withoutRemotePictures<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = strip(entry);
  const fields = typeof out.type === "string" && Object.hasOwn(PICTURE_FIELDS, out.type) ? PICTURE_FIELDS[out.type] : undefined;
  if (!fields) return out;
  for (const key of fields.never ?? []) delete out[key];
  for (const key of fields.optional ?? []) if (out[key] !== undefined && out[key] !== null && !isKeptPicture(out[key])) delete out[key];
  for (const key of fields.required ?? []) if (typeof out[key] === "string" && out[key] !== "" && !isKeptPicture(out[key])) out[key] = "";
  for (const key of fields.lists ?? []) {
    if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).filter((item) => !isRecord(item) || isKeptPicture(item.url));
  }
  return out;
}
