import { EmbedBuilder } from 'discord.js';

const EMBED_FIELD_NAME_LIMIT = 256;
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_MAX_FIELDS = 25;

export function buildTableEmbed({ title, rows } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const embed = new EmbedBuilder().setColor(0x5865f2);
  if (title) embed.setTitle(String(title).slice(0, 256));

  const fields = rows.slice(0, EMBED_MAX_FIELDS).map((row) => ({
    name: String(row?.label ?? '—').slice(0, EMBED_FIELD_NAME_LIMIT) || '—',
    value: String(row?.value ?? '—').slice(0, EMBED_FIELD_VALUE_LIMIT) || '—',
    inline: true,
  }));

  embed.addFields(fields);
  return embed;
}

export function buildLogEmbed(log, balance) {
  const sign = log.type === 'income' ? '+' : '-';
  const embed = new EmbedBuilder()
    .setColor(log.type === 'income' ? 0x2ecc71 : 0xe74c3c)
    .setTitle(`${sign}₹${Number(log.amount).toFixed(2)}`)
    .addFields(
      { name: 'Category', value: log.category, inline: true },
      { name: 'Payment mode', value: log.paymentMode, inline: true },
      { name: 'Flow', value: log.type, inline: true },
    )
    .setFooter({ text: `Entry #${log.id}` })
    .setTimestamp(log.createdAt);

  if (balance) {
    embed.addFields(
      { name: 'Cash', value: `₹${balance.cashBalance.toFixed(2)}`, inline: true },
      { name: 'Card', value: `₹${balance.cardBalance.toFixed(2)}`, inline: true },
      { name: 'Total', value: `₹${balance.total.toFixed(2)}`, inline: true },
    );
    if (balance.total < 0) embed.addFields({ name: '⚠️ Warning', value: 'Total balance is negative.' });
  }

  if (log.note) embed.setDescription(log.note);
  return embed;
}