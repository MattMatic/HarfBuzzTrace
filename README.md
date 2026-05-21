# HarfBuzz Trace

A client-side debug tool for inspecting HarfBuzz shaping — which lookups fire, what GSUB substitutions occur, and how GPOS adjusts glyph positions.

> Written by Claude with some details learned from my prior dev work 😄

## Requirements

- A modern browser (Chrome, Firefox, Safari, Edge)
- A TTF or OTF font file to inspect

## Start

Use the link https://mattmatic.github.io/HarfBuzzTrace/

## Usage

1. Drop a TTF/OTF file onto the drop zone (or click it)
2. Type a word in the **Word** field
3. Press **Enter** or click **Shape**
4. Hover any trace row to see the full buffer glyph state in the grid panel

### Controls

| Field | Description |
|-------|-------------|
| Word | The text to shape |
| Script | OpenType script tag (e.g. `Latn`, `Arab`, `Deva`) |
| Language | BCP47/OT language tag (e.g. `en`, `ara`, `hin`) |
| Tables | Filter to GSUB + GPOS / GSUB only / GPOS only |

## Trace output

Each row shows one fired shaping action:

**GSUB** (green)
- `LIGATE` — glyph sequence collapsed to ligature: `'f', 'i'` → `'fi'`
- `REPLACE` — single substitution: `'a.init'` → `'a.medi'`
- `MULTIPLY` — one glyph expanded to several
- `DELETE` — glyph removed

**GPOS** (amber)
- `KERN` — pair advance adjustment: `'A' ax:-40`
- `POSITION` — single glyph placement
- `ATTACH` — mark-to-base / cursive attachment

Hover any row to see the full glyph buffer (glyph ID, name, cluster, ax/ay/dx/dy) at the moment the action was applied. Changed cells are highlighted amber.

## Architecture

```
index.html          — single-page shell
style.css           — light minimal debug theme
js/
  main.mjs          — UI wiring, event handlers, shape pipeline
  hb-loader.mjs     — HarfBuzz WASM init, font lifecycle, glyph names
  trace-parser.mjs  — converts raw shapeWithTrace[] → LookupGroup[]
  renderer.mjs      — DOM builder for trace list + hover grid
serve.mjs           — minimal Node.js static file server
```

## HarfBuzz version

Uses **harfbuzzjs 0.3.6** (HarfBuzz 12.3.0) loaded from jsDelivr CDN.
Requires an internet connection on first load (WASM is ~2MB, cached by browser).

## Notes

- The trace feature requires a HarfBuzz build with `HB_DEBUG_SHAPE` enabled — the harfbuzzjs 0.3.6 build includes this.
- Lookups that fire but produce no change (skipped, no glyph matches) are suppressed.
- Orphaned recursive lookup entries (no closing `recursed to lookup` message) are suppressed silently — this is a known HarfBuzz trace bug.
- `end table GSUB/GPOS` clears the lookup stack to handle any missed `end lookup` messages.
