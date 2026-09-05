import { setTimezone, getTimezone } from '../constantsStore.js';
import { TIMEZONE_DISPLAY_NAMES, canonicalTimezone, findTimezoneMatches } from '../timezoneList.js';
import { replyInChunks } from '../chunkedReply.js';
import { buildSettingChangedEmbed } from '../embeds.js';
import { logError, errorDetail } from '../errorReporter.js';

export const customId = 'timezone-modal';

export async function handle(interaction) {
  const raw = interaction.fields.getTextInputValue('timezone').trim();

  // Accepts the canonical name AND any alias Intl recognizes as the same
  // zone (e.g. "Asia/Kolkata" resolves to "Asia/Calcutta") — see
  // canonicalTimezone in timezoneList.js. Whatever the user typed, what
  // gets stored is always the one canonical spelling.
  const exact = canonicalTimezone(raw);
  if (exact) {
    const before = getTimezone(); // captured before the write, for the before→after card
    try {
      await setTimezone(exact);
    } catch (err) {
      logError('timezone-modal DB write', err);
      await interaction.reply({ content: `Database error — timezone was not updated. ${errorDetail(err)}` });
      return;
    }
    await interaction.reply({ embeds: [buildSettingChangedEmbed('Timezone', before, exact)] });
    return;
  }

  const close = findTimezoneMatches(raw);
  if (close.length > 0) {
    await replyInChunks(interaction, close, `"${raw}" isn't a recognized IANA timezone. Did you mean one of:`);
    return;
  }

  await replyInChunks(interaction, TIMEZONE_DISPLAY_NAMES, `"${raw}" isn't a recognized IANA timezone. All available timezones:`);
}
