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

const FILE_BLOCK_RE = /```file\s*\n([\s\S]*?)\n```/gi;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // keeps well under Discord's DM upload cap

function safeFilename(name) {
  const fallback = 'file.txt';
  if (typeof name !== 'string' || !name.trim()) return fallback;
  // Strip path separators and anything else that could confuse Discord's
  // attachment upload — this only needs to be a display name, not a path.
  const cleaned = name.replace(/[/\\]/g, '_').trim();
  return cleaned.slice(0, 200) || fallback;
}

// Parses every ```file``` block out of `text`, returning real Discord
// attachments plus the text with those blocks removed (mirrors
// extractTableImages in aiMessageHandler.js). Malformed or oversized blocks
// are dropped with a logged error rather than breaking the whole reply.
export function extractFileAttachments(text) {
  FILE_BLOCK_RE.lastIndex = 0;
  const attachments = [];

  for (const match of text.matchAll(FILE_BLOCK_RE)) {
    try {
      const parsed = JSON.parse(match[1]);
      const encoding = parsed.encoding === 'base64' ? 'base64' : 'utf8';
      const buffer = Buffer.from(String(parsed.content ?? ''), encoding);

      if (buffer.length === 0) {
        logError('extractFileAttachments: empty file block', new Error(parsed.filename ?? 'unnamed'));
        continue;
      }
      if (buffer.length > MAX_FILE_BYTES) {
        logError('extractFileAttachments: file block too large', new Error(`${parsed.filename ?? 'unnamed'} (${buffer.length} bytes)`));
        continue;
      }

      attachments.push(new AttachmentBuilder(buffer, { name: safeFilename(parsed.filename) }));
    } catch (err) {
      logError('extractFileAttachments: malformed file JSON', err);
    }
  }

  const remainingText = text
    .replace(FILE_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { attachments, remainingText };
}
