import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

// undici (Node.js built-in fetch) has a default headersTimeout of 30s.
// Thinking/reasoning models buffer internal tokens before sending the first
// response byte, causing the 30s idle timeout to fire before any data arrives.
// Raise headersTimeout and bodyTimeout to 10 minutes to match our LLM timeout.
try {
  const _undici = createRequire(import.meta.url)('undici');
  _undici.setGlobalDispatcher(new _undici.Agent({ headersTimeout: 10 * 60 * 1000, bodyTimeout: 10 * 60 * 1000 }));
} catch {
  // undici not available — fetch will use its own defaults
}

import { actionRegistry } from '../agent/action-registry.js';
import { classifyFeedback, classifyResponse } from '../state/feedback-classifier.js';
// All conversational state is mirrored to the Event Log via the deprecated
// ContextMemory shim (state/context-memory.js). The shim's toMessages() now
// reads directly from the Event Log — no flag, no fallback.
import { costCenter, getModelCaps } from './cost-center.js';
import { EFFORT_NONE, EFFORT_LOW, EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_RANK, THINKING_INACTIVITY_MS, DEFAULT_INACTIVITY_MS } from './constants.js';

import { resolve as resolveModel, createLLM, createEmbedding, getEmbeddingDimension, DEFAULT_TASK_PROFILE, getAvailableProviders, getAllCandidates, loadRemoteModels, forceRefreshRemoteModels, markProviderTimeout, markModelTimeout, clearProviderCooldown } from './providers/factory.js';
import { resolveMaxOutputTokens } from './max-tokens-policy.js';
import { channel } from '../io/channel.js';

// ── Extracted modules ────────────────────────────────────────────────────────
import { formatDebugText, logRequest, logResponse, logDebug, logError } from './debug-logger.js';
import { TaskClassifier } from './task-classifier.js';
import { EmbeddingProvider } from './embedding-provider.js';
import { parseReactiveResponse, normalizeReactiveAction, normalizeBatchItem, searchRelevantCommits } from './response-parser.js';
import { buildReactiveSystemPrompt, buildSystemPrompt, loadKoiMd, buildSmartResourceSection } from './system-prompt-builder.js';
import { executeCompose as _executeCompose, callJSONWithMessages as _callJSONWithMessages, inferProviderFromModel } from './compose-executor.js';
import { StreamingPrintParser } from './streaming-print.js';
import { optimizeImage, resolveAttachments, injectMcpImages, pruneOldImages, injectCacheControl } from './message-builder.js';
import { isQuotaExceededError, toQuotaExceededError } from './quota-exceeded-error.js';

// Load .env files but don't override existing environment variables.
// Priority: process.env > local .env > global ~/.koi/.env
const originalWrite = process.stdout.write;
process.stdout.write = () => {}; // Temporarily silence stdout
dotenv.config({ path: path.join(os.homedir(), '.koi', '.env'), override: false });
dotenv.config({ override: false }); // local .env takes priority over global
process.stdout.write = originalWrite; // Restore stdout

/**
 * Format prompt text with > prefix for each line (for debug output)
 */
function formatPromptForDebug(text) {
  return text.split('\n').map(line => `> \x1b[90m${line}\x1b[0m`).join('\n');
}

/**
 * Truncate long base64-like strings in debug output.
 * Matches runs of ≥60 base64 chars (A-Z a-z 0-9 + / =) and replaces with
 * first 20 chars … last 10 chars so the output stays readable.
 */
/** Compare two reasoning efforts, return the higher one. */
function _compareEffort(a, b) {
  return (EFFORT_RANK[a] || 0) >= (EFFORT_RANK[b] || 0) ? (a || EFFORT_MEDIUM) : (b || EFFORT_MEDIUM);
}

function _truncB64Debug(str) {
  return str.replace(/[A-Za-z0-9+/]{60,}={0,2}/g, m => `${m.slice(0, 20)}\u2026${m.slice(-10)}`);
}

// Short aliases for Anthropic models
const ANTHROPIC_ALIASES = {
  'sonnet':       'claude-sonnet-4-6',
  'sonnet-4':     'claude-sonnet-4-6',
  'opus':         'claude-opus-4-6',
  'opus-4':       'claude-opus-4-6',
  'haiku':        'claude-haiku-4-5-20251001',
  'haiku-4':      'claude-haiku-4-5-20251001',
};

export class LLMProvider {
  constructor(config = {}) {
    const envModelOverride = process.env.KOI_DEFAULT_MODEL;
    const envProviderOverride = process.env.KOI_DEFAULT_PROVIDER;
    if ((config.model === 'auto' || config.model == null) && envModelOverride && envModelOverride !== 'auto') {
      const inferredProvider = LLMProvider._inferProviderFromModel(envModelOverride);
      config = {
        ...config,
        model: envModelOverride,
        provider: envProviderOverride || inferredProvider || config.provider,
      };
    } else if ((config.provider === 'auto' || config.provider == null) && envProviderOverride && envProviderOverride !== 'auto') {
      // Provider override without model override: keep model as auto but lock the provider
      config = {
        ...config,
        provider: envProviderOverride,
      };
    }

    const _providerIsAuto = config.provider === 'auto';
    const _modelIsAuto    = config.model === 'auto';
    this._autoMode = _providerIsAuto || _modelIsAuto;
    // When provider is fixed but model is auto, selection is constrained to that provider only
    this._lockedProvider = (!_providerIsAuto && _modelIsAuto) ? config.provider : null;

    this.temperature = config.temperature ?? 0.1; // Low temperature for deterministic results
    this.maxTokens = config.max_tokens || 16000; // Fallback; per-model limit set in BaseLLM via caps.maxOutputTokens
    this._useThinking = false; // Set to true by auto-selector when thinking variant wins

    // ── braxil.ai account mode: route all LLM calls through the gateway ──────
    // The gateway is OpenAI-compatible and handles provider selection server-side.
    // No need to hardcode providers — they come dynamically from GET /gateway/models.
    // Production: https://api.braxil.ai/gateway  Local: http://localhost:3000/gateway
    if (process.env.KOI_AUTH_TOKEN && !process.env.KOI_OFFLINE_MODE) {
      const apiBase = process.env.KOI_API_URL || 'http://localhost:3000';
      const gatewayBase = apiBase + '/gateway';
      channel.log('llm', `[gateway] baseURL=${gatewayBase} (KOI_API_URL=${process.env.KOI_API_URL || '(not set)'})`);
      this._koiGatewayApiBase = apiBase;
      this._koiGateway = new OpenAI({
        apiKey: process.env.KOI_AUTH_TOKEN,
        baseURL: gatewayBase,
        maxRetries: 2, // Retry connection errors (concurrent agents can saturate the pool)
      });
      this._autoMode = true;
      this._gatewayMode = true;
      this.provider = 'auto';
      this.model = 'auto';
      this.openai = null;
      this.anthropic = null;
      // Models MUST be loaded before any LLM/embedding call can proceed.
      // _modelsReady is awaited in _ensureClients() — nothing runs until models are available.
      this._availableProviders = [];
      this._modelsReady = this.syncGatewayProviders().then(() => {
        this._modelsReady = null; // resolved — no need to await again
      });
      return;
    }

    // Auto mode: dynamically pick the best model per task
    if (this._autoMode) {
      this.provider = 'auto';
      this.model = 'auto';
      this.openai = null;
      this.anthropic = null;

      if (this._lockedProvider) {
        // provider fixed, model auto — only use clients for the locked provider
        // Client is created lazily if the key is missing (see _ensureClients).
        this._availableProviders = [this._lockedProvider];
        if (this._lockedProvider === 'openai' && process.env.OPENAI_API_KEY) {
          this._oa = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
        } else if (this._lockedProvider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
          this._ac = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        } else if (this._lockedProvider === 'gemini' && process.env.GEMINI_API_KEY) {
          this._gc = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', maxRetries: 0 });
        }
      } else {
        // both provider and model are auto — use all available providers.
        // If no keys are configured yet, _availableProviders stays empty and the
        // user will be prompted on first use (see _ensureClients).
        this._availableProviders = getAvailableProviders();
        if (process.env.OPENAI_API_KEY)    this._oa = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
        if (process.env.ANTHROPIC_API_KEY) this._ac = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        if (process.env.GEMINI_API_KEY)    this._gc = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', maxRetries: 0 });
      }
      return;
    }

    this.provider = config.provider || 'openai';

    // Resolve model: alias expansion + per-provider defaults
    let model = config.model;
    if (this.provider === 'anthropic' && model && ANTHROPIC_ALIASES[model]) {
      model = ANTHROPIC_ALIASES[model];
    }
    this.model = model || 'auto';

    // Initialize clients — deferred if key is missing (user will be prompted on first use).
    if (this.provider === 'openai') {
      if (process.env.OPENAI_API_KEY) this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
    } else if (this.provider === 'anthropic') {
      if (process.env.ANTHROPIC_API_KEY) this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } else if (this.provider === 'gemini') {
      if (process.env.GEMINI_API_KEY) {
        this.openai = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', maxRetries: 0 });
      }
    }
  }

  // =========================================================================
  // Gateway provider sync — fetch which providers the user has configured
  // =========================================================================

  /**
   * Fetch available providers from the braxil.ai gateway and update
   * _availableProviders accordingly. Called at startup and on 400 errors
   * (e.g. "key not configured") to re-sync.
   */
  async syncGatewayProviders() {
    if (!process.env.KOI_AUTH_TOKEN) return;

    // Load models from backend — this populates the auto-model-selector with
    // the actual active models. getAvailableProviders() then returns providers
    // dynamically from whatever the backend sent (no hardcoded list needed).
    // loadRemoteModels() falls back to local models.json if the backend is
    // unreachable or returns an HTTP error.
    await loadRemoteModels();
    const providers = getAvailableProviders();
    if (providers.length > 0) {
      this._availableProviders = providers;
      channel.log('llm', `[gateway] Available providers: ${providers.join(', ')}`);
    } else {
      // Should not happen (loadRemoteModels always falls back to models.json),
      // but use a hardcoded safety net just in case.
      this._availableProviders = ['openai', 'anthropic', 'gemini'];
      channel.log('llm', '[gateway] No providers found — using hardcoded fallback list');
    }
  }

  // =========================================================================
  // API KEY MANAGEMENT — lazy client initialization
  // =========================================================================

  /**
   * Ensure all required clients are ready before making any LLM call.
   * Prompts the user for missing API keys, saves them to .env, and creates clients.
   */
  async _ensureClients(agent) {
    // Block until models are loaded from backend (or local fallback).
    // This is the gate that prevents any LLM/embedding call from proceeding
    // before the model catalog is available.
    if (this._modelsReady) {
      await this._modelsReady;
    }
    if (this._autoMode) {
      if (this._lockedProvider) {
        await this._ensureLockedProviderClient(agent);
      } else {
        await this._ensureAnyProvider(agent);
      }
    } else {
      await this._ensureExplicitClient(agent);
    }
  }

  /**
   * Late initialization of credentials that appeared AFTER this provider
   * was constructed. In GUI mode the user may sign in via the welcome
   * dialog or paste API keys into Settings → Models long after the
   * engine has started — when that happens the WsProtocolServer sets
   * `process.env.KOI_AUTH_TOKEN` / `OPENAI_API_KEY` / etc., but the
   * LLMProvider instance held by the running agent still has empty
   * `_availableProviders` and no `_koiGateway`. This method upgrades
   * the instance on the fly so the very next LLM call succeeds.
   * Safe to call repeatedly — no-op when the state is already correct.
   */
  _maybeLateInitFromEnv() {
    // (a) Gateway upgrade: token appeared → route through braxil.ai
    if (!this._koiGateway && process.env.KOI_AUTH_TOKEN && !process.env.KOI_OFFLINE_MODE) {
      const apiBase = process.env.KOI_API_URL || 'http://localhost:3000';
      const gatewayBase = apiBase + '/gateway';
      channel.log('llm', `[gateway] late-init: baseURL=${gatewayBase}`);
      this._koiGatewayApiBase = apiBase;
      this._koiGateway = new OpenAI({
        apiKey: process.env.KOI_AUTH_TOKEN,
        baseURL: gatewayBase,
        maxRetries: 2,
      });
      this._autoMode = true;
      this._gatewayMode = true;
      this.provider = 'auto';
      this.model = 'auto';
      this.openai = null;
      this.anthropic = null;
      // Clear any direct-provider clients built earlier from local env keys.
      // Once signed in, ALL LLM traffic must go through the gateway so
      // credits/usage are accounted for — never mix gateway and direct.
      this._oa = null;
      this._ac = null;
      this._gc = null;
      this._availableProviders = [];
      this._modelsReady = this.syncGatewayProviders().then(() => {
        this._modelsReady = null;
      });
      return;
    }

    // (b) Local API keys appeared in env → build SDK clients for them
    if (!this._koiGateway) {
      if (process.env.OPENAI_API_KEY && !this._oa) {
        this._oa = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
        if (!this._availableProviders.includes('openai')) this._availableProviders.push('openai');
        channel.log('llm', `[llm] late-init: openai client built from env`);
      }
      if (process.env.ANTHROPIC_API_KEY && !this._ac) {
        this._ac = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        if (!this._availableProviders.includes('anthropic')) this._availableProviders.push('anthropic');
        channel.log('llm', `[llm] late-init: anthropic client built from env`);
      }
      if ((process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) && !this._gc) {
        this._gc = new OpenAI({
          apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
          baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
          maxRetries: 0,
        });
        if (!this._availableProviders.includes('gemini')) this._availableProviders.push('gemini');
        channel.log('llm', `[llm] late-init: gemini client built from env`);
      }
    }
  }

  /**
   * For auto mode with no locked provider: ensure at least one provider client exists.
   * If none are configured, let the user pick a provider and enter the key.
   *
   * In GUI mode (`KOI_GUI_MODE=1`), this method is a no-op. The GUI has
   * its own welcome dialog + Settings > Models tab for configuring keys;
   * printing "No API key configured. Select a provider" and running
   * `cliSelect` would leak terminal-era conversation bubbles into the
   * chat. If the runtime reaches this code in GUI mode without any
   * provider, the upstream LLM call will throw a clear "No provider
   * available" error instead, which the caller (quota flow, etc.)
   * can handle by redirecting the user to Settings.
   */
  async _ensureAnyProvider(agent) {
    // ── Late auth upgrade (GUI welcome flow) ─────────────────────────
    // The LLMProvider may have been constructed before the user signed
    // in / added API keys. If the env now contains credentials, pick
    // them up on the fly instead of throwing NO_PROVIDER.
    this._maybeLateInitFromEnv();
    // If late-init just flipped us into gateway mode it started loading
    // the model catalog asynchronously. Block on that before returning —
    // otherwise the very next LLM call fires with _availableProviders=[]
    // and factory.js throws NO_PROVIDERS, forcing a 10-20s retry cycle at
    // cold start.
    if (this._modelsReady) {
      await this._modelsReady;
    }
    if (this._availableProviders.length > 0) return;
    // Gateway mode: all providers are available via the braxil.ai backend
    if (this._koiGateway) return;
    // GUI mode: never prompt via CLI. Throw a structured error so the
    // main loop can catch it and surface a "configure your keys" prompt
    // instead of crashing downstream when the SDK client is null.
    if (process.env.KOI_GUI_MODE === '1') {
      const err = new Error('No LLM provider configured. Open Settings → Models and add an API key, or sign in with Braxil.');
      err.code = 'NO_PROVIDER';
      throw err;
    }

    const { channel: cliLogger } = await import('../io/channel.js');
    const cliSelect = (await import('../io/channel.js')).channel.select;
    const { ensureApiKey } = await import('../api/api-key-manager.js');

    channel.print('No API key configured. Select a provider to use:');
    const provider = await cliSelect('Select provider', [
      { title: 'OpenAI (GPT-4o, GPT-4o-mini…)', value: 'openai' },
      { title: 'Anthropic (Claude Sonnet, Haiku…)', value: 'anthropic' },
      { title: 'Google Gemini (Gemini Flash, Pro…)', value: 'gemini' },
    ]);

    if (!provider) throw new Error('No provider selected — cannot continue without an API key');

    const apiKey = await ensureApiKey(provider, agent);

    if (provider === 'openai') {
      this._oa = new OpenAI({ apiKey, maxRetries: 0 });
    } else if (provider === 'anthropic') {
      this._ac = new Anthropic({ apiKey });
    } else if (provider === 'gemini') {
      this._gc = new OpenAI({ apiKey, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', maxRetries: 0 });
    }

    this._availableProviders = [provider];
  }

  /**
   * For auto mode with a locked provider: ensure the client for that provider exists.
   */
  async _ensureLockedProviderClient(agent) {
    this._maybeLateInitFromEnv();
    if (this._koiGateway) return;
    const p = this._lockedProvider;
    const hasClient = (p === 'openai' && this._oa) ||
                      (p === 'anthropic' && this._ac) ||
                      (p === 'gemini' && this._gc);
    if (hasClient) return;
    // GUI mode: never prompt for keys via CLI. See _ensureAnyProvider.
    if (process.env.KOI_GUI_MODE === '1') {
      const err = new Error(`No ${p} API key configured. Open Settings → Models and add an API key, or sign in with Braxil.`);
      err.code = 'NO_PROVIDER';
      throw err;
    }

    const { ensureApiKey } = await import('../api/api-key-manager.js');
    const apiKey = await ensureApiKey(p, agent);

    if (p === 'openai') {
      this._oa = new OpenAI({ apiKey, maxRetries: 0 });
    } else if (p === 'anthropic') {
      this._ac = new Anthropic({ apiKey });
    } else if (p === 'gemini') {
      this._gc = new OpenAI({ apiKey, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', maxRetries: 0 });
    }
  }

  /**
   * For explicit (non-auto) provider: ensure the client exists.
   */
  async _ensureExplicitClient(agent) {
    this._maybeLateInitFromEnv();
    if (this._koiGateway) return;
    if (this.openai || this.anthropic) return;
    // GUI mode: never prompt for keys via CLI. See _ensureAnyProvider.
    if (process.env.KOI_GUI_MODE === '1') {
      const err = new Error(`No ${this.provider} API key configured. Open Settings → Models and add an API key, or sign in with Braxil.`);
      err.code = 'NO_PROVIDER';
      throw err;
    }

    const { ensureApiKey } = await import('../api/api-key-manager.js');
    const apiKey = await ensureApiKey(this.provider, agent);

    if (this.provider === 'openai') {
      this.openai = new OpenAI({ apiKey, maxRetries: 0 });
    } else if (this.provider === 'anthropic') {
      this.anthropic = new Anthropic({ apiKey });
    } else if (this.provider === 'gemini') {
      this.openai = new OpenAI({ apiKey, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', maxRetries: 0 });
    }
  }

  // =========================================================================
  // PROVIDER FACTORY HELPERS
  // =========================================================================

  /**
   * Get the SDK client for the current provider.
   * @param {string} [provider] - Override provider (defaults to this.provider)
   * @returns {Object} SDK client
   */
  /**
   * Resolve the best model for a given task via the factory.
   * @param {string} taskType - 'code' | 'reasoning' | 'speed'
   * @param {number} [difficulty=5] - 1-10
   * @returns {{ instance, provider, model, useThinking }}
   */
  _resolveModel(taskType, difficulty = 50, opts = {}) {
    const clients = this.getClients();
    return resolveModel({
      type: 'llm',
      taskType,
      difficulty,
      availableProviders: this._availableProviders || getAvailableProviders(),
      clients,
      ...opts,
    });
  }

  /**
   * Get the SDK clients map for use with the provider factory.
   * Used by media generation actions (image, video, audio) to resolve providers.
   * @returns {{ openai?, anthropic?, gemini? }}
   */
  getClients() {
    return this._gatewayMode
      ? this._gatewayClients()
      : { openai: this._oa, anthropic: this._ac, gemini: this._gc };
  }

  _getClient(provider) {
    const p = provider || this.provider;
    // Gateway mode: all providers route through the same OpenAI-compatible gateway
    if (this._gatewayMode) return this._koiGateway;
    if (p === 'openai')    return this._autoMode ? this._oa : this.openai;
    if (p === 'gemini')    return this._autoMode ? this._gc : this.openai;
    if (p === 'anthropic') return this._autoMode ? this._ac : this.anthropic;
    throw new Error(`No client for provider: ${p}`);
  }

  /**
   * Build a dynamic clients map for gateway mode.
   * Every provider uses the same gateway client — no hardcoded provider list needed.
   * Returns a Proxy so any provider name maps to the gateway client.
   */
  _gatewayClients() {
    const gw = this._koiGateway;
    return new Proxy({}, { get: () => gw });
  }

  /**
   * Create an LLM instance via the provider factory for the current model/provider.
   * @param {Object} [opts] - Override options (useThinking, temperature, etc.)
   * @returns {import('./providers/base.js').BaseLLM}
   */
  _createLLM(opts = {}) {
    // In gateway mode, _effectiveLLMProvider is 'openai' so we always create
    // OpenAIChatLLM, regardless of the original provider (gemini, anthropic, etc.)
    const llmProvider = this._effectiveLLMProvider || this.provider;
    return createLLM(llmProvider, this._getClient(llmProvider), this.model, {
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      useThinking: this._useThinking,
      reasoningScore: this._reasoningScore ?? 50,
      reasoningEffort: this._reasoningEffort ?? EFFORT_MEDIUM,
      ...opts,
    });
  }

  // ── Debug logging (delegated to debug-logger.js) ────────────────────────
  formatDebugText(text) { return formatDebugText(text); }
  logRequest(model, systemPrompt, userPrompt, context = '', cacheBoundary = 0) { logRequest(model, systemPrompt, userPrompt, context, cacheBoundary); }
  logResponse(content, context = '', usage = null) { logResponse(content, context, usage); }
  logDebug(message) { logDebug(message); }
  logError(message, error) { logError(message, error); }

  /**
   * Simple chat completion for build-time tasks (descriptions, summaries).
   * No system prompt injection, no JSON mode, with timeout.
   */
  async simpleChat(prompt, { timeoutMs = 15000 } = {}) {
    await this._ensureClients();

    // In auto mode, _effectiveLLMProvider is only set during chat() flow.
    // For simpleChat we need to resolve a concrete provider ourselves.
    if (this._autoMode && !this._effectiveLLMProvider) {
      const p = this._availableProviders?.[0];
      if (p) {
        this._effectiveLLMProvider = p;
        // Pick a sensible default model for build-time tasks (cheap & fast)
        if (p === 'openai')         this.model = 'gpt-4o-mini';
        else if (p === 'anthropic') this.model = 'claude-haiku-4-5-20251001';
        else if (p === 'gemini')    this.model = 'gemini-2.0-flash';
      }
    }

    const llm = this._createLLM();
    const { text } = await llm.complete(
      [{ role: 'user', content: prompt }],
      { temperature: 0.1, maxTokens: this.maxTokens || 150, timeoutMs }
    );
    return text;
  }

  /**
   * Call OpenAI with logging
   * @param {Object} options - { model, messages, temperature, max_tokens, stream, response_format }
   * @param {string} context - Context description for logging
   * @returns {Promise} - OpenAI completion response
   */
  async callOpenAI(options, context = '') {
    const { model, messages, temperature = 0, max_tokens = 4000, stream = false, response_format } = options;

    // Extract prompts for logging
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    const userPrompt = messages.find(m => m.role === 'user')?.content || '';

    // Log request
    this.logRequest(model, systemPrompt, userPrompt, context);

    // Make API call with buildApiParams to handle gpt-5.2
    const completion = await this.openai.chat.completions.create(
      this.buildApiParams({
        model,
        messages,
        temperature,
        max_tokens,
        stream,
        ...(response_format && { response_format })
      })
    );

    // If not streaming, log response immediately
    if (!stream) {
      const content = completion.choices[0].message.content;
      this.logResponse(content, context);
    }

    return completion;
  }

  /**
   * Strip unsupported params based on model capabilities.
   * Consults MODEL_DB flags: noTemperature, noMaxTokens.
   */
  buildApiParams(baseParams) {
    const caps = getModelCaps(baseParams.model);
    let params = { ...baseParams };
    if (caps.noTemperature) delete params.temperature;
    if (caps.noMaxTokens)   delete params.max_tokens;
    return params;
  }

  async executePlanning(prompt) {
    try {
      // Use factory to pick the best reasoning model for planning tasks
      const _plan = this._resolveModel('reasoning', 65, { temperature: 0, maxTokens: 800 });
      const llm = _plan.instance;

      const { text } = await llm.complete([
        { role: 'system', content: 'Planning assistant. JSON only.' },
        { role: 'user', content: prompt }
      ]);
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Planning failed: ${error.message}`);
    }
  }

  // (see module-level _compareEffort function below)

  // ── Task classification (delegated to task-classifier.js) ────────────────
  _classifier = null;
  _getClassifier() {
    if (!this._classifier) {
      this._classifier = new TaskClassifier({
        getClient: (p) => this._getClient(p),
        getAvailableProvidersFn: () => this._availableProviders || getAvailableProviders(),
        createLLMFn: createLLM,
        costCenter,
        logFn: (cat, msg) => channel.log(cat, msg),
        // Block classification until remote models are loaded (gateway mode).
        // Prevents the cold-start race where the first inbound message is
        // classified against an empty provider list.
        waitForReadyFn: () => this._modelsReady,
      });
    }
    return this._classifier;
  }
  async classifyUserRequest(userMessage, agentName) { return this._getClassifier().classifyUserRequest(userMessage, agentName); }
  async classifyTaskDifficulty(playbookText, args, agentName) { return this._getClassifier().classifyTaskDifficulty(playbookText, args, agentName); }

  /**
   * Lightweight JSON call: send a prompt, get parsed JSON back.
   * No system prompt injection, no streaming, no onAction.
   */
  async callJSON(prompt, agent = null, opts = {}) {
    await this._ensureClients();
    const agentName = agent?.name || '';
    if (!opts.silent) channel.planning(agentName ? `🤖 \x1b[1m\x1b[38;2;173;218;228m${agentName}\x1b[0m \x1b[38;2;185;185;185mThinking\x1b[0m` : 'Thinking');

    this.logRequest(this.model, 'Return ONLY valid JSON.', prompt, agentName ? `callJSON | Agent: ${agentName}` : 'callJSON');

    let response;
    try {
      const _resolved = this._resolveModel('speed', 10);
      const llm = _resolved.instance;
      const { text } = await llm.complete([
        { role: 'system', content: 'Return ONLY valid JSON. No markdown, no explanations.' },
        { role: 'user', content: prompt }
      ], { responseFormat: 'json_object' });
      response = text;

      if (!opts.silent) channel.clear();
      this.logResponse(response, 'callJSON');

      if (!response) return { result: '' };

      // Clean markdown code blocks if present
      let cleaned = response;
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^\`\`\`(?:json)?\n?/, '').replace(/\n?\`\`\`$/, '').trim();
      }

      return JSON.parse(cleaned);
    } catch (error) {
      if (!opts.silent) channel.clear();
      if (error instanceof SyntaxError) {
        return { result: response };
      }
      throw error;
    }
  }

  /**
   * Summarization LLM call: cheapest+fastest model (speed taskType, difficulty=1).
   * Tokens are recorded in costCenter so they appear in /cost reports.
   * Returns the raw text response (caller is responsible for JSON parsing).
   */
  async callSummary(system, user) {
    await this._ensureClients();
    // Estimate input tokens (~4 chars/token) → convert to contextK (thousands).
    // This ensures the auto-selector picks a model whose context window fits the input.
    const estimatedTokens = Math.ceil((system.length + user.length) / 4);
    const minContextK = Math.ceil(estimatedTokens / 1000) + 1; // +1K headroom for output
    const { instance: llm, provider, model } = resolveModel({
      type: 'llm', taskType: 'speed', difficulty: 1,
      availableProviders: this._availableProviders,
      clients: this._gatewayMode ? this._gatewayClients() : { openai: this._oa, anthropic: this._ac, gemini: this._gc },
      maxTokens: 1024, // Summaries are short — keep it fast and cheap
      minContextK,
    });

    const t0 = Date.now();
    const result = await llm.complete([
      { role: 'system', content: system },
      { role: 'user',   content: user }
    ]);

    costCenter.recordUsage(model, provider, result.usage.input, result.usage.output, Date.now() - t0);
    return result.text;
  }

  /**
   * Utility LLM call for lightweight background tasks (commit summaries, etc.).
   * Always selects the cheapest available model via resolveModel (difficulty=1).
   * Tokens are recorded in costCenter so they appear in /cost reports.
   */
  async callUtility(system, user, maxTokens = 150) {
    await this._ensureClients();
    const { instance: llm, provider, model } = resolveModel({
      type: 'llm', taskType: 'reasoning', difficulty: 1,
      availableProviders: this._availableProviders,
      clients: this._gatewayMode ? this._gatewayClients() : { openai: this._oa, anthropic: this._ac, gemini: this._gc },
      maxTokens,
    });

    const t0 = Date.now();
    const result = await llm.complete([
      { role: 'system', content: system },
      { role: 'user',   content: user }
    ]);

    costCenter.recordUsage(model, provider, result.usage.input, result.usage.output, Date.now() - t0);
    return result.text;
  }

  // =========================================================================
  // REACTIVE AGENTIC LOOP METHODS
  // =========================================================================

  /**
   * Execute one iteration of the reactive playbook loop.
   * The LLM returns ONE action per call, receives feedback, and adapts.
   *
   * @param {Object} params
   * @param {string} params.playbook - The playbook text
   * @param {Object} params.context - Context with args and state
   * @param {string} params.agentName - Agent name for logging
   * @param {PlaybookSession} params.session - Session tracking state
   * @param {Object} params.agent - Agent instance
   * @param {ContextMemory} params.contextMemory - Tiered memory manager
   * @returns {Object} A single action object
   */
  async executePlaybookReactive({ playbook, playbookResolver = null, context, agentName, session, agent, contextMemory, isFirstCall = false, thinkingHint = 'Thinking', isDelegate = false, abortSignal = null }) {
    // Ensure API keys / clients are ready (prompts user if missing)
    await this._ensureClients(agent);

    const planningPrefix = agentName ? `🤖 \x1b[1m\x1b[38;2;173;218;228m${agentName}\x1b[0m` : '';

    // For non-auto mode the model is fixed — show it right away (before LLM call)
    if (!this._autoMode) channel.setInfo('model', this.model);

    const _hint = thinkingHint || 'Thinking';
    channel.planning(planningPrefix ? `${planningPrefix} \x1b[38;2;185;185;185m${_hint}\x1b[0m` : _hint);
    channel.log('llm', `Reactive call: ${agentName} (iteration ${session.iteration + 1}, firstCall=${isFirstCall})`);

    // Age memories each iteration (fire-and-forget — don't block the agent)
    contextMemory.tick().catch(() => {});

    // Rebuild the system prompt when:
    // - First call or no history yet (fresh/resumed session), OR
    // - A playbookResolver exists — meaning the playbook contains dynamic compose blocks
    //   that depend on runtime state (task list, registry, etc.) and must be re-evaluated
    //   on every LLM call so the system prompt is never stale.
    // Capture the user message for classification BEFORE the reset inside the if block.
    const _savedUserMessage = agent?._lastUserMessage || null;

    if (isFirstCall || !contextMemory.hasHistory() || playbookResolver) {
      const freshPlaybook = playbookResolver ? await playbookResolver() : playbook;
      const systemPromptResult = await this._buildReactiveSystemPrompt(agent, freshPlaybook);
      // DEBUG: detect [object Object] contamination
      if (process.env.KOI_DEBUG_LLM) {
        const _dbgStr = typeof systemPromptResult === 'string' ? systemPromptResult
          : typeof systemPromptResult === 'object' ? (systemPromptResult.static + '\n' + systemPromptResult.dynamic) : '';
        if (_dbgStr.includes('[object Object]')) {
          console.error('[DEBUG] [object Object] detected in system prompt!');
          console.error('[DEBUG] freshPlaybook type:', typeof freshPlaybook, freshPlaybook?._cacheKey);
          console.error('[DEBUG] systemPromptResult type:', typeof systemPromptResult, systemPromptResult?._cacheKey);
          if (typeof freshPlaybook === 'object') {
            console.error('[DEBUG] freshPlaybook.static contains [oO]:', String(freshPlaybook.static || '').includes('[object Object]'));
            console.error('[DEBUG] freshPlaybook.dynamic contains [oO]:', String(freshPlaybook.dynamic || '').includes('[object Object]'));
          }
        }
      }
      // Inject active skill contents into the static part of the prompt.
      // Skills are stable once activated — they belong in the cached prefix.
      // Content is stored in agent.state._skillContents (per-invocation, not serialized to user prompt).
      const _skillContents = agent.state?._skillContents;
      const _skillBlock = _skillContents && Object.keys(_skillContents).length > 0
        ? '\n\n# Active Skill Instructions\n\n' + Object.entries(_skillContents).map(
            ([name, content]) => `## Skill: ${name}\n\n${content}`
          ).join('\n\n---\n\n')
        : '';

      // Structured cache-aware prompt: store boundary for cache_control injection
      if (typeof systemPromptResult === 'object' && systemPromptResult?._cacheKey !== undefined) {
        const staticWithSkills = systemPromptResult.static + _skillBlock;
        const fullPrompt = staticWithSkills + '\n\n' + systemPromptResult.dynamic;
        contextMemory.setSystem(fullPrompt);
        session._promptCacheBoundary = staticWithSkills.length;
        session._promptCacheKey = systemPromptResult._cacheKey;
      } else {
        // Safety: ensure we always pass a string to setSystem
        const _sysStr = typeof systemPromptResult === 'string' ? systemPromptResult
          : typeof systemPromptResult === 'object' && systemPromptResult?.static
            ? [systemPromptResult.static, systemPromptResult.dynamic].filter(Boolean).join('\n\n')
            : String(systemPromptResult || '');
        contextMemory.setSystem(_sysStr + _skillBlock);
        session._promptCacheBoundary = 0;
        session._promptCacheKey = null;
      }
      // Reset userMessage after compose resolver has consumed it —
      // it should only be non-null on the turn the user actually typed something.
      agent._lastUserMessage = null;
      // If the compose resolver produced images (e.g. mobile screenshot),
      // inject them into the session's pending image queue for the next LLM call.
      // REPLACE (not accumulate) — compose images are always a fresh capture and
      // should not stack with stale action-result images from previous iterations.
      if (playbookResolver?._pendingImages?.length > 0) {
        session._pendingMcpImages = [...playbookResolver._pendingImages];
        playbookResolver._pendingImages = null;
      }
    }


    // Decide what message to add based on how many actions have been executed.
    // Use session.iteration (action count) rather than contextMemory.hasHistory() so
    // that the fast-greeting path (which skips the first LLM call but executes
    // print + prompt_user) is treated as "subsequent" rather than "fresh start".
    if (session.iteration === 0) {
      // No actions executed yet — fresh start, resumed session, task resumption, or ask_parent re-invocation.

      // ask_parent is now handled inline in the reactive loop (agent.js) — no re-invocation.
      // The answer is injected into contextMemory directly without restarting the session.
      if (session._resumingTasks) {
        // User confirmed they want to continue the pending task plan.
        // Build the task list inline so the model sees it immediately without
        // needing to call task_list first (codex tends to explore/ask otherwise).
        let taskListStr = '';
        try {
          const { taskManager } = await import('../state/task-manager.js');
          const allTasks = taskManager.list();
          const pending = allTasks.filter(t => t.status !== 'completed');
          if (pending.length > 0) {
            taskListStr = '\n\nPending tasks:\n' + pending.map(t => {
              const icon = t.status === 'in_progress' ? '●' : '☐';
              const desc = t.description ? ` — ${t.description}` : '';
              return `  [${t.id}] ${icon} ${t.subject}${desc}`;
            }).join('\n');
          }
        } catch { /* non-fatal — fall back to generic instruction */ }

        contextMemory.add(
          'user',
          `The user confirmed: resume the previous task plan.${taskListStr}\n\nExecute these tasks now, in order, starting with the first in_progress or pending one. Do NOT ask the user any questions. Do NOT explore files or run any commands before starting. Execute the first task immediately.`,
          'Resume tasks.',
          null
        );
      } else if (contextMemory.hasHistory() && !isDelegate && !session._isContinuation) {
        // Session resumed from disk (--resume): tell the LLM to wait for user input.
        // Delegates are excluded — their prior context is valid working history.
        // Continuations (feedback-triggered restarts) are excluded — they should
        // pick up where they left off, not reset.
        // ephemeral: true → not persisted to conversation file, so it doesn't
        // accumulate across multiple resume cycles.
        contextMemory.add(
          'user',
          `SESSION RESUMED. The conversation history above is from a previous session.

Your ONLY next action is: { "intent": "prompt_user" } — ask the user what they need.

CRITICAL RULES:
- Do NOT repeat, summarize, or reference anything from the conversation history above.
- Do NOT re-state your last response. The user already saw it.
- Do NOT automatically continue or restart any previous task.
- Keep your greeting SHORT (one sentence max). Just ask what they need.`,
          'Session resumed.',
          null,
          { ephemeral: true }
        );
      } else {
        // Include MCP connection errors so the LLM can diagnose
        let mcpErrorStr = '';
        if (session.mcpErrors && Object.keys(session.mcpErrors).length > 0) {
          const errors = Object.entries(session.mcpErrors)
            .map(([name, cause]) => `- MCP "${name}" server output:\n${cause}`)
            .join('\n');
          mcpErrorStr = `\n\n⚠️ MCP SERVER ERRORS — The following MCP servers crashed on startup. Do NOT call them.\nAnalyze the server output below, identify the root cause, and use "print" to tell the user:\n1. What went wrong (the specific error, not the raw output)\n2. How to fix it (e.g. "run npm install in /path/to/project")\nThen "return" with an error.\n\n${errors}`;
        }

        // For delegate invocations: expose task data clearly so the agent knows exactly
        // what to do. Format ALL args fields — don't require rigid field names, since
        // the parent agent may structure data in any way.
        // For the main agent: fall back to the raw JSON context blob.
        let contextStr = '';
        const _args = context.args;
        const _hasTaskSpec = isDelegate && _args && typeof _args === 'object' && Object.keys(_args).length > 0;
        if (_hasTaskSpec) {
          const _specLines = Object.entries(_args)
            .filter(([, v]) => v != null && v !== '')
            .map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join('\n');
          // If attachments were provided (images, files, etc.), tell the delegate.
          // List ALL registered attachment IDs so the agent can access them via read_file("att-N").
          const _imgCount = session._pendingMcpImages?.length || 0;
          let _imageNote = '';
          let _attNote = '';
          try {
            const { attachmentRegistry: _ar } = await import('../state/attachment-registry.js');
            const _allAtts = _ar.all();
            if (_allAtts.length > 0) {
              const _images = _allAtts.filter(a => a.mimeType?.startsWith('image/'));
              const _files = _allAtts.filter(a => !a.mimeType?.startsWith('image/'));
              if (_images.length > 0) {
                _imageNote = `\n\n🖼️ ${_images.length === 1 ? 'IMAGE' : _images.length + ' IMAGES'} ATTACHED: Examine ${_images.length === 1 ? 'it' : 'them'} carefully.\nImage IDs: ${_images.map(a => `${a.id} (${a.fileName})`).join(', ')}. Use read_file("att-N") to re-read.`;
              }
              if (_files.length > 0) {
                _attNote = `\n\n📎 ${_files.length === 1 ? 'FILE' : _files.length + ' FILES'} ATTACHED: The user included ${_files.length === 1 ? 'a file' : _files.length + ' files'} with their request.\nFile IDs: ${_files.map(a => `${a.id} (${a.fileName}${a.mimeType ? ', ' + a.mimeType : ''})`).join(', ')}. Use read_file("${_files[0]?.id}") to read. The file path is also available: ${_files.map(a => `${a.id} → ${a.path}`).join(', ')}.`;
              }
            }
          } catch { /* ignore */ }
          contextStr = `\n\n📋 YOUR TASK SPEC:\n${_specLines}${_imageNote}${_attNote}\n\nIf anything is unclear or you need additional context, check shared knowledge first (recall_facts). If you still can't find what you need, use ask_parent. Otherwise, start implementing now.`;
        }
        // NOTE: we intentionally no longer serialize `context` for non-delegate
        // agents. For the root agent (System) the context is just ephemeral
        // runtime state (args:{}, state:{statusPhase,userLanguage}) — dumping
        // it into the starter message as a JSON blob AND then pinning it to
        // long-term memory was polluting the Memory Inspector with entries
        // like: `Context: {"args":{},"state":{"statusPhase":"understanding",
        // "userLanguage":"Spanish"}}`. The runtime phase / language already
        // reach the LLM via the system prompt's dynamic block, so there is
        // nothing to lose by dropping it here.

        // Playbook is now in the system prompt; first user message just starts execution.
        const startMsg = `Return your FIRST action.${contextStr}${mcpErrorStr}`;
        if (_hasTaskSpec) {
          // Delegate task spec: pin to long-term so the agent never forgets
          // what it was asked to do. permanent must be non-null since
          // long-term entries render via entry.permanent in toMessages().
          const permSpec = contextStr.substring(0, 4000);
          contextMemory.add('user', startMsg, permSpec, permSpec, { directLongTerm: true });
        } else {
          // Non-delegate starter message: keep it in normal working memory,
          // let it age out naturally with the rest of the turn history.
          contextMemory.add('user', startMsg, startMsg, null);
        }
      }
    } else {
      // Actions have been executed — feed ALL new results as feedback (not just the last).
      // This ensures that when a batch contains multiple prompt_user calls, every
      // question/answer pair is visible to the LLM, not only the final one.
      //
      // `_llm_error` entries are internal bookkeeping for consecutive-failure
      // detection and must NEVER reach the LLM: feeding "the previous call
      // failed with 400" + "Continue." back as a user turn pollutes context
      // and primes the next retry with noise instead of the real task.
      // playbook-session.js already filters these from the prompt's
      // "Recent Actions" block; do the same here at the feedback pump.
      const fromIdx = session._lastFeedbackIdx ?? 0;
      const newEntries = session.actionHistory
        .slice(fromIdx)
        .filter(e => (e.action?.intent || e.action?.type) !== '_llm_error');
      session._lastFeedbackIdx = session.actionHistory.length;

      if (newEntries.length > 0) {
        // Scan ALL new entries for prompt_user with attachments/images — not just the last one.
        // When the LLM returns a batch like [prompt_user, update_state], the last entry is
        // update_state but the images are on the prompt_user result.
        let commitContext = '';
        for (const entry of newEntries) {
          if (entry.error) continue;
          const _intent = entry.action.intent || entry.action.type;
          if (_intent === 'prompt_user' && entry.result?.answer != null) {
            const _answerText = typeof entry.result.answer === 'string'
              ? entry.result.answer
              : (entry.result.answer?.text ?? '');
            if (_answerText) {
              commitContext = await this._searchRelevantCommits(_answerText);
              await contextMemory.hydrate(_answerText);
            }
            // Capture attachments from the user prompt — they'll be passed
            // directly to contextMemory.add() and resolved when building messages
            const _atts = Array.isArray(entry.result.attachments)
              ? entry.result.attachments.filter(a => a.path && fs.existsSync(a.path))
              : [];
            if (_atts.length > 0) {
              session._promptAttachments = _atts;
            }
          }
        }

        // Add intermediate entries (all except last) as plain messages without "Continue."
        for (let i = 0; i < newEntries.length - 1; i++) {
          const entry = newEntries[i];
          const classified = classifyFeedback(entry.action, entry.result, entry.error);
          if (classified) {
            contextMemory.add('user', classified.immediate, classified.shortTerm, classified.permanent, classified);
          }
        }

        // Process the last entry with full handling (commit context, images, "Continue.")
        const lastEntry = newEntries[newEntries.length - 1];
        const classified = classifyFeedback(lastEntry.action, lastEntry.result, lastEntry.error);

        if (classified) {
          // Build the immediate content (full detail + commit context + continue)
          // Include attachment references in context memory so agents can re-reference them
          // Build text references for attached files
          const _promptAtts = session._promptAttachments || [];
          const _imgPaths = _promptAtts.filter(a => a.type === 'image').map(a => a.path);
          const _imgRef = _imgPaths.length > 0
            ? `\n[Attached images: ${_imgPaths.map(p => `"${p}"`).join(', ')}]`
            : '';
          const _imgShort = _imgPaths.length > 0
            ? ` [images: ${_imgPaths.map(p => p.split('/').pop()).join(', ')}]`
            : '';
          // "Continue." signals the LLM to keep working. Skip it for
          // terminal/display actions that don't need a follow-up:
          //   - prompt_user: user's actual words
          //   - print: display-only, no follow-up needed
          //   - return: task is done
          // Without this, print results get fed back to the LLM as a
          // "user" message with Continue., causing a redundant second call.
          const _lastIntent = lastEntry.action?.intent || lastEntry.action?.type || '';
          const _terminalIntents = new Set(['prompt_user', 'print', 'return']);
          const _continueTag = _terminalIntents.has(_lastIntent) ? '' : '\nContinue.';
          const immediate = `${classified.immediate}${_imgRef}${commitContext}${_continueTag}`;
          const _shortWithImg = _imgShort
            ? `${classified.shortTerm || ''}${_imgShort}`
            : classified.shortTerm;
          // Pass attachments as part of the message — they are resolved when building LLM request
          contextMemory.add('user', immediate, _shortWithImg, classified.permanent, {
            ...classified,
            attachments: _promptAtts,
          });
          // Remember that this call had image attachments — used later by model selector
          // to ensure a vision-capable model is chosen. Must be set BEFORE clearing
          // _promptAttachments, since the classifier runs after this block.
          if (_promptAtts.some(a => a.type === 'image')) {
            session._hasImageAttachments = true;
          }
          // Same idea for non-image attachments — flag the session so the
          // model selector requires a model that can natively consume the
          // bytes. Today most read paths transcode (video → frames, pdf →
          // text+images) so these flags rarely fire; they exist so that as
          // soon as we start sending raw video/audio/file bytes through,
          // routing already gates on input_video / input_audio / input_file.
          if (_promptAtts.some(a => a.type === 'video')) session._hasVideoAttachments = true;
          if (_promptAtts.some(a => a.type === 'audio')) session._hasAudioAttachments = true;
          if (_promptAtts.some(a => a.type === 'file' || a.type === 'document' || a.type === 'pdf')) session._hasFileAttachments = true;
          session._promptAttachments = null;

          // Queue MCP image results for multimodal injection into the next LLM call.
          // Skip if the compose resolver already injected images (e.g. frame_server_state
          // screenshot) — those are always fresher than action-result images from the
          // previous iteration, and stacking both causes duplicate images.
          if (classified.imageBlocks?.length > 0 && !session._pendingMcpImages?.length) {
            session._pendingMcpImages = [];

            if (process.env.KOI_DEBUG_LLM) {
              const tool = lastEntry.action.tool || 'mcp';
              classified.imageBlocks.forEach((block, i) => {
                const ext = (block.mimeType || 'image/png').split('/')[1] || 'png';
                const tmpFile = path.join(os.tmpdir(), `koi-${tool}-${Date.now()}-${i}.${ext}`);
                fs.writeFileSync(tmpFile, Buffer.from(block.data, 'base64'));
                console.error(`[MCP Image] ${tool} → ${tmpFile}`);
                block._debugPath = tmpFile; // used at send-time for attachment log
              });
            }

            session._pendingMcpImages.push(...classified.imageBlocks);
          }
        } else {
          session._promptAttachments = null;
        }
      }
    }

    // Check abort before making the call
    if (abortSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Resolve auto model.
    // Re-classify only on first call or when returning from a delegation — not every iteration.
    // NOTE: We intentionally do NOT save/restore this.provider/model/openai/anthropic
    // around auto-resolution. In auto mode, each executePlaybookReactive call re-resolves
    // provider/model at the start (line ~942). Restoring would cause a race condition when
    // two delegates share the same LLMProvider in parallel: the first to finish would
    // restore this.provider='auto', corrupting the state for the second mid-stream.
    if (this._autoMode) {
      // Ensure remote models are loaded (gateway mode or dev mode with local backend)
      await loadRemoteModels();

      const _lastAction = session.actionHistory.at(-1);
      const _isDelegateReturn = _lastAction?.action?.actionType === 'delegate';
      // Reclassify when the user sent a new message — flag is set by prompt_user action in agent.js
      const _isNewUserMessage = !!session._needsReclassify;
      if (_isNewUserMessage) session._needsReclassify = false;
      channel.log('llm', `[classify] Reclassify check: needsReclassify=${_isNewUserMessage}, hasProfile=${!!session._autoProfile}, isFirstCall=${isFirstCall}, isDelegateReturn=${_isDelegateReturn}`);
      // reclassify_complexity is disabled (hidden). Keep the variable for
      // compatibility but never trigger agent-requested reclassification.
      const _agentRequestedReclassify = false;
      // Detect loops: same action repeated 3+ times → model is too weak, reclassify with escalation context
      const _recentActions = (session.actionHistory || []).slice(-3);
      const _isLoop = _recentActions.length >= 3 && _recentActions.every(e => e.action?.intent === _recentActions[0]?.action?.intent);
      // Always reclassify: on first call, new user message, delegate return, agent request, or loop.
      const _shouldReclassify = !session._autoProfile || isFirstCall || _isDelegateReturn || _isNewUserMessage || _agentRequestedReclassify || _isLoop;

      if (_shouldReclassify) {
        // Coordinators just route tasks to delegates — they never need
        // expensive models regardless of task complexity. Skip the
        // classifier entirely and use a fixed fast profile. The
        // delegate agents that actually do the work will get their
        // own classification when they start.
        // Build classification context — try every source of context, never give up.
        // Two classifier paths:
        // 1. User message → interaction classifier (clean message, isUserMessage=true)
        // 2. Task/delegation → task classifier (full args, isUserMessage=false)
        let _classifyArgs = context?.args && Object.keys(context.args).length > 0 ? context.args : null;
        let _isInteraction = false;

        // When the user just sent a message, use the interaction classifier with the clean message.
        // Use _savedUserMessage (captured before the reset at line ~680) since agent._lastUserMessage
        // is already null at this point.
        if (_isNewUserMessage && _savedUserMessage) {
          _classifyArgs = { userRequest: _savedUserMessage };
          _isInteraction = true;
          channel.log('llm', `[classify] Using interaction classifier for user message: "${_savedUserMessage.substring(0, 50)}"`);
        }

        // Loop/agent-reclassify force task classifier — but NOT when the user just sent
        // a new message. A new user message resets the context: classify the user's intent,
        // not the stale loop from before. The loop errors are history at that point.
        if (_isLoop && !_isNewUserMessage) {
          const _loopAction = _recentActions[0]?.action?.intent || 'unknown';
          const _loopCount = _recentActions.length;
          _classifyArgs = { ..._classifyArgs, escalationReason: `Agent stuck in loop: repeated "${_loopAction}" ${_loopCount} times. Current model is too weak — score higher.` };
          _isInteraction = false;
          channel.log('llm', `[classify] Loop detected: ${_loopAction} ×${_loopCount} — reclassifying`);
        }
        if (_agentRequestedReclassify) {
          const _reason = _lastAction?.result?.reason || _lastAction?.action?.reason || '';
          const _recentActions = (session.actionHistory || []).slice(-5).map(e => {
            const intent = e.action?.intent || '';
            const error = e.error?.message || (e.result?.success === false ? e.result.error : '');
            return error ? `${intent} FAILED: ${error.substring(0, 80)}` : intent;
          }).join(', ');
          _classifyArgs = { ..._classifyArgs, escalationReason: _reason, recentActions: _recentActions };
          _isInteraction = false;
          channel.log('llm', `[classify] Agent requested reclassify: ${_reason}`);
        }

        // ── Dispatch to the appropriate classifier ───────────────────────
        if (_isInteraction && _savedUserMessage) {
          // User just sent a message → interaction classifier (clean message, speed-oriented)
          session._autoProfile = await this.classifyUserRequest(_savedUserMessage, agentName);
          // ── Language detection side-effect ─────────────────────────────
          // The interaction classifier ALSO returns `userLanguage` as part
          // of the same LLM call (see task-classifier.js). Writing it to
          // the agent's state here means every user message refreshes the
          // active language — no extra LLM call needed, and it works both
          // for the inbox classifier path AND the fast prompt_user path.
          const _lang = session._autoProfile?.userLanguage;
          if (_lang && agent?.state) {
            const _prev = agent.state.userLanguage || null;
            if (_lang !== _prev) {
              agent.state.userLanguage = _lang;
              // Keep the global mirror in sync for legacy readers
              // (system-prompt-builder.js, compose templates, etc.).
              globalThis.__koiUserLanguage = _lang;
              channel.log('llm', `[classify] agent.userLanguage ${_prev || '(none)'} → ${_lang}`);
            }
          }
        } else {
          // Task/delegation path — build args for the task classifier.
          // Enrich with recent discovery context (files read, errors found) so the
          // classifier can gauge real complexity after the agent has explored the codebase.
          if (_classifyArgs && session.actionHistory?.length > 0) {
            const _recentResults = session.actionHistory.slice(-5).map(e => {
              const intent = e.action?.intent || '';
              const resultStr = typeof e.result === 'string' ? e.result.substring(0, 200)
                : (e.result?.content?.substring?.(0, 200) || e.result?.description?.substring?.(0, 200) || '');
              return resultStr ? `${intent}: ${resultStr}` : intent;
            }).filter(Boolean).join('\n');
            if (_recentResults) {
              _classifyArgs = { ..._classifyArgs, recentDiscovery: _recentResults };
            }
          }
          if (!_classifyArgs && _savedUserMessage) {
            _classifyArgs = { userRequest: _savedUserMessage };
          }
          if (!_classifyArgs) {
            try {
              const { taskManager: _tm } = await import('../state/task-manager.js');
              const _pending = _tm.list().filter(t => t.status === 'pending' || t.status === 'in_progress');
              if (_pending.length > 0) {
                _classifyArgs = { pendingTasks: _pending.map(t => t.subject).join('; ') };
              }
            } catch {}
          }
          if (!_classifyArgs && agent?.description) {
            _classifyArgs = { agentRole: agent.description.substring(0, 500) };
          }
          if (_classifyArgs) {
            session._autoProfile = await this.classifyTaskDifficulty(agent?.description, _classifyArgs, agentName);
          }
        }
        // Only fall back to DEFAULT if we truly have zero context AND the LLM call failed
        if (!session._autoProfile) {
          session._autoProfile = DEFAULT_TASK_PROFILE;
          channel.log('llm', `[classify] No context available — fallback default profile`);
        }
      }
      let profile = session._autoProfile;

      // ── Apply declared phase profile overrides ───────────────────────
      // The agent's .koi file may declare per-phase model requirements:
      //   phases { understanding { reasoning: none } planning { reasoning: low } }
      // Values other than "auto" REPLACE the classifier's decision — they
      // are an explicit cap. A coordinator with `reasoning: none` should
      // use a cheap model regardless of how complex the user's request is;
      // the complexity only matters for the delegate agents that actually
      // do the work.
      const _phaseProfile = session._phaseProfile;
      if (_phaseProfile && Object.keys(_phaseProfile).length > 0) {
        const _levelToScore = { none: 0, low: 30, medium: 60, high: 90 };
        const _levelToEffort = { none: EFFORT_NONE, low: EFFORT_LOW, medium: EFFORT_MEDIUM, high: EFFORT_HIGH };
        let _changed = false;
        const _newProfile = { ...profile };

        if (_phaseProfile.reasoning && _phaseProfile.reasoning !== 'auto') {
          const score = _levelToScore[_phaseProfile.reasoning];
          if (score !== undefined) {
            _newProfile.reasoning = score;
            _newProfile.reasoningEffort = _levelToEffort[_phaseProfile.reasoning];
            // Thinking is only justified for medium+ effort. If the
            // phase caps reasoning at none/low, disable thinking even
            // if the classifier originally enabled it.
            _newProfile.thinking = _phaseProfile.reasoning !== EFFORT_NONE && _phaseProfile.reasoning !== EFFORT_LOW ? _newProfile.thinking : false;
            _changed = true;
          }
        }
        if (_phaseProfile.code && _phaseProfile.code !== 'auto') {
          const score = _levelToScore[_phaseProfile.code];
          if (score !== undefined) {
            _newProfile.code = score;
            _changed = true;
          }
        }
        if (_changed) {
          _newProfile.difficulty = Math.max(_newProfile.code || 0, _newProfile.reasoning || 0);
          channel.log('llm', `[classify] Phase profile override: code=${_newProfile.code} reasoning=${_newProfile.reasoning} effort=${_newProfile.reasoningEffort}`);
          profile = _newProfile;
        }
      }

      // Escalate model on repeated LLM errors (truncated JSON, parse failures, etc.)
      // The classifier may keep returning the same category, so we force-bump scores
      // to break out of the "weak model → truncated → reclassify → same model" loop.
      // BUT skip escalation when the recent errors are network/gateway failures —
      // those have nothing to do with model capability and pushing to a bigger
      // model just wastes credits on a request that will also fail.
      if (_isLoop && _recentActions.length >= 3 && _recentActions.every(e => e.action?.intent === '_llm_error')) {
        const { isNetworkError } = await import('./is-network-error.js');
        const _allNetErrs = _recentActions.every(e => isNetworkError(e.error));
        if (_allNetErrs) {
          channel.log('llm', `[classify] LLM error escalation skipped — all recent errors are network/transient (no model bump)`);
        } else {
          const _bump = Math.min(30, _recentActions.length * 10); // 30 for 3 errors, capped
          profile = {
            ...profile,
            code: Math.min(100, (profile.code || 50) + _bump),
            reasoning: Math.min(100, (profile.reasoning || 50) + _bump),
            difficulty: Math.min(100, (profile.difficulty || 50) + _bump),
          };
          session._autoProfile = profile;
          channel.log('llm', `[classify] LLM error escalation: bumped scores by +${_bump} → code:${profile.code}, reasoning:${profile.reasoning}`);
        }
      }

      // Require a vision-capable model if images are pending (user attachments or MCP screenshots)
      const _requiresImage = !!(session._hasImageAttachments) ||
        !!(session._promptAttachments?.some(a => a.type === 'image')) ||
        !!(session._pendingMcpImages?.length > 0) ||
        session.actionHistory.some(
          e => e.action?.intent === 'prompt_user' &&
               Array.isArray(e.result?.attachments) &&
               e.result.attachments.some(a => a.type === 'image')
        );

      // Same hard-filter logic for video / audio / non-image-file inputs.
      // The runtime currently transcodes most non-image media before the
      // bytes ever reach the LLM, so these typically stay false. They turn
      // true only when a tool (e.g. read_file on a video, or a future
      // raw-bytes pass-through) explicitly flags the session.
      const _hasFileTypeAtt = (t) => !!(session._promptAttachments?.some(a => a.type === t)) ||
        session.actionHistory.some(
          e => e.action?.intent === 'prompt_user' &&
               Array.isArray(e.result?.attachments) &&
               e.result.attachments.some(a => a.type === t)
        );
      const _requiresVideo = !!session._hasVideoAttachments || _hasFileTypeAtt('video');
      const _requiresAudio = !!session._hasAudioAttachments || _hasFileTypeAtt('audio');
      const _requiresFile  = !!session._hasFileAttachments  || _hasFileTypeAtt('file') || _hasFileTypeAtt('document') || _hasFileTypeAtt('pdf');

      // When images are attached, enforce minimum difficulty so we get a model
      // that can actually understand images. Coordinators also need vision to
      // look at images before deciding who to delegate to.
      if (_requiresImage) {
        // Detect graphical annotations (user-drawn marks on top of an image
        // or per-frame video composites). These demand fine-grained spatial
        // reasoning — locating specific marks, reading short text labels in
        // any language, disambiguating between similar adjacent subjects —
        // which cheap-tier vision models (m-lite, mini, flash) consistently
        // get wrong. Force a much higher floor so the auto-selector picks a
        // top-tier model (Claude Opus / Sonnet, Gemini Pro, GPT-5) that has
        // the visual-reasoning headroom for this task. Triggers on the
        // explicit role tags we set when queueing annotation composites in
        // read-file.js — pure user attachments or MCP screenshots are NOT
        // affected by this stricter floor.
        const _hasGraphicalAnnotations = !!session._pendingMcpImages?.some(
          (img) => img && (
            img.role === 'annotation_overlay' ||
            img.role === 'video_frame_annotation'
          )
        );

        const _minVisionDifficulty = _hasGraphicalAnnotations ? 85 : 55;
        if (profile.difficulty < _minVisionDifficulty || profile.code < _minVisionDifficulty) {
          profile = {
            ...profile,
            code: Math.max(profile.code || 0, _minVisionDifficulty),
            reasoning: Math.max(profile.reasoning || 0, _minVisionDifficulty),
            difficulty: Math.max(profile.difficulty || 0, _minVisionDifficulty),
            // Keep effort high too — visual disambiguation benefits from a
            // longer think on the part of reasoning models. EFFORT_HIGH lets
            // models like Claude Opus / GPT-5 spend extra tokens in their
            // hidden reasoning before returning the answer.
            ...(_hasGraphicalAnnotations ? { reasoningEffort: 'high' } : {}),
          };
          channel.log(
            'llm',
            _hasGraphicalAnnotations
              ? `[auto] Graphical annotations (${session._pendingMcpImages.filter(i => i?.role === 'annotation_overlay' || i?.role === 'video_frame_annotation').length} composite(s)) detected — boosted to min difficulty ${_minVisionDifficulty} + effort=high (annotations need precise spatial vision)`
              : `[auto] Images detected — boosted to min difficulty ${_minVisionDifficulty} for vision quality`,
          );
        } else {
          channel.log(
            'llm',
            _hasGraphicalAnnotations
              ? `[auto] Graphical annotations detected — already meeting min difficulty ${_minVisionDifficulty}; requiring vision-capable model`
              : `[auto] Images detected — requiring vision-capable model (inputImage:true)`,
          );
        }
      }

      // Estimate input size from contextMemory so the selector can skip
      // models whose context window won't fit the payload. Without this,
      // a ballooned shell output (e.g. grep into node_modules) can be
      // routed to a 1M-token model that still rejects with 413.
      let _minContextK = 0;
      try {
        const _preMessages = contextMemory.toMessages({ agent });
        const _preChars = _preMessages.reduce((sum, m) => {
          const c = m.content;
          if (typeof c === 'string') return sum + c.length;
          if (Array.isArray(c)) return sum + c.reduce((s, p) => s + (p.text || '').length, 0);
          return sum;
        }, 0);
        const _preTokens = Math.ceil(_preChars / 4);
        _minContextK = Math.ceil(_preTokens / 1000) + 4; // +4K headroom for output
        channel.log('llm', `[auto] Input estimate: ~${_preTokens} tokens → requiring contextK ≥ ${_minContextK}`);
      } catch { /* best-effort; fall back to no minimum */ }

      // Delegate all model selection + difficulty boost logic to the provider factory
      const resolved = resolveModel({
        type: 'llm',
        taskType: profile.taskType,
        difficulty: profile.difficulty,
        profile,
        requiresImage: _requiresImage,
        requiresVideo: _requiresVideo,
        requiresAudio: _requiresAudio,
        requiresFile:  _requiresFile,
        session,
        agentName,
        minContextK: _minContextK,
        availableProviders: this._availableProviders,
        clients: this._gatewayMode ? this._gatewayClients() : { openai: this._oa, anthropic: this._ac, gemini: this._gc },
      });

      // Clear the image flag now that model selection has consumed it.
      // It will be re-set on the next iteration if new images arrive.
      if (session._hasImageAttachments) session._hasImageAttachments = false;
      if (session._hasVideoAttachments) session._hasVideoAttachments = false;
      if (session._hasAudioAttachments) session._hasAudioAttachments = false;
      if (session._hasFileAttachments)  session._hasFileAttachments  = false;

      // Store for cost tracking after the finally block restores this.model → 'auto'
      session._autoProvider = resolved.provider;
      session._autoModel    = resolved.model;

      // Set provider/model/client for this call (auto-resolved)
      // In gateway mode, effectiveProvider='openai' (for SDK wrapper) but
      // provider keeps the original name (for tracking/exclusion).
      this._effectiveLLMProvider = resolved.effectiveProvider || resolved.provider;
      this.provider     = resolved.provider;  // original provider for tracking
      this.model        = resolved.model;
      this._useThinking = resolved.useThinking;
      this._reasoningScore = resolved.profile?.reasoning ?? 50;
      this._reasoningEffort = resolved.profile?.reasoningEffort ?? EFFORT_LOW;
      if (this._effectiveLLMProvider === 'openai')        this.openai    = this._oa;
      else if (this._effectiveLLMProvider === 'gemini')    this.openai    = this._gc;
      else if (this._effectiveLLMProvider === 'anthropic') this.anthropic = this._ac;

      // ── Resolve effective max_output_tokens via the single-source policy ──
      // This replaces ad-hoc defaults (16K globally, 4000 in callChat, etc.)
      // and consumes the optional per-phase override if declared in .koi.
      // The value is assigned to this.maxTokens so the next _createLLM()
      // constructs BaseLLM with the correct cap.
      try {
        const _modelCaps = getModelCaps(resolved.model);
        const _phaseOverride = session?._phaseProfile?.maxOutputTokens;
        // Exhaustion handler (agent.js) may have bumped this for retry —
        // honour it by treating it as a session-level override.
        const _sessionBump = session?._maxTokensBump;
        const _override = _sessionBump || _phaseOverride;
        const { value, kind, source } = resolveMaxOutputTokens({
          profile: resolved.profile || profile,
          useThinking: this._useThinking,
          phaseOverride: _override,
          caps: _modelCaps,
        });
        this.maxTokens = value;
        channel.log('llm', `[auto] maxOutputTokens=${value} (${source}, kind=${kind}, thinking=${this._useThinking})`);
      } catch (_e) {
        channel.log('llm', `[auto] max-tokens policy failed (${_e.message}); keeping this.maxTokens=${this.maxTokens}`);
      }
    }

    // Build messages from the Event Log via the deprecated ContextMemory shim
    // (which now proxies to memory.eventLogToMessages internally). toMessages
    // is async post-Phase 8b.3 — await it.
    const messages = await contextMemory.toMessages({ agent });

    // Track attachments for debug logging
    const _debugAttachPaths = [];

    // ── Resolve message attachments ─────────────────────────────────────────
    // Each message may have `attachments: [{type:'image', path:'/...'}]`.
    // Optimize images and inject as multimodal content via the provider's API format.
    {
      const _MAX_IMG_DIM = 1568;
      const _optimizeImage = async (imgPath) => {
        try {
          const raw = fs.readFileSync(imgPath);
          const ext = path.extname(imgPath).toLowerCase().slice(1);
          const isJpeg = ext === 'jpg' || ext === 'jpeg';
          if (raw.length < 200_000) {
            return { mime: isJpeg ? 'image/jpeg' : `image/${ext}`, b64: raw.toString('base64') };
          }
          let optimized = raw;
          let mime = isJpeg ? 'image/jpeg' : `image/${ext}`;
          try {
            const sharp = (await import('sharp')).default;
            optimized = await sharp(raw).resize(_MAX_IMG_DIM, _MAX_IMG_DIM, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
            mime = 'image/jpeg';
          } catch {}
          channel.log('llm', `[image] Optimized ${path.basename(imgPath)}: ${(raw.length/1024).toFixed(0)}KB → ${(optimized.length/1024).toFixed(0)}KB (${mime})`);
          return { mime, b64: optimized.toString('base64') };
        } catch { return null; }
      };

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg.attachments?.length) continue;

        const imageAtts = msg.attachments.filter(a =>
          a.type === 'image' && a.path && fs.existsSync(a.path)
        );

        // Remove attachments field (LLM API doesn't understand it)
        delete msg.attachments;

        if (imageAtts.length === 0) continue;

        const textContent = typeof msg.content === 'string' ? msg.content : '';

        const imageParts = (await Promise.all(
          imageAtts.map(async a => {
            const opt = await _optimizeImage(a.path);
            return opt ? { ...opt, path: a.path } : null;
          })
        )).filter(Boolean);

        if (imageParts.length === 0) continue;

        if (this.provider === 'anthropic') {
          messages[i] = {
            role: msg.role,
            content: [
              ...imageParts.map(p => ({
                type: 'image', source: { type: 'base64', media_type: p.mime, data: p.b64 }
              })),
              { type: 'text', text: textContent }
            ]
          };
        } else {
          messages[i] = {
            role: msg.role,
            content: [
              { type: 'text', text: textContent },
              ...imageParts.map(p => ({
                type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.b64}` }
              }))
            ]
          };
        }
        _debugAttachPaths.push(...imageParts.map(p => p.path));
      }
    }

    // Inject MCP tool image results (e.g. get_screenshot) as multimodal content blocks.
    // Inject images into the LLM call so the agent can see them.
    // Coordinators also need vision to look at images before deciding who to delegate to.
    // Images are ALSO preserved for propagation to delegates.
    if (session._pendingMcpImages?.length > 0) {
      const _canDelegate = agent?.hasPermission?.('delegate');
      if (_canDelegate) {
        // Preserve images for propagation to delegates as well.
        session._lastConsumedImages = [...session._pendingMcpImages];
      }
      {
        const _visualImages = session._pendingMcpImages;

        if (_visualImages.length > 0) {
          const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
          if (lastUserIdx >= 0) {
            const existing = messages[lastUserIdx].content;
            const textContent = typeof existing === 'string' ? existing
              : Array.isArray(existing) ? existing.find(p => p.type === 'text')?.text ?? '' : '';
            // Each pending image may carry a `caption` — a text block that
            // must precede it (used to mark annotation overlays so the LLM
            // does not mistake user markup for original design elements).
            if (this.provider === 'anthropic') {
              messages[lastUserIdx] = {
                role: 'user',
                content: [
                  ..._visualImages.flatMap(p => {
                    const blocks = [];
                    if (p.caption) blocks.push({ type: 'text', text: p.caption });
                    blocks.push({ type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } });
                    return blocks;
                  }),
                  { type: 'text', text: textContent },
                ]
              };
            } else {
              messages[lastUserIdx] = {
                role: 'user',
                content: [
                  { type: 'text', text: textContent },
                  ..._visualImages.flatMap(p => {
                    const blocks = [];
                    if (p.caption) blocks.push({ type: 'text', text: p.caption });
                    blocks.push({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } });
                    return blocks;
                  }),
                ]
              };
            }
            if (process.env.KOI_DEBUG_LLM) {
              _debugAttachPaths.push(..._visualImages.map(p => p._debugPath || `[${p.mimeType || 'image'}]`));
            }
            // Always-on confirmation log: how many images, what sizes, what
            // captions/roles. Without this the user sees `[image_url]` in
            // the debug prompt and (reasonably) wonders whether the bytes
            // actually reach the LLM. The placeholder is purely a console
            // readability device (see debug-logger.js:17); the real API
            // POST carries the full base64 — this log proves it.
            try {
              const _attachReport = _visualImages.map((p, i) => {
                const kb = Math.round(((p.data?.length || 0) * 3 / 4) / 1024); // base64 → bytes
                const file = (p._debugPath || '').split('/').pop() || `img-${i}`;
                const role = p.role || 'image';
                return `${file} (${role}, ${kb}KB)`;
              }).join(', ');
              channel.log(
                'llm',
                `[vision] attaching ${_visualImages.length} image(s) to ${this.provider} request → ${_attachReport}`,
              );
            } catch { /* logging is best-effort */ }
          }
        }
        // Save ALL images (including annotations) for propagation to delegates —
        // they may need to read annotations via read_file for their own analysis.
        session._lastConsumedImages = [...session._pendingMcpImages];
        // Keep a snapshot so the catch-retry path can re-inject them if the
        // call fails. Cleared on successful streamReactive return.
        session._consumedThisCall = [...session._pendingMcpImages];
        session._pendingMcpImages = null;
      }
    }

    // Prune image blocks from all messages EXCEPT the last user message.
    // This prevents old screenshots from accumulating in the conversation
    // (e.g. from merged multimodal messages or batched image results).
    // User-provided images are always in the last user message, so they're preserved.
    {
      const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
      let _pruned = 0;
      for (let i = 0; i < messages.length; i++) {
        if (i === lastUserIdx) continue; // keep current images
        const c = messages[i].content;
        if (!Array.isArray(c)) continue;
        const hasImages = c.some(p => p.type === 'image' || p.type === 'image_url');
        if (!hasImages) continue;
        // Strip image blocks, keep text
        const textOnly = c.filter(p => p.type === 'text');
        const imgCount = c.length - textOnly.length;
        _pruned += imgCount;
        const textContent = textOnly.map(p => p.text).join('\n');
        messages[i] = { role: messages[i].role, content: textContent + ` [${imgCount} image(s) pruned]` };
      }
      if (_pruned > 0 && process.env.KOI_DEBUG_LLM) {
        console.error(`[image-prune] Stripped ${_pruned} old image(s) from conversation history`);
      }
    }

    // ── Inject cache_control breakpoints for models that support prompt caching ──
    // Anthropic + Gemini (via OpenRouter): need explicit cache_control on content blocks.
    // OpenAI: caching is automatic with allow_prompt_caching (backend-side), no breakpoints needed.
    // We cache the system message because it's the largest stable content (playbooks, tools, rules).
    // Gemini only supports 1 breakpoint; Anthropic supports multiple — system msg covers both.
    {
      const _cacheCaps = getModelCaps(this.model);
      if (_cacheCaps.supportsCaching && this.provider !== 'openai') {
        const _sysIdx = messages.findIndex(m => m.role === 'system');
        if (_sysIdx >= 0) {
          const _sysContent = messages[_sysIdx].content;
          const _boundary = session?._promptCacheBoundary || 0;

          if (typeof _sysContent === 'string' && _boundary > 0) {
            // Cache-aware: split into static (cached) + dynamic (not cached) blocks.
            // The cache_control breakpoint after the static block tells the provider
            // to cache only the static prefix. Dynamic content changes every turn.
            const _staticBlock = _sysContent.substring(0, _boundary);
            const _dynamicBlock = _sysContent.substring(_boundary);
            messages[_sysIdx] = {
              role: 'system',
              content: [
                { type: 'text', text: _staticBlock, cache_control: { type: 'ephemeral', ttl: '1h' } },
                { type: 'text', text: _dynamicBlock },
              ],
            };
          } else if (typeof _sysContent === 'string') {
            // No boundary — cache the entire system message as a single block
            messages[_sysIdx] = {
              role: 'system',
              content: [{ type: 'text', text: _sysContent, cache_control: { type: 'ephemeral', ttl: '1h' } }],
            };
          } else if (Array.isArray(_sysContent)) {
            // Already an array — add cache_control to the last text block
            const _lastText = _sysContent.map(p => p.type).lastIndexOf('text');
            if (_lastText >= 0) {
              _sysContent[_lastText] = { ..._sysContent[_lastText], cache_control: { type: 'ephemeral', ttl: '1h' } };
            }
          }
        }
      }
    }

    // Debug: log what attachments (if any) are being sent to the LLM
    if (process.env.KOI_DEBUG_LLM) {
      if (_debugAttachPaths.length > 0) {
        console.error(`📎 Attachments → LLM (${_debugAttachPaths.length}):`);
        _debugAttachPaths.forEach(p => console.error(`   ${p}`));
      } else {
        console.error(`📎 No attachments`);
      }
    }

    const msgCount = messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const lastUserMsgText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg?.content || '');

    // Estimate input tokens from total message chars (~4 chars/token)
    const _totalChars = messages.reduce((sum, m) => {
      const c = m.content;
      if (typeof c === 'string') return sum + c.length;
      if (Array.isArray(c)) return sum + c.reduce((s, p) => s + (p.text || '').length, 0);
      return sum;
    }, 0);
    const _estInputTokens = Math.ceil(_totalChars / 4);

    // Update status line with estimated input tokens before sending
    const _fmtTk = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    const _effortLabel = this._reasoningEffort && this._reasoningEffort !== EFFORT_NONE ? ` · effort:${this._reasoningEffort}` : '';
    channel.setInfo('tokens', `↑${_fmtTk(_estInputTokens)} tokens · ${this.provider}/${this.model}${_effortLabel}`);

    channel.log('llm', `Sending to ${this.provider}/${this.model} (${msgCount} messages, ~${_estInputTokens} tokens, last user msg: ${lastUserMsgText.length} chars)`);
    channel.log('llm', `Last user msg preview: ${lastUserMsgText.substring(0, 300)}${lastUserMsgText.length > 300 ? '...' : ''}`);

    // Full-message dump for debugging hallucination / prompt-regression bugs.
    // Enable with KOI_DUMP_LLM=1. Writes one JSON file per LLM call to
    // ~/.koi/debug/ containing the entire `messages` array (system + user +
    // assistant + tool), plus provider/model metadata. The file is written
    // synchronously so a crash or abort right after this line still leaves
    // the artifact on disk.
    if (process.env.KOI_DUMP_LLM) {
      try {
        const _fs = await import('fs');
        const _path = await import('path');
        const _os = await import('os');
        const _dir = _path.join(_os.homedir(), '.koi', 'debug');
        _fs.mkdirSync(_dir, { recursive: true });
        const _ts = new Date().toISOString().replace(/[:.]/g, '-');
        const _agent = (agent?.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
        const _file = _path.join(_dir, `llm-${_ts}-${_agent}.json`);
        _fs.writeFileSync(_file, JSON.stringify({
          timestamp: new Date().toISOString(),
          agent: agent?.name || null,
          provider: this.provider,
          model: this.model,
          reasoningEffort: this._reasoningEffort || null,
          msgCount,
          estInputTokens: _estInputTokens,
          messages,
        }, null, 2));
        channel.log('llm', `[dump] Full prompt → ${_file}`);
      } catch (e) {
        channel.log('llm', `[dump] Failed to write debug dump: ${e.message}`);
      }
    }

    // Real-time streaming callback: updates the token footer as chunks arrive.
    // Also detects print intent and streams the message content to the UI in real-time.
    // (_fmtTk defined above for input token estimate)

    // Streaming print state machine
    let _spState = 'init';       // 'init' | 'found_print' | 'streaming' | 'done' | 'skip'
    let _spBuf = '';             // accumulated raw JSON text
    let _spMsgOffset = -1;      // offset where message string content starts
    let _spInEscape = false;     // inside a \ escape
    let _spPendingUnicode = null; // collecting \uXXXX hex digits
    let _printStreamed = false;  // true once streaming print was active
    let _lineBuf = '';           // line buffer — holds partial line until \n
    let _tableBuf = [];          // buffered table rows for batch rendering
    let _inCodeBlock = false;    // inside a ``` code block
    let _codeLang = '';          // language of current code block
    let _codeLines = [];         // buffered code lines for syntax highlighting

    const _flushTableBuf = () => {
      if (_tableBuf.length > 0) {
        channel.printStreaming(channel.renderTable(_tableBuf) + '\n');
        _tableBuf = [];
      }
    };

    // Flush complete lines from _lineBuf to the UI with markdown formatting.
    // Tables are buffered until a non-table line arrives (or flush=true).
    // If flush=true, also emit the remaining partial line (end of message).
    const _flushCodeBlock = () => {
      if (_codeLines.length === 0) return;
      // Render the buffered code block as a single markdown code block,
      // then pass through renderMarkdown for syntax highlighting.
      const codeBlock = '```' + _codeLang + '\n' + _codeLines.join('\n') + '\n```';
      channel.printStreaming(channel.renderMarkdown(codeBlock) + '\n');
      _codeLines = [];
      _codeLang = '';
    };

    const _flushLines = (flush = false) => {
      let idx;
      while ((idx = _lineBuf.indexOf('\n')) !== -1) {
        const line = _lineBuf.slice(0, idx); // without \n
        _lineBuf = _lineBuf.slice(idx + 1);

        const trimmed = line.trim();

        // Code block start: ```lang
        if (trimmed.startsWith('```') && !_inCodeBlock) {
          _flushTableBuf();
          _inCodeBlock = true;
          _codeLang = trimmed.substring(3).trim();
          _codeLines = [];
          continue;
        }
        // Code block end: ```
        if (trimmed === '```' && _inCodeBlock) {
          _inCodeBlock = false;
          _flushCodeBlock();
          continue;
        }
        // Inside code block — collect raw lines
        if (_inCodeBlock) {
          _codeLines.push(line);
          continue;
        }

        // Detect table rows: starts and ends with |
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
          _tableBuf.push(line);
          continue;
        }

        // Non-table line — flush any buffered table first
        _flushTableBuf();

        // Format and emit
        channel.printStreaming(channel.renderLine(line) + '\n');
      }

      if (flush) {
        // Flush remaining code block
        if (_inCodeBlock) {
          _inCodeBlock = false;
          _flushCodeBlock();
        }
        // Flush remaining table buffer
        _flushTableBuf();
        // Flush remaining partial line
        if (_lineBuf) {
          channel.printStreaming(channel.renderLine(_lineBuf));
          _lineBuf = '';
        }
      }
    };

    // Process a delta chunk while in 'streaming' state — unescape JSON string chars
    // and buffer by line. Detects the closing " to transition to 'done'.
    const _processStreamingChars = (delta) => {
      for (let i = 0; i < delta.length; i++) {
        if (_spState !== 'streaming') break;
        const ch = delta[i];

        if (_spPendingUnicode !== null) {
          _spPendingUnicode += ch;
          if (_spPendingUnicode.length === 4) {
            _lineBuf += String.fromCharCode(parseInt(_spPendingUnicode, 16));
            _spPendingUnicode = null;
          }
          continue;
        }

        if (_spInEscape) {
          _spInEscape = false;
          if (ch === 'n') _lineBuf += '\n';
          else if (ch === 'r') _lineBuf += '\r';
          else if (ch === 't') _lineBuf += '\t';
          else if (ch === '"') _lineBuf += '"';
          else if (ch === '\\') _lineBuf += '\\';
          else if (ch === '/') _lineBuf += '/';
          else if (ch === 'u') { _spPendingUnicode = ''; }
          else _lineBuf += ch;
          continue;
        }

        if (ch === '\\') { _spInEscape = true; continue; }
        if (ch === '"') {
          // End of JSON string value — flush any remaining partial line
          _flushLines(true);
          _spState = 'done';
          _printStreamed = true;
          // Don't call printStreamingEnd here — the print action will clear
          // the streaming area when it commits the markdown-formatted text,
          // avoiding a visual "double display".
          break;
        }
        _lineBuf += ch;
      }
      // After processing the delta, emit any complete lines we've accumulated
      if (_spState === 'streaming') _flushLines(false);
    };

    // Transition to streaming state: emit any buffered message content
    const _startStreaming = () => {
      _spState = 'streaming';
      const buffered = _spBuf.slice(_spMsgOffset);
      if (buffered) _processStreamingChars(buffered);
    };

    let _complianceAborted = false;

    const _onStreamChunk = (_delta, estOutTokens) => {
      _markContentReceived(); // Real content arrived — cancel total timeout
      _resetTimer();          // Reset inactivity timer
      channel.setInfo('tokens', `↓${_fmtTk(estOutTokens)} tokens`);

      if (_spState === 'done' || _spState === 'skip') return;

      _spBuf += _delta;

      // Early compliance detection: if we see "wont_do" in the stream, abort immediately.
      // This saves tokens — no need to wait for the full response.
      if (!_complianceAborted && _spBuf.includes('"wont_do"')) {
        _complianceAborted = true;
        _spState = 'skip';
        channel.log('llm', `[compliance] Early abort: detected "wont_do" in stream`);
        return;
      }

      if (_spState === 'init') {
        // Wait for intent field
        const intentMatch = _spBuf.match(/"intent"\s*:\s*"([^"]*)"/);
        if (intentMatch) {
          if (intentMatch[1] === 'print') {
            _spState = 'found_print';
            // Check if message value already started
            const msgMatch = _spBuf.match(/"message"\s*:\s*"/);
            if (msgMatch) {
              _spMsgOffset = msgMatch.index + msgMatch[0].length;
              _startStreaming();
            }
          } else {
            _spState = 'skip';
          }
        } else if (_spBuf.length > 300) {
          _spState = 'skip';
        }
      } else if (_spState === 'found_print') {
        // Intent is print — waiting for message field
        const msgMatch = _spBuf.match(/"message"\s*:\s*"/);
        if (msgMatch) {
          _spMsgOffset = msgMatch.index + msgMatch[0].length;
          _startStreaming();
        }
      } else if (_spState === 'streaming') {
        // Already streaming — process new delta characters only
        _processStreamingChars(_delta);
      }
    };

    // Inactivity timeout: abort if no chunks (content OR thinking) arrive.
    // Resets on every chunk — as long as data flows, the stream lives.
    // Thinking-capable models (even without explicit thinking mode) may buffer
    // internally before sending the first chunk, so use a longer timeout.
    const _modelCaps = getModelCaps(this.model);
    const _isThinkingCapable = this._useThinking || _modelCaps?.thinking;
    // Inactivity timeout scales with reasoning effort — higher effort means
    // the model may buffer longer before sending the first content chunk.
    const _effort = this._reasoningEffort || EFFORT_NONE;
    const STREAM_INACTIVITY_MS = _isThinkingCapable
      ? (THINKING_INACTIVITY_MS[_effort] || THINKING_INACTIVITY_MS[EFFORT_LOW])
      : DEFAULT_INACTIVITY_MS;
    const STREAM_INACTIVITY_LABEL = `${STREAM_INACTIVITY_MS / 1000}s`;
    // Hard total timeout: absolute cap for a single LLM call (including thinking).
    // Scales with effort — high-effort thinking models can legitimately take minutes.
    const STREAM_TOTAL_MS = STREAM_INACTIVITY_MS * 2;
    const STREAM_TOTAL_LABEL = `${STREAM_TOTAL_MS / 1000}s`;
    const _inactivityCtrl = new AbortController();
    let _totalTimerFired = false;
    let _inactivityTimer = setTimeout(() => _inactivityCtrl.abort(), STREAM_INACTIVITY_MS);
    const _totalTimer = setTimeout(() => {
      _totalTimerFired = true;
      channel.log('llm', `[stream] TOTAL timeout (${STREAM_TOTAL_LABEL}) — aborting stream`);
      _inactivityCtrl.abort();
    }, STREAM_TOTAL_MS);
    let _firstContentReceived = false;
    let _thinkingTokens = 0; // Accumulated thinking/reasoning tokens (for cost tracking)
    const _resetTimer = () => {
      clearTimeout(_inactivityTimer);
      _inactivityTimer = setTimeout(() => _inactivityCtrl.abort(), STREAM_INACTIVITY_MS);
    };
    // Mark that real content has started flowing (called from _onStreamChunk only)
    const _markContentReceived = () => {
      _firstContentReceived = true;
    };
    // Called by streaming methods on any chunk (including empty/thinking) to signal liveness.
    // thinkingTk: estimated thinking tokens so far (0 if not tracking).
    let _heartbeatCount = 0;
    const _heartbeat = (thinkingTk) => {
      _resetTimer();
      _heartbeatCount++;
      if (!_firstContentReceived) {
        if (thinkingTk > 0) {
          _thinkingTokens = thinkingTk;
          channel.setInfo('tokens', `↓${_fmtTk(thinkingTk)} tokens · thinking`);
        } else if (_heartbeatCount > 2) {
          // No thinking token count yet but events are flowing — model is reasoning
          channel.setInfo('tokens', 'thinking');
        }
      }
    };

    // Merged signal: fires when user aborts OR inactivity timeout
    // _abortHandler is stored so it can be removed in finally (prevents MaxListenersExceededWarning
    // when abortSignal is long-lived and accumulates listeners across 100+ LLM calls).
    let _abortHandler = null;
    const _llmSignal = (() => {
      const ctrl = new AbortController();
      if (abortSignal) {
        if (abortSignal.aborted) { ctrl.abort(abortSignal.reason); }
        else {
          _abortHandler = () => ctrl.abort(abortSignal.reason);
          abortSignal.addEventListener('abort', _abortHandler, { once: true });
        }
      }
      _inactivityCtrl.signal.addEventListener('abort', () => ctrl.abort(_inactivityCtrl.signal.reason), { once: true });
      return ctrl.signal;
    })();

    let response;
    const _t0 = Date.now();
    try {
      // Dispatch to provider via factory — each provider class handles
      // its own streaming format, thinking config, and message formatting.
      const agentInfo = agent ? `Agent: ${agent.name}` : '';
      const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
      this.logRequest(this.model, systemPrompt, messages.filter(m => m.role === 'user').pop()?.content || '', `Reactive ${agentInfo}`, session?._promptCacheBoundary || 0);

      const llm = this._createLLM();
      response = await llm.streamReactive(messages, {
        abortSignal: _llmSignal,
        onChunk: _onStreamChunk,
        onHeartbeat: _heartbeat,
      });

      this.logResponse(response.text, `Reactive ${agentInfo}`, response.usage);
      // Successful call — drop the retry snapshot so these images don't get
      // re-injected on a future (unrelated) error.
      if (session) session._consumedThisCall = null;
    } catch (_callErr) {
      // Restore pending images so the retry re-injects them. Without this,
      // a failed call (e.g. model rejects image payload) silently drops the
      // attachment and the next iteration hallucinates about a different image.
      if (session?._consumedThisCall?.length && !session._pendingMcpImages?.length) {
        session._pendingMcpImages = [...session._consumedThisCall];
        channel.log('llm', `[auto] Restoring ${session._consumedThisCall.length} image(s) after LLM error for retry`);
      }
      // Resolve which model actually handled this call so the per-model
      // cooldown hits the specific failing model (e.g. gemini-3.1-pro-preview)
      // instead of the whole provider.
      const _effModel    = session?._autoModel    || this.model;
      const _effProvider = session?._autoProvider || this.provider;

      // Convert inactivity abort to a recognizable error so agent retry logic kicks in
      // Note: message must contain 'timeout' to match the isTimeout check in agent.js
      if (_inactivityCtrl.signal.aborted && !abortSignal?.aborted) {
        const _timeoutKind = _totalTimerFired ? 'total' : 'inactivity';
        const _timeoutLabel = _totalTimerFired ? STREAM_TOTAL_LABEL : STREAM_INACTIVITY_LABEL;
        channel.log('llm', `Stream ${_timeoutKind} timeout — ${_timeoutLabel}`);
        if (this._autoMode) {
          markModelTimeout(_effProvider, _effModel);
          markProviderTimeout(_effProvider);
          // The backend's circuit breaker very likely just hid this model
          // from /gateway/models (we recorded a failure on its end too).
          // Force-refresh the local model list NOW — bypassing the 60s
          // poll gate — so the next retry doesn't reselect the same dead
          // model based on a stale cache. ETag-conditional + in-flight
          // coalescing keeps this cheap.
          forceRefreshRemoteModels().catch(() => { /* non-fatal */ });
        }
        throw new Error(`LLM stream ${_timeoutKind} timeout after ${_timeoutLabel} (no chunks received)`);
      }
      // Circuit breaker: timeouts put the provider on cooldown, but we
      // ALSO put mid-stream provider errors (and any non-4xx failure)
      // on a per-model cooldown so the next retry can pick a sibling
      // model instead of hammering the same broken one. Connection
      // errors are transient network issues — leave those alone so a
      // blip doesn't wipe out the whole candidate list.
      const _isTimeout = /timed?\s*out|timeout/i.test(_callErr.message || '');
      const _isConnError = /connection error|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed/i.test(_callErr.message || '');
      if (_isTimeout && !_isConnError && this._autoMode) {
        markModelTimeout(_effProvider, _effModel);
        markProviderTimeout(_effProvider);
        // Same reasoning as the inactivity-abort branch above: pull the
        // fresh model list so the auto-selector reflects whatever the
        // backend just decided about this model's health.
        forceRefreshRemoteModels().catch(() => { /* non-fatal */ });
      } else if (!_isConnError && this._autoMode) {
        // Generic provider error mid-stream (e.g. "Provider returned error").
        // Sideline just this model so the retry picks a different one.
        markModelTimeout(_effProvider, _effModel);
      }
      // In auto mode: a 4xx from a provider means the key is invalid/unauthorized or the
      // model is unavailable. Remove that provider from candidates so we don't hammer it
      // on every retry iteration — the agent would otherwise loop forever with the same error.
      // 402 Payment Required — gateway says the user is out of credits.
      // Convert to QuotaExceededError so upstream catches (tool loop, agent)
      // can surface the upgrade dialog. Do this BEFORE the generic 4xx
      // provider-exclusion logic so we don't nuke the provider list.
      if (isQuotaExceededError(_callErr)) {
        throw toQuotaExceededError(_callErr) || _callErr;
      }
      if (this._autoMode) {
        const _status = _callErr.status ?? _callErr.statusCode;
        // 429 = rate limit — put provider on cooldown
        if (_status === 429) {
          markProviderTimeout(this.provider);
        }
        // 401 in gateway mode = token expired/invalid — signal for re-auth
        if (_status === 401 && this._gatewayMode) {
          const _s = globalThis.__koiStrings || {};
          throw new Error('AUTH_EXPIRED: ' + (_s.authExpired || 'Your session has expired. Please restart and log in again.'));
        }
        // 413 = payload too large — drop pending images and retry (don't exclude provider)
        if (_status === 413 && session?._promptAttachments?.length > 0) {
          channel.log('llm', `[auto] 413 Payload Too Large — dropping ${session._promptAttachments.length} attachment(s) and retrying`);
          session._promptAttachments = null;
        }
        // Other 4xx (401, 403, 404) = invalid key or model — exclude provider entirely.
        // 413 = payload too large — NOT the provider's fault, don't exclude it.
        if (typeof _status === 'number' && _status >= 400 && _status < 500 && _status !== 429 && _status !== 413) {
          const _badProvider = this.provider;
          const _idx = this._availableProviders.indexOf(_badProvider);
          if (_idx !== -1) {
            this._availableProviders.splice(_idx, 1);
            channel.log('llm', `[auto] Provider "${_badProvider}" excluded — HTTP ${_status} (key may be invalid or model unavailable)`);
          }
          // Gateway mode: re-sync available providers from backend when a key
          // is missing or invalid, so subsequent calls pick the right provider.
          if (this._koiGateway) {
            this.syncGatewayProviders(); // fire-and-forget
          }
        }
      }
      throw _callErr;
    } finally {
      clearTimeout(_inactivityTimer);
      clearTimeout(_totalTimer);
      if (_abortHandler) abortSignal.removeEventListener('abort', _abortHandler);
    }
    const _apiMs = Date.now() - _t0;

    const responseText = response.text;
    const usage = response.usage;

    // Use the effective model/provider for cost tracking (resolved from session cache if auto)
    const _effectiveModel    = session._autoModel    || this.model;
    const _effectiveProvider = session._autoProvider || this.provider;

    // Successful call — reset circuit breaker for this provider
    if (this._autoMode) clearProviderCooldown(_effectiveProvider);

    // Include thinking tokens in cost tracking.
    // _thinkingTokens is our streaming estimate. Set usage.thinking so it's added to cost.
    if (_thinkingTokens > 0) {
      usage.thinking = _thinkingTokens;
    }

    // Accumulate token usage on session (printed as summary before prompt_user)
    if (!session.tokenAccum) session.tokenAccum = { input: 0, output: 0, thinking: 0, calls: 0 };
    session.tokenAccum.input += usage.input;
    session.tokenAccum.output += usage.output;
    session.tokenAccum.thinking += (usage.thinking || 0);
    session.tokenAccum.calls++;
    // Store last call's usage for per-request display
    session.lastUsage = { input: usage.input, output: usage.output, thinking: usage.thinking || 0 };

    // Record to global cost center (thinking tokens count as output for billing)
    costCenter.recordUsage(_effectiveModel, _effectiveProvider, usage.input, usage.output, _apiMs, usage.thinking || 0, usage.cachedInput || 0);

    // Update token display with final accurate counts (only show ↑ when input > 0)
    {
      const _parts = [];
      if (usage.input > 0) _parts.push(`↑${_fmtTk(usage.input)}`);
      const _outTotal = (usage.output || 0) + (usage.thinking || 0);
      if (_outTotal > 0) _parts.push(`↓${_fmtTk(_outTotal)}`);
      if (_parts.length > 0) _parts.push('tokens');
      if (_parts.length > 0) channel.setInfo('tokens', _parts.join(' '));
    }

    channel.log('llm', `Response (${responseText.length} chars, ↑${usage.input} ↓${usage.output} tokens): ${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}`);

    // If compliance abort was detected during streaming, return a synthetic refused action
    // without parsing the full response. This saves processing and prevents executing refused content.
    if (_complianceAborted) {
      channel.log('llm', `[compliance] Returning synthetic refused action (stream aborted on wont_do)`);
      return { actionType: 'direct', intent: 'print', message: '', _refused: true };
    }

    // Parse the response into a single action
    const action = await this._parseReactiveResponse(responseText, agent);

    // If streaming print was active but didn't see closing quote, finalize now
    if (_spState === 'streaming') {
      channel.printStreamingEnd();
    }

    // Mark that the print was already streamed — the print action should skip
    // its own channel.print() to avoid showing the message twice.
    if (_printStreamed && action) {
      action._alreadyStreamed = true;
    }

    // Add assistant message to memory with classification
    const assistantClassified = classifyResponse(responseText, action);
    contextMemory.add('assistant', assistantClassified.immediate, assistantClassified.shortTerm, assistantClassified.permanent, assistantClassified);

    return action;
  }

  // ── Response parsing (delegated to response-parser.js) ──────────────────
  async _searchRelevantCommits(userText) { return searchRelevantCommits(userText, (t) => this.getEmbedding(t)); }
  async _parseReactiveResponse(responseText, agent = null) { return parseReactiveResponse(responseText, agent, (s, u, m) => this.callUtility(s, u, m)); }
  _normalizeBatchItem(item) { return normalizeBatchItem(item); }
  _normalizeReactiveAction(parsed) { return normalizeReactiveAction(parsed); }

  // ── System prompt building (delegated to system-prompt-builder.js) ─────
  async _buildReactiveSystemPrompt(agent, playbook = null) { return buildReactiveSystemPrompt(agent, playbook); }
  async _buildSystemPrompt(agent) { return buildSystemPrompt(agent); }
  _loadKoiMd() { return loadKoiMd(); }
  async _buildSmartResourceSection(agent) { return buildSmartResourceSection(agent); }

  // ── Compose execution (delegated to compose-executor.js) ────────────────
  static _inferProviderFromModel(model) { return inferProviderFromModel(model); }
  async executeCompose(composeDef, agent) { return _executeCompose(this, composeDef, agent); }
  async _callJSONWithMessages(messages) { return _callJSONWithMessages(this, messages); }

  // ── Embeddings (delegated to embedding-provider.js) ──────────────────────
  _embeddingProvider = null;
  _getEmbeddingProvider() {
    if (!this._embeddingProvider) {
      this._embeddingProvider = new EmbeddingProvider({
        createEmbeddingFn: createEmbedding,
        getEmbeddingDimensionFn: getEmbeddingDimension,
        logFn: (cat, msg) => channel.log(cat, msg),
      });
    }
    return this._embeddingProvider;
  }
  getEmbeddingDim() { return this._getEmbeddingProvider().getEmbeddingDim(); }
  async getEmbedding(text) { return this._getEmbeddingProvider().getEmbedding(text); }
  async getEmbeddingBatch(texts) { return this._getEmbeddingProvider().getEmbeddingBatch(texts); }
}
