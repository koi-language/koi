/**
 * Auto Model Selector — pick the cheapest capable model for a task.
 *
 * Task profile (type + difficulty) is determined by a fast LLM call in LLMProvider._inferTaskProfile().
 * This module only handles provider discovery and model selection logic.
 */

import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const modelsData = _require('./models.json');

/** Default profile used as fallback when LLM classification is unavailable. */
export const DEFAULT_TASK_PROFILE = { taskType: 'code', difficulty: 5 };

// ── Circuit breaker: per-provider timeout cooldown ────────────────────────
// After N consecutive timeouts, a provider is skipped for an escalating period.
// Cooldown steps (ms): 1.5m → 5m → 15m
const COOLDOWN_STEPS_MS = [90_000, 300_000, 900_000];
const _providerCooldowns = new Map(); // provider → { failures, until }

/** Mark a provider as having timed out. Applies progressive cooldown. */
export function markProviderTimeout(provider) {
  const entry = _providerCooldowns.get(provider) || { failures: 0, until: 0 };
  entry.failures++;
  const step = Math.min(entry.failures - 1, COOLDOWN_STEPS_MS.length - 1);
  entry.until = Date.now() + COOLDOWN_STEPS_MS[step];
  _providerCooldowns.set(provider, entry);
  const secs = COOLDOWN_STEPS_MS[step] / 1000;
  // Use console.error to avoid import cycle with cliLogger
  console.error(`[circuit-breaker] ${provider} on cooldown for ${secs}s (timeout #${entry.failures})`);
}

/** Reset cooldown for a provider after a successful call. */
export function clearProviderCooldown(provider) {
  _providerCooldowns.delete(provider);
}

function _isOnCooldown(provider) {
  const entry = _providerCooldowns.get(provider);
  if (!entry || !entry.until) return false;
  return Date.now() < entry.until;
}

/**
 * Returns true if a string looks like an API key rather than a garbage value
 * (e.g. "/exit", "undefined", empty string, shell command, etc.)
 */
function _looksLikeApiKey(val) {
  if (!val || typeof val !== 'string') return false;
  const v = val.trim();
  // Must be at least 8 chars, no leading slash (shell command), no whitespace, not literal "undefined"/"null"
  return v.length >= 8 && !v.startsWith('/') && !/\s/.test(v) && v !== 'undefined' && v !== 'null';
}

export function getAvailableProviders() {
  const providers = [];
  if (_looksLikeApiKey(process.env.OPENAI_API_KEY))    providers.push('openai');
  if (_looksLikeApiKey(process.env.ANTHROPIC_API_KEY)) providers.push('anthropic');
  if (_looksLikeApiKey(process.env.GEMINI_API_KEY))    providers.push('gemini');
  return providers;
}

// Score boost when a thinking model is selected in thinking mode.
// Thinking trades speed for quality: better reasoning/planning/code, slower.
const THINKING_DELTA = { code: 1, planning: 2, reasoning: 2, speed: -2 };

function _buildCandidates(providers, taskType, difficulty, requiresImage, skipCooldown, minContextK = 0) {
  const candidates = [];
  for (const provider of providers) {
    if (!skipCooldown && _isOnCooldown(provider)) continue;
    const providerModels = modelsData[provider];
    if (!providerModels) continue;

    for (const [modelName, caps] of Object.entries(providerModels)) {
      if (caps.outputType !== 'text') continue;
      if (requiresImage && !caps.inputImage) continue;
      // Skip models whose context window is too small for the input
      if (minContextK > 0 && caps.contextK > 0 && caps.contextK < minContextK) continue;
      const totalCost = (caps.inputPer1M || 0) + (caps.outputPer1M || 0);

      // Non-thinking variant (always added if score qualifies)
      const taskScore = caps[taskType] ?? 0;
      if (taskScore >= difficulty) {
        candidates.push({ provider, model: modelName, totalCost, speed: caps.speed || 5, useThinking: false });
      }

      // Thinking variant: boosted scores, lower speed, higher effective cost.
      // Thinking uses extra tokens for reasoning: the harder the problem, the more
      // thinking tokens are consumed. Scale cost by difficulty so the selector
      // naturally prefers non-thinking models for easy tasks and only picks
      // thinking when the base model can't meet the difficulty threshold.
      //   difficulty ≤7 → ×1.5 | 8 → ×2 | 9 → ×3 | ≥10 → ×4
      if (caps.thinking) {
        const thinkingScore = taskScore + (THINKING_DELTA[taskType] ?? 0);
        if (thinkingScore >= difficulty) {
          const thinkingSpeed = (caps.speed || 5) + THINKING_DELTA.speed;
          const costMultiplier = difficulty <= 7 ? 1.5 : difficulty === 8 ? 2 : difficulty === 9 ? 3 : 4;
          candidates.push({ provider, model: modelName, totalCost: totalCost * costMultiplier, speed: thinkingSpeed, useThinking: true });
        }
      }
    }
  }
  return candidates;
}

/**
 * Select the cheapest text-output model whose score for taskType >= difficulty.
 * For models with thinking capability, two virtual candidates are considered:
 * one without thinking (original scores) and one with thinking (code+1, planning+2,
 * reasoning+2, speed-2). The winner may activate thinking mode.
 *
 * @param {'code'|'planning'|'reasoning'} taskType
 * @param {number} difficulty - 1 (trivial) to 10 (expert)
 * @param {string[]} availableProviders - providers with API keys
 * @returns {{ provider: string, model: string, useThinking: boolean } | null}
 */
export function selectAutoModel(taskType, difficulty, availableProviders, { requiresImage = false, minContextK = 0 } = {}) {
  // Code tasks require a minimum difficulty of 6 to ensure capable models are selected.
  // Cheap/fast models can't reliably generate structured output like unified diffs.
  if (taskType === 'code') difficulty = Math.max(difficulty, 6);

  let candidates = _buildCandidates(availableProviders, taskType, difficulty, requiresImage, false, minContextK);

  // If all providers are on cooldown, ignore cooldowns and pick the best available
  // so we never block LLM calls entirely.
  if (candidates.length === 0) {
    candidates = _buildCandidates(availableProviders, taskType, difficulty, requiresImage, true, minContextK);
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const costDiff = a.totalCost - b.totalCost;
    if (Math.abs(costDiff) > 0.0001) return costDiff;
    return b.speed - a.speed;
  });

  const winner = candidates[0];
  return { provider: winner.provider, model: winner.model, useThinking: winner.useThinking };
}
