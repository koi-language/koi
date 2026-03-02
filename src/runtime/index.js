export { Agent } from './agent.js';
export { Team } from './team.js';
export { Skill } from './skill.js';
export { Role } from './role.js';
export { Runtime } from './runtime.js';
export { MCPClient, mcpClient } from './mcp-client.js';
export { Planner, PlanningAgent } from './planner.js';
export { SkillSelector, skillSelector } from './skill-selector.js';
export { registry, getRegistry } from './registry.js';
export { mcpRegistry } from './mcp-registry.js';
export { lspManager } from './lsp-manager.js';

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
