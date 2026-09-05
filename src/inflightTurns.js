// Tracks AI conversation turns that are currently in flight — from the
// moment the "Thinking..." placeholder is posted (see aiMessageHandler.js)
// until the real reply lands or the turn errors out — so that:
//   - deleting the message that triggered a turn (or deleting the
//     placeholder itself) can cancel it,
//   - running /clear on a channel can cancel every turn in flight there,
//   - editing the triggering message before it's been answered can cancel
//     the stale turn and start a fresh one with the updated content.
//
// A turn here is a plain cooperative flag, not a network-cancellable
// object — the underlying AI call already in flight (see ai/gemini.js)
// keeps running once started; there is no clean way to abort a
// generateContent() call already in progress. What this DOES guarantee is
// that nothing about a cancelled turn's result — no reply, no error
// message, no table/file attachment — is ever posted or edited into
// Discord once it's been marked cancelled. That's what "abort it, don't
// respond, just ignore it" actually requires: the visible side effect
// never happens, even though the request itself quietly finishes in the
// background and its result is discarded.

// Every Discord message id relevant to a turn — the triggering message(s)
// and the bot's own placeholder — maps to that turn, so any of them being
// deleted or edited can find it in O(1).
const turnsByMessageId = new Map();
// channelId -> Set<turn>, so /clear can cancel every turn currently in
// flight in one channel without knowing any specific message id.
const turnsByChannelId = new Map();

// Starts tracking a new turn. `triggerIds` are the Discord message id(s)
// that caused this turn (usually just the one message; a batched
// catch-up reply covers several — see aiMessageHandler.js's
// handleAiMessageBatch). The placeholder message id is registered
// separately via attachPlaceholder once it exists, since the placeholder
// isn't sent until slightly after the turn begins.
export function beginTurn(channelId, triggerIds = []) {
  const turn = { channelId, cancelled: false, done: false, placeholder: null, messageIds: new Set() };
  for (const id of triggerIds) {
    if (!id) continue;
    turnsByMessageId.set(id, turn);
    turn.messageIds.add(id);
  }
  if (!turnsByChannelId.has(channelId)) turnsByChannelId.set(channelId, new Set());
  turnsByChannelId.get(channelId).add(turn);
  return turn;
}

// Registers the "Thinking..."/"Answering..." placeholder message once it's
// been sent, so deleting THAT message also cancels the turn behind it, and
// so callers that cancel a turn (e.g. a message edit) can clean the stale
// placeholder up immediately rather than leaving it animating until the
// original request finally resolves on its own.
export function attachPlaceholder(turn, placeholderMessage) {
  turn.placeholder = placeholderMessage;
  turnsByMessageId.set(placeholderMessage.id, turn);
  turn.messageIds.add(placeholderMessage.id);
}

// Marks a turn finished (successfully, errored, or cancelled — doesn't
// matter which) and stops tracking it. Only removes a message-id mapping
// if it still points at THIS turn — if the same message id was
// re-registered to a newer turn in the meantime (the edit-retrigger case,
// where the edited message keeps its id but gets a brand-new turn), this
// must not clobber that newer mapping out from under it.
export function endTurn(turn) {
  if (turn.done) return;
  turn.done = true;
  for (const id of turn.messageIds) {
    if (turnsByMessageId.get(id) === turn) turnsByMessageId.delete(id);
  }
  const set = turnsByChannelId.get(turn.channelId);
  if (set) {
    set.delete(turn);
    if (set.size === 0) turnsByChannelId.delete(turn.channelId);
  }
}

// Looks up the in-flight turn (if any) associated with a given Discord
// message id — either a triggering message or a placeholder. Returns null
// once the turn has finished, since endTurn removes the mapping.
export function getTurnForMessage(messageId) {
  return turnsByMessageId.get(messageId) ?? null;
}

// Flags a single turn as cancelled. Safe to call more than once, and safe
// to call on a turn that's already finished (no-op).
export function cancelTurn(turn) {
  if (turn && !turn.done) turn.cancelled = true;
}

// Flags every still-in-flight turn in a channel as cancelled — used by
// /clear, which is about to wipe the channel (placeholders included) and
// forget its conversation history, so anything mid-flight there has
// nothing left to sensibly reply into. Returns the turns it cancelled, in
// case a caller wants to do something with them (e.g. delete their
// placeholders directly instead of waiting for /clear's own delete pass).
export function cancelTurnsInChannel(channelId) {
  const set = turnsByChannelId.get(channelId);
  if (!set) return [];
  const cancelled = [];
  for (const turn of set) {
    if (!turn.done && !turn.cancelled) {
      turn.cancelled = true;
      cancelled.push(turn);
    }
  }
  return cancelled;
}
