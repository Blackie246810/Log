// --- Tavily web search, with API key rotation --------------------------
// Gives the AI real-time web search via https://api.tavily.com/search.
// Key loading intentionally mirrors gemini.js's GEMINI_API_KEY_<n> /
// GEMINI_API_KEYS pattern for consistency:
//
//   1. TAVILY_API_KEY_<n> (TAVILY_API_KEY_1, TAVILY_API_KEY_2, ...) — one
//      key per env var. RECOMMENDED: add a new numbered var and redeploy.
//   2. TAVILY_API_KEYS — comma/newline separated list (legacy/bulk path).
//
// Rotation is intentionally much simpler than Gemini's: no RPM/TPM/RPD
// bookkeeping, no proactive cooldown windows — just "did this key just
// fail in a way that means it's done for now?" If so, move to the next
// key silently and retry the same search. Nothing is said about this to
// the user; only total exhaustion (every key rejected) surfaces at all,
// and even then it surfaces as a tool result handed back to the model —
// not a thrown error that blows up the whole reply — so the model can
// explain it in its own words instead of the bot showing a raw error.

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

function readNumberedKeyVars() {
  const pattern = /^TAVILY_API_KEY_(\d+)$/;
  return Object.keys(process.env)
    .map((name) => {
      const match = name.match(pattern);
      return match ? { label: name, order: Number(match[1]), raw: process.env[name] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

function readListKeyVar() {
  return (process.env.TAVILY_API_KEYS ?? '')
    .split(/[,\n]/)
    .map((raw, i) => ({ label: `TAVILY_API_KEYS[${i}]`, raw }));
}

// Strips characters that commonly survive a copy-paste (surrounding
// straight/smart quotes, stray whitespace) — same reasoning as gemini.js.
function cleanKey(raw) {
  return (raw ?? '').trim().replace(/^['"“”]+|['"“”]+$/g, '');
}

const keyLabels = new Map(); // key value -> which env var it came from, for logs
const API_KEYS = [];
{
  const seen = new Set();
  for (const entry of [...readNumberedKeyVars(), ...readListKeyVar()]) {
    const key = cleanKey(entry.raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    API_KEYS.push(key);
    keyLabels.set(key, entry.label);
  }
}

// Unlike gemini.js, a missing key here is not fatal at startup — web
// search is an optional capability, not the core of the bot. If nothing
// is configured, search_web will always report itself unavailable (see
// isConfigured() below) rather than the whole process refusing to boot.
export function isConfigured() {
  return API_KEYS.length > 0;
}

let activeKeyIndex = 0;
function rotateKey() {
  activeKeyIndex = (activeKeyIndex + 1) % API_KEYS.length;
}

function maskKey(key) {
  return key.length <= 8 ? '****' : `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function describeKey(key) {
  return `${keyLabels.get(key) ?? '?'} (${maskKey(key)})`;
}

// Thrown once every configured key has been tried and rejected for this
// call. Kept as its own class (like gemini.js's AllKeysExhaustedError) so
// it's identifiable, but it's caught inside callTool (see tools.js) and
// turned into a normal { error: ... } tool result rather than bubbling up
// as an uncaught failure — that's what lets the model read the reason and
// explain it to the user in its own words instead of the bot showing a
// raw error message.
export class TavilySearchUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TavilySearchUnavailableError';
  }
}

// Status codes (and the message patterns behind a couple of them) that
// mean "this specific key is done for now" — invalid/revoked, rate
// limited, or out of credits — as opposed to a one-off network hiccup or
// a bad request that would fail identically on every key.
//   401 — invalid/missing key
//   429 — rate limited (too many requests in a short window)
//   432 — plan's monthly credit limit exceeded
//   433 — pay-as-you-go limit exceeded
function isKeyExhaustedStatus(status) {
  return [401, 429, 432, 433].includes(status);
}

// One real HTTP call against a specific key. Returns the parsed JSON on
// success; throws on any non-2xx response (caller decides whether that
// means "try the next key" or "stop, this is a real error").
async function callTavily(key, body) {
  const res = await fetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Tavily request failed (${res.status}): ${text || res.statusText}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// Runs a search, rotating through configured keys on exhaustion. Tries
// each key at most once per call, starting from whichever key is
// currently active (so a key that's known-good keeps getting used first
// on the next call too, instead of always restarting from key #1).
async function searchWithRotation(body) {
  if (!isConfigured()) {
    throw new TavilySearchUnavailableError(
      'Web search is not set up right now — no Tavily API key is configured. Tell the user search isn\'t available at the moment.'
    );
  }

  let lastErr;
  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const key = API_KEYS[activeKeyIndex];
    try {
      return await callTavily(key, body);
    } catch (err) {
      lastErr = err;
      if (isKeyExhaustedStatus(err.status)) {
        console.warn(`[tavily] ${describeKey(key)} exhausted (HTTP ${err.status}) — rotating to next key.`);
        rotateKey();
        continue;
      }
      // Not an exhaustion error (bad request, network issue, Tavily 5xx,
      // etc.) — rotating keys wouldn't help, so stop here and let it
      // surface as a genuine error rather than silently trying every key.
      throw err;
    }
  }

  // Every configured key was tried and every one came back exhausted.
  throw new TavilySearchUnavailableError(
    `Web search is temporarily unavailable — every configured Tavily API key is currently rate-limited, out of credits, or invalid (last error: ${lastErr?.message ?? 'unknown'}). Tell the user you can't search the web right now and to try again later.`
  );
}

// Public entry point used by tools.js. Keeps the Tavily-specific request
// shape (search_depth, max_results, etc.) out of tools.js so that file
// only has to know about the tool-calling contract, not this provider's
// API shape.
export async function searchWeb({ query, max_results: maxResults, topic, time_range: timeRange }) {
  const body = {
    query,
    search_depth: 'basic',
    max_results: Math.min(Math.max(Number(maxResults) || 5, 1), 10),
    include_answer: true,
    topic: topic === 'news' ? 'news' : 'general',
  };
  if (timeRange) body.time_range = timeRange;

  const data = await searchWithRotation(body);

  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
    })),
  };
}
