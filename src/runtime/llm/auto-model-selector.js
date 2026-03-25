/**
 * Auto Model Selector — pick the cheapest capable model for a task.
 *
 * Task profile (type + difficulty) is determined by a fast LLM call in LLMProvider._inferTaskProfile().
 * This module only handles provider discovery and model selection logic.
 *
 * Models are loaded from the backend API (GET /gateway/models) at startup in gateway mode,
 * falling back to the local models.json if the API is unreachable.
 */

import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

/**
 * models.json is ONLY used as a fallback when running with direct API keys
 * and no backend is available. In gateway mode, models always come from the backend.
 */
let _localModelsData = null;
function _getLocalFallback() {
  if (!_localModelsData) {
    try { _localModelsData = _require('./models.json'); } catch { _localModelsData = {}; }
  }
  return _localModelsData;
}

/** Active models data — starts with local fallback, replaced by backend data when available. */
let modelsData = process.env.KOI_AUTH_TOKEN ? {} : _getLocalFallback();

/** ETag from last successful fetch — used for conditional requests. */
let _remoteEtag = '';
/** Whether initial load has completed. */
let _remoteLoaded = false;
/** Timestamp of last attempt — rate limits retries on failure. */
let _remoteLastAttempt = 0;
const _REMOTE_RETRY_MS = 30_000; // retry every 30s on failure
const _REMOTE_POLL_MS = 60_000;  // poll for changes every 60s
let _pollTimer = null;

/**
 * Fetch active models from the backend API.
 * Uses ETag/If-None-Match to avoid downloading unchanged data.
 * Starts a background poll timer on first successful load.
 */
export async function loadRemoteModels() {
  const now = Date.now();
  const isEmpty = Object.keys(modelsData).length === 0;
  // Always retry if modelsData is empty (critical — no models = can't work)
  if (!isEmpty) {
    // Rate limit: don't hammer on repeated failures
    if (!_remoteLoaded && _remoteLastAttempt && now - _remoteLastAttempt < _REMOTE_RETRY_MS) return;
    // Skip if polled recently and already loaded
    if (_remoteLoaded && _remoteLastAttempt && now - _remoteLastAttempt < _REMOTE_POLL_MS) return;
  }
  _remoteLastAttempt = now;

  const base = (process.env.KOI_API_URL || 'http://localhost:3000');
  // Gateway mode (KOI_AUTH_TOKEN): use /gateway/models (active models for this user)
  // API keys mode: use /gateway/models.json (all models with complete scores)
  const endpoint = process.env.KOI_AUTH_TOKEN ? '/gateway/models' : '/gateway/models.json';
  try {
    const headers = { 'Accept': 'application/json' };
    if (_remoteEtag) headers['If-None-Match'] = _remoteEtag;

    const res = await fetch(`${base}${endpoint}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    // 304 Not Modified — models haven't changed, nothing to do
    if (res.status === 304) return;

    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        modelsData = data;
        _remoteLoaded = true;
        _remoteEtag = res.headers.get('etag') || '';
        if (process.env.KOI_LOG_FILE) {
          const count = Object.values(data).reduce((n, p) => n + Object.keys(p).length, 0);
          try { require('fs').appendFileSync(process.env.KOI_LOG_FILE, `[auto-model] Loaded ${count} models from backend\n`); } catch {}
        }
      }
    }
  } catch {
    // Backend unreachable — fall back to local models.json ONLY when using API keys directly
    if (!_remoteLoaded && !process.env.KOI_AUTH_TOKEN) {
      const fallback = _getLocalFallback();
      if (Object.keys(fallback).length > 0) {
        modelsData = fallback;
        if (process.env.KOI_LOG_FILE) {
          try { require('fs').appendFileSync(process.env.KOI_LOG_FILE, `[auto-model] Backend unreachable, using local models.json fallback (API keys mode)\n`); } catch {}
        }
      }
    }
  }

  // Start background polling after first successful load
  if (_remoteLoaded && !_pollTimer) {
    _pollTimer = setInterval(() => loadRemoteModels(), _REMOTE_POLL_MS);
    if (_pollTimer.unref) _pollTimer.unref(); // don't prevent Node exit
  }
}

/** Default profile used as fallback when LLM classification is unavailable. */
export const DEFAULT_TASK_PROFILE = { taskType: 'code', difficulty: 50, code: 50, reasoning: 30 };

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
  // Log to file only — not visible to the user
  if (process.env.KOI_LOG_FILE) {
    try { require('fs').appendFileSync(process.env.KOI_LOG_FILE, `[circuit-breaker] ${provider} on cooldown for ${secs}s (timeout #${entry.failures})\n`); } catch {}
  }
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
  // Gateway mode: return all providers from the backend model list
  if (process.env.KOI_AUTH_TOKEN) {
    return Object.keys(modelsData);
  }

  // API keys mode: only providers the user has keys for
  // Filter modelsData to only include providers with valid API keys
  const providers = [];
  if (_looksLikeApiKey(process.env.OPENAI_API_KEY))    providers.push('openai');
  if (_looksLikeApiKey(process.env.ANTHROPIC_API_KEY)) providers.push('anthropic');
  if (_looksLikeApiKey(process.env.GEMINI_API_KEY))    providers.push('gemini');
  return providers;
}

// Score boost when a thinking model is selected in thinking mode.
// No score boost for thinking — scores already reflect base capability without thinking.
// Thinking only affects cost (more tokens consumed) and speed (slower).
const THINKING_DELTA = { code: 0, reasoning: 0, speed: -20 };

function _buildCandidates(providers, taskType, difficulty, requiresImage, skipCooldown, minContextK = 0, profile = null) {
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

      // Check if model meets BOTH code and reasoning requirements from the profile
      const codeScore = caps.code ?? 0;
      const reasoningScore = caps.reasoning ?? 0;
      const taskScore = caps[taskType] ?? 0;
      const reqCode = profile?.code ?? 0;
      const reqReasoning = profile?.reasoning ?? 0;
      const meetsBoth = codeScore >= reqCode && reasoningScore >= reqReasoning;
      // Fallback: if no profile with both scores, use single-dimension check
      const meetsMinimum = (reqCode > 0 || reqReasoning > 0) ? meetsBoth : (taskScore >= difficulty);

      // Non-thinking variant
      if (meetsMinimum) {
        candidates.push({ provider, model: modelName, totalCost, speed: caps.speed || 30, score: taskScore, useThinking: false });
      }

      // Thinking variant: same score, slower, different cost.
      // Cost strategy: thinking is cheaper for hard tasks, expensive for easy:
      //   difficulty < 60  → don't offer thinking
      //   difficulty 60-70 → ×3 cost
      //   difficulty 70-80 → ×1.5 cost
      //   difficulty > 80  → ×1 cost (same price)
      if (caps.thinking && meetsMinimum && difficulty >= 60) {
        const thinkingSpeed = Math.max(1, (caps.speed || 30) + THINKING_DELTA.speed);
        const costMultiplier = difficulty <= 70 ? 3 : difficulty <= 80 ? 1.5 : 1;
        candidates.push({ provider, model: modelName, totalCost: totalCost * costMultiplier, speed: thinkingSpeed, score: taskScore, useThinking: true });
      }
    }
  }
  return candidates;
}

/** Build all text-output models regardless of score, used as last-resort fallback. */
function _buildAllCandidates(providers, taskType, requiresImage, minContextK = 0) {
  const candidates = [];
  for (const provider of providers) {
    const providerModels = modelsData[provider];
    if (!providerModels) continue;
    for (const [modelName, caps] of Object.entries(providerModels)) {
      if (caps.outputType !== 'text') continue;
      if (requiresImage && !caps.inputImage) continue;
      if (minContextK > 0 && caps.contextK > 0 && caps.contextK < minContextK) continue;
      const totalCost = (caps.inputPer1M || 0) + (caps.outputPer1M || 0);
      const taskScore = caps[taskType] ?? 0;
      candidates.push({ provider, model: modelName, totalCost, speed: caps.speed || 30, score: taskScore, useThinking: false });
    }
  }
  return candidates;
}

/**
 * Select the cheapest text-output model whose score for taskType >= difficulty.
 * For models with thinking capability, two virtual candidates are considered:
 * one without thinking (original scores) and one with thinking (code+1,
 * reasoning+2, speed-2). The winner may activate thinking mode.
 *
 * @param {'code'|'reasoning'} taskType
 * @param {number} difficulty - 1-100 (code/reasoning) or 1-10 (speed)
 * @param {string[]} availableProviders - providers with API keys
 * @returns {{ provider: string, model: string, useThinking: boolean } | null}
 */
export function selectAutoModel(taskType, difficulty, availableProviders, { requiresImage = false, minContextK = 0, profile = null } = {}) {
  // Code tasks require a minimum difficulty of 50 to ensure capable models are selected.
  // Cheap/fast models can't reliably generate structured output like unified diffs.
  if (taskType === 'code') difficulty = Math.max(difficulty, 50);

  let candidates = _buildCandidates(availableProviders, taskType, difficulty, requiresImage, false, minContextK, profile);

  // If all providers are on cooldown, ignore cooldowns and pick the best available
  // so we never block LLM calls entirely.
  if (candidates.length === 0) {
    candidates = _buildCandidates(availableProviders, taskType, difficulty, requiresImage, true, minContextK, profile);
  }

  // No model meets the difficulty threshold — pick the one with the highest score
  // for this task type rather than failing. This avoids crashes when available
  // models are weaker than the minimum required score.
  if (candidates.length === 0) {
    candidates = _buildAllCandidates(availableProviders, taskType, requiresImage, minContextK);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      const costDiff = a.totalCost - b.totalCost;
      if (Math.abs(costDiff) > 0.0001) return costDiff;
      return b.speed - a.speed;
    });
    const winner = candidates[0];
    return { provider: winner.provider, model: winner.model, useThinking: winner.useThinking };
  }

  candidates.sort((a, b) => {
    const costDiff = a.totalCost - b.totalCost;
    if (Math.abs(costDiff) > 0.0001) return costDiff;
    return b.speed - a.speed;
  });

  const winner = candidates[0];
  return { provider: winner.provider, model: winner.model, useThinking: winner.useThinking };
}

/**
 * Return ALL candidate models for a task, sorted by cost (cheapest first).
 * Used by the classifier to try multiple models if the cheapest fails.
 */
export function getAllCandidates(taskType, difficulty, availableProviders) {
  let candidates = _buildCandidates(availableProviders, taskType, difficulty, false, false, 0);
  if (candidates.length === 0) {
    candidates = _buildCandidates(availableProviders, taskType, difficulty, false, true, 0);
  }
  if (candidates.length === 0) {
    candidates = _buildAllCandidates(availableProviders, taskType, false, 0);
  }
  // Sort by cost, deduplicate by model name
  candidates.sort((a, b) => a.totalCost - b.totalCost || b.speed - a.speed);
  const seen = new Set();
  return candidates.filter(c => {
    if (seen.has(c.model)) return false;
    seen.add(c.model);
    return true;
  });
}
