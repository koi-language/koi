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
import { parseReactiveResponse, normalizeReactiveAction, normalizeBatchItem } from './response-parser.js';
import { buildReactiveSystemPrompt, buildSystemPrompt, loadKoiMd, buildSmartResourceSection } from './system-prompt-builder.js';
import { executeCompose as _executeCompose, callJSONWithMessages as _callJSONWithMessages, inferProviderFromModel } from './compose-executor.js';
import { StreamingPrintParser } from './streaming-print.js';
import { optimizeImage, resolveAttachments, injectMcpImages, pruneOldImages, injectCacheControl } from './message-builder.js';
import { isQuotaExceededError, toQuotaExceededError } from './quota-exceeded-error.js';
import { attachmentTypeFromPath } from '../state/attachment-registry.js';

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
      // Inject active skill contents AND the catalog of available skills
      // into the static part of the prompt. Skills (active + catalog) are
      // stable once a session starts — they belong in the cached prefix.
      //
      // Two blocks:
      //   1. `# Available Skills` — the catalog of all skill names +
      //      descriptions on disk. Always present so the LLM can decide
      //      mid-task to activate one (e.g. when it reads a cross-reference
      //      link `[firecrawl-cli](firecrawl-cli)` in the body of an
      //      already-activated skill and recognises the name from this
      //      catalog). This is the progressive-disclosure pattern Claude
      //      Code's official Agent Skills uses: descriptions upfront, full
      //      bodies on demand via `activate_skill`. Skills already active
      //      are marked with ✓ so the LLM doesn't waste an activate_skill
      //      call on something already in context.
      //   2. `# Active Skill Instructions` — the FULL bodies of skills the
      //      LLM has explicitly activated. Stored in agent.state._skillContents.
      //
      // The catalog is cached on `agent.state._skillCatalog` after the first
      // build so we don't re-scan disk on every prompt rebuild.
      const _activeContents = agent.state?._skillContents || {};
      const _activeNames = new Set(Object.keys(_activeContents));
      let _skillCatalog = agent.state?._skillCatalog;
      if (!_skillCatalog) {
        try {
          const _listResult = await agent.callAction?.('list_skills', {});
          const _allSkills = _listResult?.skills || [];
          _skillCatalog = Array.isArray(_allSkills) ? _allSkills : [];
          if (agent.state) agent.state._skillCatalog = _skillCatalog;
        } catch {
          _skillCatalog = [];
        }
      }
      // Every skill is listed WITH a description, ordered by how much the user
      // leans on it (most-used + most-recent first). Descriptions share a total
      // character budget: the highest-priority skills get their full text (up to
      // a per-entry cap), and as the budget fills the LEAST-used skills get
      // their descriptions shortened progressively, dropping to name-only only
      // once there is no budget left. This mirrors Claude Code's skill-listing
      // budget (full text upfront, graceful degradation by priority) — the full
      // description is always one describe_skill call away, so shortening the
      // listing never loses information, only inline convenience.
      //   - KOI_SKILL_LISTING_BUDGET  — total chars for all descriptions (default 8000)
      //   - KOI_SKILL_DESC_MAX_CHARS  — per-entry hard cap (default 500)
      let _topUsedIds = [];
      let _recentIds = [];
      try {
        const { topUsedSkillIds, recentSkillIds } = await import('../tools/skills/skill-usage-store.js');
        _topUsedIds = topUsedSkillIds(_skillCatalog.length || 1000);
        _recentIds = recentSkillIds(_skillCatalog.length || 1000);
      } catch { /* no usage history yet — fall back to catalog order */ }
      const _byName = new Map(_skillCatalog.map(s => [s.name, s]));
      const _mark = (name) => _activeNames.has(name) ? '✓ ' : '';
      // Once ANY skill is active the agent has already committed to a task and
      // its body is injected below — the catalog then only needs to keep the
      // OTHER skills DISCOVERABLE, not describe them. Collapse every entry to
      // name-only (full text stays one describe_skill away) to reclaim the
      // tokens the descriptions would cost on every subsequent turn. With no
      // active skill (fresh routing decision) the descriptions are what the
      // agent picks from, so the tiered rendering below stays intact.
      const _nameOnly = _activeNames.size > 0;

      // Two tiers, NOT a per-position ramp. The old greedy allocation gave
      // earlier-listed skills more budget than later ones even when they had
      // the SAME usage (zero) — purely an accident of catalog order, which
      // starved the bottom of the list into stubs. Correct rule: skills with
      // EQUAL usage get an EQUAL cut.
      //   - USED tier   (in topUsed/recent): priority — full text, up to cap.
      //   - UNUSED tier (everything else, all equal usage): split the REMAINING
      //     budget EQUALLY, so every unused skill gets the same length. When the
      //     budget can't give them a useful length they ALL drop to name-only
      //     together, rather than the list-order tail being singled out.
      const _usedSet = new Set();
      for (const id of [..._topUsedIds, ..._recentIds]) {
        if (_byName.has(id)) _usedSet.add(id);
      }
      const _usedSkills = [];
      const _usedSeen = new Set();
      for (const id of [..._topUsedIds, ..._recentIds]) {
        if (_byName.has(id) && !_usedSeen.has(id)) { _usedSeen.add(id); _usedSkills.push(_byName.get(id)); }
      }
      const _unusedSkills = _skillCatalog.filter(s => !_usedSet.has(s.name));

      const _BUDGET = Number(process.env.KOI_SKILL_LISTING_BUDGET) || 8000;
      const _MAXE = Number(process.env.KOI_SKILL_DESC_MAX_CHARS) || 500;
      const _FLOOR = 80; // below this a fragment is useless (and worse,
                         // misleading when many descriptions share a generic
                         // "When the user wants to…" prefix that a short cut
                         // keeps while dropping the distinguishing keyword) →
                         // name-only instead.
      const _cut = (text, max) => {
        const s = String(text || '').trim();
        if (s.length <= max) return s;
        const slice = s.slice(0, max);
        const sp = slice.lastIndexOf(' ');
        return (sp > max * 0.6 ? slice.slice(0, sp) : slice).trimEnd() + '…';
      };
      const _line = (s, max) => {
        // Name-only mode (a skill is already active) — drop all descriptions.
        if (_nameOnly) return `- ${_mark(s.name)}${s.name}`;
        const natural = String(s.description || '').trim();
        if (!natural) return `- ${_mark(s.name)}${s.name}`;
        // Full description already fits → show it verbatim (a SHORT full
        // description is never misleading, so the floor must not suppress it).
        if (natural.length <= max) return `- **${_mark(s.name)}${s.name}** — ${natural}`;
        // Truncation needed → only worth inlining if the fragment clears the
        // floor (a sub-floor cut keeps the generic "When the user wants to…"
        // prefix while dropping the distinguishing keyword — name-only is
        // clearer there). The unused-tier cap below guarantees `max >= _FLOOR`,
        // so in practice every skill with a description gets a capped one.
        if (max >= _FLOOR) return `- **${_mark(s.name)}${s.name}** — ${_cut(natural, max)}`;
        return `- ${_mark(s.name)}${s.name}`;
      };

      // Tier 1 — used skills get full text (capped), priority on the budget.
      let _remaining = _BUDGET;
      const _usedLines = _usedSkills.map(s => {
        const line = _line(s, Math.min(_MAXE, _remaining));
        // Recover the rendered description length to debit the budget.
        const dash = line.indexOf(' — ');
        if (dash !== -1) _remaining -= (line.length - dash - 3);
        return line;
      });

      // Tier 2 — unused skills split the rest EQUALLY: one shared per-entry cap.
      // The cap is ELASTIC with a floor: when there are so many unused skills
      // that an equal split would fall below `_MIN_DESC`, every entry still gets
      // `_MIN_DESC` chars (so the budget grows a bit rather than starving the
      // long tail to bare names). This is why a machine with many skills used to
      // show the tail name-only: floor(remaining/N) dropped under _FLOOR and the
      // whole unused tier degraded together. Each capped line ends in "…" and the
      // full text is always one describe_skill away.
      const _MIN_DESC = Math.max(_FLOOR, Number(process.env.KOI_SKILL_DESC_MIN_CHARS) || 120);
      const _equalCap = _unusedSkills.length > 0
        ? Math.max(_MIN_DESC, Math.min(_MAXE, Math.floor(_remaining / _unusedSkills.length)))
        : 0;
      const _unusedLines = _unusedSkills.map(s => _line(s, _equalCap));

      const _lines = [..._usedLines, ..._unusedLines];

      const _intro = _nameOnly
        ? 'Skills are reusable instruction packs on disk. You already have a skill '
          + 'active (its body is in "# Active Skill Instructions" below), so the rest are '
          + 'listed by NAME ONLY here — call describe_skill on any whose name looks '
          + 'relevant to read its full description before activating. Manage them with:\n'
        : 'Skills are reusable instruction packs on disk. They are listed below with '
          + 'descriptions; the ones you use most come first and in full, and the rest share '
          + 'the remaining space evenly (so a description may be shortened or omitted to fit), '
          + 'but the full text and body are always available on demand. Manage them with:\n';
      const _catalogBlock = _skillCatalog.length > 0
        ? '\n\n## AVAILABLE SKILLS\n\n'
          + _intro
          + ' - **describe_skill** — read a skill\'s FULL description, to decide if it fits. In: { "name" } or { "names": [...] }\n'
          + ' - **activate_skill** — load a skill\'s body into context so it guides your work. In: { "name" }\n'
          + ' - **deactivate_skill** — remove a loaded skill\'s body. In: { "name" }\n\n'
          + 'HOW TO USE: at the START of a task — and ALWAYS before you open a briefing/form '
          + 'or call prompt_user / prompt_form / prompt_files — scan the list below and '
          + 'activate_skill every skill whose description is on-topic (describe_skill first for '
          + 'any whose text is shortened, rather than guessing; they compose). Skills carry '
          + 'project conventions, gotchas and recipes you won\'t derive from general knowledge, '
          + 'and frequently change WHICH questions to ask, the form fields, or whether to ask at '
          + 'all — so activate FIRST, let the skill shape the questions, and only THEN prompt the '
          + 'user. Asking first and activating after means you\'ve likely asked the wrong things. '
          + 'Loaded skills are marked ✓.\n\n'
          + _lines.join('\n')
        : '';

      const _activeBlock = _activeNames.size > 0
        ? '\n\n# Active Skill Instructions\n\n' + Object.entries(_activeContents).map(
            ([name, content]) => `## Skill: ${name}\n\n${content}`
          ).join('\n\n---\n\n')
        : '';

      const _skillBlock = _catalogBlock + _activeBlock;

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
      // A fresh user message = a NEW turn → drop the previous turn's sticky
      // vision so old images don't bleed into an unrelated request. Gated on the
      // message actually being present, so this never fires mid-turn.
      if (agent._lastUserMessage) session._stickyVision = null;
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

Your ONLY next action is this YAML:
intent: prompt_user
— ask the user what they need.

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
          contextStr = `\n\n📋 YOUR TASK SPEC:\n${_specLines}${_imageNote}${_attNote}\n\nIf anything is unclear or you need additional context, project knowledge is already in your prompt; if it really isn't there, use recall_memory for a targeted lookup or ask_parent. Otherwise, start implementing now.`;
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
        // (Legacy commit-search context injection removed — RMH retrieval
        // via the Context Compiler is the canonical replacement and runs
        // automatically during prompt build.)
        for (const entry of newEntries) {
          if (entry.error) continue;
          const _intent = entry.action.intent || entry.action.type;
          // Run for any prompt_user result that carries an answer OR attachments.
          // A voice-note-only (or image-only) message has an EMPTY/null answer but
          // MUST still have its attachments captured — otherwise the audio is never
          // queued, `_hasAudioAttachments`/`requiresAudio` stay false, the selector
          // picks a non-audio model (e.g. Opus, kept for the on-screen image's
          // vision), and the spoken instructions are SILENTLY DROPPED. Symptom: user
          // records a voice note with no typed text → agent replies "files attached
          // but no instruction". The audio must ALWAYS reach the LLM this same turn.
          const _hasPromptAtts = Array.isArray(entry.result?.attachments) && entry.result.attachments.length > 0;
          if (_intent === 'prompt_user' && (entry.result?.answer != null || _hasPromptAtts)) {
            const _answerText = typeof entry.result.answer === 'string'
              ? entry.result.answer
              : (entry.result.answer?.text ?? '');
            if (_answerText) {
              await contextMemory.hydrate(_answerText);
            }
            // Capture attachments from the user prompt — they'll be passed
            // directly to contextMemory.add() and resolved when building messages
            const _atts = Array.isArray(entry.result.attachments)
              ? entry.result.attachments
                  .filter(a => a.path && fs.existsSync(a.path))
                  // GUI attachments arrive as bare paths typed 'file'; re-derive
                  // the kind from the extension so a mic recording (.m4a) is
                  // typed 'audio' and rides as native input_audio instead of a
                  // filename the model can't hear. An explicit non-'file' type
                  // (e.g. a Telegram voice note already typed 'audio') wins.
                  .map(a => ({
                    ...a,
                    type: (a.type && a.type !== 'file') ? a.type : attachmentTypeFromPath(a.path),
                  }))
              : [];
            if (_atts.length > 0) {
              session._promptAttachments = _atts;
              // Audio attachments (e.g. a Telegram voice note on the prompt) must
              // ride the `_pendingMcpAudios` channel — contextMemory.toMessages()
              // only emits { role, content } and drops `msg.attachments`, so the
              // attachment loop never sees them. Queue them here so the injection
              // block attaches native `input_audio` to this turn's user message.
              const _audioAtts = _atts.filter(a => a.type === 'audio');
              if (_audioAtts.length > 0) {
                try {
                  const { attachAudioFileToSession } = await import('./attach-audio.js');
                  for (const a of _audioAtts) await attachAudioFileToSession(session, a.path);
                } catch (e) {
                  channel.log('llm', `[audio] failed to queue prompt audio: ${e?.message || e}`);
                }
              }
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
          // Resolve the PERSISTENT att-N id for each attached image so the
          // agent re-reads it with read_file("att-N") — those ids resolve from
          // the session dialogue log, so they survive restarts / context
          // scroll-out. Attachments are part of the conversation forever.
          let _attIdByPath = {};
          if (_imgPaths.length > 0) {
            try {
              const { attachmentRegistry: _ar } = await import('../state/attachment-registry.js');
              for (const p of _imgPaths) { try { _ar.register(p); } catch { /* */ } }
              for (const e of _ar.all()) { _attIdByPath[path.resolve(e.path)] = e.id; }
            } catch { /* best-effort — fall back to bare paths */ }
          }
          // Markdown bullet list — easier for the LLM to read AND to copy
          // verbatim into delegate task descriptions than a single inline
          // `["x", "y", …]` array. Each path on its own line means the LLM
          // also can't accidentally split the list mid-quote.
          const _imgRef = _imgPaths.length > 0
            ? `\n\n**Attached images** (permanent — re-read any of them ANY time with read_file("att-N")):\n${_imgPaths.map(p => {
                const _id = _attIdByPath[path.resolve(p)];
                return _id ? `- ${_id} → ${p}` : `- ${p}`;
              }).join('\n')}`
            : '';
          const _imgShort = _imgPaths.length > 0
            ? ` [images: ${_imgPaths.map(p => p.split('/').pop()).join(', ')}]`
            : '';
          // Audio attachments (e.g. a Telegram voice note) carry the bytes
          // separately; the request builder attaches them as native `input_audio`
          // this turn. But a voice-note-only message has an EMPTY answer, which
          // would leave `immediate` blank and the whole user turn (with its
          // audio) gets dropped. Add a non-empty marker so the turn survives and
          // the model knows to act on what it HEARS — no transcription needed.
          const _audioPaths = _promptAtts.filter(a => a.type === 'audio').map(a => a.path);
          const _audioRef = _audioPaths.length > 0
            ? `${classified.immediate ? '\n\n' : ''}🎤 The user sent ${_audioPaths.length === 1 ? 'a voice message' : `${_audioPaths.length} voice messages`} — the audio is ALREADY attached to THIS message and you can hear it directly. Listen to it and act on what is said RIGHT NOW. Do NOT call transcribe_audio, recall_media, read_file, or any tool to "find" or "open" the voice note — it is already here.`
            : '';
          const _audioShort = _audioPaths.length > 0 ? ' [voice message]' : '';
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
          const immediate = `${classified.immediate}${_imgRef}${_audioRef}${_continueTag}`;
          const _shortWithImg = (_imgShort || _audioShort)
            ? `${classified.shortTerm || ''}${_imgShort}${_audioShort}`
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
        // Timing probe: this auto-model-selection classifier is a serial LLM
        // round-trip that runs BEFORE the real answer on every user message,
        // so it's the prime suspect for the "tarda desde que escribo" latency
        // when the agent is idle. Logs elapsed ms so we can confirm with real
        // numbers instead of guessing.
        const _clsT0 = Date.now();
        if (_isInteraction && _savedUserMessage) {
          // User just sent a message → interaction classifier (clean message, speed-oriented)
          session._autoProfile = await this.classifyUserRequest(_savedUserMessage, agentName);
          channel.log('llm', `[classify] interaction classifier took ${Date.now() - _clsT0}ms → cat profile ${session._autoProfile?.label || session._autoProfile?.category || '?'}`);
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
            channel.log('llm', `[classify] task classifier took ${Date.now() - _clsT0}ms`);
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
          // DECOUPLED (per product decision): a phase's reasoning level sets
          // ONLY the thinking EFFORT/budget of the chosen model — it no longer
          // overrides `reasoning`, the capability score the auto-model-selector
          // uses to PICK a model. Model choice stays driven by the classifier's
          // capability assessment, so a "low" phase runs a CAPABLE model that
          // simply thinks less, instead of being downgraded to a weak model
          // (e.g. Gemini 3 Flash) just because the phase is cheap. Previously
          // this also set `_newProfile.reasoning = score`, which conflated
          // "how hard to think" with "which model" — the bug we're fixing.
          const effort = _levelToEffort[_phaseProfile.reasoning];
          if (effort !== undefined) {
            _newProfile.reasoningEffort = effort;
            // Thinking is only justified for medium+ effort. If the phase
            // sets none/low effort, disable thinking even if the classifier
            // originally enabled it.
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
          channel.log('llm', `[classify] Phase override: effort=${_newProfile.reasoningEffort} thinking=${_newProfile.thinking} (model still chosen by classifier capability — code=${_newProfile.code} reasoning=${_newProfile.reasoning})`);
          profile = _newProfile;
        }
      }

      // NOTE: difficulty/score escalation on repeated LLM errors was REMOVED by
      // product decision — it was too aggressive (a few transient errors would
      // ramp the profile to the top tier and burn credits). We NEVER bump the
      // difficulty on failure. Recovery from a failing model is handled purely
      // by agent.js's per-model cooldown + reclassify, which routes OFF the bad
      // model without inflating the profile.

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
      // Tie the requirement to the actual video BYTES, not a one-shot flag.
      // `_hasVideoAttachments` is cleared right after model selection (below),
      // but the video may still be queued (`_pendingMcpVideos`) or have just
      // been consumed/re-queued for a retry (`_consumedVideosThisCall`). If we
      // only checked the one-shot flag, a retry/continuation turn would drop
      // `requiresVideo` → the selector could pick a BLIND model (e.g.
      // gemini-3.5-flash, which has no inputVideo) and then skip the video
      // entirely. So: as long as a video is in play, we ALWAYS require a
      // video-capable model.
      const _requiresVideo = !!session._hasVideoAttachments
        || !!(session._pendingMcpVideos?.length)
        || !!(session._consumedVideosThisCall?.length)
        || _hasFileTypeAtt('video');
      // Like video: tie the requirement to the actual audio BYTES so a
      // retry/continuation turn never drops `requiresAudio` and picks a model
      // with no inputAudio (which would silently skip the audio).
      const _requiresAudio = !!session._hasAudioAttachments
        || !!(session._pendingMcpAudios?.length)
        || !!(session._consumedAudiosThisCall?.length)
        // `_turnAudios` keeps the requirement TRUE for every LLM call of the
        // current user turn (not just the first), so a voice note never gets
        // re-routed to a non-audio model on a follow-up call mid-turn.
        || !!(session._turnAudios?.length)
        || _hasFileTypeAtt('audio');
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

      // ── Prompt-cache continuity check ────────────────────────────────────
      // Prompt caches are per-model (and per-provider). If auto-routing picks a
      // different model than the previous turn of THIS session, the entire
      // cached prefix is lost on this request — we pay full input price and a
      // fresh cache write. Common triggers: input growth crossing a contextK
      // threshold, an image/video/audio attachment forcing a multimodal model,
      // or a provider cooldown after a timeout. Log it loudly so we can see how
      // often it's happening and what's causing it.
      {
        const _prevModel    = session._autoModel;
        const _prevProvider = session._autoProvider;
        if (_prevModel && (_prevModel !== resolved.model || _prevProvider !== resolved.provider)) {
          const _reasons = [
            _requiresImage ? 'image' : null,
            _requiresVideo ? 'video' : null,
            _requiresAudio ? 'audio' : null,
            _requiresFile  ? 'file'  : null,
            `ctxK≥${_minContextK}`,
            `task=${profile.taskType}`,
            `diff=${profile.difficulty}`,
          ].filter(Boolean).join(', ');
          channel.log(
            'llm',
            `[cache] ⚠ model switch in-session (${agentName || 'agent'}): ` +
            `${_prevProvider}/${_prevModel} → ${resolved.provider}/${resolved.model} ` +
            `— prompt cache LOST this turn [${_reasons}]`
          );
        }
      }

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

    // Build messages from the in-process TurnBuffer (per-slot ContextMemory).
    // toMessages is async — await it.
    const messages = await contextMemory.toMessages({ agent });

    // Track attachments for debug logging
    const _debugAttachPaths = [];

    // ── Resolve message attachments ─────────────────────────────────────────
    // Each message may have `attachments: [{type:'image', path:'/...'}]`.
    // Optimize images and inject as multimodal content via the provider's API format.
    //
    // The images we resolve here are ALSO recorded in `session._lastConsumedImages`
    // so that when the coordinator emits a `delegate` action right after seeing
    // them, the propagation path in agent.js (line ~3115 → 5430) can forward the
    // bytes to the delegate. Without this, the delegate's LLM only sees the
    // textual `[Attached images: …]` hint but never the actual pixels.
    const _resolvedUserImages = [];
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
        const audioAtts = msg.attachments.filter(a =>
          a.type === 'audio' && a.path && fs.existsSync(a.path)
        );

        // Remove attachments field (LLM API doesn't understand it)
        delete msg.attachments;

        if (imageAtts.length === 0 && audioAtts.length === 0) continue;

        const textContent = typeof msg.content === 'string' ? msg.content
          : Array.isArray(msg.content) ? (msg.content.find(p => p.type === 'text')?.text ?? '') : '';

        const imageParts = imageAtts.length === 0 ? [] : (await Promise.all(
          imageAtts.map(async a => {
            const opt = await _optimizeImage(a.path);
            return opt ? { ...opt, path: a.path } : null;
          })
        )).filter(Boolean);

        // Audio attachments on the CURRENT prompt are sent natively in THIS turn
        // (no separate read_file needed), as `input_audio` blocks on the same
        // message — exactly like an image attachment becomes vision. Only for
        // providers that take raw audio bytes; otherwise leave the text path (the
        // agent can still transcribe). Non-mp3/wav (Telegram voice = OGG/Opus) is
        // transcoded to mp3 first.
        const _audioCapable =
          this.provider === 'gemini' || this.provider === 'openrouter' || this.provider === 'gateway';
        let audioParts = [];
        if (audioAtts.length > 0 && _audioCapable) {
          const { loadAudioBlock } = await import('./attach-audio.js');
          audioParts = (await Promise.all(
            audioAtts.map(async a => {
              const r = await loadAudioBlock(a.path);
              return r.ok ? r : null;
            })
          )).filter(Boolean);
        } else if (audioAtts.length > 0) {
          channel.log('llm', `[audio] prompt has audio but provider=${this.provider} can't take raw audio — left for transcription`);
        }

        if (imageParts.length === 0 && audioParts.length === 0) continue;

        if (this.provider === 'anthropic') {
          // Anthropic chat takes images but not raw audio — audio (if any) was
          // already skipped above for this provider.
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
              })),
              ...audioParts.map(a => ({
                type: 'input_audio', input_audio: { data: a.data, format: a.format }
              })),
            ]
          };
        }
        if (imageParts.length > 0) {
          _debugAttachPaths.push(...imageParts.map(p => p.path));
          // Record for delegate propagation. Shape matches `_pendingMcpImages`
          // entries so the delegate's reactive loop can re-inject them
          // verbatim (see agent.js:1470 and llm-provider.js:1640+).
          for (const p of imageParts) {
            _resolvedUserImages.push({
              data: p.b64,
              mimeType: p.mime,
              _debugPath: p.path,
              role: 'user_attachment',
            });
          }
        }
        if (audioParts.length > 0) {
          try {
            channel.log('llm', `[audio] attaching ${audioParts.length} prompt audio clip(s) to ${this.provider} request → ${audioParts.map(a => `${(a.path || '').split('/').pop()} (${a.format})`).join(', ')}`);
          } catch { /* */ }
        }
      }
    }

    // Stash for delegate propagation. The coordinator may emit a delegate
    // action this turn — agent.js reads `session._lastConsumedImages` at
    // the dispatch point and forwards it onto the delegate's
    // `_pendingImagesToPropagate`. Only set when we genuinely resolved
    // images, so we don't overwrite an MCP-tool image set further down.
    if (_resolvedUserImages.length > 0) {
      const _canDelegateUserImg = agent?.hasPermission?.('delegate');
      if (_canDelegateUserImg) {
        const prev = Array.isArray(session._lastConsumedImages) ? session._lastConsumedImages : [];
        session._lastConsumedImages = [...prev, ..._resolvedUserImages];
      }
    }

    // Sticky vision: re-hydrate the turn's vision images when nothing fresh is
    // queued, so the model keeps SEEING them across the iterations of the SAME
    // turn (get_tool_info round-trips, retries, model switches) — not just the
    // single call right after read_file. Without this, tool-injected vision was
    // a strict one-shot: a successful intermediate step (e.g. get_tool_info)
    // dropped the images, and the call that did the real work (building a
    // storyboard) — often after a timeout → model switch — ran BLIND. Bounded by
    // a budget so we never re-send the bytes forever.
    let _stickyRehydrated = false;
    if ((!session._pendingMcpImages || session._pendingMcpImages.length === 0)
        && session._stickyVision?.images?.length && session._stickyVision.budget > 0) {
      session._pendingMcpImages = [...session._stickyVision.images];
      session._stickyVision.budget -= 1;
      _stickyRehydrated = true;
    }

    // Inject MCP tool image results (e.g. get_screenshot) as multimodal content blocks.
    // Inject images into the LLM call so the agent can see them.
    // Coordinators also need vision to look at images before deciding who to delegate to.
    // Images are ALSO preserved for propagation to delegates.
    // NOTE: `_pendingMcpImages` is a legacy name — it holds ALL tool-injected
    // vision (read_file, get_screenshot, MCP tool images), not just MCP ones.
    if (session._pendingMcpImages?.length > 0) {
      // Defensive payload-size cap: every modern vision endpoint enforces
      // a per-request payload ceiling (Gemini ~20 MB, OpenAI ~20 MB,
      // Claude ~5 MB per image). When a user (or the agent in parallel)
      // calls `read_file` on multiple just-generated images, the
      // accumulated base64 can blow past 25 MB and the gateway returns
      // 413 "Payload Too Large" — the agent retries the same payload
      // and loops forever.
      //
      // `read_file` already runs every image through the vision-tuned
      // normaliser (max edge 2048, JPEG q=85), so this cap should never
      // fire in practice. But leaving the door open for callers that
      // pushed raw bytes (legacy paths, custom MCP tools, future
      // additions) — the cap drops the OLDEST images first until the
      // total fits, with a loud log so the user can trace why some
      // images were skipped.
      const _MAX_VISION_BYTES = 25 * 1024 * 1024;
      try {
        const imgs = session._pendingMcpImages;
        let totalBytes = 0;
        for (const p of imgs) totalBytes += Math.round(((p?.data?.length || 0) * 3) / 4);
        if (totalBytes > _MAX_VISION_BYTES) {
          // Drop oldest entries (front of array) until we fit. Newest
          // attachments are usually the most relevant — if the agent
          // just queued a screenshot for "look at this", that should
          // win over a stale annotation overlay from earlier in the
          // turn.
          const dropped = [];
          while (imgs.length > 1 && totalBytes > _MAX_VISION_BYTES) {
            const removed = imgs.shift();
            const removedBytes = Math.round(((removed?.data?.length || 0) * 3) / 4);
            totalBytes -= removedBytes;
            dropped.push({ path: removed?._debugPath || '(unknown)', bytes: removedBytes });
          }
          if (dropped.length > 0) {
            const fmtMb = (n) => (n / (1024 * 1024)).toFixed(1);
            channel.log(
              'llm',
              `[vision] payload exceeded ${fmtMb(_MAX_VISION_BYTES)} MB — dropped ${dropped.length} oldest image(s) to fit: ${dropped.map((d) => `${(d.path.split('/').pop() || '?')} (${fmtMb(d.bytes)}MB)`).join(', ')}`,
            );
          }
        }
      } catch { /* cap is best-effort, never block the call */ }

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
        // Open a sticky window so these images survive the next few iterations of
        // THIS turn (see the re-hydrate block above). Only when they're FRESH —
        // don't reset the budget when we're merely re-attaching an already-sticky
        // set, or the window would never close.
        if (!_stickyRehydrated) {
          session._stickyVision = { images: [...session._pendingMcpImages], budget: 6 };
        }
        session._pendingMcpImages = null;
      }
    }

    // Inject MCP tool video results (e.g. read_file on an mp4) as
    // multimodal content blocks. OpenRouter exposes a `video_url`
    // content type for compatible models — see
    // https://openrouter.ai/docs/guides/overview/multimodal/videos.
    // Anthropic / OpenAI chat APIs do NOT accept raw video bytes, so we
    // skip the injection entirely for those providers (the action that
    // queued the video should have set _hasVideoAttachments → the auto-
    // selector picks a model with inputVideo:true, i.e. Gemini, before
    // we get here; if the user pinned a non-video provider we leave the
    // text path through as-is and the agent sees the description but
    // not the bytes).
    if (session._pendingMcpVideos?.length > 0) {
      const _videos = session._pendingMcpVideos;
      const _supportsVideoUrl =
        this.provider === 'gemini' ||
        this.provider === 'openrouter' ||
        this.provider === 'gateway';
      if (_supportsVideoUrl) {
        const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
        if (lastUserIdx >= 0) {
          const existing = messages[lastUserIdx].content;
          const textContent = typeof existing === 'string'
            ? existing
            : Array.isArray(existing)
              ? existing.find((p) => p.type === 'text')?.text ?? ''
              : '';
          const videoBlocks = _videos.flatMap((v) => {
            const blocks = [];
            if (v.caption) blocks.push({ type: 'text', text: v.caption });
            blocks.push({
              type: 'video_url',
              video_url: { url: `data:${v.mimeType};base64,${v.data}` },
            });
            return blocks;
          });
          // Append at the END of the last user message — same order as
          // images for consistency in the multimodal payload.
          if (Array.isArray(existing)) {
            messages[lastUserIdx] = {
              role: 'user',
              content: [...existing, ...videoBlocks],
            };
          } else {
            messages[lastUserIdx] = {
              role: 'user',
              content: [
                { type: 'text', text: textContent },
                ...videoBlocks,
              ],
            };
          }
          try {
            const _attachReport = _videos.map((v, i) => {
              const kb = Math.round(((v.data?.length || 0) * 3 / 4) / 1024);
              const file = (v._debugPath || '').split('/').pop() || `vid-${i}`;
              return `${file} (${v.mimeType || 'video'}, ${kb}KB)`;
            }).join(', ');
            channel.log(
              'llm',
              `[vision] attaching ${_videos.length} video(s) to ${this.provider} request → ${_attachReport}`,
            );
          } catch { /* logging is best-effort */ }
        }
      } else {
        channel.log(
          'llm',
          `[vision] skipping video attach — provider=${this.provider} does not accept raw video bytes via video_url`,
        );
      }
      // Snapshot for the catch-retry path so the next attempt can re-
      // inject the same bytes if this call fails (e.g. provider rejects
      // the payload, transient 5xx, …). Cleared on successful return.
      session._consumedVideosThisCall = [...session._pendingMcpVideos];
      session._pendingMcpVideos = null;
    }

    // Inject audio results (read_file on an .mp3/.ogg/…, a Telegram voice note,
    // etc.) as native `input_audio` content blocks. OpenRouter exposes the
    // `input_audio` content type for audio-capable models — the auto-selector
    // already picked a model with inputAudio:true (Gemini) because the queuing
    // side set `_hasAudioAttachments`. Anthropic / OpenAI-chat don't accept raw
    // audio bytes, so we skip the injection for them (the caller's transcribe
    // fallback handles those).
    // Re-inject this turn's voice-note audio on EVERY call of the turn. The
    // first call consumes + nulls `_pendingMcpAudios`; `_turnAudios` is the
    // turn-scoped copy (cleared by markTurnStart on the next user message), so
    // restoring from it here keeps the spoken instructions in front of the
    // model across an ack→answer multi-call turn instead of vanishing after
    // call #1.
    if (!session._pendingMcpAudios?.length && session._turnAudios?.length) {
      session._pendingMcpAudios = [...session._turnAudios];
    }
    if (session._pendingMcpAudios?.length > 0) {
      const _audios = session._pendingMcpAudios;
      const _supportsAudio =
        this.provider === 'gemini' ||
        this.provider === 'openrouter' ||
        this.provider === 'gateway';
      if (_supportsAudio) {
        const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
        if (lastUserIdx >= 0) {
          const existing = messages[lastUserIdx].content;
          const textContent = typeof existing === 'string'
            ? existing
            : Array.isArray(existing)
              ? existing.find((p) => p.type === 'text')?.text ?? ''
              : '';
          const audioBlocks = _audios.flatMap((a) => {
            const blocks = [];
            if (a.caption) blocks.push({ type: 'text', text: a.caption });
            // OpenRouter/OpenAI audio shape: raw base64 + short format, NO data: URI.
            blocks.push({ type: 'input_audio', input_audio: { data: a.data, format: a.format } });
            return blocks;
          });
          if (Array.isArray(existing)) {
            messages[lastUserIdx] = { role: 'user', content: [...existing, ...audioBlocks] };
          } else {
            messages[lastUserIdx] = {
              role: 'user',
              content: [{ type: 'text', text: textContent }, ...audioBlocks],
            };
          }
          try {
            const _attachReport = _audios.map((a, i) => {
              const kb = Math.round(((a.data?.length || 0) * 3 / 4) / 1024);
              const file = (a._debugPath || '').split('/').pop() || `aud-${i}`;
              return `${file} (${a.format || 'audio'}, ${kb}KB)`;
            }).join(', ');
            channel.log('llm', `[audio] attaching ${_audios.length} audio clip(s) to ${this.provider} request → ${_attachReport}`);
          } catch { /* logging is best-effort */ }
        }
      } else {
        channel.log('llm', `[audio] skipping audio attach — provider=${this.provider} does not accept raw audio bytes via input_audio`);
      }
      session._consumedAudiosThisCall = [...session._pendingMcpAudios];
      session._pendingMcpAudios = null;
    }

    // Prune image blocks from all messages EXCEPT the last user message.
    // This prevents old screenshots from accumulating in the conversation
    // (e.g. from merged multimodal messages or batched image results).
    // User-provided images are always in the last user message, so they're preserved.
    {
      const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
      let _pruned = 0;
      let _prunedVideos = 0;
      let _prunedAudios = 0;
      for (let i = 0; i < messages.length; i++) {
        if (i === lastUserIdx) continue; // keep current images / videos / audio
        const c = messages[i].content;
        if (!Array.isArray(c)) continue;
        const hasMedia = c.some(p => p.type === 'image' || p.type === 'image_url' || p.type === 'video_url' || p.type === 'input_audio');
        if (!hasMedia) continue;
        // Strip image / video / audio blocks, keep text
        const textOnly = c.filter(p => p.type === 'text');
        const imgCount = c.filter(p => p.type === 'image' || p.type === 'image_url').length;
        const vidCount = c.filter(p => p.type === 'video_url').length;
        const audCount = c.filter(p => p.type === 'input_audio').length;
        _pruned += imgCount;
        _prunedVideos += vidCount;
        _prunedAudios += audCount;
        const textContent = textOnly.map(p => p.text).join('\n');
        const note = [
          imgCount > 0 ? `${imgCount} image(s)` : null,
          vidCount > 0 ? `${vidCount} video(s)` : null,
          audCount > 0 ? `${audCount} audio clip(s)` : null,
        ].filter(Boolean).join(', ');
        messages[i] = { role: messages[i].role, content: textContent + ` [${note} pruned]` };
      }
      if ((_pruned > 0 || _prunedVideos > 0 || _prunedAudios > 0) && process.env.KOI_DEBUG_LLM) {
        console.error(`[media-prune] Stripped ${_pruned} image(s) + ${_prunedVideos} video(s) + ${_prunedAudios} audio clip(s) from conversation history`);
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
    let _spState = 'init';       // 'init' | 'streaming' | 'done' | 'skip'
    let _spBuf = '';             // accumulated raw YAML text of the response
    let _spEmittedLen = 0;       // chars of the decoded print message already streamed
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

    // Decode a YAML double-quoted scalar starting at buf[from] === '"'.
    // Returns { text, terminated }. `terminated` = the closing quote arrived.
    const _decodeDQuote = (buf, from) => {
      let out = '';
      for (let i = from + 1; i < buf.length; i++) {
        const c = buf[i];
        if (c === '\\') {
          const n = buf[i + 1];
          if (n === undefined) break;              // escape split across chunks — wait
          if (n === 'n') out += '\n';
          else if (n === 't') out += '\t';
          else if (n === 'r') out += '\r';
          else if (n === '"') out += '"';
          else if (n === '\\') out += '\\';
          else if (n === '/') out += '/';
          else if (n === 'u') {
            const hex = buf.substr(i + 2, 4);
            if (hex.length < 4) { i = buf.length; break; } // \uXXXX incomplete — wait
            out += String.fromCharCode(parseInt(hex, 16) || 0);
            i += 4;
          } else out += n;
          i += 1;
          continue;
        }
        if (c === '"') return { text: out, terminated: true };
        out += c;
      }
      return { text: out, terminated: false };
    };

    // Decode a YAML single-quoted scalar starting at buf[from] === "'".
    // In single-quoted YAML the only escape is '' → a literal '.
    const _decodeSQuote = (buf, from) => {
      let out = '';
      for (let i = from + 1; i < buf.length; i++) {
        const c = buf[i];
        if (c === "'") {
          if (buf[i + 1] === "'") { out += "'"; i += 1; continue; } // '' → '
          if (buf[i + 1] === undefined) return { text: out, terminated: false };
          return { text: out, terminated: true };
        }
        out += c;
      }
      return { text: out, terminated: false };
    };

    // Incrementally decode a `print` action's `message` straight from the raw
    // YAML token stream so the user sees it appear live. Recompute-and-diff:
    // re-derive the full decoded message-so-far from the buffer each chunk and
    // emit only the new tail. Handles the scalar styles the agent uses for
    // `message`: block (`|`/`>`), double-quoted, single-quoted and plain.
    // Returns { status:'undecided' | 'skip' | 'go', text?, terminated? }.
    const _extractYamlPrint = (buf) => {
      // 1) intent — only trust a COMPLETE intent line (one that ends in \n),
      // so we never decide on a half-streamed value. Matches `intent: print`,
      // `- intent: print`, quoted forms, and a trailing # comment.
      const im = buf.match(
        /(?:^|\n)[ \t]*-?[ \t]*intent[ \t]*:[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\r\n#]*?))[ \t]*(?:#[^\r\n]*)?\r?\n/,
      );
      if (!im) return buf.length > 600 ? { status: 'skip' } : { status: 'undecided' };
      const intentVal = (im[1] ?? im[2] ?? im[3] ?? '').trim();
      if (intentVal !== 'print') return { status: 'skip' };

      // 2) the `message:` key line — capture its indent and inline remainder.
      const mm = buf.match(/(?:^|\n)([ \t]*)message[ \t]*:[ \t]*([^\r\n]*)(\r?\n|$)/);
      if (!mm) return buf.length > 8000 ? { status: 'skip' } : { status: 'undecided' };
      const keyIndent = mm[1].length;
      const rest = mm[2];
      const restEndsLine = mm[3] === '\n' || mm[3] === '\r\n';
      const restTrim = rest.trim();
      const restStart = mm.index + mm[0].length - mm[3].length - rest.length;

      // 3) block scalar `|` / `>` (with optional chomping/indent indicators)
      if (/^[|>][+\-]?\d*$/.test(restTrim)) {
        if (!restEndsLine) return { status: 'go', text: '', terminated: false };
        const contentStart = restStart + rest.length + mm[3].length;
        const endsWithNL = buf.endsWith('\n');
        const rawLines = buf.slice(contentStart).split('\n');
        // block indent = indentation of the first non-empty content line
        let blockIndent = -1;
        for (const ln of rawLines) {
          if (ln.trim() === '') continue;
          blockIndent = ln.length - ln.trimStart().length;
          break;
        }
        if (blockIndent === -1) return { status: 'go', text: '', terminated: false };
        if (blockIndent <= keyIndent) return { status: 'go', text: '', terminated: true };
        const complete = [];   // de-indented lines already closed by a \n
        let partial = '';      // de-indented last line still streaming (no \n yet)
        let terminated = false;
        for (let li = 0; li < rawLines.length; li++) {
          const ln = rawLines[li];
          const isPartial = li === rawLines.length - 1 && !endsWithNL;
          if (ln.trim() !== '') {
            const ind = ln.length - ln.trimStart().length;
            if (ind < blockIndent) { if (!isPartial) terminated = true; break; } // dedent ends block
          }
          if (isPartial) partial = ln.slice(blockIndent);
          else complete.push(ln.slice(blockIndent));
        }
        // YAML clips trailing blank lines, but only when nothing is still extending the block.
        if (!partial) while (complete.length && complete[complete.length - 1] === '') complete.pop();
        // Completed lines keep their trailing \n so the renderer flushes each one
        // the instant it lands; the partial line streams on without a \n.
        return { status: 'go', text: complete.map((l) => l + '\n').join('') + partial, terminated };
      }

      // 4) quoted scalars
      if (restTrim.startsWith('"')) {
        const r = _decodeDQuote(buf, buf.indexOf('"', restStart));
        return { status: 'go', text: r.text, terminated: r.terminated };
      }
      if (restTrim.startsWith("'")) {
        const r = _decodeSQuote(buf, buf.indexOf("'", restStart));
        return { status: 'go', text: r.text, terminated: r.terminated };
      }

      // 5) plain scalar — single line (the agent is told to use `|` for
      // multi-line). Strip a trailing # comment and surrounding spaces.
      if (restEndsLine) return { status: 'go', text: restTrim.replace(/[ \t]+#.*$/, ''), terminated: true };
      return { status: 'go', text: restTrim, terminated: false };
    };

    let _complianceAborted = false;

    const _onStreamChunk = (_delta, estOutTokens) => {
      _markContentReceived(); // Real content arrived — cancel total timeout
      _resetTimer();          // Reset inactivity timer
      channel.setInfo('tokens', `↓${_fmtTk(estOutTokens)} tokens`);

      if (_spState === 'done' || _spState === 'skip') return;

      _spBuf += _delta;

      // Early compliance detection: if the model declares it won't comply,
      // abort the stream immediately (saves tokens). YAML form:
      // `user_request_compliance: wont_do`.
      if (!_complianceAborted && /\bwont_do\b/.test(_spBuf)) {
        _complianceAborted = true;
        _spState = 'skip';
        channel.log('llm', `[compliance] Early abort: detected wont_do in stream`);
        return;
      }

      // Recompute the decoded print message-so-far from the raw YAML buffer
      // and stream only the newly-decoded tail through the markdown renderer.
      const _pm = _extractYamlPrint(_spBuf);
      if (_pm.status === 'skip') { _spState = 'skip'; return; }
      if (_pm.status === 'undecided') return;
      if (_spState === 'init') _spState = 'streaming';
      if (_pm.text.length > _spEmittedLen) {
        _lineBuf += _pm.text.slice(_spEmittedLen);
        _spEmittedLen = _pm.text.length;
        _flushLines(false);
      }
      if (_pm.terminated) {
        _flushLines(true);
        _spState = 'done';
        _printStreamed = true;
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
    // TIME-TO-FIRST-CHUNK is much more generous than the inter-chunk gap: a model
    // (esp. Gemini / any thinking-capable one) can buffer / reason internally for
    // a long while before emitting ANYTHING, and that is NOT a stall. The 120s
    // inter-chunk limit was killing valid requests at the "no chunks received"
    // stage. Once data starts flowing, a long gap IS a real stall → revert to
    // the tighter inter-chunk limit.
    const STREAM_FIRST_CHUNK_MS = Math.max(STREAM_INACTIVITY_MS, 240_000);
    const STREAM_FIRST_CHUNK_LABEL = `${STREAM_FIRST_CHUNK_MS / 1000}s`;
    // Hard total timeout: absolute cap for a single LLM call (including thinking).
    // Must accommodate the first-chunk wait PLUS the actual generation.
    const STREAM_TOTAL_MS = STREAM_FIRST_CHUNK_MS + STREAM_INACTIVITY_MS * 2;
    const STREAM_TOTAL_LABEL = `${STREAM_TOTAL_MS / 1000}s`;
    const _inactivityCtrl = new AbortController();
    let _totalTimerFired = false;
    let _anyChunkSeen = false; // false until the first chunk (content or thinking)
    let _inactivityTimer = setTimeout(() => _inactivityCtrl.abort(), STREAM_FIRST_CHUNK_MS);
    const _totalTimer = setTimeout(() => {
      _totalTimerFired = true;
      channel.log('llm', `[stream] TOTAL timeout (${STREAM_TOTAL_LABEL}) — aborting stream`);
      _inactivityCtrl.abort();
    }, STREAM_TOTAL_MS);
    let _firstContentReceived = false;
    let _thinkingTokens = 0; // Accumulated thinking/reasoning tokens (for cost tracking)
    const _resetTimer = () => {
      _anyChunkSeen = true;
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
      // Successful call — drop the retry snapshots so these media don't
      // get re-injected on a future (unrelated) error.
      if (session) {
        session._consumedThisCall = null;
        session._consumedVideosThisCall = null;
        session._consumedAudiosThisCall = null;
      }
    } catch (_callErr) {
      // Restore pending media so the retry re-injects them. Without this,
      // a failed call (e.g. model rejects payload) silently drops the
      // attachment and the next iteration hallucinates about a different
      // image / video.
      if (session?._consumedThisCall?.length && !session._pendingMcpImages?.length) {
        session._pendingMcpImages = [...session._consumedThisCall];
        channel.log('llm', `[auto] Restoring ${session._consumedThisCall.length} image(s) after LLM error for retry`);
      }
      if (session?._consumedVideosThisCall?.length && !session._pendingMcpVideos?.length) {
        session._pendingMcpVideos = [...session._consumedVideosThisCall];
        channel.log('llm', `[auto] Restoring ${session._consumedVideosThisCall.length} video(s) after LLM error for retry`);
      }
      if (session?._consumedAudiosThisCall?.length && !session._pendingMcpAudios?.length) {
        session._pendingMcpAudios = [...session._consumedAudiosThisCall];
        channel.log('llm', `[auto] Restoring ${session._consumedAudiosThisCall.length} audio clip(s) after LLM error for retry`);
      }
      // Resolve which model actually handled this call so the per-model
      // cooldown hits the specific failing model (e.g. gemini-3.1-pro-preview)
      // instead of the whole provider.
      const _effModel    = session?._autoModel    || this.model;
      const _effProvider = session?._autoProvider || this.provider;

      // Convert inactivity abort to a recognizable error so agent retry logic kicks in
      // Note: message must contain 'timeout' to match the isTimeout check in agent.js
      if (_inactivityCtrl.signal.aborted && !abortSignal?.aborted) {
        const _timeoutKind = _totalTimerFired
            ? 'total'
            : (_anyChunkSeen ? 'inactivity' : 'first-chunk');
        const _timeoutLabel = _totalTimerFired
            ? STREAM_TOTAL_LABEL
            : (_anyChunkSeen ? STREAM_INACTIVITY_LABEL : STREAM_FIRST_CHUNK_LABEL);
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
        // 401 in gateway mode — could mean either:
        //   (a) The session JWT is dead → we want a re-login.
        //   (b) The gateway's API key for THIS specific upstream provider is
        //       missing/dead, but the JWT itself is fine → we just want to
        //       exclude this provider for the session and retry with another.
        //
        // We can't tell apart from a single 401, so we use the "≥ 2 distinct
        // providers failed" heuristic: in gateway mode every provider shares
        // the same JWT, so if two different providers both 401, the JWT is
        // the common factor. A single 401 falls through to the existing
        // exclusion path (line ~2329), which removes only that provider from
        // the candidate list — preserving the pre-fix behaviour where a
        // transient per-upstream 401 was silently routed around.
        //
        // The OpenAI-compat path wraps 401s into a ProviderBlockedError with
        // no `.status`, so we also check `httpStatus` preserved on the wrap.
        const _blockedStatus = _callErr?.name === 'ProviderBlockedError' ? _callErr.httpStatus : undefined;
        const _is401 = _status === 401 || _blockedStatus === 401;
        if (_is401 && this._gatewayMode) {
          if (!session._gateway401Providers) session._gateway401Providers = new Set();
          session._gateway401Providers.add(this.provider);
          if (session._gateway401Providers.size >= 2) {
            const _s = globalThis.__koiStrings || {};
            channel.log('llm', `[auto] AUTH_EXPIRED — ${session._gateway401Providers.size} distinct providers returned 401 (${[...session._gateway401Providers].join(', ')}); JWT is dead`);
            throw new Error('AUTH_EXPIRED: ' + (_s.authExpired || 'Your session has expired. Please restart and log in again.'));
          }
          channel.log('llm', `[auto] 401 from ${this.provider} — excluding provider, retrying with sibling (JWT may still be valid)`);
        }
        // 413 = payload too large — drop pending images and retry
        // (don't exclude provider). Two flavours:
        //  (a) user attachments uploaded via the chat input bar →
        //      `session._promptAttachments`. Dropping them is fine; the
        //      agent loses access to the user's drag, surfaces that to
        //      the user, retries text-only.
        //  (b) tool-injected vision (read_file, get_screenshot, …) →
        //      `session._consumedThisCall` was just snapshot-pushed
        //      INSTEAD of `_pendingMcpImages` (line ~1604) before the
        //      call, so the next retry would re-push the SAME bytes
        //      and 413 again. Drop both buckets so the retry breaks
        //      out of the loop.
        if (_status === 413) {
          // The catch handler above (line ~2160) already restored the
          // vision snapshot into `_pendingMcpImages` for retry — undo
          // that here too, otherwise the next iteration re-pushes the
          // same oversize bytes and we loop on 413 forever.
          const _atts = session?._promptAttachments?.length || 0;
          const _visPending = session?._pendingMcpImages?.length || 0;
          const _visSnapshot = session?._consumedThisCall?.length || 0;
          if (_atts > 0) session._promptAttachments = null;
          if (_visPending > 0) session._pendingMcpImages = null;
          if (_visSnapshot > 0) session._consumedThisCall = null;
          channel.log(
            'llm',
            `[auto] 413 Payload Too Large — dropped ${_atts} attachment(s) + ${Math.max(_visPending, _visSnapshot)} vision image(s); retrying without bytes`,
          );
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

    // Successful call — reset circuit breaker for this provider and clear
    // any prior 401-from-gateway tracking. A successful call proves the JWT
    // is alive; previous 401s were upstream-key issues, not session expiry.
    if (this._autoMode) clearProviderCooldown(_effectiveProvider);
    if (session._gateway401Providers) session._gateway401Providers.clear();

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

    // If streaming print was active but the scalar wasn't terminated in-stream
    // (e.g. a block scalar that ends at EOF), flush the remaining buffered line
    // and finalize now. Mark _printStreamed so the print action skips its own
    // channel.print() — otherwise it re-emits the whole message at once on top
    // of what we already streamed ("shows the print all at once").
    if (_spState === 'streaming') {
      _flushLines(true);
      _printStreamed = true;
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
