/**
 * Work Queue — Agent's internal task queue.
 *
 * Singleton that manages the agent's internal TODO list of user requests.
 * Each item uses the same Task object format as the task-manager (subject,
 * description, status, etc.) but lives in a separate container.
 *
 * The queue represents WHAT the user has asked for. The task list (task-manager)
 * represents HOW the work is broken down for delegation. The agenda represents
 * WHEN time-scheduled items should fire.
 *
 * Same Task object, three containers:
 *   - Queue (cola):     Agent's internal backlog of user requests
 *   - Task List:        Work breakdown delegated to sub-agents
 *   - Agenda:           Time-triggered scheduled items
 *
 * Features:
 *   - In-memory with session-level disk persistence
 *   - Same Task object format as task-manager.js
 *   - Description can be updated in real-time (agent discovers info / user feedback)
 *   - Feedback classification: relate new user input to existing queue items
 *
 * Usage:
 *   workQueue.add({ subject, description })
 *   workQueue.get(id)
 *   workQueue.update(id, { subject?, description?, status? })
 *   workQueue.list({ status? })
 *   workQueue.getActive()
 *   workQueue.getSummary()
 */

import fs from 'fs';
import path from 'path';
import { cliLogger } from './cli-logger.js';

const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'deleted'];

class WorkQueue {
  constructor() {
    this._items = {};
    this._nextId = 1;
    this._filePath = null;
    this._loaded = false;
  }

  _getFilePath() {
    if (!this._filePath) {
      const root = process.env.KOI_PROJECT_ROOT || process.cwd();
      const sessionId = process.env.KOI_SESSION_ID;
      if (sessionId) {
        this._filePath = path.join(root, '.koi', 'sessions', sessionId, 'queue.json');
      } else {
        this._filePath = path.join(root, '.koi', 'queue.json');
      }
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
      if (data && data.items) {
        this._items = data.items;
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
        items: this._items,
      }, null, 2));
    } catch {
      // Non-fatal
    }
  }

  /**
   * Add a new item to the work queue.
   * Uses the same Task object format as task-manager.
   *
   * @param {Object} opts
   * @param {string} opts.subject - Short title of what the user asked for
   * @param {string} [opts.description] - Detailed description (can be updated later)
   * @param {string} [opts.owner] - Agent that owns this item
   * @returns {Object} The created queue item (Task format)
   */
  add({ subject, description, owner } = {}) {
    this._loadIfNeeded();
    if (!subject) throw new Error('queue_add: "subject" is required');

    const id = String(this._nextId++);
    const now = new Date().toISOString();

    const item = {
      id,
      subject,
      description: description || '',
      status: 'pending',
      owner: owner || null,
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
    };

    this._items[id] = item;
    this._save();

    cliLogger.log('queue', `[+] #${id}: "${subject}"`);

    return { ...item };
  }

  /**
   * Get a queue item by ID.
   * @returns {Object|null} Task-format item or null
   */
  get(id) {
    this._loadIfNeeded();
    const item = this._items[String(id)];
    return item ? { ...item } : null;
  }

  /**
   * Update a queue item. Supports updating subject, description, status, owner.
   * Description updates are additive by default — new info is appended
   * unless `replaceDescription` is true.
   *
   * @param {string} id - Queue item ID
   * @param {Object} updates
   * @param {string} [updates.subject] - New title
   * @param {string} [updates.description] - New/additional description
   * @param {string} [updates.status] - New status
   * @param {string} [updates.owner] - New owner
   * @param {boolean} [updates.replaceDescription] - If true, replace description entirely
   * @param {string} [updates.feedback] - Append user feedback to description
   * @returns {Object} Updated item (Task format)
   */
  update(id, updates = {}) {
    this._loadIfNeeded();
    const strId = String(id);
    const item = this._items[strId];
    if (!item) throw new Error(`Queue item ${strId} not found`);

    if (updates.subject !== undefined) item.subject = updates.subject;

    if (updates.description !== undefined) {
      if (updates.replaceDescription) {
        item.description = updates.description;
      } else {
        // Append new description info
        if (item.description) {
          item.description = item.description + '\n\n' + updates.description;
        } else {
          item.description = updates.description;
        }
      }
    }

    if (updates.feedback !== undefined && updates.feedback) {
      // Append feedback as a clearly marked section
      const timestamp = new Date().toLocaleTimeString();
      const feedbackBlock = `\n\n[User feedback @ ${timestamp}]: ${updates.feedback}`;
      item.description = (item.description || '') + feedbackBlock;
    }

    if (updates.status !== undefined) {
      if (!VALID_STATUSES.includes(updates.status)) {
        throw new Error(`Invalid status "${updates.status}". Valid: ${VALID_STATUSES.join(', ')}`);
      }
      item.status = updates.status;
    }

    if (updates.owner !== undefined) item.owner = updates.owner;

    item.updatedAt = new Date().toISOString();
    this._items[strId] = item;
    this._save();

    cliLogger.log('queue', `[~] #${strId}: "${item.subject}" (${item.status})`);

    return { ...item };
  }

  /**
   * List queue items with optional status filter.
   * Excludes deleted items by default.
   *
   * @param {Object} [filters]
   * @param {string} [filters.status] - Filter by status
   * @returns {Object[]} Array of Task-format items
   */
  list(filters = {}) {
    this._loadIfNeeded();
    let items = Object.values(this._items);

    // Exclude deleted by default
    if (!filters.status) {
      items = items.filter(i => i.status !== 'deleted');
    }

    if (filters.status) {
      items = items.filter(i => i.status === filters.status);
    }

    // Sort by creation time (oldest first = FIFO queue)
    items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    return items.map(i => ({ ...i }));
  }

  /**
   * Get the currently active (in_progress) queue items.
   * @returns {Object[]} Active items
   */
  getActive() {
    return this.list({ status: 'in_progress' });
  }

  /**
   * Get a summary of the queue state for prompt injection.
   * Returns a formatted string or null if queue is empty.
   */
  getSummary() {
    const items = this.list();
    if (items.length === 0) return null;

    const pending = items.filter(i => i.status === 'pending');
    const active = items.filter(i => i.status === 'in_progress');
    const completed = items.filter(i => i.status === 'completed');

    let summary = `## Work Queue (${items.length} items)\n`;
    summary += `| Status | Count |\n|--------|-------|\n`;
    summary += `| Pending | ${pending.length} |\n`;
    summary += `| In progress | ${active.length} |\n`;
    summary += `| Completed | ${completed.length} |\n\n`;

    const showItems = [...active, ...pending];
    if (showItems.length > 0) {
      summary += '### Active & Pending Items\n';
      for (const item of showItems) {
        const statusIcon = item.status === 'in_progress' ? '●' : '☐';
        summary += `- ${statusIcon} **#${item.id}**: ${item.subject}\n`;
        if (item.description) {
          // Show first 200 chars of description
          const desc = item.description.length > 200
            ? item.description.slice(0, 200) + '...'
            : item.description;
          summary += `  ${desc}\n`;
        }
      }
    }

    return summary;
  }

  /**
   * Reset the queue (clear all items).
   */
  reset() {
    this._items = {};
    this._nextId = 1;
    this._loaded = true;
    const fp = this._getFilePath();
    if (fs.existsSync(fp)) {
      try { fs.unlinkSync(fp); } catch { /* non-fatal */ }
    }
  }
}

/** Singleton work queue instance */
export const workQueue = new WorkQueue();
