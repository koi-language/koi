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

// True when the resolved path lives under the project's `.koi/` directory —
// the agent's own scratch space (workflow runs, cached state, session logs,
// timeline JSON, etc.). User never reads these directly; surfacing them as
// "Create <file>.json" cards in the chat just adds noise. We treat anything
// under `.koi/` as internal by default; the agent can still flip
// `internal: false` to force-show a specific write.
function _isInternalPath(resolvedPath) {
  const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
  const koiDir = path.resolve(projectRoot, '.koi');
  return resolvedPath === koiDir || resolvedPath.startsWith(koiDir + path.sep);
}

export default {
  type: 'write_file',
  intent: 'write_file',
  description: 'Create a NEW file. Fields: "path" (file path — also accepts a `@mention` handle that resolves via MediaLibrary to overwrite a previously-tagged file; e.g. `path: "@hero_script"` overwrites whatever file is currently tagged @hero_script), "content" (full file content), "internal" (optional bool — true to write SILENTLY without the diff card / permission dialog; pass true for files only YOU read, like workflow state JSON or run-scoped scratch). Returns: { success, path }. ONLY for creating files that do not exist yet. To modify existing files (or to write to a `@mention` that already resolves to an existing file), use edit_file instead — write_file refuses to overwrite when the resolved path exists.',
  instructions: 'write_file is ONLY for creating NEW files. If the file already exists, you MUST use edit_file instead — even for large changes. Break big rewrites into multiple edit_file calls. NEVER use shell commands (cat >, echo >, tee, python scripts) to write files. Use "internal": true for files only the agent itself will read (workflow state, scratch JSON, run-scoped config) — they will not appear in the chat as a "Create file" card and need no permission. User-facing artifacts (final deliverables, scripts, content the user opens or reviews) must remain visible (omit "internal" or pass false).',
  thinkingHint: (action) => `Writing ${action.path ? path.basename(action.path) : 'file'}`,
  permission: 'write',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write. Accepts an absolute or relative path, or a `@mention` handle that resolves via MediaLibrary to a previously-tagged file (overwriting it). For brand-new files, pass a fresh path; for updating tagged ones, prefer edit_file.' },
      content: { type: 'string', description: 'Full file content to write. For HTML/CSS/code or any punctuation-heavy payload, do NOT inline it — set content to a heredoc reference "KOI_HEREDOC_<n>" and place the verbatim file body between ###KOI_HEREDOC_<n>_START### / ###KOI_HEREDOC_<n>_END### marker lines AFTER the YAML document. The body is taken literally, so colons, braces, quotes and # are all safe.' },
      internal: { type: 'boolean', description: 'Optional. When true, the write is silent: no "Create file" card in the chat, no permission dialog. Use for files only the agent itself will read (workflow state, scratch JSON). Paths under `.koi/` default to true automatically — pass false there to force-show a specific write to the user.' }
    },
    required: ['path', 'content']
  },

  async execute(action, agent) {
    let filePath = action.path;
    const newContent = action.content;

    if (!filePath) throw new Error('write_file: "path" field is required');
    if (newContent === undefined) throw new Error('write_file: "content" field is required');

    // Resolve `@mention` handles via the cross-project MediaLibrary —
    // same contract read_file uses. When the handle is unknown we
    // intentionally hard-fail rather than silently creating a file
    // named `@xxx` in cwd; that file would NEVER be findable later
    // because the rest of the system treats `@xxx` as a handle, not a
    // filename.
    {
      const { resolveMentionPath } = await import('./_resolve-mention-path.js');
      const r = await resolveMentionPath(filePath);
      if (!r.ok) return { success: false, error: `write_file: ${r.error}` };
      if (r.resolved) {
        channel.log(
          'write_file',
          `mention "${filePath}" → ${r.path}` +
            (r.matchCount > 1 ? ` (newest of ${r.matchCount} matches)` : ''),
        );
        filePath = r.path;
      }
    }

    const resolvedPath = path.resolve(filePath);
    const exists = fs.existsSync(resolvedPath);
    const oldContent = exists ? fs.readFileSync(resolvedPath, 'utf8') : '';

    // "Internal" writes bypass the diff card AND the permission dialog so
    // agent-only files (workflow state under `.koi/wfr-*/`, scratch JSON,
    // etc.) don't pollute the chat or stall on a permission prompt.
    // Resolution order:
    //   1. Explicit `action.internal` value wins (true or false).
    //   2. Otherwise, default to true when the resolved path is under
    //      the project's `.koi/` directory — that's the agent's own
    //      workspace and never user-facing.
    const isInternal = action.internal === true
      || (action.internal !== false && _isInternalPath(resolvedPath));

    // Build structured diff payload (GUI renders natively, terminal → ANSI)
    const diffPayload = exists
      ? buildDiffPayloadFromContent(oldContent, newContent, resolvedPath, 'Update')
      : buildDiffPayloadFromNewFile(newContent, resolvedPath);

    // No real changes (only trailing whitespace differences)
    if (exists && !diffPayload) {
      if (!isInternal) channel.print(`\x1b[2m${t('noChanges')}\x1b[0m`);
      return { success: true, path: filePath, noChanges: true };
    }

    if (diffPayload) {
      diffPayload.beforeContent = oldContent; // for GUI revert
      diffPayload.afterContent = newContent; // for GUI re-apply after denial
      diffPayload.diffId = `diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    if (!isInternal) {
      channel.clearProgress();
      await channel.showDiff(diffPayload);
    } else {
      // Still log to the file channel so debugging / audit trails see
      // the write even when the chat doesn't.
      channel.log('write_file', `internal write → ${resolvedPath} (${newContent.length} bytes)`);
    }

    // Check permissions (shared across all file actions).
    // Internal writes skip the permission flow — they're agent self-state,
    // not user-visible mutations, and stopping on a permission dialog would
    // block silent workflow checkpointing.
    const permissions = getFilePermissions(agent);
    let permitted = isInternal || permissions.isAllowed(resolvedPath, 'write');

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
      ], 0, { meta: {
        type: 'bash',
        header: _header,
        command: `${exists ? 'Edit' : 'Write'}(${filePath})`,
        // WRITE category → dialog title reads "Allow Braxil to write
        // files…" instead of the generic "run a command on your
        // computer?".
        permissionCategory: 'WRITE',
      } }));

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

    // Auto-memory: every artefact the agent creates becomes recall-able later
    // (so a future turn can `recall_memory` "the email sequence" and get the
    // file path, instead of falling back to a disk search). Fire-and-forget,
    // upserted by a stable per-path title so EDITS update the same note instead
    // of piling up duplicates. Skips internal/scratch writes. Cheap — the
    // "summary" is the first heading / first non-empty line, no LLM call.
    if (!action.internal) {
      (async () => {
        try {
          const memory = await import('../../memory/index.js');
          await memory.ensureInit(agent);
          const base = path.basename(resolvedPath);
          let h = 0;
          for (let i = 0; i < resolvedPath.length; i++) h = (h * 31 + resolvedPath.charCodeAt(i)) | 0;
          const firstLine = (newContent.split('\n').find((l) => l.trim()) || '')
            .replace(/^#+\s*/, '').trim().slice(0, 140);
          await memory.write({
            title: `creation-${base.replace(/\.[^.]+$/, '')}-${(h >>> 0).toString(36).slice(0, 5)}`,
            description: `${resolvedPath} — ${firstLine || base}`.slice(0, 200),
            type: 'insight',
            project: ['creation', agent?.name || 'file'],
            confidence: 'validated',
            body: `File created/updated by the agent.\n\nPath: ${resolvedPath}\nFirst line: ${firstLine}\n\nTo read it verbatim, \`read_file\` this path.`,
          });
        } catch { /* auto-memory is best-effort — never block or fail the write */ }
      })();
    }

    return { success: true, path: filePath };
  }
};
