/**
 * Context Compiler — public API.
 *
 *   compile({ agent, trigger, sessionId, budgetTokens, agentsRoot, projectRoot })
 *     → { system, slots, metadata }
 *
 * Pipeline:
 *   1. Load agent's slot map.
 *   2. Resolve all slots (static, trigger, memory, event_log, file, runtime).
 *   3. Allocate token budget across resolved slots.
 *   4. Render template with included content.
 *   5. Return prompt + per-slot metadata for telemetry.
 *
 * The output is meant to be consumed as the system prompt for an LLM call;
 * the message history and trigger-specific user message are added by the
 * caller (the agent runtime), not by the compiler.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { loadSlotMap, resolveSlots, registerProvider } from './slot-resolver.js';
import { allocate, estimateTokens } from './budget.js';
import { render } from './renderer.js';

export { registerProvider };

const DEFAULT_BUDGET_TOKENS = 60_000;

/**
 * Compile a prompt for an agent.
 *
 * @param {object} opts
 * @param {string} opts.agent          Agent name, e.g. 'planner'.
 * @param {object} opts.trigger        Event that triggered compilation (UserMessage, AgentDelegated, …).
 * @param {string} opts.sessionId      Active session id (for event_log slot).
 * @param {object} [opts.agentObject]  Live agent runtime obj (passed to memory.ensureInit etc.).
 * @param {number} [opts.budgetTokens]
 * @param {string} opts.agentsRoot     Path to <repo>/src/agents (where slots.yaml/template.* live).
 * @param {string} [opts.projectRoot]  Project root for `file` source.
 * @returns {Promise<{ system: string, slots: object[], metadata: object }>}
 */
export async function compile(opts) {
  if (!opts || !opts.agent) throw new Error('compile: agent required');
  if (!opts.agentsRoot) throw new Error('compile: agentsRoot required');

  const ctx = {
    agent: opts.agent,
    agentObject: opts.agentObject,
    sessionId: opts.sessionId,
    trigger: opts.trigger,
    agentsRoot: opts.agentsRoot,
    projectRoot: opts.projectRoot ?? process.cwd(),
    warnings: [],
  };

  const budgetTokens = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;

  // 1. Load slot map
  const slotMap = await loadSlotMap(opts.agent, opts.agentsRoot);

  // 2. Resolve slots in parallel where possible (each slot's source is independent)
  const resolved = await resolveSlots(slotMap, ctx);

  // 3. Allocate token budget
  const { slots: budgeted, totalUsed, overflow } = allocate(resolved, budgetTokens);

  // 4. Load template and render
  const tmplName = slotMap.template ?? 'template.md';
  const tmplPath = path.join(opts.agentsRoot, opts.agent, tmplName);
  let template;
  try {
    template = await fs.readFile(tmplPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Fallback: render slots in declared order with a heading per slot.
      template = budgeted.map((s) => `## ${s.id}\n{{${s.id}}}`).join('\n\n');
    } else {
      throw err;
    }
  }
  const slotMap2 = Object.fromEntries(budgeted.map((s) => [s.id, s.included]));
  const system = render(template, slotMap2);

  // 5. Metadata for telemetry / debugging
  const metadata = {
    agent: opts.agent,
    budgetTokens,
    totalUsed,
    overflow,
    slots: budgeted.map((s) => ({
      id: s.id,
      mode: s.mode,
      allocated: s.allocated,
      truncated: s.included.length < s.content.length,
      contentChars: s.content.length,
    })),
    warnings: ctx.warnings,
  };

  return { system, slots: budgeted, metadata };
}
