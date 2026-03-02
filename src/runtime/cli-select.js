/**
 * CLI Select - Simple interactive select menu using raw ANSI codes.
 *
 * Replaces the `prompts` library's select component to avoid
 * interference with cli-logger's console intercept.
 *
 * Uses process.stdout.write exclusively — no console.log/error calls.
 * Redraws line-by-line (no full-screen clear) to avoid flicker.
 */

import readline from 'readline';

// Injectable provider: when set, cliSelect delegates to this function instead
// of using the built-in raw-mode keypress menu. Set by the CLI bootstrap layer.
// Signature: fn(message, choices, initial, opts) → Promise<value>
let _selectProvider = null;

/** Set a select provider that overrides the default keypress menu. */
export function setSelectProvider(fn) {
  _selectProvider = fn;
}

/**
 * Show an interactive select menu.
 * @param {string} message - The question/prompt to display
 * @param {Array<{title: string, value: any, description?: string}>} choices
 * @param {number} [initial=0] - Initially selected index
 * @returns {Promise<any>} The selected choice's value, or undefined if cancelled
 */
export function cliSelect(message, choices, initial = 0, opts = {}) {
  const { filterable = false, inlinePrefix = '', initialFilter = '' } = opts;
  // If a select provider is set (e.g. Ink), delegate to it — pass full opts so
  // callers can attach metadata (e.g. { meta: { type: 'bash', command, warning } })
  if (_selectProvider) {
    return _selectProvider(message, choices, initial, opts);
  }

  return new Promise((resolve) => {
    let selected = initial;
    const stdout = process.stdout;
    const stdin = process.stdin;
    let firstRender = true;
    let lastRenderedLines = 0;

    // Filter state (only when filterable=true)
    let filterText = initialFilter;
    let filtered = [...choices];

    // Blinking cursor state (for filterable mode)
    let cursorVisible = true;
    let blinkInterval = null;
    let lastKeypressTime = 0;

    function getVisible() {
      return filterable ? filtered : choices;
    }

    function applyFilter() {
      if (!filterText) {
        filtered = [...choices];
      } else {
        const q = filterText.toLowerCase();
        // For description matching, strip leading "/" so "/his" matches "Browse session history"
        const qDesc = q.startsWith('/') ? q.substring(1) : q;
        filtered = choices.filter(c =>
          c.title.toLowerCase().includes(q) ||
          (qDesc && c.description && c.description.toLowerCase().includes(qDesc))
        );
      }
      // Keep selected in bounds
      if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
    }

    /**
     * Calculate how many terminal rows a string occupies (accounting for wrap).
     */
    function terminalLines(text) {
      const cols = stdout.columns || 80;
      if (!text || text.length === 0) return 1;
      // Strip ANSI escape codes for length calculation
      const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
      return Math.max(1, Math.ceil(plain.length / cols));
    }

    function render() {
      const visible = getVisible();

      // On re-render, move cursor up to start of menu area and clear
      if (!firstRender && lastRenderedLines > 0) {
        stdout.write(`\x1b[${lastRenderedLines}A`);
        stdout.write('\x1b[J');
      }

      let totalLines = 0;

      // Blinking underscore cursor (only in filterable mode)
      const cursorChar = filterable ? (cursorVisible ? '\x1b[4;36m \x1b[24m\x1b[0m' : ' ') : '';

      // Header line
      let headerText;
      if (inlinePrefix) {
        headerText = `${inlinePrefix}${filterText} `;
        stdout.write(`\x1b[2K\x1b[1m${inlinePrefix}\x1b[0m\x1b[36m${filterText}${cursorChar}\x1b[0m\n`);
      } else if (filterable && filterText) {
        headerText = `? ${message} ${filterText} `;
        stdout.write(`\x1b[2K? \x1b[1m${message}\x1b[0m \x1b[36m${filterText}${cursorChar}\x1b[0m\n`);
      } else {
        if (filterable) {
          const hint = '› Type to filter, arrows to navigate.';
          headerText = `? ${message} ${hint}`;
          stdout.write(`\x1b[2K? \x1b[1m${message}\x1b[0m \x1b[2m${hint}\x1b[0m${cursorChar}\n`);
        } else {
          const hint = '› Use arrow-keys. Return to submit.';
          headerText = `? ${message} ${hint}`;
          stdout.write(`\x1b[2K? \x1b[1m${message}\x1b[0m \x1b[2m${hint}\x1b[0m\n`);
        }
      }
      totalLines += terminalLines(headerText);

      // Choices
      for (let i = 0; i < visible.length; i++) {
        const choice = visible[i];
        const desc = choice.description ? ` - ${choice.description}` : '';
        const lineText = `    ${choice.title}${desc}`;

        if (i === selected) {
          stdout.write(`\x1b[2K\x1b[36m❯   ${choice.title}${desc ? ` \x1b[2m- ${choice.description}\x1b[0m` : ''}\x1b[0m\n`);
        } else {
          stdout.write(`\x1b[2K    ${choice.title}${choice.description ? ` \x1b[2m- ${choice.description}\x1b[0m` : ''}\n`);
        }
        totalLines += terminalLines(lineText);
      }

      lastRenderedLines = totalLines;
      firstRender = false;
    }

    // Enable raw mode for keypress detection
    if (!stdin._keypressEventsEmitting) {
      readline.emitKeypressEvents(stdin);
      stdin._keypressEventsEmitting = true;
    }
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    // Hide cursor
    stdout.write('\x1b[?25l');

    // Apply initial filter if set
    if (initialFilter) {
      applyFilter();
    }

    // Start blink interval for filterable mode
    if (filterable) {
      blinkInterval = setInterval(() => {
        if (Date.now() - lastKeypressTime < 100) return;
        cursorVisible = !cursorVisible;
        render();
      }, 500);
    }

    function resetBlink() {
      cursorVisible = true;
      lastKeypressTime = Date.now();
      if (blinkInterval) clearInterval(blinkInterval);
      if (filterable) {
        blinkInterval = setInterval(() => {
          if (Date.now() - lastKeypressTime < 100) return;
          cursorVisible = !cursorVisible;
          render();
        }, 500);
      }
    }

    function cleanup() {
      if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null; }
      stdin.removeListener('keypress', onKeypress);
      stdin.setRawMode(wasRaw);
      if (!wasRaw) {
        stdin.pause();
      }
      stdout.write('\x1b[?25h');
    }

    function finalize(choice) {
      cleanup();
      // Move up to start of menu area and clear everything
      if (lastRenderedLines > 0) {
        stdout.write(`\x1b[${lastRenderedLines}A`);
      }
      stdout.write('\r\x1b[J'); // clear from cursor to end of screen

      // Cancel: just clear, no output (prompt will re-render)
      if (!choice) return;

      // Selection: show the final choice
      if (inlinePrefix) {
        stdout.write(`\x1b[1m${inlinePrefix}\x1b[0m\x1b[36m${choice.title}\x1b[0m\n`);
      } else {
        stdout.write(`? \x1b[1m${message}\x1b[0m \x1b[36m${choice.title}\x1b[0m\n`);
      }
    }

    function onKeypress(str, key) {
      if (!key) return;
      resetBlink();
      const visible = getVisible();

      if (key.name === 'up') {
        selected = selected > 0 ? selected - 1 : visible.length - 1;
        render();
      } else if (key.name === 'down') {
        selected = selected < visible.length - 1 ? selected + 1 : 0;
        render();
      } else if (key.name === 'return') {
        if (visible.length > 0) {
          const choice = visible[selected];
          finalize(choice);
          resolve(choice.value);
        }
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        finalize(null);
        resolve(undefined);
      } else if (filterable && key.name === 'backspace') {
        if (filterText.length > 0) {
          filterText = filterText.slice(0, -1);
          if (filterText.length === 0) {
            // All filter text deleted — cancel the menu
            finalize(null);
            resolve(undefined);
          } else {
            applyFilter();
            render();
          }
        } else {
          // Filter empty + backspace = cancel (exit the menu)
          finalize(null);
          resolve(undefined);
        }
      } else if (filterable && str && str.length === 1 && str.charCodeAt(0) >= 32) {
        filterText += str;
        applyFilter();
        render();
      }
    }

    stdin.on('keypress', onKeypress);
    render();
  }).finally(() => {
    // No cleanup needed — select provider handles its own cleanup
  });
}
