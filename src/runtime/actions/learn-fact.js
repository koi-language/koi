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

import { sessionKnowledge } from '../session-knowledge.js';
import { cliLogger } from '../cli-logger.js';

export default {
  type: 'learn_fact',
  intent: 'learn_fact',
  description: 'Store a reusable project fact so other agents don\'t have to rediscover it. ONLY for: tech stacks, file paths, config values, env var names, service URLs, dependencies. NEVER for: user intent, task summaries, what you did, progress, conversation context. Fields: "key" (unique snake_case id), "value" (concise, max 200 chars — no code/file contents), "category" (tech_stack|path|config|credential|status|dependency)',
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
        description: 'Category — must be one of: tech_stack, path, config, credential, status, dependency. No generic "other" category.',
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
    const { key, value, category = 'other' } = action;

    if (!key || !value) {
      return { success: false, error: 'learn_fact: "key" and "value" are required' };
    }

    // Reject non-project facts: intent tracking, context dumps, narrative summaries
    const _rejectedKeys = new Set(['current_intent', 'initial_user_request', 'context']);
    if (_rejectedKeys.has(key)) {
      cliLogger.log('knowledge', `[${agent?.name || '?'}] REJECTED learn_fact: "${key}" is not a project fact`);
      return { success: false, error: `"${key}" is not a project fact. learn_fact is only for reusable project knowledge (paths, tech stacks, config, etc.), not conversation context or user intent.` };
    }

    // Reject "other" category — forces the LLM to pick a real category
    const _validCategories = new Set(['tech_stack', 'path', 'config', 'credential', 'status', 'dependency']);
    const effectiveCategory = _validCategories.has(category) ? category : null;
    if (!effectiveCategory) {
      cliLogger.log('knowledge', `[${agent?.name || '?'}] REJECTED learn_fact: invalid category "${category}" for key "${key}"`);
      return { success: false, error: `Invalid category "${category}". Must be one of: tech_stack, path, config, credential, status, dependency. If your fact doesn't fit any category, it probably shouldn't be stored.` };
    }

    sessionKnowledge.learn(key, value, {
      category: effectiveCategory,
      agentName: agent?.name || 'unknown',
    });

    cliLogger.log('knowledge', `[${agent?.name || '?'}] learned [${effectiveCategory}] ${key}: ${String(value).slice(0, 80)}`);

    return { success: true, key, category: effectiveCategory, stored: true };
  },
};
