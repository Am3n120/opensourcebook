/**
 * The tools every piece of work the person's agent does for an item has
 * (work.ts): look over the item's sources, search them, read them word for
 * word, and read Open Sourcebook's skills. The maker adds its own tools for writing its
 * shape. Passages are the item's own (sources/passages.ts), labelled P1,
 * P2, ... in a fixed order, and are what the writing tools cite.
 */
import { rankPassages } from "../retrieval";
import { renderPassages, type Passage } from "../../sources/passages";
import { charsOf, passagesNamed, renderMap } from "../../sources/reading";
import type { WorkTool } from "./work";
import { readSkillFile, skillFiles, skillIndex } from "./work-skills";

/** What the source tools read: the item's passages. */
export interface SourceWork {
  passages: Passage[];
  /** The packs on for the item's project, whose skills read_skill also reads (work-skills.ts). */
  packs?: readonly string[];
}

const SEARCH_MAX = 12;
const SEARCH_DEFAULT = 6;
const READ_MAX_CHARS = 16_000;

export function sourceTools<Work extends SourceWork>(): WorkTool<Work>[] {
  return [outlineSources<Work>(), searchPassages<Work>(), readPassages<Work>(), readSkill<Work>()];
}

/** The item's sources as a map: each source, its runs of passages with their labels, sizes and opening words. */
export function outlineOf(passages: Passage[]): string {
  const sources = new Map<string, Passage[]>();
  for (const passage of passages) sources.set(passage.sourceId, [...(sources.get(passage.sourceId) ?? []), passage]);
  const head = [...sources.values()].map((list) => `- "${list[0]!.sourceTitle ?? "Source"}": ${list[0]!.label}–${list.at(-1)!.label}, ${charsOf(list).toLocaleString("en-US")} characters`);
  return `Sources (${passages.length} passages, ${charsOf(passages).toLocaleString("en-US")} characters in all):\n${head.join("\n")}\n\nMap:\n${renderMap(passages)}`;
}

function outlineSources<Work extends SourceWork>(): WorkTool<Work> {
  return {
    name: "outline_sources",
    description: "Shows this item's sources as a map: each source with the labels of its passages (P1, P2, ...), their sizes and how each run of passages opens. Use it to see what there is before reading.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    label: () => "Looking over the sources",
    run: (_input, work) => ({ text: outlineOf(work.passages) }),
  };
}

function searchPassages<Work extends SourceWork>(): WorkTool<Work> {
  return {
    name: "search_passages",
    description: "Searches this item's sources for passages about something, best matches first. Each comes with its label and its full words, which is what you cite and quote. Search with the words the sources would use.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX, description: `How many passages, ${SEARCH_DEFAULT} if left out.` },
      },
      required: ["query"],
      additionalProperties: false,
    },
    label: (input) => (typeof input.query === "string" && input.query.trim() ? `Searching the sources for “${clip(input.query.trim(), 50)}”` : "Searching the sources"),
    run(input, work) {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) return { text: "`query` must say what to look for.", isError: true };
      const limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? Math.min(SEARCH_MAX, Math.max(1, input.limit)) : SEARCH_DEFAULT;
      const found = rankPassages(work.passages, query)
        .filter((entry) => entry.score > 0)
        .slice(0, limit)
        .map((entry) => entry.passage);
      if (found.length === 0) return { text: `No passage matches "${query}". Try other words, or look at outline_sources.` };
      return { text: renderPassages(found) };
    },
  };
}

function readPassages<Work extends SourceWork>(): WorkTool<Work> {
  return {
    name: "read_passages",
    description: `Reads passages word for word by their labels: a range such as "P3-P9", one label, or a list of them. Up to about ${READ_MAX_CHARS.toLocaleString("en-US")} characters at a time; it says where it stopped.`,
    inputSchema: {
      type: "object",
      properties: { passages: { description: 'Labels or ranges, such as "P3-P9" or ["P1", "P12-P14"].', anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } },
      required: ["passages"],
      additionalProperties: false,
    },
    label(input, work) {
      const named = passagesNamed(input.passages, work.passages);
      const titles = [...new Set((named ?? []).map((passage) => passage.sourceTitle).filter(Boolean))];
      return titles.length === 1 ? `Reading ${titles[0]}` : "Reading the sources";
    },
    run(input, work) {
      const named = passagesNamed(input.passages, work.passages);
      if (!named) return { text: `Name passages by label, such as "P3-P9"; this item has ${work.passages[0]?.label ?? "none"} to ${work.passages.at(-1)?.label ?? "none"}.`, isError: true };
      const shown: Passage[] = [];
      let used = 0;
      for (const passage of named) {
        if (shown.length > 0 && used + passage.text.length > READ_MAX_CHARS) break;
        shown.push(passage);
        used += passage.text.length;
      }
      const rest = named.length - shown.length;
      return { text: `${renderPassages(shown)}${rest > 0 ? `\n\n(Stopped after ${shown.at(-1)!.label}; ${rest} more of what you asked for: read on from ${named[shown.length]!.label}.)` : ""}` };
    },
  };
}

function readSkill<Work extends SourceWork>(): WorkTool<Work> {
  return {
    name: "read_skill",
    description: `Reads one of Open Sourcebook's skills, or a file it points to, whenever it would help. A skill is knowledge, never a rule: its SKILL.md first, and the files it points to when you want more. The skills:\n${skillIndex()}`,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: `A skill's name, or a file inside it, such as ${skillFiles().slice(0, 2).map((file) => `"${file}"`).join(" or ")}.` } },
      required: ["path"],
      additionalProperties: false,
    },
    label: () => "Reading how to teach this well",
    run(input, work) {
      const text = typeof input.path === "string" ? readSkillFile(input.path, work.packs) : undefined;
      return text ? { text } : { text: `No such skill file. These exist: ${skillFiles().join(", ")}.`, isError: true };
    },
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
