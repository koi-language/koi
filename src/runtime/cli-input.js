/**
 * CLI Input - Rich line editor with blinking underscore cursor, multi-line, history,
 * and paste detection.
 *
 * Features:
 *   - Blinking underscore cursor (classic terminal style)
 *   - Paste detection: multi-char data events collapse into [Pasted text #N +X lines]
 *   - Left/Right: move by character (snaps over paste markers)
 *   - Option+Left/Right: move by word
 *   - Up/Down: navigate visual lines
 *   - Up at start of text: previous history entry
 *   - Down at end of text: next history entry (empty at end)
 *   - Ctrl+A / Home: beginning of line
 *   - Ctrl+E / End: end of line
 *   - Backspace / Option+Backspace: delete char / word (deletes whole marker if at edge)
 *   - Delete / Ctrl+D: delete at cursor (deletes whole marker if at edge)
 *   - Ctrl+U: clear before cursor
 *   - Ctrl+K: clear after cursor
 *   - Ctrl+W: delete word before cursor
 *   - Enter: submit (expands paste markers back to real content)
 *   - Ctrl+C / Escape: cancel
 *
 * Uses process.stdout.write exclusively — no console.log calls.
 */

import readline from 'readline';

// Injectable provider: when set, cliInput delegates to this function instead
// of using the built-in readline editor. Set by the CLI bootstrap layer.
// Signature: fn(promptText) → Promise<string>
let _inputProvider = null;

/** Set an input provider that overrides the default readline editor. */
export function setInputProvider(fn) {
  _inputProvider = fn;
}

// Session-wide input history (persists across cliInput calls, resets on process exit)
const inputHistory = [];

// Optional callback when history is loaded (set by ink-bootstrap to sync with Ink)
let _onHistoryLoaded = null;
export function setHistoryLoadedCallback(fn) { _onHistoryLoaded = fn; }

/**
 * Add an entry to the input history (used externally for slash commands).
 */
export function addToHistory(text) {
  if (text && text.trim()) {
    inputHistory.push(text.trim());
  }
}

/**
 * Get a copy of the current input history.
 */
export function getHistory() {
  return [...inputHistory];
}

/**
 * Load previously saved history entries (e.g. from a resumed session).
 */
export function loadHistory(entries) {
  if (Array.isArray(entries)) {
    const loaded = [];
    for (const e of entries) {
      if (e && typeof e === 'string' && e.trim()) {
        inputHistory.push(e.trim());
        loaded.push(e.trim());
      }
    }
    if (loaded.length > 0 && _onHistoryLoaded) {
      _onHistoryLoaded(loaded);
    }
  }
}

/**
 * Show a line editor with block cursor, multi-line support, history, and paste detection.
 * @param {string} promptText - The prompt prefix (shown in bold white)
 * @returns {Promise<string>} The user's input text
 */
export function cliInput(promptText, { skipFinalRender = false, clearAfterSubmit = false, onCancel = null, fixedRow = 0, zone = null } = {}) {
  // If an input provider is set (e.g. Ink), delegate to it
  if (_inputProvider) {
    return _inputProvider(promptText);
  }

  return new Promise((resolve) => {
    const stdout = process.stdout;
    const stdin = process.stdin;

    // Ensure prompt ends with space
    const prompt = promptText.endsWith(' ') ? promptText : promptText + ' ';
    const promptLen = prompt.length;

    let text = '';
    let cursor = 0;
    let prevLineCount = 0;

    // Blinking cursor state
    let cursorVisible = true;
    let blinkInterval = null;
    let lastKeypressTime = 0;

    // History navigation
    let historyIndex = -1; // -1 = not browsing history
    let savedText = '';     // current text saved before entering history

    // Paste detection state
    const pastedChunks = []; // { id, content, marker }
    let pasteCounter = 0;

    // Slash command auto-submit with delay (allows backspace to cancel)
    let slashTimer = null;

    // Bracketed paste mode: terminal wraps pasted text with escape sequences
    let bracketedPasteBuffer = '';
    let inBracketedPaste = false;

    // Fallback coalescing for terminals without bracketed paste
    let pasteBuffer = '';
    let pasteTimer = null;

    // --- Paste detection ---

    function handlePaste(pastedStr) {
      resetBlink();

      // Clean line endings
      const content = pastedStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      pasteCounter++;

      const lineCount = content.split('\n').length;
      let marker;
      const isSingleLine = lineCount === 1;

      // Single-line pastes are inserted directly (no marker needed).
      // Multi-line pastes get a marker; content is stored and expanded on submit.
      if (isSingleLine) {
        text = text.substring(0, cursor) + content + text.substring(cursor);
        cursor += content.length;
        render();
        return;
      } else {
        marker = `[Pasted text #${pasteCounter} +${lineCount} lines]`;
      }

      const chunk = { id: pasteCounter, content, marker };
      pastedChunks.push(chunk);

      // Insert marker at cursor position
      text = text.substring(0, cursor) + marker + text.substring(cursor);
      cursor += marker.length;
      render();
    }

    // --- Paste marker helpers ---

    /**
     * Find if cursor position is inside a paste marker.
     * Returns { chunk, start, end } or null.
     */
    function findMarkerAt(pos) {
      for (const chunk of pastedChunks) {
        const idx = text.indexOf(chunk.marker);
        if (idx === -1) continue;
        if (pos > idx && pos < idx + chunk.marker.length) {
          return { chunk, start: idx, end: idx + chunk.marker.length };
        }
      }
      return null;
    }

    /**
     * Find if cursor is at the end edge of a marker (for backspace).
     * Returns { chunk, start, end } or null.
     */
    function findMarkerEndingAt(pos) {
      for (const chunk of pastedChunks) {
        const idx = text.indexOf(chunk.marker);
        if (idx === -1) continue;
        if (idx + chunk.marker.length === pos) {
          return { chunk, start: idx, end: idx + chunk.marker.length };
        }
      }
      return null;
    }

    /**
     * Find if cursor is at the start edge of a marker (for delete).
     * Returns { chunk, start, end } or null.
     */
    function findMarkerStartingAt(pos) {
      for (const chunk of pastedChunks) {
        const idx = text.indexOf(chunk.marker);
        if (idx === -1) continue;
        if (idx === pos) {
          return { chunk, start: idx, end: idx + chunk.marker.length };
        }
      }
      return null;
    }

    /**
     * Snap cursor forward past any marker it lands inside.
     */
    function snapCursorForward() {
      const m = findMarkerAt(cursor);
      if (m) cursor = m.end;
    }

    /**
     * Snap cursor backward past any marker it lands inside.
     */
    function snapCursorBackward() {
      const m = findMarkerAt(cursor);
      if (m) cursor = m.start;
    }

    /**
     * Remove orphaned paste chunks (marker no longer in text).
     */
    function cleanupPastes() {
      for (let i = pastedChunks.length - 1; i >= 0; i--) {
        if (!text.includes(pastedChunks[i].marker)) {
          pastedChunks.splice(i, 1);
        }
      }
    }

    /**
     * Delete a marker entirely: remove from text and pastedChunks.
     */
    function deleteMarker(m) {
      text = text.substring(0, m.start) + text.substring(m.end);
      cursor = m.start;
      const idx = pastedChunks.indexOf(m.chunk);
      if (idx !== -1) pastedChunks.splice(idx, 1);
    }

    /**
     * Get the text to submit: expand all markers back to real content.
     */
    function getSubmitText() {
      let result = text;
      for (const p of pastedChunks) {
        if (p.marker !== p.content) {
          result = result.replace(p.marker, p.content);
        }
      }
      return result;
    }

    // --- Visual line calculations ---

    function getCols() {
      return stdout.columns || parseInt(process.env.COLUMNS) || 80;
    }

    function firstLineCap() {
      return Math.max(1, getCols() - promptLen);
    }

    function cursorToRowCol(pos) {
      const flc = firstLineCap();
      const c = getCols();
      if (pos < flc) return { row: 0, col: pos };
      const rem = pos - flc;
      return { row: 1 + Math.floor(rem / c), col: rem % c };
    }

    function rowColToCursor(row, col) {
      const flc = firstLineCap();
      const c = getCols();
      if (row === 0) return Math.min(col, text.length, flc);
      const pos = flc + (row - 1) * c + col;
      return Math.min(pos, text.length);
    }

    function totalRows() {
      const flc = firstLineCap();
      const c = getCols();
      if (text.length <= flc) return 1;
      return 1 + Math.ceil((text.length - flc) / c);
    }

    function lineLen(row) {
      const flc = firstLineCap();
      const c = getCols();
      if (row === 0) return Math.min(text.length, flc);
      const start = flc + (row - 1) * c;
      if (start >= text.length) return 0;
      return Math.min(c, text.length - start);
    }

    // --- Rendering ---

    // Marker chip style: dim background + blue text
    const CHIP_START = '\x1b[0m\x1b[48;5;236m\x1b[38;5;110m';
    const CHIP_END = '\x1b[0m\x1b[36m';

    /**
     * Style a text segment, wrapping any paste markers in chip style.
     */
    function styleSegment(segment) {
      if (pastedChunks.length === 0) return segment;

      let result = segment;
      for (const chunk of pastedChunks) {
        if (result.includes(chunk.marker)) {
          result = result.replace(chunk.marker, `${CHIP_START}${chunk.marker}${CHIP_END}`);
        }
      }
      return result;
    }

    function render() {
      // Effective fixed row: zone overrides fixedRow (read dynamically each render)
      const effectiveFixedRow = zone ? zone.startRow : fixedRow;

      // --- Fixed row mode (with optional multi-line via zone) ---
      if (effectiveFixedRow > 0) {
        const c = getCols();
        const flc = Math.max(1, c - promptLen);

        // With zone: support multi-line wrapping
        if (zone) {
          const numRows = text.length <= flc ? 1 : 1 + Math.ceil((text.length - flc) / c);
          if (numRows !== prevLineCount && prevLineCount > 0) {
            zone.onHeightChange(numRows);
          }
          prevLineCount = numRows;

          // Use the current zone.startRow (may have changed after onHeightChange)
          const row = zone.startRow;
          const { row: curRow, col: curCol } = cursorToRowCol(cursor);

          stdout.write('\x1b7'); // save cursor
          for (let r = 0; r < numRows; r++) {
            let lineStart, lineEnd;
            if (r === 0) {
              lineStart = 0;
              lineEnd = Math.min(text.length, flc);
              stdout.write(`\x1b[${row + r};1H\x1b[K\x1b[1m${prompt}\x1b[0m`);
            } else {
              lineStart = flc + (r - 1) * c;
              lineEnd = Math.min(text.length, lineStart + c);
              stdout.write(`\x1b[${row + r};1H\x1b[K`);
            }
            const lineText = lineStart < text.length ? text.substring(lineStart, lineEnd) : '';

            if (r === curRow) {
              const before = lineText.substring(0, curCol);
              const atCursor = curCol < lineText.length ? lineText[curCol] : ' ';
              const after = curCol < lineText.length ? lineText.substring(curCol + 1) : '';
              if (cursorVisible) {
                stdout.write(`\x1b[36m${styleSegment(before)}\x1b[4;36m${atCursor}\x1b[24m${styleSegment(after)}\x1b[0m`);
              } else {
                stdout.write(`\x1b[36m${styleSegment(before)}${atCursor}${styleSegment(after)}\x1b[0m`);
              }
            } else {
              stdout.write(`\x1b[36m${styleSegment(lineText)}\x1b[0m`);
            }
            stdout.write('\x1b[K');
          }
          stdout.write('\x1b8'); // restore cursor
          return;
        }

        // Without zone: single-line fixed row (original behavior)
        const maxChars = c - promptLen;
        const visibleText = text.length > maxChars ? text.substring(0, maxChars) : text;
        const curCol = Math.min(cursor, visibleText.length);

        stdout.write('\x1b7'); // save cursor (DEC)
        stdout.write(`\x1b[${effectiveFixedRow};1H\x1b[K`);
        stdout.write(`\x1b[1m${prompt}\x1b[0m`);

        const before = visibleText.substring(0, curCol);
        const atCursor = curCol < visibleText.length ? visibleText[curCol] : ' ';
        const after = curCol < visibleText.length ? visibleText.substring(curCol + 1) : '';

        if (cursorVisible) {
          stdout.write(`\x1b[36m${styleSegment(before)}\x1b[4;36m${atCursor}\x1b[24m${styleSegment(after)}\x1b[0m`);
        } else {
          stdout.write(`\x1b[36m${styleSegment(before)}${atCursor}${styleSegment(after)}\x1b[0m`);
        }
        stdout.write('\x1b[K');
        stdout.write('\x1b8'); // restore cursor (DEC)
        return;
      }

      // --- Normal mode: multi-line render ---
      const flc = firstLineCap();
      const c = getCols();
      const numRows = totalRows();
      const { row: curRow, col: curCol } = cursorToRowCol(cursor);

      // Ensure cursor row exists (cursor at end of text may be on new row)
      const renderRows = Math.max(numRows, curRow + 1);

      // Move to first line of editor area
      if (prevLineCount > 1) {
        stdout.write(`\x1b[${prevLineCount - 1}A`);
      }
      stdout.write('\r');

      for (let r = 0; r < renderRows; r++) {
        // Compute text slice for this row
        let lineStart, lineEnd;
        if (r === 0) {
          lineStart = 0;
          lineEnd = Math.min(text.length, flc);
          stdout.write(`\x1b[1m${prompt}\x1b[0m`);
        } else {
          lineStart = flc + (r - 1) * c;
          lineEnd = Math.min(text.length, lineStart + c);
        }

        const lineText = (lineStart < text.length) ? text.substring(lineStart, lineEnd) : '';

        if (r === curRow) {
          // Render with blinking underscore cursor
          const before = lineText.substring(0, curCol);
          const atCursor = curCol < lineText.length ? lineText[curCol] : ' ';
          const after = curCol < lineText.length ? lineText.substring(curCol + 1) : '';
          if (cursorVisible) {
            stdout.write(`\x1b[36m${styleSegment(before)}\x1b[4;36m${atCursor}\x1b[24m${styleSegment(after)}\x1b[0m`);
          } else {
            stdout.write(`\x1b[36m${styleSegment(before)}${atCursor}${styleSegment(after)}\x1b[0m`);
          }
        } else {
          stdout.write(`\x1b[36m${styleSegment(lineText)}\x1b[0m`);
        }

        // Clear any leftover characters after content
        stdout.write('\x1b[K');

        if (r < renderRows - 1) stdout.write('\n');
      }

      // Clear leftover lines from previous render
      if (prevLineCount > renderRows) {
        const extra = prevLineCount - renderRows;
        for (let i = 0; i < extra; i++) {
          stdout.write('\n\x1b[2K');
        }
        stdout.write(`\x1b[${extra}A`);
      }

      prevLineCount = renderRows;
    }

    // --- History helpers ---

    function historyUp() {
      if (inputHistory.length === 0) return;
      if (historyIndex === -1) {
        savedText = text;
        historyIndex = inputHistory.length - 1;
      } else if (historyIndex > 0) {
        historyIndex--;
      } else {
        return; // already at oldest
      }
      text = inputHistory[historyIndex];
      cursor = 0;
    }

    function historyDown() {
      if (historyIndex === -1) return;
      if (historyIndex < inputHistory.length - 1) {
        historyIndex++;
        text = inputHistory[historyIndex];
        cursor = text.length;
      } else {
        // Past last entry → restore saved text
        text = savedText;
        cursor = text.length;
        historyIndex = -1;
      }
    }

    // --- Setup ---

    // Guard: only call emitKeypressEvents once per stdin to avoid duplicate data listeners
    if (!stdin._keypressEventsEmitting) {
      readline.emitKeypressEvents(stdin);
      stdin._keypressEventsEmitting = true;
    }
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write('\x1b[?25l'); // hide native cursor
    stdout.write('\x1b[?2004h'); // enable bracketed paste mode

    // Intercept stdin data events to detect pastes before readline processes them
    const origEmit = stdin.emit;
    stdin.emit = function(event, ...args) {
      if (event === 'data') {
        const buf = args[0];
        const str = typeof buf === 'string' ? buf : buf.toString('utf8');

        // --- Bracketed paste mode (reliable, no timers) ---
        // Start sequence: \x1b[200~  End sequence: \x1b[201~
        // These can appear within a data chunk or split across chunks.

        if (str.includes('\x1b[200~') || inBracketedPaste) {
          let data = str;

          // Handle start marker (may be mid-chunk)
          if (!inBracketedPaste && data.includes('\x1b[200~')) {
            inBracketedPaste = true;
            data = data.substring(data.indexOf('\x1b[200~') + 6);
          }

          // Check for end marker
          if (data.includes('\x1b[201~')) {
            bracketedPasteBuffer += data.substring(0, data.indexOf('\x1b[201~'));
            inBracketedPaste = false;
            handlePaste(bracketedPasteBuffer);
            bracketedPasteBuffer = '';
          } else {
            bracketedPasteBuffer += data;
          }
          return true; // swallow: do NOT forward bracketed paste data to readline
        }

        // --- Fallback: heuristic paste detection (for terminals without bracketed paste) ---
        if (str.length > 1 && !str.startsWith('\x1b') && str.charCodeAt(0) >= 32) {
          pasteBuffer += str;
          if (pasteTimer) clearTimeout(pasteTimer);
          pasteTimer = setTimeout(() => {
            handlePaste(pasteBuffer);
            pasteBuffer = '';
            pasteTimer = null;
          }, 80);
          return true; // swallow
        }
      }
      return origEmit.apply(stdin, [event, ...args]);
    };

    // Start blink interval (500ms on, 500ms off = 1s cycle)
    blinkInterval = setInterval(() => {
      // Skip blink render if user is actively typing (prevents flicker)
      if (Date.now() - lastKeypressTime < 100) return;
      cursorVisible = !cursorVisible;
      render();
    }, 500);

    function cleanup() {
      if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null; }
      if (pasteTimer) { clearTimeout(pasteTimer); pasteTimer = null; }
      if (slashTimer) { clearTimeout(slashTimer); slashTimer = null; }
      stdin.removeListener('keypress', onKeypress);
      stdin.emit = origEmit; // restore original emit
      stdin.setRawMode(wasRaw);
      stdout.write('\x1b[?2004l'); // disable bracketed paste mode
      stdout.write('\x1b[?25h'); // restore native cursor
    }

    function submit() {
      // Expand markers to real content for the submitted text
      const submitText = getSubmitText();

      cleanup();

      // Add to history if non-empty (skip slash commands)
      if (submitText.trim() && !submitText.trim().startsWith('/')) {
        inputHistory.push(submitText);
      }
      historyIndex = -1;

      // In skipFinalRender mode, just resolve without rendering
      if (skipFinalRender) {
        resolve(submitText.trim());
        return;
      }

      // In clearAfterSubmit mode: clear editor area, leave cursor at start
      if (clearAfterSubmit) {
        if (prevLineCount > 1) {
          stdout.write(`\x1b[${prevLineCount - 1}A`);
        }
        stdout.write('\r');
        for (let i = 0; i < prevLineCount; i++) {
          stdout.write('\x1b[2K');
          if (i < prevLineCount - 1) stdout.write('\n');
        }
        if (prevLineCount > 1) {
          stdout.write(`\x1b[${prevLineCount - 1}A`);
        }
        stdout.write('\r');
        resolve(submitText.trim());
        return;
      }

      // Clear editor area and show final text (no cursor) — show marker version for display
      if (prevLineCount > 1) {
        stdout.write(`\x1b[${prevLineCount - 1}A`);
      }
      stdout.write('\r');
      for (let i = 0; i < prevLineCount; i++) {
        stdout.write('\x1b[2K');
        if (i < prevLineCount - 1) stdout.write('\n');
      }
      if (prevLineCount > 1) {
        stdout.write(`\x1b[${prevLineCount - 1}A`);
      }
      stdout.write('\r');

      // For slash commands: don't print final line (handler renders its own UI)
      if (submitText.trim() === '/') {
        resolve(submitText.trim());
        return;
      }

      // Write final output with marker version (concise display)
      stdout.write(`\x1b[1m${prompt}\x1b[0m\x1b[36m${text}\x1b[0m\n`);
      resolve(submitText.trim());
    }

    function resetBlink() {
      cursorVisible = true;
      lastKeypressTime = Date.now();
      if (blinkInterval) clearInterval(blinkInterval);
      blinkInterval = setInterval(() => {
        // Skip blink render if user is actively typing (prevents flicker)
        if (Date.now() - lastKeypressTime < 100) return;
        cursorVisible = !cursorVisible;
        render();
      }, 500);
    }

    function onKeypress(str, key) {
      resetBlink();

      if (key) {
        // --- Submit / Cancel ---
        if (key.name === 'return') { submit(); return; }
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          cleanup();
          if (zone) {
            // In zone mode: just clear the input row, no newline (would break scroll region)
            stdout.write('\x1b7');
            stdout.write(`\x1b[${zone.startRow};1H\x1b[K`);
            stdout.write('\x1b8');
          } else {
            stdout.write('\r\x1b[2K');
            stdout.write(`\x1b[1m${prompt}\x1b[0m\n`);
          }
          resolve('');
          return;
        }

        // --- Up / Down ---
        if (key.name === 'up') {
          const { row, col } = cursorToRowCol(cursor);
          if (row > 0) {
            const targetCol = Math.min(col, lineLen(row - 1));
            cursor = rowColToCursor(row - 1, targetCol);
            snapCursorBackward();
          } else if (cursor > 0) {
            cursor = 0;
          } else {
            historyUp();
          }
          render();
          return;
        }

        if (key.name === 'down') {
          const { row, col } = cursorToRowCol(cursor);
          const lr = totalRows() - 1;
          if (row < lr) {
            const targetCol = Math.min(col, lineLen(row + 1));
            cursor = rowColToCursor(row + 1, targetCol);
            snapCursorForward();
          } else if (cursor < text.length) {
            cursor = text.length;
          } else {
            historyDown();
          }
          render();
          return;
        }

        // --- Left / Right ---
        if (key.name === 'left') {
          if (key.meta || key.ctrl) {
            cursor = prevWordBoundary(text, cursor);
          } else {
            cursor = Math.max(0, cursor - 1);
          }
          // Snap past any marker the cursor landed inside
          snapCursorBackward();
          render(); return;
        }
        if (key.name === 'right') {
          if (key.meta || key.ctrl) {
            cursor = nextWordBoundary(text, cursor);
          } else {
            cursor = Math.min(text.length, cursor + 1);
          }
          snapCursorForward();
          render(); return;
        }

        // ESC-b / ESC-f (word movement in some terminals)
        if (key.meta && key.name === 'b') { cursor = prevWordBoundary(text, cursor); snapCursorBackward(); render(); return; }
        if (key.meta && key.name === 'f') { cursor = nextWordBoundary(text, cursor); snapCursorForward(); render(); return; }

        // ESC-d — delete word forward (Option+D)
        if (key.meta && key.name === 'd') {
          if (cursor < text.length) {
            const end = nextWordBoundary(text, cursor);
            text = text.substring(0, cursor) + text.substring(end);
            cleanupPastes();
            render();
          }
          return;
        }

        // Home / End (Ctrl+A/E and Option+A/E)
        if (key.name === 'home' || (key.ctrl && key.name === 'a') || (key.meta && key.name === 'a')) { cursor = 0; render(); return; }
        if (key.name === 'end' || (key.ctrl && key.name === 'e') || (key.meta && key.name === 'e')) { cursor = text.length; render(); return; }

        // --- Deletion ---
        if (key.name === 'backspace') {
          // Cancel pending slash auto-submit
          if (slashTimer) { clearTimeout(slashTimer); slashTimer = null; }
          if (cursor > 0) {
            // Check if we're at the end edge of a marker → delete whole marker
            const markerEnd = findMarkerEndingAt(cursor);
            if (markerEnd) {
              deleteMarker(markerEnd);
              render();
              return;
            }
            if (key.meta || key.ctrl) {
              const prev = prevWordBoundary(text, cursor);
              text = text.substring(0, prev) + text.substring(cursor);
              cursor = prev;
            } else {
              text = text.substring(0, cursor - 1) + text.substring(cursor);
              cursor--;
            }
            cleanupPastes();
            render();
          }
          return;
        }
        if (key.name === 'delete' || (key.ctrl && key.name === 'd')) {
          if (cursor < text.length) {
            // Check if we're at the start edge of a marker → delete whole marker
            const markerStart = findMarkerStartingAt(cursor);
            if (markerStart) {
              deleteMarker(markerStart);
              render();
              return;
            }
            text = text.substring(0, cursor) + text.substring(cursor + 1);
            cleanupPastes();
            render();
          }
          return;
        }
        if (key.ctrl && key.name === 'u') {
          text = text.substring(cursor); cursor = 0; cleanupPastes(); render(); return;
        }
        if (key.ctrl && key.name === 'k') {
          text = text.substring(0, cursor); cleanupPastes(); render(); return;
        }
        if (key.ctrl && key.name === 'w') {
          if (cursor > 0) {
            const prev = prevWordBoundary(text, cursor);
            text = text.substring(0, prev) + text.substring(cursor);
            cursor = prev;
            cleanupPastes();
            render();
          }
          return;
        }

        // Skip other control/meta keys
        if (key.ctrl || key.meta) return;
      }

      // Regular character input
      if (str && str.length > 0 && str.charCodeAt(0) >= 32) {
        let ch = str;
        // Handle dead key combining characters (macOS international keyboards)
        const code = str.charCodeAt(0);
        if (code >= 0x0300 && code <= 0x036F) {
          const deadKeyMap = {
            0x0300: '`',   // combining grave → backtick
            0x0301: "'",   // combining acute → apostrophe
            0x0302: '^',   // combining circumflex → caret
            0x0303: '~',   // combining tilde → tilde
            0x0308: '"',   // combining diaeresis → double quote
          };
          ch = deadKeyMap[code] || '';
        }
        if (ch) {
          text = text.substring(0, cursor) + ch + text.substring(cursor);
          cursor += ch.length;
          // Auto-submit "/" with delay (allows backspace to cancel)
          if (text === '/') {
            if (slashTimer) clearTimeout(slashTimer);
            slashTimer = setTimeout(() => { slashTimer = null; submit(); }, 200);
          }
          render();
        }
      }
    }

    stdin.on('keypress', onKeypress);

    // Register cancel callback so external code can abort this input
    if (onCancel) {
      onCancel(() => {
        cleanup();
        // Clear prompt line
        stdout.write('\r\x1b[K');
        resolve(null);
      });
    }

    render();
  });
}

// --- Word boundary helpers ---

function prevWordBoundary(text, pos) {
  if (pos <= 0) return 0;
  let i = pos - 1;
  while (i > 0 && text[i] === ' ') i--;
  while (i > 0 && text[i - 1] !== ' ') i--;
  return i;
}

function nextWordBoundary(text, pos) {
  if (pos >= text.length) return text.length;
  let i = pos;
  while (i < text.length && text[i] !== ' ') i++;
  while (i < text.length && text[i] === ' ') i++;
  return i;
}
