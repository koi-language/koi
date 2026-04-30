/**
 * Provider factory — resolves the best model instance based on requirements.
 *
 * Six model types:
 *   - LLM:       resolve({ type: 'llm', ... })       or createLLM(provider, client, model, opts)
 *   - Embedding:  resolve({ type: 'embedding' })       or createEmbedding(provider, client)
 *   - Search:     resolve({ type: 'search' })           or createSearch(provider, opts)
 *   - Image:      resolve({ type: 'image', ... })       or createImageGen(provider, client, model)
 *   - Audio:      resolve({ type: 'audio', ... })       or createAudioGen(provider, client, model)
 *   - Video:      resolve({ type: 'video', ... })       or createVideoGen(provider, client, model)
 *
 * The resolve() method is the main entry point — it picks the best available
 * provider and model based on task requirements, available API keys, costs,
 * and circuit breaker state. Direct create* methods are for when you already
 * know exactly which provider/model to use.
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getModelCaps, getFirstModelForProvider } from '../cost-center.js';
import { OpenAIChatLLM, OpenAIResponsesLLM, OpenAIEmbedding, OpenAISearch, OpenAIImageGen, OpenAIAudioGen, OpenAIVideoGen } from './openai.js';
import { AnthropicLLM, AnthropicSearch } from './anthropic.js';
import { GeminiLLM, GeminiEmbedding, GeminiImageGen, GeminiVideoGen } from './gemini.js';
import { BraveSearch } from './brave.js';
import { TavilySearch } from './tavily.js';
import { GatewayEmbedding, GatewaySearch, GatewayImageGen, GatewayAudioGen, GatewayVideoGen } from './gateway.js';
import { KlingVideoGen } from './kling.js';
import { SeedanceVideoGen } from './seedance.js';
import { NanoBanana2ImageGen } from './banana.js';

// ── Re-export from auto-model-selector (circuit breaker, provider discovery) ─
// These are consumed by llm-provider.js for error handling.
export { markProviderTimeout, markModelTimeout, clearProviderCooldown, getAvailableProviders, loadRemoteModels, forceRefreshRemoteModels, DEFAULT_TASK_PROFILE, getAllCandidates } from '../auto-model-selector.js';
import { selectAutoModel } from '../auto-model-selector.js';
import { channel } from '../../io/channel.js';

// ─────────────────────────────────────────────────────────────────────────────
// resolve() — the main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the best model instance for the given requirements.
 *
 * @param {Object} req
 * @param {'llm'|'embedding'|'search'|'image'|'audio'|'video'} req.type
 *
 * --- LLM-specific fields ---
 * @param {string}   [req.taskType]         - 'code' | 'reasoning' | 'speed'
 * @param {number}   [req.difficulty]       - 1-10
 * @param {boolean}  [req.requiresImage]    - Needs vision-capable model
 * @param {boolean}  [req.requiresVideo]    - Needs a model with `inputVideo` (raw video bytes)
 * @param {boolean}  [req.requiresAudio]    - Needs a model with `inputAudio` (raw audio bytes)
 * @param {boolean}  [req.requiresFile]     - Needs a model with `inputFile` (PDF/document bytes)
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
    case 'image':     return _resolveImage(req);
    case 'audio':     return _resolveAudio(req);
    case 'video':     return _resolveVideo(req);
    default:          throw new Error(`Unknown model type: ${req.type}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM resolution
// ─────────────────────────────────────────────────────────────────────────────

function _resolveLLM(req) {
  const {
    taskType = 'code', difficulty: baseDifficulty = 50, profile = null, requiresImage = false,
    requiresVideo = false, requiresAudio = false, requiresFile = false,
    session, agentName, availableProviders, clients,
    temperature, maxTokens, minContextK = 0
  } = req;

  // ── Forced model override (--model flag / KOI_DEFAULT_MODEL) ───────────
  // Check BEFORE availableProviders — forced mode creates its own client
  // and doesn't need providers from the auto-selector.
  const envModelOverride = process.env.KOI_DEFAULT_MODEL;
  const envProviderOverride = process.env.KOI_DEFAULT_PROVIDER;
  if (envModelOverride && envModelOverride !== 'auto') {
    const provider = envProviderOverride
      || (envModelOverride.startsWith('claude-') ? 'anthropic' : envModelOverride.startsWith('gemini-') ? 'gemini' : 'openai');
    const model = envModelOverride;
    channel.log('llm', `[forced] ${agentName || 'agent'} → ${provider}/${model} | ${taskType}`);
    channel.setInfo('model', model);
    // Resolve client for the forced provider.
    // If the user is signed in (KOI_AUTH_TOKEN set), ALWAYS route through
    // the gateway — never fall back to local env API keys. Mixing gateway
    // and direct providers in the same session bypasses credit accounting.
    // Only when the user is NOT signed in (or explicitly offline) do we
    // fall through to direct clients built from local env vars.
    const _isSignedIn = !!process.env.KOI_AUTH_TOKEN && !process.env.KOI_OFFLINE_MODE;
    let client;
    if (_isSignedIn) {
      client = clients[provider];
    } else if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } else if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
    } else if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
      client = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', maxRetries: 0 });
    } else {
      client = clients[provider];
    }
    if (!client) throw new Error(`No SDK client for forced provider: ${provider}. Is the API key set?`);
    const instance = createLLM(provider, client, model, { temperature, maxTokens, useThinking: false });
    return { instance, provider, effectiveProvider: provider, model, useThinking: false, effectiveDifficulty: baseDifficulty };
  }

  if (!availableProviders?.length) {
    throw new Error('NO_PROVIDERS: No LLM providers available — all API keys are missing or invalid.');
  }

  // ── Calculate effective difficulty with boosts ──────────────────────────
  const boosts = session ? _calculateDifficultyBoosts(session) : { total: 0, parts: [] };
  const effectiveDifficulty = Math.min(100, baseDifficulty + boosts.total);

  // ── Filter out declined providers (models that refused tasks at this risk level) ────
  const _declined = session?._declinedProviders; // Map<provider, { risk, until }>
  const _currentRisk = profile?.risk ?? 0;
  const _now = Date.now();
  const _filteredProviders = _declined?.size > 0
    ? availableProviders.filter(p => {
        const entry = _declined.get(p);
        if (!entry) return true;
        // Cooldown expired → provider is available again
        if (_now >= entry.until) { _declined.delete(p); return true; }
        // Exclude provider for tasks at same or higher risk than what they refused
        return _currentRisk < entry.risk;
      })
    : availableProviders;

  // ── Select best model ──────────────────────────────────────────────────
  if (_declined?.size > 0) {
    channel.log('llm', `[auto] Provider filter: available=[${availableProviders.join(',')}] filtered=[${_filteredProviders.join(',')}] declined=[${[..._declined.entries()].map(([p,e]) => `${p}(risk${e.risk})`).join(',')}] taskRisk=${_currentRisk}`);
  }
  const selected = selectAutoModel(taskType, effectiveDifficulty, _filteredProviders.length > 0 ? _filteredProviders : availableProviders, { requiresImage, requiresVideo, requiresAudio, requiresFile, minContextK, profile });
  if (!selected) throw new Error('NO_MODELS: No suitable model found for the current task — check your available providers.');
  const provider = selected.provider;
  const model    = selected.model;
  const useThinking = selected.useThinking;

  // ── Log selection ──────────────────────────────────────────────────────
  const boostNote = boosts.total > 0 ? ` [escalated +${boosts.total}: ${boosts.parts.join(', ')}]` : '';
  const thinkingNote = useThinking ? ' [thinking]' : '';
  const scoreNote = profile?.code != null
    ? `code:${profile.code}/100, reasoning:${profile.reasoning}/100`
    : `${taskType}:${effectiveDifficulty}/100`;
  channel.log('llm', `[auto] ${agentName || 'agent'} → ${provider}/${model}${thinkingNote} | ${scoreNote}${boostNote}`);
  if (process.env.KOI_DEBUG_LLM) {
    console.error(`[Auto] ${agentName || 'agent'} → ${provider}/${model} (${taskType} ${effectiveDifficulty}/100${boostNote})`);
  }

  // ── Show model in footer (only for named agents, not background tasks) ──
  if (agentName) channel.setInfo('model', model);

  // ── Create instance ────────────────────────────────────────────────────
  // In gateway mode, all providers route through the OpenAI-compatible gateway.
  // Force effectiveProvider to 'openai' so createLLM uses the OpenAI SDK wrapper,
  // but keep the original provider name for tracking/exclusion purposes.
  const effectiveProvider = process.env.KOI_AUTH_TOKEN ? 'openai' : provider;
  const client = process.env.KOI_AUTH_TOKEN ? clients.openai : clients[provider];
  if (!client) throw new Error(`No SDK client for provider: ${provider}`);

  const reasoningEffort = req.profile?.reasoningEffort ?? (useThinking ? 'medium' : 'none');
  const instance = createLLM(effectiveProvider, client, model, {
    temperature, maxTokens, useThinking, reasoningEffort
  });

  // provider = original (for tracking, exclusion, cost)
  // effectiveProvider = 'openai' in gateway mode (for SDK wrapper selection)
  return { instance, provider, effectiveProvider, model, useThinking, effectiveDifficulty, profile: req.profile };
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedding resolution
// ─────────────────────────────────────────────────────────────────────────────

function _resolveEmbedding(req) {
  const { clients } = req;

  // Gateway mode: route through braxil.ai backend
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

  // Gateway mode: route through braxil.ai backend (skip if forced model is set —
  // forced mode means we're bypassing the gateway for direct API access)
  if (process.env.KOI_AUTH_TOKEN && !process.env.KOI_DEFAULT_MODEL) {
    const instance = new GatewaySearch();
    return { instance, provider: 'koi-gateway', model: 'gateway-search', useThinking: false };
  }

  // Priority: dedicated search APIs first (cheaper, faster), then LLM-based search.
  // 1. Dedicated search APIs (no LLM cost)
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const instance = new BraveSearch(process.env.BRAVE_SEARCH_API_KEY);
    return { instance, provider: 'brave', model: 'brave-search', useThinking: false };
  }
  if (process.env.TAVILY_API_KEY) {
    const instance = new TavilySearch(process.env.TAVILY_API_KEY);
    return { instance, provider: 'tavily', model: 'tavily-search', useThinking: false };
  }
  // 2. LLM-based search — pick the best available provider.
  //    Anthropic (web_search tool) is preferred: returns structured results + summary.
  //    OpenAI (gpt-5-search-api) is fallback.
  if (process.env.ANTHROPIC_API_KEY) {
    const client = clients?.anthropic || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const instance = new AnthropicSearch(client);
    return { instance, provider: 'anthropic', model: 'claude-sonnet-4-20250514', useThinking: false };
  }
  if (process.env.OPENAI_API_KEY) {
    const client = clients?.openai || new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
    const instance = new OpenAISearch(client, 'gpt-5-search-api');
    return { instance, provider: 'openai', model: 'gpt-5-search-api', useThinking: false };
  }
  return null; // No search provider available
}

// ─────────────────────────────────────────────────────────────────────────────
// Image generation resolution
// ─────────────────────────────────────────────────────────────────────────────

function _resolveImage(req) {
  const { clients, model: requestedModel, excludeProviders } = req;
  // `excluded` is a Set of provider family names the caller has asked us to
  // skip — used on retry after a ProviderBlockedError surfaces. Empty set
  // means "no exclusions". Compared against the provider string this
  // function ultimately returns, so values are: 'openai', 'google',
  // 'gemini', 'koi-gateway'.
  const excluded = new Set(excludeProviders || []);

  // Gateway mode — the gateway itself handles per-model routing; we can't
  // usefully exclude by family here, so we honor the request as-is.
  if (process.env.KOI_AUTH_TOKEN) {
    const model = requestedModel || 'auto';
    const instance = new GatewayImageGen(model);
    return { instance, provider: 'koi-gateway', model, useThinking: false };
  }

  // Priority: Google/NanoBanana2 → OpenAI (gpt-image-1) → Gemini (gemini-2.5-flash-image)
  // Nano Banana 2 is the fastest and supports up to 14 reference images.
  if (!excluded.has('google') && process.env.GEMINI_API_KEY
      && (!requestedModel || requestedModel.includes('3.1-flash-image') || requestedModel.includes('3-pro-image-preview'))) {
    const model = requestedModel || 'gemini-3.1-flash-image-preview';
    if (model.includes('3.1-flash-image') || model.includes('3-pro-image-preview')) {
      const instance = new NanoBanana2ImageGen(null, model);
      return { instance, provider: 'google', model, useThinking: false };
    }
  }
  if (!excluded.has('openai') && clients?.openai && process.env.OPENAI_API_KEY) {
    const model = requestedModel || 'gpt-image-1';
    const instance = new OpenAIImageGen(clients.openai, model);
    return { instance, provider: 'openai', model, useThinking: false };
  }
  if (!excluded.has('gemini') && process.env.GEMINI_API_KEY) {
    const model = requestedModel || 'gemini-2.5-flash-image';
    const instance = new GeminiImageGen(null, model);
    return { instance, provider: 'gemini', model, useThinking: false };
  }
  const excludedHint = excluded.size ? ` (excluded: ${[...excluded].join(', ')})` : '';
  throw new Error(`No image generation provider available${excludedHint} (need OPENAI_API_KEY or GEMINI_API_KEY)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio generation resolution
// ─────────────────────────────────────────────────────────────────────────────

function _resolveAudio(req) {
  const { clients, model: requestedModel } = req;

  // Gateway mode
  if (process.env.KOI_AUTH_TOKEN) {
    const model = requestedModel || 'auto';
    const instance = new GatewayAudioGen(model);
    return { instance, provider: 'koi-gateway', model, useThinking: false };
  }

  // Only OpenAI has TTS/STT via SDK
  if (clients?.openai && process.env.OPENAI_API_KEY) {
    const model = requestedModel || 'tts-1';
    const instance = new OpenAIAudioGen(clients.openai, model);
    return { instance, provider: 'openai', model, useThinking: false };
  }
  throw new Error('No audio generation provider available (need OPENAI_API_KEY)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Video generation resolution
// ─────────────────────────────────────────────────────────────────────────────

function _resolveVideo(req) {
  const { clients, model: requestedModel } = req;

  // Gateway mode
  if (process.env.KOI_AUTH_TOKEN) {
    const model = requestedModel || 'auto';
    const instance = new GatewayVideoGen(model);
    return { instance, provider: 'koi-gateway', model, useThinking: false };
  }

  // Priority: Kling → Seedance → OpenAI (Sora) → Gemini (Veo) → Google (Nano Banana)
  if (process.env.KLING_ACCESS_KEY && process.env.KLING_SECRET_KEY) {
    const model = requestedModel || 'kling-v3-0';
    const instance = new KlingVideoGen(null, model);
    return { instance, provider: 'kling', model, useThinking: false };
  }
  if (process.env.SEEDANCE_API_KEY) {
    const model = requestedModel || 'seedance-2-0-lite';

    const instance = new SeedanceVideoGen(null, model);
    return { instance, provider: 'seedance', model, useThinking: false };
  }
  if (clients?.openai && process.env.OPENAI_API_KEY) {
    const model = requestedModel || 'sora';
    const instance = new OpenAIVideoGen(clients.openai, model);
    return { instance, provider: 'openai', model, useThinking: false };
  }
  if (clients?.gemini || process.env.GEMINI_API_KEY) {
    const model = requestedModel || 'veo-3.1-generate-preview';
    const instance = new GeminiVideoGen(clients?.gemini, model);
    return { instance, provider: 'gemini', model, useThinking: false };
  }
  throw new Error('No video generation provider available (need KLING_ACCESS_KEY+KLING_SECRET_KEY, SEEDANCE_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)');
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

  // Infrastructure errors (LLM timeout / HTTP 4xx-5xx) should NOT inflate difficulty.
  // BUT: JSON parse failures ARE capability errors (model too weak to follow format).
  const _isInfraError = (entry) => {
    const msg = entry.error?.message || '';
    // JSON parse failures = model capability issue, NOT infra → count them
    if (/failed to parse.*json|not valid json/i.test(msg)) return false;
    if (entry.action?.intent === '_llm_error') return true;
    const status = entry.error?.status ?? entry.error?.statusCode;
    if (typeof status === 'number' && status >= 400) return true;
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
  // Boost on 1-100 scale.
  // JSON parse failures = model can't do structured output → escalate aggressively.
  // 1st fail: +15, 2nd: +30. Wastes no time on incapable models.
  // Normal errors: escalate gradually (+5 per 3 errors).
  const _isJsonParseError = _lastMsg && /failed to parse.*json|not valid json/i.test(_lastMsg);
  const difficultyBoost = _isJsonParseError
    ? Math.min(_sameErrorCount * 15, 30)
    : (_sameErrorCount >= 3 ? Math.min(Math.floor(_sameErrorCount / 3) * 5, 15) : 0);
  if (difficultyBoost > 0) parts.push(`same error ×${_sameErrorCount}${_isJsonParseError ? ' (parse)' : ''}`);

  // ── Loop boost (set externally) ────────────────────────────────────────
  const loopBoost = session._loopBoost || 0;
  if (loopBoost > 0) parts.push(`loop ×${loopBoost}`);

  // ── Fail-rate boost ────────────────────────────────────────────────────
  const _recentWindow = (session.actionHistory || []).slice(-8).filter(e => !_isInfraError(e));
  const _recentFailCount = _recentWindow.filter(
    e => e.error || (e.result?.success === false && e.result.error)
  ).length;
  const failRateBoost = (_recentWindow.length >= 5 && _recentFailCount >= Math.ceil(_recentWindow.length * 0.6))
    ? Math.min(Math.floor(_recentFailCount / 3) * 5, 10)
    : 0;
  if (failRateBoost > 0) parts.push(`fail-rate ${_recentFailCount}/${_recentWindow.length}`);

  return { total: difficultyBoost + loopBoost + failRateBoost, parts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct creation methods (for when provider/model are already known)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an LLM instance directly (no auto-selection).
 *
 * Routing between `OpenAIChatLLM` (POST /v1/chat/completions) and
 * `OpenAIResponsesLLM` (POST /v1/responses) is decided purely by
 * `caps.api`, which is populated from the model registry — either the
 * remote gateway `models.json` (authoritative source) or the local
 * `models.json` fallback. The client does NOT guess by model name.
 *
 * If a new OpenAI model is added to the gateway without an `api` value,
 * the call will default to chat completions. Use the backoffice
 * "Auto-detect API" button (or the /admin/model-prices/:id/probe-api
 * endpoint) to resolve the correct value.
 */
export function createLLM(provider, client, model, opts = {}) {
  const caps = getModelCaps(model);
  const fullOpts = { ...opts, caps };

  switch (provider) {
    case 'openai':
      // In gateway mode (OpenRouter), always use chat/completions.
      // OpenRouter accepts any model on this endpoint and converts
      // internally. The 'responses' variant is only needed for direct
      // OpenAI API calls with codex models (which reject chat/completions).
      if (caps.api === 'responses' && !process.env.KOI_AUTH_TOKEN) {
        return new OpenAIResponsesLLM(client, model, fullOpts);
      }
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
 * Create an ImageGen instance directly.
 */
export function createImageGen(provider, client, model) {
  switch (provider) {
    case 'openai':  return new OpenAIImageGen(client, model || 'gpt-image-1');
    case 'gemini':  return new GeminiImageGen(client, model || 'gemini-2.5-flash-image');
    case 'google':  return new NanoBanana2ImageGen(null, model || 'gemini-3.1-flash-image-preview');
    default: throw new Error(`No image generation support for provider: ${provider}`);
  }
}

/**
 * Create an AudioGen instance directly.
 */
export function createAudioGen(provider, client, model) {
  switch (provider) {
    case 'openai':  return new OpenAIAudioGen(client, model || 'tts-1');
    default: throw new Error(`No audio generation support for provider: ${provider}`);
  }
}

/**
 * Create a VideoGen instance directly.
 */
export function createVideoGen(provider, client, model) {
  switch (provider) {
    case 'openai':   return new OpenAIVideoGen(client, model || 'sora');
    case 'gemini':   return new GeminiVideoGen(client, model || 'veo-3.1-generate-preview');
    case 'kling':    return new KlingVideoGen(null, model || 'kling-v3-0');
    case 'seedance': return new SeedanceVideoGen(null, model || 'seedance-2-0-lite');
    default: throw new Error(`No video generation support for provider: ${provider}`);
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
