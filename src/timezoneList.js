// Node 18+ exposes the full IANA tz database via Intl — no static list or
// extra dependency to maintain. If an older runtime lacks it, fall back to
// a small but broadly-useful set rather than crashing.
export const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];
  }
})();

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return TIMEZONES.some((t) => t.toLowerCase() === tz.toLowerCase());
  } catch {
    return false;
  }
}

export function canonicalTimezone(tz) {
  return TIMEZONES.find((t) => t.toLowerCase() === tz.trim().toLowerCase()) ?? null;
}
