import { getAllMessageCursors, setMessageCursor } from './db.js';
import { logError, errorDetail } from './errorReporter.js';

// Discord keeps every message it ever receives regardless of whether this
// bot's gateway connection was up — nothing is lost on Discord's side while
// the bot is offline (crashed, mid-redeploy, host restart, etc). What IS
// missing without this module: a fresh gateway session only starts
// delivering *new* messageCreate events from the moment it connects; it
// never backfills the ones that arrived in the gap. This walks every
// channel we have a remembered position in (see db.js's MessageCursors
// table), fetches anything newer than the last message this process ever
// saw there, and replays it through the exact same handler a live message
// goes through — so a message the owner sent while the bot was down still
// gets seen, replied to, and acted on once the bot is back.
//
// Channels are handled one at a time, start to finish, before moving on to
// the next — each channel now keeps its own independent conversation
// history (see db.js's ChannelConversations table, one row per channel),
// so there's no shared state that needs cross-channel interleaving; the
// only thing that matters is that messages within a single channel replay
// in the order they were actually sent, which they do.
//
// Within a channel, every owner message found in the backlog is collected
// first and handed off ONCE as a batch (see aiMessageHandler.js's
// handleAiMessageBatch) rather than being run through the AI one message
// at a time. Sending 8 messages in a row while the bot was offline used to
// mean 8 separate Gemini calls and 8 separate replies flooding back in,
// run strictly sequentially so each could see the previous one's answer in
// history — slow, expensive, and noisy for what's very likely one thought
// split across sends. Batching turns that into a single call and a single
// reply that addresses everything.
const FETCH_PAGE_SIZE = 100;
// Hard ceiling on how many pages of backlog we'll ever walk for one
// channel (100 messages/page): a personal single-owner bot should never
// realistically need to replay more than a couple thousand messages, and
// without a cap a channel with a huge, unrelated flood of messages while
// the bot was down could turn a restart into a very long catch-up run.
const MAX_PAGES_PER_CHANNEL = 20;

export async function catchUpMissedMessages(client, processOwnerMessages) {
  const ownerId = process.env.DISCORD_OWNER_ID;
  if (!ownerId) return;

  let cursors;
  try {
    cursors = await getAllMessageCursors();
  } catch (err) {
    logError('catchUpMissedMessages: failed to load cursors', err);
    return;
  }
  // No channel has a remembered position yet (first run since this feature
  // shipped) — nothing to catch up on. The very next live message in any
  // channel establishes a baseline for next time.
  if (cursors.length === 0) return;

  for (const { channelId, lastMessageId } of cursors) {
    try {
      await catchUpChannel(client, channelId, lastMessageId, ownerId, processOwnerMessages);
    } catch (err) {
      // One channel failing (deleted, bot removed from the server, etc.)
      // shouldn't stop the rest from being checked — move on to the next
      // channel rather than aborting the whole catch-up run.
      logError(`catchUpMissedMessages: channel ${channelId} failed`, err);
      await notifyChannelOfCatchUpError(client, channelId, err);
    }
  }
}

// Best-effort: posts the error straight into the channel that actually
// caused it, rather than only logging to the console or defaulting to a
// DM — the channel may well still be reachable even though something
// about catching it up failed (e.g. a transient DB error persisting the
// cursor, not the channel itself being gone). If the channel genuinely
// can't be reached either, this just stays a console log, same as before —
// there's no meaningful "owner" channel to fall back to for a catch-up
// pass that hasn't identified any live message to reply to yet.
async function notifyChannelOfCatchUpError(client, channelId, err) {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      await channel.send(`Something went wrong catching up on missed messages here — ${errorDetail(err)}`);
    }
  } catch (notifyErr) {
    logError('catchUpMissedMessages: failed to notify channel of catch-up error', notifyErr);
  }
}

// Fully catches up ONE channel — every page of its backlog fetched and the
// cursor advanced through all of it — before catchUpMissedMessages moves
// on to the next channel in its loop above. The owner's messages found
// along the way are collected into `backlog` and handed to
// processOwnerMessages ONCE at the end as a single batch, rather than
// being dispatched one at a time as they're found.
async function catchUpChannel(client, channelId, afterId, ownerId, processOwnerMessages) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  let cursor = afterId;
  const backlog = [];
  for (let page = 0; page < MAX_PAGES_PER_CHANNEL; page++) {
    const batch = await channel.messages.fetch({ after: cursor, limit: FETCH_PAGE_SIZE });
    if (batch.size === 0) break;

    // fetch() with `after` still returns newest-first — sort into the
    // order the messages were actually sent within this channel.
    const ordered = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const message of ordered) {
      // The cursor is advanced past every message the moment it's seen,
      // regardless of whether it ends up in the backlog — same
      // "advance before handling" trade-off the live listener in bot.js
      // makes, so nothing gets fetched and replayed twice just because
      // the batch handled below fails partway through.
      cursor = message.id;
      try {
        await setMessageCursor(channelId, cursor);
      } catch (err) {
        logError('catchUpMissedMessages: cursor persist failed', err);
      }

      if (message.author.bot || message.author.id !== ownerId) continue;
      backlog.push(message);
    }

    if (batch.size < FETCH_PAGE_SIZE) break; // caught all the way up
  }

  if (backlog.length === 0) return;

  // processOwnerMessages (see bot.js) never actually throws in practice —
  // every failure path inside it is already caught internally. This
  // try/catch is defense in depth only: one unexpected failure shouldn't
  // stop the next channel in the outer loop from being attempted.
  try {
    await processOwnerMessages(backlog);
  } catch (err) {
    logError(`catchUpMissedMessages: processing ${backlog.length} message(s) in channel ${channelId} failed`, err);
    await notifyChannelOfCatchUpError(client, channelId, err);
  }
}
