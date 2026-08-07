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

export async function undoLastEntry() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT "Id" AS "id", "Type" AS "type", "Amount" AS "amount", "Category" AS "category",
              "Payment mode" AS "paymentMode", "Note" AS "note"
       FROM "Logs" ORDER BY "Id" DESC LIMIT 1`
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const deleted = rows[0];

    await client.query(`DELETE FROM "Logs" WHERE "Id" = $1`, [deleted.id]);
    const restored = await getLatestBalance(client);

    await client.query('COMMIT');
    return { deleted, restored };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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

export async function pingDatabase() {
  await pool.query('SELECT 1');
}