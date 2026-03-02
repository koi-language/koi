import { agentRouter } from './router.js';
import { cliLogger } from './cli-logger.js';

export class Runtime {
  static async send(config) {
    const { base, filters = [], args = {}, caller = null } = config;

    // Validate that base (team/peers) is not null
    if (!base || base === null || base === undefined) {
      const eventName = filters.find(f => f.type === 'event')?.name || 'unknown event';
      throw new Error(`NO_AGENT_HANDLER:${eventName}::no-team`);
    }

    // Check that calling agent has delegate permission
    if (caller && typeof caller.hasPermission === 'function' && !caller.hasPermission('delegate')) {
      const eventName = filters.find(f => f.type === 'event')?.name || 'unknown event';
      throw new Error(`Agent "${caller.name}" cannot delegate: role "${caller.role?.name || 'unknown'}" lacks "can delegate" permission. Add "can delegate" to the role definition.`);
    }

    try {
      // Build query from filters
      let query = base;

      for (const filter of filters) {
        if (filter.type === 'event') {
          query = query.event(filter.name);
        } else if (filter.type === 'role') {
          query = query.role(filter.role);
        } else if (filter.type === 'select') {
          query = filter.mode === 'any' ? query.any() : query.all();
        }
      }

      // Execute delegate — no timeout, delegates run as long as needed
      const result = await query.execute(args);

      cliLogger.clear();
      return result;
    } catch (error) {
      // Handle NO_AGENT_HANDLER errors specially
      if (error.message && error.message.startsWith('NO_AGENT_HANDLER:')) {
        const parts = error.message.split(':');
        const eventName = parts[1] || 'unknown';
        const roleInfo = parts[2] || '';
        const teamName = parts[3] || '';

        if (teamName === 'no-team') {
          console.error(`\n❌ No agent available to handle event "${eventName}" - no team configured\n`);
        } else {
          const roleMsg = roleInfo ? ` (role: ${roleInfo})` : '';
          console.error(`\n❌ No agent available to handle event "${eventName}"${roleMsg}\n`);
        }
        process.exit(1);
      }

      console.error('[Runtime] Send failed:', error.message);
      throw error;
    }
  }

  /**
   * Create an agent and auto-register it with the router
   */
  static async createAgent(AgentClass, config) {
    const agent = new AgentClass(config);

    // Auto-register with router for dynamic discovery
    if (agent.handlers && Object.keys(agent.handlers).length > 0) {
      await agentRouter.register(agent);
    }

    return agent;
  }

  /**
   * Create a team and auto-register all member agents
   */
  static async createTeam(TeamClass, name, members) {
    const team = new TeamClass(name, members);

    // Register all members with the router
    for (const [memberName, agent] of Object.entries(members)) {
      if (agent.handlers && Object.keys(agent.handlers).length > 0) {
        await agentRouter.register(agent);
      }
    }

    return team;
  }

  /**
   * Register an existing agent with the router
   */
  static async registerAgent(agent) {
    if (agent.handlers && Object.keys(agent.handlers).length > 0) {
      await agentRouter.register(agent);
    }
  }

  /**
   * Get router summary for debugging
   */
  static getRouterSummary() {
    return agentRouter.getSummary();
  }

  static log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }
}
