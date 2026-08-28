import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, InteractionContextType } from 'discord.js';
import { getCurrency } from '../constantsStore.js';

export const data = new SlashCommandBuilder()
  .setName('currency')
  .setDescription('Set the active currency')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  const modal = new ModalBuilder().setCustomId('currency-modal').setTitle('Set currency');

  const currencyInput = new TextInputBuilder()
    .setCustomId('currency')
    .setLabel('Currency')
    .setStyle(TextInputStyle.Short)
    .setValue(getCurrency())
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(currencyInput));
  await interaction.showModal(modal);
}
