// When the owner replies to a message in the channel — an error the bot
// posted, something the bot said earlier, one of their own past messages,
// or (in a shared server channel) something someone else said — Discord
// gives us that as `message.reference`, not as part of the new message's
// own content. This module resolves that reference into the same kind of
// structured context (text + embeds + attachments) the AI already gets for
// the message itself, so "what does this mean?" said in reply to something
// actually has something to point at.

import { buildAttachmentParts } from './attachments.js';
import { logError } from '../errorReporter.js';

// The referenced message's own text is quoted into the prompt verbatim —
// capped so a single huge past message can't dominate the turn the way a
// user's own runaway paste could.
const MAX_REPLY_TEXT_CHARS = 4000;
// Same idea for any one embed field value (e.g. a long note on a /log
// confirmation embed).
const MAX_EMBED_FIELD_CHARS = 500;

function describeAuthor(author, message) {
  if (author.id === message.client.user.id) return `the bot itself (${author.username})`;
  if (author.id === process.env.DISCORD_OWNER_ID) return 'the server owner (the person currently talking to you — they replied to their own earlier message)';
  return `${author.username} (a different user in this channel, not the person you're talking to)`;
}

// Renders a message's embeds (used for things like the bot's /log
// confirmation cards — see embeds.js) into plain text the model can read.
// Returns '' if there's nothing embed-wise worth surfacing.
function formatEmbeds(embeds) {
  if (!embeds || embeds.length === 0) return '';

  const rendered = embeds.map((embed, i) => {
    const lines = [];
    if (embed.title) lines.push(`Title: ${embed.title}`);
    if (embed.description) lines.push(`Description: ${embed.description}`);
    for (const field of embed.fields ?? []) {
      const value = field.value.length > MAX_EMBED_FIELD_CHARS
        ? `${field.value.slice(0, MAX_EMBED_FIELD_CHARS)}…`
        : field.value;
      lines.push(`${field.name}: ${value}`);
    }
    if (embed.footer?.text) lines.push(`Footer: ${embed.footer.text}`);
    return lines.length ? `Embed ${i + 1}:\n${lines.join('\n')}` : null;
  }).filter(Boolean);

  return rendered.join('\n\n');
}

// Resolves `message.reference` (if any) into a structured context block.
// Returns null when the message isn't a reply at all. `budget` is passed
// straight through to buildAttachmentParts so the replied-to message's
// attachments share the same per-request file-count/size limits as the
// current message's own attachments — see the comment on that function.
export async function buildReplyContext(message, budget) {
  if (!message.reference) return null;

  let referenced;
  try {
    referenced = await message.fetchReference();
  } catch (err) {
    logError('buildReplyContext: fetchReference failed', err);
    // Most common cause: the replied-to message (or its channel) was
    // deleted since. Tell the model plainly rather than silently dropping
    // the reply context and letting it guess.
    return {
      contextText:
        "# Replied-to message\nThe user replied to an earlier message, but it couldn't be loaded (it may have been deleted, or the bot lost access to that channel). Tell them plainly that you can't see what they replied to, rather than guessing at its content.",
      parts: [],
      meta: [],
      warnings: [],
    };
  }

  const authorLabel = describeAuthor(referenced.author, message);
  const timestamp = referenced.createdAt.toISOString();

  let content = (referenced.content ?? '').trim();
  let truncated = false;
  if (content.length > MAX_REPLY_TEXT_CHARS) {
    content = content.slice(0, MAX_REPLY_TEXT_CHARS);
    truncated = true;
  }

  const embedText = formatEmbeds(referenced.embeds);
  const { parts, meta, warnings } = await buildAttachmentParts(referenced, budget);
  // Tag these so history-sanitization (see gemini.js) can label them as
  // coming from the replied-to message rather than the current one.
  const taggedMeta = meta.map((m) => ({ ...m, source: 'reply' }));

  let attachmentNote = '';
  if (referenced.attachments.size > 0) {
    const names = [...referenced.attachments.values()].map((a) => a.name).join(', ');
    attachmentNote = parts.length > 0
      ? `Attachments (${parts.length} included below for you to actually view/read): ${names}`
      : `Attachments: ${names} — none could be included (see warnings below), so you cannot see their content.`;
  }

  const lines = [
    "# Replied-to message (the user's message below is asking about THIS — treat it as the primary subject, not incidental context)",
    `From: ${authorLabel}`,
    `Sent: ${timestamp}`,
    `Text: ${content ? `"${content}"${truncated ? ' (truncated — original was longer)' : ''}` : '(this message had no text content)'}`,
  ];
  if (embedText) lines.push(embedText);
  if (attachmentNote) lines.push(attachmentNote);

  return {
    contextText: lines.join('\n'),
    parts,
    meta: taggedMeta,
    warnings,
  };
}
