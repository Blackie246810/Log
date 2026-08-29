// Turns a Discord message's attachments into Gemini `inlineData` parts.
//
// Gemini's inline-data path (base64 embedded directly in the request) is
// used rather than the Files API on purpose: inline parts round-trip
// cleanly through the JSONB "Content" column in Postgres (see db.js) and
// never expire, whereas Files API uploads expire after 48h and would
// silently break re-sent conversation history. The trade-off is a request
// size cap, so we enforce conservative per-file/per-message limits below.

import { logError } from '../errorReporter.js';
import path from 'node:path';

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB per file
const MAX_TOTAL_BYTES = 18 * 1024 * 1024; // headroom under Gemini's ~20MB inline request cap
const MAX_FILES = 5;

// Gemini accepts these broad families as inline data. Discord's reported
// contentType is trusted first; unknown/missing types are still attempted
// under a generic fallback so e.g. a mislabeled .csv isn't rejected outright.
const ALLOWED_PREFIXES = ['image/', 'audio/', 'video/', 'text/'];
const ALLOWED_EXACT = ['application/pdf', 'application/json', 'application/rtf'];

// Discord frequently reports no contentType at all (undefined) — or a
// useless generic one — for perfectly normal files (CSV exports, .log
// files, some mobile-uploaded images/voice notes). When that happens we
// used to fall back to 'application/octet-stream', which then failed the
// "supported" check below and got the file skipped even though Gemini
// would have handled it fine. Guess from the extension first instead.
const EXTENSION_MIME_FALLBACK = {
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.rtf': 'application/rtf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

// Discord's declared contentType wins when it's actually informative;
// otherwise fall back to guessing from the filename extension, and only
// give up to the generic 'application/octet-stream' if neither knows.
function resolveMimeType(attachment) {
  const declared = attachment.contentType?.split(';')[0]?.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;

  const ext = path.extname(attachment.name || '').toLowerCase();
  return EXTENSION_MIME_FALLBACK[ext] || declared || 'application/octet-stream';
}

function isSupportedMimeType(mimeType) {
  if (!mimeType) return false;
  const type = mimeType.split(';')[0].trim().toLowerCase();
  // Truly unknown type (no useful contentType AND no recognized extension) —
  // still worth attempting rather than skipping outright, per the comment
  // above; Gemini (or our own error handling) will surface a clear failure
  // if it genuinely can't process it.
  if (type === 'application/octet-stream') return true;
  return ALLOWED_PREFIXES.some((p) => type.startsWith(p)) || ALLOWED_EXACT.includes(type);
}

// Downloads every attachment on `message`, validates size/type, and returns
// Gemini-ready inline parts plus lightweight metadata (used later to
// sanitize conversation history — see gemini.js). Anything skipped is
// reported back as a human-readable warning instead of failing the whole
// message.
export async function buildAttachmentParts(message) {
  const parts = [];
  const meta = [];
  const warnings = [];

  if (!message.attachments || message.attachments.size === 0) {
    return { parts, meta, warnings };
  }

  let totalBytes = 0;
  let count = 0;

  for (const attachment of message.attachments.values()) {
    if (count >= MAX_FILES) {
      warnings.push(`${attachment.name}: skipped (max ${MAX_FILES} files per message)`);
      continue;
    }

    const mimeType = resolveMimeType(attachment);
    if (!isSupportedMimeType(mimeType)) {
      warnings.push(`${attachment.name}: skipped (unsupported file type "${mimeType}")`);
      continue;
    }

    if (attachment.size > MAX_FILE_BYTES) {
      warnings.push(`${attachment.name}: skipped (over ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB)`);
      continue;
    }

    if (totalBytes + attachment.size > MAX_TOTAL_BYTES) {
      warnings.push(`${attachment.name}: skipped (message attachment total too large)`);
      continue;
    }

    try {
      const res = await fetch(attachment.url);
      if (!res.ok) {
        warnings.push(`${attachment.name}: skipped (download failed, HTTP ${res.status})`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const base64 = buffer.toString('base64');

      parts.push({ inlineData: { mimeType, data: base64 } });
      meta.push({ name: attachment.name, mimeType });
      totalBytes += attachment.size;
      count++;
    } catch (err) {
      logError('buildAttachmentParts: download failed', err);
      warnings.push(`${attachment.name}: skipped (download error)`);
    }
  }

  return { parts, meta, warnings };
}
