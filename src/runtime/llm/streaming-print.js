/**
 * StreamingPrintParser
 *
 * Extracted state machine that detects a "print" intent in a streaming JSON
 * response and progressively renders the message content with markdown
 * formatting (tables, code blocks, inline markup).
 *
 * Usage:
 *   const parser = new StreamingPrintParser({
 *     printFn:    (html) => { ... },   // emit formatted chunk to the UI
 *     renderTableFn: (rows) => { ... },// render table rows into a formatted string
 *     renderMarkdownFn: (md) => { ... },// render a markdown string (e.g. code block)
 *     renderLineFn: (line) => { ... }, // render a single line with inline markdown
 *   });
 *
 *   // Inside the streaming loop:
 *   parser.onChunk(delta);
 *
 *   // After the stream ends:
 *   const { printStreamed, state } = parser.finalize();
 */

class StreamingPrintParser {
  /**
   * @param {object} opts
   * @param {(html: string) => void}   opts.printFn          – emit a formatted chunk (printStreaming)
   * @param {(rows: string[]) => string} opts.renderTableFn  – render buffered table rows
   * @param {(md: string) => string}    opts.renderMarkdownFn – render a markdown string
   * @param {(line: string) => string}  opts.renderLineFn     – render a single line with inline markdown
   */
  constructor({ printFn, renderTableFn, renderMarkdownFn, renderLineFn }) {
    this._printFn          = printFn;
    this._renderTableFn    = renderTableFn;
    this._renderMarkdownFn = renderMarkdownFn;
    this._renderLineFn     = renderLineFn;

    // ── state ──────────────────────────────────────────────────────────
    this._spState          = 'init';    // 'init' | 'found_print' | 'streaming' | 'done' | 'skip'
    this._spBuf            = '';        // accumulated raw JSON text
    this._spMsgOffset      = -1;       // offset where message string content starts
    this._spInEscape       = false;    // inside a \ escape
    this._spPendingUnicode = null;     // collecting \uXXXX hex digits
    this._printStreamed    = false;     // true once streaming print was active
    this._lineBuf          = '';        // line buffer — holds partial line until \n
    this._tableBuf         = [];        // buffered table rows for batch rendering
    this._inCodeBlock      = false;    // inside a ``` code block
    this._codeLang         = '';        // language of current code block
    this._codeLines        = [];        // buffered code lines for syntax highlighting
    this._complianceAborted = false;
  }

  // ── public API ────────────────────────────────────────────────────────

  /**
   * Feed the next streaming delta into the parser.
   * @param {string} delta – raw text chunk from the LLM stream
   */
  onChunk(delta) {
    if (this._spState === 'done' || this._spState === 'skip') return;

    this._spBuf += delta;

    // Early compliance detection: if we see "wont_do" in the stream, abort immediately.
    // This saves tokens — no need to wait for the full response.
    if (!this._complianceAborted && this._spBuf.includes('"wont_do"')) {
      this._complianceAborted = true;
      this._spState = 'skip';
      return;
    }

    if (this._spState === 'init') {
      // Wait for intent field
      const intentMatch = this._spBuf.match(/"intent"\s*:\s*"([^"]*)"/);
      if (intentMatch) {
        if (intentMatch[1] === 'print') {
          this._spState = 'found_print';
          // Check if message value already started
          const msgMatch = this._spBuf.match(/"message"\s*:\s*"/);
          if (msgMatch) {
            this._spMsgOffset = msgMatch.index + msgMatch[0].length;
            this._startStreaming();
          }
        } else {
          this._spState = 'skip';
        }
      } else if (this._spBuf.length > 300) {
        this._spState = 'skip';
      }
    } else if (this._spState === 'found_print') {
      // Intent is print — waiting for message field
      const msgMatch = this._spBuf.match(/"message"\s*:\s*"/);
      if (msgMatch) {
        this._spMsgOffset = msgMatch.index + msgMatch[0].length;
        this._startStreaming();
      }
    } else if (this._spState === 'streaming') {
      // Already streaming — process new delta characters only
      this._processStreamingChars(delta);
    }
  }

  /**
   * Call after the stream has ended.
   * @returns {{ printStreamed: boolean, state: string }}
   */
  finalize() {
    const needsStreamEnd = this._spState === 'streaming';
    if (needsStreamEnd) {
      // Stream ended without seeing the closing quote — flush remaining content
      this._flushLines(true);
    }
    return {
      printStreamed: this._printStreamed,
      state: this._spState,
      needsStreamEnd,
    };
  }

  /**
   * Whether compliance abort was detected ("wont_do").
   */
  get complianceAborted() {
    return this._complianceAborted;
  }

  /**
   * Current parser state.
   */
  get state() {
    return this._spState;
  }

  // ── private helpers ───────────────────────────────────────────────────

  _flushTableBuf() {
    if (this._tableBuf.length > 0) {
      this._printFn(this._renderTableFn(this._tableBuf) + '\n');
      this._tableBuf = [];
    }
  }

  /**
   * Flush buffered code block as a syntax-highlighted markdown code block.
   */
  _flushCodeBlock() {
    if (this._codeLines.length === 0) return;
    // Render the buffered code block as a single markdown code block,
    // then pass through renderMarkdown for syntax highlighting.
    const codeBlock = '```' + this._codeLang + '\n' + this._codeLines.join('\n') + '\n```';
    this._printFn(this._renderMarkdownFn(codeBlock) + '\n');
    this._codeLines = [];
    this._codeLang = '';
  }

  /**
   * Flush complete lines from _lineBuf to the UI with markdown formatting.
   * Tables are buffered until a non-table line arrives (or flush=true).
   * If flush=true, also emit the remaining partial line (end of message).
   */
  _flushLines(flush = false) {
    let idx;
    while ((idx = this._lineBuf.indexOf('\n')) !== -1) {
      const line = this._lineBuf.slice(0, idx); // without \n
      this._lineBuf = this._lineBuf.slice(idx + 1);

      const trimmed = line.trim();

      // Code block start: ```lang
      if (trimmed.startsWith('```') && !this._inCodeBlock) {
        this._flushTableBuf();
        this._inCodeBlock = true;
        this._codeLang = trimmed.substring(3).trim();
        this._codeLines = [];
        continue;
      }
      // Code block end: ```
      if (trimmed === '```' && this._inCodeBlock) {
        this._inCodeBlock = false;
        this._flushCodeBlock();
        continue;
      }
      // Inside code block — collect raw lines
      if (this._inCodeBlock) {
        this._codeLines.push(line);
        continue;
      }

      // Detect table rows: starts and ends with |
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        this._tableBuf.push(line);
        continue;
      }

      // Non-table line — flush any buffered table first
      this._flushTableBuf();

      // Format and emit
      this._printFn(this._renderLineFn(line) + '\n');
    }

    if (flush) {
      // Flush remaining code block
      if (this._inCodeBlock) {
        this._inCodeBlock = false;
        this._flushCodeBlock();
      }
      // Flush remaining table buffer
      this._flushTableBuf();
      // Flush remaining partial line
      if (this._lineBuf) {
        this._printFn(this._renderLineFn(this._lineBuf));
        this._lineBuf = '';
      }
    }
  }

  /**
   * Process a delta chunk while in 'streaming' state — unescape JSON string chars
   * and buffer by line. Detects the closing " to transition to 'done'.
   */
  _processStreamingChars(delta) {
    for (let i = 0; i < delta.length; i++) {
      if (this._spState !== 'streaming') break;
      const ch = delta[i];

      if (this._spPendingUnicode !== null) {
        this._spPendingUnicode += ch;
        if (this._spPendingUnicode.length === 4) {
          this._lineBuf += String.fromCharCode(parseInt(this._spPendingUnicode, 16));
          this._spPendingUnicode = null;
        }
        continue;
      }

      if (this._spInEscape) {
        this._spInEscape = false;
        if (ch === 'n') this._lineBuf += '\n';
        else if (ch === 'r') this._lineBuf += '\r';
        else if (ch === 't') this._lineBuf += '\t';
        else if (ch === '"') this._lineBuf += '"';
        else if (ch === '\\') this._lineBuf += '\\';
        else if (ch === '/') this._lineBuf += '/';
        else if (ch === 'u') { this._spPendingUnicode = ''; }
        else this._lineBuf += ch;
        continue;
      }

      if (ch === '\\') { this._spInEscape = true; continue; }
      if (ch === '"') {
        // End of JSON string value — flush any remaining partial line
        this._flushLines(true);
        this._spState = 'done';
        this._printStreamed = true;
        // Don't call printStreamingEnd here — the print action will clear
        // the streaming area when it commits the markdown-formatted text,
        // avoiding a visual "double display".
        break;
      }
      this._lineBuf += ch;
    }
    // After processing the delta, emit any complete lines we've accumulated
    if (this._spState === 'streaming') this._flushLines(false);
  }

  /**
   * Transition to streaming state: emit any buffered message content.
   */
  _startStreaming() {
    this._spState = 'streaming';
    const buffered = this._spBuf.slice(this._spMsgOffset);
    if (buffered) this._processStreamingChars(buffered);
  }
}

export { StreamingPrintParser };
