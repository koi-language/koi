/**
 * CLI Markdown - Renders basic markdown to ANSI-formatted terminal text.
 *
 * Supports:
 *   - **bold** → ANSI bold
 *   - *italic* → ANSI italic
 *   - `code` → ANSI cyan
 *   - # Heading → bold + underline
 *   - ## Heading → bold
 *   - ### Heading → bold
 *   - --- / ___ / *** → horizontal rule
 *   - * item / - item → bullet points (•)
 *   - | col | col | → formatted tables with box-drawing
 */

const DIM  = '\x1b[2m';
const BOLD = '\x1b[1m';
const RST  = '\x1b[0m';

// Accent color for links, inline code, types, functions, etc.
// Overridable via setAccentColor() — called by the CLI theme layer.
let ACCENT = '\x1b[36m'; // default: standard cyan
export function setAccentColor(ansiCode) { ACCENT = ansiCode; }

// ── Inline formatting ────────────────────────────────────────────────────────

function renderInline(text) {
  // Links FIRST — before any ANSI codes are inserted, so URL regexes match cleanly.
  // Markdown links: [label](url) → accent underlined label
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_, label) => `${ACCENT}\x1b[4m${label}\x1b[24m\x1b[39m`
  );
  // Bare URLs: http(s)://... → accent underlined URL
  text = text.replace(
    /(^|[\s(])(https?:\/\/[^\s)\]>*]+)/g,
    (_, pre, url) => `${pre}${ACCENT}\x1b[4m${url}\x1b[24m\x1b[39m`
  );

  // Inline code: `code` → accent
  text = text.replace(/`([^`]+)`/g, (_, code) => `${ACCENT}${code}\x1b[39m`);

  // Bold: **text** → bold
  text = text.replace(/\*\*([^*]+)\*\*/g, '\x1b[1m$1\x1b[22m');

  // Italic: *text* → italic (but not ** which is already handled)
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '\x1b[3m$1\x1b[23m');

  return text;
}

// ── Line rendering ───────────────────────────────────────────────────────────

export function renderLine(line) {
  const trimmed = line.trim();

  // Horizontal rules: ---, ___, ***
  if (/^[-_*]{3,}\s*$/.test(trimmed)) {
    const cols = process.stdout.columns || parseInt(process.env.COLUMNS) || 80;
    return DIM + '─'.repeat(Math.min(cols, 60)) + RST;
  }

  // Headings (check most # first so #### doesn't match ###)
  if (trimmed.startsWith('#### ')) {
    return BOLD + renderInline(trimmed.substring(5)) + RST;
  }
  if (trimmed.startsWith('### ')) {
    return BOLD + renderInline(trimmed.substring(4)) + RST;
  }
  if (trimmed.startsWith('## ')) {
    return BOLD + renderInline(trimmed.substring(3)) + RST;
  }
  if (trimmed.startsWith('# ')) {
    return '\x1b[1;4m' + renderInline(trimmed.substring(2)) + RST;
  }

  // Unordered bullet points: * text, - text, + text → indented • text
  const bulletMatch = line.match(/^(\s*)[*\-+]\s+(.+)$/);
  if (bulletMatch && !/^[-_*]{3,}\s*$/.test(trimmed)) {
    return bulletMatch[1] + '  • ' + renderInline(bulletMatch[2]);
  }

  // Numbered lists: 1. text or 1) text → indented number. text
  const numMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
  if (numMatch) {
    return numMatch[1] + '  ' + numMatch[2] + '. ' + renderInline(numMatch[3]);
  }

  return renderInline(line);
}

// ── Table rendering ──────────────────────────────────────────────────────────

/** Strip markdown markers for width calculation (no ANSI, no ** / * / `) */
function stripMarkers(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * Render a set of markdown table lines into a box-drawing table.
 * @param {string[]} lines - raw markdown table lines (each starts/ends with |)
 * @returns {string} formatted table string
 */
export function renderTable(lines) {
  const rows = [];
  for (const line of lines) {
    const cells = line.trim().split('|').map(c => c.trim());
    // Remove empty first/last from leading/trailing |
    if (cells[0] === '') cells.shift();
    if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    // Skip separator rows (| --- | :--- | ---: |)
    if (cells.every(c => /^:?-+:?$/.test(c))) continue;
    rows.push(cells);
  }

  if (rows.length === 0) return lines.join('\n');

  // Calculate column widths from plain text
  const numCols = Math.max(...rows.map(r => r.length));
  const colWidths = new Array(numCols).fill(0);
  for (const row of rows) {
    for (let c = 0; c < numCols; c++) {
      colWidths[c] = Math.max(colWidths[c], stripMarkers(row[c] || '').length);
    }
  }

  // Box-drawing helpers
  const hLine = (l, m, r) =>
    DIM + l + colWidths.map(w => '─'.repeat(w + 2)).join(m) + r + RST;

  const out = [];
  out.push(hLine('┌', '┬', '┐'));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isHeader = i === 0 && rows.length > 1;
    const cells = [];
    for (let c = 0; c < numCols; c++) {
      const raw = row[c] || '';
      const rendered = renderInline(raw);
      const plainLen = stripMarkers(raw).length;
      const pad = colWidths[c] - plainLen;
      if (isHeader) {
        cells.push(' ' + BOLD + rendered + RST + ' '.repeat(Math.max(0, pad) + 1));
      } else {
        cells.push(' ' + rendered + ' '.repeat(Math.max(0, pad) + 1));
      }
    }
    out.push(DIM + '│' + RST + cells.join(DIM + '│' + RST) + DIM + '│' + RST);

    if (isHeader) {
      out.push(hLine('├', '┼', '┤'));
    }
  }

  out.push(hLine('└', '┴', '┘'));
  return out.join('\n');
}

// ── Syntax highlighting for code blocks ──────────────────────────────────────

const _SH = {
  KEYWORD:  '\x1b[38;5;198m',  // pink — keywords (const, function, if, return, etc.)
  STRING:   '\x1b[38;5;114m',  // green — string literals
  NUMBER:   '\x1b[38;5;208m',  // orange — numbers
  COMMENT:  '\x1b[38;5;242m',  // gray — comments
  get TYPE()  { return ACCENT; },  // accent — types, classes, interfaces
  get FUNC()  { return ACCENT; },  // accent — function names
  PUNCT:    '\x1b[38;5;250m',    // light gray — brackets, braces, parens
  get PROP()  { return ACCENT; },  // accent — property names
  RST:      '\x1b[0m',
};

// Language-agnostic keywords that cover JS/TS/Python/Go/Rust/Java/etc.
const _KEYWORDS = new Set([
  'const','let','var','function','return','if','else','for','while','do',
  'switch','case','break','continue','class','extends','new','this','super',
  'import','export','from','default','async','await','yield','throw','try',
  'catch','finally','typeof','instanceof','in','of','delete','void',
  'true','false','null','undefined','NaN','Infinity',
  // Python
  'def','elif','except','lambda','pass','raise','with','as','is','not','and','or',
  'None','True','False','self','print','nonlocal','global',
  // Go/Rust
  'fn','pub','mod','use','impl','trait','struct','enum','match','mut','ref','type',
  'package','func','defer','go','chan','select','range','map',
  // Java/C
  'public','private','protected','static','final','abstract','interface','implements',
  'void','int','string','boolean','float','double','long','char',
]);

export function highlightCode(code, lang) {
  // Token-based approach: split each line into tokens, classify, colorize, rejoin.
  // Avoids regex-on-ANSI issues by processing raw text only.
  return code.split('\n').map(line => {
    // Full-line comments
    if (/^\s*\/\//.test(line)) return _SH.COMMENT + line + _SH.RST;
    if (/^\s*#(?!!)/.test(line)) return _SH.COMMENT + line + _SH.RST;
    if (/^\s*\/\*/.test(line)) return _SH.COMMENT + line + _SH.RST;
    if (/^\s*\*/.test(line)) return _SH.COMMENT + line + _SH.RST; // multi-line comment continuation

    // Tokenize: split into strings, comments, words, numbers, punctuation, whitespace
    const tokens = [];
    let i = 0;
    while (i < line.length) {
      const ch = line[i];

      // Whitespace
      if (/\s/.test(ch)) {
        let j = i;
        while (j < line.length && /\s/.test(line[j])) j++;
        tokens.push({ type: 'ws', value: line.slice(i, j) });
        i = j;
        continue;
      }

      // Inline comment: //
      if (ch === '/' && line[i + 1] === '/') {
        tokens.push({ type: 'comment', value: line.slice(i) });
        break;
      }

      // Strings: "..." '...' `...`
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) {
          if (line[j] === '\\') j++; // skip escaped char
          j++;
        }
        tokens.push({ type: 'string', value: line.slice(i, j + 1) });
        i = j + 1;
        continue;
      }

      // Numbers: 0x..., 0b..., digits
      if (/\d/.test(ch) || (ch === '.' && /\d/.test(line[i + 1] || ''))) {
        let j = i;
        if (ch === '0' && (line[i + 1] === 'x' || line[i + 1] === 'b')) j += 2;
        while (j < line.length && /[\d.a-fA-F_eE+-]/.test(line[j])) j++;
        tokens.push({ type: 'number', value: line.slice(i, j) });
        i = j;
        continue;
      }

      // Words (identifiers, keywords)
      if (/[a-zA-Z_$]/.test(ch)) {
        let j = i;
        while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j])) j++;
        const word = line.slice(i, j);
        if (_KEYWORDS.has(word)) {
          tokens.push({ type: 'keyword', value: word });
        } else if (/^[A-Z]/.test(word)) {
          tokens.push({ type: 'type', value: word });
        } else if (line[j] === '(') {
          tokens.push({ type: 'func', value: word });
        } else {
          tokens.push({ type: 'ident', value: word });
        }
        i = j;
        continue;
      }

      // Multi-char operators
      const two = line.slice(i, i + 2);
      if (two === '=>' || two === '->' || two === '::' || two === '?.' || two === '??' || two === '!=') {
        tokens.push({ type: 'punct', value: two });
        i += 2;
        continue;
      }

      // Single-char punctuation
      tokens.push({ type: 'punct', value: ch });
      i++;
    }

    // Colorize tokens
    return tokens.map(t => {
      switch (t.type) {
        case 'keyword': return _SH.KEYWORD + t.value + _SH.RST;
        case 'string':  return _SH.STRING + t.value + _SH.RST;
        case 'number':  return _SH.NUMBER + t.value + _SH.RST;
        case 'comment': return _SH.COMMENT + t.value + _SH.RST;
        case 'type':    return _SH.TYPE + t.value + _SH.RST;
        case 'func':    return _SH.FUNC + t.value + _SH.RST;
        case 'punct':   return _SH.PUNCT + t.value + _SH.RST;
        default:        return t.value;
      }
    }).join('');
  }).join('\n');
}

// ── Full-text rendering ──────────────────────────────────────────────────────

/**
 * Convert markdown text to ANSI-formatted terminal output.
 * Supports code blocks with syntax highlighting.
 * @param {string} text - Raw markdown text
 * @returns {string} ANSI-formatted text
 */
export function renderMarkdown(text) {
  if (!text || typeof text !== 'string') return text;

  const lines = text.split('\n');
  const result = [];
  let tableBuf = [];
  let codeBuf = null;  // null = not in code block, { lang, lines } = inside
  const cols = process.stdout.columns || parseInt(process.env.COLUMNS) || 80;
  const codeWidth = Math.min(cols - 4, 100);

  for (const line of lines) {
    const trimmed = line.trim();

    // Code block start: ```lang
    if (trimmed.startsWith('```') && codeBuf === null) {
      if (tableBuf.length > 0) {
        result.push(renderTable(tableBuf));
        tableBuf = [];
      }
      const lang = trimmed.substring(3).trim().toLowerCase();
      codeBuf = { lang, lines: [] };
      continue;
    }

    // Code block end: ```
    if (trimmed === '```' && codeBuf !== null) {
      const code = codeBuf.lines.join('\n');
      const highlighted = highlightCode(code, codeBuf.lang);
      result.push('');
      for (const hl of highlighted.split('\n')) {
        result.push('    ' + hl);
      }
      result.push('');
      codeBuf = null;
      continue;
    }

    // Inside code block — collect raw lines (no markdown processing)
    if (codeBuf !== null) {
      codeBuf.lines.push(line);
      continue;
    }

    // Normal markdown processing
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableBuf.push(line);
      continue;
    }
    if (tableBuf.length > 0) {
      result.push(renderTable(tableBuf));
      tableBuf = [];
    }
    result.push(renderLine(line));
  }

  // Flush remaining buffers
  if (codeBuf !== null) {
    const code = codeBuf.lines.join('\n');
    const highlighted = highlightCode(code, codeBuf.lang);
    result.push('');
    for (const hl of highlighted.split('\n')) {
      result.push('    ' + hl);
    }
    result.push('');
  }
  if (tableBuf.length > 0) {
    result.push(renderTable(tableBuf));
  }

  return result.join('\n');
}
