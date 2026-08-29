import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { addLogEntry } from '../db.js';
import { getCurrency, getTimezone } from '../constantsStore.js';
import { buildLogEmbed } from '../embeds.js';
import { logError, errorDetail } from '../errorReporter.js';
import { validateLogFields } from '../logFieldsValidation.js';

export const customId = 'log-modal';

export async function handle(interaction) {
  const timezone = getTimezone();
  const currency = getCurrency();

  const validated = validateLogFields(interaction.fields, timezone);
  if (!validated.ok) {
    logError('log-modal validation', validated.errorText);
    await interaction.reply({ content: validated.errorText });
    return;
  }
  const { type, amount: amountNum, category, paymentMode, createdAt: parsedDate } = validated.value;

  let result;
  try {
    result = await addLogEntry({
      type, amount: amountNum, category, paymentMode, createdAt: parsedDate, currency, timezone,
    });
  } catch (err) {
    logError('log-modal DB write', err);
    await interaction.reply({ content: `Database error — nothing was written. ${errorDetail(err)}` });
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
