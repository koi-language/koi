/**
 * Provider factory — resolves the best model instance based on requirements.
 *
 * Three model types:
 *   - LLM:       resolve({ type: 'llm', ... })       or createLLM(provider, client, model, opts)
 *   - Embedding:  resolve({ type: 'embedding' })       or createEmbedding(provider, client)
 *   - Search:     resolve({ type: 'search' })           or createSearch(provider, opts)
 *
 * The resolve() method is the main entry point — it picks the best available
 * provider and model based on task requirements, available API keys, costs,
 * and circuit breaker state. Direct create* methods are for when you already
 * know exactly which provider/model to use.
 */

import { getModelCaps, getFirstModelForProvider } from '../cost-center.js';
import { OpenAIChatLLM, OpenAIResponsesLLM, OpenAIEmbedding, OpenAISearch } from './openai.js';
import { AnthropicLLM } from './anthropic.js';
import { GeminiLLM, GeminiEmbedding } from './gemini.js';
import { BraveSearch } from './brave.js';
import { TavilySearch } from './tavily.js';
import { GatewayEmbedding, GatewaySearch } from './gateway.js';
import { cliLogger } from '../cli-logger.js';

// ── Re-export from auto-model-selector (circuit breaker, provider discovery) ─
// These are consumed by llm-provider.js for error handling.
export { markProviderTimeout, clearProviderCooldown, getAvailableProviders, loadRemoteModels, DEFAULT_TASK_PROFILE } from '../auto-model-selector.js';
import { selectAutoModel } from '../auto-model-selector.js';

// ─────────────────────────────────────────────────────────────────────────────
// resolve() — the main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the best model instance for the given requirements.
 *
 * @param {Object} req
 * @param {'llm'|'embedding'|'search'} req.type
 *
 * --- LLM-specific fields ---
 * @param {string}   [req.taskType]         - 'code' | 'planning' | 'reasoning' | 'speed'
 * @param {number}   [req.difficulty]       - 1-10
 * @param {boolean}  [req.requiresImage]    - Needs vision-capable model
 * @param {Object}   [req.session]          - Agent session (for difficulty boost calculation)
 * @param {string}   [req.agentName]        - For logging
 * @param {number}   [req.temperature]      - Override temperature
 * @param {number}   [req.maxTokens]        - Override max tokens
 *
 * --- Required: available clients ---
 * @param {string[]} req.availableProviders - ['openai', 'anthropic', 'gemini']
 * @param {Object}   req.clients            - { openai, anthropic, gemini } SDK client instances
 *
 * @returns {{ instance: BaseLLM|BaseEmbedding|BaseSearch, provider: string, model: string, useThinking: boolean, effectiveDifficulty?: number }}
 */
export function resolve(req) {
  switch (req.type) {
    case 'llm':       return _resolveLLM(req);
    case 'embedding': return _resolveEmbedding(req);
    case 'search':    return _resolveSearch(req);
    default:          throw new Error(`Unknown model type: ${req.type}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM resolution
// ─────────────────────────────────────────────────────────────────────────────

function _resolveLLM(req) {
  const {
    taskType = 'code', difficulty: baseDifficulty = 5, requiresImage = false,
    session, agentName, availableProviders, clients,
    temperature, maxTokens, minContextK = 0
  } = req;

  if (!availableProviders?.length) {
    throw new Error('NO_PROVIDERS: No LLM providers available — all API keys are missing or invalid.');
  }

  // ── Calculate effective difficulty with boosts ──────────────────────────
  const boosts = session ? _calculateDifficultyBoosts(session) : { total: 0, parts: [] };
  const effectiveDifficulty = Math.min(10, baseDifficulty + boosts.total);

  // ── Select best model ──────────────────────────────────────────────────
  const selected = selectAutoModel(taskType, effectiveDifficulty, availableProviders, { requiresImage, minContextK });
  if (!selected) throw new Error('NO_MODELS: No suitable model found for the current task — check your available providers.');
  const provider = selected.provider;
  const model    = selected.model;
  const useThinking = selected.useThinking;

  // ── Log selection ──────────────────────────────────────────────────────
  const boostNote = boosts.total > 0 ? ` [escalated +${boosts.total}: ${boosts.parts.join(', ')}]` : '';
  const thinkingNote = useThinking ? ' [thinking]' : '';
  cliLogger.log('llm', `[auto] ${agentName || 'agent'} → ${provider}/${model}${thinkingNote} | ${taskType}:${effectiveDifficulty}/10${boostNote}`);
  if (process.env.KOI_DEBUG_LLM) {
    console.error(`[Auto] ${agentName || 'agent'} → ${provider}/${model} (${taskType} ${effectiveDifficulty}/10${boostNote})`);
  }

  // ── Show model in footer ───────────────────────────────────────────────
  cliLogger.setInfo('model', model);

  // ── Create instance ────────────────────────────────────────────────────
  // In gateway mode, all providers route through the OpenAI-compatible gateway.
  // Force effectiveProvider to 'openai' so createLLM uses the OpenAI SDK wrapper,
  // but keep the original provider name for tracking/exclusion purposes.
  const effectiveProvider = process.env.KOI_AUTH_TOKEN ? 'openai' : provider;
  const client = process.env.KOI_AUTH_TOKEN ? clients.openai : clients[provider];
  if (!client) throw new Error(`No SDK client for provider: ${provider}`);

  const instance = createLLM(effectiveProvider, client, model, {
    temperature, maxTokens, useThinking
  });

  // provider = original (for tracking, exclusion, cost)
  // effectiveProvider = 'openai' in gateway mode (for SDK wrapper selection)
  return { instance, provider, effectiveProvider, model, useThinking, effectiveDifficulty };
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedding resolution
// ─────────────────────────────────────────────────────────────────────────────

function _resolveEmbedding(req) {
  const { clients } = req;

  // Gateway mode: route through koi-cli.ai backend
  if (process.env.KOI_AUTH_TOKEN) {
    const instance = new GatewayEmbedding();
    return { instance, provider: 'koi-gateway', model: 'text-embedding-3-small', useThinking: false };
  }

  // Priority: OpenAI (cheapest, 1536-dim) → Gemini (768-dim)
  if (clients?.openai_embedding || process.env.OPENAI_API_KEY) {
    const client = clients?.openai_embedding || clients?.openai;
    const instance = new OpenAIEmbedding(client);
    return { instance, provider: 'openai', model: 'text-embedding-3-small', useThinking: false };
  }
  if (clients?.gemini_embedding || process.env.GEMINI_API_KEY) {
    const client = clients?.gemini_embedding || clients?.gemini;
    const instance = new GeminiEmbedding(client);
    return { instance, provider: 'gemini', model: 'text-embedding-004', useThinking: false };
  }
  throw new Error('No embedding provider available (need OPENAI_API_KEY or GEMINI_API_KEY)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Search resolution
// ─────────────────────────────────────────────────────────────────────────────

function _resolveSearch(req) {
  const { clients } = req;

  // Gateway mode: route through koi-cli.ai backend
  if (process.env.KOI_AUTH_TOKEN) {
    const instance = new GatewaySearch();
    return { instance, provider: 'koi-gateway', model: 'gateway-search', useThinking: false };
  }

  // Priority: Brave → Tavily → OpenAI search model
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const instance = new BraveSearch(process.env.BRAVE_SEARCH_API_KEY);
    return { instance, provider: 'brave', model: 'brave-search', useThinking: false };
  }
  if (process.env.TAVILY_API_KEY) {
    const instance = new TavilySearch(process.env.TAVILY_API_KEY);
    return { instance, provider: 'tavily', model: 'tavily-search', useThinking: false };
  }
  if (clients?.openai && process.env.OPENAI_API_KEY) {
    const instance = new OpenAISearch(clients.openai, 'gpt-5-search-api');
    return { instance, provider: 'openai', model: 'gpt-5-search-api', useThinking: false };
  }
  return null; // No search provider available
}

// ─────────────────────────────────────────────────────────────────────────────
// Difficulty boost calculation (extracted from llm-provider.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate difficulty boosts from session error history.
 * Escalates model selection when the agent is stuck in repeated errors.
 *
 * @param {Object} session - Agent session with actionHistory, lastError, _loopBoost
 * @returns {{ total: number, parts: string[] }}
 */
export function _calculateDifficultyBoosts(session) {
  const parts = [];

  // Infrastructure errors (LLM timeout / HTTP 4xx-5xx) should NOT inflate difficulty
  const _isInfraError = (entry) => {
    if (entry.action?.intent === '_llm_error') return true;
    const status = entry.error?.status ?? entry.error?.statusCode;
    if (typeof status === 'number' && status >= 400) return true;
    const msg = entry.error?.message || '';
    if (/timed?\s*out|timeout/i.test(msg)) return true;
    return false;
  };

  // ── Same-error repetition boost ──────────────────────────────────────
  const _normalizeErrMsg = (msg) => {
    if (!msg) return msg;
    return msg.replace(/\b(line|lines?)\s+\d+(-\d+)?\b/gi, 'line N')
              .replace(/\bcolumn\s+\d+\b/gi, 'column N')
              .replace(/\bat\s+\d+\b/gi, 'at N');
  };

  let _sameErrorCount = 0;
  const _lastErrorIsInfra = session.lastError && _isInfraError({ error: session.lastError, action: session.actionHistory?.at(-1)?.action });
  const _lastMsg = _lastErrorIsInfra ? null : session.lastError?.message;
  const _lastMsgNorm = _normalizeErrMsg(_lastMsg);
  const _maxLookback = 12;

  if (_lastMsg && session.actionHistory) {
    for (let _i = session.actionHistory.length - 1; _i >= 0 && _i >= session.actionHistory.length - _maxLookback; _i--) {
      const _e = session.actionHistory[_i];
      if (_isInfraError(_e)) continue;
      const _msg = _e.error?.message ?? (_e.result?.success === false ? _e.result.error : null);
      if (!_msg) continue;
      if (_normalizeErrMsg(_msg) !== _lastMsgNorm) break;
      _sameErrorCount++;
    }
  }
  const difficultyBoost = _sameErrorCount >= 3 ? Math.min(Math.floor(_sameErrorCount / 3), 3) : 0;
  if (difficultyBoost > 0) parts.push(`same error ×${_sameErrorCount}`);

  // ── Loop boost (set externally) ────────────────────────────────────────
  const loopBoost = session._loopBoost || 0;
  if (loopBoost > 0) parts.push(`loop ×${loopBoost}`);

  // ── Fail-rate boost ────────────────────────────────────────────────────
  const _recentWindow = (session.actionHistory || []).slice(-8).filter(e => !_isInfraError(e));
  const _recentFailCount = _recentWindow.filter(
    e => e.error || (e.result?.success === false && e.result.error)
  ).length;
  const failRateBoost = (_recentWindow.length >= 5 && _recentFailCount >= Math.ceil(_recentWindow.length * 0.6))
    ? Math.min(Math.floor(_recentFailCount / 3), 2)
    : 0;
  if (failRateBoost > 0) parts.push(`fail-rate ${_recentFailCount}/${_recentWindow.length}`);

  return { total: difficultyBoost + loopBoost + failRateBoost, parts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct creation methods (for when provider/model are already known)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an LLM instance directly (no auto-selection).
 */
export function createLLM(provider, client, model, opts = {}) {
  const caps = getModelCaps(model);
  const fullOpts = { ...opts, caps };

  switch (provider) {
    case 'openai':
      if (caps.api === 'responses') return new OpenAIResponsesLLM(client, model, fullOpts);
      return new OpenAIChatLLM(client, model, fullOpts);
    case 'anthropic':
      return new AnthropicLLM(client, model, fullOpts);
    case 'gemini':
      return new GeminiLLM(client, model, fullOpts);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

/**
 * Create an Embedding instance directly.
 */
export function createEmbedding(provider, client) {
  switch (provider) {
    case 'openai':  return new OpenAIEmbedding(client);
    case 'gemini':  return new GeminiEmbedding(client);
    default: throw new Error(`No embedding support for provider: ${provider}`);
  }
}

/**
 * Create a Search instance directly.
 */
export function createSearch(provider, opts = {}) {
  switch (provider) {
    case 'openai':
      if (!opts.client) throw new Error('createSearch("openai") requires opts.client');
      return new OpenAISearch(opts.client, opts.model || 'gpt-5-search-api');
    case 'brave':
      return new BraveSearch(opts.apiKey || process.env.BRAVE_SEARCH_API_KEY);
    case 'tavily':
      return new TavilySearch(opts.apiKey || process.env.TAVILY_API_KEY);
    default:
      throw new Error(`Unknown search provider: ${provider}`);
  }
}

/**
 * Get the embedding dimension for a provider without creating an instance.
 */
export function getEmbeddingDimension(provider) {
  switch (provider) {
    case 'openai':  return 1536;
    case 'gemini':  return 768;
    default:        return 1536;
  }
}
