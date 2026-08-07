import { SlashCommandBuilder, EmbedBuilder, InteractionContextType } from 'discord.js';
import { getRecentHistory } from '../db.js';
import { logError } from '../errorReporter.js';

export const data = new SlashCommandBuilder()
  .setName('history')
  .setDescription('Show recent log entries')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild)
  .addIntegerOption((opt) =>
    opt.setName('count').setDescription('How many entries (default 10, max 25)')
      .setRequired(false).setMinValue(1).setMaxValue(25)
  );

export async function execute(interaction) {
  const count = interaction.options.getInteger('count') ?? 10;
  try {
    const rows = await getRecentHistory(count);
    if (rows.length === 0) {
      await interaction.reply({ content: 'No entries logged yet.', ephemeral: false });
      return;
    }

    const lines = rows.map((r) => {
      const sign = r.type === 'income' ? '+' : '-';
      const date = new Date(r.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      const note = r.note ? ` — ${r.note}` : '';
      return `\`#${r.id}\` ${sign}₹${Number(r.amount).toFixed(2)} · ${r.category} · ${r.paymentMode} · ${date}${note}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle(`Last ${rows.length} entries`)
      .setDescription(lines.join('\n'))
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    logError('history command', err);
    await interaction.reply({ content: 'Failed to fetch history. Check the console for details.', ephemeral: false });
  }
}