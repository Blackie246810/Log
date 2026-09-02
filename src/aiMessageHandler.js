import { AttachmentBuilder } from 'discord.js';
import { askAi, AllKeysExhaustedError } from './ai/gemini.js';
import { logError, describeError } from './errorReporter.js';
import { renderTableImages, MAX_TABLES_PER_MESSAGE } from './tableImage.js';
import { buildAttachmentParts } from './ai/attachments.js';
import { extractFileAttachments } from './ai/outgoingFiles.js';

const DISCORD_MESSAGE_LIMIT = 2000;
const TYPING_REFRESH_MS = 8000;
const TABLE_BLOCK_RE = /```table\s*\n([\s\S]*?)\n```/gi;

// How fast the placeholder's dots/word cycle — kept snappy on purpose so the
// wait doesn't feel dead. Discord's per-message edit rate limit can't
// actually keep up with 500ms if it ever gets hit, so the animator below
// skips a frame rather than queueing up when an edit is still in flight.
const LOADER_TICK_MS = 500;
const LOADER_DOTS = ['', '.', '..', '...'];

// Rotated through while we're waiting on the AI itself.
const THINKING_WORDS = [
  'Thinking',
  'Pondering',
  'Mulling it over',
  'Ruminating',
  'Contemplating',
  'Fathoming',
  'Percolating',
  'Noodling',
  'Chewing on it',
  'Deliberating',
];

// Rotated through once we have a reply and are rendering tables/files and
// assembling the actual Discord message(s) to send.
const ANSWERING_WORDS = [
  'Answering',
  'Composing',
  'Drafting',
  'Writing it up',
  'Putting it together',
  'Wrapping up',
];

// Cycles a placeholder message through "<Word><dots>" frames, e.g.
// "Thinking" -> "Thinking." -> "Thinking.." -> "Thinking..." -> "Fathoming"
// -> ... A full dot cycle completes before the word changes. Skips a tick
// if the previous edit hasn't resolved yet, so a rate-limited edit can't
// pile up a backlog of queued requests.
function createLoaderAnimator(placeholder, words) {
  let step = 0;
  let wordIndex = 0;
  let timer = null;
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    const label = words[wordIndex % words.length];
    const dots = LOADER_DOTS[step % LOADER_DOTS.length];
    step++;
    if (step % LOADER_DOTS.length === 0) wordIndex++;
    try {
      await placeholder.edit(`${label}${dots}`);
    } catch {
      // cosmetic only
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      tick();
      timer = setInterval(tick, LOADER_TICK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function extractTableImages(text) {
  TABLE_BLOCK_RE.lastIndex = 0;
  const attachments = [];
  const warnings = [];

  // No cap here on purpose: a genuinely large result set is meant to span
  // as many images/messages as it needs (see ai/gemini.js) rather than
  // being cut off at some arbitrary count.
  for (const match of text.matchAll(TABLE_BLOCK_RE)) {
    try {
      const parsed = JSON.parse(match[1]);
      const buffers = renderTableImages(parsed); // may expand one block into several images
      buffers.forEach((buffer) => {
        attachments.push(new AttachmentBuilder(buffer, { name: `table_${attachments.length + 1}.png` }));
      });
    } catch (err) {
      logError('extractTableImages: malformed table JSON', err);
      const label = err instanceof Error ? err.message : String(err);
      warnings.push(`A table the AI tried to show couldn't be rendered (${label}) — ask it to resend that result.`);
    }
  }

  const remainingText = text
    .replace(TABLE_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { attachments, warnings, remainingText };
}

// Discord allows at most MAX_TABLES_PER_MESSAGE attachments per message —
// a bigger result set (table images and/or ```file``` blocks, see
// ai/outgoingFiles.js) means more messages, not more attachments crammed
// into one. Splits the flat attachment list into legal-sized chunks.
function chunkAttachments(attachments) {
  const chunks = [];
  for (let i = 0; i < attachments.length; i += MAX_TABLES_PER_MESSAGE) {
    chunks.push(attachments.slice(i, i + MAX_TABLES_PER_MESSAGE));
  }
  return chunks;
}

// Discord rejects any message over DISCORD_MESSAGE_LIMIT characters — a
// reply that runs longer than that is meant to continue as further
// messages, not get cut off. Splits on the last newline within the limit,
// falling back to the last space, so we never break mid-word/mid-sentence
// unless a single "word" itself exceeds the limit.
function splitTextIntoChunks(text, limit = DISCORD_MESSAGE_LIMIT) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function handleAiMessage(message) {
  if (message.author.bot) return;
  if (message.author.id !== process.env.DISCORD_OWNER_ID) return;

  const text = message.content?.trim() ?? '';
  // Attachments (receipts, statements, screenshots, ...) can carry the
  // whole request on their own, so a message isn't ignored just because
  // it has no text — only when it has neither text nor any attachments.
  if (!text && message.attachments.size === 0) return;

  const { parts: attachmentParts, meta: attachmentMeta, warnings: attachmentWarnings } = await buildAttachmentParts(message);

  // Every attachment got skipped (unsupported/too large/etc.) and there's
  // no text to fall back on — nothing to actually send the AI, so just
  // report why instead of asking it to answer an empty message.
  if (!text && attachmentParts.length === 0) {
    try {
      await message.reply(`Couldn't use any of those files:\n${attachmentWarnings.map((w) => `- ${w}`).join('\n')}`);
    } catch (err) {
      logError('ai message handler: attachment-skip reply failed', err);
    }
    return;
  }

  let placeholder;
  try {
    placeholder = await message.reply('Thinking');
  } catch (err) {
    logError('ai message handler: placeholder send failed', err);
    return;
  }

  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {
      // cosmetic only
    });
  }, TYPING_REFRESH_MS);

  const thinkingLoader = createLoaderAnimator(placeholder, THINKING_WORDS);
  thinkingLoader.start();
  let answeringLoader = null;

  try {
    const reply = await askAi(text, message.client.user.username, undefined, attachmentParts, attachmentMeta);
    thinkingLoader.stop();

    answeringLoader = createLoaderAnimator(placeholder, ANSWERING_WORDS);
    answeringLoader.start();

    const { attachments: tableAttachments, warnings: tableWarnings, remainingText: afterTables } = extractTableImages(reply);
    const { attachments: fileAttachments, warnings: fileWarnings, remainingText } = extractFileAttachments(afterTables);
    const attachments = [...tableAttachments, ...fileAttachments];

    // Incoming-attachment warnings (files skipped on the way in) and
    // outgoing ones (a table or file the AI tried to send that couldn't be
    // built) are both "this thing didn't make it, here's why" — reported
    // the same way rather than the outgoing half silently vanishing.
    const allWarnings = [...attachmentWarnings, ...tableWarnings, ...fileWarnings];
    const warningFooter = allWarnings.length
      ? `\n\n-# Skipped: ${allWarnings.join('; ')}`
      : '';
    const textChunks = splitTextIntoChunks(remainingText + warningFooter, DISCORD_MESSAGE_LIMIT);
    const attachmentChunks = chunkAttachments(attachments);

    // First chunk of text (and/or the first batch of table images, if there
    // were any) replaces the "Thinking..." placeholder. Any further text or
    // attachment chunks are genuinely separate Discord messages, sent right
    // after — this is what lets a long reply keep going instead of getting
    // cut off, and lets more than 10 table images ship for one reply.
    const firstPayload = {};
    if (textChunks[0]) firstPayload.content = textChunks[0];
    if (attachmentChunks[0]) firstPayload.files = attachmentChunks[0];
    if (!firstPayload.content && !firstPayload.files) firstPayload.content = "Here's what I found.";

    answeringLoader.stop();
    await placeholder.edit(firstPayload);

    for (let i = 1; i < textChunks.length; i++) {
      await message.channel.send({ content: textChunks[i] });
    }

    for (let i = 1; i < attachmentChunks.length; i++) {
      await message.channel.send({
        content: `-# continued (${i + 1}/${attachmentChunks.length})`,
        files: attachmentChunks[i],
      });
    }
  } catch (err) {
    logError('ai message handler', err);
    // All-keys-exhausted gets its own clean, purpose-written message
    // (see gemini.js) instead of running the raw error through the
    // that generic path would otherwise forward the raw provider error,
    // which often contains a doc URL that Discord auto-unfurls into a
    // distracting link-preview card.
    const text = err instanceof AllKeysExhaustedError
      ? err.message
      : `Something went wrong: ${describeError(err).message}`;
    await placeholder.edit(text);
  } finally {
    clearInterval(typingInterval);
    thinkingLoader.stop();
    if (answeringLoader) answeringLoader.stop();
  }
}