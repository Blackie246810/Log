import { askAi } from './ai/gemini.js';
import { logError } from './errorReporter.js';
import { buildTableEmbed } from './embeds.js';

const DISCORD_MESSAGE_LIMIT = 2000;
const TYPING_REFRESH_MS = 8000;
const TABLE_BLOCK_RE = /```table\s*\n([\s\S]*?)\n```/gi;
const DISCORD_MAX_EMBEDS_PER_MESSAGE = 10;

function extractTableBlocks(text) {
  TABLE_BLOCK_RE.lastIndex = 0;
  const embeds = [];

  for (const match of text.matchAll(TABLE_BLOCK_RE)) {
    try {
      const parsed = JSON.parse(match[1]);
      const embed = buildTableEmbed(parsed);
      if (embed) embeds.push(embed);
    } catch (err) {
      logError('extractTableBlocks: malformed table JSON', err);
    }
  }

  const remainingText = text
    .replace(TABLE_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { embeds: embeds.slice(0, DISCORD_MAX_EMBEDS_PER_MESSAGE), remainingText };
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
    const { embeds, remainingText } = extractTableBlocks(reply);

    const payload = {};
    if (remainingText) payload.content = remainingText.slice(0, DISCORD_MESSAGE_LIMIT);
    if (embeds.length > 0) payload.embeds = embeds;
    if (!payload.content && !payload.embeds) payload.content = "Here's what I found.";

    await placeholder.edit(payload);
  } catch (err) {
    logError('ai message handler', err);
    await placeholder.edit('Something went wrong asking the AI. Check the console for details.');
  } finally {
    clearInterval(typingInterval);
  }
}