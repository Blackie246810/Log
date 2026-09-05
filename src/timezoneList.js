import { closestMatches } from './fuzzyMatch.js';

// Node 18+ exposes the full IANA tz database via Intl — no static list or
// extra dependency to maintain. If an older runtime lacks it, fall back to
// a small but broadly-useful set rather than crashing.
export const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Asia/Calcutta', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];
  }
})();

// Two IANA names can refer to the exact same zone (same offset, same DST
// rules — it's just a renaming, e.g. Calcutta -> Kolkata in 2000) while
// Intl.supportedValuesOf('timeZone') only ever lists ONE spelling per zone.
// Node's Intl still privately understands the other spelling(s) though —
// new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata' }) works fine
// and resolves to 'Asia/Calcutta' — it's just that supportedValuesOf never
// surfaces that fact. canonicalTimezone() below relies on exactly that
// behavior, so ANY alias Intl recognizes is accepted as input, whether or
// not it's listed here.
//
// This map is used only to make the list shown to users nicer: entries
// here get displayed as "Asia/Calcutta (Asia/Kolkata)" instead of hiding
// the alternate name someone might actually search for or already have
// stored. It has no effect on what's accepted — add more pairs here
// freely as they come up, purely for display.
const KNOWN_ALIASES = {
  'Asia/Calcutta': ['Asia/Kolkata'],
  'Asia/Rangoon': ['Asia/Yangon'],
  'Asia/Saigon': ['Asia/Ho_Chi_Minh'],
  'Asia/Dacca': ['Asia/Dhaka'],
  'Europe/Kiev': ['Europe/Kyiv'],
};

function displayNameFor(tz) {
  const aliases = KNOWN_ALIASES[tz];
  return aliases && aliases.length > 0 ? `${tz} (${aliases.join(', ')})` : tz;
}

// TIMEZONES, decorated for display — e.g. "Asia/Calcutta (Asia/Kolkata)" —
// in the same order as TIMEZONES. Use this (not TIMEZONES) anywhere the
// list is actually shown to a user; use TIMEZONES for storage/comparison.
export const TIMEZONE_DISPLAY_NAMES = TIMEZONES.map(displayNameFor);

// Every string a user might plausibly type for a given TIMEZONES entry —
// itself plus any known aliases — paired with the display form that entry
// should render as. Powers findTimezoneMatches below so typing "kolkata"
// still surfaces "Asia/Calcutta (Asia/Kolkata)" even though "Kolkata"
// itself never appears in TIMEZONES.
const SEARCHABLE_TERMS = TIMEZONES.flatMap((tz) => {
  const display = displayNameFor(tz);
  return [tz, ...(KNOWN_ALIASES[tz] ?? [])].map((term) => ({ term, display }));
});

export function isValidTimezone(tz) {
  return canonicalTimezone(tz) !== null;
}

// Resolves ANY IANA timezone name OR alias Node's Intl recognizes (known
// aliases above, or otherwise — e.g. "Asia/Kolkata", "US/Eastern") down to
// the one canonical spelling TIMEZONES/storage/comparisons all expect
// (e.g. "Asia/Calcutta"). Returns null for anything Intl doesn't
// recognize at all, canonical or alias, case-insensitively.
export function canonicalTimezone(tz) {
  const trimmed = String(tz ?? '').trim();
  if (!trimmed) return null;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
    return TIMEZONES.includes(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

// Fuzzy-matches `raw` against every known name AND alias, then collapses
// the hits back down to one deduplicated, display-decorated entry per
// zone (ordered by match strength, best first) — so a near-miss like
// "Calcuta" or "Kolkota" surfaces "Asia/Calcutta (Asia/Kolkata)" exactly
// once rather than as two separate near-identical suggestions.
export function findTimezoneMatches(raw) {
  const matchedTerms = closestMatches(raw, SEARCHABLE_TERMS.map((s) => s.term));
  const seen = new Set();
  const displays = [];
  for (const term of matchedTerms) {
    const row = SEARCHABLE_TERMS.find((s) => s.term === term);
    if (row && !seen.has(row.display)) {
      seen.add(row.display);
      displays.push(row.display);
    }
  }
  return displays;
}
