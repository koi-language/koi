/**
 * Channel — Abstract I/O interface for agent communication.
 *
 * The runtime communicates with the outside world exclusively through a Channel.
 * Different frontends provide their own Channel implementation:
 *
 *   - TerminalChannel (koi-cli): Ink-based TUI with ANSI rendering
 *   - PipeChannel (future):      JSON over stdin/stdout for programmatic use
 *   - WebChannel (future):       WebSocket-based for browser UIs
 *
 * The DefaultChannel provides a minimal ANSI stdout fallback so the runtime
 * works standalone without any frontend.
 *
 * Usage:
 *   import { channel } from '../io/channel.js';
 *   channel.print('Hello');
 *   const answer = await channel.prompt('What is your name?');
 *   channel.log('debug', 'internal message');
 */

import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';

// ─── Channel Interface ─────────────────────────────────────────────────────

/**
 * @typedef {Object} ChannelSlotMeta
 * @property {string} agentName
 * @property {string} [subject]
 */

/**
 * @typedef {Object} SelectChoice
 * @property {string} title
 * @property {*} value
 * @property {string} [description]
 */

/**
 * @typedef {Object} FormField
 * @property {string} label
 * @property {string} [question]
 * @property {string} [hint]
 * @property {Array} [options]
 * @property {boolean} [allowFreeText]
 */

/**
 * Abstract Channel class. All methods have sensible defaults so partial
 * implementations work out of the box.
 */
class Channel {
  // ── Output ──────────────────────────────────────────────────────────────

  /** Print a line of text to the user. */
  print(text) { process.stdout.write(text + '\n'); }

  /** Print partial text without newline (streaming). */
  printStreaming(text) { process.stdout.write(text); }

  /** Finalize a streaming print with newline. */
  printStreamingEnd() { process.stdout.write('\n'); }

  /** Print without blank spacer. */
  printCompact(text) { process.stdout.write(text + '\n'); }

  /** Print to scroll area (if applicable). */
  printToScroll(text) { process.stdout.write(text + '\n'); }

  // ── Progress / Spinner ──────────────────────────────────────────────────

  /** Show progress message on same line (overwritten). */
  progress(message) { process.stderr.write(`\r\x1b[K${message}`); }

  /** Show animated thinking spinner. */
  planning(prefix) { process.stderr.write(`\r\x1b[K${prefix} ...`); }

  /** Stop animation. */
  stopAnimation() {}

  /** Show success message. */
  success(message) { process.stderr.write(`\r\x1b[K✓ ${message}\n`); }

  /** Show error message. */
  error(message) { process.stderr.write(`\r\x1b[K✗ ${message}\n`); }

  /** Show info message. */
  info(message) { process.stderr.write(`\r\x1b[K${message}\n`); }

  /** Clear current progress line. */
  clear() { process.stderr.write('\r\x1b[K'); }
  clearProgress() { this.clear(); }

  // ── Action Grouping ────────────────────────────────────────────────────
  // Default no-op stubs. TerminalChannel overrides with visual grouping.

  /** Signal the start of an action (type + detail). */
  beginAction(type, detail) { this.printCompact(`⏺ ${type}(${detail})`); }
  /** Signal the end of an action (success + detail). */
  endAction(success, detail) { this.printCompact(success ? `  ✓ ${detail || ''}` : `  ✗ ${detail || ''}`); }
  /** Reset action grouping (e.g. after user interaction). */
  resetActionGroup() {}
  /** Whether the channel has a streaming UI provider (e.g. Ink) that uses a dynamic area. */
  hasStreamingProvider() { return false; }

  /** Whether a semantic scope is currently active. */
  hasScope() { return false; }
  /** Open a semantic scope that groups subsequent actions. */
  beginScope(type, description) {}
  /** Close the current semantic scope. */
  endScope(success) {}

  // ── Input ───────────────────────────────────────────────────────────────

  /**
   * Prompt the user for text input.
   * @param {string} promptText - Question or prompt label
   * @param {Object} [options] - { secret, skipFinalRender, clearAfterSubmit, onCancel }
   * @returns {Promise<string>}
   */
  async prompt(promptText, options = {}) {
    // Minimal readline fallback
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question(promptText + ' ', (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  /**
   * Show a selection menu.
   * @param {string} message - Question
   * @param {SelectChoice[]} choices - Options to choose from
   * @param {number} [initial=0] - Initially selected index
   * @param {Object} [opts] - { filterable, inlinePrefix, initialFilter, meta }
   * @returns {Promise<*>} Selected value
   */
  async select(message, choices, initial = 0, opts = {}) {
    // Minimal: print choices and prompt for number
    this.print(message);
    choices.forEach((c, i) => this.print(`  ${i + 1}. ${c.title}`));
    const answer = await this.prompt(`Choice [1-${choices.length}]:`);
    const idx = parseInt(answer, 10) - 1;
    return choices[idx]?.value ?? choices[0]?.value;
  }

  /**
   * Show a multi-field form.
   * @param {string} title - Form title
   * @param {FormField[]} fields - Fields to fill
   * @returns {Promise<Object|null>} Map of label→value, or null if cancelled
   */
  async form(title, fields) {
    this.print(title);
    const result = {};
    for (const field of fields) {
      const answer = await this.prompt(field.question || field.label + ':');
      result[field.label] = answer;
    }
    return result;
  }

  // ── Delegation / Slot Management ────────────────────────────────────────

  /** @private Slot tracking via AsyncLocalStorage. */
  _slotStorage = new AsyncLocalStorage();
  _slotMeta = new Map();
  _indentStack = [];

  /** Push delegation context (indentation). */
  pushIndent(message) { this._indentStack.push(message); }

  /** Pop delegation context. */
  popIndent() { this._indentStack.pop(); }

  /** Clear delegation stack. */
  clearStack() { this._indentStack.length = 0; }

  /** Get current indent string. */
  getIndent() { return '  '.repeat(this._indentStack.length); }

  /** Run fn in a named slot context (for parallel agent tracking). */
  withSlot(slotId, fn) { return this._slotStorage.run(slotId, fn); }

  /** Get current slot ID. */
  getCurrentSlotId() { return this._slotStorage.getStore(); }

  /** Clear spinner for a specific slot. */
  clearSlotById(slotId) {}

  /** Register metadata for a slot. */
  registerSlotMeta(slotId, meta) { this._slotMeta.set(slotId, meta); }

  /** Unregister metadata for a slot. */
  unregisterSlotMeta(slotId) { this._slotMeta.delete(slotId); }

  /** Pre-mark a slot as background (suppresses spinner above prompt). */
  markSlotBackground(slotId) { /* override in TerminalChannel */ }

  // ── UI Zones ────────────────────────────────────────────────────────────

  /** Set info text in a named slot or footer. */
  setInfo(slotOrText, text) {}

  /** Show/hide model name in footer. */
  setShowModel(visible) {}

  /** Set active question text in input zone. */
  setQuestion(text) {}

  /** Set background task status. */
  setTaskStatus(text) {}

  /** Push full task list to UI panel. */
  setTaskPanel(tasks) {}

  /** Set LSP status indicator. */
  setLspStatus(text) {}

  // ── Input History ───────────────────────────────────────────────────────

  /** Add entry to input history. */
  addToHistory(text) {}

  /** Get input history. */
  getHistory() { return []; }

  /** Load saved history. */
  loadHistory(entries) {}

  /** Set callback for history loaded event. */
  setHistoryLoadedCallback(fn) {}

  // ── Logging ─────────────────────────────────────────────────────────────

  /** @private Log file path */
  _logFile = null;

  /**
   * Log a categorized message to file only (not visible to user).
   * @param {string} category
   * @param {string} message
   */
  log(category, message) {
    if (!this._logFile) {
      // KOI_LOG_FILE takes precedence (set by --log flag in koi-cli)
      if (process.env.KOI_LOG_FILE) {
        this._logFile = process.env.KOI_LOG_FILE;
      } else {
        const root = process.env.KOI_PROJECT_ROOT || process.cwd();
        const sessionId = process.env.KOI_SESSION_ID;
        if (sessionId) {
          this._logFile = path.join(root, '.koi', 'sessions', sessionId, 'koi.log');
        }
      }
    }
    if (this._logFile) {
      const timestamp = new Date().toISOString().slice(11, 23);
      const line = `[${timestamp}] [${category}] ${message}\n`;
      try {
        const dir = path.dirname(this._logFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(this._logFile, line);
      } catch { /* non-fatal */ }
    }
  }

  /** Sync log write (for crash handlers). */
  _logToFileSync(message) {
    this.log('crash', message);
  }

  // ── Display Helpers ─────────────────────────────────────────────────────

  /**
   * Build display text for an agent action (for progress/spinner).
   * @param {string} agentName
   * @param {Object} action - { intent, type, mcp?, tool?, input?, desc? }
   * @returns {string}
   */
  buildActionDisplay(agentName, action) {
    const name = `\x1b[1m\x1b[38;2;173;218;228m${agentName}\x1b[0m`;
    if (action?.mcp || action?.intent === 'call_mcp') {
      const tool = action.tool || action.mcp || 'mcp';
      return `🤖 ${name} 🧩 ${tool}`;
    }
    const desc = action?.desc || action?.thinkingHint || action?.intent || action?.type || 'Thinking';
    return `🤖 ${name} \x1b[38;2;185;185;185m${desc}\x1b[0m`;
  }

  // ── Rendering (pure functions, overridable) ─────────────────────────────

  /** Render a single markdown line to display format. */
  renderLine(line) { return line; }

  /** Render a markdown table to display format. */
  renderTable(lines) { return lines.join('\n'); }

  /** Render full markdown text to display format. */
  renderMarkdown(text) { return text; }

  /** Render a unified diff string to display format. */
  renderDiff(diffStr) { return diffStr; }

  /** Render content diff between old and new. */
  renderContentDiff(oldContent, newContent, filePath) { return ''; }

  /** Render a new file as all-additions diff. */
  renderNewFileDiff(content, filePath) { return content; }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _channel = new Channel();

/**
 * Get the current channel instance.
 * @returns {Channel}
 */
export function getChannel() {
  return _channel;
}

/**
 * Set the channel implementation. Called by the frontend at startup.
 * @param {Channel} impl - Channel implementation (e.g. TerminalChannel from koi-cli)
 */
export function setChannel(impl) {
  _channel = impl;
}

/**
 * Proxy object that always delegates to the current channel singleton.
 * This is what most of the runtime imports and uses.
 */
export const channel = new Proxy({}, {
  get(_, prop) {
    const val = _channel[prop];
    if (typeof val === 'function') {
      return val.bind(_channel);
    }
    return val;
  },
  set(_, prop, value) {
    _channel[prop] = value;
    return true;
  },
});

export { Channel };
