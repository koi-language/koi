/**
 * Task Manager — DAG-based session task tracking.
 *
 * Singleton that tracks tasks created by agents during a session.
 * Persists to .koi/tasks/tasks.json for inspection.
 * Notifies the CLI UI via channel.setTaskPanel() on every change.
 *
 * Tasks are per-session: in-memory state starts fresh on every process launch.
 * The file is overwritten on first save, clearing previous session data.
 *
 * Usage:
 *   taskManager.create({ subject, description, activeForm? })
 *   taskManager.get(id)
 *   taskManager.update(id, { status?, owner?, addBlockedBy?, addBlocks?, ... })
 *   taskManager.list()
 *   taskManager.reset()
 */

import fs from 'fs';
import path from 'path';
import { channel } from '../io/channel.js';
import { t } from '../i18n.js';

const STATUS_ICONS = {
  pending:     '☐',
  in_progress: '●',
  completed:   '✓',
  deleted:     '✗',
};

class TaskManager {
  constructor() {
    this._tasks = {};
    this._nextId = 1;
    this._filePath = null;
    this._loaded = false;
    // True when tasks were restored from a previous session on disk.
    // Used to signal the System agent to ask the user before auto-executing.
    this._restoredFromDisk = false;
    // Guard: prevents "All tasks completed" from firing more than once per batch.
    this._allCompletedNotified = false;
    // Task-scoped skill activations. Map<taskId, Array<{agentName, skillName}>>.
    // Populated when `task_create` auto-activates skills for the creator;
    // consumed when `task_update` transitions the task to completed/deleted
    // so every skill activated *because of* the task is released. In-memory
    // only — skill state lives on the agent, this is just the index that
    // ties them to a task's lifecycle.
    this._scopedSkills = new Map();
  }

  /** Record which skills were activated for a task. See `_scopedSkills` doc. */
  recordScopedSkills(taskId, entries) {
    if (!taskId || !Array.isArray(entries) || entries.length === 0) return;
    const key = String(taskId);
    const list = this._scopedSkills.get(key) || [];
    for (const e of entries) {
      if (e?.agentName && e?.skillName) list.push({ agentName: e.agentName, skillName: e.skillName });
    }
    if (list.length > 0) this._scopedSkills.set(key, list);
  }

  /** Pop and return all skills scoped to a task (clears the entry). */
  popScopedSkills(taskId) {
    if (!taskId) return [];
    const key = String(taskId);
    const list = this._scopedSkills.get(key) || [];
    this._scopedSkills.delete(key);
    return list;
  }

  _getFilePath() {
    if (!this._filePath) {
      const root = process.env.KOI_PROJECT_ROOT || process.cwd();
      const sessionId = process.env.KOI_SESSION_ID;
      this._filePath = path.join(root, '.koi', 'sessions', sessionId, 'tasks.json');
    }
    return this._filePath;
  }

  /**
   * Load task state from disk (called lazily on first access).
   * Restores tasks from a previous run of the same session.
   */
  _loadIfNeeded() {
    if (this._loaded) return;
    this._loaded = true;
    const fp = this._getFilePath();
    if (!fs.existsSync(fp)) return;
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (data && data.tasks) {
        this._tasks = data.tasks;
        this._nextId = data.nextId || 1;
        this._restoredFromDisk = true;
        // NOTE: Do NOT call channel.setTaskPanel() here.
        // The panel is suppressed until the user answers the resume prompt.
        // If the user confirms "continue", agent.js will call showPanel() explicitly.
      }
    } catch {
      // Non-fatal — start fresh if file is corrupt
    }
  }

  _ensureDir() {
    const root = process.env.KOI_PROJECT_ROOT || process.cwd();
    const koiDir = path.join(root, '.koi');
    if (!fs.existsSync(koiDir)) return; // onboarding hasn't created .koi yet
    const dir = path.dirname(this._getFilePath());
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** Compute derived blocked state for each task (for UI). */
  _tasksForUI() {
    const nonDeleted = Object.values(this._tasks).filter(t => t.status !== 'deleted');
    return nonDeleted.map(task => ({
      ...task,
      _isBlocked: task.status === 'pending' && task.blockedBy.some(depId => {
        const dep = this._tasks[depId];
        return !dep || dep.status !== 'completed';
      }),
    }));
  }

  /** Write current state to disk and notify UI. */
  _save() {
    this._ensureDir();
    try {
      fs.writeFileSync(this._getFilePath(), JSON.stringify({
        nextId: this._nextId,
        tasks: this._tasks,
      }, null, 2));
    } catch {
      // Non-fatal — continue even if file write fails
    }
    channel.setTaskPanel(this._tasksForUI());
  }

  /**
   * DFS cycle detection on the blockedBy dependency graph.
   * Returns true if a cycle exists.
   */
  _checkCycles() {
    const colors = new Map(); // white=0, gray=1, black=2

    const visit = (id) => {
      const c = colors.get(id);
      if (c === 1) return true;  // gray = back edge = cycle
      if (c === 2) return false; // black = already processed
      colors.set(id, 1); // gray
      const task = this._tasks[id];
      for (const depId of (task?.blockedBy || [])) {
        if (this._tasks[depId] && visit(depId)) return true;
      }
      colors.set(id, 2); // black
      return false;
    };

    for (const id of Object.keys(this._tasks)) {
      if (!colors.has(id) && visit(id)) return true;
    }
    return false;
  }

  /**
   * Reset all tasks (clear memory and delete file).
   * Called at session start to ensure a clean slate.
   */
  reset() {
    this._tasks = {};
    this._nextId = 1;
    this._loaded = true; // Mark as loaded so _loadIfNeeded won't restore deleted tasks
    this._restoredFromDisk = false;
    const fp = this._getFilePath();
    if (fs.existsSync(fp)) {
      try { fs.unlinkSync(fp); } catch { /* non-fatal */ }
    }
    channel.setTaskPanel([]);
  }

  /**
   * Returns true when tasks were loaded from a previous session on disk
   * and the System agent should ask the user before auto-executing them.
   * Cleared after first call so the prompt only appears once per session.
   */
  checkRestoredFromDisk() {
    this._loadIfNeeded(); // ensure tasks are loaded before reading the flag
    const was = this._restoredFromDisk;
    this._restoredFromDisk = false; // Clear after first check
    return was;
  }

  /**
   * Create a new task.
   * Prints: "  ☐ [id] subject"
   * Returns the created task object.
   */
  create({ subject, description, activeForm } = {}) {
    this._loadIfNeeded();
    if (!subject) throw new Error('task_create: "subject" is required');

    // Auto-reset if the previous plan is fully done — prevents mixing old and new tasks.
    // Only resets when there are no pending or in_progress tasks (plan is complete).
    const existing = Object.values(this._tasks).filter(t => t.status !== 'deleted');
    if (existing.length > 0 && existing.every(t => t.status === 'completed')) {
      this._tasks = {};
      this._nextId = 1;
    }
    // New tasks arriving means we're in a new plan — reset the completion guard.
    this._allCompletedNotified = false;

    // Deduplicate: if an active task with the same subject already exists, return it
    // instead of creating a duplicate. Prevents LLM retries from doubling tasks.
    const _norm = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const duplicate = Object.values(this._tasks).find(t =>
      t.status !== 'deleted' && _norm(t.subject) === _norm(subject)
    );
    if (duplicate) {
      // Update description if the new one is longer (more detailed)
      if (description && description.length > (duplicate.description || '').length) {
        duplicate.description = description;
        duplicate.updatedAt = new Date().toISOString();
        this._save();
      }
      return { ...duplicate };
    }

    const id = String(this._nextId++);
    const now = new Date().toISOString();

    const task = {
      id,
      subject,
      description: description || '',
      activeForm: activeForm || null,
      status: 'pending',
      owner: null,
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
    };

    this._tasks[id] = task;
    this._save();

    return { ...task };
  }

  /**
   * Get a task by ID. Returns the live task object (by reference).
   * Mutations to the returned object are reflected everywhere.
   * Returns null if not found.
   */
  get(id) {
    this._loadIfNeeded();
    return this._tasks[String(id)] || null;
  }

  /**
   * Update a task. Returns the updated task object.
   *
   * Supported updates:
   *   status, owner, subject, description, activeForm,
   *   addBlockedBy (string[]), addBlocks (string[])
   */
  update(id, updates = {}) {
    this._loadIfNeeded();
    const strId = String(id);
    const task = this._tasks[strId];
    if (!task) throw new Error(`Task ${strId} not found`);

    // Snapshot for rollback if cycle detected
    const snapshot = JSON.parse(JSON.stringify(this._tasks));
    const oldStatus = task.status;
    const now = new Date().toISOString();

    // Hard block: pending → completed is illegal. Must pass through in_progress.
    if (updates.status === 'completed' && oldStatus === 'pending') {
      throw new Error(
        `Task ${strId} cannot go from 'pending' to 'completed' directly. ` +
        `You MUST call task_update with status='in_progress' first.`
      );
    }

    if (updates.status !== undefined) task.status = updates.status;
    if (updates.owner !== undefined) task.owner = updates.owner;
    if (updates.subject !== undefined) task.subject = updates.subject;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;

    if (Array.isArray(updates.addBlockedBy)) {
      for (const depId of updates.addBlockedBy) {
        const key = String(depId);
        if (!task.blockedBy.includes(key)) task.blockedBy.push(key);
      }
    }

    if (Array.isArray(updates.addBlocks)) {
      for (const blockedTaskId of updates.addBlocks) {
        const other = this._tasks[String(blockedTaskId)];
        if (other && !other.blockedBy.includes(strId)) {
          other.blockedBy.push(strId);
          other.updatedAt = now;
        }
      }
    }

    task.updatedAt = now;

    // Cycle detection — rollback and throw if cycle would be introduced
    if (this._checkCycles()) {
      this._tasks = snapshot;
      throw new Error('Cycle detected in task dependencies — update rolled back');
    }

    this._save();

    // When the last active task terminates (completed OR deleted) and
    // nothing is left pending/in_progress, clear the plan and notify.
    // Terminal set: completed + deleted (cancelled). The original guard
    // only fired on `completed` — a fully-cancelled plan (status=deleted
    // on every task) left skills activated forever because this sweep
    // never ran.
    const _isTerminal = updates.status === 'completed' || updates.status === 'deleted';
    if (_isTerminal && !this._allCompletedNotified) {
      const all = Object.values(this._tasks);
      const hasActive = all.some(t => t.status !== 'completed' && t.status !== 'deleted');
      const hasAnyCompleted = all.some(t => t.status === 'completed');
      // Fire when the queue has fully drained (no pending/in_progress).
      // Require at least one completed task so an empty manager doesn't
      // keep firing on no-op updates.
      if (!hasActive && (hasAnyCompleted || all.length > 0)) {
        this._allCompletedNotified = true;
        // In the new memory architecture plan-scoped facts are tagged
        // `_plan` and live in the same vault as session facts. They're
        // filterable on read; we don't drop them at plan completion any
        // more — the agent can choose to surface or ignore them, and the
        // event log preserves the chain for any later re-derivation.
        // (Legacy planKnowledge.clear() removed.)
        // Auto-deactivate any active workflow when its task plan drains.
        // Mirrors the plan-knowledge clear above: when every task reaches
        // `completed`, the workflow that created them is "done". Without
        // this the footer chip + `state.activeWorkflow` guard in the
        // matcher would stick forever, blocking any future workflow
        // matches in the same session.
        import('../agent/agent.js').then(({ Agent }) => {
          const root = Agent._rootAgent;
          const active = root?.state?.activeWorkflow;
          if (root && active) {
            root.callAction('deactivate_workflow', { name: active }).catch(() => {});
          }
          // Hard-sweep: when the task plan drains, every agent's skill
          // set goes back to empty — no exceptions. Catches skills that
          // were activated outside of `task_create` (manual activate,
          // legacy delegate-start auto-activate, etc.) AND covers the
          // per-agent mismatch case where the task was completed by a
          // different agent than the one that activated the skill (so
          // the per-task pop-and-deactivate in `task_update` couldn't
          // reach it). Rule from user: "no pending tasks → no active
          // skills, always".
          try {
            const agents = [];
            if (root) agents.push(root);
            for (const team of (root?.usesTeams || [])) {
              for (const member of Object.values(team?.members || {})) {
                if (member && !agents.includes(member)) agents.push(member);
              }
            }
            for (const a of agents) {
              const skills = Array.isArray(a.state?.skills) ? a.state.skills : [];
              if (skills.length === 0) continue;
              // Preferred path: deactivate_skill per name so the channel
              // event fires (UI badge drops) and any side-effects run.
              for (const name of skills) {
                a.callAction?.('deactivate_skill', { name }).catch(() => {});
              }
            }
          } catch { /* non-fatal — sweep is best-effort */ }
        }).catch(() => {});
        setTimeout(() => {
          channel.setTaskPanel([]);
          channel.print(`\x1b[32m${t('allTasksCompleted')}\x1b[0m`);
        }, 300);
      }
    }
    return { ...task };
  }

  /**
   * Push current tasks into the anchored task panel.
   * Called explicitly by agent.js after the user confirms resume.
   */
  showPanel() {
    channel.setTaskPanel(this._tasksForUI());
  }

  /**
   * List all non-deleted tasks.
   */
  list() {
    this._loadIfNeeded();
    return Object.values(this._tasks)
      .filter(t => t.status !== 'deleted')
      .map(t => ({ ...t }));
  }
}

/** Singleton task manager instance */
export const taskManager = new TaskManager();
