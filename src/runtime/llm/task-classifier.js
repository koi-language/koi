import path from 'path';
import { getAllCandidates, DEFAULT_TASK_PROFILE } from './providers/factory.js';
import { EFFORT_NONE, EFFORT_LOW, EFFORT_MEDIUM, EFFORT_HIGH } from './constants.js';

/**
 * Task and interaction classifier — extracted from LLMProvider.
 *
 * Classifies user requests (interaction, A-G) and agent tasks (task, A-V)
 * using the cheapest capable model available.
 */
export class TaskClassifier {
  /**
   * @param {Object} deps
   * @param {function(string): object} deps.getClient        — get SDK client for a provider
   * @param {function(): string[]}     deps.getAvailableProvidersFn — returns list of available providers
   * @param {function(string, object, string, object): object} deps.createLLMFn — creates LLM instance
   * @param {object}                   deps.costCenter       — cost center instance for recording usage
   * @param {function(string, string): void} deps.logFn      — logging function (category, message)
   * @param {function(): (Promise<void>|null)} [deps.waitForReadyFn] — optional
   *        hook awaited at the start of every classifier call. Lets callers
   *        (e.g. gateway mode) block classification until remote models have
   *        been loaded, avoiding a race where the first user message lands
   *        before `_availableProviders` is populated and the classifier gets
   *        "No models available" from a cold gateway.
   */
  constructor({ getClient, getAvailableProvidersFn, createLLMFn, costCenter, logFn, waitForReadyFn }) {
    this._getClient = getClient;
    this._getAvailableProvidersFn = getAvailableProvidersFn;
    this._createLLMFn = createLLMFn;
    this._costCenter = costCenter;
    this._log = logFn;
    this._waitForReadyFn = waitForReadyFn;
  }

  // ── Project context for task classifier (cached) ──────────────────────────
  _projectContextCache = null;
  _projectContextTs = 0;

  async _getProjectContext() {
    const now = Date.now();
    // Cache for 5 minutes — project structure doesn't change that fast
    if (this._projectContextCache && now - this._projectContextTs < 300_000) {
      return this._projectContextCache;
    }
    try {
      const projectDir = process.env.KOI_PROJECT_ROOT || process.cwd();
      const { execSync } = await import('child_process');
      // git ls-files is fast (~10ms) and gives us tracked files
      const output = execSync('git ls-files', { cwd: projectDir, encoding: 'utf8', timeout: 5000 });
      const files = output.trim().split('\n').filter(Boolean);
      const totalFiles = files.length;
      if (totalFiles === 0) return null;

      // Count by extension to determine languages
      const extCounts = {};
      for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (ext) extCounts[ext] = (extCounts[ext] || 0) + 1;
      }
      // Top 5 extensions
      const topExts = Object.entries(extCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([ext, count]) => `${ext}: ${count}`)
        .join(', ');

      // Check for monorepo markers
      const hasWorkspaces = files.some(f => f === 'pnpm-workspace.yaml' || f === 'lerna.json');
      const dirCount = new Set(files.map(f => f.split('/')[0])).size;

      let context = `Files: ${totalFiles}, Top types: ${topExts}, Top-level dirs: ${dirCount}`;
      if (hasWorkspaces) context += ', Monorepo: yes';
      if (totalFiles > 300) context += ', Scale: large';
      else if (totalFiles > 50) context += ', Scale: medium';
      else context += ', Scale: small';

      this._projectContextCache = context;
      this._projectContextTs = now;
      return context;
    } catch {
      return null;
    }
  }

  /**
   * Classify using the fastest/cheapest available model.
   * Delegates to classifyUserRequest (interaction) or classifyTaskDifficulty (agent task).
   */
  async classifyUserRequest(userMessage, agentName) {
    const taskDescription = `User request: ${userMessage.substring(0, 1000)}`;

    const prompt = `You are classifying a user request.

Pick the ONE category (A-G) that best describes this user request AND detect the natural language the user wrote it in (English name, e.g. "Spanish", "English", "French"). Return ONLY json: {"cat":"X","lang":"Language"}

IMPORTANT: Pick the category that MATCHES the request. Do NOT over-classify — a simple "create an app" is just C or D (the agent will decompose it). Only use E for requests that explicitly need multi-system integration or architecture redesign.

For "lang": return the English name of the natural language used in the request (e.g. "Spanish", "English", "French", "German", "Portuguese", "Italian", "Japanese", "Chinese", "Arabic", "Russian", "Dutch", "Polish"). If the message is too short or language-neutral (single emoji, code-only), return "English" as default.

CATEGORIES:

A: Greeting, chitchat, thanks, goodbye, casual conversation — no real task
B: Simple question — factual, explanation, comparison, non-technical — no code needed
C: Quick task — a single direct action: rename, fix typo, small script, find something in codebase, explain code, run a command
D: Moderate task — a focused feature, bug fix, creative/media production (image, poster, video, infographic), review, or investigation
E: Complex task — needs planning, decomposition, multi-file changes, integration, or architecture decisions
F: Review or audit — code review, security audit, quality check, performance analysis
G: Ops / infrastructure — deploy, run services, check logs, manage environments, CI/CD

EXAMPLES:

A: "hello", "hola qué tal", "thanks!", "bye", "good morning", "hey", "gracias", "ok"
B: "what's the capital of France?", "explain what Kubernetes is", "compare React vs Vue", "what time is it?", "summarize this article"
C: "rename userId to user_id", "fix the typo", "write a bash script to backup the DB", "where is the auth middleware?", "how does the login flow work?", "add a loading spinner", "change the port to 8080", "run flutter run", "npm start"
D: "add a GET /health endpoint with tests", "fix the checkout bug", "implement email verification", "add Stripe integration", "the button doesn't work on mobile", "generate an image of a cat", "make me a poster about X", "create an infographic", "design a logo", "hazme un dibujo realista"
E: "build a notification system", "refactor auth into a shared module", "create a multi-tenant architecture", "implement real-time collaboration", "build a custom template engine", "haz una app de gestión tributaria", "create an infographic researching a topic from the web with high quality prompts"
F: "review this PR", "check for security issues", "audit the API for OWASP top 10", "review queries for N+1 problems"
G: "deploy to production", "check the Railway logs", "docker compose up", "why aren't emails sending?", "the CI pipeline broke", "restart the backend service", "check if SSL cert is valid"

${taskDescription}`;

    const CATEGORY_PROFILES = {
      A: { code: 0,   reasoning: 10,  risk: 0,  reasoningEffort: EFFORT_NONE },
      B: { code: 0,   reasoning: 20,  risk: 0,  reasoningEffort: EFFORT_NONE },
      C: { code: 30,  reasoning: 25,  risk: 10, reasoningEffort: EFFORT_LOW },
      D: { code: 45,  reasoning: 40,  risk: 15, reasoningEffort: EFFORT_LOW },
      E: { code: 60,  reasoning: 55,  risk: 20, reasoningEffort: EFFORT_MEDIUM },
      F: { code: 50,  reasoning: 50,  risk: 10, reasoningEffort: EFFORT_LOW },
      G: { code: 40,  reasoning: 45,  risk: 50, reasoningEffort: EFFORT_LOW },
    };

    return this._runClassifier(prompt, CATEGORY_PROFILES, 'interaction', agentName);
  }

  async classifyTaskDifficulty(playbookText, args, agentName) {
    const _taskText = args
      ? (args.userRequest || args.answer || args.description || args.instruction ||
         args.subject || args.question || args.agentRole ||
         (args.pendingTasks ? `Pending tasks: ${args.pendingTasks}` : null) ||
         JSON.stringify(args).substring(0, 500))
      : null;
    const taskDescription = _taskText
      ? `Task: ${_taskText.substring(0, 1000)}`
      : (playbookText ? `Role: ${playbookText.substring(0, 300)}` : 'No task provided');

    // Project context — helps the classifier gauge complexity relative to project size.
    // e.g. "rename userId" in a 5-file project ≠ "rename userId" in a 500-file monorepo.
    const projectContext = await this._getProjectContext();

    // Discovery context — what the agent found while exploring (files read, errors, scope).
    // Injected on reclassification so the classifier sees real complexity, not just the task description.
    const discoveryContext = args?.recentDiscovery || null;

    const prompt = `Pick the ONE category (A-V) that best matches this task. Return ONLY json: {"cat":"X"}

IMPORTANT: When in doubt between two categories, ALWAYS pick the HIGHER (more complex) one. Underestimating costs quality; overestimating costs pennies.

CRITICAL GUIDANCE (common mis-classifications):
- Writing/generating substantial content (documentation, README, architecture overview, BRAXIL.md, multi-section reports, project analyses "from top to bottom") is M or P — NEVER D or E. D/E are for ANSWERING questions in chat, not for producing multi-kilobyte deliverables.
- Any task that says "comprehensive", "full analysis", "top to bottom", "all sections", or lists explicit section headings is P (planning + decomposition needed).
- If the expected output is a file the agent has to write, it is at minimum M (multi-file work / real code output). Never A-E.
- Delegation to another agent ("invoke SoftwareDeveloper to do X") inherits X's complexity — classify by WHAT is being delegated, not by the delegation wrapper.
${projectContext ? `\nPROJECT CONTEXT (use this to gauge complexity — a rename in a 500-file project is harder than in a 5-file project):\n${projectContext}\n` : ''}${discoveryContext ? `\nDISCOVERY CONTEXT (what the agent found while exploring — use this to refine your estimate):\n${discoveryContext}\n` : ''}

CATEGORIES:

A: Simple text/config change — rename a variable, fix a typo in a string literal, update a version number. NOT code logic, NOT CSS/style changes, NOT anything requiring reading code structure.
B: Write a simple script or query — small Python script, single SQL query, bash one-liner
C: Look up / find something in the codebase — "where is auth implemented?", "find the email config"
D: Explain how something works in the codebase — "how does the login flow work?", "what does this function do?"
E: Read and understand code to answer a question — "what system does the frontend use for email?"
F: Simple bug fix or CSS/style change in one file — off-by-one, null check, wrong condition, missing import, change colors, add gradient, modify padding/margin, change font
G: UI design / visual adaptation — adapt colors from a reference image, redesign a page's look and feel, match a mockup/screenshot. Requires vision and strong code output.
G2: Creative media production — generate an image, poster, infographic, logo, video, audio. Requires understanding the subject, crafting a detailed prompt, and producing high-quality output.
H: Add form validation, input handling, basic interactivity, add a simple UI element (button, toggle, spinner)
I: Implement a small feature (one file, straightforward) — add an endpoint, add a column, add a filter
J: Review or audit code — PR review, security review, code quality check
K: Run CLI commands, launch apps, interact with external services — railway, docker, kubectl, aws, heroku, ssh, emulators, simulators, dev servers
L: Investigate infrastructure / DevOps issue — "why aren't emails sending?", "check production logs", "debug the deploy pipeline"
M: Implement a feature touching 2-3 files — new API endpoint with DB + route + handler
N: Integrate an external service — Stripe, SendGrid, OAuth provider, S3, push notifications
O: Fix a bug that spans multiple files or requires understanding a flow
P: Plan implementation — break a feature into tasks, design the approach, create a roadmap
Q: Database work — schema migration, complex queries, data modeling, indexing, performance tuning
R: Refactor across multiple files — rename a concept everywhere, extract a module, reorganize structure
S: Debug a complex issue — race condition, intermittent failure, production-only bug, performance problem
T: Design architecture — system design, API design, multi-service coordination, scalability planning
U: Expert-level engineering — compiler, distributed systems, CRDT, custom protocol, AST manipulation
V: Coordinate / delegate — route tasks to agents, manage execution, orchestrate multi-step workflows

If NONE of the above categories fit, pick the closest one. When torn between two options, ALWAYS pick the harder/more complex one — it is much better to overestimate than underestimate.

EXAMPLES:

A: "rename userId to user_id", "fix the typo in the error message", "change the port from 3000 to 8080", "update the version to 2.1.0" — NOTE: CSS changes, style modifications, adding gradients, changing layouts are NOT A — they are F or higher
B: "write a script to rename all .txt files", "SQL query to count active users", "bash script to backup the DB"
G2: "generate an image of a cat", "make me a logo", "hazme un dibujo realista", "create a poster about climate change", "design an infographic about Artemis 2", "make me a high-quality illustration"
C: "where is the auth middleware?", "find where password reset is handled", "locate the email sending code", "find all API routes"
D: "how does the login flow work?", "explain the billing system", "what happens when a user signs up?"
E: "what email provider does the backend use?", "what ORM is this project using?", "what database engine are we using?"
F: "fix the null pointer on line 42", "the button doesn't disable after click", "off-by-one error in pagination", "missing await on async call", "add a rainbow gradient to the title", "change the background color", "make the text bigger", "add a CSS animation", "change the font"
G: "adapt the colors to match this screenshot", "redesign the page to look like the mockup", "change the CSS to match the reference image", "create a landing page design from scratch"
H: "add email validation to the signup form", "add a character counter to the textarea", "add a logout button to the navbar", "add a loading spinner"
I: "add a GET /health endpoint", "add a 'role' column to the users table", "add a search filter to the user list", "create a simple CRUD for tags"
J: "review this pull request", "check this code for security issues", "audit the API for OWASP top 10"
K: "docker compose logs backend", "check if the SSL cert is valid", "list running pods in staging", "run flutter run", "npm start"
L: "why aren't password reset emails arriving?", "the deploy failed, investigate", "production API is slow, check the logs"
M: "add user profile endpoint with DB + route + tests", "implement email verification flow", "add a comments feature to posts"
N: "integrate Stripe for payments", "add Google OAuth login", "set up SendGrid for transactional emails"
O: "the checkout flow sometimes charges twice", "login works on web but fails on mobile", "images upload but don't show in the gallery"
P: "plan how to implement the notification system", "break down the migration to TypeScript", "create tasks for the new onboarding flow"
Q: "add an index to speed up user lookups", "migrate from SQL to Drizzle ORM", "design the schema for a chat system"
R: "rename 'workspace' to 'organization' everywhere", "extract the auth logic into a shared module", "split the monolith API into separate route files"
S: "race condition in concurrent checkout", "memory leak in the WebSocket handler", "intermittent 502 errors in production"
T: "design the architecture for real-time collaboration", "plan the multi-region deployment strategy", "API gateway design for microservices"
U: "build a custom template engine", "implement Raft consensus for our cluster", "write a CSS parser from scratch"
V: "coordinate the implementation of features 1-5", "delegate tasks to developers and track progress", "execute the planned migration steps"

Task:

${taskDescription}`;

    // Effort policy:
    //   low    — trivial lookup / one-liner / small fix (A-C, F, H, K)
    //   medium — real multi-step work (D, E, G/G2, I, J, L, M, N, O, Q, R, V)
    //   high   — planning, debugging complex flows, architecture, expert-level (P, S, T, U)
    // Default to medium. Low is the exception, not the rule — under-classifying
    // causes reasoning models to hallucinate success without doing work.
    const CATEGORY_PROFILES = {
      A: { code: 40,  reasoning: 10,  risk: 10, reasoningEffort: EFFORT_LOW },
      B: { code: 40,  reasoning: 30,  risk: 10, reasoningEffort: EFFORT_LOW },
      C: { code: 50,  reasoning: 50,  risk: 10, reasoningEffort: EFFORT_LOW },
      D: { code: 60,  reasoning: 60,  risk: 10, reasoningEffort: EFFORT_MEDIUM },
      E: { code: 60,  reasoning: 60,  risk: 10, reasoningEffort: EFFORT_MEDIUM },
      F: { code: 60,  reasoning: 50,  risk: 20, reasoningEffort: EFFORT_LOW },
      G: { code: 70,  reasoning: 70,  risk: 10, reasoningEffort: EFFORT_MEDIUM },
      G2: { code: 50,  reasoning: 70,  risk: 10, reasoningEffort: EFFORT_MEDIUM },
      H: { code: 50,  reasoning: 40,  risk: 10, reasoningEffort: EFFORT_LOW },
      I: { code: 60,  reasoning: 50,  risk: 20, reasoningEffort: EFFORT_MEDIUM },
      J: { code: 60,  reasoning: 60,  risk: 10, reasoningEffort: EFFORT_MEDIUM },
      K: { code: 50,  reasoning: 70,  risk: 70, reasoningEffort: EFFORT_LOW },
      L: { code: 60,  reasoning: 75,  risk: 60, reasoningEffort: EFFORT_MEDIUM },
      M: { code: 70,  reasoning: 60,  risk: 30, reasoningEffort: EFFORT_MEDIUM },
      N: { code: 70,  reasoning: 70,  risk: 40, reasoningEffort: EFFORT_MEDIUM },
      O: { code: 70,  reasoning: 70,  risk: 30, reasoningEffort: EFFORT_MEDIUM },
      P: { code: 60,  reasoning: 85,  risk: 10, reasoningEffort: EFFORT_HIGH },
      Q: { code: 70,  reasoning: 60,  risk: 20, reasoningEffort: EFFORT_MEDIUM },
      R: { code: 75,  reasoning: 70,  risk: 20, reasoningEffort: EFFORT_MEDIUM },
      S: { code: 80,  reasoning: 80,  risk: 30, reasoningEffort: EFFORT_HIGH },
      T: { code: 60,  reasoning: 85,  risk: 10, reasoningEffort: EFFORT_HIGH },
      U: { code: 90,  reasoning: 85,  risk: 20, reasoningEffort: EFFORT_HIGH },
      V: { code: 60,  reasoning: 70,  risk: 20, reasoningEffort: EFFORT_MEDIUM },
    };

    return this._runClassifier(prompt, CATEGORY_PROFILES, 'task', agentName);
  }

  /**
   * Run a JSON-returning completion on the cheapest capable model.
   *
   * Used by any caller that needs a fast, cheap, structured LLM call
   * (classifiers, routers, small decisions). Returns the parsed JSON
   * or `null` if every candidate fails.
   *
   * @param {string} prompt
   * @param {Object} [opts]
   * @param {number} [opts.timeoutMs=5000]
   * @param {number} [opts.maxTokens=800]
   * @param {number} [opts.minReasoning=40]  — min reasoning score required from candidate models
   * @param {string} [opts.label='cheap-json'] — used for logs
   * @returns {Promise<Object|null>}
   */
  async runCheapJsonCompletion(prompt, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const maxTokens = opts.maxTokens ?? 800;
    const minReasoning = opts.minReasoning ?? 40;
    const label = opts.label || 'cheap-json';

    // Wait for remote model list to finish loading (gateway mode) before
    // asking the factory for candidates. Without this, a message that lands
    // in the first ~700ms after engine start hits an empty provider list.
    try { await this._waitForReadyFn?.(); } catch (_) {}

    const _allModels = getAllCandidates('reasoning', minReasoning, this._getAvailableProvidersFn());
    const _candidates = _allModels.map(c => ({
      client: this._getClient(c.provider),
      model: c.model,
      provider: c.provider,
      caps: c.caps || {},
    }));

    if (_candidates.length === 0) {
      this._log('llm', `[${label}] No models available`);
      return null;
    }

    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    for (const candidate of _candidates) {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this._log('llm', `[${label}] Circuit breaker: ${consecutiveFailures} consecutive failures — giving up`);
        break;
      }
      try {
        const effectiveProvider = process.env.KOI_AUTH_TOKEN ? 'openai' : candidate.provider;
        const client = process.env.KOI_AUTH_TOKEN ? this._getClient('openai') : candidate.client;
        const llm = this._createLLMFn(effectiveProvider, client, candidate.model, { temperature: 0, maxTokens, useThinking: false });
        const { text: content, usage: _u } = await llm.complete(
          [{ role: 'user', content: prompt }],
          { timeoutMs, responseFormat: 'json_object' }
        );
        consecutiveFailures = 0;
        const inputTokens = _u?.input || 0, outputTokens = _u?.output || 0;
        this._costCenter.recordUsage(candidate.model, candidate.provider, inputTokens, outputTokens);
        const _stripped = (content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        try {
          return JSON.parse(_stripped);
        } catch (e) {
          this._log('llm', `[${label}] Invalid JSON from ${candidate.model}: ${e.message}`);
          // Fall through — try the next candidate
        }
      } catch (e) {
        consecutiveFailures++;
        this._log('llm', `[${label}] ${candidate.model} failed: ${e.message} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      }
    }
    return null;
  }

  /**
   * Shared classifier execution — sends prompt to cheapest capable model, parses category response.
   */
  async _runClassifier(prompt, CATEGORY_PROFILES, classifierType, agentName) {
    const _debug = !!process.env.KOI_DEBUG_LLM;
    if (process.env.KOI_LOG_CLASSIFIER_PROMPTS) {
      this._log('classify-prompt', `--- ${classifierType.toUpperCase()} CLASSIFIER PROMPT ---\n${prompt}\n--- END ---`);
    }
    this._log('llm', `[classify] Using ${classifierType} classifier`);

    // Wait for remote model list to finish loading (gateway mode) before
    // asking the factory for candidates. Without this, a cold-start message
    // gets "No models available" even though providers arrive ~700ms later.
    try { await this._waitForReadyFn?.(); } catch (_) {}

    // Get candidate models for classification, sorted by cost (cheapest first).
    // The classifier MUST be a competent model — a weak model (like nano) will underestimate
    // task complexity and then get selected for the task itself, creating a feedback loop.
    // Minimum reasoning:40 ensures we skip nano/haiku/lite but allow flash/gpt-5.1 as classifiers.
    const _allModels = getAllCandidates('reasoning', 40, this._getAvailableProvidersFn());
    const _candidates = _allModels.map(c => ({
      client: this._getClient(c.provider),
      model: c.model,
      provider: c.provider,
      caps: c.caps || {},
    }));

    if (_candidates.length === 0) {
      this._log('llm', `[classify] No models available for classification — default profile`);
      return DEFAULT_TASK_PROFILE;
    }
    this._log('llm', `[classify] ${_candidates.length} candidate models: ${_candidates.map(c => c.model).join(', ')}`);

    this._log('llm', `[classify] Using ${_candidates[0].model} for classification`);

    // Circuit breaker: if 3 consecutive models fail (timeout/error), the gateway
    // is likely down. Stop trying and use the default profile immediately instead
    // of wasting 15s × N_remaining models.
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    for (const candidate of _candidates) {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this._log('llm', `[classify] Circuit breaker: ${consecutiveFailures} consecutive failures — gateway likely down, using default`);
        break;
      }
      this._log('llm', `[classify] Trying ${candidate.model}...`);
      try {
        // Use the correct adapter for each provider (OpenAI Chat/Responses, Anthropic, Gemini).
        // In gateway mode, all providers route through the OpenAI-compatible gateway.
        const effectiveProvider = process.env.KOI_AUTH_TOKEN ? 'openai' : candidate.provider;
        const client = process.env.KOI_AUTH_TOKEN ? this._getClient('openai') : candidate.client;
        const llm = this._createLLMFn(effectiveProvider, client, candidate.model, { temperature: 0, maxTokens: 800, useThinking: false });
        const { text: content, usage: _u } = await llm.complete([{ role: 'user', content: prompt }], { timeoutMs: 5000, responseFormat: 'json_object' });
        consecutiveFailures = 0; // reset on success
        const inputTokens = _u.input || 0, outputTokens = _u.output || 0;
        this._costCenter.recordUsage(candidate.model, candidate.provider, inputTokens, outputTokens);
        this._log('llm', `[classify] Raw response: ${content.substring(0, 200)}`);
        const _stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const json = JSON.parse(_stripped);
        // Optional language detection — only present when classifying
        // an interaction (classifyUserRequest). Normalized and validated.
        const _lang = _normalizeLanguage(json.lang || json.language || null);
        // Category format: { cat: "A"-"Z" }
        if (json.cat) {
          const cat = String(json.cat).toUpperCase();
          const catProfile = CATEGORY_PROFILES[cat];
          if (catProfile) {
            const { code: codeScore, reasoning: reasoningScore, risk: riskLevel = 0, reasoningEffort: effort = 'medium' } = catProfile;
            // Only enable thinking for HIGH effort. Medium is fast enough
            // without extended reasoning — thinking adds minutes of latency
            // for marginal quality improvement on most tasks.
            const needsThinking = effort === 'high';
            const taskType = codeScore >= reasoningScore ? 'code' : 'reasoning';
            const difficulty = Math.max(codeScore, reasoningScore);
            const profile = { taskType, difficulty, code: codeScore, reasoning: reasoningScore, thinking: needsThinking, risk: riskLevel, reasoningEffort: effort };
            if (_lang) profile.userLanguage = _lang;
            this._log('llm', `[classify] Category ${cat} → code=${codeScore} reasoning=${reasoningScore} effort=${effort} risk=${riskLevel}${_lang ? ` lang=${_lang}` : ''}`);
            return profile;
          }
          this._log('llm', `[classify] Unknown category "${cat}" from ${candidate.model}`);
        }
        // Fallback: direct scores format { code: 0-100, reasoning: 0-100, thinking: true/false }
        if (json.code != null && json.reasoning != null) {
          const codeScore = Math.min(100, Math.max(0, Number(json.code)));
          const reasoningScore = Math.min(100, Math.max(0, Number(json.reasoning)));
          const needsThinking = json.thinking === true || json.thinking === 'true';
          const taskType = codeScore >= reasoningScore ? 'code' : 'reasoning';
          const difficulty = Math.max(codeScore, reasoningScore);
          const profile = { taskType, difficulty, code: codeScore, reasoning: reasoningScore, thinking: needsThinking };
          this._log('llm', `[classify] Direct scores: code=${codeScore} reasoning=${reasoningScore} thinking=${needsThinking}`);
          return profile;
        }
        this._log('llm', `[classify] Invalid shape from ${candidate.model}: ${JSON.stringify(json)}`);
      } catch (e) {
        // Quota exceeded — don't burn through more fallback candidates, we
        // already know none of them will succeed. Fall back to the default
        // profile immediately so the real LLM call (which will itself 402)
        // happens ASAP and surfaces the upgrade dialog.
        const _s = e?.status ?? e?.statusCode;
        if (_s === 402 || e?.name === 'QuotaExceededError' || /QUOTA_EXCEEDED/i.test(e?.message || '')) {
          this._log('llm', `[classify] ${candidate.model} → 402 quota exceeded — skipping remaining candidates`);
          break;
        }
        consecutiveFailures++;
        this._log('llm', `[classify] ${candidate.model} failed: ${e.message} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} consecutive)`);
      }
    }
    this._log('llm', `[classify] All candidates failed — default profile ${DEFAULT_TASK_PROFILE.taskType}:${DEFAULT_TASK_PROFILE.difficulty}`);
    return DEFAULT_TASK_PROFILE;
  }
}

/** Normalize a language string returned by the classifier. Returns
 *  a trimmed English language name or null for obvious non-values. */
function _normalizeLanguage(lang) {
  if (!lang || typeof lang !== 'string') return null;
  const trimmed = lang.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'null' || lower === 'unknown' || lower === 'n/a' || lower === 'none') return null;
  // Capitalize: "spanish" → "Spanish"
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}
