import { mcpClient } from './mcp-client.js';
import { cliLogger } from './cli-logger.js';

export class Team {
  constructor(name, members = {}) {
    this.name = name;
    this.members = members;
    this._mcpResolved = new Map(); // Cache for resolved MCP addresses

    // Automatically set this team as peers for all agent members
    for (const memberName in members) {
      const member = members[memberName];
      // Check if it's an Agent instance (has handle method)
      // Check if peers is not set or is the no-team proxy
      const hasNoTeam = !member.peers || member.peers.__isNoTeamProxy;

      if (member && typeof member.handle === 'function' && hasNoTeam) {
        member.peers = this;
      }
    }
  }

  get(memberName) {
    return this.members[memberName];
  }

  event(eventName) {
    return new TeamEventQuery(this, eventName);
  }

  toString() {
    return `Team(${this.name})`;
  }
}

class TeamEventQuery {
  constructor(team, event) {
    this.team = team;
    this.eventName = event;
    this.roleFilter = null;
    this.selectionMode = null;
  }

  role(roleObj) {
    this.roleFilter = roleObj;
    return this;
  }

  any() {
    this.selectionMode = 'any';
    return this;
  }

  all() {
    this.selectionMode = 'all';
    return this;
  }

  isMCPAddress(value) {
    if (typeof value === 'string' && value.startsWith('mcp://')) {
      return true;
    }
    if (value && value.type === 'MCPAddress') {
      return true;
    }
    return false;
  }

  async execute(args = {}) {
    // Find matching agents
    const candidates = [];

    for (const [name, agentOrAddress] of Object.entries(this.team.members)) {
      let agent = agentOrAddress;

      // If it's an MCP address, resolve it
      if (this.isMCPAddress(agentOrAddress)) {
        const address = typeof agentOrAddress === 'string'
          ? agentOrAddress
          : agentOrAddress.address;

        cliLogger.progress(`[Team] Resolving MCP: ${address}...`);

        // Check cache
        if (this.team._mcpResolved.has(address)) {
          agent = this.team._mcpResolved.get(address);
          cliLogger.clear();
        } else {
          // Resolve the MCP address
          try {
            agent = await mcpClient.resolve(address);
            this.team._mcpResolved.set(address, agent);
            cliLogger.clear();
          } catch (error) {
            cliLogger.error(`[Team] Failed to resolve ${address}: ${error.message}`);
            continue;
          }
        }
      }

      // Check role filter
      if (this.roleFilter && agent.role !== this.roleFilter) {
        continue;
      }

      // Check if agent has handler for this event
      if (agent.handlers && agent.handlers[this.eventName]) {
        candidates.push({ name, agent });
      } else if (!agent.handlers && typeof agent.handle === 'function') {
        // MCP resources (not regular agents) have a generic handle method
        candidates.push({ name, agent });
      } else if (!agent.handlers && typeof agent.send === 'function') {
        // MCP resources may also have a send method
        candidates.push({ name, agent });
      }
    }

    if (candidates.length === 0) {
      const roleInfo = this.roleFilter ? ` with role "${this.roleFilter.name}"` : '';
      throw new Error(`NO_AGENT_HANDLER:${this.eventName}:${roleInfo}:${this.team.name}`);
    }

    // Execute based on selection mode
    if (this.selectionMode === 'any') {
      const selected = candidates[0];
      const agentName = selected.agent.name || selected.name;

      // Show delegation
      cliLogger.progress(`    → [${agentName}] ${this.eventName}...`);

      // Handle both regular agents and MCP resources
      let result;
      if (selected.agent.handle) {
        // Don't mark as delegation - let the agent decide based on its own context
        result = await selected.agent.handle(this.eventName, args, false);
      } else if (selected.agent.send) {
        result = await selected.agent.send(this.eventName, args);
      } else {
        throw new Error(`Agent ${selected.name} cannot handle event ${this.eventName}`);
      }
      cliLogger.clear();
      return result;
    } else if (this.selectionMode === 'all') {
      const results = [];
      for (const { name, agent } of candidates) {
        const agentName = agent.name || name;
        cliLogger.progress(`    → [${agentName}] ${this.eventName}...`);

        if (agent.handle) {
          // Don't mark as delegation - let the agent decide based on its own context
          results.push(await agent.handle(this.eventName, args, false));
        } else if (agent.send) {
          results.push(await agent.send(this.eventName, args));
        }
        cliLogger.clear();
      }
      return results;
    }

    throw new Error(`Selection mode not specified (use .any() or .all())`);
  }
}
