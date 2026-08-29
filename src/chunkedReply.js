const DISCORD_LIMIT = 1900; // headroom under Discord's 2000-char message cap
const ELLIPSIS = '…';

// Caps a single string to `maxLen`, since some callers pass through
// unbounded user input (e.g. a modal text field with no setMaxLength) —
// without this, a single overlong header or item would produce a chunk
// that itself exceeds Discord's hard cap and throws on send.
function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, Math.max(0, maxLen - ELLIPSIS.length)) + ELLIPSIS;
}

// Joins `items` with ", " into as few messages as fit, splitting only
// between items (never mid-item). `header` (if given) is prepended to the
// first message only — and can end up as its own standalone chunk if even
// the first item wouldn't otherwise fit alongside it.
function buildChunks(items, header) {
  const chunks = [];
  // -1 leaves room for the trailing "\n" appended right after.
  const safeHeader = header ? truncate(header, DISCORD_LIMIT - 1) : '';
  let current = safeHeader ? `${safeHeader}\n` : '';
  let currentHasItems = false; // tracks whether `current` holds any items yet, so we know whether the next one needs a ", " separator

  for (const rawItem of items) {
    const item = truncate(String(rawItem), DISCORD_LIMIT);
    const separator = currentHasItems ? ', ' : '';
    const candidate = `${current}${separator}${item}`;

    // Only split if `current` already holds something worth keeping as its
    // own chunk (a header and/or earlier items) — an empty `current` has
    // nothing to push, so the item has to go in it regardless of length.
    if (current !== '' && candidate.length > DISCORD_LIMIT) {
      chunks.push(current);
      current = item;
    } else {
      current = candidate;
    }
    currentHasItems = true;
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function replyInChunks(interaction, items, header) {
  const chunks = buildChunks(items, header);
  await interaction.reply({ content: chunks[0] });
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i] });
  }
}
