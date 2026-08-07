import { SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { CATEGORIES } from '../constants.js';

export const data = new SlashCommandBuilder()
  .setName('categories')
  .setDescription('List valid categories for /log')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

export async function execute(interaction) {
  await interaction.reply({
    content: `Valid categories:\n${CATEGORIES.map((c) => `• ${c}`).join('\n')}`,
    ephemeral: true,
  });
}