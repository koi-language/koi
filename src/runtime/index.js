export { Agent } from './agent/agent.js';
export { Team } from './team.js';
export { Skill } from './skills/skill.js';
export { Role } from './role.js';
export { Runtime } from './runtime.js';
export { MCPClient, mcpClient } from './mcp/mcp-client.js';
export { Planner, PlanningAgent } from './agent/planner.js';
export { SkillSelector, skillSelector } from './skills/skill-selector.js';
export { registry, getRegistry } from './skills/registry.js';
export { mcpRegistry } from './mcp/mcp-registry.js';
export { lspManager } from './lsp/lsp-manager.js';

// Global registry for skill functions (for tool calling)
export const SkillRegistry = {
  _functions: {},

  register(skillName, functionName, fn, metadata = {}) {
    if (!this._functions[skillName]) {
      this._functions[skillName] = {};
    }
    this._functions[skillName][functionName] = { fn, metadata };
  },

  get(skillName, functionName) {
    return this._functions[skillName]?.[functionName];
  },

  getAll(skillName) {
    return this._functions[skillName] || {};
  },

  getAllSkills() {
    return this._functions;
  }
};
