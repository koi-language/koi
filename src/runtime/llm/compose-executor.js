/**
 * Compose execution functions extracted from LLMProvider.
 *
 * These functions implement the compose-block prompt assembly logic:
 * an LLM generates an execution plan from named fragments + runtime actions,
 * and the plan is cached and replayed on subsequent calls.
 */

import { actionRegistry } from '../agent/action-registry.js';

// ---------------------------------------------------------------------------
// inferProviderFromModel
// ---------------------------------------------------------------------------

/**
 * Infer the LLM provider from a model name.
 * Used by executeCompose when a model is explicitly specified.
 *
 * @param {string} model
 * @returns {string} provider key ('openai' | 'gemini' | 'anthropic')
 */
export function inferProviderFromModel(model) {
  if (!model) return 'openai';
  if (model.startsWith('gemini-')) return 'gemini';
  if (model.startsWith('claude-')) return 'anthropic';
  // gpt-*, o1*, o3*, o4*, codex -> openai
  return 'openai';
}

// ---------------------------------------------------------------------------
// executeCompose
// ---------------------------------------------------------------------------

/**
 * Execute a compose block: call an LLM to dynamically assemble a prompt
 * from named fragments, optionally calling runtime actions (e.g. task_list)
 * to make the decision.
 *
 * @param {import('./llm-provider.js').LLMProvider} llmProvider - The LLMProvider instance to use
 * @param {Object} composeDef - { fragments, template, model }
 * @param {import('../agent/agent.js').Agent} agent - The agent requesting composition
 * @returns {Promise<string|{text: string, images: Array}>} The assembled prompt text
 */
export async function executeCompose(llmProvider, composeDef, agent) {
  const { fragments, template, model } = composeDef;

  // Resolve fragment values (may be strings, functions, or nested compose prompts)
  const resolvedFragments = {};
  for (const [name, value] of Object.entries(fragments)) {
    if (typeof value === 'function') {
      resolvedFragments[name] = value();
    } else if (value && value.__isCompose__) {
      // Recursively resolve nested compose prompts
      resolvedFragments[name] = await agent._executeComposePrompt(value, null);
    } else {
      resolvedFragments[name] = value || '';
    }
  }

  const callAction = async (intent, data = {}) => {
    // Special compose-only actions
    if (intent === 'frame_server_state') {
      return await agent._getFrameServerState();
    }
    const actionDef = actionRegistry.get(intent);
    if (!actionDef) return null;
    return await actionDef.execute({ intent, ...data }, agent);
  };

  // -- Fast path: use cached execution plan (no LLM call) --
  // The plan is generated once by the LLM, then replayed on every subsequent call.
  // This is critical because compose blocks inside playbooks are re-evaluated on
  // every reactive loop iteration -- calling an LLM each time would be prohibitive.
  if (composeDef._cachedPlan) {
    return await executeComposePlan(composeDef._cachedPlan, resolvedFragments, callAction);
  }

  // -- First call: use LLM to generate the execution plan --
  // When a model is explicitly specified, create a fresh LLMProvider for the
  // compose call.  We import LLMProvider lazily to avoid circular dependencies.
  let provider;
  if (model) {
    const { LLMProvider } = await import('./llm-provider.js');
    provider = new LLMProvider({ provider: inferProviderFromModel(model), model });
  } else {
    provider = llmProvider;
  }

  // Build available actions list for the compose LLM
  // Include hidden actions too -- compose resolvers need access to actions like
  // action_history that are hidden from the main LLM but available to compose.
  const directActions = actionRegistry.getAll().filter(a => {
    if (!a.permission) return true;
    return agent.hasPermission(a.permission);
  });
  const actionDocs = directActions
    .map(a => `- ${a.intent || a.type}: ${a.description || ''}`)
    .join('\n');

  const fragmentNames = Object.keys(resolvedFragments).join(', ');

  const systemPrompt = `You are a prompt composer. Generate an execution plan for assembling a prompt from fragments and runtime data.

## AVAILABLE FRAGMENTS
${fragmentNames}

## AVAILABLE ACTIONS (callable at runtime to get dynamic data)
${actionDocs}

## COMPOSITION TEMPLATE
${template}

## OUTPUT FORMAT
Return a JSON execution plan — an ordered array of steps. Each step is one of:
- { "fragment": "name" } — include this fragment's text
- { "call": "action_name", "data": {}, "field": "fieldName", "prefix": "optional text before the result" } — call an action at runtime, extract \`result[field]\` (usually "summary"), and include it as text. "prefix" is optional static text prepended before the action result.
- { "text": "static text to include" } — include literal text
- { "image_call": "action_name", "textField": "fieldName", "imageField": "screenshot", "mimeTypeField": "mimeType", "prefix": "optional text" } — call an action that returns both text and an image. The text (result[textField]) is included in the prompt, and the screenshot image (result[imageField]) is injected visually into the LLM call. Supported actions: "frame_server_state" (mobile screen, textField="elements"), "browser_observe" (browser screenshot, textField="elementsSummary").

Example:
[
  { "fragment": "planning" },
  { "fragment": "template" },
  { "call": "action_history", "data": { "count": 15 }, "field": "summary", "prefix": "## Action History\\n\\nReview the actions below. If you see the same action repeated 3+ times, you are stuck in a loop — change strategy immediately.\\n\\n" },
  { "image_call": "frame_server_state", "textField": "elements", "imageField": "screenshot", "mimeTypeField": "mimeType", "prefix": "## Current Mobile Screen\\n\\n" },
  { "image_call": "browser_observe", "textField": "elementsSummary", "imageField": "screenshot", "mimeTypeField": "mimeType", "prefix": "## Current Browser Page\\n\\n" }
]

Output ONLY the JSON array, no explanation.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Generate the execution plan now.' }
  ];

  try {
    const plan = await callJSONWithMessages(provider, messages);

    if (Array.isArray(plan) && plan.length > 0) {
      // Cache the plan on the composeDef so subsequent calls skip the LLM
      composeDef._cachedPlan = plan;

      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[Compose] Generated plan (${plan.length} steps):`, JSON.stringify(plan));
      }

      return await executeComposePlan(plan, resolvedFragments, callAction);
    }
  } catch (error) {
    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[Compose] Plan generation failed: ${error.message}`);
    }
  }

  // Fallback: concatenate all fragments
  if (process.env.KOI_DEBUG_LLM) {
    console.error('[Compose] Falling back to concatenated fragments');
  }
  return Object.values(resolvedFragments).join('\n\n');
}

// ---------------------------------------------------------------------------
// executeComposePlan
// ---------------------------------------------------------------------------

/**
 * Execute a cached compose plan -- no LLM call, just fragment concatenation
 * and runtime action calls.
 *
 * @param {Array} plan - The execution plan (array of steps)
 * @param {Object} resolvedFragments - Map of fragment name -> resolved text
 * @param {Function} callAction - async (intent, data) => result
 * @returns {Promise<string|{text: string, images: Array}>}
 */
export async function executeComposePlan(plan, resolvedFragments, callAction) {
  const parts = [];
  const images = [];

  for (const step of plan) {
    if (step.fragment && resolvedFragments[step.fragment] !== undefined) {
      parts.push(resolvedFragments[step.fragment]);
    } else if (step.image_call) {
      // Multimodal step: call action, extract text + image
      try {
        const result = await callAction(step.image_call, step.data || {});
        if (result) {
          const textValue = step.textField ? result[step.textField] : null;
          if (textValue) parts.push((step.prefix || '') + textValue);
          const imageData = step.imageField ? result[step.imageField] : null;
          const mimeType = step.mimeTypeField ? result[step.mimeTypeField] : 'image/jpeg';
          if (imageData) images.push({ data: imageData, mimeType });
        }
      } catch (err) {
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Compose] Image action ${step.image_call} failed: ${err.message}`);
        }
      }
    } else if (step.call) {
      try {
        const result = await callAction(step.call, step.data || {});
        const value = step.field ? result?.[step.field] : JSON.stringify(result);
        if (value) {
          parts.push((step.prefix || '') + value);
        }
      } catch (err) {
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Compose] Action ${step.call} failed: ${err.message}`);
        }
      }
    } else if (step.text) {
      parts.push(step.text);
    }
  }

  const text = parts.filter(Boolean).join('\n\n');
  // Return multimodal format if images were collected, otherwise plain text
  if (images.length > 0) {
    return { text, images };
  }
  return text;
}

// ---------------------------------------------------------------------------
// callJSONWithMessages
// ---------------------------------------------------------------------------

/**
 * Call the LLM with a full messages array and return a parsed JSON object.
 * Used by executeCompose for multi-turn composition.
 *
 * @param {import('./llm-provider.js').LLMProvider} llmProvider - The LLMProvider instance
 * @param {Array} messages - Array of { role, content } message objects
 * @returns {Promise<Object>} Parsed JSON response
 */
export async function callJSONWithMessages(llmProvider, messages) {
  try {
    const llm = llmProvider._createLLM({ maxTokens: 4096, temperature: 0 });
    const { text } = await llm.complete(messages, { responseFormat: 'json_object' });
    return JSON.parse(text || '{}');
  } catch (e) {
    if (process.env.KOI_DEBUG_LLM) {
      console.error('[Compose] _callJSONWithMessages error:', e.message);
    }
    return {};
  }
}
