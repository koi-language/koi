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
import { listAdminPluginDirs } from '../plugins/admin-root.js';

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
  const adminPlugins = listAdminPluginDirs();
  const hasAdmin = adminPlugins.length > 0;
  if (!fs.existsSync(dir) && !hasAdmin) return;

  // Lazy imports to avoid circular dependency chains
  const [{ Agent }, { Role }, { Team }] = await Promise.all([
    import('./agent.js'),
    import('../role.js'),
    import('../team.js'),
  ]);

  // Scan order: project first, then admin. `_scanRecursive` adds to
  // `members` and OVERWRITES existing keys — so admin agents end up
  // shadowing same-named project agents. Same priority story as
  // skills and workflows.
  const members = {};
  if (fs.existsSync(dir)) {
    _scanRecursive(dir, members, Agent, Role);
  }
  for (const p of adminPlugins) {
    const adminAgentsDir = path.join(p.dir, 'agents');
    if (fs.existsSync(adminAgentsDir)) {
      _scanRecursive(adminAgentsDir, members, Agent, Role);
    }
  }

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

  channel.log('agent', `[md-agent-loader] Loaded ${Object.keys(members).length} user agent(s) (project=${dir}${hasAdmin ? `, admin=${adminPlugins.length} plugin(s)` : ''})`);
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
  // Skills declared in the frontmatter `skills:` list — Claude-Code-style
  // SKILL.md skills the agent author wants auto-activated on load (see the
  // auto-activate block in agent.js). Distinct from the legacy `this.skills`
  // SkillRegistry concept.
  let skills = [];

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
        let listValue = null;
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
        } else if (value.startsWith('[') && value.endsWith(']')) {
          // Inline flow sequence: `skills: [a, b, c]`
          listValue = value
            .slice(1, -1)
            .split(',')
            .map(s => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
          i++;
        } else if (value === '') {
          // Possible block sequence on following indented `- item` lines:
          //   skills:
          //     - api-conventions
          //     - error-handling-patterns
          const collected = [];
          i++;
          while (i < lines.length) {
            const lm = lines[i].match(/^\s+-\s*(.+)$/);
            if (!lm) break;
            collected.push(lm[1].trim().replace(/^["']|["']$/g, ''));
            i++;
          }
          if (collected.length) listValue = collected;
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
        if (key === 'skills' && listValue) skills = listValue;
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
    autoActivateSkills: skills,
    state: {},
  });

  return agent;
}

function _toCamelCase(str) {
  return str.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
}
