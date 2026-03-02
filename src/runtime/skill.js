export class Skill {
  constructor(config) {
    this.name = config.name;
    this.affordance = config.affordance || '';
    this.run = config.run || (async () => ({ error: 'Not implemented' }));
    this.agents = config.agents || {};
  }

  async execute(input) {
    console.log(`[Skill:${this.name}] Executing with input:`, input);

    try {
      const result = await this.run(input);
      console.log(`[Skill:${this.name}] Completed successfully`);
      return result;
    } catch (error) {
      console.error(`[Skill:${this.name}] Error:`, error.message);
      return { error: error.message };
    }
  }

  toString() {
    return `Skill(${this.name})`;
  }
}
