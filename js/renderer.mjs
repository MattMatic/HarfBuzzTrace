/**
 * renderer.mjs
 * Builds trace list DOM, hover glyph grid, and SVG glyph preview.
 */

import { glyphName, getGlyphPath, getGlyphAdvance } from './hb-loader.mjs';
import { cpsForClusters, clusterLabel, highlight, clearHighlight } from './crossref.mjs';

// ── Element cache ─────────────────────────────────────────────────────────────
let traceList  = null;
let traceEmpty = null;
let hoverGrid  = null;
let hoverTable = null;
let svgPanel   = null;

/** Font metrics set once on font load. */
let fontMetrics = { unitsPerEm: 1000, ascender: 800, descender: -200 };

export function setFontMetrics(m) {
  if (m) fontMetrics = m;
}

export function initRenderer() {
  traceList  = document.getElementById('trace-list');
  traceEmpty = document.getElementById('trace-empty');
  hoverGrid  = document.getElementById('hover-grid');
  hoverTable = document.getElementById('hover-table');
  svgPanel   = document.getElementById('svg-panel');
}

// ── Main render entry point ───────────────────────────────────────────────────

export function renderTrace(groups) {
  traceList.innerHTML = '';
  hideRightPanel();

  if (!groups || groups.length === 0) {
    traceList.hidden = true;
    traceEmpty.hidden = false;
    traceEmpty.textContent = 'no matching trace events — lookups fired but nothing changed';
    return;
  }

  traceEmpty.hidden = true;
  traceList.hidden = false;

  for (const group of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'lookup-group';
    if (group.table === 'FINAL') groupEl.classList.add('lookup-group-final');
    groupEl.appendChild(buildLookupHeader(group));

    const isMultiRow = group.rows.length > 1;
    for (const row of group.rows) {
      groupEl.appendChild(buildEntryRow(row, isMultiRow));
    }

    traceList.appendChild(groupEl);
  }
}

// ── Lookup header ─────────────────────────────────────────────────────────────

function buildLookupHeader(group) {
  const header = document.createElement('div');
  header.className = 'lookup-header';

  // FINAL row — simple label, no badge or crumb
  if (group.table === 'FINAL') {
    const lbl = document.createElement('span');
    lbl.className = 'lookup-final-label';
    lbl.textContent = 'final output';
    header.appendChild(lbl);
    return header;
  }

  // traceIdx of first fired row — shown far left, dim
  const firstIdx = group.rows[0]?.traceIdx;
  if (firstIdx != null) {
    const idxEl = document.createElement('span');
    idxEl.className   = 'lookup-trace-idx';
    idxEl.textContent = firstIdx;
    header.appendChild(idxEl);
  }

  // Table badge
  const badge = document.createElement('span');
  badge.className = `lookup-table-badge badge-${group.table.toLowerCase()}`;
  badge.textContent = group.table;
  header.appendChild(badge);

  // Breadcrumb: current lookup first, then ancestors innermost→outermost
  header.appendChild(buildLookupCrumb(
    group.lookupId, group.feature, group.debugName, group.debugLocation, false
  ));

  const ancestors = [...(group.ancestorPath ?? [])].reverse();
  for (const anc of ancestors) {
    const sep = document.createElement('span');
    sep.className   = 'crumb-sep';
    sep.textContent = '←';
    header.appendChild(sep);
    header.appendChild(buildLookupCrumb(
      anc.lookupId, anc.feature, anc.debugName, anc.debugLocation, true
    ));
  }

  return header;
}

function buildLookupCrumb(lookupId, feature, debugName, debugLocation, dim) {
  const crumb = document.createElement('span');
  crumb.className = 'lookup-crumb' + (dim ? ' lookup-crumb-dim' : '');

  const idSpan = document.createElement('span');
  idSpan.className   = 'lookup-id';
  idSpan.textContent = `lookup ${lookupId}`;

  const featSpan = document.createElement('span');
  featSpan.className   = 'lookup-feature';
  featSpan.textContent = `'${feature}'`;

  crumb.append(idSpan, featSpan);

  if (debugName) {
    const dbgSpan = document.createElement('span');
    dbgSpan.className   = 'lookup-debug-name';
    dbgSpan.textContent = debugName;
    if (debugLocation) dbgSpan.title = debugLocation;
    crumb.appendChild(dbgSpan);
  }

  return crumb;
}

// ── Row builder ───────────────────────────────────────────────────────────────

const ACTION_LABELS = {
  ligate:   'LIGATE',
  replace:  'REPLACE',
  multiply: 'MULTIPLY',
  delete:   'DELETE',
  kern:     'KERN',
  position: 'POSITION',
  attach:   'ATTACH',
  final:    'OUTPUT',
};

const ACTION_CLASS = {
  ligate:   'action-ligate',
  replace:  'action-replace',
  multiply: 'action-multiply',
  delete:   'action-delete',
  kern:     'action-kern',
  position: 'action-position',
  attach:   'action-attach',
  final:    'action-final',
};

function buildEntryRow(row, dimLabel) {
  const el = document.createElement('div');
  el.className = 'trace-entry';
  if (row.action === 'final') el.classList.add('trace-entry-final');

  // Trace step index — on each action row (not just header)
  const idxEl = document.createElement('span');
  idxEl.className   = 'trace-step-idx';
  idxEl.textContent = row.traceIdx ?? '';

  const badge = document.createElement('span');
  badge.className   = `action-badge ${ACTION_CLASS[row.action] ?? 'action-generic'}`;
  badge.textContent = ACTION_LABELS[row.action] ?? row.action.toUpperCase();
  if (dimLabel && row.action !== 'final') badge.style.opacity = '0.4';

  const body = document.createElement('span');
  body.className = 'entry-body';

  if (row.action === 'ligate' || row.action === 'replace' ||
      row.action === 'multiply' || row.action === 'delete') {
    buildGsubBody(body, row);
  } else if (row.action === 'final') {
    body.textContent = `${row.after.length} glyph${row.after.length !== 1 ? 's' : ''}`;
    body.style.color = 'var(--text-dim)';
  } else {
    buildGposBody(body, row);
  }

  el.append(idxEl, badge, body);

  // Source code points this row touched (via cluster values)
  const cps = rowCodePoints(row);
  el._cps = cps;

  el.addEventListener('mouseenter', () => {
    el.classList.add('active-hover');
    highlight(cps);
    // Derive which buffer indices are "active" (changed/involved) for highlight
    const activeIndices = getActiveIndices(row);
    showRightPanel(row.after || row.before || [], row.before || [], activeIndices);
  });
  el.addEventListener('mouseleave', () => {
    el.classList.remove('active-hover');
    clearHighlight();
  });

  return el;
}

/**
 * Cluster values of the glyphs this row acted on, resolved to code point indices.
 * Cluster boundaries come from the before+after buffers so merges are split finely.
 */
function rowCodePoints(row) {
  const clusters = new Set();
  const add = (buf, i) => { const g = buf?.[i]; if (g) clusters.add(g.cl ?? 0); };

  if (row.action === 'final') {
    (row.after ?? []).forEach(g => clusters.add(g?.cl ?? 0));
  } else if (row.action === 'ligate' || row.action === 'replace' ||
             row.action === 'multiply' || row.action === 'delete') {
    const g = row.glyphs[0];
    if (g) {
      g.before.forEach(b => add(row.before, b.idx));
      g.after.forEach(a => add(row.after, a.idx));
    }
  } else {
    row.glyphs.forEach(g => add(row.after, g.idx));
  }

  const boundaries = [...(row.before ?? []), ...(row.after ?? [])].map(g => g?.cl ?? 0);
  return cpsForClusters(clusters, boundaries);
}

// ── GSUB body ─────────────────────────────────────────────────────────────────

function buildGsubBody(container, row) {
  const g = row.glyphs[0];
  if (!g) return;

  const beforeSpan = document.createElement('span');
  beforeSpan.className   = 'gsub-before';
  beforeSpan.textContent = g.before.map(b => `'${b.name}'`).join(', ');

  const arrow = document.createElement('span');
  arrow.className   = 'gsub-arrow';
  arrow.textContent = ' → ';

  const afterSpan = document.createElement('span');
  afterSpan.className   = 'gsub-after';
  afterSpan.textContent = g.after.map(a => `'${a.name}'`).join(', ');

  container.append(beforeSpan, arrow, afterSpan);
}

// ── GPOS body ─────────────────────────────────────────────────────────────────

function buildGposBody(container, row) {
  for (const g of row.glyphs) {
    const token = document.createElement('span');
    token.className = 'glyph-token';

    const nameEl = document.createElement('span');
    nameEl.className   = 'glyph-name';
    nameEl.textContent = `'${g.name}'`;

    const deltaEl = document.createElement('span');
    deltaEl.className = 'glyph-deltas';
    deltaEl.appendChild(buildDeltaSpan(g.delta));

    token.append(nameEl, deltaEl);
    container.appendChild(token);
  }
}

function buildDeltaSpan(delta) {
  const frag   = document.createDocumentFragment();
  const fields = ['ax', 'ay', 'dx', 'dy'];
  const vals   = fields.map(f => delta?.[f] ?? 0);

  if (vals.every(v => v === 0)) {
    const s = document.createElement('span');
    s.className   = 'delta-zero-all';
    s.textContent = '•';
    frag.appendChild(s);
    return frag;
  }

  let first = true;
  fields.forEach((f, i) => {
    const val = vals[i];
    if (val === 0) return;
    if (!first) frag.appendChild(document.createTextNode(' '));
    first = false;
    const s = document.createElement('span');
    s.className   = 'delta-nonzero';
    s.textContent = `${f}:${val > 0 ? '+' : ''}${val}`;
    frag.appendChild(s);
  });

  return frag;
}

// ── Active index derivation ───────────────────────────────────────────────────

/**
 * Returns a Set of buffer indices that were involved in / changed by this row.
 * Used to highlight those glyphs in the hover grid and SVG.
 */
function getActiveIndices(row) {
  const s = new Set();
  if (row.action === 'final') return s;  // no highlight for final

  if (row.action === 'ligate' || row.action === 'replace' ||
      row.action === 'multiply' || row.action === 'delete') {
    // GSUB: highlight the after-state glyph positions
    const g = row.glyphs[0];
    if (g) g.after.forEach(a => s.add(a.idx));
  } else {
    // GPOS: highlight glyphs by their buffer index
    row.glyphs.forEach(g => s.add(g.idx));
  }
  return s;
}

// ── Right panel: hover grid + SVG preview ────────────────────────────────────

function showRightPanel(afterBuffer, beforeBuffer, activeIndices) {
  showHoverGrid(afterBuffer, beforeBuffer, activeIndices);
  showSvgPreview(afterBuffer, activeIndices);
}

function hideRightPanel() {
  hoverGrid.hidden = true;
  svgPanel.hidden  = true;
  const tbody = hoverTable?.querySelector('tbody');
  if (tbody) tbody.innerHTML = '';
  svgPanel.innerHTML = '';
}

// ── Hover glyph grid ──────────────────────────────────────────────────────────

function showHoverGrid(afterBuffer, beforeBuffer, activeIndices = new Set()) {
  const tbody = hoverTable.querySelector('tbody');
  tbody.innerHTML = '';

  for (let i = 0; i < afterBuffer.length; i++) {
    const a = afterBuffer[i];
    const b = beforeBuffer[i];
    if (!a) continue;

    const name = glyphName(a.g);

    const changed = activeIndices.has(i) || (b && (
      a.g         !== b.g         ||
      (a.ax ?? 0) !== (b.ax ?? 0) ||
      (a.ay ?? 0) !== (b.ay ?? 0) ||
      (a.dx ?? 0) !== (b.dx ?? 0) ||
      (a.dy ?? 0) !== (b.dy ?? 0)
    ));

    const tr = document.createElement('tr');
    if (changed) tr.classList.add('hg-changed');

    const vals = [i, a.g, name, a.cl ?? 0, a.ax ?? 0, a.ay ?? 0, a.dx ?? 0, a.dy ?? 0];
    const changedFlags = [
      false,
      b && a.g !== b.g,
      b && a.g !== b.g,
      false,
      b && (a.ax ?? 0) !== (b.ax ?? 0),
      b && (a.ay ?? 0) !== (b.ay ?? 0),
      b && (a.dx ?? 0) !== (b.dx ?? 0),
      b && (a.dy ?? 0) !== (b.dy ?? 0),
    ];

    vals.forEach((v, ci) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (changedFlags[ci]) td.classList.add('changed');
      else if (v === 0)     td.classList.add('zero');

      tr.appendChild(td);

      // Separate "src" column right after cl: the source code point(s) the cluster covers
      if (ci === 3) {
        const cps = cpsForClusters([a.cl ?? 0], afterBuffer.map(g => g?.cl ?? 0));
        const lbl = clusterLabel(cps);
        const src = document.createElement('td');
        src.className   = 'hg-src';
        src.textContent = lbl.text;
        src.title       = lbl.title;
        if (lbl.text) {
          for (const el of [td, src]) {
            el.classList.add('hg-cl');
            el.addEventListener('mouseenter', () => highlight(cps));
            el.addEventListener('mouseleave', () => clearHighlight());
          }
        }
        tr.appendChild(src);
      }
    });

    tbody.appendChild(tr);
  }

  hoverGrid.hidden = false;
}

// ── SVG glyph preview ─────────────────────────────────────────────────────────
//
// Renders the shaped glyphs as outlines in a small SVG.
// Coordinate system:
//   - HarfBuzz / font: Y-up, origin at baseline-left
//   - SVG: Y-down
// Transform per glyph:
//   translate(penX + dx,  ascender - dy)  scale(1, -1)
// where penX accumulates ax advances.
//
// Highlighted glyphs (those whose buffer index appears in activeIndices)
// are drawn in amber; others in a dim foreground colour.

function showSvgPreview(glyphBuffer, activeIndices = new Set()) {
  svgPanel.innerHTML = '';
  if (!glyphBuffer || glyphBuffer.length === 0) {
    svgPanel.hidden = true;
    return;
  }

  const { ascender, descender } = fontMetrics;
  const viewH = ascender - descender;

  // Compute display advance per glyph:
  // During GSUB phase ax=0 — fall back to hmtx advance so glyphs don't overlap.
  const displayAx = glyphBuffer.map(g => {
    const ax = g.ax ?? 0;
    return ax !== 0 ? ax : getGlyphAdvance(g.g);
  });

  const totalAx = displayAx.reduce((s, a) => s + a, 0) || 1000;
  const margin  = viewH * 0.05;
  const viewW   = totalAx + margin * 2;
  const svgH    = 120;
  const svgW    = Math.round(svgH * viewW / viewH);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width',   svgW);
  svg.setAttribute('height',  svgH);
  svg.setAttribute('viewBox', `${-margin} ${-margin} ${viewW} ${viewH + margin * 2}`);
  svg.style.display = 'block';

  // Baseline
  const baseline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  baseline.setAttribute('x1', 0);
  baseline.setAttribute('y1', ascender);
  baseline.setAttribute('x2', totalAx);
  baseline.setAttribute('y2', ascender);
  baseline.setAttribute('stroke', 'var(--border)');
  baseline.setAttribute('stroke-width', '8');
  svg.appendChild(baseline);

  // Glyphs
  let penX = 0;
  for (let i = 0; i < glyphBuffer.length; i++) {
    const g    = glyphBuffer[i];
    const d    = getGlyphPath(g.g);
    const dx   = g.dx ?? 0;
    const dy   = g.dy ?? 0;

    const tx = penX + dx;
    const ty = ascender - dy;

    if (d) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('transform', `translate(${tx},${ty}) scale(1,-1)`);

      const isActive = activeIndices.has(i);
      path.setAttribute('fill',         isActive ? 'var(--amber)' : 'var(--text)');
      path.setAttribute('fill-opacity', isActive ? '0.9'          : '0.25');
      path.setAttribute('stroke', 'none');
      svg.appendChild(path);
    }

    penX += displayAx[i];
  }

  svgPanel.appendChild(svg);
  svgPanel.hidden = false;
}

// ── Codepoints ────────────────────────────────────────────────────────────────

export function textToHex(text) {
  return [...text]
    .map(ch => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
    .join(' ');
}

// Hex values may be delimited by any non-hex character; "U+" and "\u" prefixes
// are silently ignored (u, + and \ are non-hex, so they act as delimiters).
export function hexToText(hex) {
  return hex.split(/[^0-9a-fA-F]+/)
    .filter(v => v.length > 0)
    .map(v => {
      const cp = parseInt(v, 16);
      return cp <= 0x10FFFF ? String.fromCodePoint(cp) : '';
    })
    .join('');
}

export function renderCodepoints(text) {
  document.getElementById('hex-input').value = textToHex(text);
}

// ── Status / error ────────────────────────────────────────────────────────────

export function showStatus(msg, isError = false) {
  let bar = document.getElementById('status-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'status-bar';
    document.getElementById('app').appendChild(bar);
  }
  bar.textContent = msg;
  bar.style.color = isError ? 'var(--red)' : 'var(--text-dim)';
}

export function clearStatus() {
  const bar = document.getElementById('status-bar');
  if (bar) bar.textContent = '';
}

export function showEmpty(msg) {
  traceList.hidden = true;
  traceEmpty.hidden = false;
  traceEmpty.textContent = msg;
}
