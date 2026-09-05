import pg from 'pg';
import dotenv from 'dotenv';
import { logError } from './errorReporter.js';

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

// pg's Pool emits 'error' on an IDLE client (one sitting in the pool, not
// mid-query) when its connection drops — a dropped network link, the DB
// restarting, etc. This is independent of any query currently in flight.
// Without a listener, that's an unhandled 'error' event, and Node treats an
// unhandled EventEmitter 'error' as fatal — it crashes the whole process.
// Logging it here keeps the bot alive; the pool reconnects new clients on
// the next query on its own.
pool.on('error', (err) => {
  logError('pg pool: idle client error', err);
});

// ---------------------------------------------------------------------------
// Constants (Currency / Timezone) — single row, mirrors the Conversations
// table's Id-fixed-at-1 pattern. constantsStore.js is the in-memory cache
// that everything else actually reads; these are its only DB touchpoints.
// ---------------------------------------------------------------------------

export async function getConstantsRow() {
  const { rows } = await pool.query(`SELECT "Currency" AS "currency", "Timezone" AS "timezone", "AiLevel" AS "level" FROM "Constants" WHERE "Id" = 1`);
  return rows[0] ?? null;
}

export async function updateCurrencyRow(currency) {
  await pool.query(
    `INSERT INTO "Constants" ("Id", "Currency", "Timezone") VALUES (1, $1, 'Asia/Kolkata')
     ON CONFLICT ("Id") DO UPDATE SET "Currency" = EXCLUDED."Currency"`,
    [currency]
  );
}

export async function updateTimezoneRow(timezone) {
  await pool.query(
    `INSERT INTO "Constants" ("Id", "Currency", "Timezone") VALUES (1, 'INR', $1)
     ON CONFLICT ("Id") DO UPDATE SET "Timezone" = EXCLUDED."Timezone"`,
    [timezone]
  );
}

// Backs /level (see commands/level.js, modals/levelModal.js). Stores only
// the bare number Ameen entered (e.g. "3.5") — resolving that to an actual
// model id is ai/modelLevels.js's job, kept out of the DB layer entirely.
// Requires an "AiLevel" TEXT column on "Constants" — add it once via:
//   ALTER TABLE "Constants" ADD COLUMN "AiLevel" TEXT;
export async function updateLevelRow(level) {
  await pool.query(
    `INSERT INTO "Constants" ("Id", "Currency", "Timezone", "AiLevel") VALUES (1, 'INR', 'Asia/Kolkata', $1)
     ON CONFLICT ("Id") DO UPDATE SET "AiLevel" = EXCLUDED."AiLevel"`,
    [level]
  );
}

async function getLatestBalance(client) {
  const { rows } = await client.query(
    `SELECT b."Cash balance" AS "cashBalance", b."Card balance" AS "cardBalance", b."Total" AS "total", b."Currency" AS "currency"
     FROM "Balances" b
     JOIN "Logs" l ON b."Log id" = l."Id"
     ORDER BY l."Created at" DESC, l."Id" DESC LIMIT 1`
  );
  if (rows.length === 0) {
    return { cashBalance: 0, cardBalance: 0, total: 0, currency: null };
  }
  return {
    cashBalance: Number(rows[0].cashBalance),
    cardBalance: Number(rows[0].cardBalance),
    total: Number(rows[0].total),
    currency: rows[0].currency,
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

async function insertContribution(client, { id, createdAt, type, amount, paymentMode, currency }) {
  const signedAmount = type === 'income' ? Number(amount) : -Number(amount);
  const anchor = await findAnchorBalance(client, { createdAt, id });

  const cashBalance = anchor.cashBalance + (paymentMode === 'physical' ? signedAmount : 0);
  const cardBalance = anchor.cardBalance + (paymentMode === 'digital' ? signedAmount : 0);
  const total = cashBalance + cardBalance;

  await client.query(
    `INSERT INTO "Balances" ("Log id", "Cash balance", "Card balance", "Total", "Currency") VALUES ($1, $2, $3, $4, $5)`,
    [id, cashBalance, cardBalance, total, currency]
  );

  await propagateDelta(client, {
    afterCreatedAt: createdAt,
    afterId: id,
    cashDelta: paymentMode === 'physical' ? signedAmount : 0,
    cardDelta: paymentMode === 'digital' ? signedAmount : 0,
    totalDelta: signedAmount,
  });

  return { cashBalance, cardBalance, total, currency };
}

export async function addLogEntry({ type, amount, category, paymentMode, createdAt, currency, timezone }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const logResult = await client.query(
      `INSERT INTO "Logs" ("Type", "Amount", "Category", "Payment mode", "Created at", "Timezone")
       VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6)
       RETURNING "Id" AS "id", "Created at" AS "createdAt"`,
      [type, amount, category, paymentMode, createdAt ?? null, timezone]
    );
    const log = logResult.rows[0];
    const own = await insertContribution(client, {
      id: log.id,
      createdAt: log.createdAt,
      type,
      amount,
      paymentMode,
      currency,
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
    `SELECT l."Id" AS "id", l."Created at" AS "createdAt", l."Type" AS "type", l."Amount" AS "amount",
            l."Category" AS "category", l."Payment mode" AS "paymentMode", l."Note" AS "note",
            l."Timezone" AS "timezone", b."Currency" AS "currency"
     FROM "Logs" l
     LEFT JOIN "Balances" b ON b."Log id" = l."Id"
     WHERE l."Id" = $1`,
    [logId]
  );
  return rows[0] ?? null;
}

// Rebuild wipes and recreates every Balances row from Logs in order — but
// currency lives on Balances, not Logs, so the currency each row was
// originally created under must be snapshotted BEFORE the wipe and carried
// forward per log id, or a repair run would silently erase currency history.
async function rebuildAllBalances(client, fallbackCurrency) {
  const { rows: currencySnapshot } = await client.query(`SELECT "Log id" AS "logId", "Currency" AS "currency" FROM "Balances"`);
  const currencyByLogId = new Map(currencySnapshot.map((r) => [r.logId, r.currency]));

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
    else if (log.paymentMode === 'digital') cardBalance += signedAmount;
    const total = cashBalance + cardBalance;
    const currency = currencyByLogId.get(log.id) ?? fallbackCurrency;
    await client.query(
      `INSERT INTO "Balances" ("Log id", "Cash balance", "Card balance", "Total", "Currency") VALUES ($1, $2, $3, $4, $5)`,
      [log.id, cashBalance, cardBalance, total, currency]
    );
  }

  return { cashBalance, cardBalance, total: cashBalance + cardBalance };
}

export async function repairAllBalances(fallbackCurrency) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await rebuildAllBalances(client, fallbackCurrency);
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
      `SELECT l."Id" AS "id", l."Type" AS "type", l."Amount" AS "amount", l."Category" AS "category",
              l."Payment mode" AS "paymentMode", l."Created at" AS "createdAt", l."Note" AS "note",
              l."Timezone" AS "timezone", b."Currency" AS "currency"
       FROM "Logs" l
       LEFT JOIN "Balances" b ON b."Log id" = l."Id"
       WHERE l."Id" = $1`,
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

// `timezone` is intentionally NOT a parameter here — a log's Timezone is set
// once at creation and never changes via /edit; the caller re-parses the
// typed date using that original timezone before calling this. `currency`
// likewise always carries forward from the log's own existing Balances row
// (fetched below), never from the live Constants cache, so an edit never
// silently reassigns a past entry to today's currency.
export async function editLogById(logId, { type, amount, category, paymentMode, createdAt, note }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `SELECT l."Id" AS "id", l."Type" AS "type", l."Amount" AS "amount", l."Category" AS "category",
              l."Payment mode" AS "paymentMode", l."Created at" AS "createdAt", l."Note" AS "note",
              l."Timezone" AS "timezone", b."Currency" AS "currency"
       FROM "Logs" l
       LEFT JOIN "Balances" b ON b."Log id" = l."Id"
       WHERE l."Id" = $1`,
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
      restored = await insertContribution(client, {
        id: logId, createdAt, type, amount, paymentMode, currency: before.currency,
      });
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
    `SELECT l."Id" AS "id", l."Created at" AS "createdAt", l."Type" AS "type", l."Amount" AS "amount",
            l."Category" AS "category", l."Payment mode" AS "paymentMode", l."Note" AS "note",
            l."Timezone" AS "timezone", b."Currency" AS "currency"
     FROM "Logs" l
     LEFT JOIN "Balances" b ON b."Log id" = l."Id"
     ORDER BY l."Created at" DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getLogsBetween(fromDate, toDate) {
  const { rows } = await pool.query(
    `SELECT l."Id" AS "id", l."Created at" AS "createdAt", l."Type" AS "type", l."Amount" AS "amount",
            l."Category" AS "category", l."Payment mode" AS "paymentMode", l."Note" AS "note",
            l."Timezone" AS "timezone",
            b."Cash balance" AS "cashBalance", b."Card balance" AS "cardBalance", b."Total" AS "total", b."Currency" AS "currency"
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

// ---------------------------------------------------------------------------
// Memories — small, curated, long-lived facts the AI keeps about the user,
// separate from the raw turn-by-turn Conversations history. Overwrite-by-key
// keeps this bounded and self-current (updating a fact replaces it instead
// of piling up a new row), and MAX_MEMORY_ROWS is a hard backstop so this
// table can never grow large enough to meaningfully bloat the per-message
// system instruction it gets injected into, even if the model itself is
// sloppy about pruning. Expired rows are swept on every read.
//
// Keys are normalized (trimmed + lowercased) before every read/write/delete
// so that "Travel_Status" and "travel_status" are treated as the exact same
// fact instead of silently becoming two rows that can drift out of sync —
// the whole point of overwrite-by-key depends on the AI's own casing
// choices never being able to defeat it.
// ---------------------------------------------------------------------------

const MAX_MEMORY_ROWS = 60;
const MAX_MEMORY_VALUE_LENGTH = 600;

function normalizeMemoryKey(key) {
  return String(key ?? '').trim().toLowerCase();
}

export async function getMemories() {
  await pool.query(`DELETE FROM "Memories" WHERE "Expires at" IS NOT NULL AND "Expires at" <= now()`);
  const { rows } = await pool.query(
    `SELECT "Key" AS "key", "Value" AS "value", "Category" AS "category", "Expires at" AS "expiresAt", "Updated at" AS "updatedAt"
     FROM "Memories" ORDER BY "Updated at" DESC`
  );
  return rows;
}

export async function upsertMemory({ key, value, category, expiresAt }) {
  const normalizedKey = normalizeMemoryKey(key);
  if (!normalizedKey) throw new Error('Memory key cannot be empty.');

  const truncated = value.length > MAX_MEMORY_VALUE_LENGTH;
  const boundedValue = truncated ? value.slice(0, MAX_MEMORY_VALUE_LENGTH) : value;

  const { rows } = await pool.query(
    `INSERT INTO "Memories" ("Key", "Value", "Category", "Expires at", "Updated at")
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT ("Key")
     DO UPDATE SET "Value" = EXCLUDED."Value", "Category" = EXCLUDED."Category",
                   "Expires at" = EXCLUDED."Expires at", "Updated at" = now()
     RETURNING "Key" AS "key"`,
    [normalizedKey, boundedValue, category ?? null, expiresAt ?? null]
  );

  // Backstop: trim oldest-updated rows beyond the cap, regardless of how
  // this table got there.
  await pool.query(
    `DELETE FROM "Memories" WHERE "Id" IN (
       SELECT "Id" FROM "Memories" ORDER BY "Updated at" DESC OFFSET $1
     )`,
    [MAX_MEMORY_ROWS]
  );

  return { key: rows[0].key, truncated };
}

export async function deleteMemory(key) {
  const { rows } = await pool.query(`DELETE FROM "Memories" WHERE "Key" = $1 RETURNING "Key" AS "key"`, [normalizeMemoryKey(key)]);
  return rows.length > 0;
}

// Bumps "Updated at" for the given keys only — called when the AI reports it
// actually drew on those specific facts while answering, NOT on every read.
// getMemories() sends the whole table on every single message, so touching
// "Updated at" there would stamp all rows at once and erase any distinction
// between them; this exists precisely so eviction in upsertMemory's backstop
// tracks real usage (facts the model actually leaned on) rather than mere
// presence in context (facts that were sent but ignored).
export async function touchMemories(keys) {
  const normalizedKeys = (Array.isArray(keys) ? keys : [])
    .map(normalizeMemoryKey)
    .filter(Boolean);
  if (normalizedKeys.length === 0) return { touched: [] };

  const { rows } = await pool.query(
    `UPDATE "Memories" SET "Updated at" = now() WHERE "Key" = ANY($1::text[]) RETURNING "Key" AS "key"`,
    [normalizedKeys]
  );
  return { touched: rows.map((r) => r.key) };
}

// Per-channel conversation history — one row per Discord channel (a DM or
// a server channel) the bot has ever replied in, keyed by that channel's
// own Discord ID. A channel's ID never changes; its display name can (a
// server channel gets renamed, a DM partner changes their username), so
// the name is stored purely for readability when looking at the table
// directly — it is never used to look a row up, only "ChannelId" is. A row
// is created automatically the first time the bot ever saves history for
// that channel (see saveChannelConversationHistory below) — nothing needs
// to be provisioned ahead of time for a brand new channel or a first-ever
// DM. Each row's "Content" column holds the same { messages, pending }
// shape the old single global history used:
//   - messages: the lean, completed-turn conversation history for that
//     channel only — just user/model text pairs, no dynamic context or
//     tool-call noise.
//   - pending: null normally; set to a snapshot of the exact in-flight
//     request (see ai/gemini.js) whenever a turn gets cut off by an error
//     before the model ever replied — e.g. high demand, a timed-out
//     request, every API key exhausted. Pinging again in that SAME channel
//     resumes exactly that request instead of losing it.
export async function ensureChannelConversationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "ChannelConversations" (
      "ChannelId" TEXT PRIMARY KEY,
      "ChannelName" TEXT,
      "Content" JSONB NOT NULL DEFAULT '{"messages": [], "pending": null}'::jsonb,
      "UpdatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function getChannelConversationHistory(channelId) {
  const { rows } = await pool.query(
    `SELECT "Content" AS "content" FROM "ChannelConversations" WHERE "ChannelId" = $1`,
    [channelId]
  );
  const stored = rows[0]?.content;
  if (!stored) return { messages: [], pending: null };
  if (Array.isArray(stored)) return { messages: stored, pending: null };
  return { messages: stored.messages ?? [], pending: stored.pending ?? null };
}

export async function saveChannelConversationHistory(channelId, channelName, messages, pending = null) {
  await pool.query(
    `INSERT INTO "ChannelConversations" ("ChannelId", "ChannelName", "Content", "UpdatedAt")
     VALUES ($1, $2, $3, now())
     ON CONFLICT ("ChannelId") DO UPDATE
     SET "ChannelName" = EXCLUDED."ChannelName", "Content" = EXCLUDED."Content", "UpdatedAt" = now()`,
    [channelId, channelName ?? null, JSON.stringify({ messages, pending })]
  );
}

// Used by /clear — wipes only the channel it was run in. Each channel's
// conversation is independent now, so clearing one shouldn't touch any
// other channel's history.
export async function clearChannelConversationHistory(channelId) {
  await pool.query(`DELETE FROM "ChannelConversations" WHERE "ChannelId" = $1`, [channelId]);
}

// Used by the daily reset (conversationReset.js) — every channel's history
// starts a clean slate together, once per local calendar day, same as the
// single global history used to.
export async function clearAllChannelConversationHistories() {
  await pool.query(`DELETE FROM "ChannelConversations"`);
}

// ---------------------------------------------------------------------------
// Message cursors — one row per channel the owner has ever messaged the bot
// in, remembering the newest message ID this process has ever handed to the
// message handler there. This is what lets the bot catch up on messages
// that arrived while it was offline (crashed, redeploying, etc.): Discord
// keeps every message on its own side regardless of whether this bot was
// connected, but a fresh gateway session never backfills old messageCreate
// events on its own — something has to remember where we left off and go
// fetch the gap. See missedMessages.js for the catch-up logic that reads
// this; setMessageCursor is called for every live message too (see bot.js)
// so the pointer never falls behind.
// ---------------------------------------------------------------------------

export async function ensureMessageCursorTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "MessageCursors" (
      "ChannelId" TEXT PRIMARY KEY,
      "LastMessageId" TEXT NOT NULL,
      "UpdatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function getAllMessageCursors() {
  const { rows } = await pool.query(
    `SELECT "ChannelId" AS "channelId", "LastMessageId" AS "lastMessageId" FROM "MessageCursors"`
  );
  return rows;
}

// Snowflake IDs sort correctly as plain strings for a very long time (they're
// all the same digit-length within any realistic window), but casting to
// bigint for the comparison costs nothing and removes that assumption —
// this only ever advances the cursor forward, even if an older/out-of-order
// event somehow lands after a newer one.
export async function setMessageCursor(channelId, messageId) {
  await pool.query(
    `INSERT INTO "MessageCursors" ("ChannelId", "LastMessageId", "UpdatedAt")
     VALUES ($1, $2, now())
     ON CONFLICT ("ChannelId") DO UPDATE
     SET "LastMessageId" = EXCLUDED."LastMessageId", "UpdatedAt" = now()
     WHERE "MessageCursors"."LastMessageId"::bigint < EXCLUDED."LastMessageId"::bigint`,
    [channelId, messageId]
  );
}
