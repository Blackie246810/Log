export const CATEGORIES = [
  'Food/Drink', 'Travel', 'Stationary/Grocery', 'Income', 'Exchange',
  'Laundry', 'Recharge', 'Other services', 'Interpersonal transactions',
  'Fees', 'Assignment',
];

export const PAYMENT_MODES = ['Physical', 'Digital'];
export const PAYMENT_FLOWS = ['Income', 'Expense'];

export function matchCanonical(input, canonicalList) {
  const found = canonicalList.find((c) => c.toLowerCase() === input.trim().toLowerCase());
  return found ?? null;
}

export function parseDateDDMMYYYY(input) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(input.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  const now = new Date();
  const candidate = new Date(year, month - 1, day, now.getHours(), now.getMinutes(), now.getSeconds());

  if (candidate.getDate() !== day || candidate.getMonth() !== month - 1 || candidate.getFullYear() !== year) {
    return null;
  }
  return candidate;
}

export function todayDDMMYYYY() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}