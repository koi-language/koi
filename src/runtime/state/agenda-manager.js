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
 *
 * Usage:
 *   agendaManager.add({ title, scheduledAt, description?, cron?, agentName?, workDir? })
 *   agendaManager.list({ from?, to?, status?, agentName?, type? })
 *   agendaManager.remove(id)
 *   agendaManager.update(id, { title?, scheduledAt?, description?, cron?, status? })
 *   agendaManager.startScheduler(notifyFn)
 *   agendaManager.stopScheduler()
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Cron } from 'croner';
import { channel } from '../io/channel.js';

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
    // Map of entry ID → schedule signature (cron|scheduledAt) the job was
    // created with, so syncJobs can detect a rescheduled entry and rebuild it.
    this._jobSig = new Map();
    this._started = false;
  }

  /** Signature of an entry's timing — changes when it's rescheduled. */
  _scheduleSig(entry) {
    return `${entry.cron || ''}|${entry.scheduledAt || ''}`;
  }

  /**
   * Resolve a recurrence value into a cron expression (or null for one-off).
   * 'once' → null; daily/weekly/monthly → derived from scheduledDate's time;
   * anything else → treated as a raw cron expression (validated). Shared by
   * add() and update() so editing recurrence behaves identically to creating.
   */
  _resolveCron(recurrence, scheduledDate) {
    const rec = (recurrence || 'once').trim();
    if (rec === 'once') return null;
    if (RECURRENCE_TO_CRON[rec]) {
      return RECURRENCE_TO_CRON[rec](
        scheduledDate.getMinutes(), scheduledDate.getHours(),
        scheduledDate.getDay(), scheduledDate.getDate(),
      );
    }
    const test = new Cron(rec); // throws on an invalid expression
    test.stop();
    return rec;
  }

  _getFilePath() {
    // SINGLE global agenda (one per machine/team), NOT per-project. Each entry
    // carries its own `workDir` so the scheduler can run it in the directory it
    // was scheduled in. Override with KOI_AGENDA_FILE for tests.
    if (!this._filePath) {
      this._filePath = process.env.KOI_AGENDA_FILE
        || path.join(os.homedir(), '.koi', 'agenda.json');
    }
    return this._filePath;
  }

  /**
   * Force a re-read from disk. The agenda is a single global file shared across
   * processes (the scheduler daemon + any spawned task session that calls
   * agenda_update). The daemon calls this before each fire so it sees status
   * changes (e.g. a watch a child marked 'completed') instead of acting on a
   * stale in-memory copy.
   */
  refresh() {
    this._loaded = false;
    this._loadIfNeeded();
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
      const callback = () => self._triggerEntry(entry, notifyFn);

      if (entry.cron) {
        // Cron-based recurring entry
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
      this._jobSig.set(entry.id, this._scheduleSig(entry));
    } catch (err) {
      channel.log('agenda', `Failed to schedule entry #${entry.id}: ${err.message}`);
    }
  }

  /**
   * Fire a triggered entry: notify the agent and update status.
   */
  _triggerEntry(scheduledEntry, fireFn) {
    // Reconcile with disk first — the global agenda is shared across processes,
    // so the entry may have been cancelled/updated since we scheduled it.
    this.refresh();
    const entry = this._entries[scheduledEntry.id];
    if (!entry || entry.status !== 'pending') {
      this._unscheduleEntry(scheduledEntry.id);
      return;
    }

    // The scheduled task IS the instruction handed to the new session's System
    // agent — exactly as it was scheduled, nothing more. (The session runs it in
    // YOLO + exit-on-complete, so no extra "do this autonomously" framing needed.)
    const prompt = entry.description
      ? `${entry.title}\n\n${entry.description}`
      : entry.title;

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
    // fireFn spawns a fresh headless YOLO session in entry.workDir to run the
    // task and exit (see the scheduler daemon). It receives the full entry so
    // it knows the work directory.
    try { fireFn({ entry: { ...entry }, prompt }); } catch (err) {
      channel.log('agenda', `fireFn failed for #${entry.id}: ${err.message}`);
    }
    channel.log('agenda', `Triggered entry #${entry.id}: "${entry.title}" → ${entry.workDir}`);
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
    this._jobSig.delete(id);
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
  add({ title, scheduledAt, description, recurrence, agentName, workDir } = {}) {
    this.refresh(); // shared global file — re-read so we don't clobber other processes' writes
    if (!title) throw new Error('agenda_add: "title" is required');
    if (!scheduledAt) throw new Error('agenda_add: "scheduledAt" is required');

    const parsedDate = new Date(scheduledAt);
    if (isNaN(parsedDate.getTime())) {
      throw new Error(`agenda_add: Invalid date "${scheduledAt}". Use ISO 8601 format (e.g. "2025-03-22T14:30:00")`);
    }

    // Determine cron expression from recurrence
    const rec = (recurrence || 'once').trim();
    let cronExpr;
    try {
      cronExpr = this._resolveCron(rec, parsedDate);
    } catch (err) {
      throw new Error(`agenda_add: Invalid recurrence/cron "${rec}": ${err.message}`);
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
      // The directory this task runs in when it fires. Defaults to where it was
      // scheduled. The scheduler daemon spawns the task session with this as
      // KOI_PROJECT_ROOT.
      workDir: workDir || process.env.KOI_PROJECT_ROOT || process.cwd(),
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

    channel.log('agenda', `[${agentName || '?'}] Scheduled: "${title}" at ${parsedDate.toLocaleString()} (${cronExpr || 'once'}) in ${entry.workDir}`);

    return { ...entry };
  }

  /**
   * Remove an agenda entry by ID.
   */
  remove(id) {
    this.refresh(); // shared global file — re-read first
    const strId = String(id);
    const entry = this._entries[strId];
    if (!entry) throw new Error(`Agenda entry ${strId} not found`);

    entry.status = 'cancelled';
    entry.updatedAt = new Date().toISOString();
    this._unscheduleEntry(strId);
    this._save();

    channel.log('agenda', `Cancelled agenda entry #${strId}: "${entry.title}"`);
    return { ...entry };
  }

  /**
   * Update an agenda entry.
   */
  update(id, updates = {}) {
    this.refresh(); // shared global file — re-read first
    const strId = String(id);
    const entry = this._entries[strId];
    if (!entry) throw new Error(`Agenda entry ${strId} not found`);

    const needsReschedule = updates.scheduledAt !== undefined
      || updates.recurrence !== undefined
      || updates.cron !== undefined
      || updates.status !== undefined;

    if (updates.title !== undefined) entry.title = updates.title;
    if (updates.description !== undefined) entry.description = updates.description;
    // Agent-written completion summary (shown in the calendar once completed).
    if (updates.summary !== undefined) entry.summary = updates.summary;
    // Agent-written publication preview (post text + media), shown in the
    // calendar's Preview tab when available.
    if (updates.preview !== undefined) entry.preview = updates.preview;
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
    // Recurrence change → recompute cron (mirrors add(), uses the effective
    // scheduledAt). An explicit `cron` update, if given, wins.
    if (updates.cron !== undefined) {
      entry.cron = updates.cron;
      if (updates.recurrence !== undefined) entry.recurrence = updates.recurrence;
    } else if (updates.recurrence !== undefined) {
      const rec = (updates.recurrence || 'once').trim();
      try {
        entry.cron = this._resolveCron(rec, new Date(entry.scheduledAt));
      } catch (err) {
        throw new Error(`agenda_update: Invalid recurrence/cron "${rec}": ${err.message}`);
      }
      entry.recurrence = rec;
    } else if (updates.scheduledAt !== undefined
               && entry.recurrence && RECURRENCE_TO_CRON[entry.recurrence]) {
      // A keyword-recurring entry (daily/weekly/monthly) whose time moved —
      // its cron is derived from the time of day, so recompute it.
      entry.cron = this._resolveCron(entry.recurrence, new Date(entry.scheduledAt));
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
    this.refresh(); // shared global file — always read the latest (the daemon updates statuses)
    const entry = this._entries[String(id)];
    return entry ? { ...entry } : null;
  }

  /**
   * List agenda entries with optional filters.
   */
  list(filters = {}) {
    this.refresh(); // shared global file — always read the latest (the daemon updates statuses)
    let entries = Object.values(this._entries);

    // Exclude cancelled by default unless explicitly requested (by status
    // filter or by the includeCancelled flag — the calendar shows cancelled
    // entries struck-through rather than hiding them).
    if (!filters.status && !filters.includeCancelled) {
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
   * Intended to run in ONE process only (the agenda daemon) — the agenda is a
   * single global file, so multiple schedulers would each fire every task.
   * @param {Function} fireFn - Called as fireFn({ entry, prompt }) when an entry
   *   is due. The daemon spawns a fresh headless YOLO session in entry.workDir
   *   that runs `prompt` and exits.
   */
  startScheduler(fireFn) {
    if (this._started) return;
    this._notifyFn = fireFn;
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

    channel.log('agenda', `Scheduler started (croner). ${count} pending entry/entries loaded.`);
  }

  /**
   * Reconcile in-memory cron jobs with the on-disk agenda. The daemon calls
   * this on a timer so entries ADDED by other processes (session agents calling
   * agenda_add) get scheduled, and entries that were cancelled/completed get
   * their jobs stopped. Returns { added, removed } counts.
   */
  syncJobs() {
    if (!this._started) return { added: 0, removed: 0, rescheduled: 0 };
    this.refresh();
    let added = 0;
    let removed = 0;
    let rescheduled = 0;
    for (const entry of Object.values(this._entries)) {
      if (entry.status !== 'pending') continue;
      if (!this._jobs.has(entry.id)) {
        // New pending entry (added by a session via agenda_add) — schedule it.
        this._scheduleEntry(entry);
        if (this._jobs.has(entry.id)) added++;
      } else if (this._jobSig.get(entry.id) !== this._scheduleSig(entry)) {
        // Already scheduled but its time/cron changed (a session called
        // agenda_update) — rebuild the cron job so the new time takes effect.
        this._unscheduleEntry(entry.id);
        this._scheduleEntry(entry);
        rescheduled++;
      }
    }
    // Stop jobs whose entry is gone or no longer pending.
    for (const id of [...this._jobs.keys()]) {
      const e = this._entries[id];
      if (!e || e.status !== 'pending') {
        this._unscheduleEntry(id);
        removed++;
      }
    }
    return { added, removed, rescheduled };
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
    channel.log('agenda', 'Scheduler stopped');
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
