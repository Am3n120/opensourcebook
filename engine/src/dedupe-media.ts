import type { ByteBlock } from "./types";

/**
 * Deterministic enforcement of the one-appearance asset rule from the writing
 * prompt (prompts.ts): an asset URL may appear at most once in a set of cards. Prompt
 * guidance alone is probabilistic — with a single harvested asset the model
 * sometimes repeats it (observed in production 2026-08-10: the same thumbnail
 * in two hero blocks of an Instagram byte) — so repeats are removed here:
 *
 * - hero / figure blocks whose url repeats an earlier media URL are dropped
 *   (their url is required, so stripping it is not an option);
 * - gallery / carousel items that repeat are filtered; a block that filtering
 *   drops below the 2-item schema minimum is dropped entirely;
 * - linkPreview.imageURL / clip.posterURL that repeat are stripped (both are
 *   optional decorations; the block itself stays);
 * - linkPreview / linkCard / embed blocks whose destination URL repeats an
 *   earlier one are dropped — the same link shown twice reads as a bug
 *   (observed in production 2026-08-10: a tweet byte carried two near-identical
 *   linkPreview cards for the source post);
 * - clip.url is exempt: several clips of the same video at different
 *   timestamps are a feature, not repetition.
 *
 * First occurrence wins, reading top to bottom; reveal children share the same
 * seen set as their siblings. Invalid entries (missing urls, non-objects) pass
 * through untouched — reporting those is the validator's job, not this pass's.
 */
/** `seen` carries the media already placed, so a set's cards can be passed side by side and share it. */
export function dedupeMediaURLs(blocks: ByteBlock[], seen: Set<string> = new Set<string>()): ByteBlock[] {
  return dedupeList(blocks, seen);
}

function dedupeList(blocks: ByteBlock[], seen: Set<string>): ByteBlock[] {
  const kept: ByteBlock[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      kept.push(block);
      continue;
    }
    switch (block.type) {
      case "hero":
      case "figure": {
        const key = mediaKey(block.url);
        if (key && seen.has(key)) continue; // repeated pure-media block
        if (key) seen.add(key);
        kept.push(block);
        break;
      }
      case "gallery":
      case "carousel": {
        const items = block.type === "gallery" ? block.images : block.items;
        if (!Array.isArray(items)) {
          kept.push(block);
          break;
        }
        const freshKeys: string[] = [];
        const fresh = items.filter((item) => {
          const key = item && typeof item === "object" ? mediaKey(item.url) : undefined;
          if (!key) return true; // invalid items stay for the validator
          if (seen.has(key)) return false;
          freshKeys.push(key);
          return true;
        });
        if (fresh.length < items.length && fresh.length < 2) continue; // fell below the schema minimum
        for (const key of freshKeys) seen.add(key);
        if (block.type === "gallery") block.images = fresh;
        else block.items = fresh;
        kept.push(block);
        break;
      }
      case "clip": {
        const key = mediaKey(block.posterURL);
        if (key) {
          if (seen.has(key)) delete block.posterURL;
          else seen.add(key);
        }
        kept.push(block);
        break;
      }
      case "linkPreview": {
        const destKey = mediaKey(block.url);
        if (destKey && seen.has(destKey)) continue; // same destination already shown
        if (destKey) seen.add(destKey);
        const key = mediaKey(block.imageURL);
        if (key) {
          if (seen.has(key)) delete block.imageURL;
          else seen.add(key);
        }
        kept.push(block);
        break;
      }
      case "linkCard":
      case "embed": {
        const destKey = mediaKey(block.url);
        if (destKey && seen.has(destKey)) continue; // same destination already shown
        if (destKey) seen.add(destKey);
        kept.push(block);
        break;
      }
      case "reveal": {
        if (Array.isArray(block.blocks)) block.blocks = dedupeList(block.blocks, seen);
        kept.push(block);
        break;
      }
      default:
        kept.push(block);
    }
  }
  return kept;
}

/** Same normalization as evidence validation: hash stripped, trailing slash ignored; relative asset paths compare exactly. */
function mediaKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}
