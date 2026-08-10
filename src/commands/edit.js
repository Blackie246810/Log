import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, InteractionContextType } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('edit')
  .setDescription('Edit a logged entry by its ID')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  const modal = new ModalBuilder().setCustomId('edit-id-modal').setTitle('Edit an entry');

  const idInput = new TextInputBuilder()
    .setCustomId('entryId')
    .setLabel('Entry ID')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 42 — the number shown as "Entry #42"')
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(idInput));
  await interaction.showModal(modal);
}