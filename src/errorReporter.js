// Full detail (stack trace, raw error object) is only ever printed to the
// console via logError. Anything sent to Discord — channel replies or the
// owner DM — goes through describeError/errorDetail below, which reduces an
// error down to "what kind of error" + "what actually went wrong", with no
// file paths, line numbers, or stack frames.

export function logError(context, err) {
  console.error(`[${context}]`, err);
}

// Pulls a clean {name, message} pair out of any thrown value.
export function describeError(err) {
  if (!(err instanceof Error)) {
    // Some call sites in this codebase log a plain string as a pseudo-error
    // (e.g. validation messages) — treat that string as the message itself.
    const message = String(err ?? 'Unknown error').split('\n')[0].trim();
    return { name: 'Error', message: message || 'Unknown error' };
  }

  const name = err.name && err.name !== 'Error' ? err.name : (err.constructor?.name ?? 'Error');
  let message = err.message || String(err);

  // API client errors (e.g. the Gemini SDK) often stuff a raw JSON payload
  // into `message`, like: got status: 429 Too Many Requests. {"error":{...}}
  // Pull the human-readable part out instead of dumping JSON to the channel.
  const jsonStart = message.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart));
      const nested = parsed?.error?.message ?? parsed?.message;
      message = nested ? String(nested) : message.slice(0, jsonStart).trim();
    } catch {
      message = message.slice(0, jsonStart).trim() || message;
    }
  }

  // First line only — anything past that (stack-shaped detail, "at ..."
  // frames some libraries fold into .message) stays out of the channel.
  message = message.split('\n')[0].trim();

  return { name, message: message || 'No further details were provided.' };
}

// Short "**Name:** message" string safe to drop straight into a Discord
// reply — no stack trace, no file/line info, just what broke and why.
export function errorDetail(err) {
  const { name, message } = describeError(err);
  return `**${name}:** ${message}`.slice(0, 1900);
}

export async function reportError(client, context, err) {
  logError(context, err);

  const ownerId = process.env.DISCORD_OWNER_ID;
  if (!ownerId || !client) return;

  try {
    const user = await client.users.fetch(ownerId);
    await user.send({
      content: `⚠️ **Error in \`${context}\`**\n${errorDetail(err)}`,
    });
  } catch (reportErr) {
    console.error('[errorReporter] failed to DM owner:', reportErr);
  }
}
