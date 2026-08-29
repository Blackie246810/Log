// Holds the in-flight state of an /edit session between "Edit" confirm and
// the final note-modal submit (see editFieldsModal.js -> editConfirmButton.js
// -> editNoteModal.js). A session that's abandoned partway — the owner
// closes the confirm dialog without hitting Cancel, or the final DB write
// throws and there's no obvious retry path — used to sit in this Map
// forever, since nothing ever swept it. Every entry now carries an expiry
// and a lazy sweep runs on every access, so an abandoned session is
// reclaimed instead of leaking for the life of the process.

const pendingEdits = new Map();
const TTL_MS = 15 * 60 * 1000; // an edit session (open modal -> confirm -> note) has no business taking longer than this

function sweepExpired() {
  const now = Date.now();
  for (const [key, entry] of pendingEdits) {
    if (entry.expiresAt <= now) pendingEdits.delete(key);
  }
}

export function setPendingEdit(logId, data) {
  sweepExpired();
  pendingEdits.set(String(logId), { data, expiresAt: Date.now() + TTL_MS });
}

export function getPendingEdit(logId) {
  sweepExpired();
  const entry = pendingEdits.get(String(logId));
  return entry ? entry.data : null;
}

export function clearPendingEdit(logId) {
  pendingEdits.delete(String(logId));
}
