import { EmbedBuilder } from 'discord.js';
import { getRecentHistory } from '../db.js';
import { formatDateTimeDDMMYYYY } from '../constants.js';
import { logError, errorDetail } from '../errorReporter.js';

export const customId = 'history-modal';

export async function handle(interaction) {
  const rawCount = interaction.fields.getTextInputValue('count').trim();

  let count;
  if (rawCount === '') {
    count = 10;
  } else {
    count = Number(rawCount);
    if (!Number.isInteger(count) || count < 1 || count > 25) {
      const errorText = `Unexpected value for [count]\nexpected values: a whole number from 1 to 25\ngiven value: ${rawCount}`;
      logError('history-modal validation', errorText);
      await interaction.reply({ content: errorText });
      return;
    }
  }

  try {
    const rows = await getRecentHistory(count);
    if (rows.length === 0) {
      await interaction.reply({ content: 'No entries logged yet.' });
      return;
    }

    const lines = rows.map((r) => {
      const sign = r.type === 'income' ? '+' : '-';
      // Each row's own stored timezone/currency — not the live constants.
      const date = formatDateTimeDDMMYYYY(new Date(r.createdAt), r.timezone);
      const note = r.note ? ` — ${r.note}` : '';
      return `\`#${r.id}\` ${sign}${r.currency} ${Number(r.amount).toFixed(2)} · ${r.category} · ${r.paymentMode} · ${date} (${r.timezone})${note}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle(`Last ${rows.length} entries`)
      .setDescription(lines.join('\n'))
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    logError('history command', err);
    await interaction.reply({ content: `Failed to fetch history — ${errorDetail(err)}` });
  }
}
