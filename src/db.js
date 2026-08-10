import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DBHOSTNAME,
  user: process.env.DBUSERNAME,
  password: process.env.DBPASSWORD,
  database: process.env.DBNAME,
  port: Number(process.env.DBPORT),
  ssl: { rejectUnauthorized: false },
});

async function getLatestBalance(client) {
  const { rows } = await client.query(
    `SELECT "Cash balance" AS "cashBalance", "Card balance" AS "cardBalance", "Total" AS "total"
     FROM "Balances" ORDER BY "Id" DESC LIMIT 1`
  );
  if (rows.length === 0) {
    return { cashBalance: 0, cardBalance: 0, total: 0 };
  }
  return {
    cashBalance: Number(rows[0].cashBalance),
    cardBalance: Number(rows[0].cardBalance),
    total: Number(rows[0].total),
  };
}

export async function addLogEntry({ type, amount, category, paymentMode, discordUserId, createdAt }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prev = await getLatestBalance(client);
    const signedAmount = type === 'income' ? amount : -amount;

    const cashBalance = paymentMode === 'physical' ? prev.cashBalance + signedAmount : prev.cashBalance;
    const cardBalance = paymentMode === 'digital' ? prev.cardBalance + signedAmount : prev.cardBalance;
    const total = cashBalance + cardBalance;

    const logResult = await client.query(
      `INSERT INTO "Logs" ("Type", "Amount", "Category", "Payment mode", "Discord user id", "Created at")
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))
       RETURNING "Id" AS "id", "Created at" AS "createdAt"`,
      [type, amount, category, paymentMode, discordUserId, createdAt ?? null]
    );
    const log = logResult.rows[0];

    await client.query(
      `INSERT INTO "Balances" ("Log id", "Cash balance", "Card balance", "Total")
       VALUES ($1, $2, $3, $4)`,
      [log.id, cashBalance, cardBalance, total]
    );

    await client.query('COMMIT');
    return { logId: log.id, createdAt: log.createdAt, cashBalance, cardBalance, total };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function setLogNote(logId, note) {
  const { rows } = await pool.query(
    `UPDATE "Logs" SET "Note" = $1 WHERE "Id" = $2 RETURNING "Id" AS "id"`,
    [note, logId]
  );
  return rows.length > 0;
}

export async function getLogById(logId) {
  const { rows } = await pool.query(
    `SELECT "Id" AS "id", "Created at" AS "createdAt", "Type" AS "type", "Amount" AS "amount",
            "Category" AS "category", "Payment mode" AS "paymentMode", "Note" AS "note"
     FROM "Logs" WHERE "Id" = $1`,
    [logId]
  );
  return rows[0] ?? null;
}

async function rebuildAllBalances(client) {
  await client.query(`DELETE FROM "Balances"`);

  const { rows: remaining } = await client.query(
    `SELECT "Id" AS "id", "Type" AS "type", "Amount" AS "amount", "Payment mode" AS "paymentMode"
     FROM "Logs" ORDER BY "Id" ASC`
  );

  let cashBalance = 0;
  let cardBalance = 0;
  for (const log of remaining) {
    const signedAmount = log.type === 'income' ? Number(log.amount) : -Number(log.amount);
    if (log.paymentMode === 'physical') cashBalance += signedAmount;
    else cardBalance += signedAmount;
    const total = cashBalance + cardBalance;
    await client.query(
      `INSERT INTO "Balances" ("Log id", "Cash balance", "Card balance", "Total") VALUES ($1, $2, $3, $4)`,
      [log.id, cashBalance, cardBalance, total]
    );
  }

  return { cashBalance, cardBalance, total: cashBalance + cardBalance };
}

export async function deleteLogById(logId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT "Id" AS "id", "Type" AS "type", "Amount" AS "amount", "Category" AS "category",
              "Payment mode" AS "paymentMode", "Note" AS "note"
       FROM "Logs" WHERE "Id" = $1`,
      [logId]
    );
    if (existing.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const deleted = existing[0];
    await client.query(`DELETE FROM "Logs" WHERE "Id" = $1`, [logId]);
    const restored = await rebuildAllBalances(client);
    await client.query('COMMIT');
    return { deleted, restored };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function editLogById(logId, { type, amount, category, paymentMode, createdAt, note }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `SELECT "Id" AS "id", "Type" AS "type", "Amount" AS "amount", "Category" AS "category",
              "Payment mode" AS "paymentMode", "Created at" AS "createdAt", "Note" AS "note"
       FROM "Logs" WHERE "Id" = $1`,
      [logId]
    );
    if (existing.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const before = existing[0];

    const ledgerAffectingChanged =
      type !== before.type ||
      Number(amount) !== Number(before.amount) ||
      paymentMode !== before.paymentMode;

    await client.query(
      `UPDATE "Logs"
       SET "Type" = $1, "Amount" = $2, "Category" = $3, "Payment mode" = $4, "Created at" = $5
       WHERE "Id" = $6`,
      [type, amount, category, paymentMode, createdAt, logId]
    );

    const noteChanged = note !== undefined && note !== before.note;
    if (noteChanged) {
      await client.query(`UPDATE "Logs" SET "Note" = $1 WHERE "Id" = $2`, [note, logId]);
    }

    let restored = null;
    if (ledgerAffectingChanged) {
      restored = await rebuildAllBalances(client);
    }

    await client.query('COMMIT');
    return { before, ledgerRebuilt: ledgerAffectingChanged, noteChanged, restored };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function undoLastEntry() {
  const { rows } = await pool.query(`SELECT "Id" AS "id" FROM "Logs" ORDER BY "Id" DESC LIMIT 1`);
  if (rows.length === 0) return null;
  return deleteLogById(rows[0].id);
}

export async function getCurrentBalance() {
  const client = await pool.connect();
  try {
    return await getLatestBalance(client);
  } finally {
    client.release();
  }
}

export async function getRecentHistory(limit = 10) {
  const { rows } = await pool.query(
    `SELECT "Id" AS "id", "Created at" AS "createdAt", "Type" AS "type", "Amount" AS "amount",
            "Category" AS "category", "Payment mode" AS "paymentMode", "Note" AS "note"
     FROM "Logs" ORDER BY "Created at" DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getLogsBetween(fromDate, toDate) {
  const { rows } = await pool.query(
    `SELECT l."Id" AS "id", l."Created at" AS "createdAt", l."Type" AS "type", l."Amount" AS "amount",
            l."Category" AS "category", l."Payment mode" AS "paymentMode", l."Note" AS "note",
            b."Cash balance" AS "cashBalance", b."Card balance" AS "cardBalance", b."Total" AS "total"
     FROM "Logs" l
     JOIN "Balances" b ON b."Log id" = l."Id"
     WHERE l."Created at" BETWEEN $1 AND $2
     ORDER BY l."Created at" ASC`,
    [fromDate, toDate]
  );
  return rows;
}

export async function pingDatabase() {
  await pool.query('SELECT 1');
}