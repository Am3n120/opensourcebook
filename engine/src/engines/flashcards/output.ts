/**
 * What every maker of a set hands the engine once the set is written: the
 * output row (title, summary for later items, citations, assets used) and
 * the network checks' findings as validation issues.
 */
import { cardBlocks, type CardSet } from "../../cards/contract";
import type { Citation, EngineContext, EngineOutput, ValidationIssue } from "../../studio/types";
import type { AssetRef, SourceEnvelope } from "../../types/source";
import type { URLVerificationReport } from "../../types/verification";
import { allBlocks } from "./pipeline";
import type { FlashcardSettings } from "./settings";

export function setOutput(set: CardSet, ctx: EngineContext<FlashcardSettings>, source: SourceEnvelope): EngineOutput<CardSet> {
  return {
    title: set.title,
    summary: summarize(set),
    payload: set,
    citations: outputCitations(set, ctx),
    assets: usedAssets(set, source.assets ?? []),
  };
}

/**
 * The output row's citations: every card's cites, anchored at the card (or
 * the block) they ground, and a bare one for each source no card cites, so
 * the row still names everything the set was made from.
 */
function outputCitations(set: CardSet, ctx: EngineContext<FlashcardSettings>): Citation[] {
  const citations: Citation[] = [];
  set.cards.forEach((card, index) => {
    const front = card.front.length;
    for (const cite of card.cites) {
      const at = cite.block === undefined ? "" : cite.block < front ? `.front[${cite.block}]` : `.back[${cite.block - front}]`;
      citations.push({
        sourceId: cite.sourceId,
        ...(cite.chunkId ? { chunkId: cite.chunkId } : {}),
        ...(cite.locator ? { locator: cite.locator } : {}),
        ...(cite.quote ? { quote: cite.quote } : {}),
        anchor: `cards[${index}]${at}`,
      });
    }
  });
  const cited = new Set(citations.map((citation) => citation.sourceId));
  for (const nodeSource of ctx.sources) if (!cited.has(nodeSource.sourceId)) citations.push({ sourceId: nodeSource.sourceId });
  return citations;
}

/**
 * What later items are told this set covered: the excerpt, or what its
 * first cards ask and answer, so a quiz after it knows what was drilled.
 */
export function summarize(set: CardSet): string {
  if (set.excerpt?.trim()) return set.excerpt.trim().slice(0, 600);
  const lines: string[] = [];
  for (const card of set.cards) {
    const words = cardBlocks(card)
      .map((block) => ("text" in block && typeof block.text === "string" ? block.text : "term" in block && typeof block.term === "string" ? block.term : ""))
      .map((text) => text.replace(/\[\[([^[\]]+)\]\]/g, "$1").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    if (words) lines.push(words);
    if (lines.join(" ").length > 500) break;
  }
  const base = lines.length > 0 ? `${set.cards.length} cards: ${lines.join(" · ")}` : `${set.title}. ${set.subtitle}`.trim();
  return base.slice(0, 600);
}

function usedAssets(set: CardSet, assets: AssetRef[]): AssetRef[] {
  if (assets.length === 0) return [];
  const json = JSON.stringify(allBlocks(set));
  return assets.filter((asset) => json.includes(JSON.stringify(asset.url)));
}

export function verificationIssues(verification: URLVerificationReport): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const failure of verification.failures) {
    issues.push({
      path: failure.url,
      code: "unreachable_url",
      message: `${failure.error ?? "URL check failed"}${failure.status ? ` (HTTP ${failure.status})` : ""}; remove or replace this link or media`,
      severity: "error",
    });
  }
  for (const chartError of verification.chartErrors) {
    const [path, ...rest] = chartError.split(": ");
    issues.push({ path, code: "chart_data", message: rest.join(": ") || chartError, severity: "error" });
  }
  for (const warning of verification.warnings) {
    issues.push({ path: "$", code: "verification_warning", message: warning, severity: "warning" });
  }
  return issues;
}
