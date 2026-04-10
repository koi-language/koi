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

import { t } from '../../i18n.js';
import { getFilePermissions, runFilePermDialog } from '../../code/file-permissions.js';
import { sessionTracker } from '../../state/session-tracker.js';
import { channel } from '../../io/channel.js';
import { buildDiffPayloadFromContent, buildDiffPayloadFromNewFile } from '../../util/diff-render.js';

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

    // Build structured diff payload (GUI renders natively, terminal → ANSI)
    const diffPayload = exists
      ? buildDiffPayloadFromContent(oldContent, newContent, resolvedPath, 'Update')
      : buildDiffPayloadFromNewFile(newContent, resolvedPath);

    // No real changes (only trailing whitespace differences)
    if (exists && !diffPayload) {
      channel.print(`\x1b[2m${t('noChanges')}\x1b[0m`);
      return { success: true, path: filePath, noChanges: true };
    }

    if (diffPayload) {
      diffPayload.beforeContent = oldContent; // for GUI revert
      diffPayload.afterContent = newContent; // for GUI re-apply after denial
      diffPayload.diffId = `diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    channel.clearProgress();
    await channel.showDiff(diffPayload);

    // Check permissions (shared across all file actions)
    const permissions = getFilePermissions(agent);
    let permitted = permissions.isAllowed(resolvedPath, 'write');

    if (!permitted) {
      const agentName = agent?.name || 'Agent';
      const _dirBase = path.basename(path.dirname(resolvedPath));
      const _header = `${agentName} ${exists ? t('wantsToEdit') : t('wantsToCreate')}`.replace(':', '');
      const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
      const _isInProject = resolvedPath.startsWith(path.resolve(projectRoot) + path.sep);
      const _acceptLabel = _isInProject ? t('permAcceptEdits') || 'Accept all edits in this project' : `${t('permAlwaysAllow')} (${_dirBase}/)`;
      const value = await runFilePermDialog(() => channel.select('', [
        { title: t('permYes'), value: 'yes' },
        { title: _acceptLabel, value: 'always' },
        { title: 'No, but give feedback', value: 'feedback' },
        { title: t('permNo'), value: 'no' }
      ], 0, { meta: { type: 'bash', header: _header, command: `${exists ? 'Edit' : 'Write'}(${filePath})` } }));

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
        if (channel.updateDiff && diffPayload?.diffId) await channel.updateDiff({ diffId: diffPayload.diffId, applied: false });
        return { success: false, denied: true, feedback, message: `User rejected the edit with feedback: ${feedback}` };
      }
    }

    if (!permitted) {
      if (channel.updateDiff && diffPayload?.diffId) await channel.updateDiff({ diffId: diffPayload.diffId, applied: false });
      return { success: false, denied: true, message: 'User denied file change' };
    }

    // Ensure directory exists
    const parentDir = path.dirname(resolvedPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(resolvedPath, newContent, 'utf8');
    if (sessionTracker) sessionTracker.trackFile(resolvedPath, oldContent);
    // Schedule background re-indexing after file changes
    try { const { backgroundTaskManager } = await import('../../api/background-task-manager.js'); backgroundTaskManager.scheduleReindex(); } catch {}

    return { success: true, path: filePath };
  }
};
