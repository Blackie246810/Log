import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { undoLastEntry } from '../db.js';
import { getCurrency } from '../constantsStore.js';
import { logError, errorDetail } from '../errorReporter.js';
import { buildUndoEmbed } from '../embeds.js';

export const data = new SlashCommandBuilder()
  .setName('undo')
  .setDescription('Delete the most recently inserted log entry and restore the prior balance')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  try {
    const result = await undoLastEntry();
    if (!result) {
      await interaction.reply({ content: 'Nothing to undo — no entries exist.' });
      return;
    }

    const { deleted, restored } = result;
    const embed = buildUndoEmbed(deleted, restored, getCurrency());

    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    logError('undo command', err);
    await interaction.reply({ content: `Failed to undo — ${errorDetail(err)}` });
  }
}
