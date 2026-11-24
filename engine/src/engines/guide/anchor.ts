/**
 * A spot in a guide in words (`FormatDefinition.describeAnchor`): the
 * section the person is at, as the guide's player keeps it (`{ section }`,
 * a section id, and `point` when they pointed at one), with its heading, its
 * points, which of them are the maker's own explanation or the person's own
 * words, and their cites.
 */
import type { AnchorWords, JsonValue } from "../../studio/types";
import type { GuidePayload, GuidePoint } from "./contract";

export function guideAnchor(guide: GuidePayload, at: JsonValue): AnchorWords | undefined {
  if (!at || typeof at !== "object" || Array.isArray(at) || typeof at.section !== "string") return undefined;
  const sections = Array.isArray(guide?.sections) ? guide.sections : [];
  const index = sections.findIndex((section) => section.id === at.section);
  if (index < 0) return undefined;
  const section = sections[index]!;
  const facts = [`In section ${index + 1} of ${sections.length}: "${section.title}".`];
  const pointed = typeof at.point === "string" ? section.points.find((point) => point.id === at.point) : undefined;
  if (pointed) facts.push(`The person is pointing at this point: ${line(pointed)}`);
  for (const point of section.points) if (point !== pointed) facts.push(`A point here: ${line(point)}`);
  return { label: pointed ? `at "${short(pointed.term ?? pointed.text)}"` : `in "${short(section.title)}"`, facts };
}

function line(point: GuidePoint): string {
  const words = `"${point.term ? `${point.term}: ` : ""}${point.text}"`;
  const whose = point.yours ? (point.made ? ` The person changed it by hand; the maker wrote "${point.made.term ? `${point.made.term}: ` : ""}${point.made.text}".` : " The person wrote it by hand.") : point.background ? " It is the maker's own explanation, not from the person's sources." : "";
  const cites = point.cites.map((cite) => `"${cite.quote}"`).join("; ");
  return `${words}${whose}${cites ? ` It cites: ${cites}.` : ""}`;
}

function short(text: string): string {
  return text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text;
}
