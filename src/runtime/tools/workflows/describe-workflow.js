/**
 * Describe Workflow Action — Look up METADATA for a single workflow by name.
 *
 * Returns ONLY metadata (name, description, scope, directory, sibling files).
 * The WORKFLOW.md body is NEVER returned by this tool: when the body was
 * exposed here, agents read the body and treated its instructions as their
 * own for the current turn — silently skipping `run_workflow`. The body is
 * the property of `run_workflow` and the per-step task descriptions it
 * generates. Use this tool only when the agent needs to confirm the
 * workflow exists / its scope / its sibling files before invoking
 * `run_workflow`.
 */

import fs from 'fs';
import path from 'path';
import { listWorkflowsCatalog } from '../../state/workflows-catalog.js';

export default {
  type: 'describe_workflow',
  intent: 'describe_workflow',
  description: 'Look up METADATA for a workflow by name — its description, scope, directory, and sibling files. Does NOT return the WORKFLOW.md body (that is internal to run_workflow). Use this only when you need to confirm a workflow\'s identity before invoking run_workflow — usually the name + description in the AVAILABLE WORKFLOWS section is already enough. Read-only. Fields: "name" (required). → Returns: { name, description, scope, directory, files?, requireConfirmation?, compatibility? }',
  thinkingHint: (action) => `Inspecting workflow: ${action.name || '...'}`,
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The workflow name to inspect (matches the names listed in the AVAILABLE WORKFLOWS section of the system prompt).',
      },
    },
    required: ['name'],
  },

  examples: [
    { actionType: 'direct', intent: 'describe_workflow', name: 'generate-article' },
  ],

  async execute(action, _agent) {
    const name = action.name;
    if (!name) return { found: false, error: 'Missing required field: name' };

    const workflows = listWorkflowsCatalog();
    const workflow = workflows.find(w => w.name === name);
    if (!workflow) {
      const available = workflows.map(w => w.name).join(', ');
      return {
        found: false,
        error: `Workflow "${name}" not found.${available ? ` Available: ${available}` : ' No workflows are currently configured.'}`,
      };
    }

    const result = {
      found: true,
      name: workflow.name,
      description: workflow.description,
      scope: workflow.scope,
      // Absolute directory + sibling files (like `activate_skill`'s
      // `directory` + `resources`) so the coordinator can pre-resolve
      // any file the workflow references. NEVER the WORKFLOW.md body
      // itself — that's the run_workflow translator's input only.
      directory: workflow.directory || null,
    };
    if (workflow.directory) {
      try {
        const entries = fs.readdirSync(workflow.directory, { withFileTypes: true });
        const files = [];
        for (const ent of entries) {
          if (ent.name === 'WORKFLOW.md') continue;
          if (ent.name.startsWith('.')) continue;
          const abs = path.join(workflow.directory, ent.name);
          files.push(ent.isDirectory() ? `${abs}/` : abs);
        }
        if (files.length > 0) result.files = files;
      } catch { /* unreadable — omit `files` */ }
    }
    if (workflow.requireConfirmation) result.requireConfirmation = true;
    if (workflow.compatibility) result.compatibility = workflow.compatibility;
    return result;
  },
};
