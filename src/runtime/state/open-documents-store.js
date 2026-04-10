/**
 * Open Documents Store
 *
 * Tracks the documents the user currently has open in the GUI's working area
 * and which one is active. Updated by the CLI layer when it receives
 * `workingAreaState` messages from the GUI.
 *
 * The state is process-global (singleton) because actions are stateless
 * and need to access it without explicit injection.
 */

let _documents = []; // [{ type, title, path }]
let _activeId = null;

export const openDocumentsStore = {
  /** Replace the full state with a new snapshot from the GUI. */
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

  /** Human-readable summary for injection into action descriptions. */
  summary() {
    if (_documents.length === 0) {
      return 'No documents currently open in the working area.';
    }
    const active = this.getActive();
    const lines = [`Open documents (${_documents.length}):`];
    for (const d of _documents) {
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
