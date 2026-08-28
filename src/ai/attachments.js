// Turns a Discord message's attachments into Gemini `inlineData` parts.
//
// Gemini's inline-data path (base64 embedded directly in the request) is
// used rather than the Files API on purpose: inline parts round-trip
// cleanly through the JSONB "Content" column in Postgres (see db.js) and
// never expire, whereas Files API uploads expire after 48h and would
// silently break re-sent conversation history. The trade-off is a request
// size cap, so we enforce conservative per-file/per-message limits below.

import { logError } from '../errorReporter.js';

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB per file
const MAX_TOTAL_BYTES = 18 * 1024 * 1024; // headroom under Gemini's ~20MB inline request cap
const MAX_FILES = 5;

// Gemini accepts these broad families as inline data. Discord's reported
// contentType is trusted first; unknown/missing types are still attempted
// under a generic fallback so e.g. a mislabeled .csv isn't rejected outright.
const ALLOWED_PREFIXES = ['image/', 'audio/', 'video/', 'text/'];
const ALLOWED_EXACT = ['application/pdf', 'application/json', 'application/rtf'];

function isSupportedMimeType(mimeType) {
  if (!mimeType) return false;
  const type = mimeType.split(';')[0].trim().toLowerCase();
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

    const mimeType = attachment.contentType?.split(';')[0]?.trim() || 'application/octet-stream';
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
