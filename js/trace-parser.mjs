/**
 * trace-parser.mjs
 *
 * Converts the raw array returned by hb.shapeWithTrace() into a structured
 * list of "fired lookup" objects, each containing the action rows that should
 * be rendered.
 *
 * Raw trace entry shape:
 *   { m: string, t: Array<{g, cl, ax?, ay?, dx?, dy?}>, glyphs?: true }
 *
 * Message patterns we handle:
 *
 *   Control flow:
 *     "start table GSUB script tag 'latn'"
 *     "end table GSUB script tag 'latn'"
 *     "start table GPOS script tag 'latn'"
 *     "end table GPOS script tag 'latn'"
 *     "start lookup 39 feature 'liga'"
 *     "end lookup 39 feature 'liga'"
 *     "skipped lookup N feature '...' because ..."
 *     "recursing to lookup N at M"
 *     "recursed to lookup N"
 *     "start postprocess-glyphs"
 *     "end postprocess-glyphs"
 *
 *   GSUB actions (paired *ing / *ed):
 *     "ligating glyphs at 0,1"       / "ligated glyph at 0"
 *     "replacing glyph at N (...)"   / "replaced glyph at N (...)"
 *     "multiplying glyph at N"       / "multiplied glyph at N"
 *     "deleting glyph at N"          / "deleted glyph at N"
 *
 *   GPOS actions (triplet try-ing / actioned / tried-ed):
 *     "try kerning glyphs at N,M"    / "kerned glyphs at N,M"    / "tried kerning glyphs at N,M"
 *     "positioning glyph at N"       / "positioned glyph at N"
 *     "attaching glyph at N to glyph at M"
 *     "cursive attaching glyph at N to glyph at M"
 *
 * Output structure:
 *   Array of LookupGroup {
 *     table:   'GSUB' | 'GPOS'
 *     feature: string    e.g. 'kern'
 *     lookupId: number
 *     rows: Array of ActionRow
 *   }
 *
 *   ActionRow {
 *     action:  string  ('ligate'|'replace'|'multiply'|'delete'|'kern'|'position'|'attach')
 *     glyphs:  Array of GlyphEntry
 *     before:  Array<{g,cl,ax,ay,dx,dy}> — snapshot before action
 *     after:   Array<{g,cl,ax,ay,dx,dy}> — snapshot after action (GPOS) or new state (GSUB)
 *   }
 *
 *   GlyphEntry {
 *     idx:     number  — position in the buffer at time of action
 *     nameBefore: string
 *     nameAfter:  string  (differs for GSUB substitutions)
 *     delta:  { ax, ay, dx, dy }  — after minus before (GPOS)
 *   }
 */

import { glyphName, lookupDebugInfo } from './hb-loader.mjs';

// ── Regex catalogue ───────────────────────────────────────────────────────────

const RE = {
  startTable:    /^start table (GSUB|GPOS)/,
  endTable:      /^end table (GSUB|GPOS)/,
  startLookup:   /^start lookup (\d+) feature '([^']+)'/,
  endLookup:     /^end lookup (\d+) feature '([^']+)'/,
  skippedLookup: /^skipped lookup/,
  recursing:     /^recursing to lookup (\d+) at (\d+)/,
  recursed:      /^recursed to lookup (\d+)/,
  startPost:     /^start postprocess/,
  endPost:       /^end postprocess/,

  // GSUB — *ing forms capture glyph indices; *ed forms capture result index
  ligating:      /^ligating glyphs? at ([\d,]+)/,
  ligated:       /^ligated glyphs? at ([\d,]+)/,
  replacing:     /^replacing glyphs? at ([\d,]+)/,
  replaced:      /^replaced glyphs? at ([\d,]+)/,
  multiplying:   /^multiplying glyphs? at ([\d,]+)/,
  multiplied:    /^multiplied glyphs? at ([\d,]+)/,
  deleting:      /^deleting glyphs? at ([\d,]+)/,
  deleted:       /^deleted glyphs? at ([\d,]+)/,

  // GPOS — try*/ed/tried* triplet
  tryKerning:    /^try kerning glyphs? at ([\d,]+)/,
  kerned:        /^kerned glyphs? at ([\d,]+)/,
  triedKerning:  /^tried kerning glyphs? at ([\d,]+)/,
  positioning:   /^positioning glyphs? at ([\d,]+)/,
  positioned:    /^positioned glyphs? at ([\d,]+)/,
  attaching:     /^(?:cursive )?attaching (?:mark )?glyph at (\d+) to glyph at (\d+)/,
  attached:      /^(?:cursive )?attached (?:mark )?glyph at (\d+) to glyph at (\d+)/,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseIndices(str) {
  return str.split(',').map(Number);
}

/** Snapshot a subset of the t array by buffer indices */
function snapshotByIndices(t, indices) {
  return indices.map(i => {
    const g = t[i];
    return g ? { ...g } : { g: 0, cl: i, ax: 0, ay: 0, dx: 0, dy: 0 };
  });
}

/** Snapshot full buffer */
function snapshotFull(t) {
  return t.map(g => ({ ...g }));
}

/** Compute per-field deltas between two glyph snapshots (same buffer index) */
function diffGlyph(before, after) {
  return {
    ax: (after.ax ?? 0) - (before.ax ?? 0),
    ay: (after.ay ?? 0) - (before.ay ?? 0),
    dx: (after.dx ?? 0) - (before.dx ?? 0),
    dy: (after.dy ?? 0) - (before.dy ?? 0),
  };
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parse a raw shapeWithTrace() output array.
 *
 * @param {Array}  rawTrace
 * @param {'both'|'GSUB'|'GPOS'} filter
 * @returns {LookupGroup[]}
 */
export function parseTrace(rawTrace, filter = 'both') {
  /** Stack of open lookup contexts */
  const stack = [];

  /** Accumulated output */
  const groups = [];

  /** Pending *ing state waiting for matching *ed */
  // Key: action type string, Value: { indices, beforeFull, beforeSlice }
  const pendingIng = new Map();

  /** Current active table (GSUB | GPOS | null) */
  let currentTable = null;

  function peekLookup() {
    return stack.length > 0 ? stack[stack.length - 1] : null;
  }

  function pushGroup(table, feature, lookupId) {
    const dbg = table ? lookupDebugInfo(table, lookupId) : null;
    const debugName     = dbg?.name     ?? null;
    const debugLocation = dbg?.location ?? null;
    // Capture the current call path (ancestor lookups, outermost first).
    const ancestorPath = stack.map(s => ({
      lookupId:      s.lookupId,
      feature:       s.group.feature,
      debugName:     s.group.debugName,
      debugLocation: s.group.debugLocation,
    }));
    const group = { table, feature, lookupId, debugName, debugLocation, ancestorPath, rows: [] };
    stack.push({ table, feature, lookupId, group });
    return group;
  }

  function popLookup(lookupId) {
    // Pop until we find the matching lookup id (handles missing recursed messages)
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      stack.pop();
      if (top.lookupId === lookupId) {
        // Only add to output if it produced rows
        if (top.group.rows.length > 0) {
          groups.push(top.group);
        }
        break;
      }
    }
  }

  function clearStack() {
    // Flush any groups with rows
    while (stack.length > 0) {
      const { group } = stack.pop();
      if (group.rows.length > 0) groups.push(group);
    }
    pendingIng.clear();
  }

  for (let traceIdx = 0; traceIdx < rawTrace.length; traceIdx++) {
    const entry = rawTrace[traceIdx];
    const m = entry.m;
    const t = entry.t || [];

    // ── Control flow ─────────────────────────────────────────────

    if (RE.startTable.test(m)) {
      currentTable = m.match(RE.startTable)[1];
      continue;
    }

    if (RE.endTable.test(m)) {
      clearStack();
      currentTable = null;
      pendingIng.clear();
      continue;
    }

    if (RE.startLookup.test(m)) {
      const [, idStr, feature] = m.match(RE.startLookup);
      const lookupId = Number(idStr);
      pushGroup(currentTable, feature, lookupId);
      pendingIng.clear();
      continue;
    }

    if (RE.endLookup.test(m)) {
      const [, idStr] = m.match(RE.endLookup);
      popLookup(Number(idStr));
      pendingIng.clear();
      continue;
    }

    if (RE.skippedLookup.test(m)) {
      // Skipped — no actions will fire for this lookup.
      // Leave the stack intact; end lookup will pop it (with no rows → not emitted).
      pendingIng.clear();
      continue;
    }

    if (RE.recursing.test(m)) {
      // Treat like a nested lookup start — use lookupId from message
      const [, idStr] = m.match(RE.recursing);
      pushGroup(currentTable, peekLookup()?.feature ?? '?', Number(idStr));
      continue;
    }

    if (RE.recursed.test(m)) {
      const [, idStr] = m.match(RE.recursed);
      popLookup(Number(idStr));
      continue;
    }

    if (RE.startPost.test(m) || RE.endPost.test(m)) continue;

    // ── GSUB actions ──────────────────────────────────────────────
    // Filter check
    if (currentTable === 'GSUB' && filter === 'GPOS') continue;
    if (currentTable === 'GPOS' && filter === 'GSUB') continue;

    // ligating / ligated
    if (RE.ligating.test(m)) {
      const indices = parseIndices(m.match(RE.ligating)[1]);
      pendingIng.set('ligate', { indices, beforeFull: snapshotFull(t) });
      continue;
    }
    if (RE.ligated.test(m)) {
      const resultIndices = parseIndices(m.match(RE.ligated)[1]);
      const pending = pendingIng.get('ligate');
      pendingIng.delete('ligate');
      const ctx = peekLookup();
      if (!ctx) continue;

      const beforeFull = pending?.beforeFull ?? [];
      const afterFull  = snapshotFull(t);
      const glyphs = buildGsubGlyphs(pending?.indices ?? [], resultIndices, beforeFull, afterFull);
      ctx.group.rows.push({ action: 'ligate', traceIdx, glyphs, before: beforeFull, after: afterFull });
      continue;
    }

    // replacing / replaced
    if (RE.replacing.test(m)) {
      const indices = parseIndices(m.match(RE.replacing)[1]);
      pendingIng.set('replace', { indices, beforeFull: snapshotFull(t) });
      continue;
    }
    if (RE.replaced.test(m)) {
      const resultIndices = parseIndices(m.match(RE.replaced)[1]);
      const pending = pendingIng.get('replace');
      pendingIng.delete('replace');
      const ctx = peekLookup();
      if (!ctx) continue;

      const beforeFull = pending?.beforeFull ?? [];
      const afterFull  = snapshotFull(t);
      const glyphs = buildGsubGlyphs(pending?.indices ?? resultIndices, resultIndices, beforeFull, afterFull);
      ctx.group.rows.push({ action: 'replace', traceIdx, glyphs, before: beforeFull, after: afterFull });
      continue;
    }

    // multiplying / multiplied
    if (RE.multiplying.test(m)) {
      const indices = parseIndices(m.match(RE.multiplying)[1]);
      pendingIng.set('multiply', { indices, beforeFull: snapshotFull(t) });
      continue;
    }
    if (RE.multiplied.test(m)) {
      const resultIndices = parseIndices(m.match(RE.multiplied)[1]);
      const pending = pendingIng.get('multiply');
      pendingIng.delete('multiply');
      const ctx = peekLookup();
      if (!ctx) continue;

      const beforeFull = pending?.beforeFull ?? [];
      const afterFull  = snapshotFull(t);
      const glyphs = buildGsubGlyphs(pending?.indices ?? resultIndices, resultIndices, beforeFull, afterFull);
      ctx.group.rows.push({ action: 'multiply', traceIdx, glyphs, before: beforeFull, after: afterFull });
      continue;
    }

    // deleting / deleted
    if (RE.deleting.test(m)) {
      const indices = parseIndices(m.match(RE.deleting)[1]);
      pendingIng.set('delete', { indices, beforeFull: snapshotFull(t) });
      continue;
    }
    if (RE.deleted.test(m)) {
      const resultIndices = parseIndices(m.match(RE.deleted)[1]);
      const pending = pendingIng.get('delete');
      pendingIng.delete('delete');
      const ctx = peekLookup();
      if (!ctx) continue;

      const beforeFull = pending?.beforeFull ?? [];
      const afterFull  = snapshotFull(t);
      const glyphs = buildGsubGlyphs(pending?.indices ?? resultIndices, resultIndices, beforeFull, afterFull);
      ctx.group.rows.push({ action: 'delete', traceIdx, glyphs, before: beforeFull, after: afterFull });
      continue;
    }

    // ── GPOS actions ──────────────────────────────────────────────

    // try kerning / kerned / tried kerning
    if (RE.tryKerning.test(m)) {
      const indices = parseIndices(m.match(RE.tryKerning)[1]);
      pendingIng.set('kern', { indices, beforeFull: snapshotFull(t) });
      continue;
    }
    if (RE.kerned.test(m)) {
      const indices = parseIndices(m.match(RE.kerned)[1]);
      const pending = pendingIng.get('kern');
      // Don't delete yet — wait for triedKerning to confirm, but store afterFull here
      if (pending) pending.afterFull = snapshotFull(t);
      continue;
    }
    if (RE.triedKerning.test(m)) {
      const pending = pendingIng.get('kern');
      pendingIng.delete('kern');
      const ctx = peekLookup();
      if (!ctx || !pending) continue;

      const { indices, beforeFull, afterFull } = pending;
      if (!afterFull) continue;  // no kerned message arrived

      const glyphs = buildGposGlyphs(indices, beforeFull, afterFull);
      ctx.group.rows.push({ action: 'kern', traceIdx, glyphs, before: beforeFull, after: afterFull });
      continue;
    }

    // positioning / positioned
    if (RE.positioning.test(m)) {
      const indices = parseIndices(m.match(RE.positioning)[1]);
      pendingIng.set('position', { indices, beforeFull: snapshotFull(t) });
      continue;
    }
    if (RE.positioned.test(m)) {
      const indices = parseIndices(m.match(RE.positioned)[1]);
      const pending = pendingIng.get('position');
      pendingIng.delete('position');
      const ctx = peekLookup();
      if (!ctx) continue;

      const beforeFull = pending?.beforeFull ?? [];
      const afterFull  = snapshotFull(t);
      const effIndices = pending?.indices ?? indices;
      const glyphs = buildGposGlyphs(effIndices, beforeFull, afterFull);
      ctx.group.rows.push({ action: 'position', traceIdx, glyphs, before: beforeFull, after: afterFull });
      continue;
    }

    // attaching / attached (cursive or mark)
    if (RE.attaching.test(m)) {
      const [, i1, i2] = m.match(RE.attaching);
      const indices = [Number(i1), Number(i2)];
      pendingIng.set('attach', { indices, beforeFull: snapshotFull(t) });
      continue;
    }
    if (RE.attached.test(m)) {
      const [, i1, i2] = m.match(RE.attached);
      const indices = [Number(i1), Number(i2)];
      const pending = pendingIng.get('attach');
      pendingIng.delete('attach');
      const ctx = peekLookup();
      if (!ctx) continue;

      const beforeFull = pending?.beforeFull ?? [];
      const afterFull  = snapshotFull(t);
      const effIndices = pending?.indices ?? indices;
      const glyphs = buildGposGlyphs(effIndices, beforeFull, afterFull);
      ctx.group.rows.push({ action: 'attach', traceIdx, glyphs, before: beforeFull, after: afterFull });
      continue;
    }
  }

  // Flush any remaining open groups
  clearStack();

  // ── Synthetic FINAL group ─────────────────────────────────────────────────
  // Find the last rawTrace entry that has a non-empty t array.
  // This is the complete post-processed glyph buffer — the true HarfBuzz output.
  let finalT = null;
  let finalIdx = -1;
  for (let i = rawTrace.length - 1; i >= 0; i--) {
    if (rawTrace[i].t && rawTrace[i].t.length > 0) {
      finalT   = rawTrace[i].t;
      finalIdx = i;
      break;
    }
  }
  if (finalT) {
    const snap = finalT.map(g => ({ ...g }));
    groups.push({
      table:         'FINAL',
      feature:       '',
      lookupId:      null,
      debugName:     null,
      debugLocation: null,
      ancestorPath:  [],
      rows: [{
        action:   'final',
        traceIdx: finalIdx,
        glyphs:   [],
        before:   snap,
        after:    snap,
      }],
    });
  }

  return groups;
}

// ── Glyph builders ────────────────────────────────────────────────────────────

/**
 * Build GSUB glyph entries — shows before-glyph names → after-glyph names.
 */
function buildGsubGlyphs(beforeIndices, afterIndices, beforeFull, afterFull) {
  const glyphs = [];

  // Before glyphs
  const beforeGlyphs = beforeIndices.map(i => {
    const g = beforeFull[i];
    return g ? { idx: i, name: glyphName(g.g), gid: g.g } : { idx: i, name: `gid?`, gid: -1 };
  });

  // After glyphs
  const afterGlyphs = afterIndices.map(i => {
    const g = afterFull[i];
    return g ? { idx: i, name: glyphName(g.g), gid: g.g } : { idx: i, name: `gid?`, gid: -1 };
  });

  glyphs.push({ type: 'gsub', before: beforeGlyphs, after: afterGlyphs });
  return glyphs;
}

/**
 * Build GPOS glyph entries — shows glyph name + delta.
 */
function buildGposGlyphs(indices, beforeFull, afterFull) {
  return indices.map(i => {
    const b = beforeFull[i] ?? { g: 0, cl: i, ax: 0, ay: 0, dx: 0, dy: 0 };
    const a = afterFull[i]  ?? { g: 0, cl: i, ax: 0, ay: 0, dx: 0, dy: 0 };
    return {
      type:  'gpos',
      idx:   i,
      name:  glyphName(b.g),
      gid:   b.g,
      delta: diffGlyph(b, a),
    };
  });
}
