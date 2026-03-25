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
      actions = actions.filter(action => {
        // hidden can be boolean or function(agent)
        const isHidden = typeof action.hidden === 'function' ? action.hidden(agent) : action.hidden;
        if (isHidden) return false;
        if (!action.permission) return true;
        if (!agent.hasPermission(action.permission)) return false;
        // Phase-based: if permission is temporarily disabled, hide the action
        if (Array.isArray(disabledPerms) && disabledPerms.includes(action.permission)) return false;
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

// Auto-load tools (actions) from the tools directory on module load
const toolsDir = path.join(__dirname, '..', 'tools');
if (fs.existsSync(toolsDir)) {
  await actionRegistry.loadFromDirectory(toolsDir).catch(err => {
    console.warn('[ActionRegistry] Failed to auto-load tools:', err.message);
  });
}
