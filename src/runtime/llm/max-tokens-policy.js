/**
 * Single source of truth for `max_output_tokens` in reactive LLM calls.
 *
 * Rationale: max_output_tokens is a shared budget (reasoning + visible content
 * on reasoning models), and having it set in 5+ places with ad-hoc numbers
 * caused dead-code bugs and silent "0 content" failures. This module owns it.
 *
 * Two layers:
 *   1. Base table keyed by TASK KIND (route/extract/answer/code/final). Derived
 *      from the classifier's profile scores — the agent doesn't need to know.
 *   2. Optional per-phase override via `maxOutputTokens` in the agent's `.koi`
 *      phase declaration, e.g.
 *          phases { writing { code: high, maxOutputTokens: 8000 } }
 *
 * Thinking models get the budget doubled because `max_output_tokens` on them
 * covers reasoning + visible content: half goes to thinking, half to output.
 */

/** Non-thinking base caps by task kind. */
export const MAX_OUTPUT_TOKENS_BASE = {
  route:   1000,  // routing / classification — needs headroom because some
                  // models burn tokens on internal reasoning even with
                  // effort=none, leaving nothing for the actual response.
  extract: 1200,  // structured extraction from a short input
  answer:  2000,  // conversational answer / explanation
  code:    6000,  // write_file / edit_file with non-trivial content
  final:   2000,  // final summary / closing response
};

/**
 * Derive a task kind from the classifier's profile scores.
 * Scores are 0–100. See task-classifier.js.
 */
export function classifyTaskKind(profile) {
  if (!profile) return 'answer';
  const code = profile.code ?? 0;
  const reasoning = profile.reasoning ?? 0;
  const difficulty = profile.difficulty ?? Math.max(code, reasoning);

  // Trivial routing: both axes low.
  if (difficulty < 25) return 'route';

  // Structured extraction: low difficulty, non-zero reasoning, low code.
  if (difficulty < 40 && code < 30) return 'extract';

  // Code-heavy tasks dominate the budget because tool arguments
  // (write_file content, edit_file diffs) count as output tokens.
  if (code >= 60) return 'code';

  // High-reasoning final response (planning, analysis).
  if (reasoning >= 70) return 'final';

  // Default conversational answer.
  return 'answer';
}

/**
 * Resolve the effective max_output_tokens for a reactive LLM call.
 *
 * @param {Object}   args
 * @param {Object}   args.profile        - Classifier output (code, reasoning, difficulty).
 * @param {boolean}  args.useThinking    - Whether the selected model is a thinking model.
 * @param {number}   [args.phaseOverride] - Optional per-phase override from the .koi file.
 * @param {Object}   [args.caps]         - Model caps (`caps.maxOutputTokens`) to clamp to.
 * @returns {{ value: number, kind: string, source: string }}
 */
export function resolveMaxOutputTokens({ profile, useThinking, phaseOverride, caps }) {
  const kind = classifyTaskKind(profile);
  let value;
  let source;

  if (typeof phaseOverride === 'number' && phaseOverride > 0) {
    value = phaseOverride;
    source = `phase override`;
  } else {
    value = MAX_OUTPUT_TOKENS_BASE[kind] ?? MAX_OUTPUT_TOKENS_BASE.answer;
    source = `policy(${kind})`;
  }

  // Reasoning models share the budget between reasoning and visible content.
  // Double so the visible portion matches the non-thinking baseline.
  // This applies both when thinking is explicitly enabled AND when the model
  // always reasons internally (codex, o1, etc.) — indicated by caps.thinking.
  const alwaysReasons = caps?.thinking === true;
  if (useThinking || alwaysReasons) {
    value = value * 2;
    source += alwaysReasons ? ' +reasoning-model' : ' +thinking';
  }

  // Clamp to what the model actually supports.
  const modelMax = caps?.maxOutputTokens;
  if (typeof modelMax === 'number' && modelMax > 0 && value > modelMax) {
    value = modelMax;
    source += ` clamp(${modelMax})`;
  }

  return { value, kind, source };
}
