import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, InteractionContextType } from 'discord.js';
import { getLevel } from '../constantsStore.js';

export const data = new SlashCommandBuilder()
  .setName('level')
  .setDescription('Set the response level')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  const modal = new ModalBuilder().setCustomId('level-modal').setTitle('Set level');

  const levelInput = new TextInputBuilder()
    .setCustomId('level')
    .setLabel('Level')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Whole or decimal number')
    .setValue(getLevel())
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(levelInput));
  await interaction.showModal(modal);
}
