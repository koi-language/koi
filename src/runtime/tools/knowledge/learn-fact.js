/**
 * Learn Fact Action — store a discovered fact in the persistent memory vault.
 *
 * Backed by the new memory architecture (Ori-vendored RMH at .koi/memory/).
 * The action's external API (key/value/category/scope) is preserved for
 * backward compatibility with existing .koi agent prompts; internally it
 * routes through `memory.write()`.
 *
 * Mapping:
 *   key       → note title (slugified)
 *   value     → description (≤200) + body
 *   category  → project tag (tech_stack|path|config|...) — preserved for filtering
 *   scope     → 'session' or 'plan' — both stored as type=learning. 'plan' notes
 *               get a `_plan` project tag so they can be filtered/cleared per plan.
 */

import * as memory from '../../memory/index.js';
import { channel } from '../../io/channel.js';

const VALID_CATEGORIES = new Set([
  'tech_stack', 'path', 'config', 'credential', 'status', 'dependency',
]);

const _IGNORED_KEYS = new Set([
  'current_intent', 'initial_user_request', 'context',
  'user_request', 'task_intent', 'goal', 'objective',
]);

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
        description: 'Descriptive fact value (max 200 chars). Must explain WHAT it is and WHY it matters, not just the raw value.',
      },
      category: {
        type: 'string',
        enum: ['tech_stack', 'path', 'config', 'credential', 'status', 'dependency'],
        description: 'Category — must be one of: tech_stack, path, config, credential, status, dependency.',
      },
      scope: {
        type: 'string',
        enum: ['session', 'plan'],
        description: 'Scope. "session" (default) = durable project knowledge. "plan" = transient details shared between sibling tasks.',
      },
    },
    required: ['key', 'value'],
  },

  examples: [
    { actionType: 'direct', intent: 'learn_fact', key: 'frontend_tech_stack', value: 'React 18 + Vite 5 + TypeScript', category: 'tech_stack' },
    { actionType: 'direct', intent: 'learn_fact', key: 'db_schema_path', value: '../backend/src/db/schema.ts — Drizzle ORM table definitions', category: 'path' },
  ],

  async execute(action, agent) {
    const { key, category = 'config', scope = 'session' } = action;
    const value = typeof action.value === 'object' && action.value !== null
      ? JSON.stringify(action.value)
      : action.value;

    if (!key || !value) {
      return { success: false, error: 'learn_fact: "key" and "value" are required' };
    }

    // Silently swallow non-project keys.
    if (_IGNORED_KEYS.has(key)) {
      channel.log('knowledge', `[${agent?.name || '?'}] Ignored learn_fact: "${key}" (not a project fact)`);
      return { success: true, stored: false, message: 'Noted.' };
    }

    const effectiveCategory = VALID_CATEGORIES.has(category) ? category : 'other';

    try {
      await memory.ensureInit(agent);
    } catch (err) {
      // Memory not available — degrade gracefully so the agent doesn't crash.
      channel.log('knowledge', `learn_fact: memory init failed (${err.message}) — fact dropped`);
      return { success: true, stored: false, message: 'Memory unavailable; fact not persisted.' };
    }

    const title = String(key).replace(/_/g, ' ');
    const projects = [effectiveCategory];
    if (scope === 'plan') projects.push('_plan');

    try {
      const result = await memory.write({
        title,
        description: String(value).slice(0, 200),
        type: 'learning',
        project: projects,
        confidence: 'validated',
        body: String(value),
      });

      channel.log('knowledge',
        `[${agent?.name || '?'}] learned [${scope}/${effectiveCategory}] ${key} → ${result.title} (${result.status})`);

      return {
        success: true,
        key,
        category: effectiveCategory,
        scope,
        stored: true,
        promoted: result.status === 'active',
      };
    } catch (err) {
      channel.log('knowledge', `learn_fact write failed: ${err.message}`);
      return { success: false, error: `learn_fact failed: ${err.message}` };
    }
  },
};
