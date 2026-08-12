import { SlashCommandBuilder, EmbedBuilder, InteractionContextType } from 'discord.js';
import { undoLastEntry } from '../db.js';
import { logError } from '../errorReporter.js';

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
    const sign = deleted.type === 'income' ? '+' : '-';
    const embed = new EmbedBuilder()
      .setColor(0xf39c12)
      .setTitle(`Undone: entry #${deleted.id}`)
      .setDescription(`${sign}₹${Number(deleted.amount).toFixed(2)} · ${deleted.category} · ${deleted.paymentMode}`)
      .addFields(
        { name: 'Cash', value: `₹${restored.cashBalance.toFixed(2)}`, inline: true },
        { name: 'Card', value: `₹${restored.cardBalance.toFixed(2)}`, inline: true },
        { name: 'Total', value: `₹${restored.total.toFixed(2)}`, inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    logError('undo command', err);
    await interaction.reply({ content: 'Failed to undo. Check the console for details.' });
  }
}