import { sha256Hex } from "./net";
import { ASSET_KINDS, type AssetKind, type AssetRef, type R2BucketLike } from "./types";

const ASSET_KEY_PREFIX = "assets/";
export const ASSET_PATH_PREFIX = "/v1/assets/";
const ASSET_PATH_PATTERN = /^\/v1\/assets\/[A-Za-z0-9._~-]+$/;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export interface PutAssetInput {
  kind: AssetKind;
  sourceURL?: string;
  caption?: string;
  page?: number;
  timestampMs?: number;
  width?: number;
  height?: number;
  contentType?: string;
}

/**
 * Content-addressed media store backed by the assets R2 bucket. Asset ids
 * are the SHA-256 hex of the bytes, so identical media is stored once and the
 * `/v1/assets/<id>` paths are immutable. With no bucket bound every call
 * resolves undefined so extraction degrades gracefully.
 */
export class AssetStore {
  constructor(private readonly bucket?: R2BucketLike) {}

  async putAsset(bytes: ArrayBuffer | ArrayBufferView, input: PutAssetInput): Promise<AssetRef | undefined> {
    if (!this.bucket) return undefined;
    const buffer = toArrayBuffer(bytes);
    const id = await sha256Hex(buffer);
    const contentType = input.contentType ?? DEFAULT_CONTENT_TYPE;
    await this.bucket.put(assetKeyForId(id), buffer, {
      httpMetadata: { contentType },
      customMetadata: customMetadataFor(input),
    });
    return {
      id,
      kind: input.kind,
      url: assetPathForId(id),
      ...(input.sourceURL ? { sourceURL: input.sourceURL } : {}),
      ...(input.caption ? { caption: input.caption } : {}),
      ...(input.page !== undefined ? { page: input.page } : {}),
      ...(input.timestampMs !== undefined ? { timestampMs: input.timestampMs } : {}),
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      contentType,
    };
  }

  /** Deletes a kept file; false when there is no bucket or it cannot delete. Only for a file nothing points at any more. */
  async deleteAsset(id: string): Promise<boolean> {
    if (!this.bucket?.delete) return false;
    await this.bucket.delete(assetKeyForId(id));
    return true;
  }

  async headAsset(id: string): Promise<AssetRef | undefined> {
    if (!this.bucket) return undefined;
    const object = await this.bucket.head(assetKeyForId(id));
    if (!object) return undefined;
    const metadata = object.customMetadata ?? {};
    const page = metadataNumber(metadata.page);
    const timestampMs = metadataNumber(metadata.timestampMs);
    const contentType = object.httpMetadata?.contentType;
    return {
      id,
      kind: isAssetKind(metadata.kind) ? metadata.kind : "image",
      url: assetPathForId(id),
      ...(metadata.sourceURL ? { sourceURL: metadata.sourceURL } : {}),
      ...(metadata.caption ? { caption: metadata.caption } : {}),
      ...(page !== undefined ? { page } : {}),
      ...(timestampMs !== undefined ? { timestampMs } : {}),
      ...(contentType ? { contentType } : {}),
    };
  }
}

/** An AssetStore without a bucket; every put resolves undefined. */
export function createNullAssetStore(): AssetStore {
  return new AssetStore();
}

export function assetKeyForId(id: string): string {
  return `${ASSET_KEY_PREFIX}${id}`;
}

export function assetPathForId(id: string): string {
  return `${ASSET_PATH_PREFIX}${id}`;
}

export function isAssetPath(url: string): boolean {
  return ASSET_PATH_PATTERN.test(url);
}

/** Every kept file a stored JSON text points at by its path (`/v1/assets/<id>`), each id once. */
export function assetIdsIn(json: string): string[] {
  return [...new Set([...json.matchAll(/\/v1\/assets\/([A-Za-z0-9._~-]+)/g)].map((match) => match[1]!))];
}

/** Resolves a worker-relative asset path against the public base URL when one is configured. */
export function assetURLFromPath(path: string, baseURL?: string): string | undefined {
  if (!isAssetPath(path)) return undefined;
  const base = baseURL?.trim().replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

function customMetadataFor(input: PutAssetInput): Record<string, string> {
  const metadata: Record<string, string> = { kind: input.kind };
  if (input.sourceURL) metadata.sourceURL = input.sourceURL;
  if (input.caption) metadata.caption = input.caption;
  if (input.page !== undefined) metadata.page = String(input.page);
  if (input.timestampMs !== undefined) metadata.timestampMs = String(input.timestampMs);
  return metadata;
}

function metadataNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAssetKind(value: string | undefined): value is AssetKind {
  return typeof value === "string" && (ASSET_KINDS as readonly string[]).includes(value);
}

function toArrayBuffer(bytes: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
