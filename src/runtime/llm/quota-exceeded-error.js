/**
 * QuotaExceededError — thrown whenever the braxil.ai gateway responds with
 * HTTP 402 Payment Required (no credits).
 *
 * The backend returns a structured body:
 *
 *   {
 *     error: {
 *       code: 'QUOTA_EXCEEDED',
 *       message: string,
 *       hasPlan: boolean,
 *       isTopPlan: boolean,
 *       options: [{ key, label, action, url?, text? }, ...]
 *     }
 *   }
 *
 * We parse that body at the fetch boundary and throw this error so every
 * caller upstream can recognise the quota case in one `instanceof` check,
 * stop whatever it was doing, and surface the upgrade dialog.
 */

export class QuotaExceededError extends Error {
  constructor({ message, options = [], hasPlan = false, isTopPlan = false } = {}) {
    super(message || 'Quota exceeded — no credits available');
    this.name = 'QuotaExceededError';
    this.status = 402;
    this.code = 'QUOTA_EXCEEDED';
    this.options = Array.isArray(options) ? options : [];
    this.hasPlan = !!hasPlan;
    this.isTopPlan = !!isTopPlan;
  }
}

/**
 * Parse a Response whose status is 402 into a QuotaExceededError.
 *
 * Caller is responsible for the 402 check — this function unconditionally
 * reads the body and returns the error instance. If the body isn't the
 * expected JSON shape we still return an error so the caller can throw it;
 * the options list will just be empty and the default dialog will kick in.
 */
export async function parseQuotaExceededResponse(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    try {
      const text = await res.text();
      try { body = JSON.parse(text); } catch { body = { error: { message: text } }; }
    } catch { body = null; }
  }
  const err = body?.error || {};
  return new QuotaExceededError({
    message: err.message,
    options: err.options,
    hasPlan: err.hasPlan,
    isTopPlan: err.isTopPlan,
  });
}

/** True if the given error is (or wraps) a QuotaExceededError / HTTP 402. */
export function isQuotaExceededError(err) {
  if (!err) return false;
  if (err instanceof QuotaExceededError) return true;
  if (err?.name === 'QuotaExceededError') return true;
  if (err?.status === 402 || err?.statusCode === 402) return true;
  // OpenAI SDK APIError carries the parsed body on .error
  const code = err?.error?.error?.code || err?.error?.code;
  if (code === 'QUOTA_EXCEEDED') return true;
  return false;
}

/**
 * One-shot background surfacing: if `err` is a 402, show the quota dialog
 * exactly once across the process. Background sites (memory summarization,
 * embeddings during startup) call this so the user sees "no credits" instead
 * of a frozen UI while the main reactive loop hasn't picked up the error yet.
 *
 * Returns true iff a 402 was detected (regardless of whether the dialog was
 * shown this call — the caller uses it to decide whether to rethrow / abort
 * further work).
 */
let _quotaSurfaced = false;
export async function surfaceQuotaIfDetected(err) {
  if (!isQuotaExceededError(err)) return false;
  if (_quotaSurfaced) return true;
  _quotaSurfaced = true;
  try {
    const quotaErr = toQuotaExceededError(err) || err;
    const { showQuotaExceededDialog } = await import('./quota-dialog.js');
    // Fire-and-forget — callers are in background task contexts and must not
    // block on the dialog resolving.
    showQuotaExceededDialog(quotaErr).catch(() => {});
  } catch { /* best-effort */ }
  return true;
}

/**
 * Best-effort conversion of any error (typed, APIError, generic) into a
 * QuotaExceededError. Returns null if the input is not quota-related.
 */
export function toQuotaExceededError(err) {
  if (!err) return null;
  if (err instanceof QuotaExceededError) return err;
  if (!isQuotaExceededError(err)) return null;
  // OpenAI SDK: the parsed JSON body is on err.error (or err.error.error)
  const payload = err?.error?.error || err?.error || {};
  return new QuotaExceededError({
    message: payload.message || err.message,
    options: payload.options,
    hasPlan: payload.hasPlan,
    isTopPlan: payload.isTopPlan,
  });
}
