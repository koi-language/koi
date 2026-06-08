/**
 * Response parsing utilities extracted from LLMProvider.
 * Standalone functions for parsing reactive LLM responses into action objects.
 */

import { channel } from '../io/channel.js';
import { parse as parseYaml } from 'yaml';

// Recognised top-level keys of a real action / batch. Used to tell a genuine
// (if malformed) action object apart from a prose sentence that YAML happened
// to coerce into a map (e.g. "Note: done." → { Note: 'done.' }).
const _ACTION_KEYS = new Set([
  'actionType', 'intent', 'type', 'batch', 'parallel', 'actions',
  'data', 'summary', 'message', 'text', 'result', 'answer', 'user_request_compliance',
]);
function _looksLikeAction(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return true; // a sequence of actions
  return Object.keys(obj).some(k => _ACTION_KEYS.has(k));
}

/**
 * Log a debug message (only when KOI_DEBUG_LLM=1).
 * @private
 */
function logDebug(message) {
  if (process.env.KOI_DEBUG_LLM !== '1') return;
  console.error(`[LLM Debug] ${message}`);
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
    cleaned = cleaned.replace(/^```(?:ya?ml|json)?\n?/i, '').replace(/\n?```$/, '').trim();
  }
  const _rawCleaned = cleaned; // pre-strip copy, used for the prose fallback

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
    // PRIMARY: parse as YAML. YAML is a strict superset of JSON, so this
    // accepts BOTH the YAML the agent now emits AND any legacy/stray JSON,
    // which is our safety net during the migration. The `yaml` package uses
    // the 1.2 core schema, so `yes/no/on/off` stay strings (no "Norway
    // problem") and only true/false/null are booleans.
    parsed = parseYaml(cleaned, { uniqueKeys: false });
    if (parsed === undefined) throw new Error('empty YAML document');
    // A bare scalar (string/number/bool) means the model answered in PROSE,
    // not an action map/sequence — surface it verbatim as a print (same as
    // the prose fallback in the catch below). YAML is lenient enough that a
    // sentence with no colon parses as a plain string.
    if (parsed === null || typeof parsed !== 'object') {
      return normalizeReactiveAction({
        actionType: 'direct', intent: 'print', message: String(parsed ?? '').trim(),
      });
    }
    // YAML coerced prose-with-a-colon ("Note: done.") into a 1-key map. If
    // NONE of the keys look like a real action, it was prose, not a tool
    // call — print the original text instead of throwing on a bogus action.
    if (!_looksLikeAction(parsed)) {
      return normalizeReactiveAction({
        actionType: 'direct', intent: 'print', message: _rawCleaned.trim(),
      });
    }
  } catch (firstErr) {
    // YAML parse failed (genuinely malformed / truncated). Fall through to
    // the JSON-specific repair ladder below — it handles bad escapes,
    // concatenated objects and truncation that YAML can't recover either.
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
      // The model answered in plain PROSE — it never even tried to emit a
      // JSON action. This is common when a model just "answers the question"
      // directly (e.g. it watched a video and wrote the whole shot-list table
      // as its reply). Throwing here discards a perfectly good answer AND
      // forces a retry that often makes the agent thrash into other tools
      // (shell / ffmpeg). So when there is NO JSON structure at all — the
      // response doesn't start with `{` or `[`, and every extraction fallback
      // above came up empty — treat the entire response as a `print`: surface
      // the answer to the user verbatim instead of erroring.
      //
      // We do this ONLY for clear prose. A response that DID start with `{` /
      // `[` but failed to parse is a genuinely malformed / truncated JSON
      // action — that still throws to retry, so we never silently swallow a
      // half-formed tool call (the exact anti-pattern the user banned).
      const _trimmed = cleaned.trim();
      if (_trimmed.length > 0 && !_trimmed.startsWith('{') && !_trimmed.startsWith('[')) {
        return normalizeReactiveAction({
          actionType: 'direct',
          intent: 'print',
          message: _trimmed,
        });
      }

      // No recovery via a secondary LLM: we must NEVER invent actions the
      // agent did not explicitly emit. A second model "fixing" a malformed
      // response is guessing intent on behalf of the real agent — the same
      // anti-pattern the user has banned. Surface the parse failure instead
      // so the real agent retries with a valid JSON action.
      throw new Error(
        `Your response was not valid YAML (or JSON) and could not be parsed. ${firstErr.message}. ` +
        `Response received: ${cleaned.substring(0, 300)}. ` +
        `Retry with a valid YAML action, e.g.:\nactionType: direct\nintent: print\nmessage: "..."`
      );
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

  // If the payload has no intent/actionType/type but looks like a final
  // summary or message, auto-wrap as a return action instead of crashing.
  if (!parsed.intent && !parsed.actionType && !parsed.type) {
    const _text = parsed.summary || parsed.message || parsed.text || parsed.result || parsed.answer;
    if (_text && typeof _text === 'string') {
      parsed.actionType = 'direct';
      parsed.intent = 'return';
      parsed.data = { success: true, summary: _text };
    } else {
      throw new Error(
        `Your response did not contain a valid action. Expected YAML with an "intent" or "actionType" key (e.g.\nactionType: direct\nintent: print\nmessage: "..."). ` +
        `Got: ${JSON.stringify(parsed).substring(0, 300)}. ` +
        `Retry with a valid action. If you wanted to finish the task, emit:\nactionType: direct\nintent: return\ndata:\n  ...`
      );
    }
  }

  return parsed;
}
