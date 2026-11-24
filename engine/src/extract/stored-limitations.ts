/**
 * Extractions stored before Nov 13, 2026 mixed plain lines and technical
 * notes in `limitations` and had no `extractionNotes`. Read back, each old
 * line is matched against the exact wording the readers of that time wrote:
 * a line that has a plain counterpart shows that instead, a line that only
 * told how the reading worked moves to the notes, and every old line is kept
 * whole in the notes. A line not listed here (already plain, such as the
 * long-source cut line, or unknown) stays as it was.
 *
 * This table is frozen history: readers now say their own plain lines
 * (./limits), so a new tier never adds a row here.
 */
import type { SourceEnvelope } from "../types";
import { SOME_PICTURES_LEFT_OUT } from "./limits";
import { VIDEO_TITLE_AND_DESCRIPTION_ONLY } from "./video";
import { LITTLE_TEXT } from "./web";

/** [old wording, plain line ($1 from the match) or undefined for a note only] */
const OLD_LINES: Array<[RegExp, string | undefined]> = [
  [/^No source text or URL was supplied$/, "Nothing was given to read."],
  [/^(Site-served Markdown|Reader-mode) extraction excludes scripts, styles, and authenticated content$/, undefined],
  [/^HTML extraction is lightweight and excludes scripts, styles, and authenticated content$/, undefined],
  [/^oEmbed metadata is provider-supplied/, undefined],
  [/^Included \d+ core subpage\(s\) advertised by the site's documentation index$/, undefined],
  [/^Page HTML was rendered in a headless browser before parsing$/, undefined],
  [/^Extracted via a reader service/, undefined],
  [/^GitHub repository statistics were unavailable$/, undefined],
  [/^Reader-mode parsing found no article/, "Only the page's title, description and preview picture could be read."],
  [/^The page exposed limited readable text$/, LITTLE_TEXT],
  [/^Web page could not be fetched/, "This page could not be opened."],
  [/^PDF bytes are not parsed/, "The file's text could not be read."],
  [/^PDF URL could not be reached during extraction$/, "The file could not be downloaded from its link."],
  [/^PDF exceeds 60 pages; embedded-figure extraction skipped/, "Pictures in this file were left out because it is long. All of its text was read."],
  [/^(Embedded PDF images were skipped|Some embedded PDF images could not|Oversized embedded images were skipped|Embedded-image budget exceeded|Embedded images were skipped|Some embedded images could not)/, SOME_PICTURES_LEFT_OUT],
  [/^The PDF has no extractable text layer/, "No text could be read from this file. It may be a scan of printed pages."],
  [/^The document has no extractable text/, "No text could be read from this file. It may be empty."],
  [/^Workbook was truncated at (\d+) sheets$/, "Only the first $1 sheets of this file were read."],
  [/^Worksheet rows were truncated at (\d+) rows per sheet$/, "Only the first $1 rows of each sheet were read."],
  [/^Only the first 40 rows are included in the extraction preview \((\d+) total\)$/, "Only the first 40 of this table's $1 rows were read."],
  [/^JSON payload did not parse cleanly/, undefined],
  [/^The feed exposed no entries$/, "This feed has no entries."],
  [/^The audio was stored, but the transcription provider returned no transcript$/, "The audio's words could not be turned into text."],
  [/^The audio was stored, but no transcription is available/, "Turning speech into text is not set up, so the audio's words were not read."],
  [/^The audio clip (could not be persisted|was not persisted)/, undefined],
  [/^The image was stored, but the vision provider returned no caption$/, "What this picture shows could not be described."],
  [/^The image was stored, but no vision caption is available/, "Describing pictures is not set up, so what this picture shows was not read."],
  [/^The image (could not be persisted|was not persisted)/, undefined],
  [/^No subtitles available; transcript empty$/, VIDEO_TITLE_AND_DESCRIPTION_ONLY],
  [/^Transcript is auto-generated and may contain errors$/, "This video's words come from automatic captions and may have mistakes."],
  [/^YouTube channel and playlist pages are not single videos/, "This link is a channel or playlist, not a single video, so only its title and description were read."],
  [/^(Gemini returned metadata without transcript|YouTube oEmbed provides metadata only)/, "Only this video's title and channel name could be read, not what is said in it."],
  [/^(Gemini YouTube extraction was unavailable|No Gemini YouTube extraction provider configured)/, undefined],
  [/^YouTube metadata endpoint was unavailable$/, "This video could not be opened."],
  [/^Reddit JSON view covers the post\/listing and top comments/, "Only the posts and their top comments were read, not pictures or videos in them."],
  [/^Social platforms may require authentication or block content extraction$/, undefined],
  [/^This post appears to be deleted, private, or otherwise unavailable$/, "This post seems to be deleted or private."],
  [/^Only publicly exposed metadata and supplied text are included$/, "Only this post's title and description could be read."],
  [/^No public social metadata was available$/, "This post could not be opened."],
  [/^Uploaded video content is not extracted yet/, "Uploaded videos are not read yet, so only the file's name was kept."],
  [/^The uploaded file \(.*\) could not be parsed/, "This kind of file could not be read."],
];

/**
 * An envelope with plain `limitations` and its `extractionNotes`, whenever
 * it was stored. One written since Nov 13, 2026 (it has `extractionNotes`)
 * comes back unchanged.
 */
export function withPlainLimitations(envelope: SourceEnvelope): SourceEnvelope {
  if (envelope.extractionNotes) return envelope;
  const limitations: string[] = [];
  const extractionNotes: string[] = [];
  for (const line of envelope.limitations ?? []) {
    const known = OLD_LINES.map(([pattern, plain]) => ({ match: pattern.exec(line), plain })).find(({ match }) => match);
    if (!known?.match) {
      if (!limitations.includes(line)) limitations.push(line);
      continue;
    }
    extractionNotes.push(line);
    const { match, plain } = known;
    const shown = plain?.replace(/\$(\d)/g, (_, index: string) => match[Number(index)] ?? "");
    if (shown && !limitations.includes(shown)) limitations.push(shown);
  }
  // Nothing the engine recognises: the envelope reads back exactly as stored.
  if (extractionNotes.length === 0) return envelope;
  return { ...envelope, limitations, extractionNotes };
}
