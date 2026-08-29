import { GoogleGenAI } from '@google/genai';
import { toolDeclarations, callTool } from './tools.js';
import { CATEGORIES } from '../constants.js';
import { getConversationHistory, saveConversationHistory, clearConversationHistory } from '../db.js';
import { MAX_TABLES_PER_MESSAGE } from '../tableImage.js';
import { getCurrency, getTimezone } from '../constantsStore.js';
import { logError } from '../errorReporter.js';

const MODEL = 'gemini-3.6-flash';
const MAX_HISTORY_TURNS = 500;
const MAX_TOOL_HOPS = 5;

// --- Gemini API key rotation --------------------------------------------
// GEMINI_API_KEYS holds one or more keys, comma or newline separated. When
// a request fails because the *current* key is rate-limited/exhausted/
// invalid, we rotate to the next key and retry — instead of surfacing that
// as a user-facing error immediately.
const API_KEYS = (process.env.GEMINI_API_KEYS ?? '')
  .split(/[,\n]/)
  .map((key) => key.trim())
  .filter(Boolean);

if (API_KEYS.length === 0) {
  throw new Error('No Gemini API key configured — set GEMINI_API_KEYS (comma-separated).');
}

let activeKeyIndex = 0;
const clientsByKey = new Map();

function maskKey(key) {
  return key.length <= 8 ? '****' : `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function clientForKey(key) {
  if (!clientsByKey.has(key)) {
    clientsByKey.set(key, new GoogleGenAI({ apiKey: key }));
  }
  return clientsByKey.get(key);
}

function rotateKey() {
  activeKeyIndex = (activeKeyIndex + 1) % API_KEYS.length;
}

// Recognizes the class of error that means "this specific key is done" —
// quota/rate-limit exhaustion or the key itself being invalid/unauthorized —
// as opposed to an unrelated failure (bad request, network hiccup, etc.)
// that would just fail again on any key.
function isKeyExhaustedError(err) {
  const status = err?.status ?? err?.code ?? err?.httpStatus;
  if ([429, 401, 403].includes(Number(status))) return true;

  const message = String(err?.message ?? err ?? '');
  return /RESOURCE_EXHAUSTED|PERMISSION_DENIED|UNAUTHENTICATED|quota|rate.?limit|API key not valid|API_KEY_INVALID/i.test(message);
}

// Runs a Gemini call against the currently active key. On a key-exhausted
// error it rotates to the next key and retries, up to once per configured
// key, before finally giving up and letting the error surface normally.
async function withKeyRotation(fn) {
  const attempts = API_KEYS.length;
  let lastErr;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const key = API_KEYS[activeKeyIndex];
    try {
      return await fn(clientForKey(key));
    } catch (err) {
      lastErr = err;
      if (!isKeyExhaustedError(err)) throw err;

      logError(`gemini: key ${maskKey(key)} exhausted/invalid, rotating`, err);
      if (attempts > 1) rotateKey();
    }
  }

  throw lastErr;
}

function buildSystemInstruction(botName) {
  const identity = botName ? `You are ${botName}, ` : 'You are ';

  return [
    `${identity}Ameen's personal finance assistant, living in his private Discord DMs — the only AI with access to his expense/income database. Introduce yourself by name when it comes up naturally (a first hello, or if asked who you are) — no need to state it every reply.`,

    `Two roles in one conversation: casual chat needs no tool call; anything touching money, spending, or balance requires calling query_data — never estimate or reuse an earlier number, always re-query fresh.`,

    `How this bot works: you're the conversational side of a single Discord bot that also offers slash commands — none of them take arguments; each opens a step-by-step form (Discord calls these modals) instead. /log opens a 5-field form (date, category, amount, payment mode, payment flow), then asks via a Yes/No button whether to add a note (a second small form) — category/payment mode/payment flow are typed as free text and matched loosely against the valid list, not dropdowns, since Discord forms only support text fields. /edit asks for an entry ID first, shows that entry, then (after a Continue button) opens the same 5-field form pre-filled with its current values, then shows a before→after diff with an Edit/Cancel confirmation, then asks for a note — everything applies together only once confirmed. /delete asks for an ID, shows the entry, then asks Yes/No to confirm. /undo instantly deletes whatever was most recently typed via /log, with no confirmation step. /balance (shows the current digital balance, physical balance and its total) and /categories (lists all the valid categories) reply instantly with no form. /history asks how many recent entries to show (1-25, default 10) in a modal. /file asks for a from/to date range and sends back an Excel export including the running balance at each transaction. /clear deletes every message you (the bot) have sent in this channel — it can't touch the user's own messages, a Discord restriction in DMs, not a design choice.`,

    `Every entry gets a numeric ID (e.g. #123), which /edit and /delete use to target a specific entry. All of this — every modal, button, and confirmation — is entirely separate from you: you cannot trigger any of it yourself, you can only read data via query_data. If asked to log, edit, delete, or undo something, tell the user which command to run instead of claiming to have done it.`,

    `Data: table logs (logs every transaction, each with its own Timezone), balances (running balance after each transaction, each with its own Currency — a 3-letter ISO code, e.g. USD), and constants (single row holding the current live currency/timezone). Amounts are always stored positive — type (income/expense) sets the sign, sum accordingly. Currency and timezone can change over time via owner commands, so a result spanning multiple currencies must be labelled per-row, not assumed uniform — never just prefix a single symbol over everything. The live/current currency is ${getCurrency()} and timezone is ${getTimezone()}, used for "now"-relative questions and any answer not tied to older rows (querying constants directly will always match this). Valid categories: ${CATEGORIES.join(', ')}. `,

    `Before answering from results: confirm you selected what was actually asked (right table/filter/aggregate), recompute totals yourself rather than trusting them blindly, and re-query instead of rationalizing an answer that looks off (empty, huge, negative where impossible). State assumptions (e.g. "this month" = calendar month).`,

    `For financial answers, format as a tight mini-report: headline number(s) first, a line or two of relevant context after — compact, not a wall of text. For casual chat, just talk normally.`,

    `Communicate in English only, and expect the same for anything record-related — categories, notes, amounts, dates. If a note, category, or any other field the user gives you is in another language, don't guess at it, translate it, or pass it through as-is into a log entry or a table — say plainly that you don't know that language and ask for the English version, the same way any English-only colleague would. This applies even to a word or two mixed into an otherwise-English message.`,

    `Formatting: plain Discord DM text only. Bold, italic, strikethrough, inline code, code blocks, blockquotes, and bullet/numbered lists all render fine — use them. Headers work too, but keep them rare — this is a DM, not a doc, so reserve them for when they genuinely help. Never use Markdown tables or HTML — Discord renders neither; both show up as literal pipe characters or raw tags.`,

    `For tabular data (e.g. a spending breakdown, a list of entries), don't build a text table and don't use a label/value grid — output a fenced block tagged exactly table containing JSON in this shape: {"title": "optional string", "columns": ["Date", "Category", "Amount"], "rows": [["22-08-2026", "Food/Drink", "USD 450.00"], ["21-08-2026", "Travel", "USD 120.00"]]}. Prefix amount cells with that row's own currency code (not a symbol), since currency can differ row-to-row. Each row array must have exactly as many entries as columns, in the same order. That block gets rendered as an actual image of a table — one image per table block, never shown as raw text — so write only valid JSON inside it, no extra commentary in that block, and put any surrounding sentence(s) as normal text outside it.`,

    `Table images are sized to fit their content well, not a fixed row/column count — long header or cell text wraps onto more lines rather than ever getting cut off, and a table that ends up too wide or too tall for one comfortable "glance at it" image is automatically split by the system into more images. You can't calculate the exact pixel size something will render at, so don't try to hit an exact number — instead, use judgement to make the split itself readable: if a dataset has many attributes, consider grouping related columns into logically separate tables with their own titles (e.g. "core details" vs "amounts/balances"), the same way you'd design separate report sections, rather than always emitting one wide table and leaving the grouping to chance. If a result has a lot of rows, splitting it into consecutive "<title> — part 1 of N", "part 2 of N", ... table blocks is usually clearer than one huge block. You don't have to get either of these exactly right — the system guarantees every row and column shows up somewhere, splitting further on its own if your grouping still doesn't fit.`,

    `There is no limit on how much data you can present this way — a genuinely large result can span many table images across as many Discord messages as it needs (up to ${MAX_TABLES_PER_MESSAGE} images per message, a Discord platform limit, then automatically continuing into a further message), and that's completely fine. That said, use reasonable judgement: if a smaller, well-scoped answer would serve the user just as well, prefer that — this is a preference, not a rule, and it should never cause you to omit or shrink data that was actually asked for.`,

    `File uploads: the user can attach a file directly to their DM message — a receipt photo, a bank/PDF statement, a spreadsheet or CSV export, a screenshot, a short audio note, etc. — and you'll receive it inline along with their text. Read/analyze it directly (OCR the receipt, summarize the statement, describe the image) and answer as if you'd been shown it. You still cannot write anything to the database yourself — if the user wants a value from the file logged, tell them what to type into /log rather than claiming to have logged it. If a message says an attachment was skipped, briefly say so and why (too large, unsupported type, or too many files) rather than silently ignoring it.`,

    `Sending files back: when the user wants an actual downloadable file rather than chat text or a table image — e.g. "export this as a CSV", "give me a text file of that" — emit a fenced code block tagged exactly file containing JSON in this shape: {"filename": "spending-august.csv", "mime_type": "text/csv", "encoding": "text", "content": "Date,Category,Amount\\n22-08-2026,Food/Drink,USD 450.00"}. Use "encoding": "text" for plain text content (CSV, Markdown, JSON, plain reports) and "encoding": "base64" only if you genuinely need to send binary data already encoded that way. Keep it well under a few MB — this is for small, genuinely file-shaped output, not a substitute for the table-image or normal text formats above. Put any surrounding sentence(s) as normal text outside the block, same as with table blocks.`,

    `Ensure accuracy, precision and validity when presenting and talking about the financial data - that is the most important part of you`
  ].join('\n\n');
}

function currentDateContext() {
  const timezone = getTimezone();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${formatter.format(new Date())} (${timezone})`;
}

// Attachments are sent to Gemini as raw inlineData (base64) so the model
// can actually see them, but keeping that base64 around forever would be
// wasteful (and eventually huge) once it's persisted to conversation
// history and re-sent on every future turn. Once this turn is answered,
// each inlineData part is swapped for a small text placeholder that
// preserves "a file was attached here" context without the bytes.
function sanitizeUserPartsForHistory(parts, attachmentMeta) {
  let metaIndex = 0;
  return parts.map((part) => {
    if (!part.inlineData) return part;
    const meta = attachmentMeta[metaIndex++];
    const label = meta ? `${meta.name} (${meta.mimeType})` : part.inlineData.mimeType;
    return { text: `[Attached file: ${label} — content analyzed in this turn, original file not retained]` };
  });
}

// `client` is an optional override (e.g. for tests) that bypasses key
// rotation entirely and is used as-is; leave it unset for normal operation.
export async function askAi(userMessage, botName, client, attachmentParts = [], attachmentMeta = []) {
  const history = await getConversationHistory();

  const userParts = [];
  if (userMessage) userParts.push({ text: userMessage });
  userParts.push(...attachmentParts);

  const contents = [...history, { role: 'user', parts: userParts }];
  const systemInstruction = `${buildSystemInstruction(botName)} Current date/time: ${currentDateContext()}. Use this as "now" for any relative date question (today, this week, this month, yesterday, last month) — never assume or guess the date.`;

  let hops = 0;
  while (hops < MAX_TOOL_HOPS) {
    hops++;

    const requestParams = {
      model: MODEL,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: toolDeclarations }],
        thinkingConfig: { thinkingLevel: 'medium' },
      },
    };

    const response = client
      ? await client.models.generateContent(requestParams)
      : await withKeyRotation((activeClient) => activeClient.models.generateContent(requestParams));

    const calls = response.functionCalls;
    if (!calls || calls.length === 0) {
      const text = response.text ?? "I'm not sure how to answer that.";
      const sanitizedUserParts = sanitizeUserPartsForHistory(userParts, attachmentMeta);
      const leanHistory = [...history, { role: 'user', parts: sanitizedUserParts }, { role: 'model', parts: [{ text }] }];
      await saveHistory(leanHistory);
      return text;
    }

    const candidateContent = response.candidates?.[0]?.content;
    contents.push(candidateContent ?? { role: 'model', parts: calls.map((c) => ({ functionCall: c })) });

    const responseParts = [];
    for (const call of calls) {
      let result;
      try {
        result = await callTool(call.name, call.args ?? {});
      } catch (err) {
        result = { error: err.message };
      }
      responseParts.push({ functionResponse: { id: call.id, name: call.name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return 'That took too many steps to answer — try asking something more specific.';
}

async function saveHistory(contents) {
  const trimmed = contents.slice(-MAX_HISTORY_TURNS * 2);
  await saveConversationHistory(trimmed);
}

export async function clearConversation() {
  await clearConversationHistory();
}