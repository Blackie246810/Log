import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { addLogEntry } from '../db.js';
import { CATEGORIES, PAYMENT_MODES, PAYMENT_FLOWS, matchCanonical, parseDateTimeDDMMYYYY } from '../constants.js';
import { getCurrency, getTimezone } from '../constantsStore.js';
import { buildLogEmbed } from '../embeds.js';
import { logError } from '../errorReporter.js';

export const customId = 'log-modal';

export async function handle(interaction) {
  const rawDate = interaction.fields.getTextInputValue('date').trim();
  const rawCategory = interaction.fields.getTextInputValue('category').trim();
  const rawAmount = interaction.fields.getTextInputValue('amount').trim();
  const rawPaymentMode = interaction.fields.getTextInputValue('payment_mode').trim();
  const rawPaymentFlow = interaction.fields.getTextInputValue('payment_flow').trim();

  const errorBlocks = [];

  const timezone = getTimezone();
  const currency = getCurrency();

  const parsedDate = parseDateTimeDDMMYYYY(rawDate, timezone);
  if (!parsedDate) {
    errorBlocks.push(
      `Unexpected value for [date]\nexpected values: DD-MM-YYYY HH:mm format (24-hour, ${timezone})\ngiven value: ${rawDate}`
    );
  }

  const category = matchCanonical(rawCategory, CATEGORIES);
  if (!category) {
    errorBlocks.push(
      `Unexpected value for [category]\nexpected values: ${CATEGORIES.join(', ')}\ngiven value: ${rawCategory}`
    );
  }

  const amountNum = Number(rawAmount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  if (!amountValid) {
    errorBlocks.push(
      `Unexpected value for [amount]\nexpected values: a positive number\ngiven value: ${rawAmount}`
    );
  }

  const paymentModeCanon = matchCanonical(rawPaymentMode, PAYMENT_MODES);
  if (!paymentModeCanon) {
    errorBlocks.push(
      `Unexpected value for [payment_mode]\nexpected values: ${PAYMENT_MODES.join(', ')}\ngiven value: ${rawPaymentMode}`
    );
  }

  const paymentFlowCanon = matchCanonical(rawPaymentFlow, PAYMENT_FLOWS);
  if (!paymentFlowCanon) {
    errorBlocks.push(
      `Unexpected value for [payment_flow]\nexpected values: ${PAYMENT_FLOWS.join(', ')}\ngiven value: ${rawPaymentFlow}`
    );
  }

  if (errorBlocks.length > 0) {
    const errorText = errorBlocks.join('\n\n');
    logError('log-modal validation', errorText);
    await interaction.reply({ content: errorText });
    return;
  }

  const type = paymentFlowCanon.toLowerCase();
  const paymentMode = paymentModeCanon.toLowerCase();

  let result;
  try {
    result = await addLogEntry({
      type, amount: amountNum, category, paymentMode, createdAt: parsedDate, currency, timezone,
    });
  } catch (err) {
    logError('log-modal DB write', err);
    await interaction.reply({ content: 'Database error — nothing was written. Check the console for details.' });
    return;
  }

  const embed = buildLogEmbed(
    { id: result.logId, createdAt: result.createdAt, type, amount: amountNum, category, paymentMode, currency },
    result
  );

  const yesButton = new ButtonBuilder()
    .setCustomId(`log-note:yes:${result.logId}`)
    .setLabel('Yes')
    .setStyle(ButtonStyle.Primary);
  const noButton = new ButtonBuilder()
    .setCustomId(`log-note:no:${result.logId}`)
    .setLabel('No')
    .setStyle(ButtonStyle.Secondary);

  await interaction.reply({
    content: 'Do you want to type a description/note?',
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(yesButton, noButton)],
  });
}
