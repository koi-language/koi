/**
 * Describe Workflow Action — Look up the description (and optional body) of
 * a single workflow by name.
 *
 * Workflows surface to the agent as bare names in the system prompt; the
 * agent calls this tool to confirm what a workflow does before invoking
 * `run_workflow`. Mirrors the "list-by-name + describe-on-demand" pattern
 * used for non-core toolsets.
 */

import { listWorkflowsCatalog, readWorkflowBody } from '../../state/workflows-catalog.js';

export default {
  type: 'describe_workflow',
  intent: 'describe_workflow',
  description: 'Describe a workflow by name. Returns the workflow\'s short description and full WORKFLOW.md body so you can decide whether it matches the user\'s intent before invoking it via run_workflow. Read-only — no state change. Fields: "name" (required), "verbose" (optional bool, defaults true — set false to skip the body). → Returns: { name, description, scope, requireConfirmation?, body? }',
  thinkingHint: (action) => `Describing workflow: ${action.name || '...'}`,
  permission: null,
  hidden: true,

  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The workflow name to describe (matches the names listed in the AVAILABLE WORKFLOWS section of the system prompt).',
      },
      verbose: {
        type: 'boolean',
        description: 'When true (default), include the full WORKFLOW.md body. Set false for just the one-line description + metadata.',
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

    const verbose = action.verbose !== false;
    const result = {
      found: true,
      name: workflow.name,
      description: workflow.description,
      scope: workflow.scope,
    };
    if (workflow.requireConfirmation) result.requireConfirmation = true;
    if (workflow.compatibility) result.compatibility = workflow.compatibility;
    if (verbose) {
      const body = readWorkflowBody(workflow);
      if (body != null) result.body = body;
    }
    return result;
  },
};
