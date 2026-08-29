import { editLogById, getLogById, getCurrentBalance } from '../db.js';
import { buildLogEmbed } from '../embeds.js';
import { logError, errorDetail } from '../errorReporter.js';
import { getPendingEdit, clearPendingEdit } from '../pendingEdits.js';

export const customIdPrefix = 'edit-note-modal:';

export async function handle(interaction) {
  const [, logId, originalMessageId] = interaction.customId.split(':');

  const pending = getPendingEdit(logId);
  if (!pending) {
    await interaction.reply({ content: `Edit session for entry #${logId} expired — please run /edit again.` });
    return;
  }

  const rawNote = interaction.fields.getTextInputValue('note').trim();
  const originalNote = pending.originalNote ?? '';
  const noteChanged = rawNote !== originalNote;
  const noteArg = noteChanged ? (rawNote || null) : undefined;

  let result;
  try {
    result = await editLogById(logId, {
      type: pending.type,
      amount: pending.amount,
      category: pending.category,
      paymentMode: pending.paymentMode,
      createdAt: pending.createdAt,
      note: noteArg,
    });
  } catch (err) {
    logError('edit-note-modal DB write', err);
    await interaction.reply({ content: `Database error — entry #${logId} was NOT updated. ${errorDetail(err)}` });
    return;
  }

  clearPendingEdit(logId);

  if (!result) {
    await interaction.reply({ content: `Entry #${logId} no longer exists — nothing was updated.` });
    return;
  }

  const updated = await getLogById(logId);
  const balance = result.ledgerRebuilt ? result.restored : await getCurrentBalance();
  const embed = buildLogEmbed(updated, balance);

  await interaction.reply({
    content: `Entry #${logId} updated.`,
    embeds: [embed],
  });

  try {
    const originalMessage = await interaction.channel.messages.fetch(originalMessageId);
    await originalMessage.edit({ content: `Entry #${logId} — edit applied.`, components: [] });
  } catch (err) {
    logError('edit-note-modal cleanup', err);
  }
}