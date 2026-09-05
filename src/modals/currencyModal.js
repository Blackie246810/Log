import { setCurrency, getCurrency } from '../constantsStore.js';
import { CURRENCY_CODES } from '../currencyList.js';
import { closestMatches } from '../fuzzyMatch.js';
import { replyInChunks } from '../chunkedReply.js';
import { buildSettingChangedEmbed } from '../embeds.js';
import { logError, errorDetail } from '../errorReporter.js';

export const customId = 'currency-modal';

export async function handle(interaction) {
  const raw = interaction.fields.getTextInputValue('currency').trim();
  const upper = raw.toUpperCase();

  const exact = CURRENCY_CODES.find((c) => c === upper);
  if (exact) {
    const before = getCurrency(); // captured before the write, for the before→after card
    try {
      await setCurrency(exact);
    } catch (err) {
      logError('currency-modal DB write', err);
      await interaction.reply({ content: `Database error — currency was not updated. ${errorDetail(err)}` });
      return;
    }
    await interaction.reply({ embeds: [buildSettingChangedEmbed('Currency', before, exact)] });
    return;
  }

  const close = closestMatches(raw, CURRENCY_CODES);
  if (close.length > 0) {
    await replyInChunks(interaction, close, `"${raw}" isn't a recognized currency code. Did you mean one of:`);
    return;
  }

  await replyInChunks(interaction, CURRENCY_CODES, `"${raw}" isn't a recognized currency code. All available codes:`);
}
