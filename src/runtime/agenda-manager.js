/**
 * Agenda Manager — Persistent scheduling system for agents.
 *
 * Singleton that allows agents to schedule entries (reminders, tasks, events)
 * at specific dates/times. Persists to .koi/agenda.json at project level.
 *
 * Uses croner for precise cron/date scheduling with timezone support.
 *
 * Features:
 *   - Add/remove/update/list agenda entries
 *   - One-time scheduling at specific dates
 *   - Cron-based recurrence (e.g. "0 9 * * MON-FRI")
 *   - Simple recurrence shortcuts (daily, weekly, monthly)
 *   - Timezone-aware via Intl.DateTimeFormat
 *   - Triggers agents by injecting synthetic input when entries are due
 *   - Watchers: periodic condition checks that notify agents when a condition is met
 *
 * Usage:
 *   agendaManager.add({ title, scheduledAt, description?, cron?, agentName? })
 *   agendaManager.addWatch({ title, checkInstructions, interval?, maxAttempts?, agentName? })
 *   agendaManager.list({ from?, to?, status?, agentName?, type? })
 *   agendaManager.remove(id)
 *   agendaManager.update(id, { title?, scheduledAt?, description?, cron?, status? })
 *   agendaManager.startScheduler(notifyFn)
 *   agendaManager.stopScheduler()
 */

import fs from 'fs';
import path from 'path';
import { Cron } from 'croner';
import { cliLogger } from './cli-logger.js';

const ENTRY_STATUSES = ['pending', 'triggered', 'completed', 'cancelled'];

// Map simple recurrence keywords to cron expressions.
// The time part (minute/hour) is filled in from scheduledAt.
const RECURRENCE_TO_CRON = {
  daily: (m, h) => `${m} ${h} * * *`,
  weekly: (m, h, dow) => `${m} ${h} * * ${dow}`,
  monthly: (m, h, dom) => `${m} ${h} ${dom} * *`,
};

class AgendaManager {
  constructor() {
    this._entries = {};
    this._nextId = 1;
    this._filePath = null;
    this._loaded = false;
    this._notifyFn = null;
    // Map of entry ID → Cron instance (active scheduled jobs)
    this._jobs = new Map();
    this._started = false;
  }

  _getFilePath() {
    if (!this._filePath) {
      const root = process.env.KOI_PROJECT_ROOT || process.cwd();
      this._filePath = path.join(root, '.koi', 'agenda.json');
    }
    return this._filePath;
  }

  _loadIfNeeded() {
    if (this._loaded) return;
    this._loaded = true;
    const fp = this._getFilePath();
    if (!fs.existsSync(fp)) return;
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (data && data.entries) {
        this._entries = data.entries;
        this._nextId = data.nextId || 1;
      }
    } catch {
      // Non-fatal — start fresh if file is corrupt
    }
  }

  _ensureDir() {
    const dir = path.dirname(this._getFilePath());
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _save() {
    this._ensureDir();
    try {
      fs.writeFileSync(this._getFilePath(), JSON.stringify({
        nextId: this._nextId,
        entries: this._entries,
      }, null, 2));
    } catch {
      // Non-fatal
    }
  }

  /**
   * Detect the local IANA timezone (e.g. "Europe/Madrid").
   */
  _getLocalTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined; // croner will use system default
    }
  }

  /**
   * Create a Cron job for an entry and store it in _jobs.
   * Called when the scheduler is running and a pending entry needs scheduling.
   */
  _scheduleEntry(entry) {
    if (this._jobs.has(entry.id)) return; // Already scheduled
    if (entry.status !== 'pending') return;
    if (!this._notifyFn) return;

    const timezone = this._getLocalTimezone();
    const notifyFn = this._notifyFn;
    const self = this;

    try {
      let job;
      const isWatch = entry.entryType === 'watch';
      const callback = isWatch
        ? () => self._triggerWatch(entry, notifyFn)
        : () => self._triggerEntry(entry, notifyFn);

      if (entry.cron) {
        // Cron-based recurring/watch entry
        job = new Cron(entry.cron, { timezone }, callback);
      } else {
        // One-time entry at specific date
        const scheduledDate = new Date(entry.scheduledAt);
        if (scheduledDate <= new Date()) {
          // Already past due — trigger immediately
          callback();
          return;
        }
        job = new Cron(scheduledDate, { timezone }, callback);
      }

      this._jobs.set(entry.id, job);
    } catch (err) {
      cliLogger.log('agenda', `Failed to schedule entry #${entry.id}: ${err.message}`);
    }
  }

  /**
   * Fire a triggered entry: notify the agent and update status.
   */
  _triggerEntry(entry, notifyFn) {
    const message = `📅 AGENDA REMINDER: "${entry.title}"${entry.description ? ` — ${entry.description}` : ''} (scheduled by ${entry.agentName})`;
    const fullMessage = `[AGENDA] Scheduled item is now due:\n${message}\n\nPlease handle this agenda item.`;

    entry.lastTriggeredAt = new Date().toISOString();
    entry.updatedAt = new Date().toISOString();

    if (!entry.cron) {
      // One-time: mark as triggered and remove the job
      entry.status = 'triggered';
      const job = this._jobs.get(entry.id);
      if (job) job.stop();
      this._jobs.delete(entry.id);
    }
    // Cron-based: keep status as pending, croner handles the next run automatically

    this._save();
    notifyFn(fullMessage);
    cliLogger.log('agenda', `Triggered entry #${entry.id}: "${entry.title}"`);
  }

  /**
   * Fire a watch check: inject instructions for the agent to verify a condition.
   * The agent decides whether the condition is met and calls agenda_update(status='completed') if so.
   */
  _triggerWatch(entry, notifyFn) {
    entry.checkCount = (entry.checkCount || 0) + 1;
    entry.lastTriggeredAt = new Date().toISOString();
    entry.updatedAt = new Date().toISOString();

    // Check if max attempts exceeded
    if (entry.maxAttempts && entry.checkCount > entry.maxAttempts) {
      entry.status = 'cancelled';
      this._unscheduleEntry(entry.id);
      this._save();
      const timeoutMsg = `[AGENDA WATCH #${entry.id}] ⏰ Watch "${entry.title}" has reached its maximum of ${entry.maxAttempts} checks without the condition being met. The watch has been cancelled. Inform the user.`;
      notifyFn(timeoutMsg);
      cliLogger.log('agenda', `Watch #${entry.id} timed out after ${entry.maxAttempts} attempts`);
      return;
    }

    this._save();

    const fullMessage = `[AGENDA WATCH #${entry.id}] Periodic check (attempt ${entry.checkCount}${entry.maxAttempts ? `/${entry.maxAttempts}` : ''}): "${entry.title}"\nInstructions: ${entry.checkInstructions}\nIf the condition IS met: inform the user and call agenda_update with id="${entry.id}" and status="completed".\nIf the condition is NOT met: BE COMPLETELY SILENT. Do NOT print anything to the user. Do NOT say "still checking" or "still in progress". Just call prompt_user with no prior output.`;
    notifyFn(fullMessage);
    cliLogger.log('agenda', `Watch #${entry.id} check #${entry.checkCount}: "${entry.title}"`);
  }

  /**
   * Stop and remove the Cron job for a specific entry.
   */
  _unscheduleEntry(id) {
    const job = this._jobs.get(id);
    if (job) {
      job.stop();
      this._jobs.delete(id);
    }
  }

  /**
   * Add a new agenda entry.
   * @param {Object} opts
   * @param {string} opts.title - Short description of the entry
   * @param {string} opts.scheduledAt - ISO 8601 date/time string (required for one-time, used for time extraction in recurrence)
   * @param {string} [opts.description] - Detailed description
   * @param {string} [opts.recurrence='once'] - once|daily|weekly|monthly OR a cron expression (e.g. "0 9 * * MON-FRI")
   * @param {string} [opts.agentName] - Agent that created the entry
   * @returns {Object} The created entry
   */
  add({ title, scheduledAt, description, recurrence, agentName } = {}) {
    this._loadIfNeeded();
    if (!title) throw new Error('agenda_add: "title" is required');
    if (!scheduledAt) throw new Error('agenda_add: "scheduledAt" is required');

    const parsedDate = new Date(scheduledAt);
    if (isNaN(parsedDate.getTime())) {
      throw new Error(`agenda_add: Invalid date "${scheduledAt}". Use ISO 8601 format (e.g. "2025-03-22T14:30:00")`);
    }

    // Determine cron expression from recurrence
    let cronExpr = null;
    const rec = (recurrence || 'once').trim();

    if (rec === 'once') {
      cronExpr = null; // One-time, uses scheduledAt directly
    } else if (RECURRENCE_TO_CRON[rec]) {
      // Simple keyword → derive cron from scheduledAt time
      const m = parsedDate.getMinutes();
      const h = parsedDate.getHours();
      const dow = parsedDate.getDay(); // 0=Sun
      const dom = parsedDate.getDate();
      cronExpr = RECURRENCE_TO_CRON[rec](m, h, dow, dom);
    } else {
      // Assume it's a raw cron expression — validate it
      try {
        const test = new Cron(rec);
        test.stop();
        cronExpr = rec;
      } catch (err) {
        throw new Error(`agenda_add: Invalid recurrence/cron "${rec}": ${err.message}`);
      }
    }

    const id = String(this._nextId++);
    const now = new Date().toISOString();

    const entry = {
      id,
      title,
      description: description || '',
      scheduledAt: parsedDate.toISOString(),
      cron: cronExpr,
      recurrence: rec,
      status: 'pending',
      agentName: agentName || 'unknown',
      createdAt: now,
      updatedAt: now,
      lastTriggeredAt: null,
    };

    this._entries[id] = entry;
    this._save();

    // If scheduler is running, schedule immediately
    if (this._started) {
      this._scheduleEntry(entry);
    }

    cliLogger.log('agenda', `[${agentName || '?'}] Scheduled: "${title}" at ${parsedDate.toLocaleString()} (${cronExpr || 'once'})`);

    return { ...entry };
  }

  /**
   * Add a watch entry — periodic condition check that notifies the agent.
   *
   * opts.title - Short description of what to watch for
   * opts.checkInstructions - Instructions for the agent on what to check and how
   * opts.interval - Cron expression for check frequency (default: every 2 min)
   * opts.maxAttempts - Max checks before giving up, default 60 (0 = unlimited)
   * opts.agentName - Agent that created the watch
   */
  addWatch({ title, checkInstructions, interval, maxAttempts, agentName } = {}) {
    this._loadIfNeeded();
    if (!title) throw new Error('agenda_watch: "title" is required');
    if (!checkInstructions) throw new Error('agenda_watch: "checkInstructions" is required');

    // Validate and default the interval cron expression
    const cronExpr = (interval || '*/2 * * * *').trim();
    try {
      const test = new Cron(cronExpr);
      test.stop();
    } catch (err) {
      throw new Error(`agenda_watch: Invalid interval cron "${cronExpr}": ${err.message}`);
    }

    const id = String(this._nextId++);
    const now = new Date().toISOString();

    const entry = {
      id,
      entryType: 'watch',
      title,
      description: checkInstructions,
      checkInstructions,
      scheduledAt: now,
      cron: cronExpr,
      recurrence: cronExpr,
      status: 'pending',
      agentName: agentName || 'unknown',
      maxAttempts: maxAttempts != null ? maxAttempts : 60,
      checkCount: 0,
      createdAt: now,
      updatedAt: now,
      lastTriggeredAt: null,
    };

    this._entries[id] = entry;
    this._save();

    // If scheduler is running, schedule immediately
    if (this._started) {
      this._scheduleEntry(entry);
    }

    cliLogger.log('agenda', `[${agentName || '?'}] Watch: "${title}" every ${cronExpr} (max ${entry.maxAttempts} checks)`);

    return { ...entry };
  }

  /**
   * Remove an agenda entry by ID.
   */
  remove(id) {
    this._loadIfNeeded();
    const strId = String(id);
    const entry = this._entries[strId];
    if (!entry) throw new Error(`Agenda entry ${strId} not found`);

    entry.status = 'cancelled';
    entry.updatedAt = new Date().toISOString();
    this._unscheduleEntry(strId);
    this._save();

    cliLogger.log('agenda', `Cancelled agenda entry #${strId}: "${entry.title}"`);
    return { ...entry };
  }

  /**
   * Update an agenda entry.
   */
  update(id, updates = {}) {
    this._loadIfNeeded();
    const strId = String(id);
    const entry = this._entries[strId];
    if (!entry) throw new Error(`Agenda entry ${strId} not found`);

    const needsReschedule = updates.scheduledAt !== undefined
      || updates.recurrence !== undefined
      || updates.cron !== undefined
      || updates.status !== undefined;

    if (updates.title !== undefined) entry.title = updates.title;
    if (updates.description !== undefined) entry.description = updates.description;
    if (updates.status !== undefined && ENTRY_STATUSES.includes(updates.status)) {
      entry.status = updates.status;
    }
    if (updates.scheduledAt !== undefined) {
      const parsedDate = new Date(updates.scheduledAt);
      if (isNaN(parsedDate.getTime())) {
        throw new Error(`Invalid date "${updates.scheduledAt}"`);
      }
      entry.scheduledAt = parsedDate.toISOString();
    }
    if (updates.cron !== undefined) {
      entry.cron = updates.cron;
    }
    if (updates.recurrence !== undefined) {
      entry.recurrence = updates.recurrence;
    }

    entry.updatedAt = new Date().toISOString();

    // Reschedule if timing or status changed
    if (needsReschedule && this._started) {
      this._unscheduleEntry(strId);
      if (entry.status === 'pending') {
        this._scheduleEntry(entry);
      }
    }

    this._save();
    return { ...entry };
  }

  /**
   * Get a single entry by ID.
   */
  get(id) {
    this._loadIfNeeded();
    const entry = this._entries[String(id)];
    return entry ? { ...entry } : null;
  }

  /**
   * List agenda entries with optional filters.
   */
  list(filters = {}) {
    this._loadIfNeeded();
    let entries = Object.values(this._entries);

    // Exclude cancelled by default unless explicitly requested
    if (!filters.status) {
      entries = entries.filter(e => e.status !== 'cancelled');
    }

    if (filters.status) {
      entries = entries.filter(e => e.status === filters.status);
    }
    if (filters.agentName) {
      entries = entries.filter(e => e.agentName === filters.agentName);
    }
    if (filters.from) {
      const fromDate = new Date(filters.from);
      entries = entries.filter(e => new Date(e.scheduledAt) >= fromDate);
    }
    if (filters.to) {
      const toDate = new Date(filters.to);
      entries = entries.filter(e => new Date(e.scheduledAt) <= toDate);
    }

    // Sort by scheduledAt ascending
    entries.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

    return entries.map(e => ({ ...e }));
  }

  /**
   * Start the scheduler. Loads all pending entries and creates Cron jobs.
   * @param {Function} notifyFn - Called with a message string when entries are due.
   */
  startScheduler(notifyFn) {
    if (this._started) return;
    this._notifyFn = notifyFn;
    this._started = true;
    this._loadIfNeeded();

    // Schedule all pending entries
    let count = 0;
    for (const entry of Object.values(this._entries)) {
      if (entry.status === 'pending') {
        this._scheduleEntry(entry);
        count++;
      }
    }

    cliLogger.log('agenda', `Scheduler started (croner). ${count} pending entry/entries loaded.`);
  }

  /**
   * Stop the scheduler and all active Cron jobs.
   */
  stopScheduler() {
    for (const [id, job] of this._jobs) {
      job.stop();
    }
    this._jobs.clear();
    this._started = false;
    cliLogger.log('agenda', 'Scheduler stopped');
  }

  /**
   * Reset all entries (clear memory, stop jobs, delete file).
   */
  reset() {
    this.stopScheduler();
    this._entries = {};
    this._nextId = 1;
    this._loaded = true;
    const fp = this._getFilePath();
    if (fs.existsSync(fp)) {
      try { fs.unlinkSync(fp); } catch { /* non-fatal */ }
    }
  }
}

/** Singleton agenda manager instance */
export const agendaManager = new AgendaManager();
