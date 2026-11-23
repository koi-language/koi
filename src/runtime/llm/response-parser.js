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

// A plain scalar that itself holds ": " («motivo: Nombre en mayúsculas: se escribe …») is not valid YAML, and one
// such line threw away a whole 50-item batch (17 kB, ~40 s of generation) and made the model write it all again,
// several times in a row (opfh, 23/11/2026). Quoting a value the model wrote is not guessing an action: the text is
// kept character for character, only wrapped in quotes. Lines inside a block scalar (`|`, `>`) are left alone.
const _KEY_LINE = /^([ \t]*(?:-[ \t]+)?)([A-Za-z_][\w.-]*)[ \t]*:[ \t]+(.*)$/;
export function _quoteColonScalars(text) {
  const lines = text.split('\n');
  let blockIndent = -1; // inside a block scalar while a line is indented deeper than this
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (line.trim() === '' || indent > blockIndent) continue;
      blockIndent = -1;
    }
    const m = _KEY_LINE.exec(line);
    if (!m) continue;
    const value = m[3].replace(/[ \t]+$/, '');
    if (/^[|>][+-]?\d*$/.test(value)) { blockIndent = m[1].replace(/-[ \t]+$/, '').length + (m[1].includes('-') ? 2 : 0); continue; }
    if (!value || /^["'[{&*!#|>]/.test(value)) continue;
    if (!/:[ \t]|:$/.test(value)) continue;
    lines[i] = `${m[1]}${m[2]}: ${JSON.stringify(value)}`;
  }
  return lines.join('\n');
}

function _parseYamlTolerant(text) {
  try {
    return parseYaml(text, { uniqueKeys: false });
  } catch (err) {
    if (!/compact mappings|implicit key|nested mapping|mapping values are not allowed/i.test(err.message)) throw err;
    const quoted = _quoteColonScalars(text);
    if (quoted === text) throw err;
    let repaired;
    try { repaired = parseYaml(quoted, { uniqueKeys: false }); } catch { throw err; }
    if (!_looksLikeAction(repaired)) throw err;
    return repaired;
  }
}

// Text that is a (malformed) YAML *action* attempt, not genuine prose. When a
// response fails to parse, we must NOT dump it into the chat as a print — that
// "vomits the raw YAML". If it carries action structure, throw to force a retry.
const _YAML_ACTION_LINE = /(?:^|\n)[ \t]*-?[ \t]*(?:actionType|intent|batch|parallel)[ \t]*:/;
function _looksLikeYamlAction(t) {
  return typeof t === 'string' && _YAML_ACTION_LINE.test(t);
}

// Prose head + YAML action tail ("He revisado las imágenes…\n\nbatch:\n  - …").
// The WHOLE text isn't valid YAML — the prose's own colons make the parser
// throw ("Nested mappings are not allowed in compact mappings") — which used
// to discard a perfectly good action AND the analysis, forcing a retry. Slice
// at the first action-looking line: if that tail parses to a real action,
// execute it and surface the head as a print (the prose→print rule).
function _recoverProseThenAction(text) {
  if (typeof text !== 'string') return null;
  const m = _YAML_ACTION_LINE.exec(text);
  if (!m) return null;
  const start = m.index + (m[0][0] === '\n' ? 1 : 0);
  if (start === 0) return null; // no prose head — genuinely malformed action
  const head = text.slice(0, start).trim();
  const tail = text.slice(start).trim();
  if (!head || !tail) return null;
  try {
    const parsed = parseYaml(tail, { uniqueKeys: false });
    if (parsed && typeof parsed === 'object' && _looksLikeAction(parsed)) {
      return { prose: head, parsed };
    }
  } catch { /* tail not valid YAML either → let the caller throw/retry */ }
  return null;
}

// A `message` value that itself contains action YAML means a block scalar
// (`message: |`) swallowed the batch's sibling actions — a model indentation
// bug that, left alone, prints the whole batch as one giant message and never
// runs the swallowed actions. Detect it so we can retry instead.
function _messageSwallowedActions(s) {
  if (typeof s !== 'string' || s.length < 24) return false;
  return /\n[ \t]*-?[ \t]*actionType[ \t]*:[ \t]*(?:direct|delegate)\b/.test(s)
      && /\n[ \t]*-?[ \t]*intent[ \t]*:[ \t]*[A-Za-z]/.test(s);
}

// ---------------------------------------------------------------------------
// HEREDOC content blocks.
//
// Problem: file payloads (write_file `content`, edit_file `diff`) are arbitrary
// HTML/CSS/code. Inlined as a YAML value they routinely break the parser —
// `line-height: 1.6;` reads as a nested mapping, `{ margin: 0; }` as a flow
// map ("Nested mappings are not allowed in compact mappings"). Block scalars
// (`|`) "work" but the #1 batch-breaker is mis-indenting their body.
//
// Fix: let the model put that payload OUTSIDE the YAML, between sentinel lines,
// and reference it by id from the field. We pull the blocks out of the raw text
// BEFORE YAML parsing (so their contents never reach the parser), then splice
// each captured body back into any field whose value is the matching reference.
// No escaping, no indentation to maintain — the body is verbatim.
//
//   intent: write_file
//   path: page.html
//   content: KOI_HEREDOC_1
//   ###KOI_HEREDOC_1_START###
//   <!doctype html><style>body{ margin:0; line-height:1.6; }</style>...
//   ###KOI_HEREDOC_1_END###
//
// The reference token (`KOI_HEREDOC_<id>`) is a plain alnum scalar, so it is
// ALWAYS valid YAML regardless of what the body contains.
const _HEREDOC_MARKER = '###KOI_HEREDOC_';
const _HEREDOC_BLOCK_RE =
  /^[ \t]*###KOI_HEREDOC_(\w+)_START###[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*###KOI_HEREDOC_\1_END###[ \t]*$/gm;
const _HEREDOC_REF_RE = /^KOI_HEREDOC_(\w+)$/;

// Strip every heredoc block out of the raw response and return the cleaned text
// plus an id→body map. Cleaned text is what gets YAML-parsed; the bodies are
// spliced back afterwards via _applyHeredocs.
function _extractHeredocs(text) {
  const blocks = new Map();
  if (typeof text !== 'string' || !text.includes(_HEREDOC_MARKER)) {
    return { text, blocks };
  }
  // Reset lastIndex — module-level /g regex is reused across calls.
  _HEREDOC_BLOCK_RE.lastIndex = 0;
  const stripped = text.replace(_HEREDOC_BLOCK_RE, (_m, id, body) => {
    blocks.set(id, body);
    return ''; // remove the block entirely so the remaining text is clean YAML
  });
  return { text: stripped, blocks };
}

// Last-ditch deterministic recovery for the case the model SKIPPED the heredoc
// convention and inlined HTML/CSS/code straight into `content:` / `diff:`,
// breaking the YAML parse. We can recover SAFELY only when the payload is the
// tail of the document — i.e. there is exactly ONE inline content/diff field
// and everything after it runs to EOF. That's how models actually emit file
// writes (the big blob goes last), and taking value-to-EOF removes the
// where-does-the-value-end ambiguity entirely: whatever it looks like, it's
// content. Anything more ambiguous (2+ inline fields, junk before the action)
// → return null so the caller throws a heredoc-guided retry instead of
// guessing and silently corrupting the file. Returns { parsedHead, blocks }.
function _recoverInlineFileContent(text) {
  if (typeof text !== 'string') return null;
  if (!/\bintent[ \t]*:[ \t]*(?:write_file|edit_file)\b/.test(text)) return null;
  const fieldRe = /^([ \t]*)(content|diff)[ \t]*:[ \t]*(.*)$/gm;
  const hits = [];
  let m;
  while ((m = fieldRe.exec(text)) !== null) {
    const v = m[3].trim();
    // Skip block scalars (handled by YAML), empties, and already-heredoc refs.
    if (!v || v.startsWith('|') || v.startsWith('>') || _HEREDOC_REF_RE.test(v)) continue;
    hits.push({ valueStart: m.index + m[0].length - m[3].length });
  }
  if (hits.length !== 1) return null; // 0 → not this case; 2+ → ambiguous, bail
  const value = text.slice(hits[0].valueStart); // value runs verbatim to EOF
  const head = text.slice(0, hits[0].valueStart) + 'KOI_HEREDOC_R';
  let parsedHead;
  try { parsedHead = parseYaml(head, { uniqueKeys: false }); }
  catch { return null; } // head still broken → not a clean tail, don't guess
  if (!parsedHead || typeof parsedHead !== 'object') return null;
  _applyHeredocs(parsedHead, new Map([['R', value]]));
  channel.log('llm',
    '[parser] recovered inlined file content (model skipped the KOI_HEREDOC convention) — ' +
    'lifted the value-to-EOF payload into the action');
  return parsedHead;
}

// Walk a parsed action tree and replace any string value that is exactly a
// `KOI_HEREDOC_<id>` reference with its captured body. Mutates in place.
function _applyHeredocs(node, blocks) {
  if (!blocks || blocks.size === 0 || node == null) return node;
  if (typeof node === 'string') {
    const m = _HEREDOC_REF_RE.exec(node.trim());
    return m && blocks.has(m[1]) ? blocks.get(m[1]) : node;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = _applyHeredocs(node[i], blocks);
    return node;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) node[k] = _applyHeredocs(node[k], blocks);
    return node;
  }
  return node;
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
  // Pull heredoc content blocks (write_file `content`, edit_file `diff`, etc.)
  // OUT of the text before anything else touches it — their arbitrary HTML/CSS/
  // code must never reach the YAML parser. The reference tokens left behind are
  // plain scalars, so the remaining document always parses. Bodies are spliced
  // back into the matching fields once we have a valid action tree.
  const { text: _deheredoced, blocks: _heredocs } = _extractHeredocs(responseText);
  responseText = _deheredoced;

  // Clean markdown code blocks
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:ya?ml|json)?\n?/i, '').replace(/\n?```$/, '').trim();
  }
  const _rawCleaned = cleaned; // pre-strip copy, used for the prose fallback
  let _proseHead = ''; // prose recovered ahead of a YAML action tail → printed first

  // The brace/bracket preamble+trailing stripping below is for JSON-mode
  // responses (prose then `{...}`). It MUST NOT run when the response is
  // already a YAML action — a `{` then belongs to file content (CSS
  // `{ margin: 0 }`, a JS snippet) and chopping to it shreds the action and
  // turns the CSS into a bogus flow-map. Detect a YAML-action head and skip.
  const _yamlActionHead = /^[ \t]*(?:-[ \t]+)?(?:batch|parallel|actions|actionType|intent|type)[ \t]*:/.test(cleaned);

  // Strip preamble: some models (e.g. Anthropic) write reasoning text before the JSON.
  // Find the first { or [ that starts valid JSON and discard everything before it.
  // Capture preamble text — if the action is prompt_user, inject it as "message".
  // Prefer { over [ — arrays at the top level are rare and often false positives
  // (e.g. the LLM writes "[0, range)" as math notation, not a JSON array).
  let preambleText = '';
  const braceIdx = _yamlActionHead ? -1 : cleaned.indexOf('{');
  let bracketIdx = _yamlActionHead ? -1 : cleaned.indexOf('[');
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

  // Tolerate a frequent flash-model slip: the `batch` keyword emitted WITHOUT
  // its colon at the head of a multi-action list ("batch\n  - actionType:…").
  // A bare `batch` line is an invalid YAML implicit key and breaks the WHOLE
  // batch. Scoped STRICTLY to the literal `batch` keyword directly followed by a
  // YAML sequence item — restore the colon. `batch:` (already correct) and any
  // other word are left untouched.
  cleaned = cleaned.replace(/^([ \t]*)batch[ \t]*(\r?\n[ \t]*-[ \t])/m, '$1batch:$2');

  let parsed;
  try {
    // PRIMARY: parse as YAML. YAML is a strict superset of JSON, so this
    // accepts BOTH the YAML the agent now emits AND any legacy/stray JSON,
    // which is our safety net during the migration. The `yaml` package uses
    // the 1.2 core schema, so `yes/no/on/off` stay strings (no "Norway
    // problem") and only true/false/null are booleans.
    parsed = _parseYamlTolerant(cleaned);
    if (parsed === undefined) throw new Error('empty YAML document');
    // A bare scalar (string/number/bool) means the model answered in PROSE,
    // not an action map/sequence. We used to surface it verbatim as a print;
    // removed — fail instead so the agent re-emits a real action. (If the
    // model wants to show text to the user it must emit `intent: print` with
    // the text under `message`.)
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error(
        'Your response was a bare value, not an action. Emit a YAML action ' +
        'with an "intent"/"actionType". To show text to the user, emit:\n' +
        'actionType: direct\nintent: print\nmessage: "..."\n' +
        `Got: ${String(parsed ?? '').trim().substring(0, 120)}`
      );
    }
    // YAML parsed to an object but NONE of the keys look like a real action.
    // We used to print the raw text to the user when it didn't carry the
    // literal action keywords — that's the bug: a stray `return:` / `summary:`
    // / `taskCount:` block parses fine, isn't an action, and got dumped raw
    // into the chat. We now FAIL in every non-action case so the agent retries
    // with a valid action (the `_looksLikeYamlAction` branch still attempts a
    // mechanical prose+action recovery first).
    if (!_looksLikeAction(parsed)) {
      if (_looksLikeYamlAction(_rawCleaned)) {
        const _rec = _recoverProseThenAction(_rawCleaned);
        if (_rec) {
          parsed = _rec.parsed;
          _proseHead = _rec.prose;
        } else {
          throw new Error(
            `Your YAML parsed but isn't a valid action (likely a block-scalar/indentation slip). ` +
            `Re-emit a clean action — every action key (actionType/intent) at the same indent, and ` +
            `multi-line values under "message: |" / "prompt: |" indented DEEPER than the key.`
          );
        }
      } else {
        throw new Error(
          'Your YAML parsed but is not a valid action (no "intent"/"actionType"). ' +
          'Do NOT wrap output in keys like "return:" / "summary:" / "taskCount:". ' +
          'To show text to the user, emit:\n' +
          'actionType: direct\nintent: print\nmessage: "..."\n' +
          `Got: ${_rawCleaned.trim().substring(0, 120)}`
        );
      }
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
      // NOTE: we used to treat unparseable plain prose (no JSON/YAML structure)
      // as a `print` and surface it to the user verbatim. Removed deliberately:
      // when the model emits a structured-but-broken response, that band-aid
      // dumped raw YAML straight into the chat. We now FAIL instead — the model
      // must always emit a real action (use `intent: print` to show text to the
      // user). Genuine "prose head + action tail" responses are still recovered
      // mechanically just below (that slices out an action the model actually
      // emitted, not a guess); if no action can be recovered, we throw at the
      // end of this block so the agent retries.

      // Prose head + action tail (the response DOES carry action lines, the
      // prose ahead of them is what broke the YAML parse). Recover the action,
      // surface the prose as a print — this is mechanical slicing of what the
      // model literally emitted, NOT a second model guessing intent.
      const _rec = _recoverProseThenAction(_rawCleaned);
      if (_rec) {
        parsed = _rec.parsed;
        _proseHead = _rec.prose;
      } else if ((parsed = _recoverInlineFileContent(_rawCleaned))) {
        // Deterministically lifted inlined file content (model skipped the
        // heredoc) into the action — `parsed` is now valid; fall through.
      } else {
        // No recovery via a secondary LLM: we must NEVER invent actions the
        // agent did not explicitly emit. A second model "fixing" a malformed
        // response is guessing intent on behalf of the real agent — the same
        // anti-pattern the user has banned. Surface the parse failure instead
        // so the real agent retries with a valid JSON action.
        //
        // When the break is almost certainly inlined file content (a
        // write_file/edit_file action whose HTML/CSS/code value tripped the
        // mapping parser) AND the safe value-to-EOF recovery above could not
        // apply (e.g. 2+ inline fields, payload not at the tail), steer the
        // retry straight to the HEREDOC instead of the generic hint.
        const _looksLikeInlineFileContent =
          /\bintent[ \t]*:[ \t]*(?:write_file|edit_file)\b/.test(_rawCleaned)
          && /compact mappings|implicit key|nested mapping|mapping values are not allowed|flow collection|block collection/i.test(firstErr.message);
        if (_looksLikeInlineFileContent) {
          throw new Error(
            `Your file content broke the YAML parser (${firstErr.message}). ` +
            `Do NOT inline HTML/CSS/code into "content"/"diff" and do NOT use a "|" block for it. ` +
            `Re-emit using a HEREDOC: set the field to "KOI_HEREDOC_1", then put the verbatim payload ` +
            `between marker lines AFTER the YAML, e.g.:\n` +
            `actionType: direct\nintent: write_file\npath: page.html\ncontent: KOI_HEREDOC_1\n` +
            `###KOI_HEREDOC_1_START###\n<your file content, any characters, taken literally>\n###KOI_HEREDOC_1_END###`
          );
        }
        throw new Error(
          `Your response was not valid YAML (or JSON) and could not be parsed. ${firstErr.message}. ` +
          `Response received: ${cleaned.substring(0, 300)}. ` +
          `Retry with a valid YAML action, e.g.:\nactionType: direct\nintent: print\nmessage: "..."`
        );
      }
    }
  }

  // Surface the prose head recovered by _recoverProseThenAction as a print
  // that runs BEFORE the action(s) — the narration is part of the answer
  // (prose→print rule); only the action tail is executable YAML.
  if (_proseHead) {
    const _printHead = { actionType: 'direct', intent: 'print', message: _proseHead };
    if (Array.isArray(parsed)) parsed.unshift(_printHead);
    else if (parsed.batch && Array.isArray(parsed.batch)) parsed.batch.unshift(_printHead);
    else if (parsed.actions && Array.isArray(parsed.actions)) parsed.actions.unshift(_printHead);
    else if (parsed.parallel && Array.isArray(parsed.parallel)) parsed = { batch: [_printHead, { parallel: parsed.parallel }] };
    else parsed = { batch: [_printHead, parsed] };
  }

  // Splice captured heredoc bodies back into the parsed action tree, replacing
  // every `KOI_HEREDOC_<id>` reference with its verbatim content. Runs before
  // batch/array dispatch so each action carries its real payload downstream.
  _applyHeredocs(parsed, _heredocs);

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
  // Guard: a `message`/`text` that itself contains action YAML means a block
  // scalar swallowed the batch's sibling actions (model indentation bug).
  // Throw so the agent retries instead of printing the whole batch as one
  // giant message (and never running the swallowed actions).
  if (parsed && typeof parsed === 'object'
      && (_messageSwallowedActions(parsed.message) || _messageSwallowedActions(parsed.text))) {
    throw new Error(
      `A multi-line value swallowed sibling actions — your "message: |" block was indented so the ` +
      `next action fell inside it. Re-emit the batch with each "- actionType:" at the SAME indent and ` +
      `every block-scalar line indented DEEPER than its key.`
    );
  }
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
