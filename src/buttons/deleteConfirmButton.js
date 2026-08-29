import { deleteLogById } from '../db.js';
import { logError, errorDetail } from '../errorReporter.js';

export const customIdPrefix = 'delete-confirm:';

export async function handle(interaction) {
  const [, action, logId] = interaction.customId.split(':');

  if (action === 'no') {
    await interaction.update({ content: 'Deletion cancelled.', embeds: [], components: [] });
    return;
  }

  if (action === 'yes') {
    let result;
    try {
      result = await deleteLogById(logId);
    } catch (err) {
      logError('delete-confirm DB write', err);
      await interaction.update({ content: `Database error — entry #${logId} was NOT deleted. ${errorDetail(err)}`, embeds: [], components: [] });
      return;
    }

    if (!result) {
      await interaction.update({ content: `Entry #${logId} no longer exists — nothing to delete.`, embeds: [], components: [] });
      return;
    }

    await interaction.update({ content: `Entry #${logId} deleted.`, embeds: [], components: [] });
  }
}