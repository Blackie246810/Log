import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { getLogById } from '../db.js';
import { formatDDMMYYYY } from '../constants.js';
import { logError } from '../errorReporter.js';

export const customId = 'edit-id-modal';

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function handle(interaction) {
  const rawId = interaction.fields.getTextInputValue('entryId').trim();

  if (!/^\d+$/.test(rawId)) {
    const errorText = `Unexpected value for [entryId]\nexpected values: a positive whole number\ngiven value: ${rawId}`;
    logError('edit-id-modal validation', errorText);
    await interaction.reply({ content: errorText });
    return;
  }

  let log;
  try {
    log = await getLogById(rawId);
  } catch (err) {
    logError('edit-id-modal lookup', err);
    await interaction.reply({ content: 'Database error while looking up that entry. Check the console for details.' });
    return;
  }

  if (!log) {
    await interaction.reply({ content: `No entry found with ID #${rawId}.` });
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