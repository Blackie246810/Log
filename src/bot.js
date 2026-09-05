import { Client, GatewayIntentBits, Partials, Collection } from 'discord.js';
import dotenv from 'dotenv';

import * as logCmd from './commands/log.js';
import * as balanceCmd from './commands/balance.js';
import * as historyCmd from './commands/history.js';
import * as undoCmd from './commands/undo.js';
import * as categoriesCmd from './commands/categories.js';
import * as fileCmd from './commands/file.js';
import * as deleteCmd from './commands/delete.js';
import * as editCmd from './commands/edit.js';
import * as clearCmd from './commands/clear.js';
import * as currencyCmd from './commands/currency.js';
import * as timezoneCmd from './commands/timezone.js';
import * as memoryCmd from './commands/memory.js';
import * as levelCmd from './commands/level.js';
import * as logModal from './modals/logModal.js';
import * as noteModal from './modals/noteModal.js';
import * as deleteModal from './modals/deleteModal.js';
import * as historyModal from './modals/historyModal.js';
import * as fileModal from './modals/fileModal.js';
import * as editIdModal from './modals/editIdModal.js';
import * as editFieldsModal from './modals/editFieldsModal.js';
import * as editNoteModal from './modals/editNoteModal.js';
import * as currencyModal from './modals/currencyModal.js';
import * as timezoneModal from './modals/timezoneModal.js';
import * as levelModal from './modals/levelModal.js';
import * as logNoteButton from './buttons/logNoteButton.js';
import * as deleteConfirmButton from './buttons/deleteConfirmButton.js';
import * as editConfirmButton from './buttons/editConfirmButton.js';
import * as editStartButton from './buttons/editStartButton.js';
import { logError, reportError, errorDetail } from './errorReporter.js';
import { startHealthServer } from './health.js';
import { handleAiMessage, handleAiMessageBatch } from './aiMessageHandler.js';
import { validateGeminiKeys } from './ai/gemini.js';
import { loadConstants } from './constantsStore.js';
import { startDailyConversationReset } from './conversationReset.js';
import { ensureMessageCursorTable, ensureChannelConversationsTable, setMessageCursor } from './db.js';
import { catchUpMissedMessages } from './missedMessages.js';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.commands = new Collection();
for (const cmd of [logCmd, balanceCmd, historyCmd, undoCmd, categoriesCmd, fileCmd, deleteCmd, editCmd, clearCmd, currencyCmd, timezoneCmd, memoryCmd, levelCmd]) {
  client.commands.set(cmd.data.name, cmd);
}

// Start the health server right away, independent of Discord login. Render's
// health checks (and any external cron pinger) hit this port on a fixed
// schedule from the moment the process boots — they don't wait for
// clientReady. If startup was gated on Discord being connected, a slow or
// failed Discord login (or a hang in loadConstants/validateGeminiKeys) would
// leave nothing listening on the port, and Render would treat the service as
// down and restart it even though the process itself was fine.
const port = Number(process.env.PORT) || Number(process.env.HEALTH_PORT) || 3000;
startHealthServer(client, port);

// Every slash command, modal, and button is gated to the bot owner alone —
// same env var the AI chat and error-DM already use. Anyone else is told
// plainly rather than the interaction silently doing nothing.
function isOwner(userId) {
  return userId === process.env.DISCORD_OWNER_ID;
}

// Anyone can DM or invoke this bot even though only the owner can actually
// use it — without a cooldown, a stranger who finds it can trigger an
// "unauthorized" reply on every single message/interaction, for free,
// indefinitely. That's a way to burn through this bot's single Discord
// token's rate limit and to probe that it's alive. One reply per stranger
// per window is enough to tell them plainly that the bot is private;
// further attempts in that window are silently ignored instead of answered.
// Shared by both the messageCreate and interactionCreate rejection paths
// below, keyed by Discord user id.
const UNAUTHORIZED_REPLY_COOLDOWN_MS = 5 * 60 * 1000;
const lastUnauthorizedReplyAt = new Map();

function shouldReplyToUnauthorized(userId) {
  const now = Date.now();
  const last = lastUnauthorizedReplyAt.get(userId);
  if (last !== undefined && now - last < UNAUTHORIZED_REPLY_COOLDOWN_MS) return false;
  lastUnauthorizedReplyAt.set(userId, now);
  // Opportunistic cleanup — bounds the map instead of letting it grow
  // forever if many different strangers interact with the bot over its
  // lifetime.
  if (lastUnauthorizedReplyAt.size > 1000) {
    for (const [id, ts] of lastUnauthorizedReplyAt) {
      if (now - ts >= UNAUTHORIZED_REPLY_COOLDOWN_MS) lastUnauthorizedReplyAt.delete(id);
    }
  }
  return true;
}

async function rejectUnauthorized(interaction) {
  if (!shouldReplyToUnauthorized(interaction.user.id)) return;
  const payload = { content: 'You are not authorized for this action.', flags: 64 };
  try {
    if (interaction.isModalSubmit() || interaction.isButton() || interaction.isChatInputCommand()) {
      await interaction.reply(payload);
    }
  } catch (err) {
    logError('unauthorized interaction reply failed', err);
  }
}

// Shared by the real-time messageCreate listener below and by the
// startup catch-up pass (missedMessages.js) — a "missed" message replays
// through this exact same path, so it gets the same reply/action a live
// message would, no special-cased behavior for having arrived late.
// Persisting the cursor BEFORE handling means a message is never replayed
// twice just because handling it failed or the process died mid-reply —
// that's consistent with the existing "ping me again" resume behavior in
// aiMessageHandler.js for real-time failures.
async function processOwnerMessage(message) {
  try {
    await setMessageCursor(message.channelId, message.id);
  } catch (err) {
    logError('processOwnerMessage: cursor persist failed', err);
  }
  try {
    await handleAiMessage(message);
  } catch (err) {
    logError('messageCreate', err);
    try {
      await message.reply(`Something went wrong — ${errorDetail(err)}`);
    } catch (replyErr) {
      await reportError(client, 'messageCreate error-reply failed', replyErr);
    }
  }
}

// Catch-up-only counterpart to processOwnerMessage above, used by
// catchUpMissedMessages (missedMessages.js) instead of it. The cursor for
// every message in `messages` has already been persisted by the time this
// is called (missedMessages.js does that as it walks each channel's
// backlog page by page), so this only needs to worry about getting the AI
// to actually respond.
//
// A SMALL backlog (BATCH_THRESHOLD or fewer) is replied to one message at
// a time, same as if the bot had been online the whole time — each reply
// lands as its own message, in order, each one seeing the previous one's
// answer in history. Only once the backlog is bigger than that does it
// switch to one combined batched turn (see handleAiMessageBatch) instead
// of individually replying to every single one — past a few messages,
// individual replies would mean that many sequential Gemini calls (they
// have to run one after another so each sees the last one's answer) and
// that many separate replies flooding back into the channel at once.
const BATCH_THRESHOLD = 5;

async function processOwnerMessageBatch(messages) {
  if (messages.length === 0) return;

  if (messages.length <= BATCH_THRESHOLD) {
    // Sequential on purpose, not parallel — each message's reply needs to
    // land, and its turn saved to that channel's history, before the next
    // one is handled, same ordering guarantee a live conversation has.
    for (const message of messages) {
      try {
        await handleAiMessage(message);
      } catch (err) {
        logError('missedMessages: individual catch-up message failed', err);
        try {
          await message.reply(`Something went wrong — ${errorDetail(err)}`);
        } catch (replyErr) {
          await reportError(client, 'missedMessages individual error-reply failed', replyErr);
        }
      }
    }
    return;
  }

  try {
    await handleAiMessageBatch(messages);
  } catch (err) {
    const last = messages[messages.length - 1];
    logError(`missedMessages: batch of ${messages.length} failed`, err);
    try {
      await last.reply(`Something went wrong catching up on ${messages.length} missed message(s) — ${errorDetail(err)}`);
    } catch (replyErr) {
      await reportError(client, 'missedMessages batch error-reply failed', replyErr);
    }
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await loadConstants();
  } catch (err) {
    logError('startup: loadConstants failed', err);
  }

  try {
    await ensureMessageCursorTable();
    await ensureChannelConversationsTable();
    await catchUpMissedMessages(client, processOwnerMessageBatch);
  } catch (err) {
    logError('startup: catchUpMissedMessages failed', err);
  }

  // Ping every configured Gemini key now, once, rather than finding out a
  // key is bad the first time a real DM happens to land on it. Always
  // logged; only DMs the owner if something actually needs attention, so
  // a normal restart with healthy keys stays quiet.
  try {
    const { ok, summary, report } = await validateGeminiKeys();
    console.log(`[startup] ${summary}`);
    if (!ok) {
      const ownerId = process.env.DISCORD_OWNER_ID;
      if (ownerId) {
        try {
          const owner = await client.users.fetch(ownerId);
          await owner.send(`⚠️ **AI service key check on startup**\n${report}`);
        } catch (dmErr) {
          logError('startup: failed to DM key check report', dmErr);
        }
      }
    }
  } catch (err) {
    logError('startup: validateGeminiKeys failed', err);
  }

  startDailyConversationReset();
});

client.on('interactionCreate', async (interaction) => {
  if (!isOwner(interaction.user.id)) {
    await rejectUnauthorized(interaction);
    return;
  }

  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === logModal.customId) {
        await logModal.handle(interaction);
      } else if (interaction.customId.startsWith(noteModal.customIdPrefix)) {
        await noteModal.handle(interaction);
      } else if (interaction.customId === deleteModal.customId) {
        await deleteModal.handle(interaction);
      } else if (interaction.customId === historyModal.customId) {
        await historyModal.handle(interaction);
      } else if (interaction.customId === fileModal.customId) {
        await fileModal.handle(interaction);
      } else if (interaction.customId === editIdModal.customId) {
        await editIdModal.handle(interaction);
      } else if (interaction.customId.startsWith(editFieldsModal.customIdPrefix)) {
        await editFieldsModal.handle(interaction);
      } else if (interaction.customId.startsWith(editNoteModal.customIdPrefix)) {
        await editNoteModal.handle(interaction);
      } else if (interaction.customId === currencyModal.customId) {
        await currencyModal.handle(interaction);
      } else if (interaction.customId === timezoneModal.customId) {
        await timezoneModal.handle(interaction);
      } else if (interaction.customId === levelModal.customId) {
        await levelModal.handle(interaction);
      }
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith(logNoteButton.customIdPrefix)) {
        await logNoteButton.handle(interaction);
      } else if (interaction.customId.startsWith(deleteConfirmButton.customIdPrefix)) {
        await deleteConfirmButton.handle(interaction);
      } else if (interaction.customId.startsWith(editConfirmButton.customIdPrefix)) {
        await editConfirmButton.handle(interaction);
      } else if (interaction.customId.startsWith(editStartButton.customIdPrefix)) {
        await editStartButton.handle(interaction);
      }
      return;
    }
  } catch (err) {
    logError(`interaction:${interaction.type}`, err);
    const payload = { content: `Something went wrong handling that — ${errorDetail(err)}` };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (replyErr) {
      await reportError(client, 'interaction error-reply failed', replyErr);
    }
  }
});

// Anyone else who talks in a channel this bot can see (e.g. other members
// of a shared server channel who are only there to spectate) is silently
// ignored on plain messages — no reply, no acknowledgment, nothing. This
// is deliberate: this bot is a single-owner personal assistant, and a
// spectator shouldn't be able to tell it noticed them at all. Slash
// commands from non-owners are still rejected (see rejectUnauthorized
// above) but that's a private, ephemeral reply only that person sees, not
// a message in the shared channel — so it doesn't create the same noise.
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.author.id !== process.env.DISCORD_OWNER_ID) return;
  await processOwnerMessage(message);
});

client.login(process.env.DISCORD_TOKEN).catch(async (err) => {
  console.error('[startup] failed to log in:', err);
  process.exit(1);
});
