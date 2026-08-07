export function logError(context, err) {
  console.error(`[${context}]`, err);
}

export async function reportError(client, context, err) {
  logError(context, err);

  const ownerId = process.env.DISCORD_OWNER_ID;
  if (!ownerId || !client) return;

  try {
    const user = await client.users.fetch(ownerId);
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    await user.send({
      content: `⚠️ **Error in \`${context}\`**\n\`\`\`${message.slice(0, 1900)}\`\`\``,
    });
  } catch (reportErr) {
    console.error('[errorReporter] failed to DM owner:', reportErr);
  }
}