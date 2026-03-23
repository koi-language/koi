/**
 * Write File Action - Write/edit files with diff preview and permission system.
 *
 * Permission model:
 *   - READ:  per DIRECTORY.
 *   - WRITE: per FILE (narrow) or per DIRECTORY (broad — only if explicitly granted).
 *   - "Always allow" grants THIS FILE only; never the whole directory.
 *   - In-memory only (reset between sessions).
 *   - Serial dialog queue: parallel write_file calls show dialogs one at a time.
 */

import fs from 'fs';
import path from 'path';
import { cliLogger } from '../cli-logger.js';
import { cliSelect } from '../cli-select.js';
import { cliInput } from '../cli-input.js';
import { renderContentDiff, renderNewFileDiff } from '../diff-render.js';
import { getFilePermissions, runFilePermDialog } from '../file-permissions.js';
import { sessionTracker } from '../session-tracker.js';

export default {
  type: 'write_file',
  intent: 'write_file',
  description: 'Create a NEW file. Fields: "path" (file path), "content" (full file content). Returns: { success, path }. ONLY for creating files that do not exist yet. To modify existing files, use edit_file instead.',
  instructions: 'write_file is ONLY for creating NEW files. If the file already exists, you MUST use edit_file instead — even for large changes. Break big rewrites into multiple edit_file calls. NEVER use shell commands (cat >, echo >, tee, python scripts) to write files.',
  thinkingHint: 'Writing file',
  permission: 'write',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Full file content to write' }
    },
    required: ['path', 'content']
  },

  async execute(action, agent) {
    const filePath = action.path;
    const newContent = action.content;

    if (!filePath) throw new Error('write_file: "path" field is required');
    if (newContent === undefined) throw new Error('write_file: "content" field is required');

    const resolvedPath = path.resolve(filePath);
    const exists = fs.existsSync(resolvedPath);
    const oldContent = exists ? fs.readFileSync(resolvedPath, 'utf8') : '';

    // Generate diff preview (single shared function)
    const diff = exists
      ? renderContentDiff(oldContent, newContent, filePath)
      : renderNewFileDiff(newContent, filePath);

    // No real changes (only trailing whitespace differences)
    if (exists && !diff) {
      cliLogger.print(`\x1b[2mNo changes\x1b[0m`);
      return { success: true, path: filePath, noChanges: true };
    }

    cliLogger.clearProgress();
    cliLogger.print(`\n${diff}\n`);

    // Check permissions (shared across all file actions)
    const permissions = getFilePermissions(agent);
    let permitted = permissions.isAllowed(resolvedPath, 'write');

    if (permitted) {
      const reason = permissions.autoApprovalReason(resolvedPath);
      if (reason) cliLogger.print(`\x1b[2m✓ Auto-approved: ${filePath} (${reason})\x1b[0m`);
    } else {
      const agentName = agent?.name || 'Agent';
      cliLogger.print(`🔧 ${agentName} wants to ${exists ? 'edit' : 'create'}: \x1b[33m${filePath}\x1b[0m`);

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

    // Ensure directory exists
    const parentDir = path.dirname(resolvedPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(resolvedPath, newContent, 'utf8');
    if (sessionTracker) sessionTracker.trackFile(resolvedPath, oldContent);
    cliLogger.print(`\x1b[2mDone\x1b[0m`);

    return { success: true, path: filePath };
  }
};
