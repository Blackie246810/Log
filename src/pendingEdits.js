const pendingEdits = new Map();

export function setPendingEdit(logId, data) {
  pendingEdits.set(String(logId), data);
}

export function getPendingEdit(logId) {
  return pendingEdits.get(String(logId)) ?? null;
}

export function clearPendingEdit(logId) {
  pendingEdits.delete(String(logId));
}