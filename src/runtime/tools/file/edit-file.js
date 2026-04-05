/**
 * Edit File Action - Apply a unified diff to a file.
 *
 * The LLM sends a unified diff (like git diff), the action:
 *   1. Parses the diff hunks
 *   2. Displays a colored preview (red bg = removed, green bg = added)
 *   3. Asks for permission
 *   4. Applies the changes
 *
 * Permission model: shared with write-file (per file, never auto-grants directory).
 */

import fs from 'fs';
import path from 'path';

import { t } from '../../i18n.js';
import { parseUnifiedDiff, buildDiffPayloadFromHunks } from '../../util/diff-render.js';
import { getFilePermissions, runFilePermDialog } from '../../code/file-permissions.js';

/**
 * Generate a unified diff string from two file contents.
 * Uses a simple LCS-based line diff — no external dependencies.
 * Returns null if contents are identical.
 */
function _generateUnifiedDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Quick identity check
  if (oldText === newText) return null;

  // Build edit script using Myers-like diff (simplified: line-level LCS)
  const edits = []; // { type: ' '|'+'|'-', line, oldIdx, newIdx }
  let oi = 0, ni = 0;

  // Simple O(n*m) LCS to find common lines
  const lcsLen = [];
  for (let i = 0; i <= oldLines.length; i++) {
    lcsLen[i] = new Array(newLines.length + 1).fill(0);
  }
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcsLen[i][j] = lcsLen[i + 1][j + 1] + 1;
      } else {
        lcsLen[i][j] = Math.max(lcsLen[i + 1][j], lcsLen[i][j + 1]);
      }
    }
  }

  oi = 0; ni = 0;
  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      edits.push({ type: ' ', line: oldLines[oi], oldIdx: oi, newIdx: ni });
      oi++; ni++;
    } else if (ni < newLines.length && (oi >= oldLines.length || lcsLen[oi][ni + 1] >= lcsLen[oi + 1][ni])) {
      edits.push({ type: '+', line: newLines[ni], newIdx: ni });
      ni++;
    } else {
      edits.push({ type: '-', line: oldLines[oi], oldIdx: oi });
      oi++;
    }
  }

  // Group edits into hunks (context of 3 lines)
  const CTX = 3;
  const hunks = [];
  let hunkStart = -1;
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== ' ') {
      const from = Math.max(0, i - CTX);
      const to = Math.min(edits.length - 1, i + CTX);
      if (hunkStart < 0) hunkStart = from;
      // Extend current hunk or start new
      if (hunks.length > 0 && from <= hunks[hunks.length - 1].end + 1) {
        hunks[hunks.length - 1].end = to;
      } else {
        hunks.push({ start: from, end: to });
      }
    }
  }

  if (hunks.length === 0) return null;

  // Render unified diff format
  const lines = [];
  for (const hunk of hunks) {
    const hunkEdits = edits.slice(hunk.start, hunk.end + 1);
    const oldStart = (hunkEdits.find(e => e.oldIdx != null)?.oldIdx ?? 0) + 1;
    const newStart = (hunkEdits.find(e => e.newIdx != null)?.newIdx ?? 0) + 1;
    const oldCount = hunkEdits.filter(e => e.type !== '+').length;
    const newCount = hunkEdits.filter(e => e.type !== '-').length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const e of hunkEdits) {
      lines.push(`${e.type}${e.line}`);
    }
  }

  return lines.join('\n');
}
import { sessionTracker } from '../../state/session-tracker.js';
import { channel } from '../../io/channel.js';

/**
 * Apply parsed hunks to file content.
 * Returns the new content or throws on mismatch.
 */
function applyHunks(content, hunks) {
  const lines = content.split('\n');
  // Sort hunks by oldStart descending so we apply from bottom to top
  // (this way line numbers don't shift as we apply earlier hunks)
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sorted) {
    const startIdx = hunk.oldStart - 1; // 0-based

    // Collect old lines (context + remove) for matching
    const oldLines = [];
    for (const line of hunk.lines) {
      if (line.type === 'context' || line.type === 'remove') {
        oldLines.push(line.text);
      }
    }

    // Multi-pass fuzzy search across entire file
    const match = findHunkPosition(lines, oldLines, startIdx, hunk.fuzzy, hunk.lines);
    if (match.idx === -1) {
      const err = new Error(`Hunk at line ${hunk.oldStart} does not match file content. Context lines don't match.`);
      err.failingLine = hunk.oldStart;
      throw err;
    }

    if (match.removeOnly) {
      // Pass 5 matched: only the remove lines were verified, context is untrusted.
      // Only splice the remove lines and insert add lines in their place.
      // match.idx is where the remove lines start in the file.
      const removeLines = hunk.lines.filter(l => l.type === 'remove');
      const addLines = hunk.lines.filter(l => l.type === 'add').map(l => l.text);

      // Update hunk positions for rendering
      hunk.oldStart = match.idx + 1;
      hunk.newStart = match.idx + 1;

      lines.splice(match.idx, removeLines.length, ...addLines);
    } else {
      const matchIdx = match.idx;

      // Update hunk's oldStart with actual matched position (for correct line numbers in rendering)
      hunk.oldStart = matchIdx + 1; // 1-based
      hunk.newStart = matchIdx + 1;

      // Rebuild newLines using actual file content for context lines.
      // This prevents hallucinated context lines from corrupting the file.
      const rebuiltNewLines = [];
      let fileIdx = matchIdx;
      for (const line of hunk.lines) {
        if (line.type === 'context') {
          rebuiltNewLines.push(lines[fileIdx]);
          fileIdx++;
        } else if (line.type === 'remove') {
          fileIdx++;
        } else if (line.type === 'add') {
          rebuiltNewLines.push(line.text);
        }
      }

      lines.splice(matchIdx, oldLines.length, ...rebuiltNewLines);
    }
  }

  return lines.join('\n');
}

/**
 * Find where a hunk's old lines match in the file.
 * Multi-pass strategy for maximum robustness against LLM-generated diffs:
 *   Pass 1: Exact match at expected position
 *   Pass 2: Exact match nearby (±50 lines)
 *   Pass 3: Exact match across the entire file
 *   Pass 4: Whitespace-normalized match across entire file
 *   Pass 5: Partial context match (≥70% lines match, whitespace-normalized)
 *   Pass 6: Match using only remove lines (ignore context lines) across entire file
 */
function findHunkPosition(fileLines, oldLines, expectedIdx, fuzzy = false, hunkLines = null) {
  // Pass 1: exact position
  if (linesMatch(fileLines, oldLines, expectedIdx, false)) {
    return { idx: expectedIdx, removeOnly: false };
  }

  // Pass 2: nearby (±50 lines), strict
  for (let offset = 1; offset <= 50; offset++) {
    if (expectedIdx - offset >= 0 && linesMatch(fileLines, oldLines, expectedIdx - offset, false)) {
      return { idx: expectedIdx - offset, removeOnly: false };
    }
    if (expectedIdx + offset < fileLines.length && linesMatch(fileLines, oldLines, expectedIdx + offset, false)) {
      return { idx: expectedIdx + offset, removeOnly: false };
    }
  }

  // Pass 3: entire file, strict
  for (let idx = 0; idx < fileLines.length; idx++) {
    if (Math.abs(idx - expectedIdx) <= 50) continue; // already checked
    if (linesMatch(fileLines, oldLines, idx, false)) {
      return { idx, removeOnly: false };
    }
  }

  // Pass 4: entire file, whitespace-normalized (trim both leading & trailing)
  for (let idx = 0; idx < fileLines.length; idx++) {
    if (linesMatch(fileLines, oldLines, idx, true)) {
      return { idx, removeOnly: false };
    }
  }

  // Pass 5: partial context match — tolerate up to 30% mismatched context lines.
  // LLMs frequently hallucinate some context lines but get the overall position right.
  // Only triggers when there are enough lines (≥4) to avoid false positives.
  if (oldLines.length >= 4) {
    for (let idx = 0; idx < fileLines.length; idx++) {
      if (idx + oldLines.length > fileLines.length) break;
      let matches = 0;
      for (let i = 0; i < oldLines.length; i++) {
        const a = fileLines[idx + i];
        const b = oldLines[i];
        if (a === b || a.trimEnd() === b.trimEnd() || a.trim() === b.trim()) matches++;
      }
      if (matches >= Math.ceil(oldLines.length * 0.7)) {
        return { idx, removeOnly: false };
      }
    }
  }

  // Pass 6: match using only the remove lines (the actual lines being changed).
  // LLMs frequently hallucinate context lines but get the changed lines right.
  // Returns the index where the REMOVE lines start (not the hunk start),
  // and removeOnly=true so the caller knows context is untrusted.
  if (hunkLines) {
    const removeLines = hunkLines.filter(l => l.type === 'remove').map(l => l.text);
    if (removeLines.length > 0) {
      for (let idx = 0; idx < fileLines.length; idx++) {
        if (linesMatch(fileLines, removeLines, idx, true)) {
          return { idx, removeOnly: true };
        }
      }
    }
  }

  return { idx: -1, removeOnly: false };
}

/**
 * Check if oldLines match fileLines starting at idx.
 * Tolerates trailing whitespace differences (very common in LLM-generated diffs
 * where blank lines lose their indentation whitespace).
 * When normalize=true, also tolerates leading whitespace differences (indentation).
 */
function linesMatch(fileLines, oldLines, idx, normalize = false) {
  if (idx + oldLines.length > fileLines.length) return false;
  for (let i = 0; i < oldLines.length; i++) {
    const a = fileLines[idx + i];
    const b = oldLines[i];
    if (a === b) continue;
    if (a.trimEnd() === b.trimEnd()) continue;
    if (normalize && a.trim() === b.trim()) continue;
    return false;
  }
  return true;
}

export default {
  type: 'edit_file',
  intent: 'edit_file',
  description: 'Edit a file using a unified diff. Provide "path" and "diff" (unified diff format with @@ hunks). Shows colored preview and asks permission. The diff format is the standard unified diff: lines starting with - are removed, + are added, space are context. Example diff: "@@ -10,3 +10,4 @@\\n context line\\n-old line\\n+new line\\n+added line\\n context". Returns: { success, path }',
  instructions: 'This is the ONLY correct way to modify existing files. NEVER use shell commands (sed, awk, echo >, python scripts, etc.) to edit files — always use edit_file instead.',
  thinkingHint: (action) => `Editing ${action.path || 'file'}`,
  permission: 'write',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      diff: { type: 'string', description: 'Unified diff with @@ hunks. Lines: " " context, "-" remove, "+" add.' }
    },
    required: ['path', 'diff']
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'edit_file',
      path: 'src/cli.js',
      diff: "@@ -15,3 +15,4 @@\n const COMMANDS = {\n   run: 'Compile and run',\n+  execute: 'Alias for run',\n   compile: 'Compile only',"
    }
  ],

  async execute(action, agent) {
    const filePath = action.path;
    let diffStr = action.diff;

    if (!filePath) throw new Error('edit_file: "path" field is required');

    // Fallback: if the model sent full file content instead of a unified diff,
    // compute the diff automatically so the user sees the same approval flow.
    if (!diffStr && action.content && typeof action.content === 'string') {
      const resolvedPath = path.resolve(filePath);
      const oldContent = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf8') : '';
      diffStr = _generateUnifiedDiff(oldContent, action.content);
      if (!diffStr) {
        return { success: true, path: filePath, note: 'No changes detected (content identical)' };
      }
    }

    if (!diffStr) throw new Error('edit_file: "diff" field is required');

    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');

    // Parse the diff
    const hunks = parseUnifiedDiff(diffStr);

    // No-op detection happens AFTER applying the diff (see below), by comparing
    // the final content to the original. Positional comparison (removes[i] === adds[i])
    // was removed because it incorrectly rejects diffs that reorder lines.

    if (hunks.length === 0) {
      return {
        success: false,
        error: 'Could not parse diff — no @@ hunk headers found.',
        fix: 'Rewrite the diff field using this EXACT format:\n'
          + '"diff": "@@\\n context line (unchanged)\\n-line to remove\\n+line to add\\n context line"'
          + '\n\nRULES:\n'
          + '- Start with @@ on its own line\n'
          + '- Context lines (unchanged) start with a SPACE character\n'
          + '- Lines to DELETE start with -\n'
          + '- Lines to ADD start with +\n'
          + '- Include 1-2 unchanged context lines before and after changes so the match is unique\n'
          + '- Do NOT use shell/sed. Retry edit_file with the corrected diff.'
      };
    }

    // Try applying the diff
    let newContent;
    try {
      newContent = applyHunks(content, hunks);
    } catch (err) {
      // Show surrounding file content to help the LLM write correct context lines.
      // Use the actual failing line (err.failingLine), not always hunks[0].
      const lines = content.split('\n');
      const failingLine = err.failingLine ?? hunks[0].oldStart;
      const around = Math.max(0, failingLine - 10);
      const windowEnd = Math.min(lines.length, around + 40);
      const snippet = lines.slice(around, windowEnd).map((l, i) => `${around + i + 1}: ${l}`).join('\n');

      return {
        success: false,
        error: err.message,
        fix: `The context lines in your diff do not match the actual file (${lines.length} lines total). `
          + `Here is what lines ${around + 1}–${windowEnd} look like:\n`
          + snippet + '\n\n'
          + 'IMPORTANT: Your previous read_file result may have been truncated. '
          + `Use read_file with offset and limit to read the exact area you need, e.g. `
          + `{ "path": "${filePath}", "offset": ${Math.max(1, failingLine - 5)}, "limit": 30 }. `
          + 'Then rewrite the diff with context lines that EXACTLY match the file. '
          + 'Do NOT use shell/sed. Retry edit_file.'
      };
    }

    // Detect no-op diffs (remove and add lines are identical — LLM generated garbage)
    if (newContent === content) {
      return {
        success: false,
        error: 'No-op diff: the remove and add lines are identical. The file would not change.',
        fix: 'Your diff does not make any actual changes. The - and + lines are the same. '
          + 'Re-read the file to find the exact line you need to change, then write a diff where '
          + 'the - line contains the CURRENT text and the + line contains the NEW text you want.'
      };
    }

    // Emit structured diff preview (GUI renders natively, terminal formats to ANSI)
    channel.clearProgress();
    await channel.showDiff(buildDiffPayloadFromHunks(hunks, resolvedPath, 'Update'));

    // Check permissions (shared across all file actions)
    const permissions = getFilePermissions(agent);
    let permitted = permissions.isAllowed(resolvedPath, 'write');

    if (!permitted) {
      const agentName = agent?.name || 'Agent';
      const _dirBase = path.basename(path.dirname(resolvedPath));
      const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
      const _isInProject = resolvedPath.startsWith(path.resolve(projectRoot) + path.sep);
      const _acceptLabel = _isInProject ? t('permAcceptEdits') || 'Accept all edits in this project' : `${t('permAlwaysAllow')} (${_dirBase}/)`;
      const value = await runFilePermDialog(() => channel.select('', [
        { title: t('permYes'), value: 'yes' },
        { title: _acceptLabel, value: 'always' },
        { title: 'No, but give feedback', value: 'feedback' },
        { title: t('permNo'), value: 'no' }
      ], 0, { meta: { type: 'bash', header: `${agentName} ${t('wantsToEdit')}`.replace(':', ''), command: `Edit(${filePath})` } }));

      if (value === 'always') {
        if (_isInProject) {
          permissions.enableAcceptEdits();
        } else {
          permissions.allowProject(resolvedPath);
        }
        permitted = true;
      } else if (value === 'yes') {
        permitted = true;
      } else if (value === 'feedback') {
        const feedback = await channel.prompt('> ');
        return { success: false, denied: true, feedback, message: `User rejected the edit with feedback: ${feedback}` };
      }
    }

    if (!permitted) {
      channel.print(`\x1b[2m${t('skipped')}\x1b[0m`);
      return { success: false, denied: true, message: 'User denied file change' };
    }

    fs.writeFileSync(resolvedPath, newContent, 'utf8');
    if (sessionTracker) sessionTracker.trackFile(resolvedPath, content);
    channel.print(`\x1b[2m${t('done')}\x1b[0m`);

    // Schedule background re-indexing after file changes
    try { const { backgroundTaskManager } = await import('../../api/background-task-manager.js'); backgroundTaskManager.scheduleReindex(); } catch {}

    return { success: true, path: filePath };
  }
};
