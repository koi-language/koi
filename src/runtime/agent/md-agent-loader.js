/**
 * md-agent-loader.js — Load user-defined agents from .koi/agents/*.md
 *
 * Each .md file in .koi/agents/ (recursively) becomes an agent with:
 * - Name derived from filename (kebab-case → camelCase)
 * - Description from YAML frontmatter or first # heading
 * - The markdown content as the system prompt / playbook
 * - A single `do` handler (delegate as agentName::do)
 * - Full permissions (read, write, execute, shell, etc.)
 * - No team membership — available to ALL agents with `can delegate`
 *
 * Optional YAML frontmatter:
 *   ---
 *   name: myAgent
 *   description: What this agent does
 *   ---
 */

import fs from 'fs';
import path from 'path';
import { channel } from '../io/channel.js';

let _userAgentsTeam = null;
let _initialized = false;

/**
 * Initialize the loader (async — resolves lazy imports).
 * Call once at startup before getUserAgentsTeam().
 */
export async function initUserAgents() {
  if (_initialized) return;
  _initialized = true;
  const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
  const dir = path.join(projectRoot, '.koi', 'agents');
  if (!fs.existsSync(dir)) return;

  // Lazy imports to avoid circular dependency chains
  const [{ Agent }, { Role }, { Team }] = await Promise.all([
    import('./agent.js'),
    import('../role.js'),
    import('../team.js'),
  ]);

  const members = {};
  _scanRecursive(dir, members, Agent, Role);

  if (Object.keys(members).length === 0) return;

  _userAgentsTeam = new Team('UserAgents', members);

  // Register with the router so semantic search also finds them
  try {
    const { agentRouter } = await import('../router.js');
    for (const agent of Object.values(members)) {
      agentRouter.register(agent);
    }
  } catch (err) {
    channel.log('agent', `[md-agent-loader] Router registration failed: ${err.message}`);
  }

  channel.log('agent', `[md-agent-loader] Loaded ${Object.keys(members).length} user agent(s) from ${dir}`);
}

/**
 * Get the team of user-defined markdown agents.
 * Returns null if no .koi/agents/ exists or initUserAgents() hasn't run.
 */
export function getUserAgentsTeam() {
  return _userAgentsTeam;
}

/**
 * Force reload (e.g. after user adds a new .md file mid-session).
 */
export async function reloadUserAgents() {
  _initialized = false;
  _userAgentsTeam = null;
  await initUserAgents();
  return _userAgentsTeam;
}

// ── Internal ────────────────────────────────────────────────────────────────

function _scanRecursive(dir, members, Agent, Role) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      _scanRecursive(fullPath, members, Agent, Role);
    } else if (entry.name.endsWith('.md')) {
      const agent = _createAgentFromMd(fullPath, Agent, Role);
      if (agent) {
        members[agent.name] = agent;
      }
    }
  }
}

function _createAgentFromMd(filePath, Agent, Role) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch { return null; }

  if (!content.trim()) return null;

  const fileName = path.basename(filePath, '.md');

  // Defaults from filename
  let name = _toCamelCase(fileName);
  let description = '';
  let prompt = content;

  // Parse optional YAML frontmatter — supports plain values, quoted
  // scalars, and block scalars (`|` literal, `>` folded) so Claude-style
  // multi-line `description: |` entries are read as a single string
  // instead of collapsing to the bare `|` marker.
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx > 0) {
      const frontmatter = content.substring(3, endIdx).replace(/^\n/, '').replace(/\n$/, '');
      prompt = content.substring(endIdx + 3).trim();

      const lines = frontmatter.split('\n');
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
        if (!m) { i++; continue; }
        const key = m[1];
        let value = m[2].trim();
        if (value === '|' || value === '>') {
          const folded = value === '>';
          const collected = [];
          i++;
          while (i < lines.length) {
            const next = lines[i];
            if (next.trim() === '') { collected.push(''); i++; continue; }
            if (!/^\s/.test(next)) break;
            collected.push(next.replace(/^\s+/, ''));
            i++;
          }
          while (collected.length && collected[collected.length - 1] === '') {
            collected.pop();
          }
          value = (folded ? collected.join(' ') : collected.join('\n')).trim();
        } else if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
          i++;
        } else {
          i++;
        }
        if (key === 'name' && value) name = value;
        if (key === 'description' && value) description = value;
      }
    }
  }

  // Infer description from content if not in frontmatter
  if (!description) {
    const headingMatch = prompt.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      description = headingMatch[1].trim();
    } else {
      const firstLine = prompt.split('\n').find(l => l.trim());
      if (firstLine) description = firstLine.trim().substring(0, 120);
    }
  }

  // Create the handler — playbookOnly means the reactive loop uses the
  // playbook as the system prompt and the LLM drives execution.
  const handler = async function() {};
  handler.__playbookOnly__ = true;
  handler.__playbook__ = prompt;
  // MD agents only have ONE event handler (`do`). Its affordance shows up in
  // the routing/system prompt right below the agent's own description — if we
  // stamp the same long description here, every MD agent renders the same
  // paragraph twice ("### code-reviewer ...\n  - do: ..."). Use a short generic
  // invocation hint instead; the agent description above carries the details.
  handler.__description__ = `Invoke the ${name} agent.`;

  // Broad permissions — user agents can do anything
  const role = new Role('MarkdownAgent', [
    'execute', 'read', 'write', 'shell', 'use_lsp',
    'web_access', 'call_mcp', 'delegate', 'prompt_user',
  ]);

  const agent = new Agent({
    name,
    description,
    role,
    handlers: { do: handler },
    state: {},
  });

  return agent;
}

function _toCamelCase(str) {
  return str.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
}
