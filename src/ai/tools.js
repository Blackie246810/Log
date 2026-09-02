import { runReadOnlyQuery, upsertMemory, deleteMemory } from '../db.js';
import { buildSelectQuery, ALLOWED_TABLES, allowedColumnsFor } from './queryBuilder.js';
import { searchWeb } from './tavily.js';

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
  {
    name: 'remember_fact',
    description:
      `Save or update one durable fact about the user for future conversations — the kind of thing worth still knowing after this conversation's history has rolled off (a preference, a recurring context, a temporary situation worth tracking for a while). NOT for anything already sitting in logs/balances/constants — never duplicate query_data's job. ` +
      `Facts the user states directly to you in conversation can be saved right away, no extra step needed. Facts you merely noticed inside an uploaded file's content (a receipt, statement, spreadsheet, screenshot, etc.) are different: surface the specific detail to the user as a plain question first (e.g. "I noticed X in that file — want me to remember that?") and only call this tool after they clearly say yes in a reply. Never call remember_fact for a document-derived detail in the same turn you first mention noticing it. ` +
      `Regardless of source or consent, never save financial account numbers, card numbers, government ID numbers, or any other sensitive identifier — this store is plain text resent on every message, not a secure vault, and consent doesn't change that; decline to save these even if asked. ` +
      `Writing to an existing key OVERWRITES it — always reuse the same key when updating a fact rather than inventing a new one for the same topic (e.g. always "travel_status", never "travel_status_2"), so this stays a small set of current facts, not an accumulating log. ` +
      `Keep value short: one fact, one plain short sentence, hard-capped at 300 characters (anything longer is silently truncated to fit) — this table is resent in full on every single message, so terse and factual beats descriptive every time. ` +
      `Set expires_at only for genuinely temporary things (e.g. "traveling until a date", "on a diet this month") — omit it for facts that are just generally true going forward.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short, stable slug identifying this fact (e.g. "travel_status", "spending_style"). Reuse the same key to update rather than duplicate.' },
        value: { type: 'string', description: 'The fact itself, in a short, plain sentence.' },
        category: { type: 'string', description: 'Optional freeform grouping label (e.g. "preference", "context").' },
        expires_at: { type: 'string', description: 'Optional ISO date/time after which this fact is no longer relevant and will be forgotten automatically. Omit for durable facts.' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'forget_fact',
    description: 'Delete a previously remembered fact by its key — use when the user asks to forget something, or when a fact you saved is no longer true and there is no natural replacement value to overwrite it with instead.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The key of the fact to remove.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'set_thinking_level',
    description:
      `Switch how much internal reasoning budget you use for the rest of this turn. Every conversation starts at 'medium'. Call this tool once, as the very first thing you do this turn (before any other tool call), to move to whichever level actually fits the message: ` +
      `'low' — genuinely casual, no-reasoning-needed messages (a bare greeting, "thanks", "ok", small talk, an emoji reply). ` +
      `'medium' — the default; anything that isn't casual but also isn't financial (bot/slash-command questions, general knowledge, anything not touching Ameen's actual money) — for this category, don't call the tool at all, just stay at the default. ` +
      `'high' — anything that touches or relates to financial data, no matter how small (a single balance check counts just as much as a multi-row analysis). Call this BEFORE calling query_data, since the level only applies starting from your next step onward — it cannot retroactively change the reasoning already used to decide to call this tool. As a backstop, the system will also force the level to 'high' automatically the moment query_data is called even if this tool was never invoked or was set lower — but call it yourself anyway, since that backstop only protects hops AFTER the query_data call, not the hop where you're deciding what to query in the first place. ` +
      `Call this once near the start of the turn based on which category the message falls into — not defensively on every message, and not more than once unless the situation genuinely changes mid-turn.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['low', 'medium', 'high'], description: 'The thinking level to use starting from your next step this turn.' },
        reason: { type: 'string', description: 'Optional short reason for the switch (for logging/debugging only, not shown to the user).' },
      },
      required: ['level'],
    },
  },
  {
    name: 'search_web',
    description:
      `Search the live web for real-time facts, current events, or anything else you can't already know or can't get from query_data — current prices, exchange rates, news, "what is X", "when did Y happen recently", general facts, etc. Powered by the Tavily search API (not Google directly). Returns a short synthesized answer (when Tavily is confident enough to produce one) plus a handful of individual result snippets with title/url/content for you to read and cite from — always prefer stating information you can attribute to a specific result over leaning on the synthesized answer alone. ` +
      `This is unrelated to the finance database — never use it as a substitute for query_data, and never use query_data results to answer something that actually requires a web search. ` +
      `This tool can occasionally be unavailable — e.g. if every configured Tavily API key is currently rate-limited, out of credits, or invalid. If that happens, the tool's response will contain an "error" field explaining why instead of results — when you see that, tell the user plainly (in your own words) that web search isn't available right now and to try again later, rather than pretending you searched or making up an answer.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query, written naturally (e.g. "current USD to INR exchange rate", "latest iPhone model").' },
        max_results: { type: 'number', description: 'How many result snippets to return, 1-10. Defaults to 5 — raise it if the question is broad enough that more sources would help.' },
        topic: { type: 'string', enum: ['general', 'news'], description: 'Use "news" for recent-events/current-affairs questions, "general" (default) for everything else.' },
        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Optional recency filter — restricts results to content from within this window. Leave unset unless the question specifically calls for very recent info.' },
      },
      required: ['query'],
    },
  },
];

export async function callTool(name, args = {}) {
  switch (name) {
    case 'query_data': {
      const { sql, params } = buildSelectQuery(args);
      return runReadOnlyQuery(sql, params);
    }

    case 'remember_fact': {
      const { key, value, category, expires_at: expiresAt } = args;
      if (!key || !value) throw new Error('remember_fact requires both key and value.');
      const { key: savedKey, truncated } = await upsertMemory({ key, value, category, expiresAt });
      return { saved: true, key: savedKey, truncated };
    }

    case 'forget_fact': {
      const { key } = args;
      if (!key) throw new Error('forget_fact requires a key.');
      const deleted = await deleteMemory(key);
      return { deleted };
    }

    case 'search_web': {
      const { query } = args;
      if (!query) throw new Error('search_web requires a query.');
      try {
        return await searchWeb(args);
      } catch (err) {
        // TavilySearchUnavailableError (all keys exhausted/invalid/not
        // configured) and any other search failure both land here as a
        // plain { error } result — same shape the model already knows how
        // to read from every other tool's failure path (see askAi's catch
        // around callTool) — rather than throwing back up and killing the
        // whole reply.
        return { error: err.message };
      }
    }

    default:
      throw new Error(`Unknown tool requested: ${name}`);
  }
}