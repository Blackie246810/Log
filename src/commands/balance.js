import { SlashCommandBuilder, EmbedBuilder, InteractionContextType } from 'discord.js';
import { getCurrentBalance } from '../db.js';
import { getCurrency } from '../constantsStore.js';
import { logError, errorDetail } from '../errorReporter.js';

export const data = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('Show current cash / card / total balance')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  try {
    const bal = await getCurrentBalance();
    const currency = bal.currency ?? getCurrency();
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('Current Balance')
      .addFields(
        { name: 'Cash', value: `${currency} ${bal.cashBalance.toFixed(2)}`, inline: true },
        { name: 'Card', value: `${currency} ${bal.cardBalance.toFixed(2)}`, inline: true },
        { name: 'Total', value: `${currency} ${bal.total.toFixed(2)}`, inline: true },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    logError('balance command', err);
    await interaction.reply({ content: `Failed to fetch balance — ${errorDetail(err)}` });
  }
}
