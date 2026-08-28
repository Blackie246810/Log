// Simple Levenshtein edit distance — no dependency needed for a list this size.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// Returns every entry in `list` that's "close" to `input` — either as a
// case-insensitive substring match, or above a similarity threshold on the
// whole string, or (for slash-separated values like IANA timezones) on the
// last segment alone, so "kolkata" still finds "Asia/Kolkata". Empty array
// means "no clue what this was" — caller should fall back to showing
// everything.
export function closestMatches(input, list, { threshold = 0.45 } = {}) {
  const needle = input.trim().toLowerCase();
  if (!needle) return [];

  const scored = list
    .map((entry) => {
      const hay = entry.toLowerCase();
      const lastSegment = hay.includes('/') ? hay.slice(hay.lastIndexOf('/') + 1) : hay;
      const substringHit = hay.includes(needle) || lastSegment.includes(needle);
      const sim = Math.max(similarity(needle, hay), similarity(needle, lastSegment));
      return { entry, sim: substringHit ? Math.max(sim, threshold) : sim };
    })
    .filter((s) => s.sim >= threshold)
    .sort((a, b) => b.sim - a.sim);

  return scored.map((s) => s.entry);
}
