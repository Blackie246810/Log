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
    `SELECT b."Cash balance" AS "cashBalance", b."Card balance" AS "cardBalance", b."Total" AS "total"
     FROM "Balances" b
     JOIN "Logs" l ON b."Log id" = l."Id"
     ORDER BY l."Created at" DESC, l."Id" DESC LIMIT 1`
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

async function propagateDelta(client, { afterCreatedAt, afterId, cashDelta, cardDelta, totalDelta }) {
  if (cashDelta === 0 && cardDelta === 0 && totalDelta === 0) return;
  await client.query(
    `UPDATE "Balances" b
     SET "Cash balance" = "Cash balance" + $1,
         "Card balance" = "Card balance" + $2,
         "Total" = "Total" + $3
     FROM "Logs" l
     WHERE b."Log id" = l."Id"
       AND (l."Created at" > $4 OR (l."Created at" = $4 AND l."Id" > $5))`,
    [cashDelta, cardDelta, totalDelta, afterCreatedAt, afterId]
  );
}

async function removeContribution(client, { id, createdAt, type, amount, paymentMode }) {
  const signedAmount = type === 'income' ? Number(amount) : -Number(amount);
  await client.query(`DELETE FROM "Balances" WHERE "Log id" = $1`, [id]);
  await propagateDelta(client, {
    afterCreatedAt: createdAt,
    afterId: id,
    cashDelta: paymentMode === 'physical' ? -signedAmount : 0,
    cardDelta: paymentMode === 'digital' ? -signedAmount : 0,
    totalDelta: -signedAmount,
  });
}

async function findAnchorBalance(client, { createdAt, id }) {
  const { rows } = await client.query(
    `SELECT b."Cash balance" AS "cashBalance", b."Card balance" AS "cardBalance"
     FROM "Balances" b
     JOIN "Logs" l ON b."Log id" = l."Id"
     WHERE l."Created at" < $1 OR (l."Created at" = $1 AND l."Id" < $2)
     ORDER BY l."Created at" DESC, l."Id" DESC LIMIT 1`,
    [createdAt, id]
  );
  if (rows.length === 0) return { cashBalance: 0, cardBalance: 0 };
  return { cashBalance: Number(rows[0].cashBalance), cardBalance: Number(rows[0].cardBalance) };
}

async function insertContribution(client, { id, createdAt, type, amount, paymentMode }) {
  const signedAmount = type === 'income' ? Number(amount) : -Number(amount);
  const anchor = await findAnchorBalance(client, { createdAt, id });

  const cashBalance = anchor.cashBalance + (paymentMode === 'physical' ? signedAmount : 0);
  const cardBalance = anchor.cardBalance + (paymentMode === 'digital' ? signedAmount : 0);
  const total = cashBalance + cardBalance;

  await client.query(
    `INSERT INTO "Balances" ("Log id", "Cash balance", "Card balance", "Total") VALUES ($1, $2, $3, $4)`,
    [id, cashBalance, cardBalance, total]
  );

  await propagateDelta(client, {
    afterCreatedAt: createdAt,
    afterId: id,
    cashDelta: paymentMode === 'physical' ? signedAmount : 0,
    cardDelta: paymentMode === 'digital' ? signedAmount : 0,
    totalDelta: signedAmount,
  });

  return { cashBalance, cardBalance, total };
}

export async function addLogEntry({ type, amount, category, paymentMode, createdAt }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const logResult = await client.query(
      `INSERT INTO "Logs" ("Type", "Amount", "Category", "Payment mode", "Created at")
       VALUES ($1, $2, $3, $4, COALESCE($5, now()))
       RETURNING "Id" AS "id", "Created at" AS "createdAt"`,
      [type, amount, category, paymentMode, createdAt ?? null]
    );
    const log = logResult.rows[0];
    const own = await insertContribution(client, {
      id: log.id,
      createdAt: log.createdAt,
      type,
      amount,
      paymentMode,
    });

    await client.query('COMMIT');
    return { logId: log.id, createdAt: log.createdAt, ...own };
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
     FROM "Logs" ORDER BY "Created at" ASC, "Id" ASC`
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

export async function repairAllBalances() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await rebuildAllBalances(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteLogById(logId) {
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
    const deleted = existing[0];

    await removeContribution(client, deleted);
    await client.query(`DELETE FROM "Logs" WHERE "Id" = $1`, [logId]);

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
      paymentMode !== before.paymentMode ||
      new Date(createdAt).getTime() !== new Date(before.createdAt).getTime();

    if (ledgerAffectingChanged) {
      await removeContribution(client, before);
    }

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
      restored = await insertContribution(client, { id: logId, createdAt, type, amount, paymentMode });
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

export async function runReadOnlyQuery(sql, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '5s'`);
    const { rows } = await client.query(sql, params);
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getConversationHistory() {
  const { rows } = await pool.query(
    `SELECT "Content" AS "content" FROM "Conversations" WHERE "Id" = 1`
  );
  return rows[0]?.content ?? [];
}

export async function saveConversationHistory(content) {
  await pool.query(
    `INSERT INTO "Conversations" ("Id", "Content", "Updated at")
     VALUES (1, $1, now())
     ON CONFLICT ("Id")
     DO UPDATE SET "Content" = EXCLUDED."Content", "Updated at" = now()`,
    [JSON.stringify(content)]
  );
}

export async function clearConversationHistory() {
  await pool.query(`DELETE FROM "Conversations" WHERE "Id" = 1`);
}