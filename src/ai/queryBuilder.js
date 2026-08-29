// Every table a caller can pick with `table:` gets its own alias as the
// FROM target, plus (where relevant) a JOIN to the other side of the
// Logs<->Balances 1:1 relationship (linked by Balances."Log id" = Logs."Id").
// That join is always applied, not opt-in — it costs nothing on a personal
// finance dataset this size, and it means a single query_data call can pull
// e.g. "expenses over 500 paid in USD" (amount+category live on Logs,
// currency lives on Balances) without a second round trip to correlate by
// hand. Columns pulled in from the *other* table are prefixed (balance_* /
// log_*) so nothing collides with the primary table's own id/created_at.
const TABLE_MAP = {
  logs: {
    from: '"Logs" l LEFT JOIN "Balances" b ON b."Log id" = l."Id"',
    columns: {
      id: 'l."Id"',
      created_at: 'l."Created at"',
      type: 'l."Type"',
      amount: 'l."Amount"',
      category: 'l."Category"',
      payment_mode: 'l."Payment mode"',
      note: 'l."Note"',
      timezone: 'l."Timezone"',
      // joined in from this log's own Balances row
      balance_id: 'b."Id"',
      balance_cash_balance: 'b."Cash balance"',
      balance_card_balance: 'b."Card balance"',
      balance_total: 'b."Total"',
      balance_created_at: 'b."Created at"',
      balance_currency: 'b."Currency"',
    },
  },
  balances: {
    from: '"Balances" b LEFT JOIN "Logs" l ON b."Log id" = l."Id"',
    columns: {
      id: 'b."Id"',
      log_id: 'b."Log id"',
      cash_balance: 'b."Cash balance"',
      card_balance: 'b."Card balance"',
      total: 'b."Total"',
      created_at: 'b."Created at"',
      currency: 'b."Currency"',
      // joined in from the log this balance row belongs to
      log_type: 'l."Type"',
      log_amount: 'l."Amount"',
      log_category: 'l."Category"',
      log_payment_mode: 'l."Payment mode"',
      log_note: 'l."Note"',
      log_timezone: 'l."Timezone"',
      log_created_at: 'l."Created at"',
    },
  },
  constants: {
    // single fixed row, no relation to anything else — no join needed
    from: '"Constants"',
    columns: {
      id: '"Id"',
      currency: '"Currency"',
      timezone: '"Timezone"',
    },
  },
};

export const ALLOWED_TABLES = Object.keys(TABLE_MAP);

export function allowedColumnsFor(table) {
  return Object.keys(TABLE_MAP[table]?.columns ?? {});
}

const ALLOWED_AGGREGATES = new Set(['NONE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

const ALLOWED_OPERATORS = new Set([
  '=', '!=', '>', '<', '>=', '<=',
  'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL',
]);

// The table-image/file-export pipeline downstream is explicitly built to
// handle arbitrarily large result sets (splitting across images/messages
// on its own), so this cap exists only to bound query cost/latency inside
// the 5s read-only statement timeout — not to gatekeep "how much data the
// AI is allowed to see." DEFAULT_LIMIT stays small so an unscoped question
// doesn't come back as a wall of data unless more is actually asked for.
const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 50;

function sanitizeAlias(alias) {
  const clean = String(alias).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
  return clean || 'value';
}

// Shared by WHERE and HAVING — same operator/value handling either way,
// just against a different pool of resolvable expressions.
function buildCondition(dbExpr, operator, value, params) {
  if (!ALLOWED_OPERATORS.has(operator)) throw new Error(`Unknown operator: "${operator}"`);

  if (operator === 'IS NULL' || operator === 'IS NOT NULL') {
    return `${dbExpr} ${operator}`;
  }
  if (operator === 'IN' || operator === 'NOT IN') {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${operator} requires a non-empty array value`);
    const placeholders = value.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return `${dbExpr} ${operator} (${placeholders.join(', ')})`;
  }
  if (operator === 'BETWEEN') {
    if (!Array.isArray(value) || value.length !== 2) throw new Error('BETWEEN requires a 2-element array value [from, to]');
    params.push(value[0]);
    const p1 = `$${params.length}`;
    params.push(value[1]);
    const p2 = `$${params.length}`;
    return `${dbExpr} BETWEEN ${p1} AND ${p2}`;
  }
  params.push(value);
  return `${dbExpr} ${operator} $${params.length}`;
}

export function buildSelectQuery(args = {}) {
  const { table, select, where = [], where_logic = 'AND', group_by = [], having = [], having_logic = 'AND', order_by = [], limit } = args;

  const tableConfig = TABLE_MAP[table];
  if (!tableConfig) {
    throw new Error(`Unknown table: "${table}". Allowed: ${ALLOWED_TABLES.join(', ')}`);
  }
  const columnMap = tableConfig.columns;
  const columnNames = Object.keys(columnMap);

  if (!Array.isArray(select) || select.length === 0) {
    throw new Error('select must be a non-empty array of {column, aggregate?, alias?}');
  }

  const params = [];
  const selectParts = [];
  const aliasSet = new Set();
  const exprByAlias = new Map(); // output alias -> full SQL expression, so HAVING can re-embed it

  for (const item of select) {
    const { column, aggregate = 'NONE', alias } = item ?? {};
    const dbCol = columnMap[column];
    if (!dbCol) throw new Error(`Unknown column "${column}" for table "${table}". Allowed: ${columnNames.join(', ')}`);
    if (!ALLOWED_AGGREGATES.has(aggregate)) throw new Error(`Unknown aggregate: "${aggregate}"`);

    const expr = aggregate === 'NONE' ? dbCol : `${aggregate}(${dbCol})`;
    const outputAlias = alias ? sanitizeAlias(alias) : (aggregate === 'NONE' ? column : `${aggregate.toLowerCase()}_${column}`);
    aliasSet.add(outputAlias);
    exprByAlias.set(outputAlias, expr);
    selectParts.push(`${expr} AS "${outputAlias}"`);
  }

  const whereParts = where.map((cond) => {
    const { column, operator, value } = cond ?? {};
    const dbCol = columnMap[column];
    if (!dbCol) throw new Error(`Unknown column "${column}" for table "${table}" in where clause`);
    return buildCondition(dbCol, operator, value, params);
  });

  const groupByParts = group_by.map((col) => {
    const dbCol = columnMap[col];
    if (!dbCol) throw new Error(`Unknown column "${col}" for table "${table}" in group_by`);
    return dbCol;
  });

  // HAVING filters on the *aggregated* result, so it resolves against the
  // select list's own output aliases (e.g. a "total_spent" SUM(...) alias),
  // not raw column names — Postgres doesn't accept output aliases directly
  // in HAVING, so the original expression is re-embedded here instead.
  const havingParts = having.map((cond) => {
    const { column, operator, value } = cond ?? {};
    const expr = exprByAlias.get(column);
    if (!expr) throw new Error(`Unknown alias "${column}" in having clause — must match an alias from select. Available: ${[...aliasSet].join(', ')}`);
    return buildCondition(expr, operator, value, params);
  });

  const orderByParts = order_by.map(({ column, direction = 'ASC' } = {}) => {
    const dir = direction === 'DESC' ? 'DESC' : 'ASC';
    if (columnMap[column]) return `${columnMap[column]} ${dir}`;
    if (aliasSet.has(column)) return `"${column}" ${dir}`;
    throw new Error(`Unknown column/alias "${column}" for table "${table}" in order_by`);
  });

  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  let sql = `SELECT ${selectParts.join(', ')} FROM ${tableConfig.from}`;
  if (whereParts.length > 0) {
    const logic = where_logic === 'OR' ? ' OR ' : ' AND ';
    sql += ` WHERE ${whereParts.join(logic)}`;
  }
  if (groupByParts.length > 0) {
    sql += ` GROUP BY ${groupByParts.join(', ')}`;
  }
  if (havingParts.length > 0) {
    if (groupByParts.length === 0) throw new Error('having requires group_by to be set');
    const logic = having_logic === 'OR' ? ' OR ' : ' AND ';
    sql += ` HAVING ${havingParts.join(logic)}`;
  }
  if (orderByParts.length > 0) {
    sql += ` ORDER BY ${orderByParts.join(', ')}`;
  }
  sql += ` LIMIT ${safeLimit}`;

  return { sql, params };
}
