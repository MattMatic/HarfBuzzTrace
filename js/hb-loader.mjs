/**
 * hb-loader.mjs
 * Loads HarfBuzzJS WASM (0.3.6) and wraps font/face/buffer lifecycle.
 * All HarfBuzz interaction is funnelled through this module.
 */

const WASM_URL = 'https://cdn.jsdelivr.net/npm/harfbuzzjs@0.3.6/hb.wasm';
const HBJS_URL = 'https://cdn.jsdelivr.net/npm/harfbuzzjs@0.3.6/hbjs.js';

/** @type {object|null} hbjs wrapper instance */
let hb = null;

/**
 * Raw WASM exports — needed to call hbjs_shape_with_trace directly
 * with a larger buffer than hbjs.js hardcodes (1 MB).
 * @type {object|null}
 */
let wasmExports = null;

export async function initHarfBuzz() {
  if (hb) return hb;

  if (typeof window.hbjs === 'undefined') {
    await loadScript(HBJS_URL);
  }

  const result = await WebAssembly.instantiateStreaming(fetch(WASM_URL));
  hb = window.hbjs(result.instance);
  wasmExports = result.instance.exports;
  return hb;
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(s);
  });
}

// ── Font state ────────────────────────────────────────────────────────────────

let currentFont = null;

/**
 * Debg lookup name index.
 * { GSUB: { "0": "name", ... }, GPOS: { "0": "name", ... } }
 */
let debgNames = { GSUB: {}, GPOS: {} };

/**
 * Parse the Debg table from a loaded face.
 * Raw UTF-8 JSON; feaLib block:
 *   data["com.github.fonttools.feaLib"][table][lookupIndex] = [location, name, features]
 */
function parseDebgTable(face) {
  debgNames = { GSUB: {}, GPOS: {} };
  try {
    const raw = face.reference_table('Debg');
    if (!raw || raw.length === 0) return;
    const json = JSON.parse(new TextDecoder().decode(raw));
    const feaLib = json['com.github.fonttools.feaLib'];
    if (!feaLib) return;
    for (const table of ['GSUB', 'GPOS']) {
      const entries = feaLib[table];
      if (!entries) continue;
      for (const [idxStr, value] of Object.entries(entries)) {
        if (Array.isArray(value) && typeof value[1] === 'string') {
          debgNames[table][idxStr] = value[1];
        }
      }
    }
  } catch (_) {
    // Malformed or absent Debg — silently ignore
  }
}

export function lookupDebugName(table, lookupId) {
  return debgNames[table]?.[String(lookupId)] ?? null;
}

/**
 * Parse nameID 4 (full name) and nameID 5 (version string) from the OpenType
 * name table.  Prefers platform 3 (Windows/Unicode, UTF-16BE), falls back to
 * platform 1 (Mac, Latin-1).  Returns { fullName, version } — either field may
 * be null if the record is absent.
 */
function parseFontNames(face) {
  try {
    const raw = face.reference_table('name');
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

export function loadFont(arrayBuffer) {
  if (!hb) throw new Error('HarfBuzz not initialised');

  if (currentFont) {
    currentFont.font.destroy();
    currentFont.face.destroy();
    currentFont.blob.destroy();
    currentFont = null;
  }

  const fontData = new Uint8Array(arrayBuffer);
  const blob = hb.createBlob(fontData);
  const face = hb.createFace(blob, 0);
  const font = hb.createFont(face);
  font.setScale(1000, 1000);

  parseDebgTable(face);
  const { fullName, version } = parseFontNames(face);

  currentFont = { blob, face, font };
  return { ...currentFont, fullName, version };
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
  if (!hb)          throw new Error('HarfBuzz not initialised');
  if (!currentFont) throw new Error('No font loaded');

  const { font } = currentFont;
  const exp = wasmExports;
  const utf8Dec = new TextDecoder('utf8');

  const buffer = hb.createBuffer();
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
    if (direction === 'ltr') buffer.setDirection('ltr');
    else if (direction === 'rtl') buffer.setDirection('rtl');

    // 4. Allocate trace buffer.
    //    Re-snapshot heapu8 AFTER each malloc — if any prior operation caused
    //    memory layout changes, the view must point to the current buffer.
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
    // Fresh view after all mallocs are done
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
    // Re-snapshot the view here too — belt-and-suspenders.
    const json = utf8Dec.decode(
      new Uint8Array(exp.memory.buffer).subarray(traceBuffer, traceBuffer + traceLen - 1)
    );
    exp.free(traceBuffer);

    return JSON.parse(json);
  } finally {
    buffer.destroy();
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
export function getHb()    { return hb; }
