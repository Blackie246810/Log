import { setLogNote, getLogById, getCurrentBalance } from '../db.js';
import { buildLogEmbed } from '../embeds.js';
import { logError, errorDetail } from '../errorReporter.js';

export const customIdPrefix = 'log-note-modal:';

export async function handle(interaction) {
  const [, logId, originalMessageId] = interaction.customId.split(':');
  const note = interaction.fields.getTextInputValue('note').trim();

  let saved;
  try {
    saved = await setLogNote(logId, note);
  } catch (err) {
    logError('note-modal DB write', err);
    await interaction.reply({ content: `Entry #${logId} was logged, but saving the note failed — ${errorDetail(err)}` });
    return;
  }

  if (!saved) {
    const err = new Error(`setLogNote found no row for logId=${logId}`);
    logError('note-modal missing entry', err);
    await interaction.reply({ content: `Couldn't find entry #${logId} to attach the note to.` });
    return;
  }

  const log = await getLogById(logId);
  const balance = await getCurrentBalance();
  const embed = buildLogEmbed(log, balance);

  await interaction.reply({
    content: `Entry #${logId} confirmed — transaction and note both saved.`,
    embeds: [embed],
  });

  try {
    const originalMessage = await interaction.channel.messages.fetch(originalMessageId);
    await originalMessage.edit({ content: `Entry #${logId} — note added.`, components: [] });
  } catch (err) {
    logError('note-modal cleanup', err);
  }
}