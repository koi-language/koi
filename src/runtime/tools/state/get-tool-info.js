/**
 * Get Tool Info — retrieve full documentation for a built-in action.
 *
 * The system prompt only shows compact summaries (name + short description).
 * Call this when you need the full schema, instructions, and examples for
 * a specific action before using it.
 */

export default {
  type: 'get_tool_info',
  intent: 'get_tool_info',
  description: 'Get full documentation (schema, instructions, examples) for a built-in action. Use when you need parameter details before calling an action.',
  thinkingHint: 'Looking up tool info',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: 'The intent name of the action to look up (e.g. "edit_file", "shell", "semantic_code_search")',
      },
    },
    required: ['tool'],
  },

  async execute(action, agent) {
    const { tool } = action;
    if (!tool) {
      return { success: false, error: 'Missing "tool" parameter' };
    }
    // Dynamic import to avoid circular dependency (action-registry loads us)
    const { actionRegistry } = await import('../../agent/action-registry.js');

    // Some tools (the media generators) ship a static fallback description
    // that gets rewritten in-place once the backend catalog is fetched.
    // When the agent asks for the full schema before that rewrite settles
    // we'd hand back the stale fallback (no enums, no model list). Await
    // the per-tool readiness promise — bounded so a stuck fetch never
    // blocks the call indefinitely.
    const def = actionRegistry.get(tool);
    if (def && def._descriptionReady && typeof def._descriptionReady.then === 'function') {
      try {
        await Promise.race([
          def._descriptionReady,
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      } catch { /* readiness promise rejected — fall through to whatever description is live */ }
    }

    const doc = actionRegistry.getActionDocumentation(tool);
    if (!doc) {
      return { success: false, error: `Unknown action: "${tool}"` };
    }
    // Remember that THIS agent asked for the full schema of this tool.
    // action-registry.generateExpandedToolsBlock reads this map and
    // splices the full entry into the DYNAMIC section of every
    // subsequent prompt for this agent — so the model doesn't forget
    // the parameter details three iterations later and re-guess them
    // (we hit this with resolution "2K" vs a fleet advertising only
    // ["low","medium","high","ultra"]).
    //
    // We store the iteration at which the doc will FIRST be visible to
    // the LLM (current iteration + 1, since recordAction increments
    // iteration immediately after this returns). Both the dynamic-block
    // generator and ContextMemory.toMessages key off this value:
    //   - dynamic block: include only when currentIter > expansionIter
    //     (i.e. starting from the iteration AFTER the LLM first sees the
    //     result), so the iteration where the tool result lands as a
    //     fresh user-prompt entry doesn't double-print the doc.
    //   - toMessages: rewrite the historical user-prompt entry to a tiny
    //     placeholder once currentIter > expansionIter, so the full doc
    //     only lives in one place — the dynamic block.
    // Scoped to one agent instance, so delegates don't inherit siblings'
    // expansions.
    if (agent) {
      if (!(agent._expandedTools instanceof Map)) agent._expandedTools = new Map();
      const expansionIter = (agent._activeSession?.iteration ?? -1) + 1;
      agent._expandedTools.set(tool, expansionIter);
    }
    return { success: true, tool, documentation: doc };
  },
};
