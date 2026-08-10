import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, InteractionContextType } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('history')
  .setDescription('Show recent log entries')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  const modal = new ModalBuilder().setCustomId('history-modal').setTitle('Show history');

  const countInput = new TextInputBuilder()
    .setCustomId('count')
    .setLabel('How many entries? (1-25)')
    .setStyle(TextInputStyle.Short)
    .setValue('10')
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(countInput));
  await interaction.showModal(modal);
}