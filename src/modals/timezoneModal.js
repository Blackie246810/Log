import { setTimezone } from '../constantsStore.js';
import { TIMEZONES, canonicalTimezone } from '../timezoneList.js';
import { closestMatches } from '../fuzzyMatch.js';
import { replyInChunks } from '../chunkedReply.js';
import { logError, errorDetail } from '../errorReporter.js';

export const customId = 'timezone-modal';

export async function handle(interaction) {
  const raw = interaction.fields.getTextInputValue('timezone').trim();

  const exact = canonicalTimezone(raw);
  if (exact) {
    try {
      await setTimezone(exact);
    } catch (err) {
      logError('timezone-modal DB write', err);
      await interaction.reply({ content: `Database error — timezone was not updated. ${errorDetail(err)}` });
      return;
    }
    await interaction.reply({ content: `Timezone set to ${exact}.` });
    return;
  }

  const close = closestMatches(raw, TIMEZONES);
  if (close.length > 0) {
    await replyInChunks(interaction, close, `"${raw}" isn't a recognized IANA timezone. Did you mean one of:`);
    return;
  }

  await replyInChunks(interaction, TIMEZONES, `"${raw}" isn't a recognized IANA timezone. All available timezones:`);
}
