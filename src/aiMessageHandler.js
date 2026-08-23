import { AttachmentBuilder } from 'discord.js';
import { askAi } from './ai/gemini.js';
import { logError } from './errorReporter.js';
import { renderTableImages, MAX_TABLES_PER_MESSAGE } from './tableImage.js';

const DISCORD_MESSAGE_LIMIT = 2000;
const TYPING_REFRESH_MS = 8000;
const TABLE_BLOCK_RE = /```table\s*\n([\s\S]*?)\n```/gi;

function extractTableImages(text) {
  TABLE_BLOCK_RE.lastIndex = 0;
  const attachments = [];

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
    }
  }

  const remainingText = text
    .replace(TABLE_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { attachments, remainingText };
}

// Discord allows at most MAX_TABLES_PER_MESSAGE attachments per message —
// a bigger result set means more messages, not more attachments crammed
// into one. Splits the flat attachment list into legal-sized chunks.
function chunkAttachments(attachments) {
  const chunks = [];
  for (let i = 0; i < attachments.length; i += MAX_TABLES_PER_MESSAGE) {
    chunks.push(attachments.slice(i, i + MAX_TABLES_PER_MESSAGE));
  }
  return chunks;
}

export async function handleAiMessage(message) {
  if (message.author.bot) return;
  if (message.author.id !== process.env.DISCORD_OWNER_ID) return;

  const text = message.content?.trim();
  if (!text) return;

  let placeholder;
  try {
    placeholder = await message.reply('Thinking...');
  } catch (err) {
    logError('ai message handler: placeholder send failed', err);
    return;
  }

  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {
      // cosmetic only
    });
  }, TYPING_REFRESH_MS);

  try {
    const reply = await askAi(text, message.client.user.username);
    const { attachments, remainingText } = extractTableImages(reply);
    const chunks = chunkAttachments(attachments);

    // First chunk (or plain text, if there were no tables at all) replaces
    // the "Thinking..." placeholder. Any further chunks are genuinely
    // separate Discord messages, sent right after — Discord's own 10-file
    // limit means this is the only way to deliver more than 10 table
    // images for one reply.
    const firstPayload = {};
    if (remainingText) firstPayload.content = remainingText.slice(0, DISCORD_MESSAGE_LIMIT);
    if (chunks[0]) firstPayload.files = chunks[0];
    if (!firstPayload.content && !firstPayload.files) firstPayload.content = "Here's what I found.";

    await placeholder.edit(firstPayload);

    for (let i = 1; i < chunks.length; i++) {
      await message.channel.send({
        content: `-# continued (${i + 1}/${chunks.length})`,
        files: chunks[i],
      });
    }
  } catch (err) {
    logError('ai message handler', err);
    await placeholder.edit('Something went wrong asking the AI. Check the console for details.');
  } finally {
    clearInterval(typingInterval);
  }
}