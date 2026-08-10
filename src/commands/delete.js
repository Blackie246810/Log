import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, InteractionContextType } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('delete')
  .setDescription('Delete a logged entry by its ID')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  const modal = new ModalBuilder().setCustomId('delete-modal').setTitle('Delete an entry');

  const idInput = new TextInputBuilder()
    .setCustomId('entryId')
    .setLabel('Entry ID')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Id of the log')
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(idInput));
  await interaction.showModal(modal);
}