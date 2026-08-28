const DISCORD_LIMIT = 1900; // headroom under Discord's 2000-char message cap

// Joins `items` with ", " into as few messages as fit, splitting only
// between items (never mid-item). `header` (if given) is prepended to the
// first message only.
function buildChunks(items, header) {
  const chunks = [];
  let current = header ? `${header}\n` : '';
  for (const item of items) {
    const candidate = current === '' || current.endsWith('\n') ? `${current}${item}` : `${current}, ${item}`;
    if (candidate.length > DISCORD_LIMIT && current !== '' && !current.endsWith('\n')) {
      chunks.push(current);
      current = item;
    } else {
      current = candidate;
    }
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
