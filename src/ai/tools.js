import { getCurrentBalance, getRecentHistory, getSpendingByCategory, getTotals } from '../db.js';

function parseIsoDate(iso, endOfDay) {
  if (!iso || typeof iso !== 'string') return null;
  const suffix = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';
  const d = new Date(`${iso}${suffix}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const EPOCH = new Date(0);
const FAR_FUTURE = new Date(8640000000000000);

function resolveRange(args) {
  const from = parseIsoDate(args.from_date, false) ?? EPOCH;
  const to = parseIsoDate(args.to_date, true) ?? FAR_FUTURE;
  return { from, to };
}

export const toolDeclarations = [
  {
    name: 'get_balance',
    description: 'Get the current cash, card, and total balance right now.',
    parametersJsonSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_spending_by_category',
    description:
      'Get income/expense totals broken down by category, optionally within a date range. Use this for "what did I spend the most on" type questions.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'Start date, YYYY-MM-DD. Omit for all-time.' },
        to_date: { type: 'string', description: 'End date, YYYY-MM-DD. Omit for up to today.' },
      },
      required: [],
    },
  },
  {
    name: 'get_totals',
    description:
      'Get total income and total expenses summed within a date range. Use this for "how much did I spend/earn" type questions.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'Start date, YYYY-MM-DD. Omit for all-time.' },
        to_date: { type: 'string', description: 'End date, YYYY-MM-DD. Omit for up to today.' },
      },
      required: [],
    },
  },
  {
    name: 'get_recent_transactions',
    description: 'Get the most recent individual transactions, most recent first.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'How many to return, 1-25. Defaults to 10.' },
      },
      required: [],
    },
  },
];

export async function callTool(name, args = {}) {
  switch (name) {
    case 'get_balance':
      return getCurrentBalance();

    case 'get_spending_by_category': {
      const { from, to } = resolveRange(args);
      return getSpendingByCategory(from, to);
    }

    case 'get_totals': {
      const { from, to } = resolveRange(args);
      return getTotals(from, to);
    }

    case 'get_recent_transactions': {
      const count = Math.min(Math.max(Number(args.count) || 10, 1), 25);
      const rows = await getRecentHistory(count);
      return rows.map((r) => ({
        id: r.id,
        date: r.createdAt,
        type: r.type,
        amount: Number(r.amount),
        category: r.category,
        paymentMode: r.paymentMode,
        note: r.note,
      }));
    }

    default:
      throw new Error(`Unknown tool requested: ${name}`);
  }
}