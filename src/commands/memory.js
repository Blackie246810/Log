import { SlashCommandBuilder, InteractionContextType, MessageFlags } from 'discord.js';
import { getMemories } from '../db.js';
import { logError, errorDetail } from '../errorReporter.js';

// Deliberately read-only — the AI has its own remember_fact/forget_fact
// tools to write here, and the owner can already just ask the AI in chat
// to save or forget something. This command exists purely so the owner can
// see, unfiltered, exactly what's actually stored, without going through
// (and having to trust) the AI's own account of it.
export const data = new SlashCommandBuilder()
  .setName('memory')
  .setDescription('List the durable facts the AI has saved about you')
  .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild);

const DISCORD_LIMIT = 1900;

function formatEntry(m) {
  const parts = [`• **${m.key}** — ${m.value}`];
  if (m.category) parts.push(`[${m.category}]`);
  if (m.expiresAt) parts.push(`(expires ${new Date(m.expiresAt).toISOString().slice(0, 10)})`);
  return parts.join(' ');
}

// Simple newline-based chunker — keeps whole entries intact rather than
// ever splitting one mid-line, splitting only between entries.
function buildChunks(lines, header) {
  const chunks = [];
  let current = header;
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (current && candidate.length > DISCORD_LIMIT) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function execute(interaction) {
  try {
    const memories = await getMemories();
    if (memories.length === 0) {
      await interaction.reply({ content: 'No saved facts yet.', flags: MessageFlags.Ephemeral });
      return;
    }

    const header = `**Saved facts (${memories.length}):**`;
    const chunks = buildChunks(memories.map(formatEntry), header);

    await interaction.reply({ content: chunks[0], flags: MessageFlags.Ephemeral });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    logError('memory command', err);
    await interaction.reply({ content: `Failed to fetch saved facts — ${errorDetail(err)}`, flags: MessageFlags.Ephemeral });
  }
}
