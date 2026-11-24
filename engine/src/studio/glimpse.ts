/** Helpers formats share to write their glimpse (`FormatDefinition.glimpse`). */

const MAX_GLIMPSE = 160;

/** A line of plain words from text that may carry Markdown or maths marks, cut at a word when long. */
export function plainLine(text: string | undefined, max = MAX_GLIMPSE): string | undefined {
  if (!text) return undefined;
  const plain = text
    .replace(/\$\$?([^$]*)\$\$?/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}
