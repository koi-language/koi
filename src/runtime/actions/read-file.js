/**
 * Read File Action - Read file contents without using shell.
 *
 * Dedicated action so the LLM doesn't need to use shell with cat/head/tail.
 * Supports reading full files or specific line ranges.
 * Permission: per directory, shared with edit_file/write_file/search.
 */

import fs from 'fs';
import path from 'path';
import { cliLogger } from '../cli-logger.js';
import { cliSelect } from '../cli-select.js';
import { getFilePermissions } from '../file-permissions.js';

export default {
  type: 'read_file',
  intent: 'read_file',
  description: 'Read a file\'s contents. Returns the text with line numbers. Fields: "path" (file path), optional "offset" (start line, 1-based, default 1), optional "limit" (number of lines, default 2000). Lines longer than 2000 chars are truncated. If path is a directory, lists its contents. Returns: { success, content, totalLines, path }',
  thinkingHint: (action) => `Reading ${action.path ? path.basename(action.path) : 'file'}`,
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
      offset: { type: 'number', description: 'Start reading from this line number (1-based, optional)' },
      limit: { type: 'number', description: 'Maximum number of lines to read (optional)' }
    },
    required: ['path']
  },

  examples: [
    { actionType: 'direct', intent: 'read_file', path: 'src/cli/koi.js' },
    { actionType: 'direct', intent: 'read_file', path: 'src/cli/koi.js', offset: 10, limit: 50 }
  ],

  async execute(action, agent) {
    const filePath = action.path;
    if (!filePath) throw new Error('read_file: "path" field is required');

    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    // Check directory permission
    const permissions = getFilePermissions(agent);
    const targetDir = fs.statSync(resolvedPath).isDirectory() ? resolvedPath : path.dirname(resolvedPath);

    if (!permissions.isAllowed(resolvedPath, 'read')) {
      cliLogger.clearProgress();
      const agentName = agent?.name || 'Agent';
      cliLogger.print(`📖 ${agentName} wants to read: \x1b[33m${filePath}\x1b[0m`);

      const value = await cliSelect('Allow reading files in this directory?', [
        { title: 'Yes', value: 'yes', description: 'Allow this time' },
        { title: 'Always allow', value: 'always', description: 'Always allow in this directory' },
        { title: 'No', value: 'no', description: 'Deny access' }
      ]);

      if (value === 'always') {
        permissions.allow(targetDir, 'read');
      } else if (value !== 'yes') {
        cliLogger.print(`\x1b[2mSkipped\x1b[0m`);
        return { success: false, denied: true, message: 'User denied file access' };
      }
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolvedPath);
      const listing = entries.map(e => {
        const full = path.join(resolvedPath, e);
        try {
          const s = fs.statSync(full);
          return s.isDirectory() ? `${e}/` : e;
        } catch {
          return e;
        }
      });
      return { success: true, path: filePath, type: 'directory', entries: listing };
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const allLines = content.split('\n');

    const MAX_LINES = 2000;
    const MAX_LINE_LENGTH = 2000;

    const offset = Math.max(1, action.offset || 1);
    const limit = action.limit || MAX_LINES;
    const startIdx = offset - 1;
    const endIdx = Math.min(startIdx + limit, allLines.length);
    const selectedLines = allLines.slice(startIdx, endIdx);

    // Format with line numbers, truncating long lines
    const numbered = selectedLines.map((line, i) => {
      const lineNum = String(startIdx + i + 1).padStart(5);
      const truncated = line.length > MAX_LINE_LENGTH
        ? line.substring(0, MAX_LINE_LENGTH) + '...'
        : line;
      return `${lineNum} ${truncated}`;
    }).join('\n');

    const wasTruncated = endIdx < allLines.length && !action.limit;

    return {
      success: true,
      path: filePath,
      content: numbered,
      totalLines: allLines.length,
      from: offset,
      to: endIdx,
      ...(wasTruncated && { truncated: true, hint: `File has ${allLines.length} lines. Use offset/limit to read more.` })
    };
  }
};
