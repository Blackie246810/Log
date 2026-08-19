import { askAi } from './ai/gemini.js';
import { logError } from './errorReporter.js';

const DISCORD_MESSAGE_LIMIT = 2000;

export async function handleAiMessage(message) {
  if (message.author.bot) return;
  if (message.author.id !== process.env.DISCORD_OWNER_ID) return;

  const text = message.content?.trim();
  if (!text) return;

  try {
    await message.channel.sendTyping();
  } catch {
    // cosmetic only
  }

  try {
    const reply = await askAi(text, message.client.user.username);
    await message.reply(reply.slice(0, DISCORD_MESSAGE_LIMIT));
  } catch (err) {
    logError('ai message handler', err);
    await message.reply('Something went wrong asking the AI. Check the console for details.');
  }
}