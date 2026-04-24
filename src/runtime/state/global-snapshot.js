/**
 * Global Runtime Snapshot — builds a single point-in-time view of
 * everything a user message might need to affect: active workflow, all
 * tasks (global + per-agent queues), running delegates, and recent
 * conversation context.
 *
 * Consumed by the global message classifier (see `llm/global-classifier.js`
 * when Phase B lands) so the LLM has the complete picture in one pass
 * instead of each agent classifying against only its own local queue.
 *
 * Pure read — never mutates state. Safe to call from any hook point.
 */

import { taskManager } from './task-manager.js';

/**
 * @typedef {Object} TaskRef
 * @property {string} id
 * @property {string} subject
 * @property {string} description
 * @property {'pending'|'in_progress'|'completed'|'deleted'} status
 * @property {string|null} owner
 * @property {'taskManager' | `workqueue:${string}`} source
 *   Where the task lives — taskManager (global plan) or the named agent's
 *   work queue. The classifier uses this to know where to apply mutations.
 */

/**
 * @typedef {Object} DelegateRef
 * @property {string} name
 * @property {string|null} parentTaskKey
 *   Which task (if any) triggered this delegate's current invocation.
 * @property {string|null} activityHint
 *   Free-text hint of what the delegate is currently doing (from its
 *   `thinkingHint` / last action name). Helps the classifier reason about
 *   "the one that's researching right now".
 * @property {string[]} skills
 *   Currently active domain skills. Useful signal for the classifier:
 *   "the agent with the `infographic` skill active is the one handling the
 *   infographic sub-tasks".
 */

/**
 * @typedef {Object} Snapshot
 * @property {string | null} activeWorkflow
 * @property {string | null} activeWorkflowPhase
 *   Active phase on the root agent (routing / running_plan / reporting).
 * @property {TaskRef[]} tasks
 * @property {DelegateRef[]} runningDelegates
 * @property {{role: string, text: string}[]} recentTurns
 *   Last N messages from the root's context memory (trimmed).
 */

/**
 * Build the runtime snapshot.
 *
 * @param {Object} [opts]
 * @param {number} [opts.recentTurnsCount=6]   How many recent ctx entries to include.
 * @param {number} [opts.maxDescriptionChars=400] Cap per-task description length.
 * @returns {Promise<Snapshot>}
 */
export async function buildGlobalSnapshot(opts = {}) {
  const recentTurnsCount = opts.recentTurnsCount ?? 6;
  const maxDescriptionChars = opts.maxDescriptionChars ?? 400;

  // Late import avoids circular: agent.js imports state/*, state/* cannot import agent.js eagerly.
  const { Agent } = await import('../agent/agent.js');
  const root = Agent._rootAgent;

  // ── Active workflow + phase ───────────────────────────────────────────
  const activeWorkflow = root?.state?.activeWorkflow || null;
  const activeWorkflowPhase = root?.state?.statusPhase || null;

  // ── Tasks: merge taskManager (global plan) + every agent's workQueue ─
  // Keyed dedup: (source, id) — taskManager and workQueues are separate
  // spaces, both can carry an id "1" without collision. We tag each with
  // `source` so the classifier + dispatcher can route mutations back to
  // the right container.
  const tasks = [];

  try {
    const tmTasks = taskManager.list() || [];
    for (const t of tmTasks) {
      if (t.status === 'deleted') continue;
      tasks.push({
        id: String(t.id),
        subject: t.subject || '',
        description: _clip(t.description || '', maxDescriptionChars),
        status: t.status,
        owner: t.owner || null,
        source: 'taskManager',
      });
    }
  } catch { /* non-fatal */ }

  // Walk every registered agent and pull their workQueue items if they
  // have one lazily-initialised. Agents that never called queue_add don't
  // have a `_workQueue` instance yet — skip them (nothing to show).
  if (Agent._inboxRegistry) {
    for (const [, agent] of Agent._inboxRegistry) {
      const q = agent?._workQueue;
      if (!q) continue;
      let items;
      try { items = q.list() || []; } catch { continue; }
      for (const it of items) {
        if (it.status === 'deleted') continue;
        tasks.push({
          id: String(it.id),
          subject: it.subject || '',
          description: _clip(it.description || '', maxDescriptionChars),
          status: it.status,
          owner: it.owner || agent.name || null,
          source: `workqueue:${agent.name}`,
        });
      }
    }
  }

  // ── Running delegates ────────────────────────────────────────────────
  // Any agent in the registry other than root with a `_parentTaskKey` set
  // is currently processing a delegated task. We surface which task
  // triggered them + a short activity hint from the agent's own state.
  const runningDelegates = [];
  if (Agent._inboxRegistry) {
    for (const [, agent] of Agent._inboxRegistry) {
      if (!agent || agent === root) continue;
      if (!agent._parentTaskKey) continue;
      runningDelegates.push({
        name: agent.name,
        parentTaskKey: agent._parentTaskKey,
        activityHint: agent._currentThinkingHint
          || agent._currentActionName
          || null,
        skills: Array.isArray(agent.state?.skills) ? [...agent.state.skills] : [],
      });
    }
  }

  // ── Recent conversation turns (root only) ────────────────────────────
  // Grab the last N entries from root's context memory. Lets the
  // classifier disambiguate "change that" / "no, not like that" style
  // references that only make sense against the last turn.
  //
  // Prefer `_activeContextMemory` (live instance inside the running
  // reactive loop — has every entry added so far this turn) over
  // `contextMemoryState` (serialised snapshot written at playbook
  // end, which is STALE during an in-flight turn). The live one
  // carries user/assistant messages as they happen; the serialised
  // one may be null on the very first turn or one turn behind.
  //
  // Each ContextMemory entry stores tiered representations: `immediate`
  // (full detail), `shortTerm` (condensed), `permanent` (long-term
  // keep). We prefer the fullest available so the classifier sees the
  // most informative content.
  const recentTurns = [];
  try {
    const liveCm = root?._activeContextMemory;
    const stateCm = root?.contextMemoryState;
    const entries = Array.isArray(liveCm?.entries)
      ? liveCm.entries
      : (Array.isArray(stateCm?.entries) ? stateCm.entries : []);
    // We pull MORE entries than we'll keep so the post-filter can drop
    // tool-result / inbox-bookkeeping noise without running out of
    // actual turns. The classifier cares about the user↔assistant
    // dialogue, not the plumbing between them.
    const tail = entries.slice(-recentTurnsCount * 3);
    for (const e of tail) {
      const role = e.role || 'unknown';
      const raw = e.immediate || e.shortTerm || e.permanent || '';
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw || '');
      if (!text) continue;
      const cleaned = _cleanConversationEntry(role, text);
      if (!cleaned) continue;
      recentTurns.push(cleaned);
    }
    // Keep only the most recent N after filtering.
    if (recentTurns.length > recentTurnsCount) {
      recentTurns.splice(0, recentTurns.length - recentTurnsCount);
    }
  } catch { /* non-fatal */ }

  return {
    activeWorkflow,
    activeWorkflowPhase,
    tasks,
    runningDelegates,
    recentTurns,
  };
}

/**
 * Render a snapshot as a compact markdown string — the classifier prompt
 * will interpolate this. Centralised here so the wire format and the
 * reader side can evolve together without hunting across files.
 *
 * @param {Snapshot} snap
 * @returns {string}
 */
export function renderSnapshotForPrompt(snap) {
  const lines = [];

  if (snap.activeWorkflow) {
    lines.push(`ACTIVE WORKFLOW: ${snap.activeWorkflow}${snap.activeWorkflowPhase ? ` (phase: ${snap.activeWorkflowPhase})` : ''}`);
  } else {
    lines.push('ACTIVE WORKFLOW: (none)');
  }

  if (snap.tasks.length === 0) {
    lines.push('\nTASKS: (queue and plan are empty)');
  } else {
    lines.push('\nTASKS:');
    for (const t of snap.tasks) {
      const owner = t.owner ? ` owner=${t.owner}` : '';
      lines.push(`- [${t.status}] ${t.source}#${t.id}${owner}: ${t.subject}`);
      if (t.description) {
        lines.push(`    ${t.description.replace(/\n/g, ' ')}`);
      }
    }
  }

  if (snap.runningDelegates.length > 0) {
    lines.push('\nRUNNING DELEGATES (doing work right now):');
    for (const d of snap.runningDelegates) {
      const skills = d.skills.length > 0 ? ` skills=[${d.skills.join(',')}]` : '';
      const hint = d.activityHint ? ` — ${d.activityHint}` : '';
      lines.push(`- ${d.name} (on task #${d.parentTaskKey})${skills}${hint}`);
    }
  }

  if (snap.recentTurns.length > 0) {
    lines.push('\nRECENT CONVERSATION (oldest → newest):');
    for (const r of snap.recentTurns) {
      lines.push(`  ${r.role}: ${r.text.replace(/\n/g, ' ')}`);
    }
  }

  return lines.join('\n');
}

function _clip(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.substring(0, max - 1) + '…';
}

/**
 * Normalise a single context-memory entry into something the classifier
 * can parse cleanly. The raw ContextMemory stream is noisy for our
 * purposes — it carries:
 *   - Real user turns (plain text from prompt_user answers).
 *   - Assistant turns (JSON blobs of the full action batch).
 *   - Tool-results injected as "user" rows (e.g. `✅ print -> {...}`).
 *   - Inbox bookkeeping rows (`[INBOX] Message from user: "x" Applied as modification…`).
 *
 * We keep the first two, extract readable text from assistant JSON, and
 * drop the rest. Null return = "skip this entry".
 *
 * @returns {{role: string, text: string} | null}
 */
function _cleanConversationEntry(role, text) {
  const t = text.trim();
  if (!t) return null;

  // Drop tool-result rows — they start with ✅/❌/🚫/⛔ followed by the
  // intent name, injected by ContextMemory when an action completes.
  if (/^[✅❌🚫⛔🔴]/.test(t)) return null;

  // Drop inbox bookkeeping rows — System inserts these as side-notes to
  // document what the classifier decided. They confuse the next
  // classifier run because they re-state the raw user message AFTER
  // the already-applied mutation verb.
  if (t.startsWith('[INBOX]')) {
    // Keep the user's actual words from the bookkeeping row so we
    // don't lose the turn entirely — extract the quoted payload.
    const m = t.match(/Message from user:\s*"([^"]+)"/);
    if (m && m[1]) return { role: 'user', text: _clip(m[1], 300) };
    return null;
  }

  // Assistant turns: ContextMemory stores the LLM's raw response, which
  // is almost always a JSON batch. Extract the readable bits so the
  // classifier sees natural language, not escaped JSON.
  if (role === 'assistant') {
    const pretty = _extractAssistantText(t);
    if (!pretty) return null;
    return { role, text: _clip(pretty, 300) };
  }

  return { role, text: _clip(t, 300) };
}

/**
 * Turn a raw assistant batch-JSON into a short natural-language string.
 * The classifier only needs to know what the assistant said to the
 * user — we extract `print` messages and `prompt_user` questions, and
 * ignore every other action (tool calls, state updates, etc.).
 */
function _extractAssistantText(raw) {
  // Fast path: not JSON → treat as literal text.
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return trimmed;
  }
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return trimmed; }
  const actions = Array.isArray(parsed?.batch)
    ? parsed.batch
    : (Array.isArray(parsed) ? parsed : [parsed]);
  const chunks = [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    if (a.intent === 'print' && typeof a.message === 'string') {
      chunks.push(a.message);
    } else if (a.intent === 'prompt_user') {
      const q = a.question || a.message || a.prompt;
      if (typeof q === 'string') chunks.push(`[asked] ${q}`);
    } else if (a.actionType === 'delegate' && a.intent) {
      const subj = a.task?.subject || a.data?.subject;
      chunks.push(`[delegated → ${a.intent}${subj ? `: ${subj}` : ''}]`);
    }
  }
  // If nothing readable — summarise as a short marker instead of
  // emitting the raw JSON.
  if (chunks.length === 0) {
    const n = actions.length;
    return `[dispatched ${n} action${n === 1 ? '' : 's'}]`;
  }
  return chunks.join(' ');
}
