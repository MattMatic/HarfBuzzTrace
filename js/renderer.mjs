/**
 * renderer.mjs
 * Builds the trace list DOM from parsed LookupGroup[] data.
 * Also manages the hover glyph grid panel.
 */

import { glyphName } from './hb-loader.mjs';

// ── Element cache ─────────────────────────────────────────────────────────────
let traceList    = null;
let traceEmpty   = null;
let hoverGrid    = null;
let hoverTable   = null;   // <table> element inside hover panel

export function initRenderer() {
  traceList  = document.getElementById('trace-list');
  traceEmpty = document.getElementById('trace-empty');
  hoverGrid  = document.getElementById('hover-grid');
  hoverTable = document.getElementById('hover-table');
}

// ── Main render entry point ───────────────────────────────────────────────────

export function renderTrace(groups) {
  traceList.innerHTML = '';
  hideHoverGrid();

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
    groupEl.appendChild(buildLookupHeader(group));

    const isMultiRow = group.rows.length > 1;
    for (const row of group.rows) {
      groupEl.appendChild(buildEntryRow(row, isMultiRow));
    }

    traceList.appendChild(groupEl);
  }
}

// ── Lookup header breadcrumb ──────────────────────────────────────────────────
//
// Displays the full call stack for the lookup, most-recent (innermost) first.
// Example for a recursive lookup:
//
//   [GPOS]  lookup 1 'kern' kern_pairs  ←  lookup 0 'kern'
//
// ancestorPath is outermost-first, so we reverse it to build outermost-last,
// then prepend the current group itself.

function buildLookupHeader(group) {
  const header = document.createElement('div');
  header.className = 'lookup-header';

  // Table badge
  const badge = document.createElement('span');
  badge.className = `lookup-table-badge badge-${group.table.toLowerCase()}`;
  badge.textContent = group.table;
  header.appendChild(badge);

  // Build the breadcrumb: current lookup first, then ancestors right to left
  // Current
  header.appendChild(buildLookupCrumb(group.lookupId, group.feature, group.debugName, false));

  // Ancestors: ancestorPath is outermost-first; show innermost-first after current
  // i.e. reverse so we go from "just above current" out to root
  const ancestors = [...(group.ancestorPath ?? [])].reverse();
  for (const anc of ancestors) {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '←';
    header.appendChild(sep);
    header.appendChild(buildLookupCrumb(anc.lookupId, anc.feature, anc.debugName, true));
  }

  return header;
}

function buildLookupCrumb(lookupId, feature, debugName, dim) {
  const crumb = document.createElement('span');
  crumb.className = 'lookup-crumb' + (dim ? ' lookup-crumb-dim' : '');

  const idSpan = document.createElement('span');
  idSpan.className = 'lookup-id';
  idSpan.textContent = `lookup ${lookupId}`;

  const featSpan = document.createElement('span');
  featSpan.className = 'lookup-feature';
  featSpan.textContent = `'${feature}'`;

  crumb.append(idSpan, featSpan);

  if (debugName) {
    const dbgSpan = document.createElement('span');
    dbgSpan.className = 'lookup-debug-name';
    dbgSpan.textContent = debugName;
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
};

const ACTION_CLASS = {
  ligate:   'action-ligate',
  replace:  'action-replace',
  multiply: 'action-multiply',
  delete:   'action-delete',
  kern:     'action-kern',
  position: 'action-position',
  attach:   'action-attach',
};

function buildEntryRow(row, dimLabel) {
  const el = document.createElement('div');
  el.className = 'trace-entry';

  const badge = document.createElement('span');
  badge.className = `action-badge ${ACTION_CLASS[row.action] ?? 'action-generic'}`;
  badge.textContent = ACTION_LABELS[row.action] ?? row.action.toUpperCase();
  if (dimLabel) badge.style.opacity = '0.4';

  const body = document.createElement('span');
  body.className = 'entry-body';

  if (row.action === 'ligate' || row.action === 'replace' ||
      row.action === 'multiply' || row.action === 'delete') {
    buildGsubBody(body, row);
  } else {
    buildGposBody(body, row);
  }

  el.append(badge, body);

  el.addEventListener('mouseenter', () => {
    el.classList.add('active-hover');
    showHoverGrid(row.after || row.before || [], row.before || []);
  });
  el.addEventListener('mouseleave', () => {
    el.classList.remove('active-hover');
  });

  return el;
}

// ── GSUB body ─────────────────────────────────────────────────────────────────

function buildGsubBody(container, row) {
  const g = row.glyphs[0];
  if (!g) return;

  const beforeSpan = document.createElement('span');
  beforeSpan.className = 'gsub-before';
  beforeSpan.textContent = g.before.map(b => `'${b.name}'`).join(', ');

  const arrow = document.createElement('span');
  arrow.className = 'gsub-arrow';
  arrow.textContent = ' → ';

  const afterSpan = document.createElement('span');
  afterSpan.className = 'gsub-after';
  afterSpan.textContent = g.after.map(a => `'${a.name}'`).join(', ');

  container.append(beforeSpan, arrow, afterSpan);
}

// ── GPOS body ─────────────────────────────────────────────────────────────────

function buildGposBody(container, row) {
  for (const g of row.glyphs) {
    const token = document.createElement('span');
    token.className = 'glyph-token';

    const nameEl = document.createElement('span');
    nameEl.className = 'glyph-name';
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

  // All zero → single centred bullet
  if (vals.every(v => v === 0)) {
    const s = document.createElement('span');
    s.className   = 'delta-zero-all';
    s.textContent = '•';
    frag.appendChild(s);
    return frag;
  }

  // Show only non-zero fields
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

// ── Hover glyph grid ──────────────────────────────────────────────────────────
//
// Uses a <table> so header and body columns are guaranteed to align.
// Columns: #  glyph  name  cluster  ax  ay  dx  dy

const HG_COLS = ['#', 'glyph', 'name', 'cl', 'ax', 'ay', 'dx', 'dy'];
// Which column indices are right-aligned (numeric)
const HG_RIGHT = new Set([0, 1, 3, 4, 5, 6, 7]);

function showHoverGrid(afterBuffer, beforeBuffer) {
  // Clear tbody
  const tbody = hoverTable.querySelector('tbody');
  tbody.innerHTML = '';

  for (let i = 0; i < afterBuffer.length; i++) {
    const a = afterBuffer[i];
    const b = beforeBuffer[i];
    if (!a) continue;

    const name = glyphName(a.g);

    const changed = b && (
      a.g         !== b.g         ||
      (a.ax ?? 0) !== (b.ax ?? 0) ||
      (a.ay ?? 0) !== (b.ay ?? 0) ||
      (a.dx ?? 0) !== (b.dx ?? 0) ||
      (a.dy ?? 0) !== (b.dy ?? 0)
    );

    const tr = document.createElement('tr');
    if (changed) tr.classList.add('hg-changed');

    // Values: #  glyph  name  cl  ax  ay  dx  dy
    const vals = [
      i,
      a.g,
      name,
      a.cl  ?? 0,
      a.ax  ?? 0,
      a.ay  ?? 0,
      a.dx  ?? 0,
      a.dy  ?? 0,
    ];

    // Changed flags per cell
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
    });

    tbody.appendChild(tr);
  }

  hoverGrid.hidden = false;
}

function hideHoverGrid() {
  hoverGrid.hidden = true;
  const tbody = hoverTable?.querySelector('tbody');
  if (tbody) tbody.innerHTML = '';
}

// ── Codepoints ────────────────────────────────────────────────────────────────

export function renderCodepoints(text) {
  const row  = document.getElementById('codepoints-row');
  const list = document.getElementById('codepoints-list');
  list.innerHTML = '';

  if (!text) { row.hidden = true; return; }

  [...text].forEach(ch => {
    const cp  = ch.codePointAt(0);
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    const chip = document.createElement('span');
    chip.className   = 'cp-chip';
    chip.textContent = hex;
    chip.title       = ch;
    list.appendChild(chip);
  });

  row.hidden = false;
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
