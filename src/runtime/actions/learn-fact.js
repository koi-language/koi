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
  description: 'Store a discovered fact in the shared session knowledge store so all agents in this session can use it without rediscovering it. Use for: tech stacks, file paths, config values, env var names, service URLs, deployment outputs. Fields: "key" (unique snake_case id), "value" (concise, max 200 chars — no code/file contents), "category" (tech_stack|path|config|credential|status|dependency|other)',
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
        description: 'Concise fact value (max 200 chars). Do NOT include file contents, code snippets, or binary data.',
      },
      category: {
        type: 'string',
        enum: ['tech_stack', 'path', 'config', 'credential', 'status', 'dependency', 'other'],
        description: 'Category for organisation and retrieval',
      },
    },
    required: ['key', 'value'],
  },

  examples: [
    { actionType: 'direct', intent: 'learn_fact', key: 'frontend_tech_stack', value: 'React 18 + Vite 5 + TypeScript, no SSR, builds to dist/', category: 'tech_stack' },
    { actionType: 'direct', intent: 'learn_fact', key: 'infra_dir', value: '~/Documents/Git/Koi-lang/infra', category: 'path' },
    { actionType: 'direct', intent: 'learn_fact', key: 'backend_db_env_var', value: 'DATABASE_URL — full PostgreSQL connection string including credentials', category: 'dependency' },
    { actionType: 'direct', intent: 'learn_fact', key: 'ecr_base_url', value: '123456789.dkr.ecr.eu-west-1.amazonaws.com', category: 'config' },
    { actionType: 'direct', intent: 'learn_fact', key: 'eks_cluster_name', value: 'myapp-eks-cluster (us-east-1)', category: 'status' },
  ],

  async execute(action, agent) {
    const { key, value, category = 'other' } = action;

    if (!key || !value) {
      return { success: false, error: 'learn_fact: "key" and "value" are required' };
    }

    sessionKnowledge.learn(key, value, {
      category,
      agentName: agent?.name || 'unknown',
    });

    cliLogger.log('knowledge', `[${agent?.name || '?'}] learned [${category}] ${key}: ${String(value).slice(0, 80)}`);

    return { success: true, key, category, stored: true };
  },
};
