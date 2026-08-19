const TABLE_MAP = {
  logs: {
    dbTable: '"Logs"',
    columns: {
      id: '"Id"',
      created_at: '"Created at"',
      type: '"Type"',
      amount: '"Amount"',
      category: '"Category"',
      payment_mode: '"Payment mode"',
      note: '"Note"',
    },
  },
  balances: {
    dbTable: '"Balances"',
    columns: {
      id: '"Id"',
      log_id: '"Log id"',
      cash_balance: '"Cash balance"',
      card_balance: '"Card balance"',
      total: '"Total"',
      created_at: '"Created at"',
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

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function sanitizeAlias(alias) {
  const clean = String(alias).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
  return clean || 'value';
}

export function buildSelectQuery(args = {}) {
  const { table, select, where = [], where_logic = 'AND', group_by = [], order_by = [], limit } = args;

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

  for (const item of select) {
    const { column, aggregate = 'NONE', alias } = item ?? {};
    const dbCol = columnMap[column];
    if (!dbCol) throw new Error(`Unknown column "${column}" for table "${table}". Allowed: ${columnNames.join(', ')}`);
    if (!ALLOWED_AGGREGATES.has(aggregate)) throw new Error(`Unknown aggregate: "${aggregate}"`);

    const expr = aggregate === 'NONE' ? dbCol : `${aggregate}(${dbCol})`;
    const outputAlias = alias ? sanitizeAlias(alias) : (aggregate === 'NONE' ? column : `${aggregate.toLowerCase()}_${column}`);
    aliasSet.add(outputAlias);
    selectParts.push(`${expr} AS "${outputAlias}"`);
  }

  const whereParts = [];
  for (const cond of where) {
    const { column, operator, value } = cond ?? {};
    const dbCol = columnMap[column];
    if (!dbCol) throw new Error(`Unknown column "${column}" for table "${table}" in where clause`);
    if (!ALLOWED_OPERATORS.has(operator)) throw new Error(`Unknown operator: "${operator}"`);

    if (operator === 'IS NULL' || operator === 'IS NOT NULL') {
      whereParts.push(`${dbCol} ${operator}`);
    } else if (operator === 'IN' || operator === 'NOT IN') {
      if (!Array.isArray(value) || value.length === 0) throw new Error(`${operator} requires a non-empty array value`);
      const placeholders = value.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      whereParts.push(`${dbCol} ${operator} (${placeholders.join(', ')})`);
    } else if (operator === 'BETWEEN') {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('BETWEEN requires a 2-element array value [from, to]');
      params.push(value[0]);
      const p1 = `$${params.length}`;
      params.push(value[1]);
      const p2 = `$${params.length}`;
      whereParts.push(`${dbCol} BETWEEN ${p1} AND ${p2}`);
    } else {
      params.push(value);
      whereParts.push(`${dbCol} ${operator} $${params.length}`);
    }
  }

  const groupByParts = group_by.map((col) => {
    const dbCol = columnMap[col];
    if (!dbCol) throw new Error(`Unknown column "${col}" for table "${table}" in group_by`);
    return dbCol;
  });

  const orderByParts = order_by.map(({ column, direction = 'ASC' } = {}) => {
    const dir = direction === 'DESC' ? 'DESC' : 'ASC';
    if (columnMap[column]) return `${columnMap[column]} ${dir}`;
    if (aliasSet.has(column)) return `"${column}" ${dir}`;
    throw new Error(`Unknown column/alias "${column}" for table "${table}" in order_by`);
  });

  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  let sql = `SELECT ${selectParts.join(', ')} FROM ${tableConfig.dbTable}`;
  if (whereParts.length > 0) {
    const logic = where_logic === 'OR' ? ' OR ' : ' AND ';
    sql += ` WHERE ${whereParts.join(logic)}`;
  }
  if (groupByParts.length > 0) {
    sql += ` GROUP BY ${groupByParts.join(', ')}`;
  }
  if (orderByParts.length > 0) {
    sql += ` ORDER BY ${orderByParts.join(', ')}`;
  }
  sql += ` LIMIT ${safeLimit}`;

  return { sql, params };
}