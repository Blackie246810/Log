import { EmbedBuilder } from 'discord.js';
import { resolveLevelInput } from '../ai/modelLevels.js';
import { setLevel } from '../constantsStore.js';
import { logError, errorDetail } from '../errorReporter.js';

export const customId = 'level-modal';

// Same "Unexpected value for [x]" shape validateLogValues uses for /log and
// /edit (see logFieldsValidation.js) — kept here as its own card instead of
// a plain reply because this command's replies are all cards (see the note
// below on why the "doesn't exist" case is deliberately vague).
function invalidInputCard(detail, given) {
  return new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('Invalid input')
    .setDescription(`Unexpected value for [level]\nexpected values: a number, e.g. 3.5\ngiven value: ${given}\n\n${detail}`)
    .setTimestamp();
}

// Deliberately vague: this fires both for a level that flat-out doesn't
// exist and for one that exists but isn't free right now (see the note on
// `free: false` in ai/modelLevels.js) — the two are indistinguishable here
// on purpose, so nothing about what "level" actually maps to leaks through
// even indirectly.
function unknownLevelCard() {
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('No such level')
    .setDescription("That level doesn't exist.")
    .setTimestamp();
}

function successCard(number) {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('Level updated')
    .setDescription(`Change successful — now on level **${number}**.`)
    .setTimestamp();
}

export async function handle(interaction) {
  const raw = interaction.fields.getTextInputValue('level').trim();
  const result = resolveLevelInput(raw);

  if (!result.ok) {
    if (result.reason === 'format') {
      await interaction.reply({ embeds: [invalidInputCard(result.detail, raw)] });
    } else {
      await interaction.reply({ embeds: [unknownLevelCard()] });
    }
    return;
  }

  try {
    await setLevel(result.number);
  } catch (err) {
    logError('level-modal DB write', err);
    await interaction.reply({ content: `Database error — level was not updated. ${errorDetail(err)}` });
    return;
  }

  await interaction.reply({ embeds: [successCard(result.number)] });
}
