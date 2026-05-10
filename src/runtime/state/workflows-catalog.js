/**
 * Workflows catalog — shared disk scanner.
 *
 * Used by the system-prompt builder (to inject workflow names), by the
 * `run_workflow` and `describe_workflow` tools, and by the GUI Run-button
 * forced-activation path. NOT exposed as an agent-callable action: workflows
 * surface to the agent as bare names in the prompt; the agent calls
 * `describe_workflow(name)` for details and `run_workflow(name)` to invoke.
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
      result.requireConfirmation = value === 'true';
    }
  }

  return (result.name && result.description) ? result : null;
}

function scanDir(dirPath, scope) {
  const out = [];
  if (!fs.existsSync(dirPath)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const wfMdPath = path.join(dirPath, entry.name, 'WORKFLOW.md');
    if (!fs.existsSync(wfMdPath)) continue;
    try {
      const content = fs.readFileSync(wfMdPath, 'utf-8');
      const meta = parseFrontmatter(content);
      if (!meta) continue;
      out.push({
        name: meta.name,
        description: meta.description,
        location: wfMdPath,
        directory: path.join(dirPath, entry.name),
        scope,
        ...(meta.compatibility && { compatibility: meta.compatibility }),
        ...(meta.requireConfirmation && { requireConfirmation: true }),
      });
    } catch { /* skip unreadable */ }
  }
  return out;
}

/** Return the merged workflow catalog. Project-level entries override
 *  global entries with the same `name`. Each entry has at least
 *  `{ name, description, location, directory, scope }`. */
export function listWorkflowsCatalog() {
  const merged = new Map();
  const globalDir = path.join(os.homedir(), '.koi', 'workflows');
  for (const wf of scanDir(globalDir, 'global')) merged.set(wf.name, wf);
  const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
  const projectDir = path.join(projectRoot, '.koi', 'workflows');
  for (const wf of scanDir(projectDir, 'project')) merged.set(wf.name, wf);
  return Array.from(merged.values());
}

/** Read a workflow's WORKFLOW.md body (frontmatter stripped). Returns
 *  null if the file isn't readable. */
export function readWorkflowBody(workflow) {
  if (!workflow?.location) return null;
  try {
    const raw = fs.readFileSync(workflow.location, 'utf-8');
    const fmEnd = raw.indexOf('\n---', 4);
    return fmEnd !== -1 ? raw.substring(fmEnd + 4).trim() : raw;
  } catch {
    return null;
  }
}
