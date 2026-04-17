/**
 * Shared constants for the LLM subsystem.
 */

// ── Reasoning effort levels ─────────────────────────────────────────────────
export const EFFORT_NONE   = 'none';
export const EFFORT_LOW    = 'low';
export const EFFORT_MEDIUM = 'medium';
export const EFFORT_HIGH   = 'high';

/** Ordered rank for effort comparison (higher = more effort). */
export const EFFORT_RANK = {
  [EFFORT_NONE]:   0,
  [EFFORT_LOW]:    1,
  [EFFORT_MEDIUM]: 2,
  [EFFORT_HIGH]:   3,
};

/** Stream inactivity timeouts (ms) per effort level for thinking-capable models. */
export const THINKING_INACTIVITY_MS = {
  [EFFORT_NONE]:   120_000,
  [EFFORT_LOW]:    120_000,
  [EFFORT_MEDIUM]: 300_000,
  [EFFORT_HIGH]:   600_000,
};

/** Stream inactivity timeout (ms) for non-thinking models. */
export const DEFAULT_INACTIVITY_MS = 90_000;
