import path from 'path';
import { getAllCandidates, DEFAULT_TASK_PROFILE } from './providers/factory.js';
import { EFFORT_NONE, EFFORT_LOW, EFFORT_MEDIUM, EFFORT_HIGH } from './constants.js';
import { hasKoiApi } from '../api/koi-api.js';

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

CRITICAL: A request to perform a REAL-WORLD ACTION on the user's behalf through an external integration — publish/post/share to a social network (X, LinkedIn, Instagram…), send an email or message, deploy, make a payment, place an order, delete data — is NEVER A, B or C. It looks short ("post X to Twitter") but it requires careful tool/skill orchestration (activate the skill, run the right command with the right arguments, handle accounts/OAuth, and VERIFY it actually happened) and carries irreversible side effects. A weak model fabricates success without doing the work. Classify these as at least D (or G for pure ops/deploy).

For "lang": return the English name of the natural language used in the request (e.g. "Spanish", "English", "French", "German", "Portuguese", "Italian", "Japanese", "Chinese", "Arabic", "Russian", "Dutch", "Polish"). If the message is too short or language-neutral (single emoji, code-only), return "English" as default.

CATEGORIES:

A: Greeting, chitchat, thanks, goodbye, casual conversation — no real task
B: Simple question — factual, explanation, comparison, non-technical — no code needed
C: Quick task — a single direct action: rename, fix typo, small script, find something in codebase, explain code, run a command. NOTE: actions with external side effects on the user's behalf (publish/send/deploy/pay) do NOT belong here — see the CRITICAL note above.
D: Moderate task — a focused feature, bug fix, creative/media production (image, poster, video, infographic), review, investigation, OR performing a side-effecting external action on the user's behalf (publish/post/share to a social network, send an email/message)
E: Complex task — needs planning, decomposition, multi-file changes, integration, or architecture decisions
F: Review or audit — code review, security audit, quality check, performance analysis
G: Ops / infrastructure — deploy, run services, check logs, manage environments, CI/CD

EXAMPLES:

A: "hello", "hola qué tal", "thanks!", "bye", "good morning", "hey", "gracias", "ok"
B: "what's the capital of France?", "explain what Kubernetes is", "compare React vs Vue", "what time is it?", "summarize this article"
C: "rename userId to user_id", "fix the typo", "write a bash script to backup the DB", "where is the auth middleware?", "how does the login flow work?", "add a loading spinner", "change the port to 8080", "run flutter run", "npm start"
D: "add a GET /health endpoint with tests", "fix the checkout bug", "implement email verification", "add Stripe integration", "the button doesn't work on mobile", "generate an image of a cat", "make me a poster about X", "create an infographic", "design a logo", "hazme un dibujo realista", "publica un post en X que diga ...", "post this to LinkedIn", "share this on Instagram", "send this email to the team", "tuitea esto"
E: "build a notification system", "refactor auth into a shared module", "create a multi-tenant architecture", "implement real-time collaboration", "build a custom template engine", "haz una app de gestión tributaria", "create an infographic researching a topic from the web with high quality prompts"
F: "review this PR", "check for security issues", "audit the API for OWASP top 10", "review queries for N+1 problems"
G: "deploy to production", "check the Railway logs", "docker compose up", "why aren't emails sending?", "the CI pipeline broke", "restart the backend service", "check if SSL cert is valid"

${taskDescription}`;

    // Capability floor: ONLY greetings/chitchat (A) stay on a cheap model.
    // Everything else floors reasoning above 50 so a low-reasoning flash model
    // (e.g. Gemini 3 Flash @39) is never selected — even a "simple" question or
    // quick task hallucinates / makes things up on the cheap tier, and
    // overestimating costs pennies while underestimating costs quality.
    const CATEGORY_PROFILES = {
      A: { code: 0,   reasoning: 10,  risk: 0,  reasoningEffort: EFFORT_NONE },
      B: { code: 30,  reasoning: 55,  risk: 0,  reasoningEffort: EFFORT_LOW },
      C: { code: 45,  reasoning: 55,  risk: 10, reasoningEffort: EFFORT_LOW },
      // Media production (image/poster/infographic) and complex tasks need a
      // capable model: reasoning 65 keeps low-reasoning models (e.g. Gemini 3
      // Flash @39) out, which otherwise botch detailed prompt assembly.
      D: { code: 50,  reasoning: 65,  risk: 15, reasoningEffort: EFFORT_MEDIUM },
      E: { code: 60,  reasoning: 65,  risk: 20, reasoningEffort: EFFORT_MEDIUM },
      F: { code: 55,  reasoning: 60,  risk: 10, reasoningEffort: EFFORT_MEDIUM },
      G: { code: 50,  reasoning: 60,  risk: 50, reasoningEffort: EFFORT_MEDIUM },
    };

    return this._runClassifier(prompt, CATEGORY_PROFILES, 'interaction', agentName);
  }

  async classifyTaskDifficulty(playbookText, args, agentName, opts = {}) {
    const _named = args
      ? (args.userRequest || args.answer || args.description || args.instruction ||
         args.subject || args.question || args.agentRole ||
         (args.pendingTasks ? `Pending tasks: ${args.pendingTasks}` : null))
      : null;
    // A handler's arguments are usually data (ids, dates, flags), not a description of the work: classifying their
    // JSON alone told the classifier nothing, so it fell back on «pick the higher one». When none of them describes
    // the task, the handler's own instructions (its playbook) do, with the arguments beside them as inputs.
    const _playbook = typeof opts.playbook === 'string' && opts.playbook.trim() ? opts.playbook.trim() : null;
    const _taskText = _named
      || (_playbook ? `Instructions given to the agent:\n${_playbook.length > 1600 ? `${_playbook.substring(0, 1000)}\n[…]\n${_playbook.slice(-600)}` : _playbook}${args ? `\n\nInputs: ${JSON.stringify(args).substring(0, 300)}` : ''}` : null)
      || (args ? JSON.stringify(args).substring(0, 500) : null);
    const taskDescription = _taskText
      ? `Task: ${_taskText.substring(0, 2000)}`
      : (playbookText ? `Role: ${playbookText.substring(0, 300)}` : 'No task provided');

    // An agent whose role cannot touch code (no `write`, no `use_lsp`) is classified with a table of GENERAL work:
    // every category of the software table below is programming, so a travel planner or a text writer could only
    // land on «implement a feature touching 2-3 files» and was sent to the most expensive model for it.
    if (opts.kind === 'general') return this._classifyGeneralTask(taskDescription, args, agentName);

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
- Performing a real-world action with EXTERNAL SIDE EFFECTS on the user's behalf (publish/post/share to a social network, send an email/message, deploy, make a payment, place an order) is K or N — NEVER A/B/C. It requires running the right tool/skill with correct arguments and verifying it actually happened; a weak model hallucinates success without acting.
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
      // G2 runs the media-production skills (infographic, slide-deck, poster…):
      // multi-step flows that read reference specs and assemble long prompts.
      // reasoning 80 + high effort keeps small models out — a nano-class model
      // skips the skill's read steps and improvises vague prompts (seen live).
      G2: { code: 50,  reasoning: 80,  risk: 10, reasoningEffort: EFFORT_HIGH },
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
   * The table for an agent that does not program: it reads, looks things up through its tools, decides, plans and
   * writes prose. Code scores stay low (a tool call needs valid JSON, not software engineering) and the reasoning
   * score carries the difficulty. No project file list: the repository the backend lives in says nothing about how
   * hard it is to plan a day or write a paragraph.
   */
  async _classifyGeneralTask(taskDescription, args, agentName) {
    const discoveryContext = args?.recentDiscovery || null;
    const escalation = args?.escalationReason ? `\nESCALATION: ${args.escalationReason}\n` : '';
    const prompt = `Pick the ONE category that best matches the work this agent has to do. Return ONLY json: {"cat":"XX"}

This agent does NOT write software: it reads, looks things up through its tools, decides, plans and writes text.
Judge the difficulty of THAT work. Pick the category that fits; do not inflate it. Long instructions or many rules do
not make a task hard by themselves: what matters is how much judgement the result needs. When the work has several
steps, classify the hardest step it really needs, not the sum of them.
${escalation}${discoveryContext ? `\nWHAT THE AGENT FOUND SO FAR:\n${discoveryContext}\n` : ''}
CATEGORIES (code: example)

TRANSFORM (the answer is already in the input)
X1: Reformat or normalise: dates, numbers, names, casing, units ("pass these dates to dd/mm/yyyy")
X2: Extract fields from a text into a fixed shape ("take the hotel, the nights and the meal plan out of this paragraph")
X3: Translate a short text, or keep a text and change only its language ("translate this title into English")
X4: Fill a template or a fixed structure with given data ("put these values into the day's JSON")
X5: Split, merge, sort or deduplicate a given list ("remove the repeated places of this list")

LOOK UP (the answer is in a catalogue, a library or a database reached through tools)
L1: Fetch one known record by its id or exact name ("get the day 3 of the reservation")
L2: Search by name and pick the obvious match ("find the Alhambra in the library")
L3: Match several items to a catalogue, with spelling variants and near names ("match each stop of the day to a point of interest")
L4: Match with ambiguity that needs context to settle: same name in two cities, a place known by two names, partial data
L5: Find what is missing: compare what was asked with what exists and list the gaps

DECIDE
D1: Yes/no or one label from a short fixed list ("is this a complaint or a question?")
D2: Choose the best of a few given options with a simple criterion ("which of these three photos is the cover?")
D3: Rank or score items against several criteria
D4: Check a result against explicit rules and say what breaks them ("does this plan respect the opening hours?")

WRITE (prose a person reads)
W1: One line: a title, a label, a caption, a short name
W2: A short paragraph from given facts: a description, a notice, a reply
W3: Several paragraphs with structure and a given tone: a section of a guide, an introduction, an email
W4: A long document with sections that must agree with each other
W5: Rewrite or correct an existing text: style, tone, length, house rules

PLAN
P1: Order a few steps that have an obvious order
P2: A day or a schedule with times, distances and opening hours ("plan the visits of the day in a sensible order")
P3: Several days or resources with constraints between them ("split the trip into days by city and travel time")
P4: An allocation or a plan with many competing constraints and trade-offs

TOOL WORK (several tool calls with a result to deliver)
T1: Call one tool with the right arguments and return what it says
T2: Read, look up and submit a result, once
T3: Submit, read the validation and correct until it is accepted ("resolve the day: find its places, submit the plan and fix it until it is written")
T4: A long workflow with branches, retries and state across many calls

ANALYSE
A1: Summarise one document or one record
A2: Compare two versions or two sources and list the differences
A3: Reconcile many documents or records, find contradictions and consolidate them
A4: Investigate why something is wrong from scattered evidence

COORDINATE
C1: Hand a clear piece of work to one other agent and pass back its answer
C2: Split work among several agents, check and merge what they return

HIGH STAKES
H1: Expert judgement: legal, financial, medical, contractual
H2: An action with irreversible consequences for a person: pay, send, sign, delete, publish

${taskDescription}`;

    const p = (code, reasoning, risk, reasoningEffort) => ({ code, reasoning, risk, reasoningEffort });
    const CATEGORY_PROFILES = {
      X1: p(0, 10, 0, EFFORT_NONE),  X2: p(0, 20, 0, EFFORT_NONE),  X3: p(0, 25, 0, EFFORT_NONE),
      X4: p(10, 15, 0, EFFORT_NONE), X5: p(0, 15, 0, EFFORT_NONE),
      L1: p(15, 15, 0, EFFORT_NONE), L2: p(15, 30, 0, EFFORT_LOW),  L3: p(20, 45, 10, EFFORT_LOW),
      L4: p(20, 60, 10, EFFORT_MEDIUM), L5: p(15, 50, 10, EFFORT_LOW),
      D1: p(0, 20, 0, EFFORT_NONE),  D2: p(0, 35, 0, EFFORT_LOW),   D3: p(0, 50, 10, EFFORT_LOW),
      D4: p(10, 55, 10, EFFORT_LOW),
      W1: p(0, 20, 0, EFFORT_NONE),  W2: p(0, 35, 0, EFFORT_LOW),   W3: p(0, 50, 10, EFFORT_LOW),
      W4: p(0, 65, 10, EFFORT_MEDIUM), W5: p(0, 35, 0, EFFORT_LOW),
      P1: p(0, 30, 0, EFFORT_LOW),   P2: p(10, 55, 10, EFFORT_MEDIUM), P3: p(10, 65, 20, EFFORT_MEDIUM),
      P4: p(10, 80, 20, EFFORT_HIGH),
      T1: p(20, 20, 10, EFFORT_NONE), T2: p(20, 40, 10, EFFORT_LOW), T3: p(25, 55, 20, EFFORT_MEDIUM),
      T4: p(30, 70, 20, EFFORT_MEDIUM),
      A1: p(0, 35, 0, EFFORT_LOW),   A2: p(0, 45, 10, EFFORT_LOW),  A3: p(10, 75, 30, EFFORT_MEDIUM),
      A4: p(10, 75, 20, EFFORT_MEDIUM),
      C1: p(10, 30, 10, EFFORT_LOW), C2: p(15, 60, 20, EFFORT_MEDIUM),
      H1: p(10, 85, 60, EFFORT_HIGH), H2: p(20, 75, 80, EFFORT_MEDIUM),
    };

    return this._runClassifier(prompt, CATEGORY_PROFILES, 'task-general', agentName);
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
        const effectiveProvider = hasKoiApi() ? 'openai' : candidate.provider;
        const client = hasKoiApi() ? this._getClient('openai') : candidate.client;
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

    // Candidate models for classification. The classifier MUST be a competent
    // model — a weak one (like nano) underestimates task complexity and then
    // gets selected for the task itself, a feedback loop. Minimum reasoning:40
    // skips nano/haiku/lite but allows flash/gpt-5.1 as classifiers.
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

    // Order so the FIRST candidate is "fast enough, then cheapest". A classify
    // call is a tiny, low-stakes JSON call on the hot path before every reply —
    // it must not blow the 5s timeout, but it also must NOT default to the most
    // EXPENSIVE model just because it scores highest on raw speed (that's how
    // gpt-5.4 — $17.5/1M — was winning over gemini-flash — $10.5/1M, reasoning
    // 96 — which classifies just as well). Two regimes:
    //   • OBSERVED latency present (/gateway/models.json p50LatencyMs): fastest
    //     wins, but ties WITHIN a latency band break by COST (sub-band latency
    //     differences are noise — don't pay extra for them).
    //   • No observed latency yet (cold/local — the common case): among models
    //     FAST ENOUGH to clear the timeout (static speed ≥ floor), pick the
    //     CHEAPEST; below the floor fall back to fastest. So a timeout still
    //     falls back to the next-fastest, never a slow reasoning model.
    const _cost = (c) => (c.caps?.inputPer1M || 0) + (c.caps?.outputPer1M || 0);
    const SPEED_FLOOR = 50; // static speed below this risks the 5s classify timeout
    const LAT_BAND = 400;   // ms: latency differences under this are noise
    _candidates.sort((a, b) => {
      const ap = a.caps?.p50LatencyMs, bp = b.caps?.p50LatencyMs;
      const aHas = typeof ap === 'number', bHas = typeof bp === 'number';
      if (aHas && bHas) {
        const ab = Math.round(ap / LAT_BAND), bb = Math.round(bp / LAT_BAND);
        if (ab !== bb) return ap - bp;          // meaningfully different latency → fastest
        return _cost(a) - _cost(b);             // same band → cheaper
      }
      if (aHas !== bHas) return aHas ? -1 : 1;  // known-latency models first
      const aFast = (a.caps?.speed || 0) >= SPEED_FLOOR;
      const bFast = (b.caps?.speed || 0) >= SPEED_FLOOR;
      if (aFast !== bFast) return aFast ? -1 : 1;
      if (aFast) return _cost(a) - _cost(b) || (b.caps?.speed || 0) - (a.caps?.speed || 0);
      return (b.caps?.speed || 0) - (a.caps?.speed || 0); // both slow → fastest
    });

    this._log('llm', `[classify] ${_candidates.length} candidate models (fast-enough, then cheapest): ${_candidates.map(c => `${c.model}${typeof c.caps?.p50LatencyMs === 'number' ? `(${c.caps.p50LatencyMs}ms)` : ''}($${_cost(c)}/1M)`).join(', ')}`);

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
        const effectiveProvider = hasKoiApi() ? 'openai' : candidate.provider;
        const client = hasKoiApi() ? this._getClient('openai') : candidate.client;
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
        // Category format: { cat: "A"-"Z" }, or a family code like "L3" from the general table
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
