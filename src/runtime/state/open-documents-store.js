/**
 * Open Documents Store
 *
 * Two parallel views of the working-area state:
 *
 *   1. **LIVE** (`set` / `getAll` / `getActive` / `findByPathOrUrl`) — the
 *      current, up-to-the-millisecond state of GUI tabs. Updated by both
 *      `input` messages AND `workingAreaState` pushes. Used by code that
 *      genuinely needs "what is open RIGHT NOW" (file watchers, cancel
 *      banners, UI sync logic).
 *
 *   2. **TURN SNAPSHOT** (`pinTurnSnapshot` / `getSnapshotAll` /
 *      `getSnapshotActive` / `findInSnapshotByPathOrUrl`) — a frozen
 *      copy taken at the moment the user submits a message. Stays
 *      immutable for the duration of the agent's turn; only re-pinned
 *      when the NEXT user input arrives. Used by every prompt-building
 *      code path so the agent's "WORKING AREA" view is what the user
 *      saw when they typed, not whatever the GUI is showing N tool
 *      calls later.
 *
 * Why two views: when the agent generates an image / video / upscale
 * and the GUI auto-opens the result as a new tab, that tab BECOMES the
 * active one in the live store. Without snapshot pinning, the next LLM
 * call inside the same turn would see the just-generated artifact as
 * "the active document the user is looking at" — wrong: the user is
 * still implicitly referring to whatever they were looking at when they
 * typed. The snapshot keeps the agent's frame-of-reference stable.
 *
 * The state is process-global (singleton) because actions are stateless
 * and need to access it without explicit injection.
 */

let _documents = []; // LIVE — [{ type, title, path }]
let _activeId = null;

let _snapshotDocs = [];   // TURN SNAPSHOT — frozen at user-input-submit
let _snapshotActiveId = null;
let _snapshotPinnedAt = null; // unix ms — for diagnostic logs

export const openDocumentsStore = {
  // ─── LIVE store ───────────────────────────────────────────────────────

  /** Replace the full LIVE state with a new snapshot from the GUI. Called
   *  by both `input` messages and `workingAreaState` pushes. Does NOT
   *  touch the turn snapshot — that's done explicitly by
   *  `pinTurnSnapshot` when an input arrives. */
  set(documents, activeId) {
    _documents = Array.isArray(documents) ? documents : [];
    _activeId = activeId ?? null;
  },

  getAll() { return _documents; },

  getActive() {
    if (!_activeId) return null;
    return _documents.find(d => d.id === _activeId) || null;
  },

  hasAny() { return _documents.length > 0; },

  /** Find an open document (in the LIVE store) by its file path or URL. */
  findByPathOrUrl(pathOrUrl) {
    if (!pathOrUrl) return null;
    const needle = String(pathOrUrl);
    return _documents.find(d => d.path === needle || d.url === needle) || null;
  },

  // ─── TURN SNAPSHOT ────────────────────────────────────────────────────

  /** Freeze the current GUI working-area state as the "user's frame of
   *  reference" for the entire upcoming turn. Call this at user-input
   *  arrival; subsequent prompt builds within the same turn read from
   *  this frozen view, NOT from the LIVE store that may have shifted as
   *  the agent generated artifacts.
   *
   *  Performs a SHALLOW copy of the documents array — the doc objects
   *  themselves are reused. That's fine because the frozen-time
   *  documents shouldn't be mutated by the GUI side once the snapshot
   *  is taken (a new GUI push replaces the LIVE array with a new
   *  reference, leaving the snapshot's reference intact). */
  pinTurnSnapshot(documents, activeId) {
    _snapshotDocs = Array.isArray(documents) ? [...documents] : [];
    _snapshotActiveId = activeId ?? null;
    _snapshotPinnedAt = Date.now();
  },

  /** When was the current snapshot pinned (unix ms)? Null if no snapshot
   *  has ever been pinned (initial state before first user input). */
  snapshotPinnedAt() { return _snapshotPinnedAt; },

  /** Read documents from the frozen turn snapshot. Falls back to LIVE
   *  for the very first turn before any input has been received (the
   *  snapshot won't be pinned yet). After the first input every prompt
   *  build returns this view until the next input re-pins. */
  getSnapshotAll() {
    return _snapshotPinnedAt != null ? _snapshotDocs : _documents;
  },

  getSnapshotActive() {
    const docs = this.getSnapshotAll();
    const id = _snapshotPinnedAt != null ? _snapshotActiveId : _activeId;
    if (!id) return null;
    return docs.find(d => d.id === id) || null;
  },

  hasAnyInSnapshot() { return this.getSnapshotAll().length > 0; },

  /** Find a document in the SNAPSHOT view by path or URL. Used by
   *  read_file et al. so the agent's "is this the active doc?" check
   *  matches what the user saw at submit time, not the current LIVE
   *  state which may include artifacts the agent generated mid-turn. */
  findInSnapshotByPathOrUrl(pathOrUrl) {
    if (!pathOrUrl) return null;
    const needle = String(pathOrUrl);
    return this.getSnapshotAll().find(d => d.path === needle || d.url === needle) || null;
  },

  // ─── Misc ─────────────────────────────────────────────────────────────

  /** Human-readable summary for injection into action descriptions.
   *  Reads from the SNAPSHOT (it's what the agent would describe to
   *  the user) — the LIVE state is for non-agent code. */
  summary() {
    const docs = this.getSnapshotAll();
    if (docs.length === 0) {
      return 'No documents currently open in the working area.';
    }
    const active = this.getSnapshotActive();
    const lines = [`Open documents (${docs.length}):`];
    for (const d of docs) {
      const loc = d.path || d.url || '';
      lines.push(`  - [${d.type}] ${d.title}${loc ? ' — ' + loc : ''}`);
    }
    if (active) {
      const loc = active.path || active.url || '';
      lines.push(`Active document (what the user is currently looking at): [${active.type}] ${active.title}${loc ? ' — ' + loc : ''}`);
    }
    return lines.join('\n');
  },
};
