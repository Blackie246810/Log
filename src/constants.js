export const CATEGORIES = [
  'Food/Drink', 'Travel', 'Stationary/Grocery', 'Income', 'Exchange',
  'Laundry', 'Recharge', 'Other services', 'Interpersonal transactions',
  'Fees', 'Assignment', 'Salary',
];

export const PAYMENT_MODES = ['Physical', 'Digital'];
export const PAYMENT_FLOWS = ['Income', 'Expense'];

export function matchCanonical(input, canonicalList) {
  const found = canonicalList.find((c) => c.toLowerCase() === input.trim().toLowerCase());
  return found ?? null;
}

// ---------------------------------------------------------------------------
// Date/time handling — anchored to IST (Asia/Kolkata), not the server clock.
//
// Render's server clock runs in UTC, but every log entry belongs to a single
// person in Chennai. India has no DST, so IST is always UTC+5:30 — a fixed
// offset, not something that needs a timezone-database lookup. Every "now",
// every typed date, and every displayed date is converted through this fixed
// offset so the bot behaves the same regardless of what timezone the host
// happens to be running in.
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// A stored "Created at" value is an absolute instant (UTC under the hood).
// This pulls out what that instant reads as on an IST wall clock.
function toISTParts(date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
  };
}

// Inverse: given IST wall-clock components (what the user typed, or wants to
// see), build the absolute instant (Date) that corresponds to it.
function fromISTParts({ year, month, day, hours = 0, minutes = 0, seconds = 0, ms = 0 }) {
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, ms) - IST_OFFSET_MS);
}

function parseDDMMYYYYComponents(input) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(input.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  // Round-trip through fromISTParts/toISTParts to reject invalid calendar
  // dates (e.g. 31-02-2026) the same way the old Date-object probe did.
  const check = toISTParts(fromISTParts({ year, month, day, hours: 12 }));
  if (check.day !== day || check.month !== month || check.year !== year) return null;
  return { day, month, year };
}

function parseDateTimeComponents(input) {
  const match = /^(\d{2})-(\d{2})-(\d{4})[ ,]+(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  if (hours > 23 || minutes > 59) return null;

  const check = toISTParts(fromISTParts({ year, month, day, hours, minutes }));
  if (check.day !== day || check.month !== month || check.year !== year) return null;
  return { day, month, year, hours, minutes };
}

// Date-only parsing — used by /file's from/to range.
export function parseDateStartOfDay(input) {
  const c = parseDDMMYYYYComponents(input);
  if (!c) return null;
  return fromISTParts({ ...c, hours: 0, minutes: 0, seconds: 0, ms: 0 });
}

export function parseDateEndOfDay(input) {
  const c = parseDDMMYYYYComponents(input);
  if (!c) return null;
  return fromISTParts({ ...c, hours: 23, minutes: 59, seconds: 59, ms: 999 });
}

// Date + time parsing — used by /log and /edit.
export function parseDateTimeDDMMYYYY(input) {
  const c = parseDateTimeComponents(input);
  if (!c) return null;
  return fromISTParts(c);
}

export function formatDDMMYYYY(date) {
  const p = toISTParts(date);
  const dd = String(p.day).padStart(2, '0');
  const mm = String(p.month).padStart(2, '0');
  return `${dd}-${mm}-${p.year}`;
}

export function formatDateTimeDDMMYYYY(date) {
  const p = toISTParts(date);
  const dd = String(p.day).padStart(2, '0');
  const mm = String(p.month).padStart(2, '0');
  const hh = String(p.hours).padStart(2, '0');
  const mi = String(p.minutes).padStart(2, '0');
  return `${dd}-${mm}-${p.year} ${hh}:${mi}`;
}

export function todayDDMMYYYY() {
  return formatDDMMYYYY(new Date());
}

export function nowDateTimeDDMMYYYY() {
  return formatDateTimeDDMMYYYY(new Date());
}

export function defaultFileFromDate() {
  const p = toISTParts(new Date());
  // month - 1 here is deliberately allowed to go to 0 — Date.UTC (inside
  // fromISTParts) normalizes that to December of the previous year, so
  // this correctly rolls back across a January -> December year boundary.
  return fromISTParts({ year: p.year, month: p.month - 1, day: 1, hours: 0, minutes: 0 });
}

export const FILE_EXPORT_EPOCH = new Date(0);