import { getTimezone } from './constantsStore.js';

export const CATEGORIES = [
  'Food/Drink', 'Travel', 'Stationary/Grocery', 'Income', 'Exchange',
  'Laundry', 'Recharge/Subscription', 'Other service', 'Interpersonal transaction',
  'Fee', 'Assignment', 'Salary', 'Medical',
];

export const PAYMENT_MODES = ['Physical', 'Digital'];
export const PAYMENT_FLOWS = ['Income', 'Expense'];

export function matchCanonical(input, canonicalList) {
  const found = canonicalList.find((c) => c.toLowerCase() === input.trim().toLowerCase());
  return found ?? null;
}

// ---------------------------------------------------------------------------
// Date/time handling — timezone comes from the Constants table (see
// constantsStore.js), not a fixed offset. Unlike the old IST-only version,
// this must be DST-correct for any IANA zone, so conversions go through
// Intl rather than fixed millisecond math.
// ---------------------------------------------------------------------------

// What a stored UTC instant reads as on a given zone's wall clock.
function toZonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return { year: +p.year, month: +p.month, day: +p.day, hours: +p.hour, minutes: +p.minute };
}

// The UTC offset (ms) that `timeZone` is at for a given instant.
function zoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// Inverse of toZonedParts: given wall-clock components in `timeZone`, find
// the absolute instant (Date) they correspond to. Two-pass so DST
// transitions (where the offset itself depends on the answer) resolve
// correctly.
function fromZonedParts({ year, month, day, hours = 0, minutes = 0, seconds = 0, ms = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hours, minutes, seconds, ms);
  let offset = zoneOffsetMs(new Date(guess), timeZone);
  let utc = guess - offset;
  offset = zoneOffsetMs(new Date(utc), timeZone);
  utc = guess - offset;
  return new Date(utc);
}

// Falls back to the live Constants timezone when `timeZone` is explicitly
// null/undefined/empty — covers both an omitted argument (already handled
// by each exported function's own default parameter) AND a value that WAS
// passed but happens to be null, e.g. a Logs row whose Timezone column is
// somehow empty (pre-migration data, a manual DB edit). Without this, a
// null explicitly passed through (default parameters only kick in for
// undefined, never null) reaches Intl.DateTimeFormat directly and throws
// "Invalid time zone specified: null" — surfacing as a generic error on
// /edit, /history, or /file for that one row instead of a real answer.
function safeTimeZone(timeZone) {
  return timeZone || getTimezone();
}

function parseDDMMYYYYComponents(input, timeZone) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(input.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  const check = toZonedParts(fromZonedParts({ year, month, day, hours: 12 }, timeZone), timeZone);
  if (check.day !== day || check.month !== month || check.year !== year) return null;
  return { day, month, year };
}

// Matches a wall-clock date+time against `timeZone` and confirms the exact
// instant it resolves to actually reads back as that SAME time — not just
// the same day. Without checking hours/minutes too, a time that never
// existed (a DST spring-forward gap, e.g. 02:30 on a day the clock jumps
// straight from 02:00 to 03:00) would silently resolve to some OTHER wall-
// clock time near it and be accepted with no error, quietly storing the
// wrong instant. Checking every field closes that gap; an ambiguous time
// (a fall-back repeat, which really does occur, just twice) still passes,
// since that's a legitimate — if ambiguous — instant, not an invalid one.
function parseDateTimeComponents(input, timeZone) {
  const match = /^(\d{2})-(\d{2})-(\d{4})[ ,]+(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  if (hours > 23 || minutes > 59) return null;

  const check = toZonedParts(fromZonedParts({ year, month, day, hours, minutes }, timeZone), timeZone);
  if (check.day !== day || check.month !== month || check.year !== year || check.hours !== hours || check.minutes !== minutes) return null;
  return { day, month, year, hours, minutes };
}

// Every parse/format function below takes an optional explicit `timeZone`
// (used when re-parsing/redisplaying an EXISTING log — it must use that
// log's own stored timezone, never the live one) and otherwise defaults to
// the live Constants timezone (used for /log and for user-typed ranges like
// /file's from/to, which aren't tied to any specific past record).

export function parseDateStartOfDay(input, timeZone = getTimezone()) {
  timeZone = safeTimeZone(timeZone);
  const c = parseDDMMYYYYComponents(input, timeZone);
  if (!c) return null;
  return fromZonedParts({ ...c, hours: 0, minutes: 0, seconds: 0, ms: 0 }, timeZone);
}

export function parseDateEndOfDay(input, timeZone = getTimezone()) {
  timeZone = safeTimeZone(timeZone);
  const c = parseDDMMYYYYComponents(input, timeZone);
  if (!c) return null;
  return fromZonedParts({ ...c, hours: 23, minutes: 59, seconds: 59, ms: 999 }, timeZone);
}

export function parseDateTimeDDMMYYYY(input, timeZone = getTimezone()) {
  timeZone = safeTimeZone(timeZone);
  const c = parseDateTimeComponents(input, timeZone);
  if (!c) return null;
  return fromZonedParts(c, timeZone);
}

export function formatDDMMYYYY(date, timeZone = getTimezone()) {
  timeZone = safeTimeZone(timeZone);
  const p = toZonedParts(date, timeZone);
  const dd = String(p.day).padStart(2, '0');
  const mm = String(p.month).padStart(2, '0');
  return `${dd}-${mm}-${p.year}`;
}

export function formatDateTimeDDMMYYYY(date, timeZone = getTimezone()) {
  timeZone = safeTimeZone(timeZone);
  const p = toZonedParts(date, timeZone);
  const dd = String(p.day).padStart(2, '0');
  const mm = String(p.month).padStart(2, '0');
  const hh = String(p.hours).padStart(2, '0');
  const mi = String(p.minutes).padStart(2, '0');
  return `${dd}-${mm}-${p.year} ${hh}:${mi}`;
}

export function todayDDMMYYYY(timeZone = getTimezone()) {
  return formatDDMMYYYY(new Date(), safeTimeZone(timeZone));
}

export function nowDateTimeDDMMYYYY(timeZone = getTimezone()) {
  return formatDateTimeDDMMYYYY(new Date(), safeTimeZone(timeZone));
}

export function defaultFileFromDate(timeZone = getTimezone()) {
  timeZone = safeTimeZone(timeZone);
  const p = toZonedParts(new Date(), timeZone);
  return fromZonedParts({ year: p.year, month: p.month, day: 1, hours: 0, minutes: 0 }, timeZone);
}

export const FILE_EXPORT_EPOCH = new Date(0);
