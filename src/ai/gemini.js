import { GoogleGenAI } from '@google/genai';
import { toolDeclarations, callTool } from './tools.js';
import { CATEGORIES } from '../constants.js';
import { getConversationHistory, saveConversationHistory, clearConversationHistory } from '../db.js';

const MODEL = 'gemini-3.6-flash';
const MAX_HISTORY_TURNS = 500;
const MAX_TOOL_HOPS = 5;

function buildSystemInstruction(botName) {
  const identity = botName ? `You are ${botName}, ` : 'You are ';
  return `${identity}Ameen's personal finance assistant, living in his private Discord DMs — the only AI with access to his expense/income database. Introduce yourself by name when it comes up naturally (a first hello, or if asked who you are) — no need to state it every reply. Two roles in one conversation: casual chat needs no tool call; anything touching money, spending, or balance requires calling query_data — never estimate or reuse an earlier number, always re-query fresh. Data: table logs (every transaction) and balances (running balance after each transaction, own timestamps). Amounts in ₹, always stored positive — type (income/expense) sets the sign, sum accordingly. Valid categories: ${CATEGORIES.join(', ')}. Before answering from results: confirm you selected what was actually asked (right table/filter/aggregate), recompute totals yourself rather than trusting them blindly, and re-query instead of rationalizing an answer that looks off (empty, huge, negative where impossible). State assumptions (e.g. "this month" = calendar month). For financial answers, format as a tight mini-report: headline number(s) first, a line or two of relevant context after — compact, not a wall of text. For casual chat, just talk normally. Formatting: plain Discord DM text only. Bold, italic, strikethrough, inline code, code blocks, blockquotes, and bullet/numbered lists all render fine — use them. Headers work too, but keep them rare — this is a DM, not a doc, so reserve them for when they genuinely help. Never use Markdown tables or HTML — Discord renders neither; both show up as literal pipe characters or raw tags. For tabular data (e.g. a category breakdown), don't build a text table at all — output a fenced block tagged exactly table containing JSON in this shape: {"title": "optional string", "rows": [{"label": "Food/Drink", "value": "₹1,240"}, ...]}. That block gets rendered as a real Discord embed, not shown as raw text, so write only valid JSON inside it — no extra commentary in that block — and put any surrounding sentence(s) as normal text outside it. Each table block holds at most 25 rows. If you have more than 25 rows to show, split them into multiple separate table blocks (each ≤25 rows) in the same reply, one right after another — each renders as its own embed, in order. Hard ceiling: at most 10 table blocks per reply (250 rows total) — anything beyond that gets silently dropped, not shown. If a query would need more than that, narrow it yourself (tighter date range, top-N by amount, etc.) or tell the user there's more data than can be shown and ask how they'd like it narrowed, rather than truncating without saying so.`;
}

let defaultClient = null;
function getDefaultClient() {
  if (!defaultClient) {
    defaultClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return defaultClient;
}

function currentDateContext() {
  const formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${formatter.format(new Date())} IST`;
}

export async function askAi(userMessage, botName, client = getDefaultClient()) {
  const history = await getConversationHistory();
  const contents = [...history, { role: 'user', parts: [{ text: userMessage }] }];
  const systemInstruction = `${buildSystemInstruction(botName)} Current date/time: ${currentDateContext()}. Use this as "now" for any relative date question (today, this week, this month, yesterday, last month) — never assume or guess the date.`;

  let hops = 0;
  while (hops < MAX_TOOL_HOPS) {
    hops++;

    const response = await client.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: toolDeclarations }],
        thinkingConfig: { thinkingLevel: 'medium' },
      },
    });

    const calls = response.functionCalls;
    if (!calls || calls.length === 0) {
      const text = response.text ?? "I'm not sure how to answer that.";
      const leanHistory = [...history, { role: 'user', parts: [{ text: userMessage }] }, { role: 'model', parts: [{ text }] }];
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