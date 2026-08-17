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

function parseDDMMYYYYComponents(input) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(input.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  const probe = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (probe.getDate() !== day || probe.getMonth() !== month - 1 || probe.getFullYear() !== year) {
    return null;
  }
  return { day, month, year };
}

export function parseDateDDMMYYYY(input) {
  const c = parseDDMMYYYYComponents(input);
  if (!c) return null;
  const now = new Date();
  return new Date(c.year, c.month - 1, c.day, now.getHours(), now.getMinutes(), now.getSeconds());
}

export function parseDateStartOfDay(input) {
  const c = parseDDMMYYYYComponents(input);
  if (!c) return null;
  return new Date(c.year, c.month - 1, c.day, 0, 0, 0, 0);
}

export function parseDateEndOfDay(input) {
  const c = parseDDMMYYYYComponents(input);
  if (!c) return null;
  return new Date(c.year, c.month - 1, c.day, 23, 59, 59, 999);
}

export function formatDDMMYYYY(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${date.getFullYear()}`;
}

export function todayDDMMYYYY() {
  return formatDDMMYYYY(new Date());
}

export function defaultFileFromDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
}

export const FILE_EXPORT_EPOCH = new Date(0);