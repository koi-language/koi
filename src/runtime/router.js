/**
 * Agent Router — lightweight registry of agent affordances.
 *
 * Stores agent descriptions for system prompt generation.
 * Routing is done by the LLM via the system prompt (it sees all available
 * intents and picks the right one). This router only provides a simple
 * keyword fallback for edge cases where direct handler matching fails.
 */

export class AgentRouter {
  constructor() {
    this.agents = new Map(); // Map<agentName, agent>
    this.affordances = []; // Array of { agent, event, description, confidence, metadata }
  }

  /**
   * Register an agent and extract its affordances (descriptions only, no embeddings).
   * @param agent - The agent to register
   * @param cachedAffordances - Optional pre-computed affordances from build cache
   */
  async register(agent, cachedAffordances = null) {
    if (!agent || !agent.name) return;

    this.agents.set(agent.name, agent);

    if (cachedAffordances) {
      // Agent-level description (explicit or inferred at build time)
      if (cachedAffordances.__description__) {
        agent.description = cachedAffordances.__description__;
      }
      for (const [eventName, aff] of Object.entries(cachedAffordances)) {
        if (eventName === '__description__') continue;
        if (!aff.description || aff.description.trim() === '') continue;
        this.affordances.push({
          agent,
          event: eventName,
          description: aff.description,
          confidence: aff.confidence,
          metadata: { hasPlaybook: aff.hasPlaybook }
        });
      }
      return;
    }

    // No cache: extract affordances by introspection
    const extracted = this.extractAffordances(agent);
    for (const aff of extracted) {
      if (!aff.description || aff.description.trim() === '') continue;
      this.affordances.push({
        agent,
        event: aff.event,
        description: aff.description,
        confidence: aff.confidence,
        metadata: aff.metadata
      });
    }
  }

  /**
   * Extract affordances from an agent by analyzing its handlers and playbooks.
   */
  extractAffordances(agent) {
    const result = [];
    if (!agent.handlers) return result;

    for (const [eventName, handler] of Object.entries(agent.handlers)) {
      const playbook = agent.playbooks?.[eventName];

      let description;
      let confidence;

      if (playbook) {
        description = this.inferIntentFromPlaybook(playbook, eventName);
        confidence = 0.9;
      } else {
        description = `Handle ${eventName} event`;
        confidence = 0.5;
      }

      result.push({
        event: eventName,
        description,
        confidence,
        metadata: { hasPlaybook: !!playbook, role: agent.role?.name }
      });
    }

    return result;
  }

  /**
   * Infer a short description from a playbook text.
   */
  inferIntentFromPlaybook(playbook, eventName) {
    const cleanText = playbook
      .replace(/\$\{[^}]+\}/g, '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('//'))
      .slice(0, 3)
      .join(' ');

    if (cleanText.length > 10 && cleanText.length < 200) {
      return cleanText;
    }

    return this.humanizeEventName(eventName);
  }

  /**
   * Convert camelCase/snake_case event names to readable descriptions.
   */
  humanizeEventName(eventName) {
    return eventName
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .toLowerCase()
      .trim();
  }

  /**
   * Find matching agents using simple keyword matching on descriptions.
   * This is a fallback — primary routing happens via direct handler name
   * matching in Agent.findTeamMemberForIntent().
   */
  async findMatches(intent, topK = 3) {
    if (this.affordances.length === 0) return [];
    if (!intent || typeof intent !== 'string' || intent.trim() === '') return [];

    const intentLower = intent.toLowerCase();
    const intentKeywords = intentLower
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[\s_-]+/)
      .filter(k => k.length > 2);

    const scored = this.affordances.map(aff => {
      const eventLower = aff.event.toLowerCase();
      const descLower = aff.description.toLowerCase();

      // Exact event name match
      if (eventLower === intentLower) {
        return { ...aff, similarity: 1.0 };
      }

      // Partial event name match
      if (intentLower.includes(eventLower) || eventLower.includes(intentLower)) {
        return { ...aff, similarity: 0.8 };
      }

      // Keyword matching on description
      let matchCount = 0;
      for (const kw of intentKeywords) {
        if (descLower.includes(kw) || eventLower.includes(kw)) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        const score = Math.min(0.7, 0.3 + (matchCount / intentKeywords.length) * 0.4);
        return { ...aff, similarity: score };
      }

      return { ...aff, similarity: 0 };
    });

    return scored
      .filter(s => s.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /**
   * Check if any agent can handle this intent.
   */
  async canHandle(intent) {
    const matches = await this.findMatches(intent, 1);
    return matches.length > 0;
  }

  /**
   * Route a task to the best matching agent.
   */
  async route(task) {
    const intent = task.intent || task.description || task.type;
    if (!intent) {
      throw new Error('[Router] Task must have an intent, description, or type');
    }

    const matches = await this.findMatches(intent, 1);
    if (matches.length === 0) {
      throw new Error(`[Router] No agent can handle: "${intent}"`);
    }

    const best = matches[0];
    return await best.agent.handle(best.event, task.data || {});
  }

  /**
   * Get summary of registered agents and their capabilities.
   */
  getSummary() {
    const agentSummaries = [];
    for (const [name, agent] of this.agents) {
      const affs = this.affordances
        .filter(a => a.agent === agent)
        .map(a => ({ event: a.event, description: a.description, confidence: a.confidence }));
      agentSummaries.push({ name, role: agent.role?.name, affordances: affs });
    }
    return {
      totalAgents: this.agents.size,
      totalAffordances: this.affordances.length,
      agents: agentSummaries
    };
  }

  /**
   * Clear all registered agents.
   */
  clear() {
    this.agents.clear();
    this.affordances = [];
  }
}

// Singleton instance for global use
export const agentRouter = new AgentRouter();
