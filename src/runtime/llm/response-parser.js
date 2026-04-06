/**
 * Response parsing utilities extracted from LLMProvider.
 * Standalone functions for parsing reactive LLM responses into action objects.
 */

import { channel } from '../io/channel.js';
import { actionRegistry } from '../agent/action-registry.js';

/**
 * Log a debug message (only when KOI_DEBUG_LLM=1).
 * @private
 */
function logDebug(message) {
  if (process.env.KOI_DEBUG_LLM !== '1') return;
  console.error(`[LLM Debug] ${message}`);
}

/**
 * Search commit embeddings for context relevant to user text.
 * Returns a string to inject into the LLM context, or '' if nothing relevant.
 *
 * @param {string} userText - The user's message text to match against commits.
 * @param {function(string): Promise<number[]|null>} getEmbeddingFn - Callback to get an embedding vector.
 * @returns {Promise<string>}
 */
export async function searchRelevantCommits(userText, getEmbeddingFn) {
  try {
    const { sessionTracker } = await import('../state/session-tracker.js');
    if (!sessionTracker) return '';

    const { commits } = sessionTracker.loadCommitEmbeddings();
    const hashes = Object.keys(commits);
    if (hashes.length === 0) return '';

    const userEmbedding = await getEmbeddingFn(userText);
    if (!userEmbedding) return '';

    const { SessionTracker } = await import('../state/session-tracker.js');

    // Score each commit
    const allScored = hashes.map(hash => ({
      hash,
      summary: commits[hash].summary,
      score: SessionTracker.cosineSimilarity(userEmbedding, commits[hash].embedding)
    }));

    channel.log('llm', `Commit search: ${allScored.length} commits scored against "${userText.substring(0, 60)}"`);
    for (const c of allScored) {
      channel.log('llm', `  [${c.hash}] score=${c.score.toFixed(3)} ${c.score >= 0.35 ? '✓' : '✗'} "${c.summary}"`);
    }

    const matched = allScored
      .filter(c => c.score >= 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (matched.length === 0) {
      channel.log('llm', `Commit search: no matches above threshold (0.35)`);
      return '';
    }

    channel.log('llm', `Commit search: injecting ${matched.length} relevant commit(s)`);

    // Build context with truncated diffs
    const parts = matched.map(c => {
      let diff = '';
      try {
        diff = sessionTracker.getCommitDiff(c.hash);
      } catch { /* no diff */ }
      return `[${c.hash}] "${c.summary}"${diff ? `\nDiff:\n${diff}` : ''}`;
    });

    return `\n\nRELEVANT SESSION CHANGES:\n${parts.join('\n\n')}`;
  } catch (err) {
    channel.log('llm', `Commit search failed: ${err.message}`);
    return '';
  }
}

/**
 * Parse the LLM response from reactive mode into a single action object.
 * Handles edge cases like markdown wrapping or legacy array format.
 * If parsing fails entirely, attempts a recovery call with a stronger model.
 *
 * @param {string} responseText - Raw LLM response text.
 * @param {object|null} agent - The agent object (used for recovery prompt generation).
 * @param {function(string, string, number): Promise<string>} callUtilityFn - Callback for LLM utility calls (system, user, maxTokens).
 * @returns {Promise<object|object[]>}
 */
export async function parseReactiveResponse(responseText, agent = null, callUtilityFn = null) {
  // Clean markdown code blocks
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  // Strip preamble: some models (e.g. Anthropic) write reasoning text before the JSON.
  // Find the first { or [ that starts valid JSON and discard everything before it.
  // Capture preamble text — if the action is prompt_user, inject it as "message".
  // Prefer { over [ — arrays at the top level are rare and often false positives
  // (e.g. the LLM writes "[0, range)" as math notation, not a JSON array).
  let preambleText = '';
  const braceIdx = cleaned.indexOf('{');
  let bracketIdx = cleaned.indexOf('[');
  // Only trust [ if it looks like a JSON array of objects (reactive actions are always objects)
  if (bracketIdx >= 0) {
    const afterBracket = cleaned.substring(bracketIdx + 1).trimStart();
    if (!afterBracket.startsWith('{')) {
      bracketIdx = -1; // Not an array of action objects — ignore it
    }
  }
  const jsonStart = braceIdx >= 0 && bracketIdx >= 0
    ? Math.min(braceIdx, bracketIdx)
    : braceIdx >= 0 ? braceIdx : bracketIdx;
  if (jsonStart > 0) {
    preambleText = cleaned.substring(0, jsonStart).trim();
    cleaned = cleaned.substring(jsonStart);
  }

  // Strip trailing text after JSON: some models (Gemini) append explanations
  // after the JSON object. Find the matching closing brace/bracket by counting.
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    const openChar = cleaned[0];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let jsonEnd = -1;
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === openChar) depth++;
      else if (ch === closeChar) { depth--; if (depth === 0) { jsonEnd = i; break; } }
    }
    if (jsonEnd > 0 && jsonEnd < cleaned.length - 1) {
      cleaned = cleaned.substring(0, jsonEnd + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (firstErr) {
    // Fallback 0: Fix malformed escape sequences and literal newlines/tabs inside JSON string values.
    // Some models (Gemini) emit literal newlines within strings instead of \n,
    // or produce invalid escape sequences like \a, \p, \s etc. in diff content.
    try {
      const fixed = cleaned.replace(/"(?:[^"\\]|\\.)*"/gs, match => {
        let s = match;
        // Fix literal control characters
        s = s.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        // Fix invalid escape sequences: \X where X is not a valid JSON escape char.
        // Valid: \", \\, \/, \b, \f, \n, \r, \t, \uXXXX
        // Replace invalid \X with \\X (escaped backslash + literal char)
        s = s.replace(/\\([^"\\/bfnrtu])/g, '\\\\$1');
        return s;
      });
      parsed = JSON.parse(fixed);
    } catch { /* fall through */ }

    if (!parsed) {
      // Fallback 1: LLM returned multiple JSON objects on separate lines
      const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
      if (lines.length > 1) {
        try {
          const actions = lines.map(l => JSON.parse(l));
          return actions.map(a => normalizeReactiveAction(a));
        } catch { /* fall through */ }
      }
      // Fallback 2: concatenated objects without newline: {...}{...}
      try {
        const asArray = JSON.parse(`[${cleaned.replace(/\}\s*\{/g, '},{')}]`);
        if (Array.isArray(asArray) && asArray.length > 0) {
          return asArray.map(a => normalizeReactiveAction(a));
        }
      } catch { /* fall through */ }
      // Fallback 3: truncated response — try to parse just the first complete JSON object
      const objMatches = [...cleaned.matchAll(/\{[\s\S]*?\}(?=\s*[\{$]|\s*$)/g)];
      if (objMatches.length > 0) {
        for (const match of objMatches) {
          const block = match[0];
          const hasJsIdentifiers = /:\s*(?!["\d{\[]|true\b|false\b|null\b)[A-Za-z_$][\w$\.]*\b/.test(block);
          const hasJsKeywords = /\bfunction\b|=>|\bthis\./.test(block);
          if (hasJsIdentifiers || hasJsKeywords) {
            continue;
          }
          try {
            const firstObj = JSON.parse(block);
            return normalizeReactiveAction(firstObj);
          } catch { /* fall through */ }
        }
      }
      // Recovery: use a fast model to convert the malformed response into valid JSON.
      // The recovery prompt includes the available tools so the model knows the schema.
      if (agent && callUtilityFn) {
        try {
          const toolDocs = actionRegistry.generatePromptDocumentation(agent);
          const recoveryPrompt = `An LLM produced this INVALID response instead of JSON:\n\n${cleaned.substring(0, 500)}\n\nConvert it into a valid JSON action. Available actions:\n${toolDocs.substring(0, 2000)}\n\nReturn ONLY valid JSON: {"actionType":"direct","intent":"<action_name>",...}`;
          const recovered = await callUtilityFn('Return ONLY valid JSON. No markdown.', recoveryPrompt, 300);
          channel.log('llm', `[recovery] Attempting to fix malformed response: "${cleaned.substring(0, 100)}"`);
          const recoveredCleaned = recovered.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
          const recoveredParsed = JSON.parse(recoveredCleaned);
          channel.log('llm', `[recovery] Success: ${JSON.stringify(recoveredParsed).substring(0, 200)}`);
          return normalizeReactiveAction(recoveredParsed);
        } catch (recoveryErr) {
          channel.log('llm', `[recovery] Failed: ${recoveryErr.message}`);
        }
      }
      throw new Error(`Failed to parse reactive LLM response as JSON: ${firstErr.message}\nResponse: ${cleaned.substring(0, 200)}`);
    }
  }

  // Helper: inject preamble text into the last prompt_user in an action list
  const _injectPreamble = (actions) => {
    if (!preambleText) return actions;
    // Find the last prompt_user action and inject preamble as message
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i];
      if (a && a.intent === 'prompt_user' && !a.message) {
        a.message = preambleText;
        break;
      }
    }
    return actions;
  };

  // Extract user_request_compliance from first batch element (if present).
  // This is a separate declaration from the actions — strip it before processing.
  const _extractCompliance = (items) => {
    if (items.length > 0 && items[0].user_request_compliance) {
      const compliance = items[0].user_request_compliance;
      items.shift(); // remove compliance declaration from actions
      if (compliance !== 'will_do') {
        // Mark all remaining actions as refused
        for (const a of items) a._refused = true;
        channel.log('llm', `[compliance] Model declared "${compliance}" for user request`);
      }
    }
    return items;
  };

  // Handle batched actions: { "batch": [action1, action2, ...] }
  // Items may be regular actions OR { "parallel": [...] } groups.
  if (parsed.batch && Array.isArray(parsed.batch) && parsed.batch.length > 0) {
    logDebug(`Reactive response batched ${parsed.batch.length} actions`);
    let actions = _extractCompliance(parsed.batch).map(a => normalizeBatchItem(a));
    _injectPreamble(actions);
    return actions.length === 1 ? actions[0] : actions;
  }

  // Handle raw array (in case json_object mode is not used)
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error('Reactive response was an empty array');
    }
    let actions = _extractCompliance(parsed).map(a => normalizeReactiveAction(a));
    _injectPreamble(actions);
    return actions.length === 1 ? actions[0] : actions;
  }

  // If LLM returned legacy format { "actions": [...] }, extract as batch
  if (parsed.actions && Array.isArray(parsed.actions) && parsed.actions.length > 0) {
    logDebug('Reactive response used legacy {actions:[...]} format, extracting as batch');
    let actions = parsed.actions.map(a => normalizeReactiveAction(a));
    _injectPreamble(actions);
    return actions.length === 1 ? actions[0] : actions;
  }

  // Handle top-level parallel group: { "parallel": [...] }
  // The LLM sometimes returns a parallel block as the root object (without a batch wrapper).
  // Without this check, normalizeReactiveAction sees no intent/actionType/type and
  // wraps the whole parallel block as `{ intent: 'return', data: { parallel: [...] } }`,
  // causing all parallel actions to be silently discarded as return data.
  if (parsed.parallel && Array.isArray(parsed.parallel) && parsed.parallel.length > 0) {
    logDebug('Reactive response was a top-level parallel group, normalizing inner actions');
    return { parallel: parsed.parallel.map(a => normalizeReactiveAction(a)) };
  }

  const result = normalizeReactiveAction(parsed);

  // If the LLM wrote explanation text before the JSON and the action is prompt_user,
  // inject the preamble as the "message" field so it's displayed to the user.
  if (preambleText && result && !Array.isArray(result)) {
    const action = result;
    if (action.intent === 'prompt_user' && !action.message) {
      action.message = preambleText;
    }
  }

  return result;
}

/**
 * Normalize a single item from a batch array.
 * If it's a { parallel: [...] } group, normalize each inner action.
 * Otherwise treat it as a regular action.
 *
 * @param {object} item - A batch item (action or parallel group).
 * @returns {object}
 */
export function normalizeBatchItem(item) {
  if (item && Array.isArray(item.parallel)) {
    return { parallel: item.parallel.map(a => normalizeReactiveAction(a)) };
  }
  return normalizeReactiveAction(item);
}

/**
 * Normalize a single action object from a reactive response.
 *
 * @param {object} parsed - A parsed action object.
 * @returns {object}
 */
export function normalizeReactiveAction(parsed) {
  // Strip compliance fields (batch-level or legacy inline)
  if (parsed.user_request_compliance) {
    if (parsed.user_request_compliance !== 'will_do') parsed._refused = true;
    delete parsed.user_request_compliance;
  }
  if (parsed._compliance) {
    if (parsed._compliance !== 'will_do') parsed._refused = true;
    delete parsed._compliance;
  }


  // Safety net: if actionType is not "direct"/"delegate", the LLM put the intent there
  if (parsed.actionType && parsed.actionType !== 'direct' && parsed.actionType !== 'delegate') {
    if (!parsed.intent) {
      parsed.intent = parsed.actionType;
    }
    parsed.actionType = 'direct';
  }

  // Validate minimal structure — if no action fields, treat as raw return data
  if (!parsed.intent && !parsed.actionType && !parsed.type) {
    if (Object.keys(parsed).length > 0) {
      logDebug('Reactive response was raw data, wrapping as return action');
      return { actionType: 'direct', intent: 'return', data: parsed };
    }
    throw new Error(`Invalid reactive action: missing "intent" or "actionType". Got: ${JSON.stringify(parsed).substring(0, 200)}`);
  }

  return parsed;
}
