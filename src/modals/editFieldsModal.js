import { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import { getLogById } from '../db.js';
import { formatDateTimeDDMMYYYY } from '../constants.js';
import { logError, errorDetail } from '../errorReporter.js';
import { setPendingEdit } from '../pendingEdits.js';
import { validateLogFields } from '../logFieldsValidation.js';

export const customIdPrefix = 'edit-fields-modal:';

function diffLine(label, oldVal, newVal) {
  return oldVal === newVal ? `${label}: ${newVal}` : `${label}: ${oldVal} → ${newVal}`;
}

export async function handle(interaction) {
  const [, logId] = interaction.customId.split(':');

  let original;
  try {
    original = await getLogById(logId);
  } catch (err) {
    logError('edit-fields-modal lookup', err);
    await interaction.reply({ content: `Database error while looking up that entry — ${errorDetail(err)}` });
    return;
  }
  if (!original) {
    await interaction.reply({ content: `Entry #${logId} no longer exists.` });
    return;
  }

  // The date is re-parsed using THIS log's own stored timezone — never the
  // live Constants timezone — so re-typing the same wall-clock time doesn't
  // silently shift the stored instant.
  const timezone = original.timezone;

  const validated = validateLogFields(interaction.fields, timezone);
  if (!validated.ok) {
    logError('edit-fields-modal validation', validated.errorText);
    await interaction.reply({ content: validated.errorText });
    return;
  }
  const { type, amount: amountNum, category, paymentMode, createdAt: parsedDate } = validated.value;

  setPendingEdit(logId, {
    type, amount: amountNum, category, paymentMode, createdAt: parsedDate,
    originalNote: original.note,
  });

  const currency = original.currency;
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Confirm edit — entry #${logId}`)
    .setDescription([
      diffLine('Date', formatDateTimeDDMMYYYY(new Date(original.createdAt), timezone), formatDateTimeDDMMYYYY(parsedDate, timezone)),
      diffLine('Category', original.category, category),
      diffLine('Amount', `${currency} ${Number(original.amount).toFixed(2)}`, `${currency} ${amountNum.toFixed(2)}`),
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
