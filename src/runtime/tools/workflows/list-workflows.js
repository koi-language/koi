/**
 * List Workflows Action — Discover and list available Workflows.
 *
 * A Workflow is a markdown script (WORKFLOW.md) describing the pre-approved
 * sequence of steps to complete a recurring task type. Mirrors the layout of
 * Skills (each workflow lives in its own subdirectory).
 *
 * Discovery paths:
 *   - Global:        ~/.koi/workflows/
 *   - Project-level: <projectRoot>/.koi/workflows/  (overrides global)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let value = line.substring(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'name' || key === 'description' || key === 'compatibility' || key === 'license') {
      result[key] = value;
    } else if (key === 'requireConfirmation') {
      // Optional boolean. When true, activating this workflow blocks on
      // an explicit user confirmation instead of the default
      // count-down-and-proceed banner. Meant for workflows whose first
      // step is destructive (deploy, rm -rf, DB migration, etc.).
      result.requireConfirmation = value === 'true';
    }
  }

  return (result.name && result.description) ? result : null;
}

function scanWorkflowsDirectory(dirPath) {
  const workflows = [];
  if (!fs.existsSync(dirPath)) return workflows;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;

      const wfMdPath = path.join(dirPath, entry.name, 'WORKFLOW.md');
      if (!fs.existsSync(wfMdPath)) continue;

      try {
        const content = fs.readFileSync(wfMdPath, 'utf-8');
        const meta = parseFrontmatter(content);
        if (meta) {
          workflows.push({
            name: meta.name,
            description: meta.description,
            location: wfMdPath,
            directory: path.join(dirPath, entry.name),
            ...(meta.compatibility && { compatibility: meta.compatibility }),
            ...(meta.requireConfirmation && { requireConfirmation: true }),
          });
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* skip unreadable dirs */ }

  return workflows;
}

export default {
  type: 'list_workflows',
  intent: 'list_workflows',
  description: 'Discover available Workflows by scanning workflow directories. → Returns: { workflows: [{ name, description, location }], catalog }',
  thinkingHint: 'Examining available workflows',
  permission: null,
  hidden: true,

  schema: {
    type: 'object',
    properties: {},
  },

  examples: [
    { actionType: 'direct', intent: 'list_workflows' },
  ],

  async execute(action, agent) {
    const all = new Map(); // keyed by name; project-level overrides global

    const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();

    const globalDir = path.join(os.homedir(), '.koi', 'workflows');
    for (const wf of scanWorkflowsDirectory(globalDir)) {
      all.set(wf.name, { ...wf, scope: 'global' });
    }

    const projectDir = path.join(projectRoot, '.koi', 'workflows');
    for (const wf of scanWorkflowsDirectory(projectDir)) {
      all.set(wf.name, { ...wf, scope: 'project' });
    }

    if (all.size === 0) {
      try {
        const { channel: ch } = await import('../../io/channel.js');
        ch.log('workflows', `list_workflows: none found. global=${globalDir}, project=${projectDir}, root=${projectRoot}`);
      } catch { /* channel optional */ }
    }

    const workflows = Array.from(all.values());
    const publicWorkflows = workflows.map(({ name, description }) => ({ name, description }));

    let catalog = '';
    if (workflows.length > 0) {
      const entries = workflows.map(w => `  <workflow name="${w.name}">${w.description}</workflow>`);
      catalog = '<available_workflows>\n' + entries.join('\n') + '\n</available_workflows>';
    }

    return { workflows: publicWorkflows, _fullWorkflows: workflows, catalog };
  },
};
