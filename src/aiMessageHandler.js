import { AttachmentBuilder } from 'discord.js';
import { askAi, AllKeysExhaustedError, isOverloadedError } from './ai/gemini.js';
import { logError, describeError, redactVendorNames } from './errorReporter.js';
import { renderTableImages, MAX_TABLES_PER_MESSAGE } from './tableImage.js';
import { buildAttachmentParts } from './ai/attachments.js';
import { buildReplyContext } from './ai/replyContext.js';
import { extractFileAttachments } from './ai/outgoingFiles.js';
import { beginTurn, attachPlaceholder, endTurn } from './inflightTurns.js';

// Purely cosmetic: a human-readable label for the ChannelConversations row
// (see db.js) so the table is readable at a glance. Never used to look a
// row up — that's always the channel's own Discord ID, which (unlike a
// name) never changes.
function describeChannel(channel) {
  if (!channel) return null;
  if (channel.isDMBased?.()) {
    return `DM: ${channel.recipient?.username ?? channel.recipient?.tag ?? 'unknown user'}`;
  }
  return channel.name ? `#${channel.name}` : `channel ${channel.id}`;
}

const DISCORD_MESSAGE_LIMIT = 2000;

// Shown when the underlying provider is temporarily overloaded (see
// isOverloadedError in gemini.js). Deliberately generic — no mention of
// "error", "AI", "model", or the actual cause — so it just reads as the
// bot itself being briefly unavailable rather than surfacing what's
// happening behind the scenes. One is picked at random each time so it
// doesn't look like a canned, repeated response.
const OVERLOAD_MESSAGES = [
  "I'm unavailable right now — please try again later.",
  "Can't get to that at the moment. Try again in a bit.",
  "I'm not able to respond right now — check back soon.",
  "Not available at the moment — please try again shortly.",
  "I'm offline for the moment — give it another shot later.",
];

const TYPING_REFRESH_MS = 8000;
const TABLE_BLOCK_RE = /```table\s*\n([\s\S]*?)\n```/gi;

// How fast the placeholder's dots/word cycle — kept snappy on purpose so the
// wait doesn't feel dead. Discord's per-message edit rate limit can't
// actually keep up with 500ms if it ever gets hit, so the animator below
// skips a frame rather than queueing up when an edit is still in flight.
const LOADER_TICK_MS = 500;
const LOADER_DOTS = ['', '.', '..', '...'];

// Rotated through while we're waiting on the AI itself.
const THINKING_WORDS = [
  'Thinking',
  'Pondering',
  'Mulling it over',
  'Ruminating',
  'Contemplating',
  'Fathoming',
  'Percolating',
  'Noodling',
  'Chewing on it',
  'Deliberating',
];

// Rotated through once we have a reply and are rendering tables/files and
// assembling the actual Discord message(s) to send.
const ANSWERING_WORDS = [
  'Answering',
  'Composing',
  'Drafting',
  'Writing it up',
  'Putting it together',
  'Wrapping up',
];

// Cycles a placeholder message through "<Word><dots>" frames, e.g.
// "Thinking" -> "Thinking." -> "Thinking.." -> "Thinking..." -> "Fathoming"
// -> ... A full dot cycle completes before the word changes. Skips a tick
// if the previous edit hasn't resolved yet, so a rate-limited edit can't
// pile up a backlog of queued requests.
function createLoaderAnimator(placeholder, words) {
  let step = 0;
  let wordIndex = 0;
  let timer = null;
  let stopped = true;
  // Tracks the in-flight edit (if any) so stop() can wait for it instead of
  // walking away mid-request. clearInterval only stops *future* ticks — it
  // has no effect on a tick() whose placeholder.edit() is already in flight,
  // and that stale edit can otherwise resolve and land *after* the real
  // result/error message is written, silently overwriting it.
  let inFlight = null;

  function tick() {
    if (stopped || inFlight) return; // skip a frame rather than queue up
    const label = words[wordIndex % words.length];
    const dots = LOADER_DOTS[step % LOADER_DOTS.length];
    step++;
    if (step % LOADER_DOTS.length === 0) wordIndex++;
    inFlight = placeholder
      .edit(`${label}${dots}`)
      .catch(() => {
        // cosmetic only
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return {
    start() {
      stopped = false;
      tick();
      timer = setInterval(tick, LOADER_TICK_MS);
    },
    // async now: callers MUST await this before writing the real content to
    // `placeholder`, or the ordering guarantee is worthless.
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (inFlight) await inFlight;
    },
  };
}

function extractTableImages(text) {
  TABLE_BLOCK_RE.lastIndex = 0;
  const attachments = [];
  const warnings = [];

  // No cap here on purpose: a genuinely large result set is meant to span
  // as many images/messages as it needs (see ai/gemini.js) rather than
  // being cut off at some arbitrary count.
  for (const match of text.matchAll(TABLE_BLOCK_RE)) {
    try {
      const parsed = JSON.parse(match[1]);
      const buffers = renderTableImages(parsed); // may expand one block into several images
      buffers.forEach((buffer) => {
        attachments.push(new AttachmentBuilder(buffer, { name: `table_${attachments.length + 1}.png` }));
      });
    } catch (err) {
      logError('extractTableImages: malformed table JSON', err);
      const label = err instanceof Error ? err.message : String(err);
      warnings.push(`A table the AI tried to show couldn't be rendered (${label}) — ask it to resend that result.`);
    }
  }

  const remainingText = text
    .replace(TABLE_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { attachments, warnings, remainingText };
}

// Discord allows at most MAX_TABLES_PER_MESSAGE attachments per message —
// a bigger result set (table images and/or ```file``` blocks, see
// ai/outgoingFiles.js) means more messages, not more attachments crammed
// into one. Splits the flat attachment list into legal-sized chunks.
// Deletes a placeholder we're never going to put real content into,
// because the turn behind it was cancelled (see inflightTurns.js) —
// best-effort, since the message may already be gone (e.g. /clear already
// wiped it along with the rest of the channel).
async function silentlyDiscard(placeholder) {
  try {
    await placeholder.delete();
  } catch (err) {
    // Already deleted, or we lack permission — either way, this is a
    // deliberately quiet no-op; a cancelled turn should leave nothing
    // behind, but failing to clean up the placeholder isn't itself worth
    // surfacing anywhere.
  }
}

function chunkAttachments(attachments) {
  const chunks = [];
  for (let i = 0; i < attachments.length; i += MAX_TABLES_PER_MESSAGE) {
    chunks.push(attachments.slice(i, i + MAX_TABLES_PER_MESSAGE));
  }
  return chunks;
}

// Discord rejects any message over DISCORD_MESSAGE_LIMIT characters — a
// reply that runs longer than that is meant to continue as further
// messages, not get cut off. Splits on the last newline within the limit,
// falling back to the last space, so we never break mid-word/mid-sentence
// unless a single "word" itself exceeds the limit.
function splitTextIntoChunks(text, limit = DISCORD_MESSAGE_LIMIT) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// The actual "run one AI turn and post the reply" machinery — placeholder,
// loaders, the askAi call itself, splitting the reply into table images /
// files / text chunks, and error handling. Factored out so both a single
// live message (handleAiMessage) and a whole batch of backlog messages
// (handleAiMessageBatch, below) go through the exact same posting logic —
// the only difference between them is how promptText/attachments get
// built up front. `replyTo` is the Discord message the placeholder and
// any error reply attach to; `channel` is where follow-up chunks get sent.
// `triggerIds` are any additional Discord message ids (beyond replyTo's own,
// which is always included) that should also be able to cancel this turn if
// deleted or edited — used by the batch path below, where several backlog
// messages all feed one combined reply. See inflightTurns.js: a turn
// tracked here can be cancelled by a messageDelete/messageDeleteBulk on any
// of its ids, by /clear wiping the channel, or restarted by a messageUpdate
// on its triggering message — all wired up in bot.js.
async function runAiTurn({ replyTo, channel, client, promptText, attachmentParts, attachmentMeta, attachmentWarnings, triggerIds = [] }) {
  const turn = beginTurn(channel.id, [replyTo.id, ...triggerIds]);

  let placeholder;
  try {
    placeholder = await replyTo.reply('Thinking');
  } catch (err) {
    logError('ai message handler: placeholder send failed', err);
    endTurn(turn);
    return;
  }
  attachPlaceholder(turn, placeholder);

  // Cancelled in the brief window between the turn starting and the
  // placeholder actually landing (e.g. the triggering message was deleted,
  // or /clear ran, right away) — nothing to show, just clean up quietly.
  if (turn.cancelled) {
    await silentlyDiscard(placeholder);
    endTurn(turn);
    return;
  }

  const typingInterval = setInterval(() => {
    channel.sendTyping().catch(() => {
      // cosmetic only
    });
  }, TYPING_REFRESH_MS);

  const thinkingLoader = createLoaderAnimator(placeholder, THINKING_WORDS);
  thinkingLoader.start();
  let answeringLoader = null;

  try {
    const { text: reply, cards } = await askAi(
      promptText,
      client.user.username,
      undefined,
      attachmentParts,
      attachmentMeta,
      channel.id,
      describeChannel(channel)
    );

    // The turn was cancelled while askAi was running (message deleted,
    // /clear ran, or the triggering message was edited and a fresh turn
    // already started in its place). The request finished, but nothing
    // about its result should ever reach Discord — discard the
    // placeholder and stop here rather than posting a stale answer.
    if (turn.cancelled) {
      await silentlyDiscard(placeholder);
      return;
    }

    await thinkingLoader.stop();

    answeringLoader = createLoaderAnimator(placeholder, ANSWERING_WORDS);
    answeringLoader.start();

    const { attachments: tableAttachments, warnings: tableWarnings, remainingText: afterTables } = extractTableImages(reply);
    const { attachments: fileAttachments, warnings: fileWarnings, remainingText } = extractFileAttachments(afterTables);
    const attachments = [...tableAttachments, ...fileAttachments];

    // Incoming-attachment warnings (files skipped on the way in) and
    // outgoing ones (a table or file the AI tried to send that couldn't be
    // built) are both "this thing didn't make it, here's why" — reported
    // the same way rather than the outgoing half silently vanishing.
    const allWarnings = [...attachmentWarnings, ...tableWarnings, ...fileWarnings];
    const warningFooter = allWarnings.length
      ? `\n\n-# Skipped: ${allWarnings.join('; ')}`
      : '';
    const textChunks = splitTextIntoChunks(remainingText + warningFooter, DISCORD_MESSAGE_LIMIT);
    const attachmentChunks = chunkAttachments(attachments);

    // First chunk of text (and/or the first batch of table images, if there
    // were any) replaces the "Thinking..." placeholder. Any further text or
    // attachment chunks are genuinely separate Discord messages, sent right
    // after — this is what lets a long reply keep going instead of getting
    // cut off, and lets more than 10 table images ship for one reply.
    const firstPayload = {};
    if (textChunks[0]) firstPayload.content = textChunks[0];
    if (attachmentChunks[0]) firstPayload.files = attachmentChunks[0];
    // Discord embeds, e.g. a log/undo confirmation card — built from the
    // real DB write in tools.js, never authored by the model. Riding on
    // the same message as the model's own confirmation text, exactly like
    // /log and /undo show their embed alongside a reply of their own.
    if (cards.length) firstPayload.embeds = cards;
    if (!firstPayload.content && !firstPayload.files && !firstPayload.embeds) firstPayload.content = "Here's what I found.";

    await answeringLoader.stop();

    // Re-checked right before actually posting anything — the table/file
    // extraction above is synchronous and fast, but this keeps the
    // guarantee airtight regardless.
    if (turn.cancelled) {
      await silentlyDiscard(placeholder);
      return;
    }

    await placeholder.edit(firstPayload);

    for (let i = 1; i < textChunks.length; i++) {
      if (turn.cancelled) break;
      await channel.send({ content: textChunks[i] });
    }

    for (let i = 1; i < attachmentChunks.length; i++) {
      if (turn.cancelled) break;
      await channel.send({
        content: `-# continued (${i + 1}/${attachmentChunks.length})`,
        files: attachmentChunks[i],
      });
    }
  } catch (err) {
    // Cancelled turns never surface an error message either — "abort it,
    // don't respond, just ignore it" applies just as much to a failure as
    // to a success. Just clean up and leave; the loaders/interval/turn
    // teardown below in `finally` still runs.
    if (turn.cancelled) {
      await silentlyDiscard(placeholder);
      return;
    }

    logError('ai message handler', err);
    // Stop both loaders — and wait for any edit they already had in
    // flight — before writing the error message. Otherwise a stale
    // "Thinking..."/"Answering..." edit can resolve after this one and
    // silently overwrite the error text on screen.
    await thinkingLoader.stop();
    if (answeringLoader) await answeringLoader.stop();
    // All-keys-exhausted gets its own clean, purpose-written message
    // (see gemini.js) instead of running the raw error through the
    // that generic path would otherwise forward the raw provider error,
    // which often contains a doc URL that Discord auto-unfurls into a
    // distracting link-preview card.
    const errorText = err instanceof AllKeysExhaustedError
      ? err.message
      : isOverloadedError(err)
        ? OVERLOAD_MESSAGES[Math.floor(Math.random() * OVERLOAD_MESSAGES.length)]
        : `Something went wrong: ${redactVendorNames(describeError(err).message)}`;
    // askAi snapshots exactly what it was doing before rethrowing here (see
    // the catch block around its generateContent call) — whatever it was
    // asking or about to do is safely parked, so a later ping (even a bare
    // one) resumes it instead of starting over.
    await placeholder.edit(`${errorText}\n\n-# Ping me again once this clears up — I'll pick up right where I left off.`);
  } finally {
    clearInterval(typingInterval);
    // Idempotent safety net — both loaders are already stopped on every
    // path above; this just guarantees the interval is cleared even if an
    // unexpected throw happens between the try block and those calls.
    await thinkingLoader.stop();
    if (answeringLoader) await answeringLoader.stop();
    endTurn(turn);
  }
}

export async function handleAiMessage(message) {
  if (message.author.bot) return;
  if (message.author.id !== process.env.DISCORD_OWNER_ID) return;

  // A message that's just a mention of the bot (whitespace aside) still
  // has non-empty `content` — the raw "<@id>" markup — so it's stripped
  // out here rather than sent to the AI as a literal prompt. This is the
  // "just ping it" gesture: on its own it carries no new request, but it
  // still needs to reach askAi (see the early guard just below) so a turn
  // that got interrupted by high demand or an error can resume — askAi is
  // what actually knows whether there's anything to pick back up.
  const mentionsBotOnly = new RegExp(`^(<@!?${message.client.user.id}>\\s*)+$`).test(message.content ?? '');
  const rawText = message.content?.trim() ?? '';
  const text = mentionsBotOnly ? '' : rawText;
  // Attachments (receipts, statements, screenshots, ...) can carry the
  // whole request on their own, so a message isn't ignored just because
  // it has no text — only when it has neither text nor any attachments,
  // and isn't a bare ping either (a bare ping still needs to reach askAi,
  // which is what actually knows whether there's an interrupted turn to
  // resume).
  if (!text && message.attachments.size === 0 && !mentionsBotOnly) return;

  // A reply's own attachments and whatever it's replying to both end up
  // inlined into the same Gemini request, so they share one file-count/
  // size budget rather than each getting the full limit to itself (see
  // buildAttachmentParts). The current message is built first so it keeps
  // first claim on that budget, same as before this feature existed;
  // buildReplyContext spends whatever's left.
  const attachmentBudget = { totalBytes: 0, count: 0 };
  const { parts: ownAttachmentParts, meta: ownAttachmentMeta, warnings: ownAttachmentWarnings } = await buildAttachmentParts(message, attachmentBudget);
  const replyContext = await buildReplyContext(message, attachmentBudget);

  const attachmentParts = [...(replyContext?.parts ?? []), ...ownAttachmentParts];
  const attachmentMeta = [...(replyContext?.meta ?? []), ...ownAttachmentMeta];
  const attachmentWarnings = [...(replyContext?.warnings ?? []), ...ownAttachmentWarnings];

  // Every attachment got skipped (unsupported/too large/etc.), there's no
  // text to fall back on, and this isn't a reply to anything either —
  // nothing to actually send the AI, so just report why instead of asking
  // it to answer an empty message. A reply still has the referenced
  // message's own content to go on even without extra text of its own, so
  // that case is allowed through. A bare ping is allowed through too — it
  // never had attachments to skip in the first place, and it still needs
  // to reach askAi so an interrupted turn can resume.
  if (!text && !replyContext && attachmentParts.length === 0 && !mentionsBotOnly) {
    try {
      await message.reply(`Couldn't use any of those files:\n${attachmentWarnings.map((w) => `- ${w}`).join('\n')}`);
    } catch (err) {
      logError('ai message handler: attachment-skip reply failed', err);
    }
    return;
  }

  // Fold the replied-to message's context in ahead of the user's own text
  // rather than changing askAi's signature — it's just more text in the
  // same turn, structurally no different from the user pasting a quote in
  // themselves, just gathered for them.
  const promptText = replyContext
    ? `${replyContext.contextText}\n\n# The user's message (about the above)\n${text || '(no additional text — see attachments, if any, on this message)'}`
    : text;

  await runAiTurn({
    replyTo: message,
    channel: message.channel,
    client: message.client,
    promptText,
    attachmentParts,
    attachmentMeta,
    attachmentWarnings,
  });
}

// Catch-up entry point for a channel that has MORE THAN ONE owner message
// waiting after a restart/reconnect (see missedMessages.js). Firing
// handleAiMessage once per backlog message would mean one Gemini call, one
// "Thinking..." placeholder, and one reply PER message — slow (they'd have
// to run strictly one after another so each sees the last one's reply in
// history), expensive, and it floods the channel with replies to what was
// very likely a single continuous thought split across several sends.
// Instead every backlog message's text/attachments/reply-context are
// folded into ONE prompt, oldest first, and answered with a single turn —
// the model is explicitly told there are several messages and asked to
// address each. A batch of exactly one message is just handleAiMessage.
export async function handleAiMessageBatch(messages) {
  if (messages.length === 0) return;
  if (messages.length === 1) {
    await handleAiMessage(messages[0]);
    return;
  }

  const lastMessage = messages[messages.length - 1];
  const channel = lastMessage.channel;
  const botUserId = lastMessage.client.user.id;

  // Shared across every message in the batch, same reasoning as the
  // single-message path sharing one budget between a message and whatever
  // it's replying to (see buildAttachmentParts): all of it lands in one
  // Gemini request, so it all has to fit under one combined cap rather
  // than each message getting the full limit to itself.
  const attachmentBudget = { totalBytes: 0, count: 0 };
  const attachmentParts = [];
  const attachmentMeta = [];
  const attachmentWarnings = [];
  const segments = [];

  for (const message of messages) {
    const mentionsBotOnly = new RegExp(`^(<@!?${botUserId}>\\s*)+$`).test(message.content ?? '');
    const rawText = message.content?.trim() ?? '';
    const text = mentionsBotOnly ? '' : rawText;

    const { parts: ownParts, meta: ownMeta, warnings: ownWarnings } = await buildAttachmentParts(message, attachmentBudget);
    const replyContext = await buildReplyContext(message, attachmentBudget);

    attachmentParts.push(...(replyContext?.parts ?? []), ...ownParts);
    attachmentMeta.push(...(replyContext?.meta ?? []), ...ownMeta);
    attachmentWarnings.push(...(replyContext?.warnings ?? []), ...ownWarnings);

    // Same "nothing usable here" check as the single-message path — skip
    // this one message rather than the whole batch; the others may still
    // have real content.
    if (!text && !replyContext && ownParts.length === 0 && !mentionsBotOnly) continue;

    const timestamp = new Date(message.createdTimestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    const body = replyContext
      ? `${replyContext.contextText}\n\n${text || '(no additional text on this message — see attachments, if any)'}`
      : text || (ownParts.length ? '(no text — see attached file(s) on this message)' : '(just a ping)');
    segments.push(`[${timestamp}] ${body}`);
  }

  // Every backlog message turned out to be unusable on its own (e.g. all
  // bare pings with attachments that got skipped) — nothing worth sending
  // the AI. Rather than silently doing nothing, still surface the warnings
  // so the owner knows files were dropped.
  if (segments.length === 0) {
    if (attachmentWarnings.length) {
      try {
        await lastMessage.reply(`Caught up on ${messages.length} messages, but couldn't use any of the attached files:\n${attachmentWarnings.map((w) => `- ${w}`).join('\n')}`);
      } catch (err) {
        logError('ai message handler (batch): attachment-skip reply failed', err);
      }
    }
    return;
  }

  const promptText = `# ${messages.length} messages sent to you in this channel while you were offline, oldest first. Reply once, addressing each in turn.\n\n${segments.join('\n\n---\n\n')}`;

  await runAiTurn({
    replyTo: lastMessage,
    channel,
    client: lastMessage.client,
    promptText,
    attachmentParts,
    attachmentMeta,
    attachmentWarnings,
    // Any one of the batched backlog messages being deleted or edited
    // should be able to cancel this combined reply, not just the last one.
    triggerIds: messages.map((m) => m.id),
  });
}