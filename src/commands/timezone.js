import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, InteractionContextType } from 'discord.js';
import { getTimezone } from '../constantsStore.js';

export const data = new SlashCommandBuilder()
  .setName('timezone')
  .setDescription('Set the active timezone')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  const modal = new ModalBuilder().setCustomId('timezone-modal').setTitle('Set timezone');

  const timezoneInput = new TextInputBuilder()
    .setCustomId('timezone')
    .setLabel('Timezone')
    .setStyle(TextInputStyle.Short)
    .setValue(getTimezone())
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(timezoneInput));
  await interaction.showModal(modal);
}
