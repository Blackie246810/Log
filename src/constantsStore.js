// Single-row Constants cache: loaded once at startup, refreshed the instant
// /currency or /timezone runs. Everything else (modals, embeds, exports,
// the AI prompt) reads this in-memory cache instead of hitting the DB or a
// hardcoded value — this IS what "constants.js populated from the table"
// means in practice, since a live process can't rewrite its own source file.
import { getConstantsRow, updateCurrencyRow, updateTimezoneRow, updateLevelRow } from './db.js';
import { DEFAULT_LEVEL_NUMBER } from './ai/modelLevels.js';

let cache = { currency: 'INR', timezone: 'Asia/Kolkata', level: DEFAULT_LEVEL_NUMBER };

export async function loadConstants() {
  const row = await getConstantsRow();
  if (row) cache = { currency: row.currency, timezone: row.timezone, level: row.level || DEFAULT_LEVEL_NUMBER };
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

// Stores just the bare number Ameen entered via /level (e.g. "3.5") — not
// a model id. Resolving that number to an actual model id is
// modelLevels.js's job (see modelIdForNumber there, used by gemini.js),
// kept deliberately separate so this file stays a dumb cache, same as
// currency/timezone.
export function getLevel() {
  return cache.level;
}

export async function setLevel(number) {
  await updateLevelRow(number);
  cache = { ...cache, level: number };
}
