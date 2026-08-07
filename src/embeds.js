import { EmbedBuilder } from 'discord.js';

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