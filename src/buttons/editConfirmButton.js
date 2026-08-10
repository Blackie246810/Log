import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { getPendingEdit, clearPendingEdit } from '../pendingEdits.js';

export const customIdPrefix = 'edit-confirm:';

export async function handle(interaction) {
  const [, action, logId] = interaction.customId.split(':');

  if (action === 'cancel') {
    clearPendingEdit(logId);
    await interaction.update({ content: 'Editing cancelled.', embeds: [], components: [] });
    return;
  }

  if (action === 'apply') {
    const pending = getPendingEdit(logId);
    if (!pending) {
      await interaction.update({ content: `Edit session for entry #${logId} expired — please run /edit again.`, embeds: [], components: [] });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`edit-note-modal:${logId}:${interaction.message.id}`)
      .setTitle(`Description for entry #${logId}`);

    const noteInput = new TextInputBuilder()
      .setCustomId('note')
      .setLabel('Description / note')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(1000)
      .setValue(pending.originalNote ?? '')
      .setRequired(false);

    modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
    await interaction.showModal(modal);
  }
}