/**
 * crossref.mjs
 * Cross-references HarfBuzz cluster values (`cl`) back to the source code points.
 *
 * The shaped text is added to the HarfBuzz buffer with addText(), so cluster
 * values are UTF-16 code-unit offsets into that string (an astral code point
 * occupies two units). Everything here maps between three views of the input:
 *   - the code point strip (chips)
 *   - the Word input   (selected, which needs focus)
 *   - the Hex input    (marked through a backdrop layer)
 *
 * A cluster value c covers the source from offset c up to the next cluster
 * value present in the buffer (merged clusters swallow the code points between).
 */

let text      = '';      // exactly what was passed to the shaper
let cpOffsets = [];      // UTF-16 offset of each code point in `text`
let cpChars   = [];      // the code points themselves

let wordInput, hexInput, hexBackdrop, strip;

export function initCrossRef() {
  wordInput   = document.getElementById('word-input');
  hexInput    = document.getElementById('hex-input');
  hexBackdrop = document.getElementById('hex-backdrop');
  strip       = document.getElementById('cp-strip');

  // Keep the backdrop aligned if a long hex string is scrolled
  hexInput.addEventListener('scroll', () => { hexBackdrop.scrollLeft = hexInput.scrollLeft; });
}

// ── Source text ───────────────────────────────────────────────────────────────

export function hexOf(ch) {
  return 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
}

function displayChar(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0x20) return '␣';                        // ␣
  if (/\p{Cc}|\p{Zs}|\p{Cf}|\p{Cs}|\p{Co}|\p{Cn}/u.test(ch)) return '·'; // ·
  if (/\p{M}/u.test(ch)) return '◌' + ch;             // dotted circle base for marks
  return ch;
}

/** Record the text that was just shaped and rebuild the code point strip. */
export function setSourceText(t) {
  text      = t;
  cpChars   = Array.from(t);
  cpOffsets = [];
  let off = 0;
  for (const ch of cpChars) { cpOffsets.push(off); off += ch.length; }

  strip.textContent = '';
  cpChars.forEach((ch, n) => {
    const chip = document.createElement('span');
    chip.className = 'cp-chip';
    chip.dataset.cp = n;
    chip.title = `code point ${n}, UTF-16 offset ${cpOffsets[n]}`;

    const idx = document.createElement('span');
    idx.className = 'cp-idx';
    idx.textContent = cpOffsets[n];                        // the value `cl` will hold

    const glyph = document.createElement('span');
    glyph.className = 'cp-char';
    glyph.textContent = displayChar(ch);

    const hex = document.createElement('span');
    hex.className = 'cp-hex';
    hex.textContent = hexOf(ch);

    chip.append(idx, glyph, hex);
    chip.addEventListener('mouseenter', () => { highlight(new Set([n])); dimRowsExcept(n); });
    chip.addEventListener('mouseleave', () => { clearHighlight(); clearRowDim(); });
    strip.appendChild(chip);
  });
  strip.hidden = cpChars.length === 0;
}

// ── Cluster → code point mapping ─────────────────────────────────────────────

/**
 * @param {Iterable<number>} clusters   cluster values to resolve
 * @param {Iterable<number>} boundaries every cluster value present in the buffer(s)
 * @returns {Set<number>} code point indices covered
 */
export function cpsForClusters(clusters, boundaries) {
  const bs = [...new Set(boundaries)].sort((a, b) => a - b);
  const out = new Set();
  for (const c of clusters) {
    const i = bs.indexOf(c);
    const end = (i >= 0 && i + 1 < bs.length) ? bs[i + 1] : Infinity;
    cpOffsets.forEach((off, n) => { if (off >= c && off < end) out.add(n); });
  }
  return out;
}

/** Short form for the cl cell: first code point, "+N" when the cluster has more. */
export function clusterLabel(cps) {
  const list = [...cps].sort((a, b) => a - b);
  if (list.length === 0) return { text: '', title: '' };
  const first = hexOf(cpChars[list[0]]);
  return {
    text:  list.length > 1 ? `${first} +${list.length - 1}` : first,
    title: list.map(n => `${hexOf(cpChars[n])} ${cpChars[n]}`).join('\n'),
  };
}

// ── Highlighting ──────────────────────────────────────────────────────────────

let savedSel = null;

export function highlight(cps) {
  clearHighlight();
  if (!cps || cps.size === 0) return;

  for (const chip of strip.children) {
    if (cps.has(+chip.dataset.cp)) chip.classList.add('cp-hl');
  }

  // Word / hex are only addressable while they still hold the shaped text
  const value = wordInput.value;
  if (value.trim() !== text) return;
  const lead = value.length - value.trimStart().length;   // UTF-16 units == code points (whitespace is BMP)

  paintHex(cps, lead);
  selectInWord(cps, lead);
}

export function clearHighlight() {
  for (const chip of strip.children) chip.classList.remove('cp-hl');
  hexBackdrop.textContent = '';
  restoreWordSelection();
}

function selectInWord(cps, lead) {
  const list = [...cps].sort((a, b) => a - b);
  const first = list[0], last = list[list.length - 1];
  if (cpOffsets[first] == null || cpOffsets[last] == null) return;

  const active = document.activeElement;
  const typing = active && active !== document.body && active !== wordInput &&
                 /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
  if (typing) return;                                      // never steal focus from another field

  if (!savedSel) {
    savedSel = { focused: active === wordInput,
                 s: wordInput.selectionStart, e: wordInput.selectionEnd, d: wordInput.selectionDirection };
  }
  if (active !== wordInput) wordInput.focus({ preventScroll: true });
  wordInput.setSelectionRange(lead + cpOffsets[first], lead + cpOffsets[last] + cpChars[last].length);
}

function restoreWordSelection() {
  if (!savedSel) return;
  const s = savedSel;
  savedSel = null;
  if (s.focused) wordInput.setSelectionRange(s.s, s.e, s.d ?? 'none');
  else { wordInput.setSelectionRange(0, 0); wordInput.blur(); }
}

/** Mirror the hex field in the backdrop with the chosen tokens wrapped in <mark>. */
function paintHex(cps, lead) {
  const value = hexInput.value;
  hexBackdrop.textContent = '';
  let pos = 0, tok = 0;
  for (const m of value.matchAll(/[0-9a-fA-F]+/g)) {
    if (parseInt(m[0], 16) > 0x10FFFF) continue;           // dropped by hexToText, so not a code point
    if (m.index > pos) hexBackdrop.append(value.slice(pos, m.index));
    if (cps.has(tok - lead)) {
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      hexBackdrop.appendChild(mark);
    } else {
      hexBackdrop.append(m[0]);
    }
    pos = m.index + m[0].length;
    tok++;
  }
  hexBackdrop.append(value.slice(pos));
  hexBackdrop.scrollLeft = hexInput.scrollLeft;
}

// ── Reverse direction: chip hover dims trace rows that don't touch it ────────

function dimRowsExcept(n) {
  for (const row of document.querySelectorAll('#trace-list .trace-entry')) {
    const hit = row._cps?.has(n);
    row.classList.toggle('cp-match', !!hit);
    row.classList.toggle('cp-dim', !hit);
  }
}

function clearRowDim() {
  for (const row of document.querySelectorAll('#trace-list .trace-entry')) {
    row.classList.remove('cp-match', 'cp-dim');
  }
}
