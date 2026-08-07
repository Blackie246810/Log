import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';

export const customIdPrefix = 'log-note:';

export async function handle(interaction) {
  const [, action, logId] = interaction.customId.split(':');

  if (action === 'no') {
    await interaction.update({ content: `Entry #${logId} saved — no note added.`, components: [] });
    return;
  }

  if (action === 'yes') {
    const modal = new ModalBuilder()
      .setCustomId(`log-note-modal:${logId}:${interaction.message.id}`)
      .setTitle(`Note for entry #${logId}`);

    const noteInput = new TextInputBuilder()
      .setCustomId('note')
      .setLabel('Description / note')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(1000)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
    await interaction.showModal(modal);
  }
}