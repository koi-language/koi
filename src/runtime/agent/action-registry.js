/**
 * Action Registry - Manages available actions for the LLM planner
 *
 * Actions are modules that define what the LLM can do in playbooks.
 * Each action has a type, description, schema, and examples.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Ensure LSP manager singleton is created on globalThis before actions load.
// LSP action files access globalThis.lspManager — without this import,
// the module is never loaded and all LSP actions silently return "LSP not available".
import '../lsp/lsp-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ActionRegistry {
  constructor() {
    this.actions = new Map(); // Map<type, actionDefinition>
    this.actionsByIntent = new Map(); // NUEVO: Map<intent, actionDefinition>
  }

  /**
   * Register an action
   */
  register(action) {
    if (!action.type || !action.description) {
      throw new Error('Action must have type and description');
    }
    this.actions.set(action.type, action);

    // NUEVO: indexar también por intent
    if (action.intent) {
      this.actionsByIntent.set(action.intent, action);
    }
  }

  /**
   * Get an action by type or intent
   */
  get(typeOrIntent) {
    // Intentar por intent primero (nuevo)
    const byIntent = this.actionsByIntent.get(typeOrIntent);
    if (byIntent) return byIntent;

    // Fallback a type (legacy)
    return this.actions.get(typeOrIntent);
  }

  /**
   * Get all registered actions
   */
  getAll() {
    return Array.from(this.actions.values());
  }

  /**
   * Load all actions from a directory (recursively scans subdirectories).
   */
  async loadFromDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await this.loadFromDirectory(fullPath);
      } else if (entry.name.endsWith('.js')) {
        try {
          const module = await import(`file://${fullPath}`);
          const action = module.default;

          if (action && action.type) {
            // Auto-assign toolset from parent directory name
            if (!action.toolset) {
              action.toolset = path.basename(path.dirname(fullPath));
            }
            this.register(action);
          }
        } catch (error) {
          console.warn(`[ActionRegistry] Failed to load action from ${entry.name}: ${error.message}`);
        }
      }
    }
  }

  /**
   * Generate LLM prompt documentation for actions
   * @param {Agent} agent - Agent to filter actions by permissions (null = show all actions)
   */
  generatePromptDocumentation(agent = null) {
    let actions = this.getAll();

    if (agent) {
      const disabledPerms = agent.state?.disabledPermissions;
      // Phase-scoped permission model:
      //  - `can X` in a phase → whitelist subset of the role's permissions.
      //  - `cant X` in a phase → deny list subtracted from the effective set.
      //  - Neither declared → phase inherits all role permissions.
      //  - `return` is an implicit capability every agent has (see
      //    hasPermission), and is always allowed in a phase unless explicitly
      //    denied via `cant return`.
      const _phaseName = agent.state?.statusPhase;
      const _phaseConfig = agent.phases?.[_phaseName];
      const _phaseCan = Array.isArray(_phaseConfig?.permissions)
        ? new Set(_phaseConfig.permissions)
        : null;
      const _phaseCant = Array.isArray(_phaseConfig?.deniedPermissions)
        ? new Set(_phaseConfig.deniedPermissions)
        : null;

      actions = actions.filter(action => {
        // hidden can be boolean or function(agent)
        const isHidden = typeof action.hidden === 'function' ? action.hidden(agent) : action.hidden;
        if (isHidden) return false;
        const perm = action.permission;
        if (!perm) return true;
        if (!agent.hasPermission(perm)) return false;
        // Legacy: if permission is temporarily disabled, hide the action
        if (Array.isArray(disabledPerms) && disabledPerms.includes(perm)) return false;
        // Phase deny-list takes precedence over everything else
        if (_phaseCant && _phaseCant.has(perm)) return false;
        // Whitelist mode: must be in `can` list. `return` is implicit unless
        // explicitly denied above, so it passes even without `can return`.
        if (_phaseCan && perm !== 'return' && !_phaseCan.has(perm)) return false;
        return true;
      });
    } else {
      actions = actions.filter(action => {
        const isHidden = typeof action.hidden === 'function' ? action.hidden(null) : action.hidden;
        return !isHidden;
      });
    }

    if (actions.length === 0) return '';

    // List exact valid intent names upfront so the LLM never invents one
    const validNames = actions.map(a => a.intent || a.type);
    let doc = '## AVAILABLE ACTIONS\n\n';
    doc += `Valid intent names: ${validNames.join(', ')}\n`;
    doc += 'The "intent" field MUST be one of these exact names. Never paraphrase or use free text.\n\n';
    for (const action of actions) {
      doc += this._formatActionEntry(action) + '\n';
    }
    return doc;
  }

  /**
   * Compact prompt: one line per action (name + short description + params).
   * Full details available on-demand via `get_tool_info`.
   * Saves ~7K tokens vs the full documentation.
   */
  generateCompactDocumentation(agent = null) {
    let actions = this.getAll();

    if (agent) {
      const disabledPerms = agent.state?.disabledPermissions;
      const _phaseName = agent.state?.statusPhase;
      const _phaseConfig = agent.phases?.[_phaseName];
      const _phaseCan = Array.isArray(_phaseConfig?.permissions)
        ? new Set(_phaseConfig.permissions) : null;
      const _phaseCant = Array.isArray(_phaseConfig?.deniedPermissions)
        ? new Set(_phaseConfig.deniedPermissions) : null;

      actions = actions.filter(action => {
        const isHidden = typeof action.hidden === 'function' ? action.hidden(agent) : action.hidden;
        if (isHidden) return false;
        const perm = action.permission;
        if (!perm) return true;
        if (!agent.hasPermission(perm)) return false;
        if (Array.isArray(disabledPerms) && disabledPerms.includes(perm)) return false;
        if (_phaseCant && _phaseCant.has(perm)) return false;
        if (_phaseCan && perm !== 'return' && !_phaseCan.has(perm)) return false;
        return true;
      });
    } else {
      actions = actions.filter(action => {
        const isHidden = typeof action.hidden === 'function' ? action.hidden(null) : action.hidden;
        return !isHidden;
      });
    }

    if (actions.length === 0) return '';

    const validNames = actions.map(a => a.intent || a.type);
    let doc = '## AVAILABLE ACTIONS\n\n';
    doc += `Valid intent names: ${validNames.join(', ')}\n`;
    doc += 'The "intent" field MUST be one of these exact names. Use get_tool_info for full schema.\n\n';

    for (const action of actions) {
      const intent = action.intent || action.type;
      let desc = action.description || '';
      // Truncate description to first sentence (before "Fields:", "Returns:", or ". ")
      const cutPoints = [
        desc.indexOf('Fields:'),
        desc.indexOf('Returns:'),
        desc.indexOf('→'),
        desc.indexOf('. ', 40),
      ].filter(i => i > 0);
      const cutAt = cutPoints.length > 0 ? Math.min(...cutPoints) : desc.length;
      const shortDesc = desc.substring(0, cutAt).trim().replace(/[.,]\s*$/, '');

      // Extract param names from schema
      let params = '';
      if (action.schema?.properties) {
        const keys = Object.keys(action.schema.properties);
        const required = new Set(action.schema.required || []);
        if (keys.length > 0) {
          params = keys.map(k => required.has(k) ? `"${k}"` : `"${k}"?`).join(', ');
        }
      }

      doc += `- **${intent}**: ${shortDesc}`;
      if (params) doc += ` | In: ${params}`;
      doc += '\n';
    }

    return doc;
  }

  /**
   * Toolset-level prompt: group actions by toolset, show only toolset
   * names + tool list. The agent calls open_toolset for the compact
   * list and get_tool_info for individual schemas.
   */
  generateToolsetDocumentation(agent = null) {
    const actions = this._filterActions(agent);
    if (actions.length === 0) return '';

    // Core intents shown inline (always visible, no toolset lookup needed)
    const CORE_INTENTS = new Set([
      'print', 'prompt_user', 'prompt_form', 'return', 'phase_done',
      'delegate', 'open_toolset', 'get_tool_info',
      'learn_fact', 'recall_facts',
    ]);

    const coreActions = actions.filter(a => CORE_INTENTS.has(a.intent || a.type));
    const toolsetActions = actions.filter(a => !CORE_INTENTS.has(a.intent || a.type));

    // Group non-core by toolset
    const toolsets = new Map();
    for (const action of toolsetActions) {
      const ts = action.toolset || 'other';
      if (!toolsets.has(ts)) toolsets.set(ts, []);
      toolsets.get(ts).push(action);
    }

    const tsDescriptions = {
      file: 'Read, write, edit files and search code',
      shell: 'Execute commands and manage processes',
      lsp: 'Language Server Protocol (types, definitions, references, diagnostics)',
      io: 'User interaction (show results)',
      knowledge: 'Session and plan knowledge store',
      task: 'Task management',
      queue: 'Work queue (user requests)',
      web: 'Internet access (fetch, search)',
      mcp: 'External MCP tool servers',
      media: 'Screenshots, image info, segmentation',
      session: 'Version control (diff, history, checkout)',
      agenda: 'Scheduling, reminders, watchers',
      code: 'Code analysis',
      delegation: 'Delegate to other agents',
      state: 'Agent state and control',
      llm: 'Direct LLM calls',
      browser: 'Browser automation',
      mobile: 'Mobile device interaction',
      skills: 'Skill management',
    };

    const validNames = actions.map(a => a.intent || a.type);
    let doc = '## AVAILABLE ACTIONS\n\n';
    doc += `Valid intent names: ${validNames.join(', ')}\n\n`;

    // Core tools — shown inline with params
    doc += '### Core\n';
    for (const action of coreActions) {
      const intent = action.intent || action.type;
      let desc = action.description || '';
      const cut = [desc.indexOf('Fields:'), desc.indexOf('Returns:'), desc.indexOf('→'), desc.indexOf('. ', 30)].filter(i => i > 0);
      const shortDesc = desc.substring(0, cut.length > 0 ? Math.min(...cut) : desc.length).trim().replace(/[.,]\s*$/, '');
      let params = '';
      if (action.schema?.properties) {
        const keys = Object.keys(action.schema.properties);
        const req = new Set(action.schema.required || []);
        if (keys.length > 0) params = keys.map(k => req.has(k) ? `"${k}"` : `"${k}"?`).join(', ');
      }
      doc += `- **${intent}**: ${shortDesc}`;
      if (params) doc += ` | In: ${params}`;
      doc += '\n';
    }

    // Toolsets — grouped table
    doc += '\n### Toolsets\nUse **open_toolset** to see tool names and parameters. Use **get_tool_info** for full schema and instructions.\n\n';
    doc += '| Toolset | Tools | Description |\n|---|---|---|\n';
    for (const [ts, tsActions] of toolsets) {
      const names = tsActions.map(a => a.intent || a.type).join(', ');
      const desc = tsDescriptions[ts] || ts;
      doc += `| ${ts} | ${names} | ${desc} |\n`;
    }
    doc += '\n';

    return doc;
  }

  /**
   * Get compact documentation for all tools in a toolset.
   */
  getToolsetDocumentation(toolsetName, agent = null) {
    const actions = this._filterActions(agent)
      .filter(a => (a.toolset || 'other') === toolsetName);
    if (actions.length === 0) return null;

    let doc = `## Toolset: ${toolsetName}\n\n`;
    for (const action of actions) {
      const intent = action.intent || action.type;
      let desc = action.description || '';
      const cutPoints = [
        desc.indexOf('Fields:'),
        desc.indexOf('Returns:'),
        desc.indexOf('→'),
        desc.indexOf('. ', 40),
      ].filter(i => i > 0);
      const cutAt = cutPoints.length > 0 ? Math.min(...cutPoints) : desc.length;
      const shortDesc = desc.substring(0, cutAt).trim().replace(/[.,]\s*$/, '');
      let params = '';
      if (action.schema?.properties) {
        const keys = Object.keys(action.schema.properties);
        const required = new Set(action.schema.required || []);
        if (keys.length > 0) {
          params = keys.map(k => required.has(k) ? `"${k}"` : `"${k}"?`).join(', ');
        }
      }
      doc += `- **${intent}**: ${shortDesc}`;
      if (params) doc += ` | In: ${params}`;
      doc += '\n';
    }
    return doc;
  }

  /** Internal: filter actions by agent permissions/phase. */
  _filterActions(agent) {
    let actions = this.getAll();
    if (agent) {
      const disabledPerms = agent.state?.disabledPermissions;
      const _phaseName = agent.state?.statusPhase;
      const _phaseConfig = agent.phases?.[_phaseName];
      const _phaseCan = Array.isArray(_phaseConfig?.permissions)
        ? new Set(_phaseConfig.permissions) : null;
      const _phaseCant = Array.isArray(_phaseConfig?.deniedPermissions)
        ? new Set(_phaseConfig.deniedPermissions) : null;
      actions = actions.filter(action => {
        const isHidden = typeof action.hidden === 'function' ? action.hidden(agent) : action.hidden;
        if (isHidden) return false;
        const perm = action.permission;
        if (!perm) return true;
        if (!agent.hasPermission(perm)) return false;
        if (Array.isArray(disabledPerms) && disabledPerms.includes(perm)) return false;
        if (_phaseCant && _phaseCant.has(perm)) return false;
        if (_phaseCan && perm !== 'return' && !_phaseCan.has(perm)) return false;
        return true;
      });
    } else {
      actions = actions.filter(action => {
        const isHidden = typeof action.hidden === 'function' ? action.hidden(null) : action.hidden;
        return !isHidden;
      });
    }
    return actions;
  }

  /**
   * Get full documentation for a single action (for get_tool_info).
   */
  getActionDocumentation(intentName) {
    const action = this.get(intentName);
    if (!action) return null;
    return this._formatActionEntry(action);
  }

  /**
   * Format a single action as a ### section.
   * Parses the description string to extract main text, In: (fields) and Out: (returns).
   */
  _formatActionEntry(action) {
    const intent = action.intent || action.type;
    let desc = action.description || '';

    // Extract "Returns: ..." (with optional "→ " prefix) from the end of description
    let outText = null;
    const returnsMatch = desc.match(/(?:→\s*)?Returns?:\s*(.+)$/s);
    if (returnsMatch) {
      outText = returnsMatch[1].trim().replace(/\s+/g, ' ');
      desc = desc.substring(0, returnsMatch.index).trim().replace(/[.,]\s*$/, '');
    }

    // Extract "Fields: ..." or "Requires: ..." block
    let inText = null;
    const fieldsMatch = desc.match(/\b(?:Fields?|Requires?):\s*(.+?)(?:\.\s*(?=[A-Z])|$)/s);
    if (fieldsMatch) {
      inText = fieldsMatch[1].trim().replace(/\.\s*$/, '');
      desc = desc.substring(0, fieldsMatch.index).trim().replace(/[.,]\s*$/, '');
    } else if (action.schema?.properties) {
      const keys = Object.keys(action.schema.properties);
      if (keys.length > 0) inText = keys.map(k => `"${k}"`).join(', ');
    }

    let out = `### ${intent}\n${desc}\n`;
    if (inText)  out += `In: ${inText}\n`;
    if (outText) out += `Out: ${outText}\n`;
    if (action.instructions) out += `\n${action.instructions}\n`;
    return out;
  }

  /**
   * Generate detailed examples for LLM prompt
   */
  generateExamples() {
    const actions = this.getAll();
    const actionsWithExamples = actions.filter(a => a.examples && a.examples.length > 0);

    if (actionsWithExamples.length === 0) {
      return '';
    }

    let examples = '\nAction Examples:\n';

    actionsWithExamples.forEach(action => {
      if (action.examples && action.examples.length > 0) {
        examples += `\n${action.type}:\n`;
        action.examples.forEach(example => {
          examples += `  ${JSON.stringify(example)}\n`;
        });
      }
    });

    return examples;
  }

  /**
   * Clear all registered actions
   */
  clear() {
    this.actions.clear();
  }
}

// Global singleton instance
export const actionRegistry = new ActionRegistry();

// Auto-load tools from the tools directory on module load
const toolsDir = path.join(__dirname, '..', 'tools');
if (fs.existsSync(toolsDir)) {
  await actionRegistry.loadFromDirectory(toolsDir).catch(err => {
    console.warn('[ActionRegistry] Failed to auto-load tools:', err.message);
  });
}
