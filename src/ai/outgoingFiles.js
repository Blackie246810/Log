// Lets Gemini send an actual downloadable file into the DM, the same way
// ```table``` blocks (see tableImage.js) let it send a rendered image —
// this is the text-side counterpart for output that should be a real file
// (a CSV export, a text report, a reformatted copy of something the user
// uploaded) rather than chat text or a table image.
//
// The model emits a fenced code block tagged exactly `file` containing
// JSON: {"filename": "...", "mime_type": "...", "encoding": "text"|"base64", "content": "..."}
// — see the format documented in ai/gemini.js's system instruction.

import { AttachmentBuilder } from 'discord.js';
import { logError } from '../errorReporter.js';
import path from 'node:path';

const FILE_BLOCK_RE = /```file\s*\n([\s\S]*?)\n```/gi;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // keeps well under Discord's DM upload cap

// Discord decides how to render an attachment (inline image preview, syntax
// highlighting, etc.) from the filename's extension, not from any mime_type
// field — there isn't one to set on AttachmentBuilder. So if the model gives
// a filename with no extension (or one that disagrees with mime_type), the
// file would still send fine but wouldn't necessarily be treated the way the
// model intended (e.g. a "table" of CSV text with no .csv). Fall back to
// deriving one from mime_type in that case.
const MIME_EXTENSION_FALLBACK = {
  'text/csv': '.csv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/rtf': '.rtf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function safeFilename(name, mimeType) {
  const fallbackExt = MIME_EXTENSION_FALLBACK[String(mimeType ?? '').toLowerCase()] ?? '.txt';
  if (typeof name !== 'string' || !name.trim()) return `file${fallbackExt}`;

  // Strip path separators and anything else that could confuse Discord's
  // attachment upload — this only needs to be a display name, not a path.
  let cleaned = name.replace(/[/\\]/g, '_').trim().slice(0, 200);
  if (!cleaned) cleaned = `file${fallbackExt}`;

  // Only append an extension when there's genuinely none to work with —
  // never override whatever extension the model actually chose.
  if (!path.extname(cleaned)) cleaned += fallbackExt;
  return cleaned;
}

// Parses every ```file``` block out of `text`, returning real Discord
// attachments plus the text with those blocks removed (mirrors
// extractTableImages in aiMessageHandler.js). Malformed or oversized blocks
// are dropped, and reported back as a human-readable warning (surfaced to
// the channel by aiMessageHandler.js) instead of just failing silently.
export function extractFileAttachments(text) {
  FILE_BLOCK_RE.lastIndex = 0;
  const attachments = [];
  const warnings = [];

  for (const match of text.matchAll(FILE_BLOCK_RE)) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch (err) {
      logError('extractFileAttachments: malformed file JSON', err);
      warnings.push('A file the AI tried to send was malformed and could not be attached — ask it to resend the file.');
      continue;
    }

    try {
      const label = typeof parsed.filename === 'string' && parsed.filename.trim() ? parsed.filename : 'unnamed file';
      const encoding = parsed.encoding === 'base64' ? 'base64' : 'utf8';
      const buffer = Buffer.from(String(parsed.content ?? ''), encoding);

      if (buffer.length === 0) {
        logError('extractFileAttachments: empty file block', new Error(label));
        warnings.push(`${label}: the AI sent it with no content — ask it to try again.`);
        continue;
      }
      if (buffer.length > MAX_FILE_BYTES) {
        const limitMb = Math.floor(MAX_FILE_BYTES / (1024 * 1024));
        logError('extractFileAttachments: file block too large', new Error(`${label} (${buffer.length} bytes)`));
        warnings.push(`${label}: too large to send (over ${limitMb}MB) — ask the AI to split it into smaller files or trim the content.`);
        continue;
      }

      attachments.push(new AttachmentBuilder(buffer, { name: safeFilename(parsed.filename, parsed.mime_type) }));
    } catch (err) {
      logError('extractFileAttachments: failed to build attachment', err);
      warnings.push('A file the AI tried to send could not be attached — ask it to resend the file.');
    }
  }

  const remainingText = text
    .replace(FILE_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { attachments, warnings, remainingText };
}
