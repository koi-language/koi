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
import { cliLogger } from '../cli-logger.js';
import { cliSelect } from '../cli-select.js';
import { cliInput } from '../cli-input.js';
import { parseUnifiedDiff, renderColoredDiff } from '../diff-render.js';
import { getFilePermissions, runFilePermDialog } from '../file-permissions.js';
import { sessionTracker } from '../session-tracker.js';

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

    // Collect old lines (context + remove) and new lines (context + add)
    const oldLines = [];
    const newLines = [];
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        oldLines.push(line.text);
        newLines.push(line.text);
      } else if (line.type === 'remove') {
        oldLines.push(line.text);
      } else if (line.type === 'add') {
        newLines.push(line.text);
      }
    }

    // Verify context matches (multi-pass fuzzy search across entire file)
    let matchIdx = findHunkPosition(lines, oldLines, startIdx, hunk.fuzzy, hunk.lines);
    if (matchIdx === -1) {
      const err = new Error(`Hunk at line ${hunk.oldStart} does not match file content. Context lines don't match.`);
      err.failingLine = hunk.oldStart;
      throw err;
    }

    // Update hunk's oldStart with actual matched position (for correct line numbers in rendering)
    hunk.oldStart = matchIdx + 1; // 1-based
    hunk.newStart = matchIdx + 1;

    // Replace old lines with new lines
    lines.splice(matchIdx, oldLines.length, ...newLines);
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
 *   Pass 5: Match using only remove lines (ignore context lines) across entire file
 */
function findHunkPosition(fileLines, oldLines, expectedIdx, fuzzy = false, hunkLines = null) {
  // Pass 1: exact position
  if (linesMatch(fileLines, oldLines, expectedIdx, false)) {
    return expectedIdx;
  }

  // Pass 2: nearby (±50 lines), strict
  for (let offset = 1; offset <= 50; offset++) {
    if (expectedIdx - offset >= 0 && linesMatch(fileLines, oldLines, expectedIdx - offset, false)) {
      return expectedIdx - offset;
    }
    if (expectedIdx + offset < fileLines.length && linesMatch(fileLines, oldLines, expectedIdx + offset, false)) {
      return expectedIdx + offset;
    }
  }

  // Pass 3: entire file, strict
  for (let idx = 0; idx < fileLines.length; idx++) {
    if (Math.abs(idx - expectedIdx) <= 50) continue; // already checked
    if (linesMatch(fileLines, oldLines, idx, false)) {
      return idx;
    }
  }

  // Pass 4: entire file, whitespace-normalized (trim both leading & trailing)
  for (let idx = 0; idx < fileLines.length; idx++) {
    if (linesMatch(fileLines, oldLines, idx, true)) {
      return idx;
    }
  }

  // Pass 5: match using only the remove lines (the actual lines being changed).
  // LLMs frequently hallucinate context lines but get the changed lines right.
  if (hunkLines) {
    const removeLines = hunkLines.filter(l => l.type === 'remove').map(l => l.text);
    if (removeLines.length > 0) {
      // Find sequences of remove lines in the file
      for (let idx = 0; idx < fileLines.length; idx++) {
        if (linesMatch(fileLines, removeLines, idx, true)) {
          // Found the remove lines — figure out where the hunk actually starts
          // by counting how many context lines precede the first remove
          let contextBefore = 0;
          for (const hl of hunkLines) {
            if (hl.type === 'remove') break;
            if (hl.type === 'context') contextBefore++;
          }
          const hunkStart = idx - contextBefore;
          if (hunkStart >= 0) return hunkStart;
          return idx;
        }
      }
    }
  }

  return -1;
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
    const diffStr = action.diff;

    if (!filePath) throw new Error('edit_file: "path" field is required');
    if (!diffStr) throw new Error('edit_file: "diff" field is required');

    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');

    // Parse the diff
    const hunks = parseUnifiedDiff(diffStr);
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

    // Render colored diff preview
    const coloredOutput = renderColoredDiff(hunks, filePath);

    cliLogger.clearProgress();
    cliLogger.print(`\n${coloredOutput}\n`);

    // Check permissions (shared across all file actions)
    const permissions = getFilePermissions(agent);
    let permitted = permissions.isAllowed(resolvedPath, 'write');

    if (permitted) {
      const reason = permissions.autoApprovalReason(resolvedPath);
      if (reason) cliLogger.print(`\x1b[2m✓ Auto-approved: ${filePath} (${reason})\x1b[0m`);
    } else {
      const agentName = agent?.name || 'Agent';
      cliLogger.print(`🔧 ${agentName} wants to edit: \x1b[33m${filePath}\x1b[0m`);

      const value = await runFilePermDialog(() => cliSelect('Allow this file change?', [
        { title: 'Yes', value: 'yes', description: 'Apply this time' },
        { title: 'Always allow this file', value: 'always', description: 'Always allow writes to THIS file' },
        { title: 'No, but', value: 'feedback', description: 'Reject and give instructions to retry' },
        { title: 'No', value: 'no', description: 'Skip this change' }
      ]));

      if (value === 'always') {
        permissions.allowFile(resolvedPath);
        permitted = true;
      } else if (value === 'yes') {
        permitted = true;
      } else if (value === 'feedback') {
        const feedback = await cliInput('> ');
        cliLogger.print(`\x1b[2mSkipped\x1b[0m`);
        return { success: false, denied: true, feedback, message: `User rejected the edit with feedback: ${feedback}` };
      }
    }

    if (!permitted) {
      cliLogger.print(`\x1b[2mSkipped\x1b[0m`);
      return { success: false, denied: true, message: 'User denied file change' };
    }

    fs.writeFileSync(resolvedPath, newContent, 'utf8');
    if (sessionTracker) sessionTracker.trackFile(resolvedPath, content);
    cliLogger.print(`\x1b[2mDone\x1b[0m`);

    return { success: true, path: filePath };
  }
};
