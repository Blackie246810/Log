import { clearConversationHistory } from './db.js';
import { getTimezone } from './constantsStore.js';
import { logError } from './errorReporter.js';

// Conversation history is no longer trimmed by turn count — instead it's
// wiped once per calendar day (in the currently live timezone), so within
// a day the AI always sees the FULL, untrimmed conversation, and each new
// day starts a clean slate. Long-term memory (the Memories table) is what
// carries facts across that daily wipe; raw back-and-forth does not.
//
// Implementation: rather than computing the exact ms until next local
// midnight and rescheduling around it (fiddly to get right across DST
// transitions and live timezone changes), this just polls once a minute
// and compares today's zoned date string to the last one it saw. The
// moment they differ, it wipes and remembers the new date. This is
// self-correcting — if the timezone changes mid-day, the very next check
// just starts comparing against the new zone's calendar day.
const CHECK_INTERVAL_MS = 60 * 1000;

function currentLocalDateKey(timezone) {
  // en-CA formats as YYYY-MM-DD, which sorts/compares correctly as a string.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

let lastSeenDateKey = null;
let intervalHandle = null;

export function startDailyConversationReset() {
  lastSeenDateKey = currentLocalDateKey(getTimezone());

  intervalHandle = setInterval(async () => {
    const todayKey = currentLocalDateKey(getTimezone());
    if (todayKey === lastSeenDateKey) return;

    const previousKey = lastSeenDateKey;
    lastSeenDateKey = todayKey; // set before the await so a slow clear can't cause a double-fire on the next tick

    try {
      await clearConversationHistory();
      console.log(`Conversation history reset for new day: ${previousKey} -> ${todayKey} (${getTimezone()}).`);
    } catch (err) {
      logError('daily conversation reset failed', err);
    }
  }, CHECK_INTERVAL_MS);

  return intervalHandle;
}

export function stopDailyConversationReset() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
