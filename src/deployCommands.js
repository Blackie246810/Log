import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import * as logCmd from './commands/log.js';
import * as balanceCmd from './commands/balance.js';
import * as historyCmd from './commands/history.js';
import * as undoCmd from './commands/undo.js';
import * as categoriesCmd from './commands/categories.js';

dotenv.config();

const commands = [logCmd, balanceCmd, historyCmd, undoCmd, categoriesCmd].map((c) => c.data.toJSON());
const rest = new REST().setToken(process.env.DISCORD_TOKEN);

try {
  const application = await rest.get(Routes.oauth2CurrentApplication());
  console.log(`Registering ${commands.length} GLOBAL commands for application ${application.id}...`);
  await rest.put(Routes.applicationCommands(application.id), { body: commands });
  console.log('Done. Global commands can take up to ~1 hour to propagate on first deploy.');
} catch (err) {
  console.error('Failed to register commands:', err);
}