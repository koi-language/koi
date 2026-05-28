/**
 * Return Action - Return final result
 */

import fs from 'fs';
import { taskManager } from '../../state/task-manager.js';

/**
 * Walk `data` and collect every string value whose KEY looks like a file path
 * field (imagePath, videoPath, audioPath, savedTo, filePath, localPath, path,
 * outputPath, ...) so we can verify the agent isn't returning a fabricated
 * location. We deliberately DO NOT inspect arbitrary string values — only
 * fields whose name advertises them as paths — to avoid false positives on
 * prompts, descriptions, URLs, etc.
 */
const PATH_KEY_RX = /(^|[_-])(path|pathname|savedto|saved_to|filepath|file_path|localpath|local_path|outputpath|output_path)$/i;

function _collectPathClaims(node, trail, out) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) _collectPathClaims(node[i], `${trail}[${i}]`, out);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const here = trail ? `${trail}.${k}` : k;
      if (typeof v === 'string' && PATH_KEY_RX.test(k)) {
        // Ignore remote URLs — only verify local filesystem claims.
        if (!/^https?:\/\//i.test(v) && !/^data:/i.test(v)) out.push({ field: here, value: v });
      } else {
        _collectPathClaims(v, here, out);
      }
    }
  }
}

export default {
  type: 'return',          // Mantener temporalmente
  intent: 'return',        // NUEVO: identificador semántico
  description: 'Return final result from action sequence. CRITICAL: Return RAW data structures (objects, arrays) NOT formatted strings or markdown tables. If playbook says "Return: { count, users: [array] }", return actual JSON array not a formatted table string.',
  thinkingHint: 'Finishing',
  permission: 'return',

  schema: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        description: 'Data to return as final result'
      }
    },
    required: ['data']
  },

  examples: [
    { type: 'return', data: { success: true, message: 'Completed' } },
    { type: 'return', data: { user: 'Alice', success: true } }
  ],

  // Executor function
  async execute(action, agent) {
    const data = action.data || action.result || {};

    // User-approval gate (belt-and-braces). The reactive agent loop in
    // agent.js already blocks unapproved returns before this executor runs;
    // this catches any non-reactive path that calls `return` directly. A task
    // flagged requiresApproval cannot be completed until the user has approved
    // it (recorded via `task_update approved:true`). A { success:false } return
    // is a legitimate failure report and is allowed through.
    if (data?.success !== false && agent?.name) {
      try {
        const ownTask = taskManager.list().find(
          (t) => t.owner === agent.name && t.status === 'in_progress'
        );
        if (ownTask && ownTask.requiresApproval === true && ownTask.approved !== true) {
          const note = (ownTask.approvalNote || '').trim()
            || '(no note provided — re-read the task description to determine what the user must approve)';
          const err = new Error(
            `return blocked — task #${ownTask.id} ("${ownTask.subject}") requires explicit USER APPROVAL before it can be completed, ` +
            `and the user's approval has not been recorded.\n\nWhat the user must approve:\n${note}\n\n` +
            `Ask the user via prompt_user, and once they approve call task_update { taskId: "${ownTask.id}", approved: true } before returning. ` +
            `Never set approved:true without an explicit go-ahead from the user.`
          );
          err.code = 'task_requires_user_approval';
          err.details = { taskId: ownTask.id };
          throw err;
        }
      } catch (e) {
        if (e?.code === 'task_requires_user_approval') throw e;
        // Any other failure looking up the task is non-fatal — don't trap a return on it.
      }
    }

    // Guard: every advertised filesystem path in the return payload must actually
    // exist on disk. This catches agents that hallucinate a result (typical failure
    // mode: the LLM skips generate_image / web_fetch and fabricates a plausible path
    // instead). Letting such returns through poisons downstream tools like
    // show_result and confuses the user. Fail LOUDLY at the boundary instead.
    const claims = [];
    _collectPathClaims(data, '', claims);
    const missing = claims.filter((c) => {
      try { return !fs.existsSync(c.value); } catch { return true; }
    });
    if (missing.length > 0) {
      const err = new Error(
        `return rejected — ${missing.length} path field(s) point to files that do not exist on disk:\n` +
        missing.map((m) => `  • ${m.field} = ${m.value}`).join('\n') +
        `\n\nYou must NOT fabricate file paths. Only return paths that were produced by an actual tool call this turn ` +
        `(generate_image savedTo, web_fetch savedTo, write_file path, etc.). If you did not call such a tool, ` +
        `call it now and retry return with the real path it reports.`
      );
      err.code = 'return_path_does_not_exist';
      err.details = { missing };
      throw err;
    }

    return data;
  }
};
