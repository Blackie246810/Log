// Renders tabular data as a PNG image for Discord.
//
// Discord's embed "fields" API only supports label/value pairs shoved into
// an inline grid — it can't represent a real multi-column table (date,
// category, amount, ...) without faking it. This draws an actual table onto
// a canvas instead, styled to match Discord's own dark theme so it reads as
// part of the chat rather than a pasted-in foreign element.
//
// Uses @napi-rs/canvas rather than the more common `canvas` package: it
// ships prebuilt binaries per platform, so it installs on Render without
// needing system-level Cairo/Pango libraries available at build time.
//
// Text is drawn with a bundled variable font (assets/fonts) rather than
// relying on whatever fonts happen to be installed on the host — a minimal
// Render container has no guarantee of shipping any usable font at all, and
// silently falling back to tofu/blank glyphs would be a bad failure mode.

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_FAMILY = 'Noto Sans';
const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSans-Variable.ttf');

// Registered once, process-wide, at module load — GlobalFonts is a global
// registry, so re-registering per render would just be wasted work.
GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);

// Shared with the AI's system prompt (see ai/gemini.js) so the model knows
// roughly what this file enforces, without being given exact numbers it
// can't actually predict — see the note on splitting below.
//
// Splitting here is driven by rendered SIZE, not row/column COUNT. A table
// with 3 columns can still be "too wide" if the content in those columns is
// long, and a table with only a few rows can still be "too tall" if each
// row wraps onto several lines — a fixed count either splits things that
// would've fit fine, or lets genuinely oversized content through. Content
// is never cut to fit: header and cell text word-wrap onto more lines
// (growing that row's height) rather than getting truncated with an
// ellipsis, and anything that still doesn't fit one comfortable image gets
// pushed into more images automatically.
export const MAX_TABLE_WIDTH = 700; // target total image width, logical px
export const MAX_TABLE_HEIGHT = 480; // target total image height, logical px

// Discord hard-caps attachments at 10 files per message — this isn't a
// design choice, it's the platform's actual limit. A result set needing
// more tables than this must span multiple Discord messages, not more
// attachments crammed into one.
export const MAX_TABLES_PER_MESSAGE = 10;

const SCALE = 2; // render at 2x, Discord displays at native size — crisper on high-DPI screens
const PAD_X = 14;
const TITLE_H = 36;
const LINE_H = 19; // one wrapped line of text, any font size used here
const HEADER_V_PAD = 21; // header row = LINE_H + this per line-of-text, single line = 40 (matches prior fixed HEADER_H)
const ROW_V_PAD = 15; // data row = LINE_H + this per line-of-text, single line = 34 (matches prior fixed ROW_H)
const MIN_COL_W = 70; // floor width for any column, including padding — below this a column stops being legible

// Discord's own dark-theme palette (Blurple's dark surface colors), so the
// image blends into the chat instead of looking like a pasted-in screenshot
// from somewhere else.
const COLORS = {
  background: '#1e1f22',
  header: '#2b2d31',
  rowEven: '#232428',
  rowOdd: '#1e1f22',
  textPrimary: '#f2f3f5',
  textBody: '#dbdee1',
  separator: '#3a3b3f',
};

// Currency now renders as a 3-letter ISO code prefix (e.g. "USD 450.00" or
// "-USD 450.00"), not a fixed symbol — accept an optional leading code,
// with or without the sign before it, as still "numeric" for right-align.
function looksNumeric(value) {
  return /^-?([A-Z]{3}\s?)?-?[\d,]+(\.\d+)?%?$/.test(String(value ?? '').trim());
}

// Binary-searches for the longest prefix of `text` that fits in `maxWidth`
// once an ellipsis is appended. Used only for the table title (see
// renderTableImage) as a last-resort defensive fallback — the title's own
// width is what the table is widened to fit, so this should never actually
// need to cut anything in normal operation.
function truncateToWidth(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

// Greedy word-wrap: breaks `text` into lines that each fit in `maxWidth`.
// A single word/token longer than maxWidth on its own (a long URL, ID, or
// unbroken string) is still shown in full — hard-broken character by
// character — rather than silently cut off. This is the one place content
// can be "cut" at all, and even then only visually across lines, never
// dropped.
function wrapText(ctx, text, maxWidth) {
  const str = String(text ?? '');
  if (str === '') return [''];

  function breakLongWord(word) {
    const pieces = [];
    let chunk = '';
    for (const ch of word) {
      const attempt = chunk + ch;
      if (chunk !== '' && ctx.measureText(attempt).width > maxWidth) {
        pieces.push(chunk);
        chunk = ch;
      } else {
        chunk = attempt;
      }
    }
    if (chunk) pieces.push(chunk);
    return pieces;
  }

  const words = str.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines = [];
  let current = '';
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (ctx.measureText(attempt).width <= maxWidth) {
      current = attempt;
      continue;
    }
    if (current) {
      lines.push(current);
      current = '';
    }
    if (ctx.measureText(word).width <= maxWidth) {
      current = word;
    } else {
      const pieces = breakLongWord(word);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] || '';
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// Smart width allocation ("water-filling"): every column gets its natural
// content width (floored at MIN_COL_W) as long as the total fits the
// budget — nothing is capped just because one fixed ceiling says so. Only
// once the combined total exceeds budget does anything shrink, and even
// then a column keeps its full request until the group of columns still
// asking for more is squeezed down to an equal share of what's left. A
// column that only wanted a little is left almost untouched; a column
// that wanted a lot gives up the most, since it has the most slack to
// still stay legible via wrapping. This is the standard max-min fair-share
// algorithm (the same idea used for splitting bandwidth fairly).
function waterFillWidths(desired, budget) {
  const n = desired.length;
  if (n === 0) return [];
  const total = desired.reduce((a, b) => a + b, 0);
  if (total <= budget) return desired.slice();

  const order = desired.map((_, i) => i).sort((a, b) => desired[a] - desired[b]);
  const result = new Array(n).fill(0);
  let remaining = budget;
  let remainingCount = n;
  for (let k = 0; k < n; k++) {
    const idx = order[k];
    const fairShare = remaining / remainingCount;
    if (desired[idx] <= fairShare) {
      result[idx] = desired[idx];
      remaining -= desired[idx];
      remainingCount -= 1;
    } else {
      // This column, and every later one in the (ascending) sort order,
      // wants at least as much as this one — none of them can be fully
      // satisfied, so they split what's left equally.
      const share = remaining / remainingCount;
      for (let j = k; j < n; j++) result[order[j]] = share;
      break;
    }
  }
  return result;
}

// Proportionally scales a set of column widths UP to fill exactly
// targetWidth, in proportion to each column's current width — used so a
// table that has room to spare distributes the extra space across all its
// columns rather than leaving it as dead space at one edge. Never shrinks;
// if the widths already meet or exceed targetWidth, they're returned as-is.
function growToFill(widths, targetWidth) {
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= 0 || total >= targetWidth) return widths;
  const scale = targetWidth / total;
  return widths.map((w) => w * scale);
}

/**
 * Renders one table as a PNG buffer, at whatever size it takes to show
 * every column and row in full — no count-based limit here. Column widths
 * are smart-allocated (see waterFillWidths) against MAX_TABLE_WIDTH by
 * default: a column that needs little space doesn't waste it, a column
 * that needs more gets what the others don't need, and only if everyone
 * combined still doesn't fit does anything actually compress.
 *
 * `columnWidths`, if passed, is used verbatim instead — this is how
 * renderTableImages() enforces one consistent width across every image in
 * a multi-image split (see there for why). Most callers should omit it.
 *
 * Callers that can't guarantee a single image stays a comfortable overall
 * size should use renderTableImages() instead, which measures content
 * first and splits into multiple appropriately-sized images.
 * @param {{ title?: string, columns: string[], rows: Array<Array<string|number>>, columnWidths?: number[] }} table
 * @returns {Buffer}
 */
export function renderTableImage({ title, columns, rows, columnWidths } = {}) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('renderTableImage: "columns" must be a non-empty array');
  }
  if (!Array.isArray(rows)) {
    throw new Error('renderTableImage: "rows" must be an array');
  }

  const normalizedColumns = columns.map((c) => String(c ?? ''));
  // Defensive against malformed AI output: pad/truncate every row to exactly
  // match the column count, so a short or long row can't throw off layout.
  const normalizedRows = rows.map((row) =>
    normalizedColumns.map((_, i) => (Array.isArray(row) ? row[i] ?? '' : ''))
  );

  // A scratch canvas purely for text measurement, before we know the real
  // canvas size — which itself depends on the measured column widths.
  const measure = createCanvas(10, 10).getContext('2d');

  // A column counts as numeric if every NON-BLANK cell in it looks
  // numeric — a single blank/pending entry (no value yet) shouldn't knock
  // an otherwise all-numeric column out of right-alignment. An entirely
  // blank column has nothing to judge by, so it's left-aligned like text.
  const numericCol = normalizedColumns.map((_, i) => {
    const nonBlank = normalizedRows.map((r) => r[i]).filter((v) => String(v ?? '').trim() !== '');
    return nonBlank.length > 0 && nonBlank.every((v) => looksNumeric(v));
  });

  let finalColWidths;
  if (Array.isArray(columnWidths)) {
    finalColWidths = columnWidths;
  } else {
    measure.font = `bold 15px "${FONT_FAMILY}"`;
    const rawWidths = normalizedColumns.map((c) => measure.measureText(c).width);
    measure.font = '14px "' + FONT_FAMILY + '"';
    normalizedRows.forEach((row) => {
      row.forEach((cell, i) => {
        const w = measure.measureText(cell).width;
        if (w > rawWidths[i]) rawWidths[i] = w;
      });
    });
    const desired = rawWidths.map((w) => Math.max(MIN_COL_W, w + PAD_X * 2));
    finalColWidths = waterFillWidths(desired, MAX_TABLE_WIDTH);
  }

  let tableWidth = finalColWidths.reduce((a, b) => a + b, 0);
  // A narrow table (few columns, e.g. one column-group of a wide-table
  // split) must never force its own title to truncate — the title is what
  // tells a reader which part they're looking at. Widen the table to fit
  // the title if the columns alone don't.
  if (title) {
    measure.font = `bold 17px "${FONT_FAMILY}"`;
    const titleWidth = measure.measureText(String(title)).width + PAD_X * 2;
    tableWidth = Math.max(tableWidth, titleWidth);
  }

  // Wrap the header and every cell against the FINAL column widths, so we
  // know each row's real height before drawing anything.
  measure.font = `bold 15px "${FONT_FAMILY}"`;
  let headerLines = 1;
  const wrappedHeader = normalizedColumns.map((c, i) => {
    const lines = wrapText(measure, c, finalColWidths[i] - PAD_X * 2);
    if (lines.length > headerLines) headerLines = lines.length;
    return lines;
  });
  const headerHeight = headerLines * LINE_H + HEADER_V_PAD;

  measure.font = '14px "' + FONT_FAMILY + '"';
  const wrappedRows = normalizedRows.map((row) => {
    let lines = 1;
    const wrappedCells = row.map((cell, i) => {
      const ls = wrapText(measure, cell, finalColWidths[i] - PAD_X * 2);
      if (ls.length > lines) lines = ls.length;
      return ls;
    });
    return { wrappedCells, height: lines * LINE_H + ROW_V_PAD };
  });

  const titleH = title ? TITLE_H : 0;
  const tableHeight = titleH + headerHeight + wrappedRows.reduce((sum, r) => sum + r.height, 0);

  const canvas = createCanvas(tableWidth * SCALE, tableHeight * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'middle';

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, tableWidth, tableHeight);

  let y = 0;
  if (title) {
    ctx.fillStyle = COLORS.textPrimary;
    ctx.font = `bold 17px "${FONT_FAMILY}"`;
    ctx.fillText(truncateToWidth(ctx, String(title), tableWidth - PAD_X * 2), PAD_X, y + titleH / 2);
    y += titleH;
  }

  function drawWrappedRow({ wrappedCells, rowY, rowHeight, background, font, textColor }) {
    ctx.fillStyle = background;
    ctx.fillRect(0, rowY, tableWidth, rowHeight);
    ctx.font = font;
    ctx.fillStyle = textColor;
    let x = 0;
    wrappedCells.forEach((lines, i) => {
      const w = finalColWidths[i];
      const blockHeight = lines.length * LINE_H;
      let lineY = rowY + (rowHeight - blockHeight) / 2 + LINE_H / 2;
      lines.forEach((line) => {
        const textWidth = ctx.measureText(line).width;
        const textX = numericCol[i] ? x + w - PAD_X - textWidth : x + PAD_X;
        ctx.fillText(line, textX, lineY);
        lineY += LINE_H;
      });
      x += w;
    });
  }

  drawWrappedRow({
    wrappedCells: wrappedHeader, rowY: y, rowHeight: headerHeight,
    background: COLORS.header, font: `bold 15px "${FONT_FAMILY}"`, textColor: COLORS.textPrimary,
  });
  y += headerHeight;

  wrappedRows.forEach((r, i) => {
    drawWrappedRow({
      wrappedCells: r.wrappedCells, rowY: y, rowHeight: r.height,
      background: i % 2 === 0 ? COLORS.rowEven : COLORS.rowOdd,
      font: `14px "${FONT_FAMILY}"`, textColor: COLORS.textBody,
    });
    y += r.height;
  });

  ctx.strokeStyle = COLORS.separator;
  ctx.lineWidth = 1;
  let sepX = 0;
  for (let i = 0; i < finalColWidths.length - 1; i++) {
    sepX += finalColWidths[i];
    ctx.beginPath();
    ctx.moveTo(sepX, titleH);
    ctx.lineTo(sepX, tableHeight);
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}

/**
 * Splits a table into as many images as needed so no individual image ever
 * exceeds MAX_TABLE_WIDTH x MAX_TABLE_HEIGHT — a hard guarantee, not a
 * request. The AI is instructed (see ai/gemini.js) to pre-split wide/tall
 * results itself with sensible titles and column groupings where it can,
 * since it can make semantically meaningful choices (e.g. "core details"
 * vs "amounts") that this function can't — but it has no way to know exact
 * pixel sizes in advance, so this is the backstop that guarantees no
 * column or row is ever silently dropped regardless of what the AI sends,
 * and regardless of how long any individual header or cell's content is.
 *
 * Two things this specifically fixes over a naive per-column cap:
 *
 * 1. Smart allocation: columns are sized with waterFillWidths (see above),
 *    so a column that needs little width doesn't waste it and a column
 *    that needs more gets what the others didn't need, rather than every
 *    column being squeezed to the same fixed ceiling regardless of need.
 *
 * 2. Consistent sizing across a split: when the data needs more than one
 *    column-group (e.g. a "core details" table and an "amounts" table),
 *    later groups with less content would otherwise render narrower than
 *    earlier ones — which makes Discord display them at different
 *    effective zoom/scale, a jarring size change scrolling through what's
 *    meant to be one connected result. When there's more than one column-
 *    group, every group's columns are grown (via growToFill) to the same
 *    shared width, so the whole sequence reads as one consistent report.
 *    A single column-group's own row-parts already share identical column
 *    widths by construction, so this only matters across groups.
 *
 * There is no cap on the number of resulting images — a genuinely large
 * dataset just produces as many as it needs.
 *
 * @param {{ title?: string, columns: string[], rows: Array<Array<string|number>> }} table
 * @returns {Buffer[]} one PNG per image, in reading order
 */
export function renderTableImages({ title, columns, rows } = {}) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('renderTableImages: "columns" must be a non-empty array');
  }
  if (!Array.isArray(rows)) {
    throw new Error('renderTableImages: "rows" must be an array');
  }

  const normalizedColumns = columns.map((c) => String(c ?? ''));
  const measure = createCanvas(10, 10).getContext('2d');

  // Natural (floor-respecting, uncompressed) desired width per column.
  measure.font = `bold 15px "${FONT_FAMILY}"`;
  const headerWidths = normalizedColumns.map((c) => measure.measureText(c).width);
  measure.font = '14px "' + FONT_FAMILY + '"';
  const desiredColWidths = normalizedColumns.map((c, i) => {
    let w = headerWidths[i];
    rows.forEach((row) => {
      const cellW = measure.measureText(String(Array.isArray(row) ? row[i] ?? '' : '')).width;
      if (cellW > w) w = cellW;
    });
    return Math.max(MIN_COL_W, w + PAD_X * 2);
  });

  // Every desired width is already >= MIN_COL_W, so a group of k columns
  // always sums to >= k * MIN_COL_W — meaning water-filling can only
  // guarantee every column at least the floor if k <= MAX_TABLE_WIDTH /
  // MIN_COL_W. That bound is exact regardless of content, so bucketing by
  // this fixed count is equivalent to "keep adding columns as long as
  // fair allocation can still keep everyone legible."
  const maxColsPerGroup = Math.max(1, Math.floor(MAX_TABLE_WIDTH / MIN_COL_W));
  const columnGroups = [];
  for (let i = 0; i < normalizedColumns.length; i += maxColsPerGroup) {
    const indices = [];
    for (let j = i; j < Math.min(i + maxColsPerGroup, normalizedColumns.length); j++) indices.push(j);
    columnGroups.push(indices);
  }

  // Phase 1: for each column group, water-fill its own desired widths
  // against the budget (its "tight" width — compressed only if it has to
  // be) and use that to decide row-chunk boundaries. Wider (stretched)
  // columns can only wrap LESS than this estimate, so using the tight
  // width here is a safe, conservative basis for where to break rows.
  const groups = columnGroups.map((colIndices, colGroupIdx) => {
    const groupDesired = colIndices.map((i) => desiredColWidths[i]);
    const tightWidths = waterFillWidths(groupDesired, MAX_TABLE_WIDTH);
    const groupColumns = colIndices.map((i) => normalizedColumns[i]);

    measure.font = `bold 15px "${FONT_FAMILY}"`;
    let headerLines = 1;
    groupColumns.forEach((c, j) => {
      const lines = wrapText(measure, c, tightWidths[j] - PAD_X * 2).length;
      if (lines > headerLines) headerLines = lines;
    });
    const headerHeight = headerLines * LINE_H + HEADER_V_PAD;

    measure.font = '14px "' + FONT_FAMILY + '"';
    const rowHeights = rows.map((row) => {
      let lines = 1;
      colIndices.forEach((i, j) => {
        const cellText = String(Array.isArray(row) ? row[i] ?? '' : '');
        const cellLines = wrapText(measure, cellText, tightWidths[j] - PAD_X * 2).length;
        if (cellLines > lines) lines = cellLines;
      });
      return lines * LINE_H + ROW_V_PAD;
    });

    const titleHGuess = title ? TITLE_H : 0;
    const budget = Math.max(1, MAX_TABLE_HEIGHT - titleHGuess - headerHeight);
    const rowChunks = [];
    {
      let idxs = [];
      let height = 0;
      rows.forEach((_, rIdx) => {
        const h = rowHeights[rIdx];
        if (idxs.length > 0 && height + h > budget) {
          rowChunks.push(idxs);
          idxs = [];
          height = 0;
        }
        idxs.push(rIdx);
        height += h;
      });
      if (idxs.length > 0 || rows.length === 0) rowChunks.push(idxs);
    }

    return { colIndices, groupColumns, tightWidths, rowChunks };
  });

  // Phase 2: decide the shared render width. Only matters when there's
  // more than one column-group — a single group's row-parts already
  // share identical widths by construction, so forcing them to the full
  // budget would just needlessly puff up an otherwise-compact small table.
  const shouldMatchWidth = groups.length > 1;
  const buffers = [];

  groups.forEach(({ colIndices, groupColumns, tightWidths, rowChunks }, colGroupIdx) => {
    const renderWidths = shouldMatchWidth ? growToFill(tightWidths, MAX_TABLE_WIDTH) : tightWidths;

    rowChunks.forEach((rowIdxs, rowChunkIdx) => {
      const groupRows = rowIdxs.map((rIdx) =>
        colIndices.map((i) => (Array.isArray(rows[rIdx]) ? rows[rIdx][i] ?? '' : ''))
      );

      const labelParts = [];
      if (groups.length > 1) labelParts.push(`fields ${colGroupIdx + 1}/${groups.length}`);
      if (rowChunks.length > 1) labelParts.push(`part ${rowChunkIdx + 1}/${rowChunks.length}`);
      const groupTitle = labelParts.length === 0
        ? title
        : title ? `${title} — ${labelParts.join(', ')}` : labelParts.join(', ');

      buffers.push(renderTableImage({
        title: groupTitle,
        columns: groupColumns,
        rows: groupRows,
        columnWidths: renderWidths,
      }));
    });
  });

  return buffers;
}
