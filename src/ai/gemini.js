import { GoogleGenAI } from '@google/genai';
import { toolDeclarations, callTool } from './tools.js';
import { CATEGORIES } from '../constants.js';
import { getConversationHistory, saveConversationHistory, clearConversationHistory } from '../db.js';

const MODEL = 'gemini-2.5-flash';
const MAX_HISTORY_TURNS = 500;
const MAX_TOOL_HOPS = 5;

const SYSTEM_INSTRUCTION = `You are a helpful assistant embedded in a personal Discord finance-tracking bot. You answer questions about the user's own income/expense data by calling the provided tools — never guess or make up numbers, always call a tool to check. Amounts are in Indian Rupees (₹). Valid categories are: ${CATEGORIES.join(', ')}. Keep answers conversational and concise, suited for a Discord DM reply. If a question is unrelated to their finances, answer briefly and naturally without forcing a tool call.`;

let defaultClient = null;
function getDefaultClient() {
  if (!defaultClient) {
    defaultClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return defaultClient;
}

export async function askAi(userMessage, client = getDefaultClient()) {
  const history = await getConversationHistory();
  const contents = [...history, { role: 'user', parts: [{ text: userMessage }] }];

  let hops = 0;
  while (hops < MAX_TOOL_HOPS) {
    hops++;

    const response = await client.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [{ functionDeclarations: toolDeclarations }],
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
      responseParts.push({ functionResponse: { name: call.name, response: { result } } });
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