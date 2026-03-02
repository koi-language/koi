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
 */

/**
 * Convert markdown text to ANSI-formatted terminal output.
 * @param {string} text - Raw markdown text
 * @returns {string} ANSI-formatted text
 */
export function renderMarkdown(text) {
  if (!text || typeof text !== 'string') return text;

  const lines = text.split('\n');
  const rendered = lines.map(line => renderLine(line));
  return rendered.join('\n');
}

function renderLine(line) {
  const trimmed = line.trim();

  // Horizontal rules: ---, ___, ***
  if (/^[-_*]{3,}\s*$/.test(trimmed)) {
    const cols = process.stdout.columns || parseInt(process.env.COLUMNS) || 80;
    return '\x1b[2m' + '─'.repeat(Math.min(cols, 60)) + '\x1b[0m';
  }

  // Headings
  if (trimmed.startsWith('### ')) {
    return '\x1b[1m' + renderInline(trimmed.substring(4)) + '\x1b[0m';
  }
  if (trimmed.startsWith('## ')) {
    return '\x1b[1m' + renderInline(trimmed.substring(3)) + '\x1b[0m';
  }
  if (trimmed.startsWith('# ')) {
    return '\x1b[1;4m' + renderInline(trimmed.substring(2)) + '\x1b[0m';
  }

  return renderInline(line);
}

function renderInline(text) {
  // Inline code: `code` → cyan
  text = text.replace(/`([^`]+)`/g, '\x1b[36m$1\x1b[39m');

  // Bold: **text** → bold
  text = text.replace(/\*\*([^*]+)\*\*/g, '\x1b[1m$1\x1b[22m');

  // Italic: *text* → italic (but not ** which is already handled)
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '\x1b[3m$1\x1b[23m');

  return text;
}
