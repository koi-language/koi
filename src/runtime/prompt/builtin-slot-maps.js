/**
 * Built-in slot maps for the core agents (System, Worker, Planner).
 *
 * Embedded as static JS so they survive the pkg bundle (no file-system
 * lookups at runtime — the packaged binary's `__dirname` doesn't carry
 * the YAML files). The slot-resolver checks this map first; only falls
 * back to disk for ad-hoc / project-defined agents.
 *
 * Slot map shape (mirrors the YAML schema in slots.yaml):
 *   {
 *     template: '...optional template name...',
 *     slots: [
 *       { id, source, query?, budget? },
 *       ...
 *     ]
 *   }
 *
 * Each slot's content lands inside the system prompt under a heading
 * derived from the slot id (when no template is provided). The
 * Context Compiler runs them in parallel and budget-allocates tokens.
 *
 * Sources used here:
 *   - `memory`        — RMH retrieval over the project vault
 *                       (`.koi/memory/notes/`, `.koi/memory/inbox/`).
 *                       Drives "what notes are relevant to the current
 *                       turn" — the auto-retrieval the agent prompts
 *                       have always promised.
 *   - `conversations` — KNN over the per-session embeddings table built
 *                       earlier today (`<project>/media-library/vector-cache/
 *                       index.sqlite#conversations`). Surfaces past
 *                       sessions in the same project that talked about
 *                       similar things — cross-session continuity
 *                       without depending on the vault being up to date.
 *
 * Trigger payload contract: callers of `compile()` pass
 *   { trigger: { payload: { task: <last user message> } } }
 * so slot maps can interpolate `{{trigger.payload.task}}` as the
 * semantic query.
 */

/** Common slot used by every agent — relevant project notes. */
const NOTES_SLOT = {
  id: 'relevant_notes',
  source: 'memory',
  query: {
    semantic: '{{trigger.payload.task}}',
    limit: 8,
    scope: 'project',
  },
  // Fixed-ish budget — notes carry the most context per token, but
  // capping here prevents a 30-note vault from drowning the prompt.
  budget: 2400,
};

/** Common slot — recently active blockers (filter on type). */
const BLOCKERS_SLOT = {
  id: 'active_blockers',
  source: 'memory',
  query: {
    semantic: '{{trigger.payload.task}}',
    filter: { type: 'blocker', status: 'active' },
    limit: 5,
    scope: 'project',
  },
  budget: 800,
};

/** Common slot — recent decisions (filter on type). */
const DECISIONS_SLOT = {
  id: 'recent_decisions',
  source: 'memory',
  query: {
    semantic: '{{trigger.payload.task}}',
    filter: { type: 'decision' },
    limit: 5,
    scope: 'project',
  },
  budget: 800,
};

/** Common slot — top-N past sessions in this project that are
 *  semantically close to the current user message. Lets the agent
 *  pick up "we already talked about X last week" without needing the
 *  vault to be perfectly maintained. */
const PREVIOUS_SESSIONS_SLOT = {
  id: 'previous_sessions',
  source: 'conversations',
  query: {
    semantic: '{{trigger.payload.task}}',
    k: 5,
    // projectScope: true → only sessions rooted in the same working
    // dir as the current one. Cross-project search would mostly add
    // noise (sessions from unrelated projects rarely apply).
    projectScope: true,
  },
  budget: 1200,
};

const _SYSTEM = {
  template: null,
  slots: [
    NOTES_SLOT,
    BLOCKERS_SLOT,
    DECISIONS_SLOT,
    PREVIOUS_SESSIONS_SLOT,
  ],
};

/** Leaner previous-sessions variant for Workers. Historically the
 *  Worker skipped this slot entirely — the old source only surfaced
 *  lossy session SUMMARIES, low value for a task-bound agent. Now the
 *  conversations source injects VERBATIM exchanges from the palace
 *  ("we already fixed this exact error like this"), which IS useful
 *  mid-task — so the Worker gets it too, just smaller (k=3, 800
 *  tokens) to keep most of the budget for code context. */
const WORKER_PREVIOUS_SESSIONS_SLOT = {
  ...PREVIOUS_SESSIONS_SLOT,
  query: { ...PREVIOUS_SESSIONS_SLOT.query, k: 3 },
  budget: 800,
};

const _WORKER = {
  template: null,
  slots: [
    NOTES_SLOT,
    BLOCKERS_SLOT,
    WORKER_PREVIOUS_SESSIONS_SLOT,
  ],
};

const _PLANNER = {
  template: null,
  slots: [
    NOTES_SLOT,
    DECISIONS_SLOT,
    PREVIOUS_SESSIONS_SLOT,
  ],
};

/** Map of agent name → slot map. The slot-resolver consults this
 *  before reaching for the file system; missing entries fall back to
 *  the on-disk lookup so project-defined agents still work. */
export const BUILTIN_SLOT_MAPS = Object.freeze({
  System: _SYSTEM,
  Worker: _WORKER,
  Planner: _PLANNER,
});

export function getBuiltinSlotMap(agentName) {
  if (!agentName) return null;
  return BUILTIN_SLOT_MAPS[agentName] || null;
}
