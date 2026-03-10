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

// ── Inline formatting ────────────────────────────────────────────────────────

function renderInline(text) {
  // Inline code: `code` → cyan
  text = text.replace(/`([^`]+)`/g, '\x1b[36m$1\x1b[39m');

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

  // Headings
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

// ── Full-text rendering ──────────────────────────────────────────────────────

/**
 * Convert markdown text to ANSI-formatted terminal output.
 * @param {string} text - Raw markdown text
 * @returns {string} ANSI-formatted text
 */
export function renderMarkdown(text) {
  if (!text || typeof text !== 'string') return text;

  const lines = text.split('\n');
  const result = [];
  let tableBuf = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableBuf.push(line);
      continue;
    }
    // Non-table line — flush any buffered table
    if (tableBuf.length > 0) {
      result.push(renderTable(tableBuf));
      tableBuf = [];
    }
    result.push(renderLine(line));
  }

  // Flush remaining table
  if (tableBuf.length > 0) {
    result.push(renderTable(tableBuf));
  }

  return result.join('\n');
}
