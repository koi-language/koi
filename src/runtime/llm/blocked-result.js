/**
 * BlockedResult — structured return value for actions whose downstream
 * provider refused the request based on its own policy (content filter,
 * safety refusal, explicit policy error code, etc.).
 *
 * The Coordinator agent uses this shape to distinguish three very
 * different failure modes that look identical with a plain `{success:
 * false, error: "..."}`:
 *
 *   1. The request is genuinely invalid (bad prompt, missing arg) —
 *      retrying with a different provider won't help.
 *   2. The provider is transiently broken (timeout, 5xx, quota) —
 *      retry later, same provider is fine.
 *   3. The provider *refused* on content policy — the task can often be
 *      satisfied by routing to a different provider whose policy allows
 *      the request. Telling them apart is the whole point of this shape.
 *
 * Each downstream tool is responsible for mapping provider-specific
 * error signals (finish_reason, stop_reason, HTTP 4xx with a known
 * error code, SDK exception class) into one of the standard blockTypes
 * below. When a new provider or error condition shows up, extend the
 * blockType union rather than inventing an ad-hoc string — the
 * Coordinator prompt matches on these literal values.
 *
 * @typedef {'provider_policy' | 'rate_limit' | 'quota' | 'auth' | 'bad_request'} BlockType
 *
 * @typedef {Object} BlockedResult
 * @property {false} success  — Always false. A blocked result IS a failure.
 * @property {true}  blocked  — Discriminator. Coordinator checks this first.
 * @property {BlockType} blockType
 * @property {string} provider  — Provider family that refused. Examples:
 *   'openai', 'anthropic', 'gemini', 'replicate', 'banana', 'kling',
 *   'seedance'. Use the family name, NOT the exact model id — the
 *   Coordinator uses this to pick a *different* family on retry.
 * @property {string} reason    — Literal message from the provider (or
 *   a short human-readable summary). Surfaced to the user if no retry
 *   resolves the block. Keep it concise; no full stack traces.
 * @property {boolean} retryable  — Hint to the Coordinator. true when a
 *   different provider MIGHT succeed (policy refusal, rate limit,
 *   quota). false when the problem is inherent to the request itself
 *   (bad_request, auth). Defaults to true for policy/rate/quota, false
 *   for auth/bad_request.
 */

const DEFAULT_RETRYABLE = {
  provider_policy: true,
  rate_limit: true,
  quota: true,
  auth: false,
  bad_request: false,
};

/**
 * Build a BlockedResult. All fields are validated — pass nonsense and
 * you get a runtime error, not a silently malformed result that the
 * Coordinator then can't parse.
 *
 * @param {Object} opts
 * @param {BlockType} opts.blockType
 * @param {string} opts.provider
 * @param {string} opts.reason
 * @param {boolean} [opts.retryable]  — Overrides the default for this blockType.
 * @returns {BlockedResult}
 */
export function blockedResult({ blockType, provider, reason, retryable }) {
  if (!blockType || !(blockType in DEFAULT_RETRYABLE)) {
    throw new Error(
      `blockedResult: unknown blockType "${blockType}". ` +
      `Must be one of: ${Object.keys(DEFAULT_RETRYABLE).join(', ')}`
    );
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error('blockedResult: provider is required');
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error('blockedResult: reason is required');
  }
  return {
    success: false,
    blocked: true,
    blockType,
    provider,
    reason,
    retryable: typeof retryable === 'boolean' ? retryable : DEFAULT_RETRYABLE[blockType],
  };
}

/**
 * Type guard for the Coordinator's runtime logic and for tests.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBlockedResult(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.blocked === true &&
    typeof value.blockType === 'string' &&
    value.blockType in DEFAULT_RETRYABLE
  );
}

/**
 * Valid blockType values, exported so providers / actions don't
 * stringly-type their callers.
 */
export const BlockType = Object.freeze({
  ProviderPolicy: 'provider_policy',
  RateLimit: 'rate_limit',
  Quota: 'quota',
  Auth: 'auth',
  BadRequest: 'bad_request',
});
