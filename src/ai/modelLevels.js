// Maps the plain number Ameen types into /level (see commands/level.js and
// modals/levelModal.js) to a concrete backing AI model id.
//
// This file is the ONLY place in the codebase where a "level" number and a
// real model id are connected. Nothing on the /level command path — the
// command itself, the modal handler, the cards it shows — ever prints a
// model id, a provider name, or a version string back to Discord. It only
// ever echoes the bare number Ameen typed, or a deliberately vague "that
// level doesn't exist" for anything that isn't a real, currently-free
// option below. This mirrors the "Your own internals" rule in gemini.js's
// system instruction and the VENDOR_NAME_PATTERN redaction in
// errorReporter.js — same intent (never reveal what's actually running
// under the hood), applied here at the command layer instead of the
// conversational one.
//
// This module has no imports and knows nothing about Discord, the DB, or
// the active-level cache in constantsStore.js — it's pure mapping/
// validation logic, kept separate so it stays easy to update by hand
// whenever the underlying provider ships or retires a model, or changes
// what's free. There's no live lookup against the provider; this table
// has to be kept current manually.
//
// `free: false` is for a level that IS a real, named model but isn't
// available on the free tier right now (e.g. a Pro-only or subscription-
// gated model) — treat it exactly like a level that doesn't exist at all
// anywhere user-facing. resolveLevelInput() and modelIdForNumber() below
// both already collapse that distinction on purpose; don't reintroduce it
// in a caller.
export const LEVELS = [
  { number: '3.1', modelId: 'gemini-3.1-pro', free: false },
  { number: '3.5', modelId: 'gemini-3.5-flash', free: true },
  { number: '3.6', modelId: 'gemini-3.6-flash', free: true },
  { number: '3.7', modelId: 'gemini-3.7-flash', free: false },
  { number: '3.8', modelId: 'gemini-3.8-flash', free: false },
];

// What a fresh install (or a DB row with no level saved yet) starts on —
// matches the model this bot shipped with.
export const DEFAULT_LEVEL_NUMBER = '3.5';

// Resolves a level number to its backing model id, but ONLY if that level
// both exists and is free — an unfree or unknown number both return null,
// indistinguishably, by design (see the note on `free: false` above).
export function modelIdForNumber(number) {
  const match = LEVELS.find((l) => l.number === number && l.free);
  return match ? match.modelId : null;
}

// Matches a plain non-negative number with at most one decimal point:
// "3", "3.5", "12.9" — not "3.5.1", not "-3.5", not "3,5", not "3 .5", and
// not anything with letters mixed in. Checked before the LEVELS lookup,
// and deliberately kept as its own error class — "this isn't a number at
// all" is a different, specific problem from "no such level", and callers
// should say so plainly rather than folding it into the vague message.
const NUMBER_PATTERN = /^\d+(\.\d+)?$/;

// Validates and resolves raw modal input in one step. Return shapes:
//   { ok: true, number: '3.5' }
//     — well-formed, and matches a real, free level.
//   { ok: false, reason: 'format', detail: '...' }
//     — not a valid number at all (empty, malformed, out of shape). Safe
//       to show `detail` to the user as-is — it never mentions models.
//   { ok: false, reason: 'unknown' }
//     — a well-formed number, but no matching free level. Covers both
//       "no such level" and "that level exists but isn't free" — callers
//       must show the same vague message for both, never branch on which
//       one it actually was.
export function resolveLevelInput(raw) {
  const trimmed = (raw ?? '').trim();

  if (trimmed === '') {
    return { ok: false, reason: 'format', detail: 'Level cannot be empty.' };
  }

  if (!NUMBER_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'format', detail: `"${trimmed}" is not a valid number — enter something like 3.5.` };
  }

  // Compare numerically (not string-for-string) so equivalent forms like
  // "3.50" and "3.5" resolve to the same level.
  const value = Number(trimmed);
  const match = LEVELS.find((l) => Number(l.number) === value);

  if (!match || !match.free) {
    return { ok: false, reason: 'unknown' };
  }

  return { ok: true, number: match.number };
}
