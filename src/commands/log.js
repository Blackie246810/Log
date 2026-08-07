import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, InteractionContextType } from 'discord.js';
import { todayDDMMYYYY } from '../constants.js';

export const data = new SlashCommandBuilder()
  .setName('log')
  .setDescription('Log a transaction')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  const modal = new ModalBuilder().setCustomId('log-modal').setTitle('Log a transaction');

  const dateInput = new TextInputBuilder()
    .setCustomId('date')
    .setLabel('Date (DD-MM-YYYY)')
    .setStyle(TextInputStyle.Short)
    .setValue(todayDDMMYYYY())
    .setRequired(true);

  const categoryInput = new TextInputBuilder()
    .setCustomId('category')
    .setLabel('Category')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Food/Drink — see /categories for full list')
    .setRequired(true);

  const amountInput = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('Amount')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 250')
    .setRequired(true);

  const paymentModeInput = new TextInputBuilder()
    .setCustomId('payment_mode')
    .setLabel('Payment mode')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Physical or Digital')
    .setRequired(true);

  const paymentFlowInput = new TextInputBuilder()
    .setCustomId('payment_flow')
    .setLabel('Payment flow')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Income or Expense')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(dateInput),
    new ActionRowBuilder().addComponents(categoryInput),
    new ActionRowBuilder().addComponents(amountInput),
    new ActionRowBuilder().addComponents(paymentModeInput),
    new ActionRowBuilder().addComponents(paymentFlowInput),
  );

  await interaction.showModal(modal);
}