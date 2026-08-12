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
import * as logModal from './modals/logModal.js';
import * as noteModal from './modals/noteModal.js';
import * as deleteModal from './modals/deleteModal.js';
import * as historyModal from './modals/historyModal.js';
import * as fileModal from './modals/fileModal.js';
import * as editIdModal from './modals/editIdModal.js';
import * as editFieldsModal from './modals/editFieldsModal.js';
import * as editNoteModal from './modals/editNoteModal.js';
import * as logNoteButton from './buttons/logNoteButton.js';
import * as deleteConfirmButton from './buttons/deleteConfirmButton.js';
import * as editConfirmButton from './buttons/editConfirmButton.js';
import * as editStartButton from './buttons/editStartButton.js';
import { logError, reportError } from './errorReporter.js';
import { startHealthServer } from './health.js';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

client.commands = new Collection();
for (const cmd of [logCmd, balanceCmd, historyCmd, undoCmd, categoriesCmd, fileCmd, deleteCmd, editCmd]) {
  client.commands.set(cmd.data.name, cmd);
}

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  const port = Number(process.env.PORT) || Number(process.env.HEALTH_PORT) || 3000;
  startHealthServer(client, port);
});

client.on('interactionCreate', async (interaction) => {
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
    const payload = { content: 'Something went wrong handling that. Check the console for details.' };
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

client.login(process.env.DISCORD_TOKEN).catch(async (err) => {
  console.error('[startup] failed to log in:', err);
  process.exit(1);
});