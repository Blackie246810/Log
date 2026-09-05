import { EmbedBuilder } from 'discord.js';
import { parseLevelInput } from '../ai/modelLevels.js';
import { checkModelAccess } from '../ai/gemini.js';
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

// Deliberately vague: this fires both for a well-formed number Google
// doesn't recognize as a real Flash version (checkModelAccess's
// 'not_found') and for one that exists but isn't reachable right now for
// a non-transient reason (checkModelAccess's 'blocked') — the two are
// indistinguishable here on purpose, so nothing about what "level"
// actually maps to leaks through even indirectly. A transient
// rate-limit/high-demand hit from checkModelAccess is NOT one of these —
// that still counts as success, see the success path below.
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
  const parsed = parseLevelInput(raw);

  if (!parsed.ok) {
    // parseLevelInput only ever fails with 'format' now — there's no
    // local table to miss anymore (see ai/modelLevels.js), so a
    // well-formed number always makes it through to the live check
    // below, which is the only place a "no such level" verdict can come
    // from.
    await interaction.reply({ embeds: [invalidInputCard(parsed.detail, raw)] });
    return;
  }

  // parseLevelInput only confirms the number maps to *something* in our
  // local table — it says nothing about whether that model is actually
  // usable right now. Google is the only source of truth for that (see
  // checkModelAccess's own doc comment in ai/gemini.js), so this is
  // checked live before the stored level is ever touched. A rate-limit/
  // high-demand hit from checkModelAccess still resolves to 'accessible'
  // — that's still a real, working level, just momentarily busy — only
  // 'not_found' and 'blocked' are treated as a failure. The live check
  // is a real network call, so the reply is deferred first rather than
  // risking Discord's ~3s interaction-response window expiring.
  await interaction.deferReply();

  let access;
  try {
    access = await checkModelAccess(parsed.modelId);
  } catch (err) {
    logError('level-modal live check', err);
    await interaction.editReply({ content: `Couldn't verify that level right now. ${errorDetail(err)}` });
    return;
  }

  if (access !== 'accessible') {
    await interaction.editReply({ embeds: [unknownLevelCard()] });
    return;
  }

  try {
    await setLevel(parsed.number);
  } catch (err) {
    logError('level-modal DB write', err);
    await interaction.editReply({ content: `Database error — level was not updated. ${errorDetail(err)}` });
    return;
  }

  await interaction.editReply({ embeds: [successCard(parsed.number)] });
}
