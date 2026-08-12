import { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import { getLogById } from '../db.js';
import { CATEGORIES, PAYMENT_MODES, PAYMENT_FLOWS, matchCanonical, parseDateDDMMYYYY, formatDDMMYYYY } from '../constants.js';
import { logError } from '../errorReporter.js';
import { setPendingEdit } from '../pendingEdits.js';

export const customIdPrefix = 'edit-fields-modal:';

function diffLine(label, oldVal, newVal) {
  return oldVal === newVal ? `${label}: ${newVal}` : `${label}: ${oldVal} → ${newVal}`;
}

export async function handle(interaction) {
  const [, logId] = interaction.customId.split(':');

  const rawDate = interaction.fields.getTextInputValue('date').trim();
  const rawCategory = interaction.fields.getTextInputValue('category').trim();
  const rawAmount = interaction.fields.getTextInputValue('amount').trim();
  const rawPaymentMode = interaction.fields.getTextInputValue('payment_mode').trim();
  const rawPaymentFlow = interaction.fields.getTextInputValue('payment_flow').trim();

  const errorBlocks = [];

  const parsedDate = parseDateDDMMYYYY(rawDate);
  if (!parsedDate) {
    errorBlocks.push(`Unexpected value for [date]\nexpected values: DD-MM-YYYY format\ngiven value: ${rawDate}`);
  }

  const category = matchCanonical(rawCategory, CATEGORIES);
  if (!category) {
    errorBlocks.push(`Unexpected value for [category]\nexpected values: ${CATEGORIES.join(', ')}\ngiven value: ${rawCategory}`);
  }

  const amountNum = Number(rawAmount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    errorBlocks.push(`Unexpected value for [amount]\nexpected values: a positive number\ngiven value: ${rawAmount}`);
  }

  const paymentModeCanon = matchCanonical(rawPaymentMode, PAYMENT_MODES);
  if (!paymentModeCanon) {
    errorBlocks.push(`Unexpected value for [payment_mode]\nexpected values: ${PAYMENT_MODES.join(', ')}\ngiven value: ${rawPaymentMode}`);
  }

  const paymentFlowCanon = matchCanonical(rawPaymentFlow, PAYMENT_FLOWS);
  if (!paymentFlowCanon) {
    errorBlocks.push(`Unexpected value for [payment_flow]\nexpected values: ${PAYMENT_FLOWS.join(', ')}\ngiven value: ${rawPaymentFlow}`);
  }

  if (errorBlocks.length > 0) {
    const errorText = errorBlocks.join('\n\n');
    logError('edit-fields-modal validation', errorText);
    await interaction.reply({ content: errorText });
    return;
  }

  let original;
  try {
    original = await getLogById(logId);
  } catch (err) {
    logError('edit-fields-modal lookup', err);
    await interaction.reply({ content: 'Database error while looking up that entry. Check the console for details.' });
    return;
  }
  if (!original) {
    await interaction.reply({ content: `Entry #${logId} no longer exists.` });
    return;
  }

  const type = paymentFlowCanon.toLowerCase();
  const paymentMode = paymentModeCanon.toLowerCase();

  setPendingEdit(logId, {
    type, amount: amountNum, category, paymentMode, createdAt: parsedDate,
    originalNote: original.note,
  });

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Confirm edit — entry #${logId}`)
    .setDescription([
      diffLine('Date', formatDDMMYYYY(new Date(original.createdAt)), formatDDMMYYYY(parsedDate)),
      diffLine('Category', original.category, category),
      diffLine('Amount', `₹${Number(original.amount).toFixed(2)}`, `₹${amountNum.toFixed(2)}`),
      diffLine('Payment mode', original.paymentMode, paymentMode),
      diffLine('Flow', original.type, type),
    ].join('\n'));

  const editButton = new ButtonBuilder().setCustomId(`edit-confirm:apply:${logId}`).setLabel('Edit').setStyle(ButtonStyle.Primary);
  const cancelButton = new ButtonBuilder().setCustomId(`edit-confirm:cancel:${logId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary);

  await interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(editButton, cancelButton)],
  });
}