/**
 * CLI Logger - Single-line progress updates like Claude Code CLI
 *
 * Supports an optional output provider for alternative rendering (e.g. Ink).
 * When a provider is set, output is delegated to it instead of direct ANSI.
 *
 * Usage:
 *   cliLogger.progress('Processing...') - Updates same line
 *   cliLogger.success('Done!') - New line with result
 *   cliLogger.error('Failed!') - New line with error
 *   cliLogger.log('category', 'message') - Write to log file only
 *   cliLogger.clear() - Clear current line
 *   cliLogger.print(text) - Print a line of output
 *   cliLogger.setInfo(text) - Show info line (e.g. token usage)
 *   cliLogger.printToScroll(text) - Print to scroll area
 */

import fs from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Output provider interface (all methods optional):
 *   { progress(msg), thinking(prefix), stopThinking(), clear(),
 *     thinkingSlot(slotId, prefix), clearSlot(slotId),
 *     print(text), setInfo(text), printToScroll(text) }
 */
let _provider = null;

/** Set an output provider (called from CLI bootstrap layer) */
export function setProvider(provider) {
  _provider = provider;
}

/**
 * Per-async-context slot ID for parallel agent tracking.
 * Each parallel delegate branch gets a unique slot so the UI can show
 * all active agents simultaneously instead of last-writer-wins.
 */
const _slotStorage = new AsyncLocalStorage();

/** Metadata (agentName, subject) associated with each slot ID. */
const _slotMeta = new Map();

/**
 * Run fn in a named slot context. All cliLogger.planning() / clear()
 * calls within fn (and its async descendants) will be tagged with slotId,
 * enabling the UI to show a separate thinking line per parallel branch.
 */
export function withSlot(slotId, fn) {
  return _slotStorage.run(slotId, fn);
}

/** Returns the slot ID of the current async context (undefined if not in a named slot). */
export function getCurrentSlotId() {
  return _slotStorage.getStore();
}

/**
 * Clear the spinner for a specific slot ID.
 * undefined/null = main thinking slot (stopThinking), named string = clearSlot(id).
 * Used by the delegation path to hide the parent's spinner while a child runs.
 */
export function clearSlotById(slotId) {
  if (slotId === undefined || slotId === null) {
    if (_provider?.stopThinking) _provider.stopThinking();
  } else if (_provider?.clearSlot) {
    _provider.clearSlot(slotId);
  }
}

/**
 * Associate metadata (agentName, subject) with a slot ID.
 * Call before withSlot() so that planning() can forward it to the UI.
 */
export function registerSlotMeta(slotId, meta) {
  _slotMeta.set(slotId, meta);
}

/** Remove metadata for a slot ID when the slot is done. */
export function unregisterSlotMeta(slotId) {
  _slotMeta.delete(slotId);
}

class CLILogger {
  constructor() {
    this.currentLine = '';
    this.isProgress = false;
    this.animationInterval = null;
    this.animationDots = 0;
    this.isAnimating = false; // Track if we're in animation mode
    this.animationBase = '';
    this.animationChars = null;
    this.indentStack = []; // Stack of messages showing delegation hierarchy
    this.indentLevel = 0;
    this._logStream = null;
    this._logStreamReady = false;
    this._infoSlots = {};
    this._showModel = false; // controlled by CLI bootstrap via setShowModel()
    // Intercept console methods to auto-clear progress
    this.setupConsoleIntercept();
    // Initialize log file if configured
    this._initLogFile();
  }

  /** Initialize log file stream from KOI_LOG_FILE env var */
  _initLogFile() {
    const logFile = process.env.KOI_LOG_FILE;
    if (!logFile) return;
    try {
      this._logFile = logFile;
      this._logStream = fs.createWriteStream(logFile, { flags: 'a' });
      this._logStreamReady = true;
    } catch { /* non-fatal */ }
  }

  /** Write to log file only (not visible to user) */
  _logToFile(message) {
    if (!this._logStreamReady) {
      // Lazy init in case env var was set after constructor
      if (process.env.KOI_LOG_FILE && !this._logStream) {
        this._initLogFile();
      }
      if (!this._logStreamReady) return;
    }
    const ts = new Date().toTimeString().split(' ')[0] + '.' + String(Date.now() % 1000).padStart(3, '0');
    this._logStream.write(`[${ts}] ${message}\n`);
  }

  /**
   * Write synchronously to the log file — use ONLY in crash/exit handlers
   * where the async stream may not flush before process.exit().
   */
  _logToFileSync(message) {
    const logFile = this._logFile || process.env.KOI_LOG_FILE;
    if (!logFile) return;
    try {
      const ts = new Date().toTimeString().split(' ')[0] + '.' + String(Date.now() % 1000).padStart(3, '0');
      fs.appendFileSync(logFile, `[${ts}] ${message}\n`);
    } catch { /* non-fatal */ }
  }

  /**
   * Log a categorized message to the log file (not visible to user).
   * @param {string} category - e.g. 'agent', 'llm', 'action', 'session'
   * @param {string} message - the log message
   */
  log(category, message) {
    this._logToFile(`[${category}] ${message}`);
  }

  setupConsoleIntercept() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;
    const self = this;

    console.log = function(...args) {
      self.clearProgress();
      originalLog.apply(console, args);
    };

    console.error = function(...args) {
      self.clearProgress();
      originalError.apply(console, args);
    };

    console.warn = function(...args) {
      self.clearProgress();
      originalWarn.apply(console, args);
    };

    console.info = function(...args) {
      self.clearProgress();
      originalInfo.apply(console, args);
    };
  }

  /**
   * Push a message to the delegation stack (indented)
   */
  pushIndent(message) {
    this.indentLevel++;
    const indent = '  '.repeat(this.indentLevel);
    this.indentStack.push({ message, indent, level: this.indentLevel });
    this.progress(`${indent}→ ${message}`);
  }

  /**
   * Pop the last delegation from stack and restore parent context
   */
  popIndent() {
    if (this.indentStack.length > 0) {
      this.indentStack.pop();
      this.indentLevel = Math.max(0, this.indentLevel - 1);

      // Clear and restore parent context
      this.clear();

      // Re-render parent if exists
      if (this.indentStack.length > 0) {
        const parent = this.indentStack[this.indentStack.length - 1];
        this.progress(`${parent.indent}→ ${parent.message}`);
      }
    } else {
      this.indentLevel = 0;
    }
  }

  /**
   * Clear all indentation stack
   */
  clearStack() {
    this.indentStack = [];
    this.indentLevel = 0;
    this.clear();
  }

  /**
   * Get current indent string
   */
  getIndent() {
    return '  '.repeat(this.indentLevel);
  }

  /**
   * Print a line of output. Delegates to provider if set.
   */
  print(text) {
    if (_provider?.print) {
      _provider.print(text);
    } else {
      this.clearProgress();
      process.stdout.write(`${text}\n`);
    }
  }

  /**
   * Print a line without the blank spacer that normally follows print().
   * Use for lines that belong visually to the next output (e.g. shell description before → cmd).
   */
  printCompact(text) {
    if (_provider?.printCompact) {
      _provider.printCompact(text);
    } else {
      this.clearProgress();
      process.stdout.write(`${text}\n`);
    }
  }

  /**
   * Control whether the 'model' info slot is shown in the footer.
   * Called by the CLI bootstrap layer based on user config.
   * Defaults to false (model name hidden).
   */
  setShowModel(visible) {
    this._showModel = !!visible;
    // Immediately update: if turning off, clear the slot; if turning on, no-op (slot fills on next LLM call)
    if (!this._showModel) {
      delete this._infoSlots['model'];
      const combined = Object.values(this._infoSlots).filter(Boolean).join(' · ');
      if (_provider?.setInfo) _provider.setInfo(combined);
    }
  }

  /**
   * Info store — each module writes to its own named slot.
   * The footer renders all slots joined with ' · '.
   * @example cliLogger.setInfo('tokens', '↑3.2k tokens')
   * @example cliLogger.setInfo('context', 'ctx: 2.9k long · 0 mid')
   */
  setInfo(slotOrText, text) {
    if (text !== undefined) {
      // Named slot mode: setInfo('key', 'value')
      if (slotOrText === 'model' && !this._showModel) return;

      // model and tokens always go to inline slot display (never footer).
      // The slot ID may be undefined (main agent, maps to null in UI).
      if (slotOrText === 'model' || slotOrText === 'tokens') {
        const slotId = _slotStorage.getStore();
        if (_provider?.setSlotInfo) {
          _provider.setSlotInfo(slotId, slotOrText, text || null);
        }
        return;
      }

      // All other keys go to the global footer as before.
      if (text) {
        this._infoSlots[slotOrText] = text;
      } else {
        delete this._infoSlots[slotOrText];
      }
    } else {
      // Legacy single-string mode: setInfo('full text') — goes to footer
      this._infoSlots._default = slotOrText;
    }

    // Footer: only non-model/non-tokens slots
    const combined = Object.entries(this._infoSlots)
      .filter(([k]) => k !== 'model' && k !== 'tokens')
      .map(([, v]) => v)
      .filter(Boolean)
      .join(' · ');
    if (_provider?.setInfo) {
      _provider.setInfo(combined);
    } else if (combined && process.env.KOI_DEBUG_LLM === '1') {
      process.stdout.write(`\x1b[2m${combined}\x1b[0m\n`);
    }
  }

  /**
   * Print text to scroll area. Delegates to provider if set.
   */
  printToScroll(text) {
    if (_provider?.printToScroll) {
      _provider.printToScroll(text);
    } else {
      this.clearProgress();
      process.stdout.write(`${text}\n`);
    }
  }

  /**
   * Show planning state with animated spinning stick.
   * If called within a withSlot() context, delegates to provider.thinkingSlot()
   * so each parallel agent gets its own spinner row.
   * Delegates to provider.thinking() if set (no slot context).
   */
  planning(prefix) {
    const slotId = _slotStorage.getStore();
    if (slotId !== undefined && _provider?.thinkingSlot) {
      const meta = _slotMeta.get(slotId) || {};
      _provider.thinkingSlot(slotId, prefix || 'Thinking', meta);
      this._logToFile(`[state:${slotId}] ${prefix || 'Thinking'}`);
      return;
    }
    if (_provider?.thinking) {
      _provider.thinking(prefix || 'Thinking');
      this._logToFile(`[state] ${prefix || 'Thinking'}`);
      return;
    }

    // Stop any existing animation
    this.stopAnimation();

    const baseMessage = prefix || 'Thinking';
    this.animationDots = 0;
    this.isAnimating = true;
    this.animationBase = baseMessage;
    this._logToFile(`[state] ${baseMessage}`);

    // Hide native cursor to prevent square artifact next to emojis
    process.stdout.write('\x1b[?25l');

    // Pick a random spinner set for this animation
    const spinnerSets = [
      ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
      ['❤️', '🧡', '💛', '💚', '💙', '💜', '💙', '💚', '💛', '🧡'],
      ['☀️', '☀️', '🌤', '⛅', '🌥', '🌥', '⛅', '🌤'],
      ['😐', '🙂', '😊', '😄', '😆', '😄', '😊', '🙂']
    ];
    this.animationChars = spinnerSets[Math.floor(Math.random() * spinnerSets.length)];

    // Initial render
    this.progress(`${baseMessage} ${this.animationChars[0]}`);

    // Start animation
    this.animationInterval = setInterval(() => {
      this.animationDots = (this.animationDots + 1) % this.animationChars.length;
      const spinner = this.animationChars[this.animationDots];
      this.progress(`${this.animationBase} ${spinner}`);
    }, 200);
  }

  /**
   * Stop animation if running.
   * In a slot context, clears the specific slot via provider.clearSlot().
   * Delegates to provider.stopThinking() if set (no slot context).
   */
  stopAnimation() {
    const slotId = _slotStorage.getStore();
    if (slotId !== undefined && _provider?.clearSlot) {
      _provider.clearSlot(slotId);
      return;
    }
    if (_provider?.stopThinking) {
      _provider.stopThinking();
      return;
    }

    if (this.animationInterval) {
      clearInterval(this.animationInterval);
      this.animationInterval = null;
      this.animationDots = 0;
      this.isAnimating = false;
      this.animationBase = '';
      this.animationChars = null;
      // Restore native cursor (hidden in planning() to prevent square artifact)
      process.stdout.write('\x1b[?25h');
    }
  }

  /**
   * Update the same line with progress (no newline).
   * Delegates to provider.progress() if set.
   */
  progress(message) {
    if (_provider?.progress) {
      _provider.progress(message);
      return;
    }

    // Stop animation if it's running and we're not in animation mode
    if (this.animationInterval && !this.isAnimating && !message.includes('...')) {
      this.stopAnimation();
    }

    // Always clear current line (handles parent process leftovers like "🌊 Running...")
    process.stdout.write('\r\x1b[K');

    // Write new message
    process.stdout.write(message);
    this.currentLine = message;
    this.isProgress = true;
  }

  /**
   * Complete progress and print result on new line
   */
  success(message) {
    this.clearProgress();
    console.log(message);
  }

  /**
   * Print error on new line
   */
  error(message) {
    this.clearProgress();
    console.error(message);
  }

  /**
   * Print info on new line
   */
  info(message) {
    this.clearProgress();
    console.log(message);
  }

  /**
   * Clear current progress line.
   * In a slot context, clears the specific slot via provider.clearSlot().
   * Delegates to provider.clear() if set (no slot context).
   */
  clearProgress() {
    const slotId = _slotStorage.getStore();
    if (slotId !== undefined && _provider?.clearSlot) {
      _provider.clearSlot(slotId);
      return;
    }
    if (_provider?.clear) {
      _provider.clear();
      return;
    }

    this.stopAnimation();
    if (this.isProgress) {
      process.stdout.write('\r\x1b[K');
      this.isProgress = false;
      this.currentLine = '';
    }
  }

  /**
   * Set the active question text shown in the input zone (above the InputLine).
   * Pass empty string or null to clear it.
   * Delegates to provider if set.
   */
  setQuestion(text) {
    if (_provider?.setQuestion) {
      _provider.setQuestion(text || '');
    }
    // No fallback — question display is only meaningful in Ink mode
  }

  /**
   * Set background task status text (shown on the right side of the footer).
   * Delegates to provider if set.
   */
  setTaskStatus(text) {
    if (_provider?.setTaskStatus) {
      _provider.setTaskStatus(text);
    }
    // No fallback — background task status is only visible in Ink mode
  }

  /**
   * Push the full task list to the TaskPanel UI component.
   * Delegates to provider if set.
   * @param {Array} tasks - Array of task objects from taskManager
   */
  setTaskPanel(tasks) {
    if (_provider?.setTaskPanel) {
      _provider.setTaskPanel(tasks);
    }
    // No fallback — task panel is only visible in Ink mode
  }

  /**
   * Set LSP status text (shown on the right side of the footer).
   * Delegates to provider if set.
   */
  setLspStatus(text) {
    if (_provider?.setLspStatus) {
      _provider.setLspStatus(text);
    }
    // No fallback — LSP status is only visible in Ink mode
  }

  /**
   * Just clear, no new line.
   * In a slot context, clears the specific slot via provider.clearSlot().
   * Delegates to provider.clear() if set (no slot context).
   */
  clear() {
    const slotId = _slotStorage.getStore();
    if (slotId !== undefined && _provider?.clearSlot) {
      _provider.clearSlot(slotId);
      return;
    }
    if (_provider?.clear) {
      _provider.clear();
      return;
    }

    this.stopAnimation();
    if (this.isProgress) {
      process.stdout.write('\r\x1b[K');
      this.isProgress = false;
      this.currentLine = '';
    }
  }
}

// Singleton instance
export const cliLogger = new CLILogger();
