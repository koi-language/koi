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

  /**
   * Present a resource to the user (open/preview it). No-op in plain CLI.
   * @param {Object} spec - { type: 'file'|'url'|'image'|'video', path?, url?, title? }
   */
  presentResource(spec) { /* no-op in non-UI channels */ }
  /** Whether this channel can present resources (open files/URLs visually). */
  canPresentResources() { return false; }

  // ── Action Grouping ────────────────────────────────────────────────────
  // Default no-op stubs. TerminalChannel overrides with visual grouping.

  /** Signal the start of an action (type + detail). */
  beginAction(type, detail, description) { this.printCompact(`⏺ ${type}(${detail})`); }
  /** Signal the end of an action (success + detail). */
  endAction(success, detail) { this.printCompact(success ? `  ✓ ${detail || ''}` : `  ✗ ${detail || ''}`); }
  /** Reset action grouping (e.g. after user interaction). */
  resetActionGroup() {}

  // ── Live agent / skill activity ────────────────────────────────────────
  // Broadcast when an agent enters its reactive loop, leaves it, or
  // (de)activates a skill. Rich UIs (Flutter GUI) use these to render
  // a live footer showing who is currently working and with what. CLIs
  // default to no-op — the info is surfaced via logs.

  /** Agent just entered its reactive loop. */
  agentStarted(info) {}
  /** Agent just exited its reactive loop. */
  agentEnded(info) {}
  /** Agent activated a skill (loaded it into its active context). */
  skillActivated(info) {}
  /** Agent deactivated a skill. */
  skillDeactivated(info) {}

  // ── AI clip generation ──────────────────────────────────────────────────
  // Fire-and-forget broadcast emitted by the `assign_generated_media_to_clip`
  // tool when a generation lands on a timeline clip. The GUI's timeline tab
  // listens for this on the WS channel, looks up the clip by id, and swaps
  // its placeholder for the rendered media (clearing the diagonal-stripes
  // overlay and updating its `aiState.lastRenderedPath`). Terminal channels
  // can leave the no-op default in place.
  /**
   * @param {{ clipId: string, mediaPath?: string|null, error?: string|null,
   *           chatId?: string|null }} info
   */
  clipMediaGenerated(info) {}

  /**
   * "Still generating" heartbeat — fires every few seconds while a
   * long-running media job is being polled. The GUI uses this to keep
   * its per-clip orphan watchdog alive past its 5 min default ceiling
   * when the engine is genuinely still working. WS channel implements
   * this with a real send; terminal channels leave the no-op default.
   *
   * @param {{ clipId: string, status?: string }} info
   */
  clipMediaGenerating(info) {}

  // ── Media tool progress (generate_image/video/audio …) ──────────────────
  // UI hooks the GUI uses to show a "generating…" card with a live status and
  // then resolve it. Headless/minimal channels (terminal, Telegram) leave these
  // as no-ops — calling an UNDEFINED method here used to throw
  // "channel.mediaToolStart is not a function" and crash the whole turn.
  mediaToolStart(info) { return null; }
  mediaToolStatus(info) {}
  mediaToolEnd(info) {}

  // ── Workflow lifecycle ─────────────────────────────────────────────────
  // `workflowActivating` fires BEFORE any tasks are created, giving the
  // GUI a chance to show a banner with a countdown and let the user
  // cancel. `waitForActivationDecision(activationId, timeoutMs)` resolves
  // with `'confirm' | 'cancel' | 'timeout'` once the user acts or the
  // window elapses. `workflowActivated` and `workflowDeactivated` are
  // fire-and-forget lifecycle broadcasts consumed by the footer chip.
  /** Announce an imminent workflow activation to the UI. */
  workflowActivating(info) {}
  /** Announce that the workflow has been activated (tasks created). */
  workflowActivated(info) {}
  /** Announce that the workflow has been deactivated (tasks drained). */
  workflowDeactivated(info) {}
  /**
   * Wait for the user's response to a `workflowActivating` banner.
   * Channels that don't support UI confirmation should fall through to
   * `'timeout'` after the window elapses.
   * @param {string} activationId
   * @param {number} timeoutMs
   * @returns {Promise<'confirm'|'cancel'|'timeout'>}
   */
  async waitForActivationDecision(activationId, timeoutMs) {
    if (timeoutMs > 0) {
      await new Promise(r => setTimeout(r, timeoutMs));
    }
    return 'timeout';
  }
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

  /**
   * Ask the user to attach one or more files. Sibling to [form] — the
   * CLI / GUI layers override this with a richer inline picker (drop
   * zone + Browse button). This fallback is a plain prompt that takes
   * comma-separated paths so the action still works in non-interactive
   * contexts and on a bare terminal.
   * @param {{title?:string, question?:string, hint?:string, multiple?:boolean, extensions?:string[]}} opts
   * @returns {Promise<string[]|null>} Absolute paths, or null if cancelled.
   */
  async files(opts) {
    const question = opts?.question || 'Please attach the files you want to share.';
    this.print(question);
    if (opts?.hint) this.print(opts.hint);
    const answer = await this.prompt('Path(s) (comma-separated, blank to cancel): ');
    if (!answer || !String(answer).trim()) return null;
    return String(answer)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
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

  // ── Structured UI Blocks (for GUI frontends) ────────────────────────────
  //
  // These methods emit structured payloads instead of pre-rendered text.
  // The base/terminal implementation formats them to ANSI and prints via
  // `print()`. GUI channels (e.g. WsChannel) override these to send JSON
  // messages that the client renders natively (DiffBlock, CommandBlock…).
  //
  // By sending structured data the transport layer — not regex on the
  // client — determines how content is rendered.

  /**
   * Show a diff block.
   * @param {{filePath:string,label:string,added:number,removed:number,lines:Array}} payload
   */
  async showDiff(payload) {
    if (!payload) return;
    const { renderPayloadToTerminal } = await import('../util/diff-render.js');
    const text = renderPayloadToTerminal(payload);
    if (text) this.print(`\n${text}\n`);
  }

  /**
   * Show a shell command + its output as a terminal-style block.
   * @param {{command:string,output?:string,exitCode?:number}} payload
   */
  showCommand(payload) {
    if (!payload || !payload.command) return;
    const dim = '\x1b[2m', reset = '\x1b[0m', bold = '\x1b[1m';
    const out = [`${bold}$ ${payload.command}${reset}`];
    if (payload.output) {
      for (const line of String(payload.output).split('\n')) {
        out.push(`${dim}  ${line}${reset}`);
      }
    }
    this.print(out.join('\n'));
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _channel = new Channel();

/**
 * Per-async-context channel override. When a piece of work runs inside
 * `runWithChannel(impl, fn)`, every `getChannel()` / `channel.*` access made
 * within that async context (and anything it awaits) resolves to `impl`
 * instead of the process-wide `_channel`.
 *
 * This is what lets a single process host SEVERAL independent sessions at
 * once without their output crossing wires — e.g. the GUI engine talking
 * over its WsChannel while the agenda daemon drives one headless Telegram
 * session per working directory, each bound to its own TelegramChannel and
 * each running inside its own `runWithChannel(...)` scope. Without this, the
 * last `setChannel()` would win and every session's output would funnel into
 * a single channel.
 *
 * @private
 */
const _channelStorage = new AsyncLocalStorage();

/** @private Resolve the channel active for the current async context. */
function _activeChannel() {
  return _channelStorage.getStore() ?? _channel;
}

/**
 * Get the current channel instance — the per-context override if one is
 * active, otherwise the process-wide channel.
 * @returns {Channel}
 */
export function getChannel() {
  return _activeChannel();
}

/**
 * Set the process-wide channel implementation. Called by the frontend at
 * startup. Does NOT affect work already running inside `runWithChannel`.
 * @param {Channel} impl - Channel implementation (e.g. TerminalChannel from koi-cli)
 */
export function setChannel(impl) {
  _channel = impl;
}

/**
 * Run `fn` with `impl` bound as the active channel for the current async
 * context. Any `getChannel()` / `channel.*` access made while `fn` (and
 * anything it awaits) runs resolves to `impl`. The override is automatically
 * torn down when `fn` settles, restoring whatever channel was active before.
 *
 * @template T
 * @param {Channel} impl - Channel to bind for this scope.
 * @param {() => T} fn - Work to run under the bound channel.
 * @returns {T}
 */
export function runWithChannel(impl, fn) {
  return _channelStorage.run(impl, fn);
}

/**
 * Proxy object that always delegates to the channel active for the current
 * async context. This is what most of the runtime imports and uses.
 */
export const channel = new Proxy({}, {
  get(_, prop) {
    const active = _activeChannel();
    const val = active[prop];
    if (typeof val === 'function') {
      return val.bind(active);
    }
    return val;
  },
  set(_, prop, value) {
    _activeChannel()[prop] = value;
    return true;
  },
});

export { Channel };
