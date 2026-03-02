/**
 * Shared diff rendering with syntax highlighting.
 * Used by edit-file.js, write-file.js, and session-diff.js actions.
 *
 * Claude Code style:
 *   - Line numbers on the left
 *   - Red background for removed lines, green for added
 *   - Syntax highlighting preserved on colored backgrounds
 *   - Lines padded to full terminal width
 */

import path from 'path';

// ─── Syntax Highlighting ───────────────────────────────────────────────

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'class', 'extends', 'new',
  'this', 'super', 'import', 'export', 'from', 'default', 'try', 'catch',
  'throw', 'finally', 'async', 'await', 'yield', 'typeof', 'instanceof',
  'in', 'of', 'delete', 'void', 'null', 'undefined', 'true', 'false',
  'static', 'get', 'set'
]);

const PY_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break',
  'continue', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise',
  'with', 'yield', 'lambda', 'pass', 'None', 'True', 'False', 'and', 'or',
  'not', 'in', 'is', 'global', 'nonlocal', 'del', 'assert', 'async', 'await',
  'self', 'cls'
]);

export function getKeywords(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.py') return PY_KEYWORDS;
  return JS_KEYWORDS;
}

/**
 * Apply syntax highlighting to a line of code.
 * Uses foreground-only ANSI codes so the background color is preserved.
 * @param {boolean} bright - Use bright/vivid colors (for text on colored backgrounds)
 */
export function syntaxHighlight(text, defaultFg, keywords, bright = false) {
  // Color palettes: normal (context lines) vs bright (on red/green bg)
  const colors = bright
    ? { comment: '\x1b[38;5;248m', string: '\x1b[38;5;116m', keyword: '\x1b[38;5;111m', number: '\x1b[38;5;218m' }
    : { comment: '\x1b[90m', string: '\x1b[36m', keyword: '\x1b[94m', number: '\x1b[35m' };

  let result = '';
  let i = 0;

  while (i < text.length) {
    // Single-line comment: // ...
    if (text[i] === '/' && text[i + 1] === '/') {
      result += `${colors.comment}${text.substring(i)}${defaultFg}`;
      break;
    }

    // Single-line comment: # ... (Python)
    if (text[i] === '#' && keywords === PY_KEYWORDS) {
      result += `${colors.comment}${text.substring(i)}${defaultFg}`;
      break;
    }

    // Strings: '...', "...", `...`
    if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === quote) { j++; break; }
        j++;
      }
      result += `${colors.string}${text.substring(i, j)}${defaultFg}`;
      i = j;
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(text[i])) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j])) j++;
      const word = text.substring(i, j);
      if (keywords.has(word)) {
        result += `${colors.keyword}${word}${defaultFg}`;
      } else {
        result += word;
      }
      i = j;
      continue;
    }

    // Numbers
    if (/\d/.test(text[i])) {
      let j = i;
      while (j < text.length && /[\d.xXa-fA-F_]/.test(text[j])) j++;
      result += `${colors.number}${text.substring(i, j)}${defaultFg}`;
      i = j;
      continue;
    }

    result += text[i];
    i++;
  }

  return result;
}

/**
 * Calculate visible length of a string (excluding ANSI escape codes).
 */
export function visibleLength(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Pad a line with spaces to fill the terminal width, preserving background color.
 */
export function padToWidth(str, totalWidth) {
  const visible = visibleLength(str);
  if (visible >= totalWidth) return str;
  return str + ' '.repeat(totalWidth - visible);
}

/**
 * Render a single diff line (context, remove, or add) with syntax highlighting
 * and padded to full terminal width.
 */
export function renderDiffLine(type, lineNum, text, filePath) {
  const termWidth = process.stdout.columns || 80;
  const keywords = getKeywords(filePath);
  const num = String(lineNum).padStart(5);

  // Colors: muted/subdued backgrounds so the diff is readable without being jarring.
  // Uses 24-bit truecolor for precise low-saturation tones.
  // - Removed: muted dark brownish-red bg, light text
  // - Added: muted dark olive-green bg, light text
  // - Context: no bg, dim text
  const REMOVE_BG = '\x1b[48;5;52m';
  const REMOVE_FG = '\x1b[38;5;255m';
  const REMOVE_NUM = '\x1b[38;5;174m';
  const ADD_BG = '\x1b[48;5;22m';
  const ADD_FG = '\x1b[38;5;255m';
  const ADD_NUM = '\x1b[38;5;114m';

  if (type === 'context') {
    const defaultFg = '\x1b[0m';
    const highlighted = syntaxHighlight(text, defaultFg, keywords, false);
    const raw = `\x1b[2m${num}\x1b[0m  ${highlighted}`;
    return padToWidth(raw, termWidth);
  } else if (type === 'remove') {
    const highlighted = syntaxHighlight(text, REMOVE_FG, keywords, true);
    const raw = `${REMOVE_NUM}${num} -${REMOVE_FG}${highlighted}`;
    return `${REMOVE_BG}${padToWidth(raw, termWidth)}\x1b[0m`;
  } else if (type === 'add') {
    const highlighted = syntaxHighlight(text, ADD_FG, keywords, true);
    const raw = `${ADD_NUM}${num} +${ADD_FG}${highlighted}`;
    return `${ADD_BG}${ADD_FG}${padToWidth(raw, termWidth)}\x1b[0m`;
  }
  return text;
}

// ─── Unified Diff Parsing & Rendering ─────────────────────────────────

/**
 * Parse a unified diff string into hunks.
 * Each hunk has: { oldStart, oldCount, newStart, newCount, lines[] }
 * Each line: { type: 'context'|'remove'|'add', text: string }
 */
export function parseUnifiedDiff(diffStr) {
  const lines = diffStr.split('\n');
  const hunks = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;

    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    const bareHunk = !hunkMatch && /^@@\s*$/.test(line.trim());
    if (hunkMatch || bareHunk) {
      current = {
        oldStart: hunkMatch ? parseInt(hunkMatch[1], 10) : 1,
        oldCount: hunkMatch && hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: hunkMatch ? parseInt(hunkMatch[3], 10) : 1,
        newCount: hunkMatch && hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
        fuzzy: !hunkMatch
      };
      hunks.push(current);
      continue;
    }

    if (!current) continue;

    if (line.startsWith('-')) {
      current.lines.push({ type: 'remove', text: line.substring(1) });
    } else if (line.startsWith('+')) {
      current.lines.push({ type: 'add', text: line.substring(1) });
    } else if (line.startsWith(' ') || line === '') {
      current.lines.push({ type: 'context', text: line.startsWith(' ') ? line.substring(1) : line });
    }
  }

  return hunks;
}

/**
 * Build the diff header line: "Update <file>  +N  -N"
 */
function diffHeader(filePath, added, removed, label = 'Update') {
  const addPart = added  > 0 ? ` \x1b[32m+${added}\x1b[0m`  : '';
  const remPart = removed > 0 ? ` \x1b[31m-${removed}\x1b[0m` : '';
  return `\x1b[1m  ${label} ${filePath}\x1b[0m${addPart}${remPart}`;
}

/**
 * Render parsed hunks as colored terminal output for a single file.
 */
export function renderColoredDiff(hunks, filePath) {
  const output = [];

  // Count added/removed lines across all hunks for the header
  let added = 0, removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') added++;
      else if (line.type === 'remove') removed++;
    }
  }
  output.push(diffHeader(filePath, added, removed));

  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of hunk.lines) {
      if (line.type === 'context') {
        output.push(renderDiffLine('context', oldLine, line.text, filePath));
        oldLine++;
        newLine++;
      } else if (line.type === 'remove') {
        output.push(renderDiffLine('remove', oldLine, line.text, filePath));
        oldLine++;
      } else if (line.type === 'add') {
        output.push(renderDiffLine('add', newLine, line.text, filePath));
        newLine++;
      }
    }

    if (h < hunks.length - 1) {
      output.push(`\x1b[2m      ...\x1b[0m`);
    }
  }

  return output.join('\n');
}

// ─── Content Diff (LCS-based, for write-file) ────────────────────────

/**
 * Compute and render a colored diff between old and new file content.
 * Uses LCS algorithm with trailing-whitespace-tolerant matching.
 * This is THE single function for rendering diffs from content strings.
 */
export function renderContentDiff(oldContent, newContent, filePath) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  // For very large files, show full remove+add
  if (m * n > 5000 * 5000) {
    const output = [diffHeader(filePath, n, m)];
    for (let i = 0; i < m; i++) output.push(renderDiffLine('remove', i + 1, oldLines[i], filePath));
    for (let i = 0; i < n; i++) output.push(renderDiffLine('add', i + 1, newLines[i], filePath));
    return output.join('\n');
  }

  // LCS DP — compare with trimEnd() to ignore trailing whitespace
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1].trimEnd() === newLines[j - 1].trimEnd()) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const rawChanges = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1].trimEnd() === newLines[j - 1].trimEnd()) {
      rawChanges.unshift({ type: 'equal', line: newLines[j - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawChanges.unshift({ type: 'add', line: newLines[j - 1] });
      j--;
    } else {
      rawChanges.unshift({ type: 'remove', line: oldLines[i - 1] });
      i--;
    }
  }

  // Assign line numbers
  const allChanges = [];
  let oldLineNum = 1, newLineNum = 1;
  for (const change of rawChanges) {
    if (change.type === 'equal') {
      allChanges.push({ ...change, oldLineNum, newLineNum });
      oldLineNum++; newLineNum++;
    } else if (change.type === 'remove') {
      allChanges.push({ ...change, oldLineNum });
      oldLineNum++;
    } else if (change.type === 'add') {
      allChanges.push({ ...change, newLineNum });
      newLineNum++;
    }
  }

  // Filter to show only changed regions with ±3 context lines
  const contextSize = 3;
  const showLine = new Array(allChanges.length).fill(false);
  for (let k = 0; k < allChanges.length; k++) {
    if (allChanges[k].type !== 'equal') {
      for (let c = Math.max(0, k - contextSize); c <= Math.min(allChanges.length - 1, k + contextSize); c++) {
        showLine[c] = true;
      }
    }
  }

  // No changes? Return empty
  if (!showLine.some(Boolean)) return '';

  const added   = allChanges.filter(c => c.type === 'add').length;
  const removed = allChanges.filter(c => c.type === 'remove').length;
  const output = [diffHeader(filePath, added, removed)];
  let skipped = false;
  for (let k = 0; k < allChanges.length; k++) {
    if (showLine[k]) {
      if (skipped) {
        output.push(`\x1b[2m      ...\x1b[0m`);
        skipped = false;
      }
      const ch = allChanges[k];
      if (ch.type === 'equal') {
        output.push(renderDiffLine('context', ch.oldLineNum, ch.line, filePath));
      } else if (ch.type === 'remove') {
        output.push(renderDiffLine('remove', ch.oldLineNum, ch.line, filePath));
      } else if (ch.type === 'add') {
        output.push(renderDiffLine('add', ch.newLineNum, ch.line, filePath));
      }
    } else {
      skipped = true;
    }
  }

  return output.join('\n');
}

/**
 * Render a new file diff (all lines are additions).
 */
export function renderNewFileDiff(content, filePath) {
  const lines = content.split('\n');
  const output = [diffHeader(filePath, 0, 0, 'Create')];
  for (let i = 0; i < lines.length; i++) {
    output.push(renderDiffLine('context', i + 1, lines[i], filePath));
  }
  return output.join('\n');
}

/**
 * Render a full multi-file git diff (with "diff --git" headers) as colored output.
 * Splits by file sections and renders each with renderColoredDiff.
 */
export function renderFullDiff(gitDiffStr) {
  if (!gitDiffStr || gitDiffStr.startsWith('(')) return '';

  // Split into per-file sections by "diff --git" headers
  const sections = gitDiffStr.split(/^diff --git /m).filter(s => s.trim());
  const output = [];

  for (const section of sections) {
    // Extract filename from "a/path b/path" header
    const headerMatch = section.match(/^a\/(.+?)\s+b\/(.+)/m);
    const filePath = headerMatch ? headerMatch[2] : 'unknown';

    // Parse the hunks from this section
    const hunks = parseUnifiedDiff(section);
    if (hunks.length > 0) {
      output.push(renderColoredDiff(hunks, filePath));
    }
  }

  return output.join('\n\n');
}
