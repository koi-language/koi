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
import { cliLogger } from './cli-logger.js';
import { actionRegistry } from './action-registry.js';
import { classifyFeedback, classifyResponse } from './context-memory.js';
import { costCenter, getModelCaps } from './cost-center.js';
import { renderLine, renderTable } from './cli-markdown.js';
import { resolve as resolveModel, createLLM, createEmbedding, getEmbeddingDimension, DEFAULT_TASK_PROFILE, getAvailableProviders, loadRemoteModels, markProviderTimeout, clearProviderCooldown } from './providers/factory.js';

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
function _truncB64Debug(str) {
  return str.replace(/[A-Za-z0-9+/]{60,}={0,2}/g, m => `${m.slice(0, 20)}\u2026${m.slice(-10)}`);
}

// Default models per provider
const DEFAULT_MODELS = {
  openai:    'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-6',
  gemini:    'gemini-2.0-flash',
};

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
    this.maxTokens = config.max_tokens || 8000; // Increased to avoid truncation of long responses
    this._useThinking = false; // Set to true by auto-selector when thinking variant wins

    // ── koi-cli.ai account mode: route all LLM calls through the gateway ──────
    // The gateway is OpenAI-compatible and handles provider selection server-side.
    // No need to hardcode providers — they come dynamically from GET /gateway/models.
    // Production: https://api.koi-cli.ai/gateway  Local: http://localhost:3000/gateway
    if (process.env.KOI_AUTH_TOKEN) {
      const apiBase = process.env.KOI_API_URL || 'http://localhost:3000';
      const gatewayBase = apiBase + '/gateway';
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
      // Start with common providers as fallback — syncGatewayProviders() will
      // replace this with the actual list from the backend (fully dynamic).
      this._availableProviders = ['openai', 'anthropic', 'gemini'];
      // Fire async sync (non-blocking — updates _availableProviders from backend)
      this.syncGatewayProviders();
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
    this.model = model || DEFAULT_MODELS[this.provider];

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
   * Fetch available providers from the koi-cli.ai gateway and update
   * _availableProviders accordingly. Called at startup and on 400 errors
   * (e.g. "key not configured") to re-sync.
   */
  async syncGatewayProviders() {
    if (!process.env.KOI_AUTH_TOKEN) return;

    // Load models from backend — this populates the auto-model-selector with
    // the actual active models. getAvailableProviders() then returns providers
    // dynamically from whatever the backend sent (no hardcoded list needed).
    await loadRemoteModels();
    const providers = getAvailableProviders();
    if (providers.length > 0) {
      this._availableProviders = providers;
      cliLogger.log('llm', `[gateway] Available providers: ${providers.join(', ')}`);
    } else {
      cliLogger.log('llm', '[gateway] No providers found — using fallback list');
    }
  }

  // =========================================================================
  // API KEY MANAGEMENT — lazy client initialization
  // =========================================================================

  /**
   * Ensure all required clients are ready before making any LLM call.
   * Prompts the user for missing API keys, saves them to .env, and creates clients.
   */
  async _ensureClients() {
    if (this._autoMode) {
      if (this._lockedProvider) {
        await this._ensureLockedProviderClient();
      } else {
        await this._ensureAnyProvider();
      }
    } else {
      await this._ensureExplicitClient();
    }
  }

  /**
   * For auto mode with no locked provider: ensure at least one provider client exists.
   * If none are configured, let the user pick a provider and enter the key.
   */
  async _ensureAnyProvider() {
    if (this._availableProviders.length > 0) return;
    // Gateway mode: all providers are available via the koi-cli.ai backend
    if (this._koiGateway) return;

    const { cliLogger } = await import('./cli-logger.js');
    const { cliSelect } = await import('./cli-select.js');
    const { ensureApiKey } = await import('./api-key-manager.js');

    cliLogger.print('No API key configured. Select a provider to use:');
    const provider = await cliSelect('Select provider', [
      { title: 'OpenAI (GPT-4o, GPT-4o-mini…)', value: 'openai' },
      { title: 'Anthropic (Claude Sonnet, Haiku…)', value: 'anthropic' },
      { title: 'Google Gemini (gemini-2.0-flash…)', value: 'gemini' },
    ]);

    if (!provider) throw new Error('No provider selected — cannot continue without an API key');

    const apiKey = await ensureApiKey(provider);

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
  async _ensureLockedProviderClient() {
    const p = this._lockedProvider;
    const hasClient = (p === 'openai' && this._oa) ||
                      (p === 'anthropic' && this._ac) ||
                      (p === 'gemini' && this._gc);
    if (hasClient) return;

    const { ensureApiKey } = await import('./api-key-manager.js');
    const apiKey = await ensureApiKey(p);

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
  async _ensureExplicitClient() {
    if (this.openai || this.anthropic) return;

    const { ensureApiKey } = await import('./api-key-manager.js');
    const apiKey = await ensureApiKey(this.provider);

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
      ...opts,
    });
  }

  /**
   * Format text for debug output with gray color.
   * Truncates long base64-like payloads so they don't flood the console.
   */
  formatDebugText(text) {
    const str = Array.isArray(text)
      ? text.map(p => p.type === 'text' ? p.text : `[${p.type}]`).join('\n')
      : String(text ?? '');
    const lines = _truncB64Debug(str).split('\n');
    return lines.map(line => `> \x1b[90m${line}\x1b[0m`).join('\n');
  }

  /**
   * Log LLM request (system + user prompts)
   */
  logRequest(model, systemPrompt, userPrompt, context = '') {
    if (process.env.KOI_DEBUG_LLM !== '1') return;

    console.error('─'.repeat(80));
    console.error(`[LLM Debug] Request - Model: ${model}${context ? ' | ' + context : ''}`);
    console.error('System Prompt:');
    console.error(this.formatDebugText(systemPrompt));
    console.error('============');
    console.error('User Prompt:');
    console.error('============');
    console.error(this.formatDebugText(userPrompt));
    console.error('─'.repeat(80));
  }

  /**
   * Log LLM response
   */
  logResponse(content, context = '') {
    if (process.env.KOI_DEBUG_LLM !== '1') return;

    console.error(`\n[LLM Debug] Response${context ? ' - ' + context : ''} (${content.length} chars)`);
    console.error('─'.repeat(80));

    // Try to format JSON for better readability
    let formattedContent = content;
    try {
      const parsed = JSON.parse(content);
      formattedContent = JSON.stringify(parsed, null, 2);
    } catch (e) {
      // Not JSON, use as is
    }

    const lines = _truncB64Debug(formattedContent).split('\n');
    for (const line of lines) {
      console.error(`< \x1b[90m${line}\x1b[0m`);
    }
    console.error('─'.repeat(80));
  }

  /**
   * Log simple message
   */
  logDebug(message) {
    if (process.env.KOI_DEBUG_LLM !== '1') return;
    console.error(`[LLM Debug] ${message}`);
  }

  /**
   * Log error
   */
  logError(message, error) {
    if (process.env.KOI_DEBUG_LLM !== '1') return;
    console.error(`[LLM Debug] ERROR: ${message}`);
    if (error) {
      console.error(error.stack || error.message);
    }
  }

  /**
   * Simple chat completion for build-time tasks (descriptions, summaries).
   * No system prompt injection, no JSON mode, with timeout.
   */
  async simpleChat(prompt, { timeoutMs = 15000 } = {}) {
    await this._ensureClients();
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
      // Force best model per provider for planning
      const planModels = { openai: 'gpt-5.2', anthropic: 'claude-3-haiku-20240307', gemini: 'gemini-2.0-flash' };
      const _planProvider = this._effectiveLLMProvider || this.provider;
      const planModel = planModels[this.provider] || this.model;
      const llm = createLLM(_planProvider, this._getClient(_planProvider), planModel, { temperature: 0, maxTokens: 800 });

      const { text } = await llm.complete([
        { role: 'system', content: 'Planning assistant. JSON only.' },
        { role: 'user', content: prompt }
      ]);
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Planning failed: ${error.message}`);
    }
  }


  /**
   * Classify a task using the fastest/cheapest available model.
   * Returns { taskType: 'code'|'planning'|'reasoning', difficulty: 1-10 }.
   * Falls back to keyword heuristic if the LLM call fails.
   */
  async _inferTaskProfile(playbookText, args, agentName) {
    const taskDescription = [
      agentName ? `Agent: ${agentName}` : '',
      playbookText ? `Role: ${playbookText}` : '',
      args ? 'Task: ' + JSON.stringify(args).substring(0, 400) : '',
    ].filter(Boolean).join('\n');

    const prompt = `Reply ONLY with valid JSON (no markdown in the output):
{"taskType":"code"|"planning"|"reasoning","difficulty":1-10}

## TASK TYPE

- **"code"**: writing, editing, debugging, refactoring, analysing or generating code, scripts, queries, configs, tests, or file operations. Includes implementation tasks even if design is required. **Also includes exploring, navigating, searching, or reading a codebase** — any task that requires understanding source code to produce results, even if no code is written. An agent named "Explorer" or tasked with "find where X is implemented" is ALWAYS "code".
- **"planning"**: system design, architecture, task decomposition, requirement analysis, specifications, workflows or strategy definition — when NO code is produced.
- **"reasoning"**: logic, math, research, classification, summarisation, comparison, or conceptual analysis that does NOT involve reading or understanding source code.

If multiple apply, choose the dominant expected output. Producing code → always "code". Reading/exploring code → always "code".

## DIFFICULTY

Code tasks are inherently complex. Most real programming tasks are 7+.

- **1-2 trivial** — echo a value, list files, read a single config key
- **3-4 easy** — change a string/label/constant, rename a variable, fix a typo, add a log line
- **5-6 moderate** — implement a self-contained function or script with no existing codebase to understand; build a simple landing page or basic CRUD app from scratch
- **7 standard** — ANY task that requires reading and understanding existing code before making changes; add a feature to an existing module; fix a non-obvious bug in an existing system; integrate a new library into an existing project
- **8 hard** — multi-file refactor; changes that ripple across several modules; implement a non-trivial algorithm; debug a subtle race condition or state issue; design and implement a new subsystem within an existing architecture
- **9-10 legendary (rare)** — distributed systems, compilers, cryptography, kernel/low-level, novel research, formal proofs

**KEY RULE**: if the agent must first explore or read the codebase to understand context, minimum difficulty is 7. Greenfield code (no existing codebase) may be 5-6.

## ADJUSTMENTS

Increase difficulty (+1 to +2) if:
- High ambiguity or underspecified requirements
- Security-sensitive logic
- Strict correctness guarantees or complex edge cases
- Concurrency, distributed state, or performance-critical constraints

Default to **7** for code tasks when unsure.
Use **9-10** only for genuinely expert-level tasks.

## PROGRAMMING EXAMPLES

**6** — Add a loading spinner to existing API calls without breaking layout · Fix a mobile CSS overflow issue in a production page · Add client-side form validation to an existing form · Implement pagination in an already working list view · Add sorting to a table component · Extract duplicated frontend logic into a shared utility · Add a confirmation modal before delete actions · Introduce basic unit tests into an untested component · Add debouncing to a search input · Fix a minor state synchronization bug

**7** — Refactor a 500+ LOC React component into smaller components · Introduce TypeScript gradually into a JS frontend · Fix a race condition in concurrent API requests · Add optimistic UI updates with rollback on failure · Implement code splitting to reduce bundle size · Add JWT authentication middleware to an API · Optimize a slow SQL query with proper indexing · Implement rate limiting using Redis · Add background job processing with retry logic · Containerize an existing application with Docker

**8** — Migrate class-based React components to hooks · Remove jQuery from a legacy frontend without regressions · Improve Lighthouse score from 60 to 90+ · Add full accessibility compliance (WCAG AA) · Introduce caching layer without breaking consistency · Implement distributed locking mechanism · Design a plugin system with dynamic module loading · Implement SSR with proper hydration handling · Add observability (logs + metrics + tracing) to a backend · Build a GraphQL gateway aggregating multiple services

**9** — Replace REST calls with GraphQL in a production frontend · Design event-driven architecture with outbox pattern · Implement idempotent webhook processing · Build a real-time dashboard using WebSockets · Implement deep linking with routing + attribution (mobile) · Design zero-downtime database migration strategy · Build a scalable ETL pipeline with incremental loads · Implement collaborative editing backend (presence + patches) · Introduce multi-tenant isolation with per-tenant encryption · Implement vector search with embeddings + reranking

**10** — Implement a CRDT for distributed state synchronization · Build a distributed task scheduler with fault tolerance · Design a multi-tenant architecture with strict isolation guarantees · Implement end-to-end encrypted messaging protocol · Build a horizontally scalable API gateway with dynamic routing · Create a static code analyzer with AST parsing and rule engine · Implement a custom ORM abstraction layer · Design a distributed tracing system from scratch · Build a micro-frontend platform with shared runtime · Implement a fault-tolerant distributed queue with exactly-once semantics

---

Classify the following task:
${taskDescription}`;

    const _debug = !!process.env.KOI_DEBUG_LLM;

    // Ordered fallback candidates for classification (cheapest/fastest first)
    const _candidates = [
      ...(this._gc ? [
        { client: this._gc, model: 'gemini-2.0-flash', provider: 'gemini' },
      ] : []),
      ...(this._oa ? [{ client: this._oa, model: 'gpt-4o-mini', provider: 'openai' }] : []),
      ...(this._ac ? [{ client: null, model: 'claude-haiku-4-5-20251001', provider: 'anthropic' }] : []),
    ];

    if (_candidates.length === 0) {
      if (_debug) console.error(`[Auto] No client for classification — using default profile`);
      return DEFAULT_TASK_PROFILE;
    }

    const _timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms));

    // Skip classification for startup (empty args) — no task to classify yet
    const _hasTask = args && Object.keys(args).length > 0;
    if (!_hasTask) {
      if (_debug) console.error(`[Auto] No task args — using default profile`);
      return DEFAULT_TASK_PROFILE;
    }

    for (const candidate of _candidates) {
      if (_debug) console.error(`[Auto] Classifying with ${candidate.model}...`);
      try {
        const llm = createLLM(candidate.provider, candidate.client || this._ac, candidate.model, { temperature: 0, maxTokens: 50 });
        const apiCall = llm.complete([{ role: 'user', content: prompt }]).then(r => r);
        const { text: content, usage: _u } = await Promise.race([apiCall, _timeout(3000)]);
        const inputTokens = _u.input || 0, outputTokens = _u.output || 0;
        costCenter.recordUsage(candidate.model, candidate.provider, inputTokens, outputTokens);
        if (_debug) console.error(`[Auto] Classification: ${content} (${inputTokens}↑ ${outputTokens}↓)`);
        const _stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const json = JSON.parse(_stripped);
        if (json.taskType && json.difficulty) {
          const profile = { taskType: json.taskType, difficulty: Math.min(10, Math.max(1, Number(json.difficulty))) };
          if (_debug) console.error(`[Auto] Profile: ${profile.taskType} difficulty=${profile.difficulty}/10`);
          return profile;
        }
        if (_debug) console.error(`[Auto] Invalid shape from ${candidate.model}, trying next...`);
      } catch (e) {
        if (_debug) console.error(`[Auto] ${candidate.model} failed: ${e.message} — trying next...`);
      }
    }
    if (_debug) console.error(`[Auto] All candidates failed — using default profile`);
    return DEFAULT_TASK_PROFILE;
  }

  /**
   * Lightweight JSON call: send a prompt, get parsed JSON back.
   * No system prompt injection, no streaming, no onAction.
   */
  async callJSON(prompt, agent = null, opts = {}) {
    await this._ensureClients();
    const agentName = agent?.name || '';
    if (!opts.silent) cliLogger.planning(agentName ? `🤖 \x1b[1m\x1b[38;2;173;218;228m${agentName}\x1b[0m \x1b[38;2;185;185;185mThinking\x1b[0m` : 'Thinking');

    this.logRequest(this.model, 'Return ONLY valid JSON.', prompt, agentName ? `callJSON | Agent: ${agentName}` : 'callJSON');

    const _cjProvider = this._autoMode ? this._availableProviders[0] : this.provider;
    const _cjModel    = this._autoMode ? (DEFAULT_MODELS[_cjProvider] || this._availableProviders[0]) : this.model;
    const _cjClient   = this._getClient(_cjProvider);

    let response;
    try {
      const llm = createLLM(_cjProvider, _cjClient, _cjModel, { temperature: 0, maxTokens: this.maxTokens });
      const { text } = await llm.complete([
        { role: 'system', content: 'Return ONLY valid JSON. No markdown, no explanations.' },
        { role: 'user', content: prompt }
      ], { responseFormat: 'json_object' });
      response = text;

      if (!opts.silent) cliLogger.clear();
      this.logResponse(response, 'callJSON');

      if (!response) return { result: '' };

      // Clean markdown code blocks if present
      let cleaned = response;
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^\`\`\`(?:json)?\n?/, '').replace(/\n?\`\`\`$/, '').trim();
      }

      return JSON.parse(cleaned);
    } catch (error) {
      if (!opts.silent) cliLogger.clear();
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
    await this._ensureClients();

    const planningPrefix = agentName ? `🤖 \x1b[1m\x1b[38;2;173;218;228m${agentName}\x1b[0m` : '';

    // For non-auto mode the model is fixed — show it right away (before LLM call)
    if (!this._autoMode) cliLogger.setInfo('model', this.model);

    const _hint = thinkingHint || 'Thinking';
    cliLogger.planning(planningPrefix ? `${planningPrefix} \x1b[38;2;185;185;185m${_hint}\x1b[0m` : _hint);
    cliLogger.log('llm', `Reactive call: ${agentName} (iteration ${session.iteration + 1}, firstCall=${isFirstCall})`);

    // Age memories each iteration
    await contextMemory.tick();

    // Rebuild the system prompt when:
    // - First call or no history yet (fresh/resumed session), OR
    // - A playbookResolver exists — meaning the playbook contains dynamic compose blocks
    //   that depend on runtime state (task list, registry, etc.) and must be re-evaluated
    //   on every LLM call so the system prompt is never stale.
    if (isFirstCall || !contextMemory.hasHistory() || playbookResolver) {
      const freshPlaybook = playbookResolver ? await playbookResolver() : playbook;
      const systemPrompt = await this._buildReactiveSystemPrompt(agent, freshPlaybook);
      contextMemory.setSystem(systemPrompt);
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
          const { taskManager } = await import('./task-manager.js');
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
          `SESSION RESUMED. The conversation history above is your complete history with this user — use it to assist them.

Your ONLY next action is: { "intent": "prompt_user" } — greet the user and wait for their instruction.

Do NOT automatically continue or restart any previous task. Wait for the user to explicitly ask.`,
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
        if (isDelegate && _args && typeof _args === 'object' && Object.keys(_args).length > 0) {
          const _specLines = Object.entries(_args)
            .filter(([, v]) => v != null && v !== '')
            .map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join('\n');
          contextStr = `\n\n📋 YOUR TASK SPEC:\n${_specLines}\n\nIf anything is unclear or you need additional context, check shared knowledge first (recall_facts). If you still can't find what you need, use ask_parent. Otherwise, start implementing now.`;
        } else if (Object.keys(context).length > 0) {
          contextStr = `\nContext: ${JSON.stringify(context)}`;
        }

        // Playbook is now in the system prompt; first user message just starts execution.
        const startMsg = `Return your FIRST action.${contextStr}${mcpErrorStr}`;
        // Place directly in long-term so it never ages out — the agent must always know its task.
        // permanent must be non-null since long-term entries render via entry.permanent in toMessages().
        const permSpec = contextStr ? contextStr.substring(0, 4000) : startMsg.substring(0, 2000);
        contextMemory.add('user', startMsg, permSpec, permSpec, { directLongTerm: true });
      }
    } else {
      // Actions have been executed — feed ALL new results as feedback (not just the last).
      // This ensures that when a batch contains multiple prompt_user calls, every
      // question/answer pair is visible to the LLM, not only the final one.
      const fromIdx = session._lastFeedbackIdx ?? 0;
      const newEntries = session.actionHistory.slice(fromIdx);
      session._lastFeedbackIdx = session.actionHistory.length;

      if (newEntries.length > 0) {
        // Add intermediate entries (all except last) as plain messages without "Continue."
        for (let i = 0; i < newEntries.length - 1; i++) {
          const entry = newEntries[i];
          const classified = classifyFeedback(entry.action, entry.result, entry.error);
          contextMemory.add('user', classified.immediate, classified.shortTerm, classified.permanent, classified);
        }

        // Process the last entry with full handling (commit context, hydrate, images, "Continue.")
        const lastEntry = newEntries[newEntries.length - 1];
        const classified = classifyFeedback(lastEntry.action, lastEntry.result, lastEntry.error);

        // Inject relevant commit context when user just spoke (after prompt_user)
        let commitContext = '';
        if (!lastEntry.error) {
          const lastIntent = lastEntry.action.intent || lastEntry.action.type;
          if (lastIntent === 'prompt_user' && lastEntry.result?.answer != null) {
            const _answerText = typeof lastEntry.result.answer === 'string'
              ? lastEntry.result.answer
              : (lastEntry.result.answer?.text ?? '');
            if (_answerText) {
              commitContext = await this._searchRelevantCommits(_answerText);
              await contextMemory.hydrate(_answerText);
            }
            // Capture image attachments so we can inject them into the next LLM message
            const _atts = Array.isArray(lastEntry.result.attachments)
              ? lastEntry.result.attachments.filter(a => a.type === 'image' && fs.existsSync(a.path))
              : [];
            session._pendingImages = _atts.length > 0 ? _atts : null;
          }
        }

        // Build the immediate content (full detail + commit context + continue)
        const immediate = `${classified.immediate}${commitContext}\nContinue.`;
        contextMemory.add('user', immediate, classified.shortTerm, classified.permanent, classified);

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
      // Ensure remote models are loaded in gateway mode (retries if initial load failed)
      if (this._koiGateway) await loadRemoteModels();

      const _lastAction = session.actionHistory.at(-1);
      const _isDelegateReturn = _lastAction?.action?.actionType === 'delegate';
      const _shouldReclassify = !session._autoProfile || isFirstCall || _isDelegateReturn;

      if (_shouldReclassify) {
        session._autoProfile = await this._inferTaskProfile(agent?.description, context?.args, agentName);
        if (process.env.KOI_DEBUG_LLM) {
          const _reason = isFirstCall ? 'first call' : _isDelegateReturn ? 'delegate returned' : 'no cached profile';
          console.error(`[Auto] Reclassifying (${_reason})`);
        }
      }
      const profile = session._autoProfile;

      // Require a vision-capable model if images are pending (user attachments or MCP screenshots)
      const _requiresImage = !!(session._pendingImages?.length > 0) ||
        !!(session._pendingMcpImages?.length > 0) ||
        session.actionHistory.some(
          e => e.action?.intent === 'prompt_user' &&
               Array.isArray(e.result?.attachments) &&
               e.result.attachments.some(a => a.type === 'image')
        );

      // Delegate all model selection + difficulty boost logic to the provider factory
      const resolved = resolveModel({
        type: 'llm',
        taskType: profile.taskType,
        difficulty: profile.difficulty,
        requiresImage: _requiresImage,
        session,
        agentName,
        availableProviders: this._availableProviders,
        clients: this._gatewayMode ? this._gatewayClients() : { openai: this._oa, anthropic: this._ac, gemini: this._gc },
      });

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
      if (this._effectiveLLMProvider === 'openai')        this.openai    = this._oa;
      else if (this._effectiveLLMProvider === 'gemini')    this.openai    = this._gc;
      else if (this._effectiveLLMProvider === 'anthropic') this.anthropic = this._ac;
    }

    // Build messages from tiered memory
    const messages = contextMemory.toMessages();

    // Track attachments for debug logging
    const _debugAttachPaths = [];

    // Inject image attachments into the last user message when the user sent images
    if (session._pendingImages?.length > 0) {
      const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
      if (lastUserIdx >= 0) {
        const textContent = typeof messages[lastUserIdx].content === 'string'
          ? messages[lastUserIdx].content : '';
        const imageParts = session._pendingImages.map(att => {
          const ext = path.extname(att.path).toLowerCase().slice(1);
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          const b64 = fs.readFileSync(att.path).toString('base64');
          return { mime, b64, path: att.path };
        });
        if (this.provider === 'anthropic') {
          messages[lastUserIdx] = {
            role: 'user',
            content: [
              ...imageParts.map(p => ({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.b64 } })),
              { type: 'text', text: textContent }
            ]
          };
        } else {
          // OpenAI / Gemini (OpenAI-compatible)
          messages[lastUserIdx] = {
            role: 'user',
            content: [
              { type: 'text', text: textContent },
              ...imageParts.map(p => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.b64}` } }))
            ]
          };
        }
        if (process.env.KOI_DEBUG_LLM) {
          _debugAttachPaths.push(...imageParts.map(p => p.path));
        }
      }
      session._pendingImages = null; // consume — don't re-send in subsequent calls
    }

    // Inject MCP tool image results (e.g. get_screenshot) as multimodal content blocks
    if (session._pendingMcpImages?.length > 0) {
      const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
      if (lastUserIdx >= 0) {
        const existing = messages[lastUserIdx].content;
        const textContent = typeof existing === 'string' ? existing
          : Array.isArray(existing) ? existing.find(p => p.type === 'text')?.text ?? '' : '';
        if (this.provider === 'anthropic') {
          messages[lastUserIdx] = {
            role: 'user',
            content: [
              ...session._pendingMcpImages.map(p => ({
                type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data }
              })),
              { type: 'text', text: textContent },
            ]
          };
        } else {
          // OpenAI / Gemini (OpenAI-compatible)
          messages[lastUserIdx] = {
            role: 'user',
            content: [
              { type: 'text', text: textContent },
              ...session._pendingMcpImages.map(p => ({
                type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` }
              })),
            ]
          };
        }
        if (process.env.KOI_DEBUG_LLM) {
          _debugAttachPaths.push(...session._pendingMcpImages.map(p => p._debugPath || `[${p.mimeType || 'image'}]`));
        }
      }
      session._pendingMcpImages = null; // consume — don't re-send in subsequent calls
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
    cliLogger.log('llm', `Sending to ${this.provider}/${this.model} (${msgCount} messages, last user msg: ${lastUserMsgText.length} chars)`);
    cliLogger.log('llm', `Last user msg preview: ${lastUserMsgText.substring(0, 300)}${lastUserMsgText.length > 300 ? '...' : ''}`);

    // Real-time streaming callback: updates the token footer as chunks arrive.
    // Also detects print intent and streams the message content to the UI in real-time.
    const _fmtTk = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

    // Streaming print state machine
    let _spState = 'init';       // 'init' | 'found_print' | 'streaming' | 'done' | 'skip'
    let _spBuf = '';             // accumulated raw JSON text
    let _spMsgOffset = -1;      // offset where message string content starts
    let _spInEscape = false;     // inside a \ escape
    let _spPendingUnicode = null; // collecting \uXXXX hex digits
    let _printStreamed = false;  // true once streaming print was active
    let _lineBuf = '';           // line buffer — holds partial line until \n
    let _tableBuf = [];          // buffered table rows for batch rendering

    const _flushTableBuf = () => {
      if (_tableBuf.length > 0) {
        cliLogger.printStreaming(renderTable(_tableBuf) + '\n');
        _tableBuf = [];
      }
    };

    // Flush complete lines from _lineBuf to the UI with markdown formatting.
    // Tables are buffered until a non-table line arrives (or flush=true).
    // If flush=true, also emit the remaining partial line (end of message).
    const _flushLines = (flush = false) => {
      let idx;
      while ((idx = _lineBuf.indexOf('\n')) !== -1) {
        const line = _lineBuf.slice(0, idx); // without \n
        _lineBuf = _lineBuf.slice(idx + 1);

        const trimmed = line.trim();
        // Detect table rows: starts and ends with |
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
          _tableBuf.push(line);
          continue;
        }

        // Non-table line — flush any buffered table first
        _flushTableBuf();

        // Format and emit
        cliLogger.printStreaming(renderLine(line) + '\n');
      }

      if (flush) {
        // Flush remaining table buffer
        _flushTableBuf();
        // Flush remaining partial line
        if (_lineBuf) {
          cliLogger.printStreaming(renderLine(_lineBuf));
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

    const _onStreamChunk = (_delta, estOutTokens) => {
      _markContentReceived(); // Real content arrived — cancel total timeout
      _resetTimer();          // Reset inactivity timer
      cliLogger.setInfo('tokens', `↓${_fmtTk(estOutTokens)} tokens`);

      if (_spState === 'done' || _spState === 'skip') return;

      _spBuf += _delta;

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

    // Inactivity timeout: abort if no chunks (content OR thinking) arrive for 30s.
    // Resets on every chunk — as long as data flows, the stream lives.
    // No total timeout needed: inactivity is the only watchdog.
    const STREAM_INACTIVITY_MS = 30_000;
    const _inactivityCtrl = new AbortController();
    let _inactivityTimer = setTimeout(() => _inactivityCtrl.abort(), STREAM_INACTIVITY_MS);
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
          cliLogger.setInfo('tokens', `↓${_fmtTk(thinkingTk)} tokens · thinking`);
        } else if (_heartbeatCount > 2) {
          // No thinking token count yet but events are flowing — model is reasoning
          cliLogger.setInfo('tokens', 'thinking');
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
      this.logRequest(this.model, systemPrompt, messages.filter(m => m.role === 'user').pop()?.content || '', `Reactive ${agentInfo}`);

      const llm = this._createLLM();
      response = await llm.streamReactive(messages, {
        abortSignal: _llmSignal,
        onChunk: _onStreamChunk,
        onHeartbeat: _heartbeat,
      });

      this.logResponse(response.text, `Reactive ${agentInfo}`);
    } catch (_callErr) {
      // Convert inactivity abort to a recognizable error so agent retry logic kicks in
      // Note: message must contain 'timeout' to match the isTimeout check in agent.js
      if (_inactivityCtrl.signal.aborted && !abortSignal?.aborted) {
        cliLogger.log('llm', `Stream inactivity timeout — no chunks for ${STREAM_INACTIVITY_MS / 1000}s`);
        if (this._autoMode) markProviderTimeout(this.provider);
        throw new Error(`LLM stream inactivity timeout after ${STREAM_INACTIVITY_MS / 1000}s (no chunks received)`);
      }
      // Circuit breaker: timeout or connection errors put provider on cooldown
      const _isTimeout = /timed?\s*out|timeout/i.test(_callErr.message || '');
      const _isConnError = /connection error|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed/i.test(_callErr.message || '');
      if ((_isTimeout || _isConnError) && this._autoMode) markProviderTimeout(this.provider);
      // In auto mode: a 4xx from a provider means the key is invalid/unauthorized or the
      // model is unavailable. Remove that provider from candidates so we don't hammer it
      // on every retry iteration — the agent would otherwise loop forever with the same error.
      if (this._autoMode) {
        const _status = _callErr.status ?? _callErr.statusCode;
        // 429 = rate limit — put provider on cooldown so auto-selector picks another model.
        if (_status === 429) {
          markProviderTimeout(this.provider);
        }
        // Other 4xx (401, 403, 404) = invalid key or model — exclude provider entirely.
        if (typeof _status === 'number' && _status >= 400 && _status < 500 && _status !== 429) {
          const _badProvider = this.provider;
          const _idx = this._availableProviders.indexOf(_badProvider);
          if (_idx !== -1) {
            this._availableProviders.splice(_idx, 1);
            cliLogger.log('llm', `[auto] Provider "${_badProvider}" excluded — HTTP ${_status} (key may be invalid or model unavailable)`);
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
    costCenter.recordUsage(_effectiveModel, _effectiveProvider, usage.input, usage.output, _apiMs, usage.thinking || 0);

    // Update token display with final accurate counts (only show ↑ when input > 0)
    {
      const _parts = [];
      if (usage.input > 0) _parts.push(`↑${_fmtTk(usage.input)}`);
      const _outTotal = (usage.output || 0) + (usage.thinking || 0);
      if (_outTotal > 0) {
        _parts.push(`↓${_fmtTk(_outTotal)} tokens`);
      }
      if (_parts.length > 0) cliLogger.setInfo('tokens', _parts.join(' '));
    }

    cliLogger.log('llm', `Response (${responseText.length} chars, ↑${usage.input} ↓${usage.output} tokens): ${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}`);

    // Parse the response into a single action
    const action = this._parseReactiveResponse(responseText);

    // If streaming print was active but didn't see closing quote, finalize now
    if (_spState === 'streaming') {
      cliLogger.printStreamingEnd();
    }

    // Mark that the print was already streamed — the print action should skip
    // its own cliLogger.print() to avoid showing the message twice.
    if (_printStreamed && action) {
      action._alreadyStreamed = true;
    }

    // Add assistant message to memory with classification
    const assistantClassified = classifyResponse(responseText, action);
    contextMemory.add('assistant', assistantClassified.immediate, assistantClassified.shortTerm, assistantClassified.permanent, assistantClassified);

    return action;
  }

  /**
   * Search commit embeddings for context relevant to user text.
   * Returns a string to inject into the LLM context, or '' if nothing relevant.
   * @private
   */
  async _searchRelevantCommits(userText) {
    try {
      const { sessionTracker } = await import('./session-tracker.js');
      if (!sessionTracker) return '';

      const { commits } = sessionTracker.loadCommitEmbeddings();
      const hashes = Object.keys(commits);
      if (hashes.length === 0) return '';

      const userEmbedding = await this.getEmbedding(userText);
      if (!userEmbedding) return '';

      const { SessionTracker } = await import('./session-tracker.js');

      // Score each commit
      const allScored = hashes.map(hash => ({
        hash,
        summary: commits[hash].summary,
        score: SessionTracker.cosineSimilarity(userEmbedding, commits[hash].embedding)
      }));

      cliLogger.log('llm', `Commit search: ${allScored.length} commits scored against "${userText.substring(0, 60)}"`);
      for (const c of allScored) {
        cliLogger.log('llm', `  [${c.hash}] score=${c.score.toFixed(3)} ${c.score >= 0.35 ? '✓' : '✗'} "${c.summary}"`);
      }

      const matched = allScored
        .filter(c => c.score >= 0.35)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      if (matched.length === 0) {
        cliLogger.log('llm', `Commit search: no matches above threshold (0.35)`);
        return '';
      }

      cliLogger.log('llm', `Commit search: injecting ${matched.length} relevant commit(s)`);

      // Build context with truncated diffs
      const parts = matched.map(c => {
        let diff = '';
        try {
          diff = sessionTracker.getCommitDiff(c.hash);
        } catch { /* no diff */ }
        return `[${c.hash}] "${c.summary}"${diff ? `\nDiff:\n${diff}` : ''}`;
      });

      return `\n\nRELEVANT SESSION CHANGES:\n${parts.join('\n\n')}`;
    } catch (err) {
      cliLogger.log('llm', `Commit search failed: ${err.message}`);
      return '';
    }
  }

  /**
   * Build system prompt for reactive mode.
   * Prepends the agent's playbook (persona/instructions) before the
   * generic execution engine rules and available actions.
   */
  async _buildReactiveSystemPrompt(agent, playbook = null) {
    const base = await this._buildSystemPrompt(agent);
    if (!playbook?.trim()) return base;
    return `${playbook.trim()}\n\n${base}`;
  }

  // ── Provider-specific streaming methods (_callOpenAIReactive, etc.) ───────
  // Moved to providers/{openai,anthropic,gemini}.js — called via factory.
  // ────────────────────────────────────────────────────────────────────────────

  // REMOVED: _callOpenAIReactive — see providers/openai.js OpenAIChatLLM
  // REMOVED: _callOpenAIResponsesReactive — see providers/openai.js OpenAIResponsesLLM
  // REMOVED: _callAnthropicReactive — see providers/anthropic.js AnthropicLLM
  // REMOVED: _callGeminiReactive — see providers/gemini.js GeminiLLM

  /**
   * Parse the LLM response from reactive mode into a single action object.
   * Handles edge cases like markdown wrapping or legacy array format.
   */
  _parseReactiveResponse(responseText) {
    // Clean markdown code blocks
    let cleaned = responseText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    // Strip preamble: some models (e.g. Anthropic) write reasoning text before the JSON.
    // Find the first { or [ and discard everything before it.
    // Capture preamble text — if the action is prompt_user, inject it as "message".
    let preambleText = '';
    const braceIdx = cleaned.indexOf('{');
    const bracketIdx = cleaned.indexOf('[');
    const jsonStart = braceIdx >= 0 && bracketIdx >= 0
      ? Math.min(braceIdx, bracketIdx)
      : braceIdx >= 0 ? braceIdx : bracketIdx;
    if (jsonStart > 0) {
      preambleText = cleaned.substring(0, jsonStart).trim();
      cleaned = cleaned.substring(jsonStart);
    }

    // Strip trailing text after JSON: some models (Gemini) append explanations
    // after the JSON object. Find the matching closing brace/bracket by counting.
    if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
      const openChar = cleaned[0];
      const closeChar = openChar === '{' ? '}' : ']';
      let depth = 0;
      let inString = false;
      let escaped = false;
      let jsonEnd = -1;
      for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === openChar) depth++;
        else if (ch === closeChar) { depth--; if (depth === 0) { jsonEnd = i; break; } }
      }
      if (jsonEnd > 0 && jsonEnd < cleaned.length - 1) {
        cleaned = cleaned.substring(0, jsonEnd + 1);
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (firstErr) {
      // Fallback 0: Fix malformed escape sequences and literal newlines/tabs inside JSON string values.
      // Some models (Gemini) emit literal newlines within strings instead of \n,
      // or produce invalid escape sequences like \a, \p, \s etc. in diff content.
      try {
        const fixed = cleaned.replace(/"(?:[^"\\]|\\.)*"/gs, match => {
          let s = match;
          // Fix literal control characters
          s = s.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
          // Fix invalid escape sequences: \X where X is not a valid JSON escape char.
          // Valid: \", \\, \/, \b, \f, \n, \r, \t, \uXXXX
          // Replace invalid \X with \\X (escaped backslash + literal char)
          s = s.replace(/\\([^"\\/bfnrtu])/g, '\\\\$1');
          return s;
        });
        parsed = JSON.parse(fixed);
      } catch { /* fall through */ }

      if (!parsed) {
        // Fallback 1: LLM returned multiple JSON objects on separate lines
        const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
        if (lines.length > 1) {
          try {
            const actions = lines.map(l => JSON.parse(l));
            return actions.map(a => this._normalizeReactiveAction(a));
          } catch { /* fall through */ }
        }
        // Fallback 2: concatenated objects without newline: {...}{...}
        try {
          const asArray = JSON.parse(`[${cleaned.replace(/\}\s*\{/g, '},{')}]`);
          if (Array.isArray(asArray) && asArray.length > 0) {
            return asArray.map(a => this._normalizeReactiveAction(a));
          }
        } catch { /* fall through */ }
        // Fallback 3: truncated response — try to parse just the first complete JSON object
        const firstObjMatch = cleaned.match(/^\{[\s\S]*?\}(?=\s*[\{$]|\s*$)/);
        if (firstObjMatch) {
          try {
            const firstObj = JSON.parse(firstObjMatch[0]);
            return this._normalizeReactiveAction(firstObj);
          } catch { /* fall through */ }
        }
        throw new Error(`Failed to parse reactive LLM response as JSON: ${firstErr.message}\nResponse: ${cleaned.substring(0, 200)}`);
      }
    }

    // Helper: inject preamble text into the last prompt_user in an action list
    const _injectPreamble = (actions) => {
      if (!preambleText) return actions;
      // Find the last prompt_user action and inject preamble as message
      for (let i = actions.length - 1; i >= 0; i--) {
        const a = actions[i];
        if (a && a.intent === 'prompt_user' && !a.message) {
          a.message = preambleText;
          break;
        }
      }
      return actions;
    };

    // Handle batched actions: { "batch": [action1, action2, ...] }
    // Items may be regular actions OR { "parallel": [...] } groups.
    if (parsed.batch && Array.isArray(parsed.batch) && parsed.batch.length > 0) {
      this.logDebug(`Reactive response batched ${parsed.batch.length} actions`);
      const actions = parsed.batch.map(a => this._normalizeBatchItem(a));
      _injectPreamble(actions);
      return actions.length === 1 ? actions[0] : actions;
    }

    // Handle raw array (in case json_object mode is not used)
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        throw new Error('Reactive response was an empty array');
      }
      const actions = parsed.map(a => this._normalizeReactiveAction(a));
      _injectPreamble(actions);
      return actions.length === 1 ? actions[0] : actions;
    }

    // If LLM returned legacy format { "actions": [...] }, extract as batch
    if (parsed.actions && Array.isArray(parsed.actions) && parsed.actions.length > 0) {
      this.logDebug('Reactive response used legacy {actions:[...]} format, extracting as batch');
      const actions = parsed.actions.map(a => this._normalizeReactiveAction(a));
      _injectPreamble(actions);
      return actions.length === 1 ? actions[0] : actions;
    }

    // Handle top-level parallel group: { "parallel": [...] }
    // The LLM sometimes returns a parallel block as the root object (without a batch wrapper).
    // Without this check, _normalizeReactiveAction sees no intent/actionType/type and
    // wraps the whole parallel block as `{ intent: 'return', data: { parallel: [...] } }`,
    // causing all parallel actions to be silently discarded as return data.
    if (parsed.parallel && Array.isArray(parsed.parallel) && parsed.parallel.length > 0) {
      this.logDebug('Reactive response was a top-level parallel group, normalizing inner actions');
      return { parallel: parsed.parallel.map(a => this._normalizeReactiveAction(a)) };
    }

    const result = this._normalizeReactiveAction(parsed);

    // If the LLM wrote explanation text before the JSON and the action is prompt_user,
    // inject the preamble as the "message" field so it's displayed to the user.
    if (preambleText && result && !Array.isArray(result)) {
      const action = result;
      if (action.intent === 'prompt_user' && !action.message) {
        action.message = preambleText;
      }
    }

    return result;
  }

  /**
   * Normalize a single item from a batch array.
   * If it's a { parallel: [...] } group, normalize each inner action.
   * Otherwise treat it as a regular action.
   */
  _normalizeBatchItem(item) {
    if (item && Array.isArray(item.parallel)) {
      return { parallel: item.parallel.map(a => this._normalizeReactiveAction(a)) };
    }
    return this._normalizeReactiveAction(item);
  }

  /**
   * Normalize a single action object from a reactive response.
   */
  _normalizeReactiveAction(parsed) {
    // Safety net: if actionType is not "direct"/"delegate", the LLM put the intent there
    if (parsed.actionType && parsed.actionType !== 'direct' && parsed.actionType !== 'delegate') {
      if (!parsed.intent) {
        parsed.intent = parsed.actionType;
      }
      parsed.actionType = 'direct';
    }

    // Validate minimal structure — if no action fields, treat as raw return data
    if (!parsed.intent && !parsed.actionType && !parsed.type) {
      if (Object.keys(parsed).length > 0) {
        this.logDebug('Reactive response was raw data, wrapping as return action');
        return { actionType: 'direct', intent: 'return', data: parsed };
      }
      throw new Error(`Invalid reactive action: missing "intent" or "actionType". Got: ${JSON.stringify(parsed).substring(0, 200)}`);
    }

    return parsed;
  }

  // =========================================================================
  // UNIFIED SYSTEM PROMPT - shared rules for all execution modes
  // =========================================================================

  /**
   * Build the system prompt for all agents.
   * Single unified prompt — only the available intents change per agent.
   * @param {Agent} agent - The agent
   * @returns {string} Complete system prompt
   */
  async _buildSystemPrompt(agent) {
    const hasTeams = agent && agent.usesTeams && agent.usesTeams.length > 0;
    const resourceSection = await this._buildSmartResourceSection(agent);
    const intentNesting = hasTeams ? '\nIMPORTANT: Do NOT nest "intent" inside "data". The "intent" field must be at the top level.' : '';
    const koiMd = agent.hasPermission('read_koi_md') ? this._loadKoiMd() : '';

    return `
# ENVIRONMENT
Working directory: ${process.cwd()}
All file paths (read_file, edit_file, write_file, shell) are relative to this directory unless absolute.

REMINDER: intent must be one of AVAILABLE ACTIONS (enum). Never invent new intents. Descriptions go in query / other fields.

========================================
OUTPUT SAFETY (MUST FOLLOW)
========================================
- intent is an ENUM: it MUST be exactly one of AVAILABLE ACTIONS. Never invent new intents.
- NO BARE ACTIONS: never output an action object with only {actionType,intent}. Every intent must include its required fields.
- If you feel like writing a descriptive phrase in intent, STOP and move that phrase into query / pattern / other params.
- PREFLIGHT (before emitting JSON):
  1) For each action: intent ∈ AVAILABLE ACTIONS
  2) Required fields present:
     - semantic_code_search => query
     - search => mode + (query or pattern depending on mode)
     - grep => pattern
     - read_file => path (ALWAYS use offset + limit to read specific sections, limit 50-150 lines. NEVER read > 200 lines at once. NEVER omit offset/limit on files > 100 lines.)
     - shell => command + description
     - learn_fact => key + value + category
  3) If any check fails: FIX the JSON. Do not output invalid actions (invalid output crashes the system).
- MULTI-CONCEPT RULE (HARD):
  - If the user request contains 2+ concepts (e.g. contains "y", "and", "also", commas, or multiple nouns),
    you MUST split into multiple semantic_code_search actions.
  - NEVER put 2 concepts in the same semantic_code_search.query.
  - If there are 2+ independent searches, they MUST be inside a single parallel block.
- NEVER ANSWER WITHOUT EVIDENCE (HARD):
  - Search results (semantic_code_search, search, grep) are LEADS, not answers. They tell you WHERE to look, not WHAT the answer is.
  - You MUST read_file the actual source code BEFORE answering any question about the codebase.
  - If search results have a "hint" warning about low confidence, you MUST use additional tools (grep, search, read_file) before responding. NEVER print a speculative answer based on search descriptions alone.
  - If you cannot find the answer after trying multiple search strategies, say so honestly — do NOT fabricate an answer from irrelevant results.
- SEMANTIC SEARCH QUERY STYLE (HARD):
  - Queries MUST be keyword lists, NOT natural language questions.
  - REMOVE filler words: where, which, how, what, is, the, are, does, find.
  - EXPAND with synonyms and related technical terms.
  - BAD: "where is semantic indexing implemented" → GOOD: "semantic index build embed vector store"
  - BAD: "which languages are supported" → GOOD: "language support parser javascript typescript python"

# OUTPUT FORMAT INSTRUCTIONS:

Convert user instructions into executable JSON actions using ONLY the actions and agents listed in AVAILABLE ACTIONS and AVAILABLE AGENTS.

ABSOLUTE OUTPUT RULE:
- Your entire response MUST be a single valid JSON object.
- Output ONLY JSON. No markdown. No explanations. No extra text.
- Every action must be complete for its intent (no bare actions).
- Intent is an enum. If you feel like writing a descriptive phrase in intent, STOP and put that phrase into query instead. Invalid intents crash the system.
- The response MUST start with { and end with }.
- If you output anything else, the system will crash.

ACTION FORMAT:
- Single action:
  { "actionType": "direct", "intent": "semantic_code_search", "query": "authentication login session token" }

- Delegate to agent:
  { "actionType": "delegate", "intent": "agentKey::eventName", "data": { ... } }

- Parallel actions (each action MUST have "actionType" and "intent"):
  { "batch": [{ "parallel": [
    { "actionType": "direct", "intent": "semantic_code_search", "query": "authentication login session token" },
    { "actionType": "direct", "intent": "semantic_code_search", "query": "database connection pool config" }
  ]}] }
    
  {
    "batch": [
      {
        "parallel": [
          {
            "actionType": "direct",
            "intent": "semantic_code_search",
            "query": "semantic index build embed vector store"
          },
          {
            "actionType": "direct",
            "intent": "semantic_code_search",
            "query": "language support parser javascript typescript python"
          }
        ]
      }
    ]
  }

  RULE: if two or more actions do not depend on each other's output, they MUST go inside a "parallel" block.
  NEVER put independent actions sequentially in a batch — always parallelize them.
  EXCEPTION: prompt_user must NEVER be inside a parallel block.

  // ❌ INVALID (invented intent + missing required fields)
  { "actionType": "direct", "intent": "semantic index supported languages" }

  // ✅ VALID (use a real intent and put text in query)
  { "actionType": "direct", "intent": "semantic_code_search", "query": "semantic index language parser support" }    

- Sequential then parallel:
  { "batch": [ { action1 }, { "parallel": [ { action2 }, { action3 } ] }, { action4 } ] }
  → action1 runs first, then action2+action3 CONCURRENTLY, then action4.

REQUIREMENTS:
- Every action object MUST have "actionType" and "intent".
- "intent" is a fixed identifier — it MUST be one of the exact names listed in AVAILABLE ACTIONS (e.g. "semantic_code_search", "search", "read_file"). Search text, descriptions, or queries are NEVER valid intents — they go in "query" or other parameter fields.
- Do NOT nest "intent" inside "data".
- Delegate intents MUST follow: agentKey::eventName.

EXECUTION FLOW:
- Return ONE JSON object per step: either a single action or a { "batch": [...] } with multiple steps.
- After each response, you receive the results and decide the next step.
- Continue step-by-step until the task is fully completed.
- Only when EVERYTHING is done, return: { "actionType": "direct", "intent": "return", "data": { ... } }
- CRITICAL: Static content (headers, banners, labels) that does NOT depend on any result MUST be included in the FIRST response — never deferred to a later step. Combine them in a batch with other first actions.
- If you are a delegate agent and have a doubt you cannot resolve by reading the codebase, use: { "actionType": "direct", "intent": "ask_parent", "question": "..." }. The runtime will ask the invoking agent and re-call you with args.answer set to the response.
- If args.answer is present, it is the parent agent's answer to your previous ask_parent — use it to continue.

RULES:
1. Never answer in natural language.
2. Never explain reasoning.
3. Never describe what you will do — execute it.
4. If an action fails, choose a different valid action — EXCEPT for "command not found" / exit code 127, which must be handled by rule 11, not skipped.
5. If the user denies permission (🚫), do not retry the same action.
6. If instructions say to repeat N times, execute ALL N iterations.
7. Do not duplicate content (e.g., do not print before prompt_user). When responding to the user with information AND a follow-up question, put the information in prompt_user's "message" field — never as free text before the JSON.
8. PARALLELISM IS MANDATORY: within a batch, whenever 2 or more actions do not depend on each other's output, they MUST go inside a "parallel" block. It is WRONG to list independent actions sequentially in a batch — always parallelize them. EXCEPTION: prompt_user is always sequential and must never be in a parallel block.
9. NEVER return before ALL steps are done. Delegating/reading/exploring is NOT completing a task — you must also execute every follow-up action (edits, writes, prints, etc.) that the task requires. Only emit { "intent": "return" } when every required change has been applied and verified.
10. ONE QUESTION PER prompt_user: Never list multiple questions in a single prompt_user. If you need N pieces of information, use N sequential prompt_user actions, one question each. After the last answer, continue with the next step — do NOT add a "submit" or summary prompt.
11. ⚠️ MISSING TOOLS (overrides rule 4): If any shell command returns "command not found" or exit code 127, the required tool is not installed. You MUST immediately stop the current task and use prompt_user (with options ["Yes", "No"]) to ask the user for permission to install it. Example: { "intent": "prompt_user", "prompt": "Flutter is not installed. Install it now? (brew install flutter) → ", "options": ["Yes", "No"] }. If Yes, install it first, then continue the original task. If No, tell the user what to install and stop. Never skip this step and continue with the task.
12. QUESTIONS: When gathering information from the user, always use prompt_user with a "question" field. The question is displayed above the input area. Never use a preceding print to show a question. When you need to show an explanation/answer AND ask a follow-up, use the "message" field for the explanation and "question" for the follow-up. Example: { "intent": "prompt_user", "message": "Here is what I found:\\n\\n1. Point A\\n2. Point B", "question": "Do you need more details?" }
14. BACKGROUND PROCESSES: Commands that launch apps, emulators, or dev servers (e.g. "flutter run", "open -a Simulator", "npm start", "python server.py") MUST use "background": true in the shell action. These processes run indefinitely — do not wait for them to finish.
13. NEVER ask the user something you can verify yourself with a shell command or file read. Run the check first, then act on the result. Examples: do NOT ask "Is Flutter installed?" — run "which flutter" or "flutter --version". Do NOT ask "Does this file exist?" — read it. Only ask the user for things that are genuinely unknowable without their input (e.g. project name, desired behavior, credentials).

All available capabilities are defined below. Use them exactly as specified.

${resourceSection}${intentNesting}

CRITICAL: Return a single JSON action or { "batch": [...] } for multiple actions. No markdown. Remember: static headers/labels go in the FIRST response; parallelize independent actions; never return until ALL steps are done.${koiMd}`;

  }

  /**
   * Load KOI.md from the project root (cwd) if it exists.
   * Similar to CLAUDE.md — project-specific instructions appended to the system prompt.
   */
  _loadKoiMd() {
    const candidates = [
      path.join(process.cwd(), 'KOI.md'),
      path.join(process.cwd(), 'koi.md'),
    ];
    for (const filePath of candidates) {
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8').trim();
          if (content) {
            return `\n\nPROJECT INSTRUCTIONS (from KOI.md):\n${content}`;
          }
        } catch { /* ignore read errors */ }
      }
    }
    return '';
  }

  // =========================================================================
  // SMART RESOURCE SECTION
  // =========================================================================

  /**
   * Build a smart resource section for system prompts.
   * THE RULE:
   *   - If total intents across ALL resources <= 25: show everything (1-step)
   *   - If total > 25: collapse resources with > 3 intents to summaries (2-step)
   *
   * @param {Agent} agent - The agent
   * @returns {string} Resource documentation for system prompt
   */
  async _buildSmartResourceSection(agent) {
    // 1. Collect ALL resources with their intents
    const resources = [];

    // Direct actions (from action registry)
    const directActions = actionRegistry.getAll().filter(a => {
      if (a.hidden) return false;
      if (!a.permission) return true;
      return agent.hasPermission(a.permission);
    });
    if (directActions.length > 0) {
      resources.push({
        type: 'direct',
        name: 'Built-in Actions',
        intents: directActions.map(a => ({
          name: a.intent || a.type,
          description: a.description,
          schema: a.schema,
          _actionDef: a
        }))
      });
    }

    // Team members (delegation targets)
    const peerIntents = this._collectPeerIntents(agent);
    for (const peer of peerIntents) {
      resources.push({
        type: 'delegate',
        name: peer.agentName,
        agentPureName: peer.agentPureName,
        agentDescription: peer.agentDescription,
        intents: peer.handlers.map(h => ({
          name: h.name,
          description: h.description,
          params: h.params
        }))
      });
    }

    // MCP servers — only if agent has call_mcp permission
    if (agent.hasPermission('call_mcp')) {
      if (globalThis.mcpRegistry?.globalReady) {
        await globalThis.mcpRegistry.globalReady;
      }
      const mcpSummaries = agent.getMCPToolsSummary?.() || [];
      for (const mcp of mcpSummaries) {
        resources.push({
          type: 'mcp',
          name: mcp.name,
          intents: mcp.tools.map(t => ({
            name: t.name,
            description: t.description || t.name,
            inputSchema: t.inputSchema
          }))
        });
      }
    }

    // 2. Count total intents
    const totalIntents = resources.reduce((sum, r) => sum + r.intents.length, 0);

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[SmartPrompt] Total intents: ${totalIntents} across ${resources.length} resources`);
      for (const r of resources) {
        console.error(`  [${r.type}] ${r.name}: ${r.intents.length} intents`);
      }
    }

    // Always expand all resources (1-step)
    return this._buildExpandedResourceSection(resources, agent);
  }

  /**
   * Collect peer intents (handler names + descriptions) from accessible teams.
   * @param {Agent} agent
   * @returns {Array<{agentName, handlers: Array<{name, description}>}>}
   */
  _collectPeerIntents(agent) {
    const result = [];
    const processedAgents = new Set();

    const collectFrom = (memberKey, member, teamName) => {
      if (!member || member === agent || processedAgents.has(member.name)) return;
      processedAgents.add(member.name);

      if (!member.handlers || Object.keys(member.handlers).length === 0) return;

      const handlers = [];
      for (const [handlerName, handlerFn] of Object.entries(member.handlers)) {
        let description = `Handle ${handlerName}`;
        let params = [];

        // Prefer LLM-generated description from build cache
        if (handlerFn?.__description__) {
          description = handlerFn.__description__;
        } else if (handlerFn?.__playbook__) {
          // Fallback: first line of playbook
          const firstLine = handlerFn.__playbook__.split('\n')[0].trim();
          description = firstLine.replace(/\$\{[^}]+\}/g, '...').substring(0, 80);
        }

        // Extract required params from ${args.X} patterns in playbook
        if (handlerFn?.__playbook__) {
          const paramMatches = handlerFn.__playbook__.matchAll(/\$\{args\.(\w+)/g);
          params = [...new Set([...paramMatches].map(m => m[1]))];
        }

        handlers.push({ name: handlerName, description, params });
      }

      result.push({
        agentName: teamName ? `${memberKey} (${teamName})` : memberKey,
        agentPureName: memberKey,
        agentDescription: member.description || null,
        handlers
      });
    };

    // Peers team
    if (agent.peers?.members) {
      for (const [name, member] of Object.entries(agent.peers.members)) {
        collectFrom(name, member, agent.peers.name);
      }
    }

    // Uses teams
    for (const team of (agent.usesTeams || [])) {
      if (team?.members) {
        for (const [name, member] of Object.entries(team.members)) {
          collectFrom(name, member, team.name);
        }
      }
    }

    return result;
  }

  /**
   * Build expanded resource section - show all intents directly.
   * This is the normal behavior when total intents <= 25.
   */
  _buildExpandedResourceSection(resources, agent) {
    let doc = '';

    // ── AVAILABLE ACTIONS ───────────────────────────────────────────────────
    for (const resource of resources) {
      if (resource.type === 'direct') {
        doc += actionRegistry.generatePromptDocumentation(agent);
      }
    }

    // ── AVAILABLE AGENTS ────────────────────────────────────────────────────
    const delegateResources = resources.filter(r => r.type === 'delegate');
    if (delegateResources.length > 0) {
      doc += '## AVAILABLE AGENTS\n\n';
      for (const resource of delegateResources) {
        doc += `### ${resource.agentPureName}\n`;
        if (resource.agentDescription) {
          doc += `${resource.agentDescription}\n`;
        }
        for (const handler of resource.intents) {
          doc += ` - ${handler.name}: ${handler.description}\n`;
          if (handler.params?.length > 0) {
            doc += `    In: { ${handler.params.map(p => `"${p}"`).join(', ')} }\n`;
          }
        }
        doc += '\n';
      }
    }

    // ── AVAILABLE MCP TOOLS ─────────────────────────────────────────────────
    const mcpResources = resources.filter(r => r.type === 'mcp');
    if (mcpResources.length > 0) {
      doc += '## AVAILABLE MCP TOOLS\n\n';
      for (const resource of mcpResources) {
        doc += `### ${resource.name}\n`;
        for (const tool of resource.intents) {
          doc += ` - ${tool.name}: ${tool.description || tool.name}\n`;
          if (tool.inputSchema?.properties) {
            const keys = Object.keys(tool.inputSchema.properties);
            if (keys.length > 0) doc += `    In: ${keys.map(k => `"${k}"`).join(', ')}\n`;
          }
        }
        doc += '\n';
      }
    }

    // ── INVOCATION SYNTAX ───────────────────────────────────────────────────
    doc += '---\n';
    doc += 'To execute an action (intent MUST be an exact name from AVAILABLE ACTIONS):\n';
    doc += '{ "actionType": "direct", "intent": "print", "message": "Hello" }\n\n';

    if (delegateResources.length > 0) {
      const ex = delegateResources[0];
      const exEvent = ex.intents[0]?.name ?? 'handle';
      doc += 'To call an agent:\n';
      doc += `{ "actionType": "delegate", "intent": "${ex.agentPureName}::${exEvent}", "data": { ... } }\n\n`;
      doc += 'The intent for a delegate action must use the format agentKey::eventName\n';
    }

    if (mcpResources.length > 0) {
      const ex = mcpResources[0];
      const exTool = ex.intents[0]?.name ?? 'tool_name';
      doc += '\nTo call an MCP tool (ALWAYS use this format — NEVER use delegate for MCP tools):\n';
      doc += `{ "actionType": "direct", "intent": "call_mcp", "mcp": "${ex.name}", "tool": "${exTool}", "input": { ... } }\n`;
    }

    return doc;
  }

  // =========================================================================
  // COMPOSE PROMPT EXECUTION
  // =========================================================================

  /**
   * Execute a compose block: call an LLM to dynamically assemble a prompt
   * from named fragments, optionally calling runtime actions (e.g. task_list)
   * to make the decision.
   *
   * @param {Object} composeDef - { fragments, template, model }
   * @param {Agent} agent - The agent requesting composition
   * @returns {string} The assembled prompt text
   */
  /**
   * Infer the LLM provider from a model name.
   * Used by executeCompose when a model is explicitly specified.
   */
  static _inferProviderFromModel(model) {
    if (!model) return 'openai';
    if (model.startsWith('gemini-')) return 'gemini';
    if (model.startsWith('claude-')) return 'anthropic';
    // gpt-*, o1*, o3*, o4*, codex → openai
    return 'openai';
  }

  async executeCompose(composeDef, agent) {
    const { fragments, template, model } = composeDef;

    // Resolve fragment values (may be strings, functions, or nested compose prompts)
    const resolvedFragments = {};
    for (const [name, value] of Object.entries(fragments)) {
      if (typeof value === 'function') {
        resolvedFragments[name] = value();
      } else if (value && value.__isCompose__) {
        // Recursively resolve nested compose prompts
        resolvedFragments[name] = await agent._executeComposePrompt(value, null);
      } else {
        resolvedFragments[name] = value || '';
      }
    }

    const callAction = async (intent, data = {}) => {
      // Special compose-only actions
      if (intent === 'frame_server_state') {
        return await agent._getFrameServerState();
      }
      const actionDef = actionRegistry.get(intent);
      if (!actionDef) return null;
      return await actionDef.execute({ intent, ...data }, agent);
    };

    // ── Fast path: use cached execution plan (no LLM call) ──
    // The plan is generated once by the LLM, then replayed on every subsequent call.
    // This is critical because compose blocks inside playbooks are re-evaluated on
    // every reactive loop iteration — calling an LLM each time would be prohibitive.
    if (composeDef._cachedPlan) {
      return await this._executeComposePlan(composeDef._cachedPlan, resolvedFragments, callAction);
    }

    // ── First call: use LLM to generate the execution plan ──
    const provider = model
      ? new LLMProvider({ provider: LLMProvider._inferProviderFromModel(model), model })
      : this;

    // Build available actions list for the compose LLM
    // Include hidden actions too — compose resolvers need access to actions like
    // action_history that are hidden from the main LLM but available to compose.
    const directActions = actionRegistry.getAll().filter(a => {
      if (!a.permission) return true;
      return agent.hasPermission(a.permission);
    });
    const actionDocs = directActions
      .map(a => `- ${a.intent || a.type}: ${a.description || ''}`)
      .join('\n');

    const fragmentNames = Object.keys(resolvedFragments).join(', ');

    const systemPrompt = `You are a prompt composer. Generate an execution plan for assembling a prompt from fragments and runtime data.

## AVAILABLE FRAGMENTS
${fragmentNames}

## AVAILABLE ACTIONS (callable at runtime to get dynamic data)
${actionDocs}

## COMPOSITION TEMPLATE
${template}

## OUTPUT FORMAT
Return a JSON execution plan — an ordered array of steps. Each step is one of:
- { "fragment": "name" } — include this fragment's text
- { "call": "action_name", "data": {}, "field": "fieldName", "prefix": "optional text before the result" } — call an action at runtime, extract \`result[field]\` (usually "summary"), and include it as text. "prefix" is optional static text prepended before the action result.
- { "text": "static text to include" } — include literal text
- { "image_call": "action_name", "textField": "fieldName", "imageField": "screenshot", "mimeTypeField": "mimeType", "prefix": "optional text" } — call an action that returns both text and an image. The text (result[textField]) is included in the prompt, and the screenshot image (result[imageField]) is injected visually into the LLM call. Supported actions: "frame_server_state" (mobile screen, textField="elements"), "browser_observe" (browser screenshot, textField="elementsSummary").

Example:
[
  { "fragment": "planning" },
  { "fragment": "template" },
  { "call": "action_history", "data": { "count": 15 }, "field": "summary", "prefix": "## Action History\\n\\nReview the actions below. If you see the same action repeated 3+ times, you are stuck in a loop — change strategy immediately.\\n\\n" },
  { "image_call": "frame_server_state", "textField": "elements", "imageField": "screenshot", "mimeTypeField": "mimeType", "prefix": "## Current Mobile Screen\\n\\n" },
  { "image_call": "browser_observe", "textField": "elementsSummary", "imageField": "screenshot", "mimeTypeField": "mimeType", "prefix": "## Current Browser Page\\n\\n" }
]

Output ONLY the JSON array, no explanation.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Generate the execution plan now.' }
    ];

    try {
      const plan = await provider._callJSONWithMessages(messages);

      if (Array.isArray(plan) && plan.length > 0) {
        // Cache the plan on the composeDef so subsequent calls skip the LLM
        composeDef._cachedPlan = plan;

        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Compose] Generated plan (${plan.length} steps):`, JSON.stringify(plan));
        }

        return await this._executeComposePlan(plan, resolvedFragments, callAction);
      }
    } catch (error) {
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[Compose] Plan generation failed: ${error.message}`);
      }
    }

    // Fallback: concatenate all fragments
    if (process.env.KOI_DEBUG_LLM) {
      console.error('[Compose] Falling back to concatenated fragments');
    }
    return Object.values(resolvedFragments).join('\n\n');
  }

  /**
   * Execute a cached compose plan — no LLM call, just fragment concatenation
   * and runtime action calls.
   */
  async _executeComposePlan(plan, resolvedFragments, callAction) {
    const parts = [];
    const images = [];

    for (const step of plan) {
      if (step.fragment && resolvedFragments[step.fragment] !== undefined) {
        parts.push(resolvedFragments[step.fragment]);
      } else if (step.image_call) {
        // Multimodal step: call action, extract text + image
        try {
          const result = await callAction(step.image_call, step.data || {});
          if (result) {
            const textValue = step.textField ? result[step.textField] : null;
            if (textValue) parts.push((step.prefix || '') + textValue);
            const imageData = step.imageField ? result[step.imageField] : null;
            const mimeType = step.mimeTypeField ? result[step.mimeTypeField] : 'image/jpeg';
            if (imageData) images.push({ data: imageData, mimeType });
          }
        } catch (err) {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Compose] Image action ${step.image_call} failed: ${err.message}`);
          }
        }
      } else if (step.call) {
        try {
          const result = await callAction(step.call, step.data || {});
          const value = step.field ? result?.[step.field] : JSON.stringify(result);
          if (value) {
            parts.push((step.prefix || '') + value);
          }
        } catch (err) {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Compose] Action ${step.call} failed: ${err.message}`);
          }
        }
      } else if (step.text) {
        parts.push(step.text);
      }
    }

    const text = parts.filter(Boolean).join('\n\n');
    // Return multimodal format if images were collected, otherwise plain text
    if (images.length > 0) {
      return { text, images };
    }
    return text;
  }

  /**
   * Call the LLM with a full messages array and return a parsed JSON object.
   * Used by executeCompose for multi-turn composition.
   *
   * @param {Array} messages - Array of { role, content } message objects
   * @returns {Object} Parsed JSON response
   */
  async _callJSONWithMessages(messages) {
    try {
      const llm = this._createLLM({ maxTokens: 4096, temperature: 0 });
      const { text } = await llm.complete(messages, { responseFormat: 'json_object' });
      return JSON.parse(text || '{}');
    } catch (e) {
      if (process.env.KOI_DEBUG_LLM) {
        console.error('[Compose] _callJSONWithMessages error:', e.message);
      }
      return {};
    }
  }

  /**
   * Returns the embedding vector dimension for the active embedding provider.
   * OpenAI text-embedding-3-small = 1536, Gemini text-embedding-004 = 768.
   * Used by ContextMemory to initialize LanceDB with the correct schema.
   */
  getEmbeddingDim() {
    if (process.env.KOI_AUTH_TOKEN) return 1536; // gateway uses text-embedding-3-small
    if (process.env.OPENAI_API_KEY) return getEmbeddingDimension('openai');
    if (process.env.GEMINI_API_KEY) return getEmbeddingDimension('gemini');
    return getEmbeddingDimension('openai'); // fallback default
  }

  /**
   * Generate embeddings for semantic search.
   * Priority: OpenAI (text-embedding-3-small, 1536-dim)
   *         → Gemini (text-embedding-004, 768-dim via OpenAI-compat endpoint)
   * Anthropic has no embedding API — throws if only Anthropic key is available.
   */
  async getEmbedding(text) {
    if (!text || typeof text !== 'string' || text.trim() === '') {
      throw new Error('getEmbedding requires non-empty text input');
    }

    const MAX_RETRIES = 2;
    const TIMEOUT_MS = 15000;
    const _provider = process.env.KOI_AUTH_TOKEN ? 'koi-gateway' : process.env.OPENAI_API_KEY ? 'openai' : process.env.GEMINI_API_KEY ? 'gemini' : 'none';
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = 2000 * attempt; // 2s, 4s
        cliLogger.log('memory', `Embedding retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }

      const ac = new AbortController();
      const _timer = setTimeout(() => ac.abort(new Error('embedding timeout')), TIMEOUT_MS);
      const _t0 = Date.now();
      cliLogger.log('memory', `Embedding request: provider=${_provider}, textLen=${text.length}, attempt=${attempt}, preview="${text.substring(0, 80).replace(/\n/g, ' ')}..."`);

      try {
        // Gateway mode: use koi-cli.ai backend for embeddings
        if (process.env.KOI_AUTH_TOKEN) {
          if (!this._gatewayEmbeddingInstance) {
            const { GatewayEmbedding } = await import('./providers/gateway.js');
            this._gatewayEmbeddingInstance = new GatewayEmbedding();
          }
          const result = await this._gatewayEmbeddingInstance.embed(text, { abortSignal: ac.signal });
          clearTimeout(_timer);
          cliLogger.log('memory', `Embedding OK: ${Date.now() - _t0}ms, dim=${result.length}${attempt > 0 ? `, retry=${attempt}` : ''}`);
          return result;
        }

        if (process.env.OPENAI_API_KEY) {
          if (!this._embeddingClient) {
            this._embeddingClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
          }
          if (!this._embeddingInstance) {
            this._embeddingInstance = createEmbedding('openai', this._embeddingClient);
          }
          const result = await this._embeddingInstance.embed(text, { abortSignal: ac.signal });
          clearTimeout(_timer);
          cliLogger.log('memory', `Embedding OK: ${Date.now() - _t0}ms, dim=${result.length}${attempt > 0 ? `, retry=${attempt}` : ''}`);
          return result;
        }

        if (process.env.GEMINI_API_KEY) {
          if (!this._geminiEmbeddingClient) {
            this._geminiEmbeddingClient = new OpenAI({
              apiKey: process.env.GEMINI_API_KEY,
              baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
              maxRetries: 0
            });
          }
          if (!this._geminiEmbeddingInstance) {
            this._geminiEmbeddingInstance = createEmbedding('gemini', this._geminiEmbeddingClient);
          }
          const result = await this._geminiEmbeddingInstance.embed(text, { abortSignal: ac.signal });
          clearTimeout(_timer);
          cliLogger.log('memory', `Embedding OK: ${Date.now() - _t0}ms, dim=${result.length}${attempt > 0 ? `, retry=${attempt}` : ''}`);
          return result;
        }

        throw new Error('No embedding provider available (need OPENAI_API_KEY or GEMINI_API_KEY)');
      } catch (error) {
        clearTimeout(_timer);
        const elapsed = Date.now() - _t0;
        const isTimeout = ac.signal.aborted;
        const msg = isTimeout ? `embedding timeout after ${elapsed}ms` : error.message;
        cliLogger.log('memory', `Embedding FAILED: ${msg} (provider=${_provider}, textLen=${text.length}, elapsed=${elapsed}ms, attempt=${attempt})`);
        lastError = new Error(msg);
        // Retry on timeout or 5xx errors; don't retry auth/validation errors
        const status = error.status || 0;
        if (!isTimeout && status > 0 && status < 500) throw lastError;
      }
    }
    throw lastError;
  }

  /**
   * Batch embed multiple texts in a single API call (gateway mode only).
   * Falls back to individual getEmbedding() calls for non-gateway providers.
   * Returns an array of embedding vectors (same order as input texts).
   * Failed embeddings return null.
   *
   * Batches are serialized: only one batch request runs at a time, even if
   * multiple files are being indexed in parallel. This prevents flooding the
   * gateway/provider with concurrent batch requests.
   */
  async getEmbeddingBatch(texts) {
    if (!texts.length) return [];

    // Serialize batch requests — wait for any in-flight batch to finish first
    if (this._embeddingBatchLock) {
      await this._embeddingBatchLock;
    }

    let _unlock;
    this._embeddingBatchLock = new Promise(r => { _unlock = r; });

    try {
      return await this._doEmbeddingBatch(texts);
    } finally {
      this._embeddingBatchLock = null;
      _unlock();
    }
  }

  async _doEmbeddingBatch(texts) {
    // Gateway mode: use batch API (single HTTP request)
    if (process.env.KOI_AUTH_TOKEN) {
      if (!this._gatewayEmbeddingInstance) {
        const { GatewayEmbedding } = await import('./providers/gateway.js');
        this._gatewayEmbeddingInstance = new GatewayEmbedding();
      }
      const _t0 = Date.now();
      cliLogger.log('memory', `Embedding batch: ${texts.length} texts via gateway`);
      try {
        const results = await this._gatewayEmbeddingInstance.embedBatch(texts);
        cliLogger.log('memory', `Embedding batch OK: ${Date.now() - _t0}ms, count=${results.length}`);
        return results;
      } catch (err) {
        cliLogger.log('memory', `Embedding batch FAILED: ${err.message}, falling back to individual`);
        // Fall through to individual calls
      }
    }

    // Fallback: sequential individual calls
    const results = [];
    for (const text of texts) {
      try {
        results.push(await this.getEmbedding(text));
      } catch {
        results.push(null);
      }
    }
    return results;
  }
}
