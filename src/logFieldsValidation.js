// Shared by logModal.js (/log) and editFieldsModal.js (/edit) — both collect
// the exact same 5 fields (date, category, amount, payment_mode,
// payment_flow) from a modal and need identical validation against them.
// This used to be copy-pasted between the two files; keeping one copy means
// a rule change (or a bug fix) only has to happen once, and /log and /edit
// can never silently drift into enforcing different rules on the same data.

import { CATEGORIES, PAYMENT_MODES, PAYMENT_FLOWS, matchCanonical, parseDateTimeDDMMYYYY } from './constants.js';

// `fields` is Discord's ModalSubmitFields (interaction.fields) — read
// directly here rather than making every caller pre-extract raw strings.
// `timezone` is the timezone the date should be interpreted in: the live
// Constants timezone for a new /log entry, or the entry's own stored
// timezone when re-validating an /edit (see editFieldsModal.js).
//
// Returns either { ok: true, value: { type, amount, category, paymentMode,
// createdAt } } with everything already canonicalized/parsed, or
// { ok: false, errorText } ready to hand straight to interaction.reply.
export function validateLogFields(fields, timezone) {
  return validateLogValues(
    {
      date: fields.getTextInputValue('date').trim(),
      category: fields.getTextInputValue('category').trim(),
      amount: fields.getTextInputValue('amount').trim(),
      paymentMode: fields.getTextInputValue('payment_mode').trim(),
      paymentFlow: fields.getTextInputValue('payment_flow').trim(),
    },
    timezone
  );
}

// The actual rules, decoupled from Discord's ModalSubmitFields — takes
// plain strings directly. This is what lets the AI's log_transaction tool
// (see ai/tools.js) enforce the exact same validation /log and /edit do,
// rather than a second, potentially-drifting copy of the rules.
// Plain decimal only — "450", "450.75" — never scientific notation ("4.5e2")
// or other numeric-literal forms JS's Number() would otherwise happily
// parse; those are technically valid amounts but no user actually intends
// to type them, and letting them through means the number quietly stored
// isn't the number displayed back. Same rule /level's NUMBER_PATTERN uses.
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

export function validateLogValues(input, timezone) {
  const rawDate = String(input.date ?? '').trim();
  const rawCategory = String(input.category ?? '').trim();
  const rawAmount = String(input.amount ?? '').trim();
  const rawPaymentMode = String(input.paymentMode ?? '').trim();
  const rawPaymentFlow = String(input.paymentFlow ?? '').trim();

  const errorBlocks = [];

  const parsedDate = parseDateTimeDDMMYYYY(rawDate, timezone);
  if (!parsedDate) {
    errorBlocks.push(
      `Unexpected value for [date]\nexpected values: DD-MM-YYYY HH:mm format (24-hour, ${timezone})\ngiven value: ${rawDate}`
    );
  }

  const category = matchCanonical(rawCategory, CATEGORIES);
  if (!category) {
    errorBlocks.push(
      `Unexpected value for [category]\nexpected values: ${CATEGORIES.join(', ')}\ngiven value: ${rawCategory}`
    );
  }

  const amountNum = Number(rawAmount);
  const amountValid = AMOUNT_PATTERN.test(rawAmount) && Number.isFinite(amountNum) && amountNum > 0;
  if (!amountValid) {
    errorBlocks.push(
      `Unexpected value for [amount]\nexpected values: a positive number\ngiven value: ${rawAmount}`
    );
  }

  const paymentModeCanon = matchCanonical(rawPaymentMode, PAYMENT_MODES);
  if (!paymentModeCanon) {
    errorBlocks.push(
      `Unexpected value for [payment_mode]\nexpected values: ${PAYMENT_MODES.join(', ')}\ngiven value: ${rawPaymentMode}`
    );
  }

  const paymentFlowCanon = matchCanonical(rawPaymentFlow, PAYMENT_FLOWS);
  if (!paymentFlowCanon) {
    errorBlocks.push(
      `Unexpected value for [payment_flow]\nexpected values: ${PAYMENT_FLOWS.join(', ')}\ngiven value: ${rawPaymentFlow}`
    );
  }

  if (errorBlocks.length > 0) {
    return { ok: false, errorText: errorBlocks.join('\n\n') };
  }

  return {
    ok: true,
    value: {
      type: paymentFlowCanon.toLowerCase(),
      amount: amountNum,
      category,
      paymentMode: paymentModeCanon.toLowerCase(),
      createdAt: parsedDate,
    },
  };
}
