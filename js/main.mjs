/**
 * main.mjs
 * Entry point. Wires together UI events, font loading, shaping, and rendering.
 */

import { initHarfBuzz, loadFont, shapeWithTrace, isLoaded } from './hb-loader.mjs';
import { parseTrace }  from './trace-parser.mjs';
import { initRenderer, renderTrace, renderCodepoints, showStatus, clearStatus, showEmpty } from './renderer.mjs';

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

function getDirection() {
  const checked = dirGroup.querySelector('input[name="direction"]:checked');
  return checked ? checked.value : 'auto';
}

// ── Initialise ────────────────────────────────────────────────────────────────

initRenderer();
shapeBtn.disabled = true;

initHarfBuzz().then(() => {
  versionBadge.textContent = 'HarfBuzz 12.3.0';
  showStatus('HarfBuzz ready — drop a font to begin');
}).catch(err => {
  showStatus(`Failed to load HarfBuzz: ${err.message}`, true);
});

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
    const { fullName, version } = loadFont(buf);

    fontNameEl.textContent = file.name;
    fontMetaEl.textContent = [fullName, version].filter(Boolean).join(' · ');
    fontMetaEl.hidden = !fullName && !version;
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
    const filter   = tableFilter.value;  // 'both' | 'GSUB' | 'GPOS'
    const groups   = parseTrace(rawTrace, filter);
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
