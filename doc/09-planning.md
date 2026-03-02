# Planning System

LLM-based automatic planning allows agents to decompose complex goals into executable steps.

## Overview

The planning system:
1. **Decomposes** complex goals (LLM)
2. **Executes** steps sequentially
3. **Re-plans** on failure (automatic)
4. **Tracks** execution history

## When to Use

Use planning for:
- Complex multi-step tasks
- Unknown sequence of actions
- Autonomous problem-solving
- Tasks that may require re-planning

Don't use for:
- Simple single-step tasks
- Fixed workflows
- Performance-critical paths

## Example

```javascript
import { Agent, Role, PlanningAgent } from './src/runtime/index.js';

const Worker = new Role('Worker', ['execute']);

const DataAgent = new Agent({
  name: 'DataAgent',
  role: Worker,
  handlers: {
    validate: async (args) => ({ valid: true }),
    transform: async (args) => ({ transformed: args.data.toUpperCase() }),
    save: async (args) => ({ saved: true, id: '123' })
  }
});

const planningAgent = new PlanningAgent(DataAgent, {
  llm: { provider: 'openai', model: 'gpt-4o-mini' }
});

const result = await planningAgent.executeWithPlanning(
  'Validate, transform, and save user data',
  { data: 'hello world' }
);
```

## Configuration

```javascript
{
  name: 'MyPlanner',
  llm: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0.3
  },
  maxSteps: 10,
  allowReplanning: true
}
```

## Re-planning

When a step fails:
1. Capture failure details
2. LLM analyzes what went wrong
3. Create new plan with alternative approach
4. Retry execution

For complete details, see [PLANNING_GUIDE.md](../PLANNING_GUIDE.md) in the root directory.

---

**Next**: [MCP Protocol](10-mcp-integration.md) →
