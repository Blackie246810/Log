import { EmbedBuilder } from 'discord.js';
import { formatDateTimeDDMMYYYY } from './constants.js';

export function buildLogEmbed(log, balance) {
  const sign = log.type === 'income' ? '+' : '-';
  const currency = log.currency ?? balance?.currency ?? '';
  const embed = new EmbedBuilder()
    .setColor(log.type === 'income' ? 0x2ecc71 : 0xe74c3c)
    .setTitle(`${sign}${currency} ${Number(log.amount).toFixed(2)}`)
    .addFields(
      { name: 'Category', value: log.category, inline: true },
      { name: 'Payment mode', value: log.paymentMode, inline: true },
      { name: 'Flow', value: log.type, inline: true },
    )
    .setFooter({ text: `Entry #${log.id}` })
    .setTimestamp(log.createdAt);

  if (balance) {
    const bc = balance.currency ?? currency;
    embed.addFields(
      { name: 'Cash', value: `${bc} ${balance.cashBalance.toFixed(2)}`, inline: true },
      { name: 'Card', value: `${bc} ${balance.cardBalance.toFixed(2)}`, inline: true },
      { name: 'Total', value: `${bc} ${balance.total.toFixed(2)}`, inline: true },
    );
    if (balance.total < 0) embed.addFields({ name: '⚠️ Warning', value: 'Total balance is negative.' });
  }

  if (log.note) embed.setDescription(log.note);
  return embed;
}

// Shared by the AI's edit_transaction tool (see ai/tools.js) to show a
// before→after diff of exactly what changed, the same style /edit's own
// confirm-step embed uses (see editFieldsModal.js), plus the balance
// impact if the edit was ledger-affecting.
export function buildEditEmbed(before, after, currency, balance) {
  const diffLine = (label, oldVal, newVal) =>
    (String(oldVal) === String(newVal) ? `${label}: ${newVal}` : `${label}: ${oldVal} → ${newVal}`);

  // Every field is always shown — diffed (old → new) where it actually
  // changed, or just the current value where it didn't — so the card is a
  // complete record of the entry post-edit, not just a changelog. Note is
  // included unconditionally too, even when it wasn't touched by this edit.
  const lines = [
    diffLine('ID', after.id, after.id),
    diffLine('Date', before.date, after.date),
    diffLine('Category', before.category, after.category),
    diffLine('Amount', `${currency} ${Number(before.amount).toFixed(2)}`, `${currency} ${Number(after.amount).toFixed(2)}`),
    diffLine('Payment mode', before.paymentMode, after.paymentMode),
    diffLine('Flow', before.type, after.type),
    diffLine('Note', before.note || '(none)', after.note || '(none)'),
  ];

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Edited: entry #${after.id}`)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  if (balance) {
    embed.addFields(
      { name: 'Cash', value: `${currency} ${balance.cashBalance.toFixed(2)}`, inline: true },
      { name: 'Card', value: `${currency} ${balance.cardBalance.toFixed(2)}`, inline: true },
      { name: 'Total', value: `${currency} ${balance.total.toFixed(2)}`, inline: true },
    );
    if (balance.total < 0) embed.addFields({ name: '⚠️ Warning', value: 'Total balance is negative.' });
  }

  return embed;
}
// Shared by /undo and /delete-style displays: a plain "this row is gone"
// card, distinct in title from buildUndoEmbed (used specifically for the
// AI's delete_transaction tool, see ai/tools.js, so the confirmation never
// implies "undone" for a plain deletion that was never itself an undo).
export function buildDeleteEmbed(deleted, restored, fallbackCurrency) {
  const sign = deleted.type === 'income' ? '+' : '-';
  const deletedCurrency = deleted.currency ?? fallbackCurrency ?? '';
  const restoredCurrency = restored.currency ?? fallbackCurrency ?? '';
  const deletedDate = deleted.date ?? formatDateTimeDDMMYYYY(new Date(deleted.createdAt), deleted.timezone);

  // Every field of the row that's now gone is shown explicitly, including
  // its id — deletion can't be diffed back like an edit can, so this is the
  // only record of what it was.
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle(`Deleted: entry #${deleted.id}`)
    .setDescription(
      [
        `ID: ${deleted.id}`,
        `Date: ${deletedDate}`,
        `Category: ${deleted.category}`,
        `Amount: ${sign}${deletedCurrency} ${Number(deleted.amount).toFixed(2)}`,
        `Payment mode: ${deleted.paymentMode}`,
        `Flow: ${deleted.type}`,
        `Note: ${deleted.note || '(none)'}`,
      ].join('\n')
    )
    .addFields(
      { name: 'Cash', value: `${restoredCurrency} ${restored.cashBalance.toFixed(2)}`, inline: true },
      { name: 'Card', value: `${restoredCurrency} ${restored.cardBalance.toFixed(2)}`, inline: true },
      { name: 'Total', value: `${restoredCurrency} ${restored.total.toFixed(2)}`, inline: true },
    )
    .setTimestamp();
}

// Shared by the /undo command and the AI's undo_last_transaction tool (see
// ai/tools.js) so both produce byte-identical cards. `fallbackCurrency` is
// only used if a row's own Currency somehow came back null (matches the
// defensive `?? getCurrency()` the /undo command used before this was
// extracted).
export function buildUndoEmbed(deleted, restored, fallbackCurrency) {
  const sign = deleted.type === 'income' ? '+' : '-';
  const deletedCurrency = deleted.currency ?? fallbackCurrency ?? '';
  const restoredCurrency = restored.currency ?? fallbackCurrency ?? '';
  return new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle(`Undone: entry #${deleted.id}`)
    .setDescription(`${sign}${deletedCurrency} ${Number(deleted.amount).toFixed(2)} · ${deleted.category} · ${deleted.paymentMode}`)
    .addFields(
      { name: 'Cash', value: `${restoredCurrency} ${restored.cashBalance.toFixed(2)}`, inline: true },
      { name: 'Card', value: `${restoredCurrency} ${restored.cardBalance.toFixed(2)}`, inline: true },
      { name: 'Total', value: `${restoredCurrency} ${restored.total.toFixed(2)}`, inline: true },
    )
    .setTimestamp();
}

// Shared by /timezone and /currency's success replies (see timezoneModal.js
// and currencyModal.js) — a simple before→after diff card for a single
// setting. When the new value is the same as the old one (re-submitting an
// unchanged setting, or a legacy stored spelling being normalized to its
// canonical form without visibly "changing" from the user's point of view),
// the arrow is dropped and just the current value is shown.
export function buildSettingChangedEmbed(settingName, before, after) {
  const valueLine = before === after ? after : `${before} → ${after}`;
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`${settingName} updated`)
    .setDescription(valueLine)
    .setTimestamp();
}
