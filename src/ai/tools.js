import { runReadOnlyQuery } from '../db.js';
import { buildSelectQuery, ALLOWED_TABLES, allowedColumnsFor } from './queryBuilder.js';

export const toolDeclarations = [
  {
    name: 'query_data',
    description:
      `Run a flexible, read-only query against the finance database to answer any question about balances, income, expenses, or transaction history. Supports selecting columns or aggregates (COUNT/SUM/AVG/MIN/MAX), filtering (=, !=, >, <, >=, <=, LIKE, NOT LIKE, IN, NOT IN, BETWEEN, IS NULL, IS NOT NULL), grouping, ordering, and a row limit. Two tables are available: ` +
      `"logs" (columns: ${allowedColumnsFor('logs').join(', ')}) holds every individual transaction. type is exactly 'income' or 'expense'. payment_mode is exactly 'physical' or 'digital'. amount is always a positive number regardless of type — expenses are not stored as negative. ` +
      `"balances" (columns: ${allowedColumnsFor('balances').join(', ')}) holds a running cash/card/total balance snapshot after every log entry, each with its own created_at timestamp — order by id DESC limit 1 for the current balance, or filter created_at to find the balance as of a given date. log_id links a balance row back to logs.id. ` +
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
        limit: { type: 'number', description: 'Max rows to return, 1-200. Defaults to 50.' },
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