import { askAi } from './ai/gemini.js';
import { logError } from './errorReporter.js';

const DISCORD_MESSAGE_LIMIT = 2000;
const TYPING_REFRESH_MS = 8000;

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
    await placeholder.edit(reply.slice(0, DISCORD_MESSAGE_LIMIT));
  } catch (err) {
    logError('ai message handler', err);
    await placeholder.edit('Something went wrong asking the AI. Check the console for details.');
  } finally {
    clearInterval(typingInterval);
  }
}