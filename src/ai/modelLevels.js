// Maps the plain number Ameen types into /level (see commands/level.js and
// modals/levelModal.js) to a concrete backing AI model id.
//
// This file is the ONLY place in the codebase where a "level" number and a
// real model id are connected. Nothing on the /level command path — the
// command itself, the modal handler, the cards it shows — ever prints a
// model id, a provider name, or a version string back to Discord. It only
// ever echoes the bare number Ameen typed, or a deliberately vague "that
// level doesn't exist" for anything that isn't a real, currently-reachable
// option. This mirrors the "Your own internals" rule in gemini.js's system
// instruction and the VENDOR_NAME_PATTERN redaction in errorReporter.js —
// same intent (never reveal what's actually running under the hood),
// applied here at the command layer instead of the conversational one.
//
// The level number IS the Gemini Flash version number, full stop — this
// bot only ever runs on the Flash line, so "3.5" means gemini-3.5-flash,
// "3.6" means gemini-3.6-flash, and so on. There is deliberately no
// per-level table mapping numbers to arbitrary/mixed model ids (Pro vs
// Flash, different naming shapes, etc.) — the id is derived straight from
// whatever number Ameen entered. That also means there's no local list of
// "known" numbers to keep updated by hand when Google ships a new Flash
// version; any well-formed number is handed straight to Google itself for
// the real answer (see checkModelAccess in gemini.js, run once at
// /level-set time from modals/levelModal.js) — this module only owns
// input-shape validation, not which numbers currently exist or work.
export const FLASH_MODEL_PREFIX = 'gemini-';
export const FLASH_MODEL_SUFFIX = '-flash';

// What a fresh install (or a DB row with no level saved yet) starts on —
// matches the model this bot shipped with.
export const DEFAULT_LEVEL_NUMBER = '3.5';

// Builds the model id for a given level number. Pure string template, no
// lookup table and no live check — this always "succeeds" in the sense
// that it always returns *a* model id string; whether that model actually
// exists is Google's call, made live by checkModelAccess.
export function modelIdForNumber(number) {
  return `${FLASH_MODEL_PREFIX}${number}${FLASH_MODEL_SUFFIX}`;
}

// Matches a plain non-negative number with at most one decimal point:
// "3", "3.5", "12.9" — not "3.5.1", not "-3.5", not "3,5", not "3 .5", and
// not anything with letters mixed in. This is the only local validation
// left — "this isn't a number at all" is a different, specific problem
// from "no such level" (Google's answer, via checkModelAccess), and
// callers should say so plainly rather than folding it into the vague
// message.
const NUMBER_PATTERN = /^\d+(\.\d+)?$/;

// Validates and parses raw modal input in one step — format shape only.
// This is deliberately NOT the final word on whether a level can be set:
// it only rules out "not a number at all". The caller
// (modals/levelModal.js) still owes the resolved modelId a live check
// against Google (gemini.js's checkModelAccess) before treating the level
// as actually settable — see the module comment above for why that split
// exists. Return shapes:
//   { ok: true, number: '3.5', modelId: 'gemini-3.5-flash' }
//     — well-formed. Still needs a live check before it's actually
//       applied; this says nothing about whether "3.5" is a real Flash
//       version.
//   { ok: false, reason: 'format', detail: '...' }
//     — not a valid number at all (empty, malformed, out of shape). Safe
//       to show `detail` to the user as-is — it never mentions models.
export function parseLevelInput(raw) {
  const trimmed = (raw ?? '').trim();

  if (trimmed === '') {
    return { ok: false, reason: 'format', detail: 'Level cannot be empty.' };
  }

  if (!NUMBER_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'format', detail: `"${trimmed}" is not a valid number — enter something like 3.5.` };
  }

  // Normalized through Number() so equivalent forms like "3.50" and "3.5"
  // both resolve to the same model id ("gemini-3.5-flash"), rather than
  // literally templating whatever extra zeros Ameen happened to type.
  const number = String(Number(trimmed));

  return { ok: true, number, modelId: modelIdForNumber(number) };
}
