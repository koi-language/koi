/**
 * PromptZone — Persistent bottom zone with ANSI scroll regions.
 *
 * Fixed layout (always visible at terminal bottom):
 *   ───────────── (top separator)
 *   ❯ input      (prompt — always active, multi-line capable)
 *   ───────────── (bottom separator)
 *   info...       (expandable: tokens, menus — 0..N lines)
 *
 * The zone starts compact (right after existing content) and grows
 * downward as new output arrives. Once it reaches the terminal bottom,
 * normal scrolling kicks in.
 */

function getCols() {
  if (process.stdout.columns) return process.stdout.columns;
  if (process.stderr.columns) return process.stderr.columns;
  try {
    const size = process.stdout.getWindowSize?.();
    if (size?.[0]) return size[0];
  } catch {}
  return parseInt(process.env.COLUMNS) || 80;
}

class PromptZone {
  constructor() {
    this._enabled = false;
    this.rows = 0;
    this._resizeHandler = null;
    this._inputQueue = [];
    this._inputWaiters = [];
    this._listening = false;
    this._cancelFn = null;
    this._infoLines = [];
    this._inputLines = 1;
    this._agentBusy = false;
    this._abortController = null;
    this._dynamicBottom = 0;   // current scroll region bottom (grows until maxBottom)
    this._zoneRendering = false; // flag to skip stdout interception during zone render
    this._origStdoutWrite = null;
  }

  get enabled() {
    return this._enabled;
  }

  setAgentBusy(busy) {
    this._agentBusy = !!busy;
    if (busy) {
      this._abortController = new AbortController();
    }
  }

  get abortSignal() {
    return this._abortController?.signal || null;
  }

  abort() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  /** Zone height: 2 separators + input lines + info lines */
  get zoneHeight() {
    return 2 + this._inputLines + this._infoLines.length;
  }

  /** Maximum scroll bottom (when zone is fully at the terminal bottom) */
  get maxBottom() {
    return this.rows - this.zoneHeight;
  }

  /** Current scroll region bottom — starts small, grows to maxBottom */
  get scrollBottom() {
    if (this._dynamicBottom > 0) {
      return Math.min(this._dynamicBottom, this.maxBottom);
    }
    return this.maxBottom;
  }

  /** First row where input starts (after top separator) */
  get inputStartRow() {
    return this.scrollBottom + 2;
  }

  /**
   * Query current cursor row via DSR (Device Status Report).
   */
  _queryCursorRow() {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (!wasRaw) stdin.setRawMode(true);
      stdin.resume();

      let resolved = false;
      let buf = '';
      const onData = (data) => {
        buf += data.toString();
        const match = buf.match(/\x1b\[(\d+);(\d+)R/);
        if (match && !resolved) {
          resolved = true;
          stdin.removeListener('data', onData);
          if (!wasRaw) stdin.setRawMode(false);
          stdin.pause();
          resolve(parseInt(match[1]));
        }
      };
      stdin.on('data', onData);
      process.stdout.write('\x1b[6n');

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          stdin.removeListener('data', onData);
          if (!wasRaw) stdin.setRawMode(false);
          stdin.pause();
          resolve(this.rows);
        }
      }, 200);
    });
  }

  /**
   * Expand the scroll region by N lines (zone moves down).
   * Does nothing if already at maximum (zone at terminal bottom).
   */
  /**
   * Snap the zone to the terminal bottom on first content output.
   * One-time transition: compact → full. No gradual expansion.
   */
  _snapToBottom() {
    if (this._dynamicBottom >= this.maxBottom) return;
    const prev = this._dynamicBottom;
    this._dynamicBottom = this.maxBottom;
    const w = this._origStdoutWrite;

    // Clear the OLD zone rows (separators, input, info left behind)
    w.call(process.stdout, '\x1b7');
    const oldZoneStart = prev + 1;
    const oldZoneEnd = prev + this.zoneHeight;
    for (let row = oldZoneStart; row <= Math.min(oldZoneEnd, this.rows); row++) {
      w.call(process.stdout, `\x1b[${row};1H\x1b[K`);
    }
    w.call(process.stdout, '\x1b8');

    // Set full scroll region and render zone at the bottom
    w.call(process.stdout, `\x1b[1;${this.scrollBottom}r`);
    this._zoneRendering = true;
    this._render();
    this._zoneRendering = false;
  }

  /**
   * Enable: render zone right after current content, set scroll region.
   * Does NOT clear the screen — existing terminal content stays visible.
   */
  async enable() {
    if (this._enabled) return;
    this._enabled = true;
    this.rows = process.stdout.rows || process.stderr.rows || 24;
    this._infoLines = ['↑0 ↓0'];

    // Find where the cursor is (after startup messages)
    const cursorRow = await this._queryCursorRow();

    // Start with the scroll region ending at the cursor row.
    // The zone will render right below the cursor.
    this._dynamicBottom = Math.min(cursorRow, this.maxBottom);

    // Make sure there's room below for the zone
    const roomBelow = this.rows - this._dynamicBottom;
    if (roomBelow < this.zoneHeight) {
      const pushUp = this.zoneHeight - roomBelow;
      process.stdout.write('\n'.repeat(pushUp));
      // Cursor moved down, but we clamp dynamicBottom
      this._dynamicBottom = this.maxBottom;
    }

    // Set scroll region
    process.stdout.write(`\x1b[1;${this.scrollBottom}r`);

    // Position cursor at the scroll bottom (where content will appear)
    process.stdout.write(`\x1b[${this.scrollBottom};1H`);

    // Render zone right below
    this._render();

    // Intercept stdout.write: snap zone to bottom on first content output.
    this._origStdoutWrite = process.stdout.write.bind(process.stdout);
    const self = this;
    process.stdout.write = function(chunk, encoding, callback) {
      // On first external write with newlines, snap zone to terminal bottom
      if (!self._zoneRendering && self._dynamicBottom < self.maxBottom) {
        const str = typeof chunk === 'string' ? chunk : '';
        if (str.includes('\n')) {
          self._snapToBottom();
        }
      }
      return self._origStdoutWrite.call(process.stdout, chunk, encoding, callback);
    };

    // Handle resize
    this._resizeHandler = () => {
      const newRows = process.stdout.rows || process.stderr.rows || 24;
      if (newRows !== this.rows) {
        this.rows = newRows;
        // Clamp dynamicBottom to new maxBottom
        if (this._dynamicBottom > this.maxBottom) {
          this._dynamicBottom = this.maxBottom;
        }
        this._origStdoutWrite.call(process.stdout, `\x1b[1;${this.scrollBottom}r`);
        this._zoneRendering = true;
        this._render();
        this._zoneRendering = false;
      }
    };
    process.stdout.on('resize', this._resizeHandler);

    // Restore terminal on exit
    process.on('exit', () => {
      process.stdout.write = this._origStdoutWrite || process.stdout.write;
      process.stdout.write('\x1b[r');
      process.stdout.write('\x1b[?25h');
    });

    // Start persistent input
    this._startListening();
  }

  /**
   * Update the info lines below the bottom separator.
   */
  setInfo(lines) {
    const oldHeight = this.zoneHeight;
    this._infoLines = Array.isArray(lines) ? lines : (lines ? [lines] : []);
    if (!this._enabled) return;

    if (this.zoneHeight !== oldHeight) {
      const w = this._origStdoutWrite || process.stdout.write.bind(process.stdout);
      w.call(process.stdout, `\x1b[1;${this.scrollBottom}r`);
    }
    this._zoneRendering = true;
    this._render();
    this._zoneRendering = false;
  }

  /**
   * Render the entire zone (separators + input placeholder + info).
   * Uses _origStdoutWrite to bypass the interception.
   */
  _render() {
    if (!this._enabled) return;
    const w = this._origStdoutWrite || process.stdout.write.bind(process.stdout);
    const cols = getCols();
    const sep = `\x1b[2m${'─'.repeat(cols)}\x1b[0m`;
    const topSepRow = this.scrollBottom + 1;
    const bottomSepRow = topSepRow + 1 + this._inputLines;

    w.call(process.stdout, '\x1b7'); // save cursor

    // Top separator
    w.call(process.stdout, `\x1b[${topSepRow};1H\x1b[K${sep}`);

    // Input line(s) — only render ❯ if cliInput is NOT active
    if (!this._listening) {
      w.call(process.stdout, `\x1b[${topSepRow + 1};1H\x1b[K\x1b[1m❯ \x1b[0m`);
      for (let r = 1; r < this._inputLines; r++) {
        w.call(process.stdout, `\x1b[${topSepRow + 1 + r};1H\x1b[K`);
      }
    }

    // Bottom separator
    w.call(process.stdout, `\x1b[${bottomSepRow};1H\x1b[K${sep}`);

    // Info lines
    for (let i = 0; i < this._infoLines.length; i++) {
      const row = bottomSepRow + 1 + i;
      const line = this._infoLines[i];
      const truncated = line.length > cols ? line.substring(0, cols) : line;
      w.call(process.stdout, `\x1b[${row};1H\x1b[K\x1b[2m${truncated}\x1b[0m`);
    }

    // Clear leftover rows below
    const lastUsedRow = bottomSepRow + this._infoLines.length;
    for (let row = lastUsedRow + 1; row <= this.rows; row++) {
      w.call(process.stdout, `\x1b[${row};1H\x1b[K`);
    }

    w.call(process.stdout, '\x1b8'); // restore cursor
  }

  /**
   * Persistent cliInput loop on the input row(s).
   */
  async _startListening() {
    if (this._listening || !this._enabled) return;
    this._listening = true;

    const { cliInput } = await import('./cli-input.js');

    const self = this;
    while (this._enabled) {
      const zone = {
        // Dynamic getter: always returns the current row, even after _snapToBottom
        get startRow() { return self.inputStartRow; },
        set startRow(_v) { /* computed — ignore external sets */ },
        onHeightChange: (newHeight) => {
          if (newHeight === this._inputLines) return;
          this._inputLines = newHeight;
          const w = this._origStdoutWrite || process.stdout.write.bind(process.stdout);
          w.call(process.stdout, `\x1b[1;${this.scrollBottom}r`);
          this._zoneRendering = true;
          this._render();
          this._zoneRendering = false;
        }
      };

      const answer = await cliInput('❯ ', {
        skipFinalRender: true,
        zone,
        onCancel: (cancelFn) => { this._cancelFn = cancelFn; }
      });

      this._cancelFn = null;

      // Reset input lines to 1 after submit
      if (this._inputLines !== 1) {
        this._inputLines = 1;
        const w = this._origStdoutWrite || process.stdout.write.bind(process.stdout);
        w.call(process.stdout, `\x1b[1;${this.scrollBottom}r`);
        this._zoneRendering = true;
        this._render();
        this._zoneRendering = false;
      }

      // null = cancelled (paused for cliSelect etc.)
      if (answer === null) {
        this._listening = false;
        return;
      }

      // Ctrl+C / Escape — empty string
      if (answer === '') {
        if (this._agentBusy) {
          this.abort();
          this.printToScroll('\x1b[33mCancelled\x1b[0m');
          this._zoneRendering = true;
          this._render();
          this._zoneRendering = false;
          continue;
        } else {
          this.disable();
          process.stdout.write('\n');
          process.exit(0);
        }
      }

      // Print submitted text in scroll region
      const w = this._origStdoutWrite || process.stdout.write.bind(process.stdout);
      w.call(process.stdout, '\x1b7');
      w.call(process.stdout, `\x1b[${this.scrollBottom};1H`);
      if (this._agentBusy) {
        w.call(process.stdout, `\n\x1b[2m❯ ${answer}\x1b[0m`);
      } else {
        w.call(process.stdout, `\n\x1b[1m❯ \x1b[0m\x1b[36m${answer}\x1b[0m`);
      }
      w.call(process.stdout, '\x1b8');

      // Deliver to waiter or queue
      if (this._inputWaiters.length > 0) {
        const waiter = this._inputWaiters.shift();
        waiter(answer);
      } else {
        this._inputQueue.push(answer);
      }
    }

    this._listening = false;
  }

  /**
   * Wait for user input (used by prompt_user).
   */
  async waitForInput() {
    if (this._inputQueue.length > 0) {
      return this._inputQueue.shift();
    }
    return new Promise(resolve => {
      this._inputWaiters.push(resolve);
    });
  }

  /** Pause the persistent input (for cliSelect / permission prompts). */
  pauseInput() {
    if (this._cancelFn) this._cancelFn();
  }

  /** Resume the persistent input after a pause. */
  resumeInput() {
    if (!this._listening && this._enabled) this._startListening();
  }

  /**
   * Print a line into the scroll area (scrolls existing content up).
   */
  printToScroll(text) {
    if (!this._enabled) return;
    const w = this._origStdoutWrite || process.stdout.write.bind(process.stdout);
    w.call(process.stdout, '\x1b7');
    w.call(process.stdout, `\x1b[${this.scrollBottom};1H`);
    w.call(process.stdout, `\n${text}`);
    w.call(process.stdout, '\x1b8');
  }

  /**
   * Show an interactive menu in the info zone (below bottom separator).
   */
  async showMenuInInfoZone(options) {
    if (!this._enabled) return null;

    const readline = (await import('readline')).default;

    this.pauseInput();

    const MAX_VISIBLE = 6;
    let selected = 0;
    let scrollOffset = 0;
    const savedInfoLines = [...this._infoLines];

    const renderMenu = () => {
      const visible = options.slice(scrollOffset, scrollOffset + MAX_VISIBLE);
      const lines = [];

      if (scrollOffset > 0) {
        lines.push('\x1b[2m  ↑ more\x1b[0m');
      }

      for (let i = 0; i < visible.length; i++) {
        const idx = scrollOffset + i;
        const opt = visible[i];
        const desc = opt.description ? `  \x1b[2m${opt.description}\x1b[0m` : '';
        if (idx === selected) {
          lines.push(`\x1b[36m❯ ${opt.title}${desc}\x1b[0m`);
        } else {
          lines.push(`  ${opt.title}${desc}`);
        }
      }

      if (scrollOffset + MAX_VISIBLE < options.length) {
        lines.push('\x1b[2m  ↓ more\x1b[0m');
      }

      this._infoLines = lines;
      const w = this._origStdoutWrite || process.stdout.write.bind(process.stdout);
      w.call(process.stdout, `\x1b[1;${this.scrollBottom}r`);
      this._zoneRendering = true;
      this._render();
      this._zoneRendering = false;
    };

    return new Promise((resolve) => {
      const stdin = process.stdin;

      if (!stdin._keypressEventsEmitting) {
        readline.emitKeypressEvents(stdin);
        stdin._keypressEventsEmitting = true;
      }
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();

      const cleanup = () => {
        stdin.removeListener('keypress', onKey);
        stdin.setRawMode(wasRaw);
        this._infoLines = savedInfoLines;
        const w = this._origStdoutWrite || process.stdout.write.bind(process.stdout);
        w.call(process.stdout, `\x1b[1;${this.scrollBottom}r`);
        this._zoneRendering = true;
        this._render();
        this._zoneRendering = false;
        this.resumeInput();
      };

      const onKey = (str, key) => {
        if (!key) return;
        if (key.name === 'up') {
          selected = Math.max(0, selected - 1);
          if (selected < scrollOffset) scrollOffset = selected;
          renderMenu();
        } else if (key.name === 'down') {
          selected = Math.min(options.length - 1, selected + 1);
          if (selected >= scrollOffset + MAX_VISIBLE) scrollOffset = selected - MAX_VISIBLE + 1;
          renderMenu();
        } else if (key.name === 'return') {
          cleanup();
          resolve(options[selected]?.value ?? null);
        } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          cleanup();
          resolve(null);
        }
      };

      stdin.on('keypress', onKey);
      renderMenu();
    });
  }

  /** Disable: restore full scroll region, clear zone. */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this.pauseInput();

    // Restore original stdout.write
    if (this._origStdoutWrite) {
      process.stdout.write = this._origStdoutWrite;
      this._origStdoutWrite = null;
    }

    process.stdout.write('\x1b[r');
    for (let row = this.scrollBottom + 1; row <= this.rows; row++) {
      process.stdout.write(`\x1b[${row};1H\x1b[K`);
    }
    process.stdout.write(`\x1b[${this.scrollBottom};1H`);
    if (this._resizeHandler) {
      process.stdout.removeListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
  }
}

// Singleton
export const promptZone = new PromptZone();
export const statusBar = promptZone;
