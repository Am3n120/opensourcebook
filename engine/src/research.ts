import { createOpenAlexProvider } from "./providers/openalex";
import { hostname, isHTTPURL } from "./net";
import type {
  PaperMetadata,
  PaperMetadataProvider,
  ResearchResult,
  SourceEnvelope,
  SourceReference,
  StructuredProvider,
  SupplementalReference,
} from "./types";

/**
 * Research is a source-level stage: it asks for the missing context needed to
 * teach the source accurately, never for output content. The source stays
 * primary; every returned reference is labeled supplemental by the caller.
 */
export function buildResearchPrompt(source: SourceEnvelope): string {
  return `Return only valid JSON. Use only facts you can ground in real, reachable sources; do not invent facts, quotes, URLs, or authors.
Research only the missing context needed to teach this source accurately. Keep the original source primary.
Source title: ${source.title ?? "(unknown)"}
Source URL: ${source.originalURL ?? "(none)"}
Source text:
${source.text}

Return JSON with summary, claims, references, and limitations. References must be real grounded URLs and must be labeled supplemental by the caller; do not repeat the original source URL.`;
}

export interface GroundedResearchResponse {
  summary?: string;
  claims?: string[];
  references?: Array<{
    url: string;
    title?: string;
    domain?: string;
    reason?: string;
  }>;
  limitations?: string[];
}

export async function researchSource(
  source: SourceEnvelope,
  provider?: StructuredProvider,
  paperMetadataProvider?: PaperMetadataProvider,
): Promise<ResearchResult> {
  const paperResult = await enrichPaperMetadata(source, paperMetadataProvider);
  const paperReferences = paperResult.paper ? referencesForPaper(paperResult.paper) : [];

  if (!provider?.generateGroundedJSON) {
    return {
      summary: paperResult.paper ? `OpenAlex metadata found for "${paperResult.paper.title}".` : "No supplemental research provider was configured.",
      claims: [],
      references: mergeSupplementalReferences(source, paperReferences),
      limitations: [
        ...paperResult.limitations,
        "Research was skipped because grounded provider access is unavailable",
      ],
      ...(paperResult.paper ? { paper: paperResult.paper } : {}),
    };
  }

  try {
    const response = await provider.generateGroundedJSON<GroundedResearchResponse>({
      systemPrompt: "Return only valid JSON. Use the supplied source as the primary evidence. Never invent citations. Every supplemental reference must be a real URL returned by the grounding tool.",
      userPrompt: buildResearchPrompt(source),
      task: "research",
      grounding: true,
    });
    const references = normalizeSupplementalReferences(response.references);
    const deduplicated = mergeSupplementalReferences(source, [...paperReferences, ...references]);
    // Counted after removing the source's own URLs: grounding that only
    // points back at the source has added nothing.
    const distinctGrounded = mergeSupplementalReferences(source, references).length;
    return {
      summary: clean(response.summary, 8_000) ?? "",
      claims: cleanArray(response.claims, 20),
      references: deduplicated,
      limitations: [
        ...paperResult.limitations,
        ...cleanArray(response.limitations, 10),
        ...(distinctGrounded === 0 ? ["Grounding returned no distinct supplemental references"] : []),
      ],
      ...(paperResult.paper ? { paper: paperResult.paper } : {}),
    };
  } catch {
    return {
      summary: paperResult.paper ? `OpenAlex metadata found for "${paperResult.paper.title}".` : "Supplemental research was unavailable.",
      claims: [],
      references: mergeSupplementalReferences(source, paperReferences),
      limitations: [
        ...paperResult.limitations,
        "Grounded research failed; generation must remain within the original source",
      ],
      ...(paperResult.paper ? { paper: paperResult.paper } : {}),
    };
  }
}

export function mergeResearchReferences(source: SourceEnvelope, research: ResearchResult): SourceReference[] {
  const sourceReferences = source.references.map((reference) => ({ ...reference, label: "source" as const }));
  const supplemental = mergeSupplementalReferences(source, research.references).map((reference) => ({
    ...reference,
    label: "supplemental" as const,
  }));
  return [...sourceReferences, ...supplemental];
}

async function enrichPaperMetadata(
  source: SourceEnvelope,
  paperMetadataProvider?: PaperMetadataProvider,
): Promise<{ paper?: PaperMetadata; limitations: string[] }> {
  if (source.kind !== "paper" && source.kind !== "pdf") return { limitations: [] };
  const provider = paperMetadataProvider ?? createOpenAlexProvider();
  try {
    const paper = await provider.enrich(source);
    return paper ? { paper, limitations: [] } : { limitations: ["OpenAlex returned no matching paper metadata"] };
  } catch (error) {
    // Best-effort tier: enrichment failure must not block the paper, but the
    // reason matters for diagnosing provider/egress issues in production.
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}${"code" in error ? ` (code ${String((error as { code?: unknown }).code)})` : ""}${"status" in error ? ` (http ${String((error as { status?: unknown }).status)})` : ""}`
        : String(error);
    console.warn(`OpenAlex paper enrichment failed: ${detail}`);
    return { limitations: ["OpenAlex paper metadata enrichment was unavailable"] };
  }
}

function referencesForPaper(paper: PaperMetadata): SupplementalReference[] {
  const references: GroundedResearchResponse["references"] = [];
  if (paper.workURL) references.push({ url: paper.workURL, title: paper.title, reason: "OpenAlex work record" });
  if (paper.doiURL) references.push({ url: paper.doiURL, title: paper.title, reason: "Paper DOI" });
  if (paper.landingPageURL) references.push({ url: paper.landingPageURL, title: paper.title, reason: "Paper landing page" });
  for (const reference of paper.references) {
    references.push({ url: reference.url, title: reference.title, reason: "OpenAlex cited work" });
  }
  return normalizeSupplementalReferences(references);
}

function mergeSupplementalReferences(source: SourceEnvelope, references: SupplementalReference[]): SupplementalReference[] {
  const sourceURLs = new Set(
    [source.originalURL, source.canonicalURL, ...source.references.map((reference) => reference.url)]
      .filter((url): url is string => Boolean(url))
      .map(referenceURLKey),
  );
  const seen = new Set<string>();
  const output: SupplementalReference[] = [];
  for (const reference of references) {
    const key = referenceURLKey(reference.url);
    if (!key || sourceURLs.has(key) || seen.has(key)) continue;
    seen.add(key);
    output.push(reference);
    if (output.length >= 20) break;
  }
  return output;
}

function referenceURLKey(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function normalizeSupplementalReferences(value: GroundedResearchResponse["references"]): SupplementalReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: SupplementalReference[] = [];
  for (const reference of value) {
    if (!reference || typeof reference.url !== "string" || !isHTTPURL(reference.url)) continue;
    let url: string;
    try {
      url = new URL(reference.url).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    output.push({
      url,
      title: clean(reference.title, 500),
      domain: clean(reference.domain, 250) ?? hostname(url),
      label: "supplemental",
      relation: clean(reference.reason, 500),
      reason: clean(reference.reason, 500) ?? "Grounded supplemental context",
    });
  }
  return output.slice(0, 20);
}

function clean(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function cleanArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => clean(entry, 2_000))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, maxItems);
}

