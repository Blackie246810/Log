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
import * as logNoteButton from './buttons/logNoteButton.js';
import * as deleteConfirmButton from './buttons/deleteConfirmButton.js';
import * as editConfirmButton from './buttons/editConfirmButton.js';
import * as editStartButton from './buttons/editStartButton.js';
import { logError, reportError, errorDetail } from './errorReporter.js';
import { startHealthServer } from './health.js';
import { handleAiMessage } from './aiMessageHandler.js';
import { loadConstants } from './constantsStore.js';
import { startDailyConversationReset } from './conversationReset.js';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.commands = new Collection();
for (const cmd of [logCmd, balanceCmd, historyCmd, undoCmd, categoriesCmd, fileCmd, deleteCmd, editCmd, clearCmd, currencyCmd, timezoneCmd, memoryCmd]) {
  client.commands.set(cmd.data.name, cmd);
}

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

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await loadConstants();
  } catch (err) {
    logError('startup: loadConstants failed', err);
  }
  const port = Number(process.env.PORT) || Number(process.env.HEALTH_PORT) || 3000;
  startHealthServer(client, port);
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

// Anyone can DM this bot even though only the owner can actually use it —
// non-owner attempts are rate-limited via shouldReplyToUnauthorized above.
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.author.id !== process.env.DISCORD_OWNER_ID) {
    if (!shouldReplyToUnauthorized(message.author.id)) return;
    try {
      await message.reply('You are not authorized for this action.');
    } catch (err) {
      logError('unauthorized message reply failed', err);
    }
    return;
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
});

client.login(process.env.DISCORD_TOKEN).catch(async (err) => {
  console.error('[startup] failed to log in:', err);
  process.exit(1);
});
