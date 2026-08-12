import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { getLogById } from '../db.js';
import { buildLogEmbed } from '../embeds.js';
import { logError } from '../errorReporter.js';

export const customId = 'edit-id-modal';

export async function handle(interaction) {
  const rawId = interaction.fields.getTextInputValue('entryId').trim();

  if (!/^\d+$/.test(rawId)) {
    const errorText = `Unexpected value for [entryId]\nexpected values: a positive whole number\ngiven value: ${rawId}`;
    logError('edit-id-modal validation', errorText);
    await interaction.reply({ content: errorText });
    return;
  }

  let log;
  try {
    log = await getLogById(rawId);
  } catch (err) {
    logError('edit-id-modal lookup', err);
    await interaction.reply({ content: 'Database error while looking up that entry. Check the console for details.' });
    return;
  }

  if (!log) {
    await interaction.reply({ content: `No entry found with ID #${rawId}.` });
    return;
  }

  const embed = buildLogEmbed(log);
  const continueButton = new ButtonBuilder()
    .setCustomId(`edit-start:${log.id}`)
    .setLabel('Continue')
    .setStyle(ButtonStyle.Primary);

  await interaction.reply({
    content: `Editing entry #${log.id}. Click Continue to open the edit form.`,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(continueButton)],
  });
}