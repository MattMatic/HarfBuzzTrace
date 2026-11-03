/**
 * main.mjs
 * Entry point. Wires together UI events, font loading, shaping, and rendering.
 */

import { initHarfBuzz, loadFont, shapeWithTrace, isLoaded, precacheGlyphPaths,
         HB_VERSIONS, DEFAULT_VERSION, getEngineInfo } from './hb-loader.mjs';
import { parseTrace }  from './trace-parser.mjs';
import { initRenderer, renderTrace, renderCodepoints, showStatus, clearStatus, showEmpty, setFontMetrics } from './renderer.mjs';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropZone     = document.getElementById('font-drop-zone');
const fileInput    = document.getElementById('font-file-input');
const fontNameEl   = document.getElementById('font-name');
const fontMetaEl   = document.getElementById('font-meta');
const wordInput    = document.getElementById('word-input');
const shapeBtn     = document.getElementById('shape-btn');
const scriptInput  = document.getElementById('script-input');
const langInput    = document.getElementById('lang-input');
const dirGroup     = document.getElementById('direction-group');
const tableFilter  = document.getElementById('table-filter');
const versionBadge = document.getElementById('hb-version');
const versionSel   = document.getElementById('hb-version-select');

function getDirection() {
  const checked = dirGroup.querySelector('input[name="direction"]:checked');
  return checked ? checked.value : 'auto';
}

// ── Initialise ────────────────────────────────────────────────────────────────

initRenderer();
shapeBtn.disabled = true;

// ── HarfBuzz engine selection ────────────────────────────────────────────────
// ?hb=<harfbuzzjs version> picks the build (e.g. ?hb=0.4.15) and is kept in
// the URL so a particular engine can be shared or bisected via links.

function hbLabel(v) {
  return `HarfBuzz ${v.hb}  ·  harfbuzzjs ${v.id}`;
}

function buildVersionSelect(selectedId) {
  versionSel.textContent = '';
  const known = HB_VERSIONS.some(v => v.id === selectedId);
  const list  = known ? HB_VERSIONS : [...HB_VERSIONS, { id: selectedId, hb: '?' }];
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = hbLabel(v);
    versionSel.appendChild(o);
  }
  versionSel.value = selectedId;
}

function updateBadge() {
  const info = getEngineInfo();
  if (!info) { versionBadge.textContent = ''; return; }
  versionBadge.textContent = info.hbVersion
    ? `HarfBuzz ${info.hbVersion}`
    : `harfbuzzjs ${info.id}`;
  versionBadge.title = `harfbuzzjs ${info.id} (${info.kind} loader)`;
}

function setUrlVersion(id) {
  try {
    const u = new URL(location.href);
    if (id === DEFAULT_VERSION) u.searchParams.delete('hb');
    else u.searchParams.set('hb', id);
    history.replaceState(null, '', u);
  } catch (_) {}
}

/** Load a build, re-load the current font into it, re-shape. */
async function selectEngine(id) {
  const previous = getEngineInfo()?.id ?? null;
  versionSel.disabled = true;
  shapeBtn.disabled = true;
  showStatus(`Loading harfbuzzjs ${id}…`);
  try {
    const { font } = await initHarfBuzz(id);
    updateBadge();
    setUrlVersion(id);
    if (font) setFontMetrics(font.metrics);
    shapeBtn.disabled = !isLoaded();
    showStatus(`HarfBuzz ${getEngineInfo().hbVersion ?? ('(harfbuzzjs ' + id + ')')} ready` +
               (isLoaded() ? '' : ' — drop a font to begin'));
    const word = wordInput.value.trim();
    if (word && isLoaded()) runShape(word);
  } catch (err) {
    console.error(err);
    if (previous) versionSel.value = previous;      // previous engine is still active
    shapeBtn.disabled = !isLoaded();
    showStatus(`Failed to load harfbuzzjs ${id}: ${err.message}`, true);
  } finally {
    versionSel.disabled = false;
  }
}

{
  const requested = new URLSearchParams(location.search).get('hb') || DEFAULT_VERSION;
  buildVersionSelect(requested);
  selectEngine(requested);
}

versionSel.addEventListener('change', () => selectEngine(versionSel.value));

// ── Font drop zone ────────────────────────────────────────────────────────────

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click();
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFontFile(file);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) handleFontFile(file);
  fileInput.value = '';
});

async function handleFontFile(file) {
  if (!file.name.match(/\.(ttf|otf)$/i)) {
    showStatus('Please drop a .ttf or .otf file', true);
    return;
  }

  try {
    clearStatus();
    const buf = await file.arrayBuffer();
    const { fullName, version, metrics } = loadFont(buf);

    fontNameEl.textContent = file.name;
    fontMetaEl.textContent = [fullName, version].filter(Boolean).join(' · ');
    fontMetaEl.hidden = !fullName && !version;
    setFontMetrics(metrics);
    dropZone.classList.add('loaded');
    shapeBtn.disabled = false;
    showStatus(`Loaded: ${file.name}`);

    // Auto-shape if word already present
    const word = wordInput.value.trim();
    if (word) runShape(word);
  } catch (err) {
    showStatus(`Font load error: ${err.message}`, true);
  }
}

// ── Shape trigger ─────────────────────────────────────────────────────────────

shapeBtn.addEventListener('click', () => {
  const word = wordInput.value.trim();
  if (!word) { showStatus('Enter a word first', true); return; }
  runShape(word);
});

wordInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const word = wordInput.value.trim();
    if (word && isLoaded()) runShape(word);
  }
});

// Update codepoints live as user types
wordInput.addEventListener('input', () => {
  renderCodepoints(wordInput.value);
});

// Filter change re-shapes if font+word ready
tableFilter.addEventListener('change', () => {
  const word = wordInput.value.trim();
  if (word && isLoaded()) runShape(word);
});

// Direction change re-shapes if font+word ready
dirGroup.addEventListener('change', () => {
  const word = wordInput.value.trim();
  if (word && isLoaded()) runShape(word);
});

// ── Core shaping pipeline ─────────────────────────────────────────────────────

function runShape(word) {
  if (!isLoaded()) {
    showStatus('Load a font first', true);
    return;
  }

  clearStatus();

  try {
    const rawTrace = shapeWithTrace(word, scriptInput.value, langInput.value, getDirection());
    const filter   = tableFilter.value;
    const groups   = parseTrace(rawTrace, filter);

    // Collect all unique glyph IDs across all groups for pre-caching
    const gids = new Set();
    for (const group of groups) {
      for (const row of group.rows) {
        for (const buf of [row.before, row.after]) {
          if (buf) buf.forEach(g => g?.g != null && gids.add(g.g));
        }
      }
    }
    precacheGlyphPaths(gids);

    renderTrace(groups);

    const total = groups.reduce((s, g) => s + g.rows.length, 0);
    showStatus(
      total === 0
        ? 'Shaped — no active lookups for this word/font combination'
        : `Shaped — ${total} action${total !== 1 ? 's' : ''} across ${groups.length} lookup${groups.length !== 1 ? 's' : ''}`
    );
  } catch (err) {
    showStatus(`Shape error: ${err.message}`, true);
    showEmpty(`error: ${err.message}`);
    console.error(err);
  }
}
