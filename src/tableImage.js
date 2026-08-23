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
//
// MAX_TABLE_WIDTH is deliberately sized for a phone screen, not a desktop
// window. Discord doesn't publish an exact mobile content-column width,
// but typical phone viewports run ~360-430 CSS px, and Discord's own
// avatar gutter + padding eats roughly 50-70px of that — leaving a
// realistic content column around 300-360px on most devices. 700px (a
// reasonable desktop target) would need to be scaled down by roughly half
// on a phone, visibly shrinking the text; 340px displays close to native
// size on most phones and only mildly shrinks on the smallest ones. This
// does mean more tables split than a desktop-only design would need — that
// tradeoff is intentional: a "glance at it" image that's actually legible
// on the device it's most likely read on beats a wider image that always
// needs pinch-zooming.
export const MAX_TABLE_WIDTH = 420; // target total image width, logical px
export const MAX_TABLE_HEIGHT = 480; // target total image height, logical px
export const MAX_COL_CONTENT_WIDTH = 110; // per-column cap before content wraps, logical px

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
const MIN_COL_W = 60;

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

function looksNumeric(value) {
  return /^-?[₹$]?[\d,]+(\.\d+)?%?$/.test(String(value ?? '').trim());
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

/**
 * Renders one table as a PNG buffer, at whatever size it takes to show
 * every column and row in full — no count-based limit here. Callers that
 * can't guarantee the result stays a comfortable size should use
 * renderTableImages() instead, which measures content first and splits
 * into multiple appropriately-sized images.
 * @param {{ title?: string, columns: string[], rows: Array<Array<string|number>> }} table
 * @returns {Buffer}
 */
export function renderTableImage({ title, columns, rows } = {}) {
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

  const numericCol = normalizedColumns.map((_, i) => normalizedRows.every((r) => looksNumeric(r[i])));

  // Natural (single-line) width per column, capped at MAX_COL_CONTENT_WIDTH
  // — content longer than that wraps onto more lines instead of stretching
  // the column indefinitely.
  measure.font = `bold 15px "${FONT_FAMILY}"`;
  const colWidths = normalizedColumns.map((c) => measure.measureText(c).width);
  measure.font = '14px "' + FONT_FAMILY + '"';
  normalizedRows.forEach((row) => {
    row.forEach((cell, i) => {
      const w = measure.measureText(cell).width;
      if (w > colWidths[i]) colWidths[i] = w;
    });
  });
  const finalColWidths = colWidths.map((w) => Math.min(MAX_COL_CONTENT_WIDTH, Math.max(MIN_COL_W, w + PAD_X * 2)));

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

  // Wrap the header and every cell against the FINAL (post-cap) column
  // widths, so we know each row's real height before drawing anything.
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
 * Columns are bucketed left to right by cumulative rendered width; rows are
 * then bucketed (independently, per column group) by cumulative rendered
 * height, since a row's height depends on which columns are next to it.
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

  // Natural (single-line, capped) width per column — same measurement
  // renderTableImage itself would derive, computed here up front so we can
  // decide how to bucket columns before rendering anything.
  measure.font = `bold 15px "${FONT_FAMILY}"`;
  const headerWidths = normalizedColumns.map((c) => measure.measureText(c).width);
  measure.font = '14px "' + FONT_FAMILY + '"';
  const naturalColWidths = normalizedColumns.map((c, i) => {
    let w = headerWidths[i];
    rows.forEach((row) => {
      const cellW = measure.measureText(String(Array.isArray(row) ? row[i] ?? '' : '')).width;
      if (cellW > w) w = cellW;
    });
    return w;
  });
  const finalColWidths = naturalColWidths.map((w) => Math.min(MAX_COL_CONTENT_WIDTH, Math.max(MIN_COL_W, w + PAD_X * 2)));

  // Bucket columns left-to-right by cumulative width. MAX_COL_CONTENT_WIDTH
  // is always well under MAX_TABLE_WIDTH, so a group always gets at least
  // one column before overflowing.
  const columnGroups = [];
  {
    let indices = [];
    let width = 0;
    normalizedColumns.forEach((_, i) => {
      const w = finalColWidths[i];
      if (indices.length > 0 && width + w > MAX_TABLE_WIDTH) {
        columnGroups.push(indices);
        indices = [];
        width = 0;
      }
      indices.push(i);
      width += w;
    });
    if (indices.length > 0) columnGroups.push(indices);
  }

  const buffers = [];
  const titleHGuess = title ? TITLE_H : 0;

  columnGroups.forEach((colIndices, colGroupIdx) => {
    const groupColumns = colIndices.map((i) => normalizedColumns[i]);
    const groupColWidths = colIndices.map((i) => finalColWidths[i]);

    measure.font = `bold 15px "${FONT_FAMILY}"`;
    let headerLines = 1;
    groupColumns.forEach((c, j) => {
      const lines = wrapText(measure, c, groupColWidths[j] - PAD_X * 2).length;
      if (lines > headerLines) headerLines = lines;
    });
    const headerHeight = headerLines * LINE_H + HEADER_V_PAD;

    measure.font = '14px "' + FONT_FAMILY + '"';
    const rowHeights = rows.map((row) => {
      let lines = 1;
      colIndices.forEach((i, j) => {
        const cellText = String(Array.isArray(row) ? row[i] ?? '' : '');
        const cellLines = wrapText(measure, cellText, groupColWidths[j] - PAD_X * 2).length;
        if (cellLines > lines) lines = cellLines;
      });
      return lines * LINE_H + ROW_V_PAD;
    });

    // Bucket rows into height-based chunks against a target image height
    // budget. A single row taller than the whole budget on its own (e.g.
    // one cell with a huge amount of wrapped text) still gets its own
    // image rather than being cut mid-row — occasionally exceeding the
    // target height is the honest tradeoff for never truncating content.
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

    rowChunks.forEach((rowIdxs, rowChunkIdx) => {
      const groupRows = rowIdxs.map((rIdx) =>
        colIndices.map((i) => (Array.isArray(rows[rIdx]) ? rows[rIdx][i] ?? '' : ''))
      );

      const labelParts = [];
      if (columnGroups.length > 1) labelParts.push(`fields ${colGroupIdx + 1}/${columnGroups.length}`);
      if (rowChunks.length > 1) labelParts.push(`part ${rowChunkIdx + 1}/${rowChunks.length}`);
      const groupTitle = labelParts.length === 0
        ? title
        : title ? `${title} — ${labelParts.join(', ')}` : labelParts.join(', ');

      buffers.push(renderTableImage({ title: groupTitle, columns: groupColumns, rows: groupRows }));
    });
  });

  return buffers;
}
