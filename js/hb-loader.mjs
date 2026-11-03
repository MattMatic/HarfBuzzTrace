/**
 * hb-loader.mjs
 * Loads a selectable harfbuzzjs build (WASM) and wraps font/face/buffer lifecycle.
 * All HarfBuzz interaction is funnelled through this module.
 *
 * harfbuzzjs has three incompatible packaging/API generations, each handled
 * by an adapter below:
 *
 *   legacy  0.3.x        hbjs.js + standalone hb.wasm. Tracing is a native WASM
 *                        export (hbjs_shape_with_trace) - the only build that has it.
 *   emcc    0.4.x-0.10.x hbjs.js + emscripten hb.js + hb.wasm. Tracing is done in JS
 *                        through hb_buffer_set_message_func.
 *   esm     1.x          ES-module package (dist/index.mjs), class based API.
 *
 * All three produce the same trace entry shape: { m, t, glyphs }.
 */

/**
 * Selectable builds. `hb` is the HarfBuzz version the build reports at runtime
 * (measured with hb_version_string()); 0.3.6 does not export that function.
 * When several harfbuzzjs releases share one HarfBuzz version, the latest is listed.
 */
export const HB_VERSIONS = [
  { id: '0.3.6',  hb: '~9.0 (not reported)' },
  { id: '0.4.2',  hb: '10.0.0' },
  { id: '0.4.3',  hb: '10.1.0' },
  { id: '0.4.4',  hb: '10.2.0' },
  { id: '0.4.5',  hb: '10.4.0' },
  { id: '0.4.6',  hb: '11.0.0' },
  { id: '0.4.7',  hb: '11.0.1' },
  { id: '0.4.9',  hb: '11.4.1' },
  { id: '0.4.10', hb: '11.4.4' },
  { id: '0.4.11', hb: '11.4.5' },
  { id: '0.4.12', hb: '11.5.0' },
  { id: '0.4.13', hb: '12.0.0' },
  { id: '0.4.14', hb: '12.2.0' },
  { id: '0.4.15', hb: '12.3.0' },
  { id: '0.10.0', hb: '12.3.2' },
  { id: '0.10.2', hb: '13.2.1' },
  { id: '0.10.3', hb: '14.0.0' },
  { id: '1.2.0',  hb: '14.2.0' },
  { id: '1.4.0',  hb: '14.2.1' },
  { id: '1.6.0',  hb: '14.3.0' },
  { id: '1.6.1',  hb: '14.4.0' },
  { id: '1.6.2',  hb: '14.5.0' },
  { id: '1.6.3',  hb: '14.6.0' },
  { id: '1.6.4',  hb: '15.0.0' },
];

/** Build used when none is requested (unchanged from previous releases). */
export const DEFAULT_VERSION = '0.3.6';

/**
 * Base URL of an npm CDN laid out like jsDelivr (`<base>/harfbuzzjs@<ver>/<file>`).
 * Override with ?cdn=<url> to self-host or test offline.
 */
const CDN_BASE = (() => {
  try {
    const c = new URLSearchParams(location.search).get('cdn');
    if (c) return c.replace(/\/+$/, '');
  } catch (_) {}
  return 'https://cdn.jsdelivr.net/npm';
})();

const pkgUrl = (ver, file) => `${CDN_BASE}/harfbuzzjs@${ver}/${file}`;

/** 'legacy' | 'emcc' | 'esm' from a harfbuzzjs version string. */
function engineKind(ver) {
  const m = /^(\d+)\.(\d+)/.exec(ver);
  if (!m) throw new Error(`Unrecognised harfbuzzjs version "${ver}"`);
  const major = +m[1], minor = +m[2];
  if (major >= 1) return 'esm';
  return minor <= 3 ? 'legacy' : 'emcc';
}

async function fetchChecked(url, as) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
  return as === 'text' ? r.text() : r.arrayBuffer();
}

/**
 * Evaluate a CommonJS/UMD-style script in an isolated function scope so that
 * several harfbuzzjs versions never fight over globals (`hbjs`, `Module`, ...).
 * `fallbackName` is a top-level identifier to return if the script did not
 * assign module.exports.
 */
function evalScript(code, fallbackName) {
  const module = { exports: {} };
  const fn = new Function('module', 'exports',
    `${code}\n;return (typeof module.exports === 'function' || Object.keys(module.exports).length)` +
    ` ? module.exports : (typeof ${fallbackName} !== 'undefined' ? ${fallbackName} : undefined);`);
  const out = fn(module, module.exports);
  if (!out) throw new Error('Script did not export a HarfBuzz factory');
  return out;
}

/**
 * Engine = {
 *   id, kind, hbVersion,                     // identity
 *   api:      hbjs-style object (createBlob/createFace/createFont/createBuffer) or
 *             null for esm
 *   newBlob/newFace/newFont/newBuffer        // uniform constructors
 *   trace(font, buffer)                      // -> raw trace array
 * }
 */
const engines = new Map();       // harfbuzzjs version -> Engine
let engine = null;               // active engine

/** Legacy/emcc: hbjs-style API object -> uniform engine. */
function wrapHbjs(id, kind, hbjsApi, wasmExports) {
  let hbVersion = null;
  try { if (hbjsApi.version_string) hbVersion = hbjsApi.version_string(); } catch (_) {}
  return {
    id, kind, hbVersion, wasmExports,
    newBlob:   bytes => hbjsApi.createBlob(bytes),
    newFace:   blob  => hbjsApi.createFace(blob, 0),
    newFont:   face  => hbjsApi.createFont(face),
    newBuffer: ()    => hbjsApi.createBuffer(),
    refTable:  (face, tag) => face.reference_table(tag),
    dirLTR: 'ltr', dirRTL: 'rtl',
    trace: (font, buffer) => hbjsApi.shapeWithTrace(font, buffer, '', 0, 0),
  };
}

async function loadLegacy(id) {
  const [src, wasm] = await Promise.all([
    fetchChecked(pkgUrl(id, 'hbjs.js'), 'text'),
    fetchChecked(pkgUrl(id, 'hb.wasm')),
  ]);
  const hbjsFactory = evalScript(src, 'hbjs');
  const { instance } = await WebAssembly.instantiate(wasm);
  const api = hbjsFactory(instance);
  const eng = wrapHbjs(id, 'legacy', api, instance.exports);
  // Native trace export; larger buffer than hbjs.js hardcodes (see TRACE_BUF_SIZE)
  eng.trace = (font, buffer) => nativeTrace(eng.wasmExports, font, buffer);
  return eng;
}

async function loadEmcc(id) {
  const [hbSrc, hbjsSrc, wasm] = await Promise.all([
    fetchChecked(pkgUrl(id, 'hb.js'), 'text'),
    fetchChecked(pkgUrl(id, 'hbjs.js'), 'text'),
    fetchChecked(pkgUrl(id, 'hb.wasm')),
  ]);
  const createHarfBuzz = evalScript(hbSrc, 'Module');
  const hbjsFactory    = evalScript(hbjsSrc, 'hbjs');
  const Module = await createHarfBuzz({
    wasmBinary: wasm,
    locateFile: f => pkgUrl(id, f),
  });
  const api = hbjsFactory(Module);
  return wrapHbjs(id, 'emcc', api, Module.wasmExports);
}

async function loadEsm(id) {
  const m = await import(/* webpackIgnore: true */ pkgUrl(id, 'dist/index.mjs'));
  const LTR = 4, RTL = 5;      // hb_direction_t
  return {
    id, kind: 'esm',
    hbVersion: m.versionString ? m.versionString() : null,
    wasmExports: null,
    newBlob:   bytes => new m.Blob(bytes),
    newFace:   blob  => new m.Face(blob, 0),
    newFont:   face  => new m.Font(face),
    newBuffer: ()    => new m.Buffer(),
    refTable:  (face, tag) => face.referenceTable(tag),
    dirLTR: LTR, dirRTL: RTL,
    trace: (font, buffer) => m.shapeWithTrace(font, buffer, [], 0, 0),
  };
}

/** Load (or fetch from cache) an engine without activating it. */
async function getEngine(id) {
  if (engines.has(id)) return engines.get(id);
  const kind = engineKind(id);
  const eng = await (kind === 'legacy' ? loadLegacy(id)
                   : kind === 'emcc'   ? loadEmcc(id)
                   :                     loadEsm(id));
  engines.set(id, eng);
  return eng;
}

/** Release a wrapper object if its API has an explicit destroy (esm uses GC). */
function release(obj) {
  try { if (obj && typeof obj.destroy === 'function') obj.destroy(); } catch (_) {}
}

/**
 * Load a harfbuzzjs build and make it the active engine.
 * If a font is already loaded it is re-created in the new engine from the
 * original bytes, so the caller can simply re-shape.
 * @returns {{ id: string, hbVersion: string|null, font: object|null }}  font = loadFont() result if one was reloaded
 */
export async function initHarfBuzz(id = DEFAULT_VERSION) {
  if (engine && engine.id === id) return { id, hbVersion: engine.hbVersion, font: null };

  const next = await getEngine(id);      // throws before touching current state

  if (currentFont) {
    release(currentFont.font); release(currentFont.face); release(currentFont.blob);
    currentFont = null;
  }
  engine = next;
  const font = lastFontBuffer ? loadFont(lastFontBuffer) : null;
  return { id, hbVersion: engine.hbVersion, font };
}

export function getEngineInfo() {
  return engine ? { id: engine.id, kind: engine.kind, hbVersion: engine.hbVersion } : null;
}

// ── Font state ────────────────────────────────────────────────────────────────

let currentFont = null;

/**
 * Debg lookup index.
 * { GSUB: { "0": { name, location }, ... }, GPOS: { ... } }
 * location is the feaLib source reference stripped to "filename:line:col",
 * or null if absent.
 */
let debgNames = { GSUB: {}, GPOS: {} };

/**
 * Strip a feaLib source location to "filename:line:col".
 * Input examples: "<features>:3:5"  "/path/to/font.fea:12:1"
 * Output:         "<features>:3:5"  "font.fea:12:1"
 */
function stripLocation(loc) {
  if (!loc || typeof loc !== 'string') return null;
  // Split on '/' or '\', take the last component (which includes :line:col)
  const last = loc.split(/[/\\]/).pop();
  return last || null;
}

function parseDebgTable(face) {
  debgNames = { GSUB: {}, GPOS: {} };
  try {
    const raw = engine.refTable(face, 'Debg');
    if (!raw || raw.length === 0) return;
    const json = JSON.parse(new TextDecoder().decode(raw));
    const feaLib = json['com.github.fonttools.feaLib'];
    if (!feaLib) return;
    for (const table of ['GSUB', 'GPOS']) {
      const entries = feaLib[table];
      if (!entries) continue;
      for (const [idxStr, value] of Object.entries(entries)) {
        if (Array.isArray(value) && typeof value[1] === 'string') {
          debgNames[table][idxStr] = {
            name:     value[1],
            location: stripLocation(value[0]),
          };
        }
      }
    }
  } catch (_) {
    // Malformed or absent Debg — silently ignore
  }
}

/** Returns { name, location } or null. */
export function lookupDebugInfo(table, lookupId) {
  return debgNames[table]?.[String(lookupId)] ?? null;
}

/** Convenience — name string only, or null. */
export function lookupDebugName(table, lookupId) {
  return debgNames[table]?.[String(lookupId)]?.name ?? null;
}

/**
 * Parse nameID 4 (full name) and nameID 5 (version string) from the OpenType
 * name table.  Prefers platform 3 (Windows/Unicode, UTF-16BE), falls back to
 * platform 1 (Mac, Latin-1).  Returns { fullName, version } — either field may
 * be null if the record is absent.
 */
function parseFontNames(face) {
  try {
    const raw = engine.refTable(face, 'name');
    if (!raw || raw.length < 6) return { fullName: null, version: null };

    const view       = new DataView(raw.buffer, raw.byteOffset);
    const count      = view.getUint16(2);
    const strOffset  = view.getUint16(4);

    // Collect candidates keyed by nameID; prefer platformID 3 over 1
    const candidates = {};   // nameID -> { platformID, str }

    for (let i = 0; i < count; i++) {
      const base       = 6 + i * 12;
      const platformID = view.getUint16(base + 0);
      const nameID     = view.getUint16(base + 6);
      const length     = view.getUint16(base + 8);
      const offset     = view.getUint16(base + 10);

      if (nameID !== 4 && nameID !== 5) continue;

      // Accept platform 3 (Windows) or platform 0 (Unicode) or platform 1 (Mac)
      if (platformID !== 0 && platformID !== 1 && platformID !== 3) continue;

      // Skip if we already have a platform-3 record for this nameID
      if (candidates[nameID]?.platformID === 3 && platformID !== 3) continue;

      const strBytes = raw.slice(strOffset + offset, strOffset + offset + length);
      const str = (platformID === 3 || platformID === 0)
        ? new TextDecoder('utf-16be').decode(strBytes)
        : new TextDecoder('latin1').decode(strBytes);

      if (str.trim()) candidates[nameID] = { platformID, str: str.trim() };
    }

    return {
      fullName: candidates[4]?.str ?? null,
      version:  candidates[5]?.str ?? null,
    };
  } catch (_) {
    return { fullName: null, version: null };
  }
}

/** Original font bytes, kept so the font can be re-created when the engine changes. */
let lastFontBuffer = null;

export function loadFont(arrayBuffer) {
  if (!engine) throw new Error('HarfBuzz not initialised');

  if (currentFont) {
    release(currentFont.font);
    release(currentFont.face);
    release(currentFont.blob);
    currentFont = null;
  }

  // Clear both caches — new font means new outlines and new advances
  glyphPathCache.clear();
  glyphAdvanceCache.clear();

  lastFontBuffer = arrayBuffer;
  const fontData = new Uint8Array(arrayBuffer);
  const blob = engine.newBlob(fontData);
  const face = engine.newFace(blob);
  const font = engine.newFont(face);
  font.setScale(1000, 1000);

  parseDebgTable(face);
  buildAdvanceCache(face);
  const { fullName, version } = parseFontNames(face);
  const metrics = parseFontMetrics(face);

  currentFont = { blob, face, font };
  return { ...currentFont, fullName, version, metrics };
}

// ── Font metrics ──────────────────────────────────────────────────────────────

/**
 * Read unitsPerEm (head table) and typo ascender/descender (OS/2 table).
 * Used to compute SVG viewport and Y-flip transform.
 */
function parseFontMetrics(face) {
  let unitsPerEm = 1000, ascender = 800, descender = -200;
  try {
    const head = engine.refTable(face, 'head');
    if (head && head.length >= 20) {
      const v = new DataView(head.buffer, head.byteOffset);
      unitsPerEm = v.getUint16(18);
    }
  } catch (_) {}
  try {
    const os2 = engine.refTable(face, 'OS/2');
    if (os2 && os2.length >= 72) {
      const v = new DataView(os2.buffer, os2.byteOffset);
      ascender  =  v.getInt16(68);
      descender =  v.getInt16(70);
    }
  } catch (_) {}
  return { unitsPerEm, ascender, descender };
}

export function getFontMetrics() {
  return currentFont ? parseFontMetrics(currentFont.face) : null;
}

// ── Glyph advance cache (from hmtx) ──────────────────────────────────────────
//
// Used during GSUB-phase SVG rendering when HarfBuzz ax=0 (not yet positioned).
// Cleared and rebuilt on every font load.

const glyphAdvanceCache = new Map();   // gid -> advance width in design units

function buildAdvanceCache(face) {
  glyphAdvanceCache.clear();
  try {
    const hhea = engine.refTable(face, 'hhea');
    if (!hhea || hhea.length < 36) return;
    const numberOfHMetrics = new DataView(hhea.buffer, hhea.byteOffset).getUint16(34);

    const hmtx = engine.refTable(face, 'hmtx');
    if (!hmtx) return;
    const hmtxView = new DataView(hmtx.buffer, hmtx.byteOffset);

    // Determine total glyph count from maxp
    let numGlyphs = numberOfHMetrics;
    try {
      const maxp = engine.refTable(face, 'maxp');
      if (maxp && maxp.length >= 6) numGlyphs = new DataView(maxp.buffer, maxp.byteOffset).getUint16(4);
    } catch (_) {}

    // Last longHorMetric advance (used for mono-tail glyphs)
    const lastAdv = hmtxView.getUint16((numberOfHMetrics - 1) * 4);

    for (let gid = 0; gid < numGlyphs; gid++) {
      glyphAdvanceCache.set(gid,
        gid < numberOfHMetrics
          ? hmtxView.getUint16(gid * 4)
          : lastAdv
      );
    }
  } catch (_) {
    // Absent or malformed hmtx — advance cache stays empty
  }
}

/** Glyph advance from hmtx, or 0 if unavailable. */
export function getGlyphAdvance(gid) {
  return glyphAdvanceCache.get(gid) ?? 0;
}

// ── Glyph path cache ──────────────────────────────────────────────────────────
// Pre-cached per shaping call; survives across words; cleared on font load.
// Key: glyph ID (number). Value: SVG path d-string from glyphToPath.

const glyphPathCache = new Map();

/**
 * Ensure all glyph IDs in `gids` are cached, then return the cache.
 * Call this once after shaping; hover rendering reads from it directly.
 */
export function precacheGlyphPaths(gids) {
  if (!currentFont) return;
  for (const gid of gids) {
    if (!glyphPathCache.has(gid)) {
      glyphPathCache.set(gid, currentFont.font.glyphToPath(gid) || '');
    }
  }
}

export function getGlyphPath(gid) {
  return glyphPathCache.get(gid) ?? '';
}

// ── Shaping ───────────────────────────────────────────────────────────────────

/**
 * Trace buffer size: 4 MB.
 *
 * The WASM heap is fixed at 65 MB (no memory.grow allowed).  Using 32 MB left
 * less than 33 MB for the font data itself — any font larger than ~30 MB would
 * push the heap watermark past the point where a 32 MB contiguous allocation
 * is impossible, causing malloc to return 0 and the subsequent WASM write to
 * address 0 to fault with "memory access out of bounds".
 *
 * 4 MB is safe: the largest trace we have measured is 232 KB (long Arabic text,
 * complex variable font), giving a 17× safety margin while leaving 61 MB free
 * for font data.  If the buffer is still too small, hbjs_shape_with_trace returns
 * -1 and we surface a clear error rather than crashing.
 */
const TRACE_BUF_SIZE = 4 * 1024 * 1024;

/**
 * Native trace for the legacy (0.3.x) build: calls the hbjs_shape_with_trace
 * WASM export directly, with a larger buffer than hbjs.js hardcodes (1 MB).
 */
function nativeTrace(exp, font, buffer) {
  const utf8Dec = new TextDecoder('utf8');

  // Allocate trace buffer.
  // Re-snapshot the memory view AFTER each malloc — if any prior operation
  // caused memory layout changes, the view must point to the current buffer.
  const traceBuffer = exp.malloc(TRACE_BUF_SIZE);
  if (!traceBuffer) {
    throw new Error(
      'WASM heap exhausted: could not allocate trace buffer. ' +
      'The loaded font may be consuming most of the 65 MB WASM heap.'
    );
  }

  // Feature string: empty, null-terminated
  const featPtr = exp.malloc(1);
  if (!featPtr) {
    exp.free(traceBuffer);
    throw new Error('WASM heap exhausted: could not allocate feature string.');
  }
  new Uint8Array(exp.memory.buffer)[featPtr] = 0;

  let traceLen;
  try {
    traceLen = exp.hbjs_shape_with_trace(
      font.ptr, buffer.ptr, featPtr,
      0, 0,                        // stop_at, stop_phase → shape fully
      traceBuffer, TRACE_BUF_SIZE
    );
  } finally {
    exp.free(featPtr);
  }

  if (traceLen < 0) {
    exp.free(traceBuffer);
    throw new Error(
      `Trace output exceeded ${TRACE_BUF_SIZE / (1024 * 1024)} MB buffer. ` +
      'This font/text combination produces an unusually large trace.'
    );
  }

  // traceLen includes the null terminator; exclude it for JSON.parse.
  const json = utf8Dec.decode(
    new Uint8Array(exp.memory.buffer).subarray(traceBuffer, traceBuffer + traceLen - 1)
  );
  exp.free(traceBuffer);
  return JSON.parse(json);
}

/**
 * Shape text and return the raw shapeWithTrace array.
 *
 * Segment property resolution order (matches HarfBuzz best-practice):
 *   1. guessSegmentProperties()  — fills script, language, direction from Unicode
 *   2. setScript / setLanguage   — override if user supplied non-empty values
 *   3. setDirection              — override if user chose LTR or RTL explicitly
 *
 * @param {string} text
 * @param {string} script     OpenType script tag, or '' to use guessed value
 * @param {string} lang       OT/BCP47 language tag, or '' to use guessed value
 * @param {string} direction  'auto' | 'ltr' | 'rtl'
 * @returns {Array}
 */
export function shapeWithTrace(text, script, lang, direction) {
  if (!engine)      throw new Error('HarfBuzz not initialised');
  if (!currentFont) throw new Error('No font loaded');

  const { font } = currentFont;
  const buffer = engine.newBuffer();
  try {
    buffer.addText(text);

    // 1. Let HarfBuzz guess everything first
    buffer.guessSegmentProperties();

    // 2. Override script/language only if the user supplied a value
    const sc = script.trim();
    const la = lang.trim();
    if (sc) buffer.setScript(sc);
    if (la) buffer.setLanguage(la);

    // 3. Override direction if explicitly chosen
    if (direction === 'ltr') buffer.setDirection(engine.dirLTR);
    else if (direction === 'rtl') buffer.setDirection(engine.dirRTL);

    // 4. Shape with the active engine's trace implementation
    return engine.trace(font, buffer);
  } finally {
    release(buffer);
  }
}

// ── Glyph names ───────────────────────────────────────────────────────────────

export function glyphName(gid) {
  if (!currentFont) return `gid${gid}`;
  const name = currentFont.font.glyphName(gid);
  if (!name || /^gid\d+$/.test(name)) return `gid${gid}`;
  return name;
}

export function isLoaded() { return currentFont !== null; }
