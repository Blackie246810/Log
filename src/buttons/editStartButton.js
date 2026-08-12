import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { getLogById } from '../db.js';
import { formatDDMMYYYY } from '../constants.js';
import { logError } from '../errorReporter.js';

export const customIdPrefix = 'edit-start:';

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function handle(interaction) {
  const [, logId] = interaction.customId.split(':');

  let log;
  try {
    log = await getLogById(logId);
  } catch (err) {
    logError('edit-start lookup', err);
    await interaction.reply({ content: 'Database error while looking up that entry. Check the console for details.' });
    return;
  }

  if (!log) {
    await interaction.update({ content: `Entry #${logId} no longer exists.`, embeds: [], components: [] });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`edit-fields-modal:${log.id}`)
    .setTitle(`Edit entry #${log.id}`);

  const dateInput = new TextInputBuilder()
    .setCustomId('date').setLabel('Date (DD-MM-YYYY)').setStyle(TextInputStyle.Short)
    .setValue(formatDDMMYYYY(new Date(log.createdAt))).setRequired(true);

  const categoryInput = new TextInputBuilder()
    .setCustomId('category').setLabel('Category').setStyle(TextInputStyle.Short)
    .setValue(log.category).setRequired(true);

  const amountInput = new TextInputBuilder()
    .setCustomId('amount').setLabel('Amount').setStyle(TextInputStyle.Short)
    .setValue(String(Number(log.amount))).setRequired(true);

  const paymentModeInput = new TextInputBuilder()
    .setCustomId('payment_mode').setLabel('Payment mode').setStyle(TextInputStyle.Short)
    .setValue(capitalize(log.paymentMode)).setRequired(true);

  const paymentFlowInput = new TextInputBuilder()
    .setCustomId('payment_flow').setLabel('Payment flow').setStyle(TextInputStyle.Short)
    .setValue(capitalize(log.type)).setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(dateInput),
    new ActionRowBuilder().addComponents(categoryInput),
    new ActionRowBuilder().addComponents(amountInput),
    new ActionRowBuilder().addComponents(paymentModeInput),
    new ActionRowBuilder().addComponents(paymentFlowInput),
  );

  await interaction.showModal(modal);
}