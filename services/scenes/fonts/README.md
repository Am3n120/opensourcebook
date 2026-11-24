# Fonts

Every font a drawn video uses ships here, so a scene measures and looks the same on any computer. A style names families (`styles/<name>.json`, its `fonts` and `render.type` lines); the engine finds the files here. Measuring (`engine/kits/text-browser.ts`) and drawing (`engine/style/load-fonts.ts`, loaded by both Remotion entries) load these same files, and nothing is left to the fonts a computer has installed. A style that names a family with no folder here fails with what to add.

All are under the SIL Open Font License 1.1, except Permanent Marker, under the Apache License 2.0. Each folder keeps its licence text beside the files, unchanged.

| Folder | Family | Files (weights) | Used by | Source |
| --- | --- | --- | --- | --- |
| `cabin-sketch` | Cabin Sketch | Regular 400, Bold 700 | chalkboard titles | Google Fonts repository, `ofl/cabinsketch` |
| `comic-neue` | Comic Neue | Regular 400, Bold 700, drawn at 106% | chalkboard and comic words | `ofl/comicneue` |
| `caveat-brush` | Caveat Brush | Regular 400, drawn at 120% (`sizeAdjust`) | whiteboard | `ofl/caveatbrush` |
| `barlow-condensed` | Barlow Condensed | SemiBold 600 | blueprint titles | `ofl/barlowcondensed` |
| `barlow` | Barlow | SemiBold 600, Bold 700 | kinetic type, documentary and map and timeline words | `ofl/barlow` |
| `libre-caslon-display` | Libre Caslon Display | Regular 400 | ink, collage, documentary and map and timeline titles | `ofl/librecaslondisplay` |
| `jost` | Jost | variable, 100 to 900, drawn at 105% | collage words | `ofl/jost` |
| `mulish` | Mulish | variable, 200 to 1000 | flat, ink, neon; the default for a style that names no font | `ofl/mulish` |
| `baskervville` | Baskervville | variable, 400 to 700 | textbook plate | `ofl/baskervville` |
| `pt-mono` | PT Mono | Regular 400 | code in every style | `ofl/ptmono` |
| `archivo-black` | Archivo Black | Regular, used as 900 | captions over pictures, kinetic type titles | `ofl/archivoblack` |
| `permanent-marker` | Permanent Marker | Regular 400 | sketchnote titles | `apache/permanentmarker` (Apache License 2.0) |
| `patrick-hand` | Patrick Hand | Regular 400 | sketchnote words | `ofl/patrickhand` |
| `bangers` | Bangers | Regular 400 | comic titles | `ofl/bangers` |
| `jetbrains-mono` | JetBrains Mono | variable, 100 to 800 | terminal, all its words | `ofl/jetbrainsmono` |
| `fallback` | Open Sourcebook Fallback | three cut-down Noto faces | behind every style's own fonts | `ofl/notosans`, `ofl/notosansmath`, `ofl/notosanssymbols2` |

Sources are folders of https://github.com/google/fonts (main branch, November 2026). The files are byte for byte as published there, except in `fallback`: those are Noto Sans (width fixed at normal, weight kept variable), Noto Sans Math and Noto Sans Symbols 2, each cut down with fontTools `pyftsubset` to the characters in its `unicodeRange` (accented Latin, Greek, Cyrillic, punctuation, sub- and superscripts, currency; arrows and maths; ticks, crosses and shapes). Noto declares no reserved font name. They exist so a symbol the style's font lacks (→, ≤, ✓, ₂) comes from a shipped file too.

About 3.3 MB in all.

## Adding a font

1. Make a folder named after the family, in lower case with dashes.
2. Put in the font files (`.ttf`, `.otf`, `.woff`, `.woff2`; a variable font when there is one, otherwise only the weights a style uses) and the licence text. Only the SIL Open Font License or Apache 2.0.
3. Write `font.json`:

   ```json
   {
     "family": "Some Face",
     "licence": "SIL Open Font License 1.1",
     "licenceFiles": ["OFL.txt"],
     "source": "where the files came from",
     "faces": [
       { "file": "SomeFace-Regular.ttf", "weight": 400 },
       { "file": "SomeFace[wght].ttf", "weight": [100, 900] }
     ]
   }
   ```

   A face may also have `"style": "italic"`, a `"unicodeRange"`, and a `"sizeAdjust"` (such as `"115%"`) for a face drawn small for its size, so it reads at the size the layout plans. `"serves"` marks the family as the `fallback` behind every style, the `default` for a style that names no font, or the `mono` code font.
4. Name the family in a style's `fonts` and `render.type` lines, ending each stack in a generic name: `"\"Some Face\", sans-serif"`.

`npm test` checks every folder: the licence, the files, and that each style's fonts resolve here.
