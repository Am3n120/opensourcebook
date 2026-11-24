# Guide payload

**This file is the contract.** It is the shape of `payload` for an output of
format `guide`, schema version 1, and of the change a person sends when they
edit one by hand. The engine writes it, its checks run over it, and the web
(and later the phone) draw it. A change here is a change for every client;
it gets a new schema version, never a silent edit.

## In one paragraph

A guide is the fifth thing Open Sourcebook makes, beside video, flashcards, quiz and
audio: a page or a few of notes the person keeps, prints, looks things up in
and changes by hand afterwards. A reference, not a lesson. It is an ordered
list of **sections**, each a heading and a list of **points**. A point is one
claim, definition, step or formula, with an optional **term** shown first,
and the passages it rests on (each cite quoted word for word, checked like
every other made thing); or it is **background**, the maker's own
explanation, never cited and shown as such; or it is the person's own,
written or changed by hand. The person's own agent writes it in one turn.
How many sections and points it has and how long it runs come from the
sources, the brief and the item's `pages` setting, never from a count in
code.

## Where it appears

| Where | What |
|---|---|
| `GET /v1/outputs/:id` | `output.type` is `"guide"`, `output.schemaVersion` is `1`, `output.payload` is a Guide. |
| `PUT /v1/outputs/:id/payload` | The person's change by hand (below). Answers the output as kept. |
| `GET /v1/formats` | `guide` is `ready: true` when the person's agent is connected, else `ready: false` with `problem`. |
| A thread's spot | `{ "section": "s2" }`, or `{ "section": "s2", "point": "p5" }` when the person pointed at a point. |

## Guide

```json
{
  "schemaVersion": 1,
  "title": "Mitosis on one page",
  "about": "What mitosis is, its stages in order, and what goes wrong.",
  "sections": [ /* Section */ ],
  "lengthNote": "Your notes hold only two pages on mitosis, so this is half a page.",
  "editedAt": "2026-11-20T10:00:00.000Z"
}
```

- `about` is a sentence on what it covers, shown in lists.
- `lengthNote`, when present, is the maker's sentence to the person on why it
  runs clearly shorter or longer than the pages asked.
- `editedAt`, when present, is when the person last changed it by hand.

## Section

```json
{ "id": "s2", "title": "The stages, in order", "points": [ /* Point */ ] }
```

## Point

```json
{
  "id": "p5",
  "term": "Anaphase",
  "text": "Sister chromatids are pulled to **opposite poles**.",
  "background": false,
  "cites": [{ "sourceId": "…", "chunkId": "…", "locator": { "charStart": 120, "charEnd": 260 }, "quote": "the sister chromatids are pulled to opposite poles" }],
  "yours": true,
  "made": { "term": "Anaphase", "text": "Chromatids are pulled apart." }
}
```

- `term` (optional): a key word, name or formula the point is about, drawn
  first and strong.
- `text`: one point in the inline marks cards use (`flashcards.md`, "Inline
  marks"): `**bold**`, `*italic*`, `` `code` ``, `$math$`, `[label](https://…)`.
  No headings, list marks or line breaks: a list is several points.
- `background`: the maker's own explanation, not from the sources. It has no
  cites and is shown as not from the person's sources.
- `cites`: where the point comes from, at most 4; empty for background and
  for a point the person added.
- `yours`: the person wrote or changed it by hand.
- `made`: the maker's term and words, kept when the person changed them, so
  they can be put back. A point the person added has `yours` and no `made`.

Point ids are `p1`, `p2`, … across the whole guide and section ids `s1`, `s2`,
…, in reading order when it is made. They are kept as the person edits, and
a new section or point takes the next free number.

## Making it

The person's agent writes it through Open Sourcebook's tools: `plan_guide`,
`write_section`, `change_section`, `remove_section`, `read_guide` and
`finish_guide`, beside the source tools. Every point is checked when its
section is sent (its passages and quotes word for word, no cite on
background, no list or heading inside a point), and nothing of a section is
kept until all of it passes. Each kept section answers with how many pages
the guide fills so far against the pages asked, at about 450 words a page.
What makes a good guide is `skills/guide`, knowledge only.

## Changing it by hand

`PUT /v1/outputs/:id/payload` takes the whole guide as the person now has it:

```json
{
  "title": "Mitosis, my notes",
  "sections": [
    { "id": "s2", "title": "Stages", "points": [{ "id": "p5", "term": "Anaphase", "text": "Chromatids go to the poles." }, { "text": "Ask about this in class." }] },
    { "title": "My questions", "points": [{ "text": "Why four stages?" }] }
  ]
}
```

It is laid over what is kept:

- A point sent with its id and the same term and words keeps everything it
  had.
- A point whose term or words changed becomes the person's (`yours`), keeps
  its cites, which still show where the maker's words came from, and keeps
  the maker's words in `made`. Sent back with exactly the maker's words, it
  is the maker's again.
- A point or a section with no id (or an id it does not have) is new and the
  person's, with no cites. Nothing sent adds a cite.
- A section or point left out is removed; one sent with no words is removed.
  Sections and points are kept in the order sent.
- Runs of spaces and line breaks in what is typed become one space.

`400 invalid_edit` with every problem in plain sentences when it cannot be
kept (a section with no heading, a term with no words, a point too long);
nothing is changed then. The output's `citations` are written again from
the points, and its `title` from the guide's.

## Players

- **Web** (`web/src/player/GuidePlayer.tsx`): the page in a readable column:
  headings, each point with its term strong, its cites as small numbers at
  the claim (numbered across the page), and a quiet tag on a point that is
  not from the sources, that the person changed or that they wrote. The
  sources are listed by number at the end. **Print** prints only the page.
  **Change it** opens the same page as fields: the title, headings, each
  point's term and words, points and sections added, removed or moved, and
  the maker's words put back; **Save** sends it whole and shows what was
  kept, or what was wrong. Reaching the end ticks the item done.
- **Phone** (Swift, not built yet): the catalog learns the format from
  `GET /v1/formats` as it does every format; it needs a player that draws
  the sections and points, and may leave changing it to the web.
