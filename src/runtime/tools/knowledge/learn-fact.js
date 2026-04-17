/**
 * Learn Fact Action — write a discovered fact to the shared session knowledge store.
 *
 * Facts written here are automatically injected into the context of every
 * agent that starts AFTER this call, so they don't need to rediscover them.
 * Agents running in parallel can retrieve them via recall_facts.
 *
 * Good candidates: tech stacks, exact file paths, required env var names,
 * service endpoints, deployment outputs (ECR URL, cluster name…), constraints.
 * Bad candidates: file contents, generated code, intermediate results.
 */

import { sessionKnowledge, planKnowledge } from '../../state/session-knowledge.js';
import { channel } from '../../io/channel.js';

export default {
  type: 'learn_fact',
  intent: 'learn_fact',
  description: 'Store a reusable fact so other agents don\'t have to rediscover it. Two scopes: "session" (default, durable project knowledge) and "plan" (implementation details shared between tasks of the current plan — auto-cleared when all tasks complete). ONLY for: tech stacks, file paths, config values, env var names, service URLs, dependencies. NEVER for: user intent, task summaries, what you did, progress, conversation context. Fields: "key" (unique snake_case id), "value" (concise, max 200 chars), "category" (tech_stack|path|config|credential|status|dependency), "scope" (session|plan, default session)',
  thinkingHint: 'Sharing knowledge',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Unique snake_case identifier, e.g. "frontend_tech_stack", "ecr_repo_url", "db_env_var_name"',
      },
      value: {
        type: 'string',
        description: 'Descriptive fact value (max 200 chars). Must explain WHAT it is and WHY it matters, not just the raw value. Example: "../backend/src/db/schema.ts — Drizzle ORM table definitions (users, apiKeys, modelPrices)". Do NOT include file contents, code snippets, or binary data.',
      },
      category: {
        type: 'string',
        enum: ['tech_stack', 'path', 'config', 'credential', 'status', 'dependency'],
        description: 'Category — must be one of: tech_stack, path, config, credential, status, dependency.',
      },
      scope: {
        type: 'string',
        enum: ['session', 'plan'],
        description: 'Scope. "session" (default) = durable project knowledge that persists across the session. "plan" = transient implementation details shared between tasks of the current plan (auto-cleared when all tasks complete). Use "plan" for: files you created, patterns you established, intermediate findings that help sibling tasks. Use "session" for: tech stacks, project structure, env vars, config.',
      },
    },
    required: ['key', 'value'],
  },

  examples: [
    { actionType: 'direct', intent: 'learn_fact', key: 'frontend_tech_stack', value: 'React 18 + Vite 5 + TypeScript, no SSR, builds to dist/', category: 'tech_stack' },
    { actionType: 'direct', intent: 'learn_fact', key: 'db_schema_path', value: '../backend/src/db/schema.ts — Drizzle ORM table definitions (users, apiKeys, usageLogs, modelPrices)', category: 'path' },
    { actionType: 'direct', intent: 'learn_fact', key: 'backend_db_env_var', value: 'DATABASE_URL — full PostgreSQL connection string, required by backend and migrations', category: 'config' },
    { actionType: 'direct', intent: 'learn_fact', key: 'ecr_base_url', value: '123456789.dkr.ecr.eu-west-1.amazonaws.com — Docker image registry for all microservices', category: 'status' },
    { actionType: 'direct', intent: 'learn_fact', key: 'gateway_api_dependency', value: 'frontend calls backend at /gateway/* — OpenAI-compatible proxy that routes to OpenRouter/native APIs', category: 'dependency' },
  ],

  async execute(action, agent) {
    const { key, value, category = 'other', scope = 'session' } = action;

    if (!key || !value) {
      return { success: false, error: 'learn_fact: "key" and "value" are required' };
    }

    // Silently ignore non-project facts (intent tracking, context dumps, narrative summaries).
    // Returning success prevents the LLM from wasting iterations retrying.
    const _ignoredKeys = new Set(['current_intent', 'initial_user_request', 'context', 'user_request', 'task_intent', 'goal', 'objective']);
    if (_ignoredKeys.has(key)) {
      channel.log('knowledge', `[${agent?.name || '?'}] Ignored learn_fact: "${key}" (not a project fact)`);
      return { success: true, stored: false, message: 'Noted.' };
    }

    // Accept any category — normalize unknown ones to 'other'
    const _validCategories = new Set(['tech_stack', 'path', 'config', 'credential', 'status', 'dependency']);
    const effectiveCategory = _validCategories.has(category) ? category : 'other';

    const store = scope === 'plan' ? planKnowledge : sessionKnowledge;
    store.learn(key, value, {
      category: effectiveCategory,
      agentName: agent?.name || 'unknown',
    });

    channel.log('knowledge', `[${agent?.name || '?'}] learned [${scope}/${effectiveCategory}] ${key}: ${String(value).slice(0, 80)}`);

    return { success: true, key, category: effectiveCategory, scope, stored: true };
  },
};
