import { runReadOnlyQuery } from '../db.js';
import { buildSelectQuery, ALLOWED_TABLES, allowedColumnsFor } from './queryBuilder.js';

export const toolDeclarations = [
  {
    name: 'query_data',
    description:
      `Run a flexible, read-only query against the finance database to answer any question about balances, income, expenses, transaction history, or the currently configured currency/timezone. Supports selecting columns or aggregates (COUNT/SUM/AVG/MIN/MAX), filtering (=, !=, >, <, >=, <=, LIKE, NOT LIKE, IN, NOT IN, BETWEEN, IS NULL, IS NOT NULL), grouping, a having filter on aggregated results, ordering, and a row limit up to 5000 (default 50 — raise it explicitly for anything meant to return more). Three tables are available: ` +
      `"logs" (columns: ${allowedColumnsFor('logs').join(', ')}) holds every individual transaction. type is exactly 'income' or 'expense'. payment_mode is exactly 'physical' or 'digital'. amount is always a positive number regardless of type — expenses are not stored as negative. This table is pre-joined to that log's own balance snapshot, so balance_cash_balance, balance_card_balance, balance_total, and balance_currency are also selectable/filterable here directly — no second query needed to combine a log's own fields (amount, category, type, ...) with its currency or resulting balance. ` +
      `"balances" (columns: ${allowedColumnsFor('balances').join(', ')}) holds a running cash/card/total balance snapshot after every log entry, each with its own created_at timestamp — order by id DESC limit 1 for the current balance, or filter created_at to find the balance as of a given date. log_id links a balance row back to logs.id, and this table is likewise pre-joined back to that log's own fields, exposed as log_type, log_amount, log_category, log_payment_mode, log_note, log_timezone, log_created_at. ` +
      `"constants" (columns: ${allowedColumnsFor('constants').join(', ')}) is a single fixed row (id = 1) holding the currently configured currency (3-letter ISO code) and timezone — the same live values already given to you in the system instruction, exposed here too in case you need to re-check them mid-conversation rather than trusting a stale value. ` +
      `This tool can never modify data — it only builds and executes a SELECT.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', enum: ALLOWED_TABLES, description: 'Which table to query.' },
        select: {
          type: 'array',
          description: 'Columns or aggregates to return. At least one required.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: 'Column to select (must exist on the chosen table).' },
              aggregate: {
                type: 'string',
                enum: ['NONE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX'],
                description: 'Aggregate function to apply, or NONE for the raw column. Defaults to NONE.',
              },
              alias: { type: 'string', description: 'Optional output name for this column, useful with aggregates (e.g. "total_spent").' },
            },
            required: ['column'],
          },
        },
        where: {
          type: 'array',
          description: 'Filter conditions.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string' },
              operator: {
                type: 'string',
                enum: ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL'],
              },
              value: {
                description:
                  'Value to compare against. String/number for most operators. Use "%text%" style patterns for LIKE. Use an array for IN/NOT IN. Use a 2-element array [from, to] for BETWEEN. Omit for IS NULL / IS NOT NULL. Dates as ISO strings (YYYY-MM-DD).',
              },
            },
            required: ['column', 'operator'],
          },
        },
        where_logic: { type: 'string', enum: ['AND', 'OR'], description: 'How multiple where conditions combine. Defaults to AND.' },
        group_by: { type: 'array', items: { type: 'string' } },
        having: {
          type: 'array',
          description:
            'Filter conditions applied AFTER grouping/aggregation (e.g. "only categories where total_spent > 5000"). Requires group_by to be set. Unlike where, the "column" here must be one of the output aliases from select, not a raw column — reference the same alias/name you gave (or that was auto-generated for) an aggregated select item.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: 'An alias from select (e.g. "total_spent"), not a raw table column.' },
              operator: {
                type: 'string',
                enum: ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL'],
              },
              value: { description: 'Same value rules as in where.' },
            },
            required: ['column', 'operator'],
          },
        },
        having_logic: { type: 'string', enum: ['AND', 'OR'], description: 'How multiple having conditions combine. Defaults to AND.' },
        order_by: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string', description: 'A column name or a select alias.' },
              direction: { type: 'string', enum: ['ASC', 'DESC'] },
            },
            required: ['column'],
          },
        },
        limit: { type: 'number', description: 'Max rows to return, 1-5000. Defaults to 50 — set this explicitly higher when the question calls for more than a default-sized sample (e.g. "every transaction this year").' },
      },
      required: ['table', 'select'],
    },
  },
];

export async function callTool(name, args = {}) {
  switch (name) {
    case 'query_data': {
      const { sql, params } = buildSelectQuery(args);
      return runReadOnlyQuery(sql, params);
    }

    default:
      throw new Error(`Unknown tool requested: ${name}`);
  }
}