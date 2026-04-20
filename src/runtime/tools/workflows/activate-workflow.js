/**
 * Activate Workflow Action — Instantiate a workflow's steps as concrete tasks.
 *
 * Unlike skills (which inject a static text block into the system prompt), a
 * workflow is a pre-approved plan. Activating it:
 *   1. Reads WORKFLOW.md (frontmatter stripped).
 *   2. Runs a cheap LLM translator that adapts the prose script into concrete
 *      tasks given the user's current message. No research, no redesign — it
 *      just instantiates the already-designed plan.
 *   3. Creates each task via task_create (task-manager handles persistence).
 *   4. Marks state.activeWorkflow = name (GUI / telemetry).
 *   5. Fires `planner.result { success: true }` on the invoking agent so the
 *      System coordinator transitions into its running_plan phase and starts
 *      executing the tasks just like it would for a Planner-produced plan.
 *
 * If the translator decides no tasks apply (e.g. the workflow was matched by
 * mistake), it returns `{ fallback: true }` and the action reports failure so
 * the caller falls back to normal routing.
 */

import fs from 'fs';
import { channel } from '../../io/channel.js';
import { fireReaction } from '../../agent/reactions.js';

async function runTranslator(agent, workflow, body, userMessage) {
  // Mirrors the cheap-classifier pattern used by _autoActivateSkills:
  // non-thinking, deterministic, short timeout. We just need a JSON list.
  const { getAllCandidates, createLLM, getAvailableProviders } = await import('../../llm/providers/factory.js');

  const providers = agent.llmProvider?._availableProviders || getAvailableProviders();
  const candidates = getAllCandidates('reasoning', 40, providers);
  if (candidates.length === 0) {
    return { tasks: [], fallback: true, reason: 'No LLM candidates available for translator' };
  }

  const nonThinking = candidates.find(c => !c.thinking) || candidates[0];
  const effectiveProvider = process.env.KOI_AUTH_TOKEN ? 'openai' : nonThinking.provider;
  const client = agent.llmProvider._getClient(effectiveProvider);
  const llm = createLLM(effectiveProvider, client, nonThinking.model, {
    temperature: 0,
    maxTokens: 1500,
    useThinking: false,
  });

  const prompt = `You are a workflow translator. A pre-approved workflow describes the ordered steps to complete a type of task. Your job is to INSTANTIATE those steps as concrete tasks for the user's current request.

Rules:
- Do NOT invent new steps that are not present in the workflow.
- Do NOT research, explore, or redesign — the plan is already validated.
- You MAY omit a step if the user's message explicitly opts out of it.
- You MAY specialize wording so each task's description is actionable in context
  (e.g. substitute the user's actual topic, file paths, or constraints).
- Keep the original step order.
- Each task "description" must be self-contained: an executing agent will read ONLY
  that description (no conversation history). Include all needed context.

USER REQUEST:
${(userMessage || '(no explicit user message)').substring(0, 1500)}

WORKFLOW: ${workflow.name}
WORKFLOW DESCRIPTION: ${workflow.description}

WORKFLOW BODY:
${body}

Return ONLY a JSON object with this shape, no prose, no markdown fences:
{
  "tasks": [
    { "subject": "<short imperative title>", "description": "<detailed, self-contained instructions>", "activeForm": "<present-continuous label, optional>" }
  ],
  "fallback": false
}

If the workflow does not actually match the user's request, return:
{ "tasks": [], "fallback": true, "reason": "<short explanation>" }`;

  try {
    const { text } = await llm.complete([{ role: 'user', content: prompt }], { timeoutMs: 30000 });
    const stripped = (text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (!stripped) return { tasks: [], fallback: true, reason: 'Empty translator response' };

    const objMatch = stripped.match(/\{[\s\S]*\}/);
    const jsonToParse = objMatch ? objMatch[0] : stripped;
    const parsed = JSON.parse(jsonToParse);

    if (!Array.isArray(parsed.tasks)) {
      return { tasks: [], fallback: true, reason: 'Malformed translator output (tasks not an array)' };
    }
    return parsed;
  } catch (err) {
    channel.log('workflow', `Translator failed: ${err.message}`);
    return { tasks: [], fallback: true, reason: `Translator error: ${err.message}` };
  }
}

export default {
  type: 'activate_workflow',
  intent: 'activate_workflow',
  description: 'Activate a workflow by name. Translates its WORKFLOW.md script into concrete tasks (via a cheap LLM), creates them, and fires planner.result to transition the System into running_plan. Fields: "name" (required). → Returns: { activated, name, taskCount, fallback?, reason? }',
  thinkingHint: (action) => `Activating workflow: ${action.name || '...'}`,
  permission: 'write_tasks',
  hidden: true,

  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The workflow name to activate (e.g. "generate-article")',
      },
    },
    required: ['name'],
  },

  examples: [
    { actionType: 'direct', intent: 'activate_workflow', name: 'generate-article' },
  ],

  async execute(action, agent) {
    const name = action.name;
    if (!name) return { activated: false, error: 'Missing required field: name' };

    const listResult = await agent.callAction('list_workflows', {});
    const workflows = listResult?._fullWorkflows || listResult?.workflows;
    if (!workflows) return { activated: false, error: 'Could not discover workflows' };

    const workflow = workflows.find(w => w.name === name);
    if (!workflow) {
      const available = workflows.map(w => w.name).join(', ');
      return { activated: false, error: `Workflow "${name}" not found. Available: ${available}` };
    }

    let body;
    try {
      const raw = fs.readFileSync(workflow.location, 'utf-8');
      const fmEnd = raw.indexOf('\n---', 4);
      body = fmEnd !== -1 ? raw.substring(fmEnd + 4).trim() : raw;
    } catch (err) {
      return { activated: false, error: `Failed to read ${workflow.location}: ${err.message}` };
    }

    // The System keeps the last user message on agent._lastUserMessage; delegates
    // may receive it via args. Fall back gracefully.
    const userMessage =
      agent._lastUserMessage ||
      action.userMessage ||
      agent.state?.lastUserMessage ||
      '';

    const translated = await runTranslator(agent, workflow, body, userMessage);

    if (translated.fallback || !translated.tasks || translated.tasks.length === 0) {
      channel.log('workflow', `Workflow "${name}" fell back to routing: ${translated.reason || 'no tasks'}`);
      return {
        activated: false,
        name,
        fallback: true,
        reason: translated.reason || 'Translator produced no tasks',
      };
    }

    // Create each task in-order via the task_create action so the task-manager
    // handles persistence, dedup, and change notifications uniformly.
    const createdIds = [];
    for (const t of translated.tasks) {
      if (!t || !t.subject || !t.description) continue;
      try {
        const result = await agent.callAction('task_create', {
          subject: String(t.subject),
          description: String(t.description),
          activeForm: t.activeForm ? String(t.activeForm) : undefined,
        });
        if (result?.id) createdIds.push(result.id);
      } catch (err) {
        channel.log('workflow', `Failed to create task "${t.subject}": ${err.message}`);
      }
    }

    if (createdIds.length === 0) {
      return {
        activated: false,
        name,
        fallback: true,
        reason: 'No tasks were created (translator returned items but task_create rejected all)',
      };
    }

    await agent.callAction('update_state', {
      updates: { activeWorkflow: name },
    });

    channel.log('workflow', `Workflow activated: ${name} (${createdIds.length} tasks created)`);
    channel.workflowActivated({
      name,
      description: workflow.description,
      taskCount: createdIds.length,
      taskIds: createdIds,
    });

    // Fire planner.result so the System transitions into running_plan.
    // Shape mirrors the payload fired by delegate returns (agent.js:2451).
    const resultPayload = {
      success: true,
      data: { workflow: name, taskIds: createdIds },
      error: null,
      taskCount: createdIds.length,
      cancelled: false,
    };
    const reactionCtx = {
      planner: { result: resultPayload },
      any: { result: resultPayload },
      state: agent.state,
    };
    try {
      fireReaction(agent, 'planner.result', null, reactionCtx);
    } catch (err) {
      channel.log('workflow', `fireReaction(planner.result) failed: ${err.message}`);
    }

    return {
      activated: true,
      name,
      taskCount: createdIds.length,
      taskIds: createdIds,
    };
  },
};
