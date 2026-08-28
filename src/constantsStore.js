// Single-row Constants cache: loaded once at startup, refreshed the instant
// /currency or /timezone runs. Everything else (modals, embeds, exports,
// the AI prompt) reads this in-memory cache instead of hitting the DB or a
// hardcoded value — this IS what "constants.js populated from the table"
// means in practice, since a live process can't rewrite its own source file.
import { getConstantsRow, updateCurrencyRow, updateTimezoneRow } from './db.js';

let cache = { currency: 'INR', timezone: 'Asia/Kolkata' };

export async function loadConstants() {
  const row = await getConstantsRow();
  if (row) cache = { currency: row.currency, timezone: row.timezone };
  return cache;
}

export function getCurrency() {
  return cache.currency;
}

export function getTimezone() {
  return cache.timezone;
}

export async function setCurrency(code) {
  await updateCurrencyRow(code);
  cache = { ...cache, currency: code };
}

export async function setTimezone(tz) {
  await updateTimezoneRow(tz);
  cache = { ...cache, timezone: tz };
}
