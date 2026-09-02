import { SlashCommandBuilder, InteractionContextType, ChannelType } from 'discord.js';
import { logError, errorDetail } from '../errorReporter.js';
import { clearConversation } from '../ai/gemini.js';

// Discord's bulk-delete endpoint can only touch messages younger than this —
// anything older has to go one-by-one regardless of channel type.
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export const data = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Wipe every message in this channel and forget the conversation so far')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

// Oldest-message-id cursor for paging backwards through history. Snowflake
// IDs are monotonically increasing with time, so a plain BigInt compare
// reliably finds the oldest id in a batch regardless of the order the API
// happened to return them in.
function oldestId(ids) {
  return ids.reduce((min, id) => (BigInt(id) < BigInt(min) ? id : min));
}

export async function execute(interaction) {
  await interaction.deferReply();

  const deferredReply = await interaction.fetchReply();
  const skipId = deferredReply.id;

  const channel = interaction.channel;
  if (!channel) {
    await interaction.editReply({ content: 'Could not access this channel to clear messages.' });
    return;
  }

  // Discord flatly does not allow a bot to delete another user's messages
  // in a DM — that's a platform restriction, not something any amount of
  // code here can work around. In a real server channel (where you're the
  // only one who can actually do anything anyway), that restriction
  // doesn't apply: the bot can delete every message, from anyone,
  // including yours, the same way a human moderator with Manage Messages
  // could.
  const isDM = channel.isDMBased ? channel.isDMBased() : channel.type === ChannelType.DM;
  const canBulkDelete = !isDM && typeof channel.bulkDelete === 'function';
  const clientUserId = interaction.client.user.id;

  // Forget the underlying conversation too, not just the visible Discord
  // messages — otherwise the AI would still remember everything said so
  // far even after the messages themselves are gone. Kept as its own
  // try/catch so a failure here doesn't block deleting the visible
  // messages below (or vice versa).
  let historyCleared = true;
  try {
    await clearConversation();
  } catch (err) {
    historyCleared = false;
    logError('clear command: conversation reset', err);
  }

  let deletedCount = 0;
  let cursor;

  try {
    while (true) {
      const batch = await channel.messages.fetch(cursor ? { limit: 100, before: cursor } : { limit: 100 });
      if (batch.size === 0) break;

      const ids = [...batch.keys()];
      cursor = oldestId(ids);

      const candidates = [...batch.values()].filter((msg) => {
        if (msg.id === skipId) return false;
        // In a DM, Discord only ever lets the bot delete its own messages —
        // filter to those here so the loop below doesn't even attempt (and
        // fail) on the user's own messages.
        if (isDM) return msg.author.id === clientUserId;
        return true;
      });

      if (candidates.length > 0) {
        const now = Date.now();
        const bulkable = canBulkDelete ? candidates.filter((m) => now - m.createdTimestamp < BULK_DELETE_MAX_AGE_MS) : [];
        const individual = canBulkDelete ? candidates.filter((m) => now - m.createdTimestamp >= BULK_DELETE_MAX_AGE_MS) : candidates;

        // bulkDelete needs at least 2 messages — a lone leftover just falls
        // through to the individual-delete path below instead.
        if (bulkable.length >= 2) {
          try {
            const deleted = await channel.bulkDelete(bulkable, true);
            deletedCount += deleted.size;
            // Anything bulkDelete silently skipped (e.g. it turned out to be
            // right at the 14-day edge) still needs an individual attempt.
            const missed = bulkable.filter((m) => !deleted.has(m.id));
            individual.push(...missed);
          } catch (err) {
            logError('clear command bulk delete', err);
            individual.push(...bulkable);
          }
        } else {
          individual.push(...bulkable);
        }

        for (const msg of individual) {
          try {
            await msg.delete();
            deletedCount++;
          } catch (err) {
            logError('clear command message delete', err);
          }
        }
      }

      if (batch.size < 100) break;
    }

    const historyNote = historyCleared
      ? " I've also forgotten our conversation so far — we're starting fresh."
      : " I wasn't able to reset our conversation memory just now, though — might still remember earlier context.";
    const scopeNote = isDM
      ? " Your own messages are untouched — Discord doesn't allow a bot to delete another user's messages in a DM."
      : '';
    await interaction.editReply({
      content: `Cleared ${deletedCount} message${deletedCount === 1 ? '' : 's'}.${scopeNote}${historyNote}`,
    });
  } catch (err) {
    logError('clear command', err);
    await interaction.editReply({ content: `Something went wrong while clearing messages — ${errorDetail(err)}` });
  }
}
