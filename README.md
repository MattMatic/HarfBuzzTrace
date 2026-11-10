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
  hb-loader.mjs     — selectable HarfBuzz WASM engines, font lifecycle, glyph names
  trace-parser.mjs  — converts raw shapeWithTrace[] → LookupGroup[]
  renderer.mjs      — DOM builder for trace list + hover grid
serve.mjs           — minimal Node.js static file server
```

## HarfBuzz version

The **Engine** drop-down in the header selects which harfbuzzjs build (and therefore which HarfBuzz version) does the shaping. Switching re-loads the current font into the new engine and re-shapes the current word, so you can step through versions to find where output changes. The badge shows the HarfBuzz version the loaded build reports. The choice is kept in the URL, e.g. `?hb=0.4.15`, so a particular engine can be shared as a link; any published harfbuzzjs version number works there, not only the ones in the list.

Builds are loaded from the jsDelivr CDN on demand (WASM is ~0.4–2 MB, cached by the browser). Use `?cdn=<base-url>` to load from a self-hosted mirror laid out as `<base>/harfbuzzjs@<version>/...`.

| harfbuzzjs | HarfBuzz | Loader |
|---|---|---|
| 0.3.6 | about 9.0 — this build does not report its version | legacy: native `hbjs_shape_with_trace` export |
| 0.4.2 – 0.4.15 | 10.0.0 → 12.3.0 | emscripten: trace via `hb_buffer_set_message_func` |
| 0.10.0 – 0.10.3 | 12.3.2 → 14.0.0 | emscripten |
| 1.2.0 – 1.6.4 *(default: 1.6.4)* | 14.2.0 → 15.0.0 | ES module, class API |

Where several harfbuzzjs releases share a HarfBuzz version, the latest is listed. harfbuzzjs 0.4.8 is not offered (it fails to initialise). Note that **harfbuzzjs 0.3.6 is not HarfBuzz 12.3.0** — HarfBuzz 12.3.0 is harfbuzzjs 0.4.15.

## Notes

- Tracing uses the buffer message callback, which every listed build supports (0.3.6 through a native export, newer builds through `hb_buffer_set_message_func`).
- Lookups that fire but produce no change (skipped, no glyph matches) are suppressed.
- Orphaned recursive lookup entries (no closing `recursed to lookup` message) are suppressed silently — this is a known HarfBuzz trace bug.
- `end table GSUB/GPOS` clears the lookup stack to handle any missed `end lookup` messages.
