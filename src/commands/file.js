import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, InteractionContextType } from 'discord.js';
import { formatDDMMYYYY, todayDDMMYYYY, defaultFileFromDate } from '../constants.js';

export const data = new SlashCommandBuilder()
  .setName('file')
  .setDescription('Export transactions between two dates as an Excel file')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  const modal = new ModalBuilder().setCustomId('file-modal').setTitle('Export transactions');

  const fromInput = new TextInputBuilder()
    .setCustomId('from')
    .setLabel('From (DD-MM-YYYY, or "all")')
    .setStyle(TextInputStyle.Short)
    .setValue(formatDDMMYYYY(defaultFileFromDate()))
    .setRequired(true);

  const toInput = new TextInputBuilder()
    .setCustomId('to')
    .setLabel('To (DD-MM-YYYY)')
    .setStyle(TextInputStyle.Short)
    .setValue(todayDDMMYYYY())
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(fromInput),
    new ActionRowBuilder().addComponents(toInput),
  );
  await interaction.showModal(modal);
}