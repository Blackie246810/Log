import { runReadOnlyQuery, upsertMemory, deleteMemory, touchMemories, addLogEntry, setLogNote, undoLastEntry, getLogById, editLogById, deleteLogById, getCurrentBalance } from '../db.js';
import { buildSelectQuery, ALLOWED_TABLES, allowedColumnsFor } from './queryBuilder.js';
import { searchWeb } from './tavily.js';
import { CATEGORIES, PAYMENT_MODES, PAYMENT_FLOWS, formatDateTimeDDMMYYYY } from '../constants.js';
import { getCurrency, getTimezone } from '../constantsStore.js';
import { validateLogValues } from '../logFieldsValidation.js';
import { buildLogEmbed, buildUndoEmbed, buildEditEmbed, buildDeleteEmbed } from '../embeds.js';

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
      `Keep value short: one fact, one plain short sentence, hard-capped at 600 characters (anything longer is silently truncated to fit) — this table is resent in full on every single message, so terse and factual beats descriptive every time. ` +
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
    name: 'recall_fact',
    description:
      `Signal that one or more stored facts from the "Saved facts about the user" block genuinely informed the answer you're about to give this turn — as opposed to merely sitting there unused in context, which is true of most facts on most turns. Call this silently, with no mention to the user, right after you notice a specific saved fact actually shaped what you're about to say (e.g. you referenced someone's travel status to explain a spending pattern, or a stated preference changed how you phrased a suggestion). ` +
      `This is what keeps long-term memory's row cap evicting the RIGHT things: every saved fact is resent to you in full on every message regardless of whether you use it, so mere presence in context can't tell the system which facts are actually valuable — only you calling this tool can. Facts you never recall this way will look stale and be the first evicted once the table fills up, even if they're still true; facts you do recall stay fresh and survive. ` +
      `Do not call this defensively or on every turn just because facts exist — only when a specific key genuinely shaped this specific answer. Do not call it for a fact you are simultaneously overwriting via remember_fact in the same turn; saving already refreshes it.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'The key(s) of the saved fact(s) that actually informed this answer.',
        },
      },
      required: ['keys'],
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
      `Search the live web for real-time facts, current events, or anything else you can't already know or can't get from query_data — current prices, exchange rates, news, "what is X", "when did Y happen recently", general facts, etc. Returns a short synthesized answer (when the search backend is confident enough to produce one) plus a handful of individual result snippets with title/url/content for you to read and cite from — always prefer stating information you can attribute to a specific result over leaning on the synthesized answer alone. This tool, like all your other tools, is an internal implementation detail — never name the underlying search provider to the user, even if asked directly; see the system instruction's note on this. ` +
      `This is unrelated to the finance database — never use it as a substitute for query_data, and never use query_data results to answer something that actually requires a web search. ` +
      `This tool can occasionally be unavailable — e.g. if the search backend is currently rate-limited, out of capacity, or not configured. If that happens, the tool's response will contain an "error" field explaining why instead of results — when you see that, tell the user plainly (in your own words, and without naming any provider) that web search isn't available right now and to try again later, rather than pretending you searched or making up an answer.`,
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
  {
    name: 'log_transaction',
    description:
      `Writes a brand-new transaction into the database — this is a real, permanent write, not a preview or a draft. Use this when Ameen has described something in conversation that is (or plausibly is) a transaction, and you have gathered every field below with real confidence, either because he stated it directly or because you reasoned it out from context with no genuine ambiguity left. Never call this with a guessed or placeholder value for any field — if anything is missing or unclear, ask a natural follow-up question instead of calling this tool. ` +
      `This performs the exact same validation /log's form does: category must match one of the fixed categories (case-insensitive matching is fine, e.g. "food" matches "Food/Drink"), payment_mode must be Physical or Digital, payment_flow must be Income or Expense, amount must be a positive number, and date must resolve to a real date/time. If any of that fails, this tool returns an error explaining exactly what was wrong — read it, fix the field, and try again rather than giving up or logging something else instead. ` +
      `description is required and must be specific and concrete — what the transaction was actually for, in Ameen's own terms as far as you know them (e.g. "sandwich from an unknown local shop", "X gave INR300 and Y gave INR20 as they owed money") — never a generic placeholder like "purchase" or "expense". ` +
      `You must call set_thinking_level('high') before calling this tool, exactly like query_data — writing financial data deserves the same seriousness as reading it. ` +
      `On success, a confirmation card showing exactly what was logged is attached to your reply automatically and looks identical to what /log itself shows — you do not need to build, describe, or re-list the fields yourself; just confirm briefly in your own words that it's done. On failure, nothing was written — tell Ameen plainly what went wrong.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: `The exact date and time the transaction happened, as DD-MM-YYYY HH:mm in 24-hour format, in the live timezone (currently ${getTimezone()}). Resolve relative phrasing ("today", "just now", "this morning", "yesterday at 5") yourself against the current date/time given to you in the live context block — do not ask Ameen to type this format himself unless he wants to correct something.`,
        },
        category: {
          type: 'string',
          enum: CATEGORIES,
          description: 'Pick the single best-fitting category from the fixed list. If genuinely unclear between two, ask rather than guessing.',
        },
        amount: { type: 'number', description: `Positive numeric amount, in the live currency (currently ${getCurrency()}).` },
        payment_mode: { type: 'string', enum: PAYMENT_MODES, description: 'Whether this was paid/received physically (cash) or digitally (card/UPI/bank/etc).' },
        payment_flow: { type: 'string', enum: PAYMENT_FLOWS, description: 'Whether money came in (Income) or went out (Expense).' },
        description: {
          type: 'string',
          description: 'A specific, concrete note on what this transaction was for. Required — never omit or leave generic.',
        },
      },
      required: ['date', 'category', 'amount', 'payment_mode', 'payment_flow', 'description'],
    },
  },
  {
    name: 'undo_last_transaction',
    description:
      `Deletes whatever transaction is currently the most recent row in the entire database and restores the balance to what it was before that entry existed — regardless of whether it was logged by you via log_transaction, or manually by Ameen via /log. This is the same "fast undo" the /undo slash command performs; calling this tool is exactly equivalent to Ameen running /undo himself. ` +
      `There is no confirmation step once you call this — so only call it when Ameen's intent to undo is actually clear (e.g. "nvm don't log that", "that was wrong, undo it", "undo what you just logged", "undo my last entry"). Don't call this speculatively, and don't ask "should I undo it?" as a substitute for actually calling it once he's said to. Because it always targets the single most recent row no matter who created it, double-check from context that Ameen means the *latest* entry and not some earlier one — for anything older, tell him to use /edit or /delete with that entry's id instead. ` +
      `You must call set_thinking_level('high') before calling this tool, same as log_transaction. On success, a confirmation card showing exactly what was deleted (id, amount, category, payment mode) and the restored balances is attached to your reply automatically — the same card /undo itself shows.`,
    parametersJsonSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'edit_transaction',
    description:
      `Edits exactly one already-existing entry, identified by log_id, changing only the field(s) you actually pass — anything you omit keeps its current stored value untouched. This is the AI equivalent of /edit, minus the modal/confirm-button flow: you gather the same information a human filling out /edit's form would, then write directly. ` +
      `**Identifying the right entry is the hard part — read this carefully.** If Ameen states an explicit entry id (e.g. "edit #482", "change the amount on 17"), you already have it — no need to search. Otherwise, use query_data to search the logs table for candidates matching whatever he described (date, category, amount, description/note, roughly-when — "the coffee thing from yesterday", "that 500 rupee expense"). ` +
      `- If exactly one row matches with real confidence, proceed straight to calling this tool with that id (as long as the requested change is also clear) — don't make him repeat the id back to you once you've already found it. ` +
      `- If nothing matches, or too little detail was given to search meaningfully, ask Ameen a natural follow-up question to narrow it down (a rough date, the amount, the category — whatever's missing) rather than guessing. Keep asking one or two things at a time, the same conversational style as gathering fields for log_transaction, until you can confidently narrow it to specific id(s). ` +
      `- If your search turns up more than one plausible match, do NOT just pick one. List the candidates briefly (id, date, amount, category is usually enough) and ask Ameen which one(s) he means — or, if he's already said he wants ALL of them changed (e.g. "fix the category on all my coffee entries this week"), summarize exactly which ids that covers and ask him to confirm before touching anything. Only proceed once he's confirmed. ` +
      `- This tool edits ONE entry per call. If multiple entries need the same change after Ameen confirms, call this tool once per entry, back to back — don't ask him to confirm each one individually once he's already approved the batch. ` +
      `**Fields:** date (DD-MM-YYYY HH:MM, 24-hour, in that entry's own original timezone — not necessarily the live one), category, amount, payment_mode (Physical/Digital), payment_flow (Income/Expense), description (pass an empty string to clear the existing note, omit entirely to leave the note as-is). Only include the field(s) actually changing; never re-send a field just to "confirm" it's unchanged. ` +
      `If date/amount/payment_mode/payment_flow change, the balance ledger is automatically rebuilt from that point forward — mention the new balance if it's relevant, the confirmation card already shows it. Editing only the category or description never touches the balance. ` +
      `There is no confirmation step once you call this — same fast, no-safety-net behavior as log_transaction and undo_last_transaction — so only call it once Ameen's intent and the target entry are both actually clear, per the identification rules above. ` +
      `You must call set_thinking_level('high') before calling this tool, same as log_transaction and undo_last_transaction. On success, a card showing a before→after diff of exactly what changed, plus the resulting balances, is attached to your reply automatically.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        log_id: { type: 'integer', description: 'The id of the exact entry to edit. Required — never guess this; resolve it first per the identification rules in the tool description.' },
        date: { type: 'string', description: 'New date & time, DD-MM-YYYY HH:MM (24-hour), in this entry\'s own original timezone. Omit to leave unchanged.' },
        category: { type: 'string', description: `New category, one of: ${CATEGORIES.join(', ')}. Omit to leave unchanged.` },
        amount: { type: 'number', description: 'New positive numeric amount, in this entry\'s own original currency. Omit to leave unchanged.' },
        payment_mode: { type: 'string', enum: PAYMENT_MODES, description: 'New payment mode. Omit to leave unchanged.' },
        payment_flow: { type: 'string', enum: PAYMENT_FLOWS, description: 'New income/expense flow. Omit to leave unchanged.' },
        description: { type: 'string', description: 'New note. Pass an empty string to clear the existing note. Omit entirely to leave the note as-is.' },
      },
      required: ['log_id'],
    },
  },
  {
    name: 'delete_transaction',
    description:
      `Permanently deletes a single already-existing entry, identified by log_id, and restores the balance to what it would be without that entry. Unlike undo_last_transaction, it is NOT limited to the most recent row or to entries you logged yourself — it can target any entry, however old, whoever logged it, exactly like the /delete slash command can. This is the AI equivalent of /delete, minus the modal/Yes-No-button flow. ` +
      `**Identifying the right entry works exactly like edit_transaction — read that section too.** If Ameen gives an explicit id, you already have your target. Otherwise, use query_data to search for it from whatever he described (date, amount, category, something from the note). ` +
      `- If exactly one row matches with real confidence and Ameen's intent to delete is clear, proceed straight to calling this tool. ` +
      `- If nothing matches, or too little detail was given, ask a natural follow-up to narrow it down rather than guessing. ` +
      `- If more than one plausible match turns up, do NOT pick one. List the candidates (id, date, amount, category) and ask which one(s) he means to delete — or, if he's said he wants all of them gone (e.g. "delete all my coffee entries from this week"), summarize exactly which ids that covers and ask him to confirm before deleting anything. Deletion is permanent and unlike an edit can't be diffed back — be at least as careful here as with edit_transaction, arguably more so. ` +
      `- This tool deletes ONE entry per call. Once Ameen has confirmed a specific set of ids (whether "just that one" or "all of them"), call it once per id, back to back — don't re-confirm each one individually once the batch is approved. ` +
      `There is no confirmation step once you actually call it — same fast, no-safety-net behavior as the other three tools. The confirmation that matters is the identification/approval step above, not a second "are you sure" once that's settled. ` +
      `You must call set_thinking_level('high') before calling this tool, same as the others. On success, a card showing exactly what was deleted (id, amount, category, payment mode) and the resulting balances is attached to your reply automatically.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        log_id: { type: 'integer', description: 'The id of the exact entry to delete. Required — never guess this; resolve it first per the identification rules in the tool description.' },
      },
      required: ['log_id'],
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

    case 'recall_fact': {
      const { keys } = args;
      if (!Array.isArray(keys) || keys.length === 0) throw new Error('recall_fact requires a non-empty array of keys.');
      const { touched } = await touchMemories(keys);
      return { touched };
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

    case 'log_transaction': {
      const { date, category, amount, payment_mode: paymentMode, payment_flow: paymentFlow, description } = args;

      const note = String(description ?? '').trim();
      if (!note) {
        return { error: 'description is required — a specific, concrete note on what this transaction was for. Ask the user for it, or state your own confident inference, before calling this tool again.' };
      }

      const timezone = getTimezone();
      const currency = getCurrency();

      const validated = validateLogValues({ date, category, amount, paymentMode, paymentFlow }, timezone);
      if (!validated.ok) {
        // Same error shape /log's modal shows a human — precise about which
        // field(s) failed and why, so the model can fix just those and retry
        // rather than re-asking the user for everything from scratch.
        return { error: validated.errorText };
      }
      const { type, amount: amountNum, category: canonCategory, paymentMode: canonPaymentMode, createdAt } = validated.value;

      let result;
      try {
        result = await addLogEntry({ type, amount: amountNum, category: canonCategory, paymentMode: canonPaymentMode, createdAt, currency, timezone });
      } catch (err) {
        return { error: `Database error while logging — nothing was written. ${err.message}` };
      }

      try {
        await setLogNote(result.logId, note);
      } catch (err) {
        // The transaction itself is already committed at this point — a
        // failed note write shouldn't be reported as "nothing happened",
        // just flagged so the model can mention the note specifically
        // didn't stick rather than claiming a clean full success.
        return {
          logged: true,
          id: result.logId,
          note_saved: false,
          warning: `Entry #${result.logId} was logged, but the description failed to save (${err.message}). Everything else is correct.`,
          __card: buildLogEmbed({ id: result.logId, createdAt: result.createdAt, type, amount: amountNum, category: canonCategory, paymentMode: canonPaymentMode, currency }, result),
        };
      }

      return {
        __card: buildLogEmbed(
          { id: result.logId, createdAt: result.createdAt, type, amount: amountNum, category: canonCategory, paymentMode: canonPaymentMode, currency, note },
          result
        ),
        logged: true,
        id: result.logId,
        date: formatDateTimeDDMMYYYY(result.createdAt, timezone),
        category: canonCategory,
        amount: amountNum,
        payment_mode: canonPaymentMode,
        payment_flow: type,
        description: note,
        currency,
        cash_balance: result.cashBalance,
        card_balance: result.cardBalance,
        total_balance: result.total,
      };
    }

    case 'undo_last_transaction': {
      let result;
      try {
        result = await undoLastEntry();
      } catch (err) {
        return { error: `Database error while undoing — ${err.message}` };
      }
      if (!result) {
        return { error: 'Nothing to undo — no entries exist.' };
      }

      const { deleted, restored } = result;
      return {
        __card: buildUndoEmbed(deleted, restored, getCurrency()),
        undone: true,
        id: deleted.id,
        date: formatDateTimeDDMMYYYY(deleted.createdAt, deleted.timezone ?? getTimezone()),
        category: deleted.category,
        amount: deleted.amount,
        payment_mode: deleted.paymentMode,
        payment_flow: deleted.type,
        description: deleted.note,
        currency: deleted.currency ?? getCurrency(),
        cash_balance: restored.cashBalance,
        card_balance: restored.cardBalance,
        total_balance: restored.total,
      };
    }

    case 'edit_transaction': {
      const { log_id: logId, date, category, amount, payment_mode: paymentMode, payment_flow: paymentFlow, description } = args;

      if (logId == null) {
        return { error: 'log_id is required — resolve the exact entry to edit first (via an id Ameen gave you, or by searching with query_data) before calling this tool.' };
      }

      let original;
      try {
        original = await getLogById(logId);
      } catch (err) {
        return { error: `Database error while looking up entry #${logId} — ${err.message}` };
      }
      if (!original) {
        return { error: `No entry found with id #${logId} — nothing was changed.` };
      }

      // Editing re-validates all 5 core fields together, same as /edit's own
      // modal does — so any field the caller didn't pass falls back to this
      // entry's own current value (in the same raw string/number shape
      // validateLogValues expects) rather than being left as a partial,
      // half-validated write.
      const timezone = original.timezone;
      const merged = {
        date: date !== undefined ? date : formatDateTimeDDMMYYYY(new Date(original.createdAt), timezone),
        category: category !== undefined ? category : original.category,
        amount: amount !== undefined ? amount : Number(original.amount),
        paymentMode: paymentMode !== undefined ? paymentMode : original.paymentMode,
        paymentFlow: paymentFlow !== undefined ? paymentFlow : original.type,
      };

      const validated = validateLogValues(merged, timezone);
      if (!validated.ok) {
        return { error: validated.errorText };
      }
      const { type, amount: amountNum, category: canonCategory, paymentMode: canonPaymentMode, createdAt } = validated.value;

      const noteProvided = description !== undefined;
      const noteArg = noteProvided ? (String(description).trim() || null) : undefined;

      let result;
      try {
        result = await editLogById(logId, { type, amount: amountNum, category: canonCategory, paymentMode: canonPaymentMode, createdAt, note: noteArg });
      } catch (err) {
        return { error: `Database error while editing entry #${logId} — nothing was changed. ${err.message}` };
      }
      if (!result) {
        return { error: `Entry #${logId} no longer exists — nothing was updated.` };
      }

      const currency = original.currency ?? getCurrency();
      const balance = result.ledgerRebuilt ? result.restored : await getCurrentBalance();

      const before = {
        date: formatDateTimeDDMMYYYY(new Date(original.createdAt), timezone),
        category: original.category,
        amount: Number(original.amount),
        paymentMode: original.paymentMode,
        type: original.type,
        note: original.note,
      };
      const after = {
        id: logId,
        date: formatDateTimeDDMMYYYY(createdAt, timezone),
        category: canonCategory,
        amount: amountNum,
        paymentMode: canonPaymentMode,
        type,
        note: noteProvided ? noteArg : original.note,
      };

      return {
        __card: buildEditEmbed(before, after, currency, balance),
        edited: true,
        id: logId,
        before,
        after,
        currency,
        cash_balance: balance.cashBalance,
        card_balance: balance.cardBalance,
        total_balance: balance.total,
      };
    }

    case 'delete_transaction': {
      const { log_id: logId } = args;

      if (logId == null) {
        return { error: 'log_id is required — resolve the exact entry to delete first (via an id Ameen gave you, or by searching with query_data) before calling this tool.' };
      }

      let result;
      try {
        result = await deleteLogById(logId);
      } catch (err) {
        return { error: `Database error while deleting entry #${logId} — ${err.message}` };
      }
      if (!result) {
        return { error: `No entry found with id #${logId} — nothing was deleted.` };
      }

      const { deleted, restored } = result;
      return {
        __card: buildDeleteEmbed(deleted, restored, getCurrency()),
        deleted: true,
        id: deleted.id,
        date: formatDateTimeDDMMYYYY(deleted.createdAt, deleted.timezone ?? getTimezone()),
        category: deleted.category,
        amount: deleted.amount,
        payment_mode: deleted.paymentMode,
        payment_flow: deleted.type,
        description: deleted.note,
        currency: deleted.currency ?? getCurrency(),
        cash_balance: restored.cashBalance,
        card_balance: restored.cardBalance,
        total_balance: restored.total,
      };
    }

    default:
      throw new Error(`Unknown tool requested: ${name}`);
  }
}