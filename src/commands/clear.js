import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { logError, errorDetail } from '../errorReporter.js';

export const data = new SlashCommandBuilder()
  .setName('clear')
  .setDescription("Delete every message this bot has sent here (can't delete your own messages)")
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  await interaction.deferReply();

  const deferredReply = await interaction.fetchReply();
  const skipId = deferredReply.id;

  const channel = interaction.channel;
  if (!channel) {
    await interaction.editReply({ content: 'Could not access this channel to clear messages.' });
    return;
  }

  const clientUserId = interaction.client.user.id;
  let deletedCount = 0;
  let cursor;

  try {
    while (true) {
      const batch = await channel.messages.fetch(cursor ? { limit: 100, before: cursor } : { limit: 100 });
      if (batch.size === 0) break;

      for (const msg of batch.values()) {
        cursor = msg.id;
        if (msg.id === skipId) continue;
        if (msg.author.id !== clientUserId) continue;

        try {
          await msg.delete();
          deletedCount++;
        } catch (err) {
          logError('clear command message delete', err);
        }
      }

      if (batch.size < 100) break;
    }

    await interaction.editReply({
      content: `Cleared ${deletedCount} message${deletedCount === 1 ? '' : 's'} sent by the bot. Your own messages are untouched — Discord doesn't allow a bot to delete another user's messages in a DM.`,
    });
  } catch (err) {
    logError('clear command', err);
    await interaction.editReply({ content: `Something went wrong while clearing messages — ${errorDetail(err)}` });
  }
}