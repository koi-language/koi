/**
 * `requireToolInfoFirst(toolName, agent)`
 *
 * Guard for media-generation tools (and any other tool whose schema
 * carries enough complexity that calling it blind is a guaranteed
 * misuse). If the calling agent has NOT previously asked for the
 * tool's documentation via `get_tool_info(<toolName>)` in this
 * session, intercept the call and return the documentation INSTEAD
 * of executing. Mark the tool as "seen" so the very next call (same
 * turn or later) proceeds normally.
 *
 * Why: the system prompt already says "you MUST call get_tool_info
 * before invoking any of these" — but the model frequently ignores
 * that, especially on a delegate's first turn, and ends up calling
 * `generate_image` (or _video, _audio, etc.) without ever seeing
 * the per-model catalog block. That block is where it learns about
 * available `label`s (live list pulled from the backend catalog — see
 * the per-tool "Label glossary" section), `excludeModels`,
 * `excludeProviders`, the live aspect/resolution enums, and which
 * models are gated for which intents. Skipping it
 * means the picker resolves to a default that frequently doesn't
 * match the request (gpt-image-2 with a strict content checker for
 * an explicit prompt, etc.) and the call wastes a round-trip.
 *
 * This guard is the runtime backstop: if the prose instruction
 * doesn't land, the FIRST blind call returns documentation and the
 * agent learns about the catalog before its second attempt.
 *
 * Returns a tool-result-shaped object when the guard fires (caller
 * should `return` it verbatim), or `null` when the agent has already
 * seen the docs and the real execute can proceed.
 */
export async function requireToolInfoFirst(toolName, agent) {
  // Reuse the same map that get_tool_info populates so the two
  // remember-paths stay in sync. The map is keyed by tool name; the
  // value is the iteration when the docs first land in the LLM's
  // context (we don't care about the value here, only the presence).
  if (agent?._expandedTools instanceof Map && agent._expandedTools.has(toolName)) {
    return null; // Already learned about this tool — let execute proceed.
  }

  // Pull the same documentation block `get_tool_info` would return.
  // Dynamic import to avoid the registry → tool circular dependency
  // (action-registry imports each tool module at boot).
  const { actionRegistry } = await import('../agent/action-registry.js');

  const def = actionRegistry.get(toolName);
  // Some media tools rewrite their `description` in place once the
  // backend catalog is fetched (model list, labels, enums). The
  // first blind call often arrives BEFORE that rewrite settles — so
  // wait briefly for the readiness promise, bounded, exactly like
  // get_tool_info does. Otherwise the doc we hand back is the stale
  // pre-fetch fallback and the agent re-runs blind on the second
  // call too.
  if (def && def._descriptionReady && typeof def._descriptionReady.then === 'function') {
    try {
      await Promise.race([
        def._descriptionReady,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch { /* readiness promise rejected — fall through */ }
  }

  const doc = actionRegistry.getActionDocumentation(toolName);
  // Mark as seen even if doc is null — there's no point looping the
  // guard on a tool whose registry entry vanished mid-call.
  const expansionIter = (agent?._activeSession?.iteration ?? -1) + 1;
  if (agent) {
    if (!(agent._expandedTools instanceof Map)) agent._expandedTools = new Map();
    agent._expandedTools.set(toolName, expansionIter);
  }

  if (!doc) {
    return {
      success: false,
      error: `Tool "${toolName}" has no documentation available — cannot enforce the get_tool_info-first contract.`,
    };
  }

  // CRITICAL: report `success: false`. The guard returned the schema
  // INSTEAD of executing — so for a generation tool NOTHING was produced
  // (no image/video/audio file, no media id). Reporting `success: true`
  // (to mirror get_tool_info's shape) made fast models read this as "the
  // generation succeeded": they'd store a "Part 1 generated" memory, look
  // for an output file that never existed, and — failing to find it — go
  // hunting on disk and splice in an artefact from a DIFFERENT project.
  // A blocked generation is a failure; surface it as one and force a
  // re-issue. The `_guardedAutoExpand` flag is dev-facing log breadcrumb only.
  return {
    success: false,
    tool: toolName,
    documentation: doc,
    expansionIter,
    _guardedAutoExpand: true,
    error:
      `${toolName} did NOT run — nothing was generated or saved (no file, no media id). ` +
      `It was invoked without first calling get_tool_info("${toolName}"), so the call was ` +
      `blocked and the schema returned instead. Do NOT treat this as a completed generation: ` +
      `do not store a "done"/"generated" memory, do not look for an output file, do not ` +
      `substitute any other file. The full schema is now in your context (labels, ` +
      `excludeProviders, excludeModels, aspect/resolution enums, live per-model catalog). ` +
      `Re-issue the SAME ${toolName} call now to actually run it.`,
  };
}
