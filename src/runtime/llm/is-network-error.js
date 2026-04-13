/**
 * isNetworkError — true when the given error is a transient network/gateway
 * failure (connection refused, DNS, socket reset, timeout) and NOT a model-
 * or provider-capability issue. Callers use this to decide whether to
 * escalate the model profile, mark the provider on cooldown, or just retry.
 *
 * Detection order, cheapest first:
 *   1. OpenAI SDK class: APIConnectionError / APIConnectionTimeoutError.
 *      Every provider we talk to goes through the OpenAI SDK (openai,
 *      gemini via openai-compat, and the koi-gateway), so this catches the
 *      vast majority of cases.
 *   2. Known undici / Node fetch error codes on err.code / err.cause.code:
 *      ECONNREFUSED, ECONNRESET, ENOTFOUND, EAI_AGAIN, EPIPE, UND_ERR_*.
 *   3. `fetch failed` TypeError from bare `fetch()` calls — the underlying
 *      cause is usually on `err.cause`.
 *   4. Last-resort substring match on the message for the few cases where
 *      the error has been stringified and the class/code is gone.
 */

const NET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export function isNetworkError(err) {
  if (!err) return false;

  const name = err?.constructor?.name || err?.name || '';
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') {
    return true;
  }

  if (err.code && NET_CODES.has(err.code)) return true;
  if (err.cause?.code && NET_CODES.has(err.cause.code)) return true;
  // Flattened form stored by playbook-session.recordAction() — the original
  // Error is gone, only { message, name, code, causeCode } remain.
  if (err.causeCode && NET_CODES.has(err.causeCode)) return true;

  // `fetch failed` TypeError from Node's global fetch — always transport-level.
  if (err instanceof TypeError && /fetch failed/i.test(err.message || '')) {
    return true;
  }

  // Inactivity timeout we throw ourselves in llm-provider.js.
  if (/stream inactivity timeout/i.test(err.message || '')) return true;

  // Fallback string match for already-flattened errors (e.g. when the
  // message has been shuttled through session.recordAction).
  const msg = err.message || '';
  if (/^connection error$/i.test(msg)) return true;
  if (/^request timed out\.?$/i.test(msg)) return true;
  if (/^request was aborted\.?$/i.test(msg)) return true;

  return false;
}
