# Long sources

How a long source (a paper, a book chapter, a long transcript) is stored,
cut into passages, mapped and read, so that what is made from it draws on the
whole of it or exactly the part asked for, and is priced by what it reads.

Until Nov 13, 2026 a source read from a link or an upload was cut to its first
24,000 characters, because every byte and quiz call sent all of an item's
passages. The cut is now at the bound below; what keeps each call small is
reading, not cutting.

## The bound

A source keeps up to **400,000 characters** of text (`MAX_SOURCE_CHARS`): about
100,000 tokens, a 200-page book, a long thesis, or seven hours of speech.
Links, uploads and pasted text share the bound. The ladders read up to
1,000,000 characters so the cut can say how long the source really was.

Above the bound the text is cut once, at a paragraph or sentence end, and the
source says so as it did before: a limitation in plain words ("Only the first
399,870 of 612,004 characters of this source are used (about 65%); the rest is
not read by anything made from it.") and `metadata.textChars`,
`textUsedChars`, `textCut`. Writers are told the passages are only part of the
source.

Why this number: the extraction row (`source_extractions.envelope_json`) holds
the text, and D1 rows are at most 2 MB. 400,000 UTF-16 units are at most
1.2 MB in UTF-8. The envelope never stores the same text twice (pasted text's
`originalText` is folded into `text` on write and restored on read). Chunk
rows are each about 1,200 characters, so a source at the bound is about 350
rows, written 20 to a statement.

## Where the text lives

In D1, as before: the whole text in the extraction's envelope (what the quote
check and the source view read) and the same text cut into passages in
`source_chunks` (what is cited and what makers read). No R2 object: the text
fits a row, and an item already reads its source's row and chunks in one
place (`NodeSource`). Reading a source at the bound is one row and about 350
chunk rows.

Nothing in the schema changes, so there is no migration.

## Passages and where they are

The chunker is unchanged for text without structure: paragraph-aligned
passages of about 1,200 characters (never over 2,000), each with
`charStart`/`charEnd`. Chunk ids are written once per extraction and do not
move.

Where the source has places, passages carry them:

- **Pages.** The PDF ladder keeps a page break (form feed, `\f`) between
  pages. The chunker never lets a passage cross one, and each passage gets
  `page` as well as its character range. A plan item's page range then reads
  exactly those pages.
- Time, slides and cells keep their locator fields; no ladder emits their
  boundaries in the text yet, so they stay as before.

## Reading: map, parts, budgets

`sources/reading.ts` is the one place that decides what part of an item's
passages a call reads. It knows nothing about the kind of source or its
subject.

- **Parts.** An item's passages fall into parts of about 8,000 characters, in
  order, never splitting a page when passages have pages. Structure comes from
  the source (pages) when it has any and from the text's own length when it
  does not.
- **Map.** A map lists every part: its passage labels (P12–P19), its pages
  when known, its size and a short preview of its opening. A map of a source
  at the bound fits in about 12,000 characters.
- **Spread.** When passages must fit a budget smaller than them, a spread
  takes passages evenly across all of them, so every part is represented,
  instead of the first ones.

A call that would read 24,000 characters or less of passages reads them all,
exactly as before. Above that:

| Maker step | Reads |
|---|---|
| Byte plan (sections) | the map, not the passages. Each section names the passage range it covers, and together the sections cover every passage: a section without a usable range gets the next uncovered run in order, and anything still uncovered joins its neighbour. At deep depth, about one section per 12,000 characters. |
| Byte section | its own range, all of it when it fits 24,000 characters, else a spread of it. |
| Byte research | a spread of 24,000 characters (it used to read the whole text). |
| Byte bit repair | the passages the bit cites (unchanged). |
| Quiz plan | a spread of 48,000 characters across everything the item covers; the prompt says it is a sample. |
| Quiz write, review, repair | the passages each question tests (unchanged). |
| Chat answer | BM25 over every passage of every source in the turn (unchanged; it now sees the whole source). |
| Planner | `SourceMap` over every passage, grouped to fit its budget (unchanged). |

Labels (P1, P2, …) are numbered over all of the item's passages, whatever a
call is shown, so a cite resolves to the same passage in every step, and the
quote check runs against that passage's stored text.

A plan item with a range reads only the passages inside it (`chunksInRange`),
and all of the above applies inside the range.

## Cost

`estimateCost` already receives the characters an item reads after its
range. The estimators now price what the engine reads:

- Byte: the plan reads the map (or all passages when short). Sections read
  their share of the source, at most 24,000 characters each. At deep depth a
  long source gets a section per about 12,000 characters (10,000 at very
  deep; `LONG_SECTION_CHARS`), so a whole-book deep byte is priced as reading
  and teaching the whole book; a light byte of a book reads a spread and is
  priced so. Real runs showed a deep section writes about 7k tokens whatever
  its share, so a smaller share only adds calls.
- Quiz: the plan reads at most 48,000 characters; writing reads only tested
  passages.

## Old sources

Extractions stored before this keep their cut text, their chunks and their
limitation, and are not re-read: their chunk ids are what existing outputs
cite, and re-reading would replace them and fetch the link again. They keep
working as before, honestly marked as cut. A source added after this change
is stored whole. Re-reading an old cut source on request is an open decision
(see the hand-over note).

## What still cannot be covered

Above the bound, a PDF with no text layer, a video with only its title, and a
page behind a login are said so in the source's limitations, as before.
