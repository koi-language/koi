import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { LLMProvider } from './llm-provider.js';
import { cliLogger, withSlot, registerSlotMeta, unregisterSlotMeta, getCurrentSlotId, clearSlotById } from './cli-logger.js';
import { actionRegistry } from './action-registry.js';
import { PlaybookSession } from './playbook-session.js';
import { buildActionDisplay } from './cli-display.js';
import { initSessionTracker, sessionTracker } from './session-tracker.js';
import { ContextMemory, classifyFeedback } from './context-memory.js';

// Per-async-context call stack: each parallel branch has its own isolated stack,
// so concurrent delegates to the same agent don't produce false "infinite loop" errors.
const _callStackStorage = new AsyncLocalStorage();

// Per-slot context memory map: parallel delegates of the same agent instance each
// get their own ContextMemory. Keyed by slot ID (from getCurrentSlotId()).
// The main (non-delegate) agent uses the '_main' key.
const _contextMemoryBySlot = new Map();


/**
 * Use LLM to infer action metadata from playbook
 * @param {string} playbook - The playbook text
 * @returns {Promise<{description: string, inputParams: string, returnType: string}>}
 */
async function inferActionMetadata(playbook) {
  try {
    if (process.env.KOI_DEBUG_LLM) {
      console.error('[InferActionMetadata] Analyzing playbook...');
    }

    if (!process.env.OPENAI_API_KEY) {
      return {
        description: 'Execute action',
        inputParams: '{ ... }',
        returnType: '{ "result": "any" }'
      };
    }

    // Call OpenAI API directly
    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'Extract action metadata from agent playbooks. Focus on UNIQUE, SPECIFIC characteristics that distinguish this action from others. Return ONLY valid JSON.'
          },
          {
            role: 'user',
            content: `Analyze this playbook and identify what makes it UNIQUE:\n\n${playbook}\n\nExtract:\n1. description: What makes THIS action unique and specific (15-20 words). Focus on:\n   - The specific role/persona (e.g., "left-wing activist", "philosopher", "poet")\n   - The unique perspective or style it brings\n   - What differentiates it from similar actions\n   Example: "Generates radical left-wing political response from activist perspective" NOT "Generates response"\n\n2. inputParams: Input parameters structure (look for \${args.X} references)\n   Example: { "context": "string", "conversation": "string" }\n\n3. returnType: Output structure (look for "Return:" or return statements)\n   Example: { "answer": "string" }\n\nRespond with JSON:\n{ "description": "...", "inputParams": "{ ... }", "returnType": "{ ... }" }\n\nNO markdown, NO explanations, ONLY JSON.`
          }
        ]
      })
    });

    const data = await response.json();
    let result = data.choices[0].message.content.trim();

    // Clean up response (remove markdown if present)
    if (result.startsWith('```')) {
      result = result.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }

    const parsed = JSON.parse(result);

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[InferActionMetadata] Result:`, parsed);
    }

    return {
      description: parsed.description || 'Execute action',
      inputParams: parsed.inputParams || '{ ... }',
      returnType: parsed.returnType || '{ "result": "any" }'
    };
  } catch (error) {
    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[InferActionMetadata] Error: ${error.message}`);
    }
    // If inference fails, use defaults
    return {
      description: 'Execute action',
      inputParams: '{ ... }',
      returnType: '{ "result": "any" }'
    };
  }
}

// Permission implication map: if an agent has the value permission,
// it also satisfies the key permission (e.g., "write" implies "read").
const PERMISSION_IMPLIES = {
  'read': ['write'],
  'read_tasks': ['write_tasks'],
};

export class Agent {
  /**
   * CLI hooks — injectable callbacks for UI integration.
   * Set by the CLI bootstrap layer (e.g. ink-bootstrap.js).
   * The runtime has no knowledge of the specific UI implementation.
   *
   * Interface: {
   *   onBusy(busy: boolean),      // Agent busy state changed
   *   getAbortSignal() → signal,  // Get AbortSignal for cancellation
   *   onInfo(text: string),       // Token/info line update (unused — use cliLogger.setInfo)
   *   onSlashCommands(cmds),      // Register slash commands for completion
   * }
   */
  static _cliHooks = null;
  static _cliBootstrapped = false;
  static _indexingStarted = false;
  static _lastActiveAgent = null;
  /** The root (System) agent — set once, used by slash commands like /memory. */
  static _rootAgent = null;

  /** Set CLI hooks from the bootstrap layer. */
  static setCliHooks(hooks) {
    Agent._cliHooks = hooks;
  }

  constructor(config) {
    this.name = config.name;
    this.description = config.description || null;
    this.role = config.role;
    this.skills = config.skills || [];
    this.usesTeams = config.usesTeams || []; // Teams this agent uses as a client
    this.usesMCPNames = config.usesMCP || []; // MCP server names this agent uses
    this.llm = config.llm || { provider: 'openai', model: 'gpt-4', temperature: 0.2 };
    this.state = config.state || {};
    this.playbooks = config.playbooks || {};
    this.resilience = config.resilience || null;
    this.amnesia = config.amnesia || false;
    this.exposesMCP = config.exposesMCP || false;
    this.contextMemoryState = null; // Serialized ContextMemory state across playbook executions

    // Never allow peers to be null - use a proxy that throws helpful error
    if (config.peers) {
      this.peers = config.peers;
    } else {
      this.peers = this._createNoTeamProxy();
    }

    this.handlers = config.handlers || {};

    // Initialize LLM provider if needed
    this.llmProvider = null;
  }

  /**
   * Create a proxy that throws a helpful error when trying to use peers without a team
   */
  _createNoTeamProxy() {
    // Return an object that mimics a Team but throws when execute() is called
    let eventName = 'unknown';
    const noTeamQuery = {
      __isNoTeamProxy: true, // Marker for Team constructor to detect and replace
      event: (name) => {
        eventName = name;
        return noTeamQuery;
      },
      role: () => noTeamQuery,
      any: () => noTeamQuery,
      all: () => noTeamQuery,
      execute: () => {
        throw new Error(`NO_AGENT_HANDLER:${eventName}::no-team`);
      }
    };
    return noTeamQuery;
  }

  /**
   * Get a specific team by reference (for peers(TeamName) syntax)
   * @param {Team} teamRef - Team instance or constructor
   * @returns {Team} The team instance
   */
  _getTeam(teamRef) {
    // If teamRef is already a Team instance, check if we have access to it
    if (teamRef && typeof teamRef === 'object') {
      // Check if it's the same instance as peers
      if (this.peers === teamRef) {
        return this.peers;
      }

      // Search in usesTeams array for the exact same instance
      if (Array.isArray(this.usesTeams)) {
        const team = this.usesTeams.find(t => t === teamRef);
        if (team) {
          return team;
        }
      }

      // Team not found - throw helpful error
      const teamName = teamRef.name || teamRef.constructor?.name || 'Unknown';
      throw new Error(
        `Agent ${this.name} does not have access to team ${teamName}.\n` +
        `Available teams: ${this.usesTeams.map(t => t?.name || t?.constructor?.name || 'Unknown').join(', ') || 'none'}\n` +
        `Hint: Add "uses Team ${teamName}" to the agent definition.`
      );
    }

    // If teamRef is a constructor/class, search by constructor
    if (typeof teamRef === 'function') {
      if (this.peers && this.peers.constructor === teamRef) {
        return this.peers;
      }

      if (Array.isArray(this.usesTeams)) {
        const team = this.usesTeams.find(t => t && t.constructor === teamRef);
        if (team) {
          return team;
        }
      }
    }

    throw new Error(
      `Agent ${this.name} could not find team.\n` +
      `Available teams: ${this.usesTeams.map(t => t?.name || t?.constructor?.name || 'Unknown').join(', ') || 'none'}`
    );
  }

  /**
   * Check if the agent has a specific permission
   * Supports hierarchical permissions: if role has "registry", it can execute "registry:read", "registry:write", etc.
   * Supports implied permissions: "write" implies "read", "write_tasks" implies "read_tasks".
   * @param {string} permissionName - Permission to check (e.g., 'execute', 'delegate', 'registry:read')
   * @returns {boolean} True if agent has the permission
   */
  hasPermission(permissionName) {
    if (!this.role) {
      return false;
    }

    // Check exact permission match first
    if (this.role.can(permissionName)) {
      return true;
    }

    // Check hierarchical permissions (e.g., "registry" covers "registry:read")
    if (permissionName.includes(':')) {
      const [prefix] = permissionName.split(':');
      if (this.role.can(prefix)) {
        return true;
      }
    }

    // Check implied permissions (e.g., "write" implies "read")
    const impliedBy = PERMISSION_IMPLIES[permissionName];
    if (impliedBy) {
      for (const p of impliedBy) {
        if (this.role.can(p)) {
          return true;
        }
      }
    }

    return false;
  }

  async handle(eventName, args, _fromDelegation = false, _parentAnswerFn = null) {
    // Bootstrap CLI layer (e.g. Ink) early — before any stdout writes.
    // When KOI_CLI_MODE is set, dynamically import the bootstrap module
    // which sets up providers on cliLogger, cliInput, cliSelect, and Agent.
    // The runtime never imports UI modules directly — only the bootstrap does.
    // The bootstrap module path is injected via KOI_CLI_BOOTSTRAP_PATH env var,
    // set by the CLI tool (e.g. koi-cli) before spawning the runtime process.
    if (process.env.KOI_CLI_MODE === '1' && !Agent._cliBootstrapped) {
      Agent._cliBootstrapped = true;
      const bootstrapPath = process.env.KOI_CLI_BOOTSTRAP_PATH;
      if (bootstrapPath) {
        const { bootstrapInk } = await import(bootstrapPath);
        await bootstrapInk();
        // After bootstrap, _cliHooks is set — register slash commands from command-registry
        if (Agent._cliHooks?.onSlashCommands) {
          const registryPath = process.env.KOI_CLI_COMMAND_REGISTRY_PATH;
          if (registryPath) {
            const { getCommandList } = await import(registryPath);
            const cmds = await getCommandList();
            Agent._cliHooks.onSlashCommands(cmds);
          }
        }
      }
      // Prompt for any missing API keys (OpenAI, Anthropic, Gemini)
      const { promptMissingApiKeys } = await import('./api-key-manager.js');
      await promptMissingApiKeys();
    }

    // Fire-and-forget: start project indexing in background (once per process)
    if (process.env.KOI_CLI_MODE === '1' && !Agent._indexingStarted) {
      Agent._indexingStarted = true;
      cliLogger.log('background', `Background indexing triggered by agent "${this.name}" on event "${eventName}"`);
      this._startBackgroundIndexing();
    }

    if (!_fromDelegation) {
      cliLogger.progress(`🤖 \x1b[1m\x1b[38;2;173;218;228m${this.name}\x1b[0m \x1b[38;2;185;185;185m${eventName}...\x1b[0m`);
    }

    const handler = this.handlers[eventName];
    if (!handler) {
      cliLogger.clear();
      cliLogger.error(`🤖 \x1b[1m\x1b[38;2;173;218;228m${this.name}\x1b[0m No handler for event: ${eventName}`);
      throw new Error(`Agent ${this.name} has no handler for event: ${eventName}`);
    }

    try {
      // Check if handler is playbook-only (has __playbookOnly__ flag)
      if (handler.__playbookOnly__) {
        const playbookText = handler.__playbookFn__
          ? await handler.__playbookFn__(args, this.state, this)
          : handler.__playbook__;
        const result = await this.executePlaybookHandler(eventName, playbookText, args, _fromDelegation, handler.__playbookFn__ || null, _parentAnswerFn);
        cliLogger.clear();
        return result;
      }

      // Execute handler with agent context
      const result = await handler.call(this, args);
      cliLogger.clear();
      return result;
    } catch (error) {
      cliLogger.clear();
      // Don't log NO_AGENT_HANDLER errors - they'll be handled in runtime.js
      if (!error.message || !error.message.startsWith('NO_AGENT_HANDLER:')) {
        cliLogger.error(`[${this.name}] Error in ${eventName}: ${error.message}`);

        // Apply resilience if configured
        if (this.resilience?.retry_max_attempts) {
          console.log(`[Agent:${this.name}] Applying resilience policy...`);
          // TODO: Implement retry logic
        }
      }

      throw error;
    }
  }

  async executePlaybookHandler(eventName, playbook, args, _fromDelegation = false, playbookFn = null, _parentAnswerFn = null) {
    // Initialize LLM provider if not already done
    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }

    // Prepare context with args and state
    const context = {
      args,
      state: this.state
    };

    // Get available skill functions for tool calling
    const tools = this.getSkillFunctions();

    // Extract playbook content if it's an object (transpiler stores it as {type, content})
    const playbookContent = typeof playbook === 'object' && playbook.content
      ? playbook.content
      : playbook;

    // Evaluate template string with context (interpolate ${...} expressions)
    // Create a function that evaluates the template in the context of args and state
    // Wraps args/state in Proxy so undefined properties resolve to "" instead of "undefined"
    const evaluateTemplate = (template, context) => {
      try {
        // Safe string substitution: replace {{args.path}}, {{state.path}} patterns
        // (canonical syntax) and legacy ${args.path}, ${state.path} for backward compat.
        // This avoids new Function / eval entirely, so code examples in playbooks
        // (e.g. JS template literals like `User ${route.params.userId}`) are never executed.
        const resolve = (ns, path) => {
          const root = ns === 'args' ? (context.args || {}) : (context.state || {});
          if (!path) return typeof root === 'object' ? JSON.stringify(root) : String(root);
          const parts = path.split('.');
          let val = root;
          for (const part of parts) {
            if (val == null) return '';
            val = val[part];
          }
          return val == null ? '' : (typeof val === 'object' ? JSON.stringify(val) : String(val));
        };
        // {{args.X}} / {{state.X}} — canonical syntax
        let result = template.replace(/\{\{(args|state)(?:\.([^}]*))?\}\}/g, (_, ns, path) => resolve(ns, path || ''));
        // ${args.X} / ${state.X} — legacy syntax (backward compat)
        result = result.replace(/\$\{(args|state)(?:\.([^}]*))?\}/g, (_, ns, path) => resolve(ns, path || ''));
        return result;
      } catch (error) {
        console.warn(`[Agent:${this.name}] Failed to evaluate playbook template: ${error.message}`);
        return template; // Return original if evaluation fails
      }
    };

    const interpolatedPlaybook = evaluateTemplate(playbookContent, context);

    // Use skillSelector for semantic skill selection instead of passing all skills
    // This improves accuracy by only passing relevant tools to the LLM
    let selectedTools = tools;
    if (typeof globalThis.skillSelector !== 'undefined' && interpolatedPlaybook) {
      try {
        selectedTools = await globalThis.skillSelector.selectSkillsForTask(interpolatedPlaybook, 2);
      } catch (error) {
        console.warn(`[Agent:${this.name}] Skill selection failed, using all skills: ${error.message}`);
        selectedTools = tools; // Fallback to all skills
      }
    }

    // Agent memory:
    // - Delegates always start fresh (per-invocation amnesia): no cross-task memory bleed
    //   and parallel delegates of the same type never race on this.contextMemoryState.
    //   ask_parent no longer re-invokes handle() — it resolves inline — so there is
    //   no "re-entry with saved state" case anymore.
    // - Non-delegates use this.contextMemoryState (persistent across user turns) unless amnesia.
    const memoryState = _fromDelegation
      ? null
      : (this.amnesia ? null : this.contextMemoryState);
    if (process.env.KOI_DEBUG_LLM) {
      const entryCount = memoryState?.entries?.length || 0;
      console.error(`[Agent:${this.name}] 🧠 Memory check: amnesia=${this.amnesia}, entries=${entryCount}, latent=LanceDB`);
    }

    // If a compose-based playbookFn is provided, create a resolver that re-evaluates
    // it on each user turn (so compose blocks pick up runtime state changes).
    // Compose resolvers may produce images (via frame_server_state); these are stored
    // on agent._composePendingImages by _normalizeComposeResult and picked up here.
    const playbookResolver = playbookFn
      ? async () => {
          try {
            const rawText = await playbookFn(args, this.state, this);
            // Pick up any images produced by compose resolvers (stored via _normalizeComposeResult)
            playbookResolver._pendingImages = this._composePendingImages || null;
            this._composePendingImages = null;
            const content = typeof rawText === 'object' && rawText.content ? rawText.content : rawText;
            return evaluateTemplate(content, { args, state: this.state });
          } catch {
            playbookResolver._pendingImages = null;
            return interpolatedPlaybook; // fallback to initial on error
          }
        }
      : null;

    // All agents use reactive loop mode (step by step, one action per LLM call)
    return await this._executePlaybookReactive(eventName, interpolatedPlaybook, args, context, memoryState, _fromDelegation, false, playbookResolver, _parentAnswerFn);
  }

  /**
   * Reactive agentic loop: LLM decides ONE action per iteration,
   * receives feedback, and adapts its strategy.
   * Uses ContextMemory for brain-inspired tiered memory management.
   */
  async _executePlaybookReactive(eventName, interpolatedPlaybook, args, context, memoryState = null, isDelegate = false, _isRecovery = false, playbookResolver = null, _parentAnswerFn = null) {
    // Initialize session tracker if session ID is set and tracker not yet created
    if (process.env.KOI_SESSION_ID && !sessionTracker) {
      initSessionTracker(
        process.env.KOI_SESSION_ID,
        process.env.KOI_PROJECT_ROOT || process.cwd()
      );
    }

    // Track the root (non-delegate) agent for slash commands like /memory
    if (!isDelegate) {
      Agent._rootAgent = this;
    }

    const session = new PlaybookSession({
      playbook: interpolatedPlaybook,
      agentName: this.name
    });
    session.actionContext.args = args;
    session.actionContext.state = this.state;

    // If this loop was triggered by feedback (not a real session resume),
    // mark it so llm-provider.js doesn't inject "SESSION RESUMED".
    if (this._nextSessionIsContinuation) {
      session._isContinuation = true;
      this._nextSessionIsContinuation = false;
    }

    // Expose session on the agent so actions (e.g. action_history) can read it
    this._activeSession = session;

    // Create ContextMemory and restore previous state.
    // Delegates use longer TTLs: they do focused multi-step tasks (read files →
    // implement) and must not forget file contents mid-task. The default TTL of 6
    // causes re-reading loops where the agent reads schema.ts 10+ times because
    // it compressed the content after 6 LLM calls.
    const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
    const sessionId = process.env.KOI_SESSION_ID;
    const latentDbPath = (projectRoot && sessionId)
      ? path.join(projectRoot, '.koi', 'sessions', sessionId, 'latent-lancedb')
      : null;
    const contextMemory = new ContextMemory({
      agentName: this.name,
      llmProvider: this.llmProvider,
      shortTermTTL: isDelegate ? 20 : 6,
      mediumTermTTL: isDelegate ? 60 : 20,
      latentDbPath,
    });
    this._activeContextMemory = contextMemory;
    // Also store per-slot so parallel delegates don't race on this._activeContextMemory
    const _ctxMemSlotKey = getCurrentSlotId() ?? '_main';
    _contextMemoryBySlot.set(_ctxMemSlotKey, contextMemory);

    if (memoryState) {
      contextMemory.restore(memoryState);
    }

    // If resuming a session, try to restore from session tracker.
    // Skip for delegates — they should always start fresh with only the task data.
    if (sessionTracker && !memoryState && !isDelegate) {
      try {
        const history = sessionTracker.getHistory();
        if (history.length > 0) {
          context.sessionHistory = history.map(h => h.summary);
        }
      } catch { /* non-fatal */ }

      // Restore context memory from previous session
      try {
        const savedState = sessionTracker.loadConversation(this.name);
        if (savedState && (savedState.version >= 1 || (Array.isArray(savedState) && savedState.length > 0))) {
          contextMemory.restore(savedState);
          const entryCount = contextMemory.entries.length;
          cliLogger.log('session', `Restored context memory for ${this.name} (${entryCount} entries, latent in LanceDB)`);
        }
      } catch { /* non-fatal */ }

      // Restore input history from previous session
      try {
        const { loadHistory } = await import('./cli-input.js');
        const savedHistory = sessionTracker.loadInputHistory();
        if (savedHistory.length > 0) {
          loadHistory(savedHistory);
          cliLogger.log('session', `Restored ${savedHistory.length} input history entries`);
        }
      } catch { /* non-fatal */ }
    }

    // Connect MCPs eagerly so their tools appear in the system prompt
    const mcpErrors = {};
    if (this.usesMCPNames.length > 0) {
      const mcpRegistry = globalThis.mcpRegistry;
      if (mcpRegistry) {
        for (const mcpName of this.usesMCPNames) {
          const client = mcpRegistry.get(mcpName);
          if (client && !client.initialized) {
            try {
              await client.connect();
            } catch (err) {
              const cause = client.lastError || err.message;
              mcpErrors[mcpName] = cause;
              console.error(`[Agent:${this.name}] ❌ MCP "${mcpName}" failed to connect: ${cause}`);
            }
          }
        }
      }
    }

    // If any MCPs failed, inject the errors so the LLM knows
    if (Object.keys(mcpErrors).length > 0) {
      session.mcpErrors = mcpErrors;
    }

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[Agent:${this.name}] 🔄 Starting reactive loop${isDelegate ? ' (delegate)' : ''}`);
    }
    cliLogger.log('agent', `${this.name}: Starting reactive loop${isDelegate ? ' [delegate]' : ''}`);

    let isFirstCall = true;
    let thinkingHint = 'Thinking';
    let exitedOnAbort = false;

    // Fast-greeting: skip the first LLM call for interactive CLI agents.
    // When the playbook has __FAST_GREETING__, we directly show a hardcoded greeting
    // + prompt_user on iteration 0 without calling the LLM at all.
    // This eliminates the 2-5s startup delay and ensures prompt_user runs in the
    // sequential path (so slash commands like /cost are properly intercepted).
    const FAST_GREETINGS = [
      "What can I build for you?",
      "Ready. What's the task?",
      "What do you need?",
      "Go ahead.",
      "What are we working on?",
    ];
    const _fastGreetMsg = FAST_GREETINGS[Math.floor(Math.random() * FAST_GREETINGS.length)];
    const isFastGreeting = !isDelegate
      && !contextMemory.hasHistory()
      && !session.mcpErrors
      && interpolatedPlaybook.includes('__FAST_GREETING__');

    // Track the active agent so CLI hooks can access its LLM provider
    Agent._lastActiveAgent = this;

    // Mark agent as busy for the entire reactive loop.
    // Delegates must NOT touch onBusy — the root agent owns the global busy state.
    // Calling onBusy(true) from a delegate would replace System's AbortController;
    // calling onBusy(false) would wipe all parallel sibling slots from the UI.
    if (!isDelegate) Agent._cliHooks?.onBusy?.(true);

    // ── RESUMED SESSION: check for pending tasks before the first LLM call ──
    // When the session resumes (context history exists, not a delegate) and there
    // are unfinished tasks persisted on disk, ask the user whether to continue or
    // start fresh — BEFORE calling the LLM, so the prompt appears immediately.
    if (!isDelegate && contextMemory.hasHistory()) {
      try {
        const { taskManager } = await import('./task-manager.js');
        const hasPendingOnDisk = taskManager.checkRestoredFromDisk();
        if (hasPendingOnDisk) {
          const tasks = taskManager.list();
          const unfinished = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
          if (unfinished.length > 0) {
            const { cliSelect } = await import('./cli-select.js');
            Agent._cliHooks?.onBusy?.(false);

            // Format: only show unfinished tasks (completed ones are not shown here).
            const UNFINISHED_LIMIT = 5;

            const fmtTask = t =>
              `  ${t.status === 'in_progress' ? '●' : '☐'}  ${t.subject}`;

            const unfinishedLines = unfinished.slice(0, UNFINISHED_LIMIT).map(fmtTask);
            const unfinishedExtra = unfinished.length - UNFINISHED_LIMIT;
            if (unfinishedExtra > 0) unfinishedLines.push(`    … +${unfinishedExtra} more`);

            cliLogger.print(unfinishedLines.join('\n'));
            const choice = await cliSelect(
              'Do you want to continue the plan?',
              [
                { title: 'Continue', value: 'continue', description: 'Resume the plan where it left off' },
                { title: 'Start fresh', value: 'fresh', description: 'Discard the plan and start over' },
              ]
            );
            Agent._cliHooks?.onBusy?.(true);
            if (choice === 'continue') {
              // User confirmed: populate the anchored panel now
              taskManager.showPanel();
              cliLogger.print('Resuming tasks...');
              session._resumingTasks = true;
            } else {
              // "Start fresh" or Escape — discard ALL tasks (pending, in_progress, and completed)
              for (const t of tasks) {
                try { taskManager.update(t.id, { status: 'deleted' }); } catch { /* non-fatal */ }
              }
              cliLogger.print('Plan cleared.');
            }
          }
        }
      } catch { /* non-fatal */ }
    }

    // Inject shared session knowledge discovered by other agents.
    // This runs once per delegate/agent start so parallel agents that started
    // before certain facts were stored can use recall_facts mid-run instead.
    {
      const { sessionKnowledge } = await import('./session-knowledge.js');

      // On first run in this process: restore knowledge persisted from previous session.
      // Set a flag on the singleton so we only restore once even with multiple agents.
      if (sessionTracker && !sessionKnowledge._restored) {
        sessionKnowledge._restored = true;
        try {
          const savedFacts = sessionTracker.loadKnowledge();
          if (savedFacts.length > 0) {
            sessionKnowledge.restore(savedFacts);
            cliLogger.log('knowledge', `Restored ${savedFacts.length} fact(s) from previous session`);
          }
        } catch { /* non-fatal */ }

        // Auto-save knowledge to disk whenever a new fact is learned.
        sessionKnowledge.on('learn', () => {
          try { sessionTracker.saveKnowledge(sessionKnowledge.serialize()); } catch { /* non-fatal */ }
        });
      }

      const knowledgeBlock = sessionKnowledge.format();
      if (knowledgeBlock) {
        contextMemory.add('user', knowledgeBlock, 'Shared session knowledge', null);
        cliLogger.log('knowledge', `${this.name}: injected ${sessionKnowledge.size} shared fact(s)`);
      }
    }

    while (!session.isTerminated) {
      // If stuck on too many consecutive errors, pivot before giving up.
      // Inject a "try completely different approach" message and reset counters.
      // After 3 pivots, break out and let recovery handle it.
      if (session.consecutiveErrors >= session.maxConsecutiveErrors) {
        const canPivot = session.pivot();
        if (!canPivot) break;
        cliLogger.log('agent', `${this.name}: pivot #${session._pivotCount} after ${session.maxConsecutiveErrors} consecutive errors`);
        // Remind the agent of its original task on pivot so it doesn't lose context
        // after a long series of errors. Especially important for delegate agents.
        const _pivotArgs = args && typeof args === 'object' ? args : {};
        const _taskReminder = (_pivotArgs.description || _pivotArgs.subject || _pivotArgs.instruction || _pivotArgs.userRequest)
          ? `\n\nYour original task (DO NOT forget it): ${_pivotArgs.subject || ''}${_pivotArgs.description ? ' — ' + _pivotArgs.description : ''}${_pivotArgs.instruction ? '\nInstruction: ' + _pivotArgs.instruction : ''}`.trim()
          : '';
        contextMemory.add(
          'user',
          `CRITICAL — PIVOT REQUIRED (attempt ${session._pivotCount}/3): You have been stuck in a failing loop. You MUST completely abandon your current approach and try something entirely different. Do NOT repeat any strategy that already failed. If you are truly blocked and cannot find another approach, use ${isDelegate ? 'ask_parent' : 'prompt_user'} to ask for guidance.${_taskReminder}`,
          'Pivot: forced strategy change.',
          null
        );
      }

      // Check if user cancelled via Ctrl+C.
      // Check both the signal (while controller exists) and wasAborted flag
      // (persists after uiBridge nulls the controller on abort).
      if (Agent._cliHooks?.getAbortSignal?.()?.aborted || Agent._cliHooks?.wasAborted?.()) {
        exitedOnAbort = true;
        break;
      }

      // 1. GET ACTION(S) from LLM — or fast-start on iteration 0
      let response;

      if (isFastGreeting && session.iteration === 0) {
        // Skip LLM call — show greeting then prompt directly (instant startup)
        cliLogger.log('agent', `${this.name}: Fast-greeting (skipping LLM on iteration 0)`);
        response = [
          { actionType: 'direct', intent: 'print', message: _fastGreetMsg },
          { actionType: 'direct', intent: 'prompt_user' }
        ];
        isFirstCall = false;
      } else {

      cliLogger.log('agent', `${this.name}: Calling LLM (iteration ${session.iteration + 1}, hint: ${thinkingHint})`);

      // Show ↑ tokens BEFORE the LLM call + context breakdown in separate slot
      // Only update slots when values > 0 so the last known data persists
      {
        const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
        const est = (text) => text ? Math.ceil(text.length / 4) : 0;
        const msgs = contextMemory.toMessages();
        const inputTk = msgs.reduce((sum, m) => sum + est(m.content || ''), 0);
        if (inputTk > 0) {
          cliLogger.setInfo('tokens', `↑${fmt(inputTk)}`);
        }

        let sysTk = est(contextMemory.systemPrompt), longTk = 0, midTk = 0, shortTk = 0;
        for (const e of contextMemory.entries) {
          if (e.tier === 'long-term') longTk += est(e.permanent);
          else if (e.tier === 'medium-term') midTk += est(e.shortTerm);
          else if (e.tier === 'short-term') shortTk += est(e.immediate);
        }
        const totalCtx = sysTk + longTk + midTk + shortTk;
        if (totalCtx > 0) {
          const latentTk = (contextMemory._latentCount || 0) * 300;
          const latentLabel = `${fmt(latentTk)} latent`;
          cliLogger.setInfo('context', `\u{1F9E0} ${fmt(sysTk)} sys / ${fmt(longTk)} long / ${fmt(midTk)} mid / ${fmt(shortTk)} short / ${latentLabel}`);
        }
      }

      try {
        response = await this.llmProvider.executePlaybookReactive({
          playbook: interpolatedPlaybook,
          playbookResolver,
          context,
          agentName: this.name,
          session,
          agent: this,
          contextMemory,
          isFirstCall,
          thinkingHint,
          isDelegate,
          abortSignal: Agent._cliHooks?.getAbortSignal?.()
        });
        isFirstCall = false;
        this._llmErrorShown = false; // Reset warning flag on successful call
        cliLogger.log('agent', `${this.name}: LLM responded`);
        // Persist conversation after every LLM response so that /exit, Ctrl+C,
        // or any crash can't lose the last exchange. At this point contextMemory
        // already contains both the user message (added in llm-provider.js) and
        // the assistant response, so the saved state is always complete.
        if (!isDelegate && !this.amnesia && sessionTracker) {
          sessionTracker.saveConversation(this.name, contextMemory.serialize());
        }
      } catch (error) {
        cliLogger.clear();

        // AbortError = user pressed Ctrl+C → break out of loop immediately.
        // Use wasAborted() hook (UIBridge flag set on user Ctrl+C) as the primary
        // signal — avoids false positives from network errors like ECONNABORTED.
        // Fall back to error.name check for non-CLI mode (no hooks).
        const isAbort = Agent._cliHooks?.wasAborted?.()
          || error.name === 'AbortError'
          || Agent._cliHooks?.getAbortSignal?.()?.aborted;
        if (isAbort) {
          exitedOnAbort = true;
          cliLogger.log('agent', `${this.name}: Cancelled by user`);
          break;
        }

        // No providers available = fatal, don't retry (would loop forever)
        if (error.message?.startsWith('NO_PROVIDERS:')) {
          const msg = error.message.replace('NO_PROVIDERS: ', '');
          cliLogger.print(`\x1b[31m${msg}\x1b[0m`);
          cliLogger.log('agent', `${this.name}: No LLM providers — stopping`);
          break;
        }

        const modelId = this.llmProvider?.model ?? '?';
        const providerId = this.llmProvider?.provider ?? '?';
        cliLogger.log('agent', `${this.name}: LLM FAILED (${modelId}): ${error.message}\n${error.stack}`);
        cliLogger.log('llm', `[${this.name}] LLM error (${providerId}/${modelId}): ${error.message}`);
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Agent:${this.name}] ❌ LLM call failed (${modelId}): ${error.message}`);
        }
        session.recordAction({ intent: '_llm_error', actionType: 'direct' }, null, error);
        // Exponential backoff on consecutive LLM failures to avoid tight retry loops.
        // 1st fail: 1s, 2nd: 2s, 3rd: 4s, cap at 15s.
        const _backoffMs = Math.min(1000 * Math.pow(2, session.consecutiveErrors - 1), 15000);
        cliLogger.log('agent', `${this.name}: Backoff ${_backoffMs}ms before retry`);
        await new Promise(r => setTimeout(r, _backoffMs));
        continue;
      }

      } // end else (normal LLM path)

      // Normalize to array for uniform processing
      const actionBatch = Array.isArray(response) ? response : [response];

      // Normalize actions: collect stray fields into "data" when missing
      for (const act of actionBatch) {
        this._normalizeActionData(act);
        // Also normalize delegate actions inside parallel blocks
        if (act.parallel && Array.isArray(act.parallel)) {
          for (const pa of act.parallel) this._normalizeActionData(pa);
        }
      }

      // ── SAFETY: split observe+tap(element) batches ──────────────────────
      // If the batch contains mobile_observe or mobile_elements followed by
      // mobile_tap with element=, the LLM is guessing element names before
      // seeing the results. Truncate the batch at the observe/elements action
      // so the LLM must re-evaluate with actual element data next iteration.
      if (actionBatch.length > 1) {
        const _OBSERVE = new Set(['mobile_observe', 'mobile_elements']);
        let _hasObserve = false;
        let _truncateAt = -1;
        for (let i = 0; i < actionBatch.length; i++) {
          const intent = actionBatch[i]?.intent || '';
          if (_OBSERVE.has(intent)) {
            _hasObserve = true;
          } else if (_hasObserve && intent === 'mobile_tap' && actionBatch[i].element) {
            // Found a tap-by-element AFTER an observe — truncate here
            _truncateAt = i;
            break;
          }
        }
        if (_truncateAt > 0) {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] ✂️  Batch split: observe+tap(element) detected — keeping ${_truncateAt} of ${actionBatch.length} actions`);
          }
          actionBatch.length = _truncateAt;
        }
      }

      if (process.env.KOI_DEBUG_LLM && actionBatch.length > 1) {
        console.error(`[Agent:${this.name}] 📦 Batched ${actionBatch.length} actions`);
      }

      // Process each action in the batch sequentially.
      // Items with { parallel: [...] } are executed concurrently via Promise.all.
      let terminated = false;
      for (const action of actionBatch) {
        if (!session.canContinue()) break;

        // ── PARALLEL GROUP ──────────────────────────────────────────────────
        if (action.parallel && Array.isArray(action.parallel)) {
          const group = action.parallel;
          cliLogger.log('action', `${this.name}: Executing ${group.length} actions in parallel`);
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] ⚡ Parallel group (${group.length}): ${group.map(a => a.intent || a.type).join(', ')}`);
          }

          // Pre-flight: collect all required permissions BEFORE launching parallel.
          // Without this, each concurrent action would ask the user separately for
          // the same directory — pre-granting here ensures they only ask once.
          await this._preflightParallelPermissions(group);

          // Per-delegate timeout: if a delegate hangs (no LLM response, stuck permission, etc.)
          // it should not block the entire parallel group forever.
          const PARALLEL_DELEGATE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

          const parallelResults = await Promise.all(group.map(async (pa) => {
            const paIntent = pa.intent || pa.type || 'unknown';
            cliLogger.log('action', `${this.name}: Starting parallel delegate: ${paIntent}`);
            try {
              const delegatePromise = this._executeAction(pa, pa, session.actionContext);
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Parallel delegate "${paIntent}" timed out after ${PARALLEL_DELEGATE_TIMEOUT_MS / 1000}s`)), PARALLEL_DELEGATE_TIMEOUT_MS)
              );
              const { result } = await Promise.race([delegatePromise, timeoutPromise]);
              if (pa.id) {
                session.actionContext[pa.id] = { output: result };
              }
              // Do NOT call session.recordAction here — the _parallel_done synthetic
              // record below already contains all results. Recording individually would
              // cause the LLM to see each result twice (once per action + once in the summary).
              const _pResult = JSON.stringify(result);
              cliLogger.log('result', `${this.name} [parallel/${paIntent}]: ${_pResult.length > 300 ? _pResult.substring(0, 300) + '…' : _pResult}`);
              return { action: pa, result };
            } catch (error) {
              const failedIntent = pa?.intent || pa?.type || 'unknown';
              cliLogger.log('error', `${this.name}: Parallel action "${failedIntent}" failed: ${error.message}`);
              return { action: pa, result: null, error };
            }
          }));

          // All parallel delegates completed — log summary for diagnostics
          {
            const _ok = parallelResults.filter(r => !r.error).length;
            const _fail = parallelResults.filter(r => r.error).length;
            cliLogger.log('action', `${this.name}: All ${group.length} parallel delegates done (${_ok} ok, ${_fail} failed)`);
          }

          // Build a combined result so the LLM sees ALL parallel results at once.
          // Use classifyFeedback per result so image blocks are extracted correctly
          // (avoids dumping raw base64 into the text summary).
          const parallelImageBlocks = [];
          const parallelSummary = parallelResults.map(r => {
            const classified = classifyFeedback(r.action, r.result, r.error);
            if (classified.imageBlocks?.length > 0) {
              parallelImageBlocks.push(...classified.imageBlocks);
            }
            // Prefix with [task:X] when available so the System LLM can identify
            // which task each result belongs to (especially important for failures).
            const taskId = r.action.data?.taskId;
            const prefix = taskId ? `[task:${taskId}] ` : '';
            return prefix + classified.immediate;
          }).join('\n');

          // Inject a synthetic "parallel group done" record so executePlaybookReactive
          // picks it up as the last feedback entry
          session.recordAction(
            { intent: '_parallel_done', actionType: 'direct', _parallelGroup: true },
            {
              _parallelResults: parallelSummary,
              _parallelSubActions: parallelResults.map(r => r.action),
              _parallelImageBlocks: parallelImageBlocks.length > 0 ? parallelImageBlocks : null
            }
          );

          if (process.env.KOI_DEBUG_LLM) {
            const summary = parallelResults.map(r => `${r.action.intent || r.action.type}: ${r.error ? '❌' : '✅'}`).join(', ');
            console.error(`[Agent:${this.name}] ⚡ Parallel done: ${summary}`);
          }

          // Update thinkingHint from the last successful parallel action
          // (without this, the hint stays stale from before the parallel batch)
          const lastOk = [...parallelResults].reverse().find(r => !r.error);
          if (lastOk) {
            thinkingHint = this._describeNextStep(lastOk.action, lastOk.result) || 'Thinking';
          }
          cliLogger.planning(`🤖 \x1b[1m\x1b[38;2;173;218;228m${this.name}\x1b[0m \x1b[38;2;185;185;185m${thinkingHint}\x1b[0m`);
          continue;
        }
        // ────────────────────────────────────────────────────────────────────

        const intent = action.intent || action.type || 'unknown';
        cliLogger.log('action', `${this.name}: Executing ${intent}${action.id ? ' [' + action.id + ']' : ''}`);

        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Agent:${this.name}] 🎯 Reactive step ${session.iteration + 1}: ${intent}`);
        }

        // Print token/memory summary before return (reset accumulator)
        if (intent === 'return') {
          this._printTokenSummary(session, contextMemory, { reset: true });
        }

        // CHECK TERMINAL ACTION
        if ((action.intent || action.type) === 'return') {
          let returnData = action.data || {};

          // ── SHELL FAILURE GUARD ──────────────────────────────────────────
          // If the agent claims success but recent shell actions failed,
          // bounce the agent back to reconsider instead of silently propagating
          // a false-positive result to the caller.
          if (returnData.success === true && isDelegate) {
            const recentShellFailures = session.actionHistory
              .filter(e => {
                const eIntent = e.action?.intent || e.action?.type;
                return eIntent === 'shell' && e.result && (e.result.success === false || (e.result.exitCode != null && e.result.exitCode !== 0));
              });
            if (recentShellFailures.length > 0) {
              const lastFail = recentShellFailures[recentShellFailures.length - 1];
              const exitCode = lastFail.result?.exitCode || '?';
              // Only bounce once to avoid infinite loops
              if (!session._shellFailureGuardTriggered) {
                session._shellFailureGuardTriggered = true;
                cliLogger.log('agent', `${this.name}: Shell failure guard — agent returned success:true but shell exited with code ${exitCode}. Bouncing back.`);
                session.recordAction(action, returnData);
                contextMemory.add(
                  'user',
                  `⚠️ RETURN REJECTED: You returned { "success": true } but a shell command in this session failed with exit code ${exitCode}. A failed shell command (especially a test run) means the task did NOT succeed. Review the shell output above and return { "success": false } with the actual error, or fix the issue and re-run the command before claiming success.`,
                  `Return rejected: shell failed (exit code ${exitCode}) but agent claimed success`,
                  null
                );
                thinkingHint = 'Reconsidering — shell command failed';
                continue;
              }
            }
          }

          // Apply state updates if present
          if (returnData && typeof returnData === 'object' && (returnData.state_updates || returnData.stateUpdates)) {
            const updates = returnData.state_updates || returnData.stateUpdates;
            Object.keys(updates).forEach(key => {
              this.state[key] = updates[key];
            });
            const { state_updates, stateUpdates, ...cleanData } = returnData;
            returnData = cleanData;
          }

          // In CLI mode, "return" means "task done, wait for next user input".
          // For delegate agents this does NOT apply — they must return the result
          // to the agent that called them, not wait for user input.
          if (process.env.KOI_CLI_MODE === '1' && !isDelegate) {
            // ── AUTO-RECOVERY: resume plan if tasks are still pending ──────────
            // This catches cases where a parallel delegate silently failed,
            // the LLM called return() prematurely, or any other early exit.
            // Cap at 5 recovery attempts per session to avoid infinite loops.
            let _recoveredToTasks = false;
            if (!session._recoveryAttempts) session._recoveryAttempts = 0;
            if (session._recoveryAttempts < 5) {
              try {
                const { taskManager: _tm } = await import('./task-manager.js');
                const _unfinished = _tm.list().filter(t => t.status === 'pending' || t.status === 'in_progress');
                if (_unfinished.length > 0) {
                  session._recoveryAttempts++;
                  _recoveredToTasks = true;
                  const _pendingList = _unfinished.map(t => `  [${t.id}] ${t.subject} (${t.status})`).join('\n');
                  cliLogger.print(`\x1b[33m⚡ Plan incomplete — ${_unfinished.length} task(s) still pending. Resuming automatically...\x1b[0m`);
                  cliLogger.log('agent', `${this.name}: Auto-recovery: ${_unfinished.length} task(s) still pending (attempt ${session._recoveryAttempts}/5)`);
                  Agent._cliHooks?.onBusy?.(true);
                  session.recordAction(action, returnData);
                  contextMemory.add(
                    'user',
                    `AUTO-RECOVERY: You called return() but the following tasks are still unfinished:\n${_pendingList}\n\nDo NOT call prompt_user. Call task_list immediately and continue executing the remaining tasks. Never leave tasks pending.`,
                    `Unfinished tasks remain (${_unfinished.length}): ${_unfinished.map(t => t.subject).join(', ')}`,
                    null
                  );
                  thinkingHint = 'Resuming plan';
                  continue;
                } else {
                  // All tasks done — reset recovery counter for next invocation
                  session._recoveryAttempts = 0;
                }
              } catch { /* non-fatal — fall through to normal completion */ }
            }
            // ─────────────────────────────────────────────────────────────────

            if (!_recoveredToTasks) {
              cliLogger.log('agent', `${this.name}: Task completed, waiting for next input`);
              // Commit pending changes
              if (sessionTracker && sessionTracker.hasPendingChanges()) {
                await this._commitSessionChanges(interpolatedPlaybook);
                const lastSummary = sessionTracker.lastCommitSummary;
                if (lastSummary) cliLogger.print(`\x1b[2m${lastSummary}\x1b[0m`);
              }
              // Save context memory
              if (!this.amnesia && sessionTracker) {
                sessionTracker.saveConversation(this.name, contextMemory.serialize());
              }
              // Release busy state
              Agent._cliHooks?.onBusy?.(false);
              this._printTokenSummary(session, contextMemory, { reset: true });
              // Tick memory (age entries)
              await contextMemory.tick();
              // Record the return so the LLM knows the task is done,
              // and add feedback telling it to wait for user input
              session.recordAction(action, returnData);
              contextMemory.add(
                'user',
                'Task completed. Wait for the user to type something — use prompt_user now.',
                'Task completed.',
                null
              );
              thinkingHint = 'Thinking';
              // Show spinner immediately so there's no gap before next callReactive
              cliLogger.planning(`🤖 \x1b[1m\x1b[38;2;173;218;228m${this.name}\x1b[0m \x1b[38;2;185;185;185m${thinkingHint}\x1b[0m`);
              // Continue the loop — LLM will be called again and should prompt_user
              continue;
            }
          }

          if (isDelegate) {
            cliLogger.log('agent', `${this.name}: Delegate task completed, returning to caller`);
          }
          session.terminate(returnData);
          terminated = true;
          break;
        }

        // ── AUTO-RECOVERY: intercept prompt_user when tasks are still pending ──
        // The LLM sometimes forgets to execute all tasks before prompting the user.
        // Cap at 3 attempts to avoid blocking legitimate prompt_user calls
        // (e.g. when the LLM needs to ask the user about a failed task).
        // Note: only intercept for PENDING tasks — in_progress tasks may be
        // legitimately waiting for the user (delegate returned { success: false }).
        if (intent === 'prompt_user' && process.env.KOI_CLI_MODE === '1' && !isDelegate) {
          if (!session._promptUserRecoveryAttempts) session._promptUserRecoveryAttempts = 0;
          if (session._promptUserRecoveryAttempts < 3) {
            try {
              const { taskManager: _tm2 } = await import('./task-manager.js');
              const _pendingOnly = _tm2.list().filter(t => t.status === 'pending');
              if (_pendingOnly.length > 0) {
                session._promptUserRecoveryAttempts++;
                const _pendingList = _pendingOnly.map(t => `  [${t.id}] ${t.subject}`).join('\n');
                cliLogger.log('agent', `${this.name}: Auto-recovery: prompt_user intercepted — ${_pendingOnly.length} task(s) still pending (attempt ${session._promptUserRecoveryAttempts}/3)`);
                session.recordAction(action, { answer: '__tasks_pending__' });
                contextMemory.add(
                  'user',
                  `AUTO-RECOVERY: You called prompt_user but the following tasks are still PENDING (not yet delegated or executed):\n${_pendingList}\n\nDo NOT call prompt_user. Call task_list immediately and continue delegating and executing all remaining tasks. Mark completed tasks as "completed". Never leave tasks pending.`,
                  `Unfinished pending tasks (${_pendingOnly.length})`,
                  null
                );
                thinkingHint = 'Resuming plan';
                continue;
              } else {
                session._promptUserRecoveryAttempts = 0;
              }
            } catch { /* non-fatal */ }
          }
        }
        // ────────────────────────────────────────────────────────────────────

        // Delegates must NEVER prompt the user directly — convert to ask_parent.
        // Only the root (System) agent should talk to the user.
        if ((intent === 'prompt_user' || intent === 'prompt_form') && isDelegate && _parentAnswerFn) {
          const question = action.question || action.prompt || action.title || 'Need clarification';
          cliLogger.log('agent', `${this.name}: Redirecting ${intent} → ask_parent: "${question.substring(0, 80)}"`);
          const _answer = await _parentAnswerFn(question);
          const _answerMsg = `✅ ask_parent answered: "${_answer}"\n\nContinue your task using this answer.`;
          session.recordAction(action, { answer: _answer });
          contextMemory.add('user', _answerMsg, `Parent answered: "${_answer}"`, null);
          thinkingHint = 'Reviewing answer';
          continue;
        }

        // Release busy state before giving control to the user.
        // keepSlots=true: named delegate slots stay visible while we wait for input.
        if (intent === 'prompt_user') {
          Agent._cliHooks?.onBusy?.(false, { keepSlots: true });
        }

        // Commit pending changes before returning control to the user (prompt_user)
        if (intent === 'prompt_user' && sessionTracker && sessionTracker.hasPendingChanges()) {
          await this._commitSessionChanges(interpolatedPlaybook);
          const lastSummary = sessionTracker.lastCommitSummary;
          if (lastSummary) cliLogger.print(`\x1b[2m${lastSummary}\x1b[0m`);
        }

        // EXECUTE ACTION
        try {
          cliLogger.planning(buildActionDisplay(this.name, action));

          let { result } = await this._executeAction(action, action, session.actionContext);

          cliLogger.clear();

          // Intercept slash commands from prompt_user (e.g. /history, /diff, /undo)
          while (intent === 'prompt_user' && typeof result?.answer === 'string' && result.answer.startsWith('/')) {
            const slashResult = await this._handleSlashCommand(result.answer, action, session);
            if (!slashResult.handled) break;
            cliLogger.planning(buildActionDisplay(this.name, action));
            const { result: newResult } = await this._executeAction(action, action, session.actionContext);
            cliLogger.clear();
            result = newResult;
          }

          // Re-enter busy state after prompt_user resolves
          if (intent === 'prompt_user') {
            Agent._cliHooks?.onBusy?.(true);
            // Immediately show thinking spinner so the user sees the agent is working
            cliLogger.planning(`🤖 \x1b[1m\x1b[38;2;173;218;228m${this.name}\x1b[0m \x1b[38;2;185;185;185m${thinkingHint || 'Processing your answer'}\x1b[0m`);
            // Track user message for compose template {{userMessage}} variable
            this._lastUserMessage = result?.answer || null;
            // Share with session tracker so delegate commits can also use the user's request
            if (sessionTracker && this._lastUserMessage) {
              sessionTracker._lastUserRequest = this._lastUserMessage;
            }

            // Clear stale tasks from previous requests.
            // A new user message = fresh task context. Old pending tasks should
            // not block or confuse the processing of the new request.
            try {
              const { taskManager: _tmCleanup } = await import('./task-manager.js');
              const _staleTasks = _tmCleanup.list().filter(t => t.status === 'pending' || t.status === 'in_progress');
              if (_staleTasks.length > 0) {
                cliLogger.log('agent', `${this.name}: Clearing ${_staleTasks.length} stale task(s) on new user input`);
                _tmCleanup.reset();
              }
              // Reset recovery counter for the new request
              session._recoveryAttempts = 0;
            } catch { /* non-fatal */ }
          }

          // Save input history, dialogue, and context memory after prompt_user
          // (persists memory in case user closes with Ctrl+C before loop ends)
          if (intent === 'prompt_user' && sessionTracker && result) {
            // appendDialogue FIRST — it creates the session dir (via mkdirSync),
            // which saveInputHistory and saveConversation depend on.
            sessionTracker.appendDialogue({ ts: Date.now(), type: 'user_input', text: result.answer || '' });
            try {
              const { getHistory: getInputHistory } = await import('./cli-input.js');
              sessionTracker.saveInputHistory(getInputHistory());
            } catch { /* non-fatal */ }
            if (!this.amnesia) {
              sessionTracker.saveConversation(this.name, contextMemory.serialize());
            }
          }

          // Log action results to dialogue
          if (intent !== 'prompt_user' && sessionTracker) {
            const resultPreview = result ? JSON.stringify(result).substring(0, 200) : 'null';
            sessionTracker.appendDialogue({ ts: Date.now(), type: 'action', intent, result: resultPreview });
          }

          session.recordAction(action, result);

          // ── Auto-register external project dependencies ──────────────────
          // When any action touches a file outside the project root (read_file,
          // edit_file, write_file, search, shell with file paths, etc.), detect
          // the external project root and register it as a dependency.
          // This ensures .koi/dependencies.json stays in sync with what the
          // agent actually uses, regardless of whether config files declare it.
          try {
            const _actionPath = action.path || action.file || action.filePath;
            if (_actionPath) {
              const _projectDir = process.env.KOI_PROJECT_ROOT || process.cwd();
              const _resolvedActionPath = path.resolve(_actionPath);
              if (!_resolvedActionPath.startsWith(_projectDir + path.sep) && _resolvedActionPath !== _projectDir) {
                const { addManualDependency: _addDep } = await import('./local-dependency-detector.js');
                const _markers = ['package.json', 'pom.xml', 'build.gradle', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'settings.gradle'];
                let _extRoot = fs.existsSync(_resolvedActionPath) && fs.statSync(_resolvedActionPath).isDirectory()
                  ? _resolvedActionPath
                  : path.dirname(_resolvedActionPath);
                for (let _i = 0; _i < 5; _i++) {
                  if (_markers.some(_m => fs.existsSync(path.join(_extRoot, _m)))) break;
                  const _parent = path.dirname(_extRoot);
                  if (_parent === _extRoot) break;
                  _extRoot = _parent;
                }
                if (_markers.some(_m => fs.existsSync(path.join(_extRoot, _m)))) {
                  _addDep(_projectDir, _extRoot, path.basename(_extRoot), 'auto-detected: agent accessed files in this project');
                }
              }
            }
          } catch { /* non-critical — never break the agent loop for this */ }

          // Inject streaming progress snapshots collected during generator actions (e.g. shell).
          // The LLM will see these checkpoints in its next context window, allowing it to reason
          // about intermediate output that occurred during long-running commands.
          if (this._pendingProgressUpdates?.length) {
            const updates = this._pendingProgressUpdates;
            this._pendingProgressUpdates = null;
            for (const { action: progressAction, update } of updates) {
              const label = progressAction.description || progressAction.intent || 'command';
              const outputSoFar = update.output_so_far || '';
              const truncated = outputSoFar.length > 2000
                ? outputSoFar.slice(-2000) + '\n...[earlier output not shown]'
                : outputSoFar;
              const msg = truncated
                ? `[${label} — streaming output at ${update.elapsed}s]\n${truncated}`
                : `[${label} — streaming output at ${update.elapsed}s] (no output yet)`;
              contextMemory.add('user', msg, `${label} streaming (${update.elapsed}s)`, null);
            }
          }

          // ask_parent: pause, get answer from parent, inject into memory, continue loop.
          // Works like prompt_user — no re-entry, no new session, memory stays intact.
          if (result && result.__askParent__ === true && isDelegate) {
            // ── ARGS GUARD: intercept delegates asking for their own task spec ──
            // Some LLMs ignore the injected 📋 YOUR TASK SPEC and ask the parent
            // "what is my task?" / "provide args". Short-circuit this by re-injecting
            // the args directly instead of wasting a parent LLM call.
            const _question = (result.question || '').toLowerCase();
            const _isAskingForArgs = /\b(provide|what|give|send|share|full)\b.*\b(args|task|description|instruction|fields|spec)\b/i.test(_question)
              || /\b(what should i do|what is my task|no task|missing task)\b/i.test(_question);
            if (_isAskingForArgs && session.iteration <= 3) {
              const _taskArgs = session.actionContext?.args;
              if (_taskArgs && Object.keys(_taskArgs).length > 0) {
                const _argsStr = Object.entries(_taskArgs)
                  .filter(([, v]) => v != null && v !== '')
                  .map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
                  .join('\n');
                cliLogger.log('agent', `${this.name}: Intercepted ask_parent for task spec — re-injecting args directly`);
                contextMemory.add(
                  'user',
                  `⚠️ Your task spec was ALREADY provided. Here it is again:\n\n📋 YOUR TASK SPEC:\n${_argsStr}\n\nDo NOT ask again. Read the fields above and start implementing immediately. If args.description is present, that is your task. If args.instruction is present, that is your task. Use whatever fields are available.`,
                  `Task spec re-injected`,
                  null
                );
                thinkingHint = 'Reading task spec';
                continue;
              }
            }

            if (_parentAnswerFn) {
              const _answer = await _parentAnswerFn(result.question);
              const _answerMsg = `✅ ask_parent answered: "${_answer}"\n\nContinue your task using this answer. If you have no more questions, implement the task now.`;
              contextMemory.add('user', _answerMsg, `Parent answered: "${_answer}"`, null);
              thinkingHint = 'Reviewing answer';
              continue;
            }
            // No parent answer fn available — terminate (fallback for non-delegate context).
            session.terminate(result);
            terminated = true;
            break;
          }

          // Update token info in status bar after every action
          this._printTokenSummary(session, contextMemory);

          const full = result ? JSON.stringify(result) : 'null';
          cliLogger.log('result', `${this.name}: ${full.length > 300 ? full.substring(0, 300) + '…' : full}`);

          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] ✅ Result: ${full.length > 500 ? full.substring(0, 500) + '…' : full}`);
          }

          // Update thinking hint based on what just happened
          if (result && result.success === false) {
            thinkingHint = 'Retrying';
            // Stop batch on failure for stateful actions — screen/page state
            // diverged, so subsequent actions would operate on wrong state.
            const intent = action?.intent || '';
            if (intent.startsWith('mobile_') || intent.startsWith('browser_')) {
              if (process.env.KOI_DEBUG_LLM) {
                console.error(`[Agent:${this.name}] ⛔ Action "${intent}" failed — stopping batch.`);
              }
              break;
            }
          } else {
            thinkingHint = this._describeNextStep(action, result) || 'Thinking';
          }
          // Immediately update spinner so there's no gap between action end and next LLM call
          cliLogger.planning(`🤖 \x1b[1m\x1b[38;2;173;218;228m${this.name}\x1b[0m \x1b[38;2;185;185;185m${thinkingHint}\x1b[0m`);
        } catch (error) {
          cliLogger.clear();
          const failedIntent = action?.intent || action?.type || 'unknown';
          cliLogger.log('error', `${this.name}: Action "${failedIntent}" failed [iter=${session.iteration}, delegate=${isDelegate}]: ${error.message}\n${error.stack}`);
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] ❌ Action "${failedIntent}" failed: ${error.message}\n${error.stack}`);
          }
          session.recordAction(action, null, error);
          thinkingHint = 'Rethinking';
          break;
        }
      }

      // ── MOBILE LOOP GUARD ──────────────────────────────────────────────
      // Detect when a mobile navigator repeats the same action pattern across
      // iterations. Instead of killing the navigator, escalate warnings so it
      // changes strategy. Only force-terminate after many repeats (truly stuck).
      // Tracks batches with at least one mutating action (tap, type, swipe, key).
      // Pure observation batches (observe, elements) are excluded.
      if (!terminated && actionBatch.length > 0) {
        const _MUTATING = new Set(['mobile_tap', 'mobile_type', 'mobile_swipe', 'mobile_key']);
        const _mutatingActions = actionBatch.filter(a => _MUTATING.has(a.intent || ''));
        if (_mutatingActions.length > 0) {
          const _batchSig = _mutatingActions.map(a =>
            `${a.intent||''}:${a.element||a.cell||a.text||a.key||a.direction||''}`
          ).join('|');
          if (!session._mobileLoopSigs) session._mobileLoopSigs = [];
          const _prevSigs = session._mobileLoopSigs;
          const _dupCount = _prevSigs.filter(s => s === _batchSig).length;
          _prevSigs.push(_batchSig);
          if (_prevSigs.length > 20) _prevSigs.shift();

          if (_dupCount >= 4) {
            // 5th repeat → strong warning + reset counter for fresh attempts
            contextMemory.add(
              'user',
              '🚨 STUCK: You have repeated the EXACT same actions 5 times with no progress. ' +
              'Your current approach is NOT working. STOP and RETHINK completely: ' +
              '(a) call mobile_observe(high) to see the actual screen state, ' +
              '(b) try completely different elements, cells, or navigation path, ' +
              '(c) go back/home and find an alternative route to the goal. ' +
              'You MUST change strategy NOW.',
              'Loop warning (strong)',
              null
            );
            session._mobileLoopSigs.length = 0;
          } else if (_dupCount >= 3) {
            // 4th repeat → medium warning
            contextMemory.add(
              'user',
              '⚠️ You have repeated the same actions 4 times. ' +
              'This approach is likely not working. Try a different strategy: ' +
              'different elements, different cells, or a different navigation path.',
              'Loop warning (medium)',
              null
            );
          } else if (_dupCount >= 2) {
            // 3rd repeat → gentle nudge
            contextMemory.add(
              'user',
              '💡 You repeated the same actions as a previous iteration. ' +
              'Consider whether this approach is making progress or if you should try something different.',
              'Loop warning',
              null
            );
          }
        }
      }

      if (terminated) break;
    }

    // Clean up per-slot context memory reference
    _contextMemoryBySlot.delete(_ctxMemSlotKey);

    // Clear busy state when loop exits (root agent only — delegates skip this).
    if (!isDelegate) Agent._cliHooks?.onBusy?.(false);

    // Commit ALL pending file changes as ONE changeset when control returns to user
    if (sessionTracker && sessionTracker.hasPendingChanges()) {
      await this._commitSessionChanges(interpolatedPlaybook);
    }

    // Save final input history on loop exit
    if (sessionTracker) {
      try {
        const { getHistory: getInputHistory } = await import('./cli-input.js');
        sessionTracker.saveInputHistory(getInputHistory());
      } catch { /* non-fatal */ }
    }

    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[Agent:${this.name}] 🔄 Reactive loop finished after ${session.iteration} iterations`);
    }

    // Save context memory state — only for non-delegate (main) agents.
    // Delegates have per-invocation amnesia: no cross-task memory bleed,
    // and parallel delegates of the same type don't race on this.contextMemoryState.
    if (!isDelegate && !this.amnesia) {
      this.contextMemoryState = contextMemory.serialize();
      if (sessionTracker) {
        sessionTracker.saveConversation(this.name, this.contextMemoryState);
      }
    }

    // In CLI mode, if the loop exited (consecutive errors, abort, etc.),
    // add a recovery message and re-enter. The loop should normally never exit
    // in CLI mode (return actions are handled as continue above).
    // Delegates must NOT enter this recovery path — they should propagate errors
    // back to the calling agent so it can handle them.
    if (process.env.KOI_CLI_MODE === '1' && !isDelegate) {
      const lastError = session.actionHistory.at(-1)?.error;
      const exitedOnErrors = session.consecutiveErrors >= session.maxConsecutiveErrors
        || (session._pivotCount || 0) > 3;

      cliLogger.log('agent', `${this.name}: CLI mode — loop exited (errors: ${session.consecutiveErrors}, abort: ${exitedOnAbort}, recovery: ${_isRecovery})`);

      // Ctrl+C abort: stop silently. No LLM call, no recovery greeting.
      // agentBusy is already false (cleared above). Directly show the input
      // prompt and wait for the user's next message, then restart fresh.
      // NOTE: Do NOT add a "Cancelled" user message — it confuses the LLM
      // into ignoring the user's next real message.
      if (exitedOnAbort) {
        // Check if the abort was triggered by the FeedbackArbitrator (user sent
        // a correction while the agent was busy). If so, inject the feedback
        // directly into context without prompting the user again.
        const hasFeedback = Agent._cliHooks?.hasPendingFeedback?.();
        if (hasFeedback) {
          const feedbackInput = Agent._cliHooks.consumePendingFeedback();
          const feedbackText = typeof feedbackInput === 'string' ? feedbackInput : (feedbackInput?.text ?? '');

          if (feedbackText) {
            cliLogger.log('agent', `${this.name}: Injecting user feedback: ${feedbackText.substring(0, 100)}`);
            cliLogger.print(`\x1b[2m↳ Feedback noted — adjusting...\x1b[0m`);

            // Inject as a user correction so the LLM knows this is a mid-task correction
            contextMemory.add(
              'user',
              `User interrupted with feedback: ${feedbackText}`,
              feedbackText,
              null
            );
            this.contextMemoryState = contextMemory.serialize();
            // Track feedback as user message for compose templates
            this._lastUserMessage = feedbackText;
            Agent._cliHooks?.onBusy?.(true);
            const freshPlaybook = playbookResolver ? await playbookResolver() : interpolatedPlaybook;
            // Mark next session as a continuation (not a session resume) so it
            // doesn't inject "SESSION RESUMED" and reset the conversation.
            this._nextSessionIsContinuation = true;
            return await this._executePlaybookReactive(eventName, freshPlaybook, args, context, this.contextMemoryState, false, false, playbookResolver);
          }
        }

        let promptResult;
        try {
          // Re-mark busy so Ctrl+C during this wait triggers cancel (not exit warning)
          Agent._cliHooks?.onBusy?.(true);

          // Check for queued new requests from the FeedbackArbitrator before prompting
          if (Agent._cliHooks?.hasPendingRequests?.()) {
            const queuedInput = Agent._cliHooks.consumePendingRequest();
            const queuedText = typeof queuedInput === 'string' ? queuedInput : (queuedInput?.text ?? '');
            if (queuedText) {
              promptResult = { answer: queuedText };
            }
          }

          if (!promptResult) {
            const { result } = await this._executeAction(
              { intent: 'prompt_user' },
              { intent: 'prompt_user' },
              session.actionContext
            );
            promptResult = result;
          }
          Agent._cliHooks?.onBusy?.(false);
        } catch (_) { Agent._cliHooks?.onBusy?.(false); return {}; }

        if (!promptResult?.answer) return {};

        // Track user message so compose templates can use {{userMessage}} / @if (userMessage)
        this._lastUserMessage = promptResult.answer;

        // Add user's new message to context and restart the reactive loop.
        // Re-evaluate the playbook via playbookResolver so compose blocks pick up
        // any runtime state changes (e.g. tasks created since the session started).
        contextMemory.add('user', promptResult.answer, promptResult.answer, null);
        this.contextMemoryState = contextMemory.serialize();
        // Persist immediately so the user entry survives even if process.exit() is
        // called (e.g. two quick Ctrl+C presses) before the next save at line 973.
        // This ensures hasHistory() returns true on resume, triggering the pending
        // tasks check before any LLM calls are made.
        if (!this.amnesia && sessionTracker) {
          sessionTracker.saveConversation(this.name, this.contextMemoryState);
        }
        const freshPlaybook = playbookResolver ? await playbookResolver() : interpolatedPlaybook;
        this._nextSessionIsContinuation = true;
        return await this._executePlaybookReactive(eventName, freshPlaybook, args, context, this.contextMemoryState, false, false, playbookResolver);
      }

      // If already in recovery, do NOT recurse again — print error and stop.
      if (_isRecovery) {
        if (lastError) {
          cliLogger.print(`\x1b[31m⚠ ${lastError.message}\x1b[0m`);
        }
        return {};
      }

      // Loop exited on consecutive errors: show the error before recovering
      if (exitedOnErrors && lastError) {
        cliLogger.print(`\x1b[31m⚠ ${lastError.message}\x1b[0m`);
      }

      if (!this.amnesia) {
        this.contextMemoryState = contextMemory.serialize();
      }
      contextMemory.add(
        'user',
        'The previous task encountered an error. Wait for the user — use prompt_user now.',
        'Error recovery.',
        null
      );
      this.contextMemoryState = contextMemory.serialize();
      this._nextSessionIsContinuation = true;
      return await this._executePlaybookReactive(eventName, interpolatedPlaybook, args, context, this.contextMemoryState, false, true, playbookResolver);
    }

    // Return final result
    if (session.finalResult) return session.finalResult;

    // If a delegate agent exits without a return action (exhausted pivots / too many errors),
    // it MUST inform the user and return a failure result so the calling agent knows what happened.
    if (isDelegate) {
      const exitedOnErrors = session.consecutiveErrors >= session.maxConsecutiveErrors
        || (session._pivotCount || 0) > 3;

      if (exitedOnErrors && !exitedOnAbort) {
        // Find the most informative error in recent history
        const recentError = [...session.actionHistory].reverse().find(e => e.error || (e.result?.success === false));
        const errorMsg = recentError?.error?.message
          || recentError?.result?.error
          || `Reached retry limit after ${session.iteration} attempts without completing the task`;

        cliLogger.print(`\x1b[31m⚠ [${this.name}] Could not complete task: ${errorMsg}\x1b[0m`);
        cliLogger.print(`\x1b[33mThe agent was unable to recover. Please review the problem and provide guidance or try a different approach.\x1b[0m`);

        return { success: false, error: `[${this.name}] ${errorMsg}`, agentName: this.name };
      }
    }

    // Fallback: return last action result if loop exhausted
    const lastEntry = session.actionHistory[session.actionHistory.length - 1];
    return lastEntry?.result || {};
  }

  /**
   * Normalize a delegate action: everything that isn't actionType, intent or id
   * gets collected into "data".
   * E.g. { actionType, intent, name, age } → { actionType, intent, data: { name, age } }
   * @private
   */
  _normalizeActionData(action) {
    if (!action || action.data || action.actionType !== 'delegate') return;

    const reserved = new Set(['actionType', 'intent']);
    const data = {};
    for (const [k, v] of Object.entries(action)) {
      if (!reserved.has(k)) {
        data[k] = v;
        if (k !== 'id') delete action[k];
      }
    }

    if (Object.keys(data).length > 0) {
      action.data = data;
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[Agent:${this.name}] 🔧 Normalized stray fields into data: ${Object.keys(data).join(', ')}`);
      }
    }
  }

  /**
   * Generate a descriptive thinking hint based on the last completed action.
   * @private
   */
  _describeNextStep(lastAction, result) {
    const intent = lastAction.intent || lastAction.type || '';

    // Ask the action itself — each action defines its own thinkingHint
    const actionDef = actionRegistry.get(intent);
    if (actionDef?.thinkingHint) {
      const hint = actionDef.thinkingHint;
      return typeof hint === 'function' ? hint(lastAction) : hint;
    }

    if (lastAction.actionType === 'delegate') {
      const agentKey = intent.split('::')[0];
      const agentName = agentKey.charAt(0).toUpperCase() + agentKey.slice(1);
      return `Processing response from ${agentName}`;
    }
    return 'Thinking';
  }


  /**
   * Commit pending session file changes with an LLM-generated summary.
   * Called after all actions from a prompt have been executed.
   * @private
   */

  // ─── Slash Commands ─────────────────────────────────────────────────

  /**
   * Handle a slash command typed by the user in prompt_user.
   * Commands are auto-loaded from the path in KOI_CLI_COMMAND_REGISTRY_PATH env var
   * (set by the CLI tool, e.g. koi-cli, before spawning the runtime process).
   * @returns {{ handled: boolean, action?, result? }}
   */
  async _handleSlashCommand(input, originalAction, session) {
    const trimmed = input.trim();
    const [cmd, ...args] = trimmed.substring(1).split(/\s+/);

    try {
      const registryPath = process.env.KOI_CLI_COMMAND_REGISTRY_PATH;
      if (!registryPath) {
        cliLogger.log('warn', `Slash command /${cmd}: KOI_CLI_COMMAND_REGISTRY_PATH not set`);
        return { handled: false };
      }
      const { getCommand, getCommands } = await import(registryPath);
      const command = await getCommand(cmd);

      if (!command) {
        // No command or unknown command — show interactive menu of available commands
        cliLogger.clearProgress();
        const { cliSelect } = await import('./cli-select.js');
        const cmds = await getCommands();
        const options = [...cmds.values()]
          .map(c => ({ title: `/${c.name}`, value: c.name, description: c.description }));

        const promptText = originalAction.question || originalAction.prompt || '';
        const selected = await cliSelect('Commands:', options, 0, { filterable: true, inlinePrefix: promptText, initialFilter: '/' });
        if (!selected) {
          return { handled: true };
        }

        // Execute the selected command
        return this._handleSlashCommand(`/${selected}`, originalAction, session);
      }

      cliLogger.progress('\x1b[2mplease wait...\x1b[0m');
      // Slash commands always run against the root (System) agent, not the delegate
      const targetAgent = Agent._rootAgent || this;
      const result = await command.execute(targetAgent, args);
      cliLogger.clearProgress();
      // Add executed slash command to input history (navigable with up/down arrows)
      const { addToHistory } = await import('./cli-input.js');
      addToHistory(`/${cmd}${args.length > 0 ? ' ' + args.join(' ') : ''}`);
      return { handled: true, result };
    } catch (err) {
      cliLogger.clearProgress();
      cliLogger.log('error', `Slash command /${cmd} failed: ${err.message}\n${err.stack}`);
      // Show the error to the user so they know what happened
      cliLogger.print(`\x1b[31m/${cmd} failed:\x1b[0m ${err.message}`);
      // Return handled: true so the input doesn't get sent to the LLM
      return { handled: true };
    }
  }

  /**
   * Print a single dim summary line with token usage and memory tier breakdown.
   * Called once before prompt_user or return — then resets the accumulator.
   */
  _printTokenSummary(session, contextMemory, { reset = false } = {}) {
    const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    const est = (text) => text ? Math.ceil(text.length / 4) : 0;

    // Update tokens slot with ↑↓ (input + output tokens from last response)
    // Only update if there's actual data so last known value persists.
    // Only show ↑ when input > 0 — some streaming APIs don't report input tokens.
    const last = session.lastUsage || { input: 0, output: 0 };
    if (last.output > 0 || last.input > 0) {
      const _parts = [];
      if (last.input > 0) _parts.push(`↑${fmt(last.input)}`);
      if (last.output > 0) _parts.push(`↓${fmt(last.output)}`);
      cliLogger.setInfo('tokens', _parts.join(' '));
    }

    // Update context slot with memory breakdown
    let sysTk = est(contextMemory.systemPrompt), longTk = 0, midTk = 0, shortTk = 0;
    for (const e of contextMemory.entries) {
      if (e.tier === 'long-term') longTk += est(e.permanent);
      else if (e.tier === 'medium-term') midTk += est(e.shortTerm);
      else if (e.tier === 'short-term') shortTk += est(e.immediate);
    }
    const totalCtx = sysTk + longTk + midTk + shortTk;
    if (totalCtx > 0) {
      const latentTk = (contextMemory._latentCount || 0) * 300;
      const latentLabel = `${fmt(latentTk)} latent`;
      cliLogger.setInfo('context', `\u{1F9E0} ${fmt(sysTk)} sys / ${fmt(longTk)} long / ${fmt(midTk)} mid / ${fmt(shortTk)} short / ${latentLabel}`);
    }

    if (reset) {
      const accum = session.tokenAccum;
      if (accum) session.tokenAccum = { input: 0, output: 0, thinking: 0, calls: 0 };
    }
  }

  async _commitSessionChanges(promptContext) {
    if (!sessionTracker || !sessionTracker.hasPendingChanges()) return;

    try {
      const files = [...sessionTracker.pendingFiles];

      // Use the user's original request as commit message for better history readability.
      // Falls back to LLM-generated diff summary, then to plain file list.
      let summary = '';
      const userRequest = this._lastUserMessage || sessionTracker?._lastUserRequest;
      if (userRequest) {
        // Truncate long user messages to a reasonable commit message length
        const msg = userRequest.trim().split('\n')[0]; // first line only
        summary = msg.length > 120 ? msg.substring(0, 117) + '...' : msg;
      }

      if (!summary) {
        summary = `Changed: ${files.join(', ')}`;

        // Get the actual diff of staged changes to feed the summary LLM
        let diffText = '';
        try {
          diffText = sessionTracker._git('diff --cached');
        } catch { /* fallback to no diff */ }

        // Generate natural language summary via LLM (fast, non-critical)
        if (this.llmProvider && diffText) {
          try {
            summary = await this.llmProvider.callUtility(
              'Summarize the code diff in one short sentence (max 80 chars). Be specific about WHAT changed, not the files. No markdown, no quotes. Examples: "Added execute command as alias for run", "Removed unused import and helper function"',
              diffText.substring(0, 2000),
              100
            );
          } catch {
            // Fallback to file list if LLM fails
          }
        }
      }

      const commitResult = sessionTracker.commitChanges(summary);

      // Fire-and-forget: embed the commit summary for semantic search
      if (commitResult.success && commitResult.hash) {
        this._embedCommitSummary(commitResult.hash, summary).catch(() => {});
      }
      sessionTracker.lastCommitSummary = summary;
      return summary;
    } catch {
      // Non-fatal
    }
  }

  /**
   * Start background semantic indexing (fire-and-forget).
   * Uses BackgroundTaskManager + SemanticIndex + LanceDB.
   * @private
   */
  async _startBackgroundIndexing() {
    try {
      if (!this.llmProvider) {
        this.llmProvider = new LLMProvider(this.llm);
      }
      const projectDir = process.env.KOI_PROJECT_ROOT || process.cwd();
      const { backgroundTaskManager } = await import('./background-task-manager.js');
      backgroundTaskManager.startSemanticIndexing(projectDir, this.llmProvider);
    } catch (err) {
      cliLogger.log('background', `Indexing start failed: ${err.message}`);
    }
  }

  /**
   * Embed a commit summary and save it for later semantic search.
   * @private
   */
  async _embedCommitSummary(hash, summary) {
    if (!this.llmProvider || !sessionTracker) return;
    try {
      const embedding = await this.llmProvider.getEmbedding(summary);
      if (embedding) {
        sessionTracker.saveCommitEmbedding(hash, summary, embedding);
        cliLogger.log('session', `Embedded commit [${hash}]: ${summary}`);
      }
    } catch (err) {
      cliLogger.log('session', `Embed commit failed: ${err.message}`);
    }
  }

  /**
   * Pre-flight permission check for a parallel action group.
   * Asks the user ONCE per unique directory before launching concurrent actions,
   * so they don't each pop their own permission dialog.
   * Grants permission even for "yes" (not just "always") so all parallel actions
   * in the group inherit the approval without re-asking.
   * @private
   */
  async _preflightParallelPermissions(group) {
    const { getFilePermissions } = await import('./file-permissions.js');
    const { cliSelect } = await import('./cli-select.js');
    const _pathMod = await import('path');
    const path = _pathMod.default ?? _pathMod;
    const _fsMod = await import('fs');
    const fs = _fsMod.default ?? _fsMod;

    // Determine what path and permission level each action needs
    const getPermissionTarget = (action) => {
      const intent = action.intent || action.type || '';
      // Path may be on action directly or nested in data
      const rawPath = action.path ?? action.data?.path;
      switch (intent) {
        case 'grep':
        case 'search':
        case 'read_file':
        case 'semantic_code_search':
          return { targetPath: rawPath || process.cwd(), level: 'read' };
        case 'edit_file':
        case 'write_file':
          return rawPath ? { targetPath: rawPath, level: 'write' } : null;
        default:
          return null; // no file permission needed
      }
    };

    const permissions = getFilePermissions(this);

    // Build deduplicated set of (resolvedDir, level) pairs that lack permission
    const toCheck = new Map(); // key: `${dir}:${level}` → { dir, level }

    for (const action of group) {
      const target = getPermissionTarget(action);
      if (!target) continue;

      const resolved = path.resolve(target.targetPath);
      let dir;
      try {
        const stat = fs.statSync(resolved);
        dir = stat.isFile() ? path.dirname(resolved) : resolved;
      } catch {
        // Path doesn't exist yet (write target) — use dirname
        dir = fs.existsSync(path.dirname(resolved)) ? path.dirname(resolved) : process.cwd();
      }

      if (!permissions.isAllowed(dir, target.level)) {
        const key = `${dir}:${target.level}`;
        if (!toCheck.has(key)) {
          toCheck.set(key, { dir, level: target.level });
        }
      }
    }

    if (toCheck.size === 0) return; // everything already permitted

    // Auto-approve read access within the project root — the agent is expected to
    // read project files without asking. This eliminates the most common preflight delay.
    const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
    for (const [key, { dir, level }] of toCheck.entries()) {
      if (level === 'read' && (dir === projectRoot || dir.startsWith(projectRoot + path.sep))) {
        permissions.allow(dir, 'read');
        cliLogger.log('permissions', `Auto-granted read for project dir: ${dir}`);
        toCheck.delete(key);
      }
    }
    if (toCheck.size === 0) return;

    // Ask once per unique (dir, level) — sequentially to avoid concurrent prompts
    for (const { dir, level } of toCheck.values()) {
      cliLogger.clearProgress();
      const op = level === 'write' ? 'write to' : 'read from';
      cliLogger.print(`🔍 ${this.name} wants to ${op}: \x1b[33m${dir}\x1b[0m`);

      const value = await cliSelect(`Allow ${level} access to this directory?`, [
        { title: 'Yes',          value: 'yes',    description: 'Allow for this batch' },
        { title: 'Always allow', value: 'always', description: 'Always allow in this directory' },
        { title: 'No',           value: 'no',     description: 'Deny access' }
      ]);

      if (value === 'yes' || value === 'always') {
        // Grant so all parallel actions (and the "always" case, future calls) skip the dialog
        permissions.allow(dir, level);
        cliLogger.log('permissions', `Pre-granted ${level} for parallel group: ${dir}`);
      }
      // If 'no': don't grant — individual actions will surface a denial result
    }
  }

  /**
   * Execute a single action (common code for both streaming and batch execution)
   * @private
   * @returns {Object} { result, shouldExitLoop }
   */
  async _executeAction(action, resolvedAction, context) {
    const actionRegistry = (await import('./action-registry.js')).actionRegistry;
    let result;
    let shouldExitLoop = false;

    // Check if this is a delegation action
    if (action.actionType === 'delegate') {
      // Delegation: route to appropriate team member
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[Agent:${this.name}] 🔀 Delegating action: ${action.intent}`);
      }

      // Auto-mark the associated task as in_progress before delegating,
      // and completed/failed after — so the UI always reflects the real state
      // regardless of whether the LLM remembered to call task_update.
      let _taskId = action.data?.taskId ?? resolvedAction.data?.taskId;
      // Fallback: if taskId was omitted, find the task by matching subject.
      // This covers cases where the LLM forgot to include taskId in the delegate data.
      if (!_taskId) {
        const _subject = action.data?.subject ?? resolvedAction.data?.subject;
        if (_subject) {
          try {
            const { taskManager: _tmFb } = await import('./task-manager.js');
            const _norm = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
            const _ns = _norm(_subject);
            const _match = _tmFb.list().find(t =>
              (t.status === 'pending' || t.status === 'in_progress') &&
              (_norm(t.subject) === _ns || _ns.includes(_norm(t.subject)) || _norm(t.subject).includes(_ns))
            );
            if (_match) _taskId = _match.id;
          } catch { /* non-fatal */ }
        }
      }
      // Derive owner from the delegate intent ("ApiDeveloper::handle" → "ApiDeveloper").
      // This is set on the task before the sub-agent starts so my_task() always finds it.
      const _intentAgentKey = (action.intent || '').split('::')[0];
      const _intentAgentName = _intentAgentKey
        ? _intentAgentKey.charAt(0).toUpperCase() + _intentAgentKey.slice(1)
        : null;
      if (_taskId) {
        try {
          const { taskManager } = await import('./task-manager.js');
          const _task = taskManager.get(String(_taskId));
          if (_task && _task.status === 'pending') {
            taskManager.update(String(_taskId), {
              status: 'in_progress',
              ...(_intentAgentName && { owner: _intentAgentName }),
            });
          } else if (_task && _intentAgentName && !_task.owner) {
            // Already in_progress but owner was never set — fix it now
            taskManager.update(String(_taskId), { owner: _intentAgentName });
          }
        } catch { /* non-fatal */ }
      }

      try {
        result = await this.resolveAction(resolvedAction, context);
      } catch (err) {
        // Delegate threw — revert task to pending so System can see it and retry/ask user.
        // (Distinguish from a deliberate { success: false } return, which stays in_progress.)
        if (_taskId) {
          try {
            const { taskManager: _tm } = await import('./task-manager.js');
            const _t = _tm.get(String(_taskId));
            if (_t && _t.status === 'in_progress') {
              _tm.update(String(_taskId), { status: 'pending' });
            }
          } catch { /* non-fatal */ }
        }
        throw err;
      }

      if (_taskId) {
        try {
          const { taskManager } = await import('./task-manager.js');
          const _task = taskManager.get(String(_taskId));
          if (_task && _task.status === 'in_progress') {
            const _failed = result && result.success === false;
            if (!_failed) taskManager.update(String(_taskId), { status: 'completed' });
          }
        } catch { /* non-fatal */ }
      }
    } else {
      // Direct action: if params are nested inside "data", lift them to top level
      if (resolvedAction.data && typeof resolvedAction.data === 'object') {
        for (const [k, v] of Object.entries(resolvedAction.data)) {
          if (resolvedAction[k] === undefined) {
            resolvedAction[k] = v;
          }
        }
      }

      // Check if this is a registered action with an executor
      const actionDef = actionRegistry.get(action.intent || action.type);

      if (actionDef && actionDef.execute) {
        // Fast path: execute registered action.
        // Support async generators: actions may yield progress updates (_isProgress: true)
        // followed by a final result. Progress snapshots are collected for later injection
        // into context memory so the LLM can see streaming output after completion.
        const maybeGen = actionDef.execute(resolvedAction, this);
        if (maybeGen && typeof maybeGen[Symbol.asyncIterator] === 'function') {
          // Manual iteration (instead of for-await) so we can pass values back
          // via iter.next(value) — required for the _inputNeeded two-way protocol.
          const iter = maybeGen[Symbol.asyncIterator]();
          let item = await iter.next();
          while (!item.done) {
            const update = item.value;
            if (update._isProgress) {
              if (update._inputNeeded) {
                // Process went silent and may be waiting for input.
                // Ask the running agent (with full context) to decide the answer.
                const answer = await this._resolveProcessInput(update, resolvedAction);
                item = await iter.next(answer);
              } else {
                if (!this._pendingProgressUpdates) this._pendingProgressUpdates = [];
                this._pendingProgressUpdates.push({ action, update });

                // Fire-and-forget LLM classification of shell output.
                // If the process hit a fatal error, kill it via iter.return() which
                // triggers the generator's finally block (process cleanup).
                // We set _shellKilledByClassifier so we can provide a synthetic error result.
                const outputSoFar = update.output_so_far || '';
                const cmd = update.command || resolvedAction.command || '';
                if (outputSoFar.length > 50 && (action.intent || action.type) === 'shell' && !this._shellClassifyInFlight) {
                  this._shellClassifyInFlight = true;
                  this._classifyShellOutput(outputSoFar, cmd).then(verdict => {
                    this._shellClassifyInFlight = false;
                    if (verdict === 'kill') {
                      cliLogger.log('shell', `[${this.name}] LLM classified output as fatal error — killing process`);
                      this._shellKilledByClassifier = outputSoFar;
                      iter.return(); // triggers generator finally → proc.kill()
                    }
                    // 'ask' verdict is handled naturally by the _inputNeeded path
                    // when the process goes silent after asking for input
                  }).catch(() => { this._shellClassifyInFlight = false; });
                }

                item = await iter.next();
              }
            } else {
              result = update;
              item = await iter.next();
            }
          }
          // If the classifier killed the process, provide a synthetic error result
          // so the agent knows the command failed and can see the output.
          if (!result && this._shellKilledByClassifier) {
            const killedOutput = this._shellKilledByClassifier;
            this._shellKilledByClassifier = null;
            const truncOut = killedOutput.length > 3000 ? killedOutput.slice(-3000) : killedOutput;
            result = { success: false, exitCode: 1, stdout: '', stderr: truncOut,
              error: 'Process killed — LLM analysis detected a fatal error in the output. Review stderr and fix the issue.' };
          }
        } else {
          result = await maybeGen;
        }

        // Special handling for return action with conditions
        if ((action.intent === 'return' || action.type === 'return') && action.condition !== undefined) {
          shouldExitLoop = true;
        }
      } else if (action.intent || action.description) {
        // Resolve via router (legacy fallback)
        result = await this.resolveAction(resolvedAction, context);
      } else {
        // Fallback legacy
        result = await this.executeLegacyAction(resolvedAction);
      }
    }

    return { result, shouldExitLoop };
  }

  /**
   * Classify streaming shell output using a fast/cheap LLM call.
   * @returns {'wait'|'kill'|{ask: string}} — wait (keep going), kill (fatal error), or ask (needs user input)
   */
  async _classifyShellOutput(output, command) {
    if (!this.llmProvider) return 'wait';
    const _ANSI_STRIP = /\x1b\[[0-9;]*[mABCDEFGHJKLMPSTfhinsu]/g;
    const clean = output.replace(_ANSI_STRIP, '').trim();
    const lastLines = clean.split('\n').slice(-40).join('\n');
    if (!lastLines) return 'wait';

    try {
      const system = 'Classify shell output. Return ONLY valid JSON, no markdown.';
      const user = `A shell command is running and has produced output. Classify the situation.

Command: ${command}
Last output:
\`\`\`
${lastLines.slice(-1500)}
\`\`\`

Respond with ONE of:
- {"action":"wait"} — process is running normally (compiling, downloading, starting up, showing logs, warnings). Keep waiting.
- {"action":"kill","reason":"brief reason"} — process has hit a fatal error and will NOT recover on its own (missing env vars, missing modules, syntax errors, crash). It should be killed so the agent can fix the problem.
- {"action":"ask","question":"what to ask the user"} — process is interactively asking for input (a question, a prompt, a confirmation). The question field should contain what the process is asking.

IMPORTANT: Only "kill" for truly FATAL and IRRECOVERABLE errors where the process cannot continue or will not recover on its own. If the output shows warnings, deprecation notices, notices, informational logs, progress, or non-fatal errors that could be retried/recovered, return "wait". Only choose "kill" when you are confident the process is doomed (e.g., hard crashes, unrecoverable missing requirements).`;

      const raw = await this.llmProvider.callSummary(system, user);
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());

      if (parsed?.action === 'kill') return 'kill';
      if (parsed?.action === 'ask') return { ask: parsed.question || 'Please provide input' };
      return 'wait';
    } catch (err) {
      cliLogger.log('shell', `_classifyShellOutput failed: ${err.message}`);
      return 'wait';
    }
  }

  /**
   * Called when a shell (or other generator) action yields { _inputNeeded: true },
   * meaning the running process has gone silent and may be waiting for interactive input.
   *
   * Uses the running agent's full context (conversation history + the command being
   * executed) to decide what value to enter — no standalone context-free LLM call.
   *
   *   • If a value can be inferred from context → returns it (written silently to stdin)
   *   • If truly unknown (password, API key, etc.) → asks the user via prompt_user action
   *   • On error → returns null (process receives nothing; will eventually time out)
   *
   * @param {Object} update        - The _inputNeeded yield from the generator
   * @param {Object} resolvedAction - The original action (contains .command, .description)
   * @returns {Promise<string|null>} - Value to write to stdin, or null
   */
  async _resolveProcessInput(update, resolvedAction) {
    if (!this.llmProvider) return null;
    const _ANSI_STRIP = /\x1b\[[0-9;]*[mABCDEFGHJKLMPSTfhinsu]/g;
    try {
      // Build a condensed view of recent conversation context so the agent has
      // enough background to infer sensible answers (DB names, regions, paths, etc.)
      let recentContext = '';
      // Use per-slot context memory to avoid race with parallel delegates
      const _slotKey = getCurrentSlotId() ?? '_main';
      const _ctxMem = _contextMemoryBySlot.get(_slotKey) || this._activeContextMemory;
      if (_ctxMem) {
        const messages = _ctxMem.toMessages();
        recentContext = messages
          .filter(m => m.role !== 'system')
          .slice(-8)
          .map(m => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return `${m.role.toUpperCase()}: ${content.slice(0, 400)}`;
          })
          .join('\n---\n');
      }

      const promptContext = (update.promptContext || '').replace(_ANSI_STRIP, '').trim();
      const command = resolvedAction.command || update.command || '';

      const system = `You are ${this.name}. You launched a shell command that is now waiting for interactive input. Respond ONLY with valid JSON, no markdown.`;
      const user =
        `Recent task context:\n${recentContext || '(no history yet)'}\n\n` +
        `Running command: ${command}\n` +
        `Recent terminal output (last 20 lines):\n\`\`\`\n${promptContext.slice(-600)}\n\`\`\`\n\n` +
        `The process is waiting for user input. Based on your task context, what value should you enter?\n\n` +
        `IMPORTANT — Detect the type of prompt:\n\n` +
        `1. **Arrow-key menu / selector** (lines with ❯, >, ●, ○, or indented options like "~ X rename" / "+ X create"):\n` +
        `   - Analyze ALL the options listed in the menu.\n` +
        `   - Decide which option is the CORRECT one based on the task context (e.g. "create enum" vs "rename enum" — pick the one that matches the intent).\n` +
        `   - Count which position that option is at (0-indexed from the highlighted/first item).\n` +
        `   - Set autoAnswer to "__MENU_SELECT__:N" where N is the 0-based index of the option to select.\n` +
        `   - Example: if the correct option is the 3rd item → autoAnswer: "__MENU_SELECT__:2"\n` +
        `   - Example: if the correct option is already highlighted (first item) → autoAnswer: "__MENU_SELECT__:0"\n\n` +
        `2. **Yes/No confirmation** (e.g. "Are you sure? [Y/n]", "Continue? (y/N)"): Set autoAnswer to "y" or "n" as appropriate.\n\n` +
        `3. **Text input** (DB name, env, region, path, etc.): Set autoAnswer to the inferred value.\n\n` +
        `4. **Password, API key, secret, or truly unknown value**: Set autoAnswer to null.\n\n` +
        `- isSecret: true only for passwords, API keys, tokens, secrets.\n` +
        `Reply ONLY with JSON: {"autoAnswer":"value or null","isSecret":bool,"label":"one-sentence question for the user (only when autoAnswer is null)"}`;

      const responseText = await this.llmProvider.callUtility(system, user, 200);

      // Parse JSON — tolerate markdown fences or surrounding whitespace
      let parsed = null;
      try {
        const cleaned = responseText.replace(/```(?:json)?\n?|\n?```/g, '').trim();
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      } catch { /* ignore */ }

      if (!parsed) return null;

      // Auto-answer: write directly to stdin, no user interaction needed
      if (parsed.autoAnswer != null) {
        let answer = String(parsed.autoAnswer);

        // Menu selection: send N arrow-down keys + Enter
        const menuMatch = answer.match(/^__MENU_SELECT__:(\d+)$/);
        if (menuMatch) {
          const index = parseInt(menuMatch[1], 10);
          // Arrow down = \x1b[B, Enter = \n
          const arrowDown = '\x1b[B';
          answer = arrowDown.repeat(index) + '\n';
          cliLogger.log('shell', `[${this.name}] auto-input → menu select option ${index} (${index} arrows + Enter)`);
          return answer;
        }

        // Convert literal escape sequences from JSON (e.g. "\\n" → actual newline)
        answer = answer.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        cliLogger.log('shell', `[${this.name}] auto-input → "${parsed.autoAnswer}"`);
        return answer;
      }

      // Need user input — use cliInput directly for secret support (asterisks)
      const label = parsed.label || 'Please enter a value';
      if (parsed.isSecret) {
        const { cliInput: _cliInput } = await import('./cli-input.js');
        const answer = await _cliInput(label, { secret: true });
        return answer ?? null;
      }
      // Non-secret: use prompt_user action for full UI integration
      const promptUserDef = actionRegistry.get('prompt_user');
      if (promptUserDef) {
        const res = await promptUserDef.execute(
          { intent: 'prompt_user', question: label },
          this
        );
        return res?.answer ?? null;
      }

      return null;
    } catch (err) {
      cliLogger.log('shell', `[${this.name}] _resolveProcessInput error: ${err.message}`);
      return null;
    }
  }

  async callAction(intent, data = {}) {
    if (intent === 'frame_server_state') {
      return await this._getFrameServerState(data.precision || 'low');
    }
    const actionDef = actionRegistry.get(intent);
    if (!actionDef) return null;
    return await actionDef.execute({ intent, ...data }, this);
  }

  async _executeComposePrompt(composeDef, _composeArgs) {
    // Prefer compile-time generated resolver (embedded by transpiler, no runtime LLM call)
    if (composeDef.resolve) {
      const resolvedFragments = {};
      for (const [key, value] of Object.entries(composeDef.fragments || {})) {
        if (typeof value === 'function') {
          resolvedFragments[key] = value();
        } else if (value && value.__isCompose__) {
          // Recursively resolve nested compose prompts
          resolvedFragments[key] = await this._executeComposePrompt(value, _composeArgs);
        } else {
          resolvedFragments[key] = value || '';
        }
      }
      const callAction = async (intent, data = {}) => {
        return await this.callAction(intent, data);
      };
      // Build context object with built-in template variables
      const context = {
        args: _composeArgs || {},
        state: this.state || {},
        agentName: this.name,
        userMessage: this._lastUserMessage ?? _composeArgs?.goal ?? null
      };
      try {
        const result = await composeDef.resolve(resolvedFragments, callAction, context);
        return this._normalizeComposeResult(result);
      } catch (error) {
        console.error(`[Compose] Resolver error for compiled compose, falling back to LLM: ${error.message}`);
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[Compose] Stack trace:`, error.stack);
        }
        // Fall through to LLM-based compose
      }
    }

    // Fallback: runtime LLM-based compose (used when no compile-time resolver is available)
    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }
    const result = await this.llmProvider.executeCompose(composeDef, this);
    return this._normalizeComposeResult(result);
  }

  /**
   * Normalize compose result: always return a string.
   * If the result is multimodal { text, images }, store images on
   * agent._composePendingImages for the playbookResolver to pick up.
   */
  _normalizeComposeResult(result) {
    if (typeof result === 'object' && result?.text && result?.images) {
      this._composePendingImages = result.images;
      return result.text;
    }
    // Plain string — clear any previous pending images
    this._composePendingImages = null;
    if (typeof result === 'string') return result;
    if (typeof result === 'object' && result !== null) {
      // Safety net: never return raw objects — would become [object Object]
      return result.text || JSON.stringify(result);
    }
    return result || '';
  }

  /**
   * Get the current mobile screen state from the frame server.
   * Used by compose resolvers to inject screenshot + elements into prompts.
   * @returns {{ screenshot: string, mimeType: string, elements: string, elementCount: number }|null}
   */
  async _getFrameServerState(precision = 'low') {
    try {
      const { isRunning: isFrameServerRunning, forceCapture } = await import('./mobile/frame-server.js');
      if (!isFrameServerRunning()) return null;
      // forceCapture triggers a fresh screenshot + element fetch (not stale cache)
      const { frame, elements } = await forceCapture(precision);
      if (!frame?.jpegBuffer) return null;
      const { formatElementsSummary } = await import('./mobile/element-matching.js');
      return {
        screenshot: frame.jpegBuffer.toString('base64'),
        mimeType: 'image/jpeg',
        elements: formatElementsSummary(elements),
        elementCount: elements.length,
      };
    } catch { return null; }
  }

  async executeActions(actions) {
    let finalResult = {};
    const context = { state: this.state };

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const intent = action.intent || action.type || action.description;

      cliLogger.progress(`🤖 \x1b[1m\x1b[38;2;173;218;228m${this.name}\x1b[0m \x1b[38;2;185;185;185mThinking...\x1b[0m`);

      const { result, shouldExitLoop } = await this._executeAction(action, action, context);
      finalResult = result;

      if (shouldExitLoop) {
        i = actions.length;
      }

      cliLogger.clear();

      if (process.env.KOI_DEBUG_LLM) {
        const fullStr = JSON.stringify(finalResult);
        console.error(`[Agent:${this.name}] 🔍 Action ${intent} returned:`, fullStr.length > 150 ? fullStr.substring(0, 150) + '...' : fullStr);
      }
    }

    return finalResult;
  }


  /**
   * Resolve an action using cascading strategy:
   * 1️⃣ Can I handle it myself (do I have a handler)?
   * 2️⃣ Do I have a skill that can do it?
   * 3️⃣ Can I delegate to another agent via router?
   * 4️⃣ Can I execute directly with a simple prompt?
   */
  async resolveAction(action, context = {}) {
    const intent = action.intent || action.type || action.description;
    const callSignature = `${this.name}:${intent}`;

    // Per-async-context stack: parallel branches each have their own isolated stack,
    // so concurrent delegates to the same agent don't produce false loop errors.
    const currentStack = _callStackStorage.getStore() || [];

    if (currentStack.includes(callSignature)) {
      throw new Error(
        `[Agent:${this.name}] Infinite loop detected!\n` +
        `  Call stack: ${currentStack.join(' → ')} → ${callSignature}\n` +
        `  Preventing recursion for intent: "${intent}"`
      );
    }

    // Run the body in a new async context with this call appended to the stack.
    // AsyncLocalStorage.run() automatically restores the parent context on return/throw,
    // so no manual pop() is needed and parallel branches never see each other's entries.
    return _callStackStorage.run([...currentStack, callSignature], async () => {
      // 1️⃣ Do I have a handler for this? (check my own event handlers)
      const matchingHandler = this.findMatchingHandler(intent);
      if (matchingHandler) {
        // Self-delegation (same agent handles it)
        return this.handle(matchingHandler, action.data || action.input || {}, false);
      }

      // 2️⃣ Do I have a matching skill?
      const matchingSkill = this.findMatchingSkill(intent);
      if (matchingSkill) {
        cliLogger.planning(buildActionDisplay(this.name, action));
        const result = await this.callSkill(matchingSkill, action.data || action.input || {});
        cliLogger.clear();
        return result;
      }

      // 3️⃣ Can someone in my teams handle it? (check peers + usesTeams)
      if (this.peers || this.usesTeams.length > 0) {
        // Check delegate permission
        if (!this.hasPermission('delegate')) {
          throw new Error(`Agent "${this.name}" cannot delegate: role "${this.role?.name || 'unknown'}" lacks "can delegate" permission.`);
        }

        // Search within team members - team defines communication boundaries
        const teamMember = await this.findTeamMemberForIntent(intent);

        if (teamMember) {
          // Show delegation with indentation
          const actionTitle = action.title || intent;
          let currentData = action.data || action.input || {};
          let result;

          // Unique slot ID so each parallel delegation shows its own spinner row.
          const _delegateSlot = `${teamMember.agent.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          // getCurrentSlotId() returns undefined when the parent runs outside any
          // withSlot context (e.g. the top-level System agent). The main spinner
          // slot uses null as its key, so map undefined → null so clearSlotById
          // actually clears it and the parent spinner doesn't show alongside the delegate.
          const _parentSlotId = getCurrentSlotId() ?? null;
          registerSlotMeta(_delegateSlot, {
            agentName: teamMember.agent.name,
            subject: currentData?.subject || null,
          });

          // Delegate gets a callback to answer ask_parent questions inline —
          // no re-entry, no new session. Works like prompt_user but the answer
          // comes from this (parent) agent's LLM instead of the terminal.
          const _parentAnswerFn = (question) =>
            this._answerDelegateQuestion(question, currentData, teamMember.agent.name);

          // Hide the parent's spinner — it's waiting for the delegate to finish.
          // The parent will re-show naturally when it resumes after this await.
          clearSlotById(_parentSlotId);
          try {
            result = await withSlot(_delegateSlot, () => teamMember.agent.handle(teamMember.event, currentData, true, _parentAnswerFn));
          } finally {
            clearSlotById(_delegateSlot);
            unregisterSlotMeta(_delegateSlot);
          }
          return result;
        }
      } else if (intent && typeof intent === 'string' && intent.trim() !== '') {
        // No teams defined - fall back to global router (rare case)
        const { agentRouter } = await import('./router.js');
        let matches = await agentRouter.findMatches(intent, 5);

        // Filter out self-delegation
        matches = matches.filter(match => match.agent !== this);

        if (matches.length > 0) {
          const best = matches[0];
          const actionTitle = action.title || intent;
          const _routerSlot = `${best.agent.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const _routerParentSlotId = getCurrentSlotId() ?? null;
          const _routerData = action.data || action.input || {};
          registerSlotMeta(_routerSlot, {
            agentName: best.agent.name,
            subject: _routerData?.subject || null,
          });
          clearSlotById(_routerParentSlotId);
          let routerResult;
          try {
            routerResult = await withSlot(_routerSlot, () => best.agent.handle(best.event, _routerData, true));
          } finally {
            clearSlotById(_routerSlot);
            unregisterSlotMeta(_routerSlot);
          }
          return routerResult;
        }
      }

      // 4️⃣ Can I execute directly with LLM? (simple tasks, only if no one else can do it)
      if (this.canExecuteDirectly(action)) {
        return this.executeDirectly(action, context);
      }

      // ❌ Cannot resolve
      throw new Error(
        `[Agent:${this.name}] Cannot resolve: "${intent}"\n` +
        `  - I don't have a handler for this\n` +
        `  - I don't have a matching skill\n` +
        `  - No team member available via router\n` +
        `  - Too complex for direct execution`
      );
    });
  }

  /**
   * Find a team member that can handle the intent
   * Searches in peers (if member of a team) and usesTeams (teams this agent uses)
   */
  async findTeamMemberForIntent(intent) {
    if (!intent || typeof intent !== 'string' || intent.trim() === '') {
      return null;
    }

    // Collect all teams this agent can access
    const accessibleTeams = [];

    if (this.peers && this.peers.members) {
      accessibleTeams.push(this.peers);
    }

    for (const team of this.usesTeams) {
      if (team && team.members) {
        accessibleTeams.push(team);
      }
    }

    if (accessibleTeams.length === 0) {
      return null;
    }

    // 0. Check for qualified intent: "agentKey::eventName" or legacy "AgentName.eventName"
    const colonIdx = intent.indexOf('::');
    const dotIdx   = intent.indexOf('.');
    if (colonIdx >= 0 || dotIdx >= 0) {
      const sepLen   = colonIdx >= 0 ? 2 : 1;
      const splitIdx = colonIdx >= 0 ? colonIdx : dotIdx;
      const agentPart = intent.substring(0, splitIdx).toLowerCase();
      const eventPart = intent.substring(splitIdx + sepLen);
      for (const team of accessibleTeams) {
        for (const [memberName, member] of Object.entries(team.members)) {
          if (member === this) continue;
          if (memberName.toLowerCase() === agentPart || member.name.toLowerCase() === agentPart) {
            const matchingEvent = member.findMatchingHandler(eventPart);
            if (matchingEvent) {
              if (process.env.KOI_DEBUG_LLM) {
                console.error(`[Agent:${this.name}] ✅ Qualified match: ${memberName}::${matchingEvent} for intent "${intent}"`);
              }
              return { agent: member, event: matchingEvent };
            }
          }
        }
      }
    }

    // 1. Try direct handler name matching first (no LLM call needed!)
    for (const team of accessibleTeams) {
      for (const memberName of Object.keys(team.members)) {
        const member = team.members[memberName];
        if (member === this) continue;

        const matchingEvent = member.findMatchingHandler(intent);
        if (matchingEvent) {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[Agent:${this.name}] ✅ Direct match: ${member.name}.${matchingEvent} for intent "${intent}"`);
          }
          return { agent: member, event: matchingEvent };
        }
      }
    }

    // 2. No direct match — use semantic router as fallback
    const { agentRouter } = await import('./router.js');
    let matches = await agentRouter.findMatches(intent, 10);

    // Filter to only include agents in accessible teams (exclude self)
    matches = matches.filter(match => {
      const isAccessible = accessibleTeams.some(team => {
        return Object.keys(team.members).some(name => {
          const member = team.members[name];
          return member === match.agent || member.name === match.agent.name;
        });
      });
      return isAccessible && match.agent !== this;
    });

    if (matches.length > 0) {
      return matches[0];
    }

    return null;
  }

  /**
   * Find a handler in this agent that matches the intent
   */
  findMatchingHandler(intent) {
    if (!this.handlers || Object.keys(this.handlers).length === 0) {
      return null;
    }

    if (!intent || typeof intent !== 'string') {
      return null;
    }

    const intentLower = intent.toLowerCase().replace(/[^a-z0-9]/g, ''); // Remove non-alphanumeric

    // Try exact match first (case insensitive, ignoring separators)
    for (const eventName of Object.keys(this.handlers)) {
      const eventNormalized = eventName.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (eventNormalized === intentLower) {
        return eventName;
      }
    }

    // Try partial match
    for (const eventName of Object.keys(this.handlers)) {
      const eventLower = eventName.toLowerCase();
      const intentOriginal = intent.toLowerCase();

      if (intentOriginal.includes(eventLower) || eventLower.includes(intentOriginal)) {
        return eventName;
      }
    }

    // Try keyword matching (split by spaces and camelCase)
    const keywords = intent
      .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
      .toLowerCase()
      .split(/\s+/)
      .filter(k => k.length > 2);

    for (const eventName of Object.keys(this.handlers)) {
      const eventLower = eventName.toLowerCase();

      for (const keyword of keywords) {
        if (eventLower.includes(keyword)) {
          return eventName;
        }
      }
    }

    return null;
  }

  /**
   * Generate documentation of peer capabilities for LLM prompts
   * Returns a string describing what intents can be delegated to which peers
   */
  getPeerCapabilitiesDocumentation() {
    const capabilities = [];
    const processedAgents = new Set();

    // Helper function to collect handlers from an agent
    const collectHandlers = (agent, teamName = null) => {
      if (!agent || processedAgents.has(agent.name)) {
        return;
      }
      processedAgents.add(agent.name);

      if (agent.handlers && Object.keys(agent.handlers).length > 0) {
        const handlers = Object.keys(agent.handlers);
        const agentInfo = teamName ? `${agent.name} (${teamName})` : agent.name;

        // Collect handler details with descriptions
        const handlerDetails = [];
        for (const handler of handlers) {
          const handlerFn = agent.handlers[handler];
          let description = '';

          if (handlerFn && handlerFn.__description__) {
            description = handlerFn.__description__;
          } else if (handlerFn && handlerFn.__playbook__) {
            const playbook = handlerFn.__playbook__;
            const firstLine = playbook.split('\n')[0].trim();
            description = firstLine.replace(/\$\{[^}]+\}/g, '...').substring(0, 60);
            if (description.length < firstLine.length) {
              description += '...';
            }
          }

          handlerDetails.push({
            name: handler,
            description: description || `Handle ${handler}`
          });
        }

        capabilities.push({
          agent: agentInfo,
          role: agent.role ? agent.role.name : 'Unknown',
          handlers: handlerDetails
        });
      }
    };

    // Collect from peers team (if this agent is a member of a team)
    if (this.peers && this.peers.members) {
      const memberNames = Object.keys(this.peers.members);
      for (const memberName of memberNames) {
        const member = this.peers.members[memberName];
        if (member !== this) {
          collectHandlers(member, this.peers.name);
        }
      }
    }

    // Collect from usesTeams (teams this agent uses as a client)
    for (const team of this.usesTeams) {
      if (team && team.members) {
        const memberNames = Object.keys(team.members);
        for (const memberName of memberNames) {
          const member = team.members[memberName];
          collectHandlers(member, team.name);
        }
      }
    }

    if (capabilities.length === 0) {
      return '';
    }

    let doc = '\nAvailable team member capabilities:\n';
    for (const cap of capabilities) {
      doc += `\n${cap.agent} [${cap.role}]:\n`;
      for (const handler of cap.handlers) {
        doc += `  - ${handler.name}: ${handler.description}\n`;
      }
    }
    doc += '\nTo delegate, use: { "intent": "handler_name", "data": {...} }\n';

    return doc;
  }

  /**
   * Generate peer capabilities formatted as available actions
   * Returns a string listing delegation actions in the same format as action registry
   */
  async getPeerCapabilitiesAsActions() {
    const capabilities = [];
    const processedAgents = new Set();

    // Helper function to collect handlers from an agent
    const collectHandlers = async (agent, teamName = null) => {
      if (!agent || processedAgents.has(agent.name)) {
        return;
      }
      processedAgents.add(agent.name);

      if (agent.handlers && Object.keys(agent.handlers).length > 0) {
        const handlers = Object.keys(agent.handlers);
        for (const handler of handlers) {
          const agentInfo = teamName ? `${agent.name} (${teamName})` : agent.name;

          // Extract affordance/description from handler
          let description = '';
          let inputParams = '{ ... }';
          let returnType = null;
          const handlerFn = agent.handlers[handler];

          if (handlerFn && handlerFn.__playbook__) {
            const playbook = handlerFn.__playbook__;

            if (process.env.KOI_DEBUG_LLM) {
              console.error(`[CollectHandlers] Found playbook for ${handler}, length: ${playbook.length}`);
            }

            // Use LLM to infer metadata from playbook
            const metadata = await inferActionMetadata(playbook);
            description = metadata.description;
            inputParams = metadata.inputParams;
            returnType = metadata.returnType;

            if (process.env.KOI_DEBUG_LLM) {
              console.error(`[CollectHandlers] Inferred metadata for ${handler}:`, metadata);
            }
          } else if (handlerFn && typeof handlerFn === 'function') {
            // For regular functions, generate description from name
            description = `Handle ${handler} event`;
            inputParams = '{ ... }';
            returnType = '{ "result": "any" }';
          }

          capabilities.push({
            intent: handler,
            agent: agentInfo,
            role: agent.role ? agent.role.name : 'Unknown',
            description: description || `Execute ${handler}`,
            inputParams: inputParams,
            returnType: returnType || '{ "result": "any" }'
          });
        }
      }
    };

    // Collect from peers team (if this agent is a member of a team)
    if (this.peers && this.peers.members) {
      const memberNames = Object.keys(this.peers.members);
      for (const memberName of memberNames) {
        const member = this.peers.members[memberName];
        if (member !== this) {
          await collectHandlers(member, this.peers.name);
        }
      }
    }

    // Collect from usesTeams (teams this agent uses as a client)
    for (const team of this.usesTeams) {
      if (team && team.members) {
        const memberNames = Object.keys(team.members);
        for (const memberName of memberNames) {
          const member = team.members[memberName];
          await collectHandlers(member, team.name);
        }
      }
    }

    if (capabilities.length === 0) {
      return '';
    }

    let doc = '\n\nDelegation actions (to team members):\n';
    for (const cap of capabilities) {
      // Build delegation description with inferred metadata
      doc += `- { "actionType": "delegate", "intent": "${cap.intent}", "data": ${cap.inputParams} } - ${cap.description} → Returns: ${cap.returnType} (Delegate to ${cap.agent} [${cap.role}])\n`;
    }

    return doc;
  }

  /**
   * Check if action can be executed directly with LLM
   */
  canExecuteDirectly(action) {
    // Has inline playbook
    if (action.playbook) return true;

    // Explicit LLM task
    if (action.type === 'llm_task') return true;

    // Simple state operations
    if (action.type === 'update_state' || action.type === 'return') return true;

    // If it's a very simple task description, LLM can handle it
    const intent = action.intent || action.description || '';
    if (intent.length < 100 && !action.requiresExternalAgent) {
      return true;
    }

    return false;
  }

  /**
   * Execute action directly with LLM
   */
  async executeDirectly(action, context) {
    // Check if this is a registered action with an executor
    const actionDef = actionRegistry.get(action.type);

    if (actionDef && actionDef.execute) {
      // Use the registered executor
      return await actionDef.execute(action, this);
    }

    // Execute with LLM
    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }

    let prompt;

    if (action.playbook) {
      prompt = action.playbook;
    } else {
      // Generate simple prompt
      const intent = action.intent || action.description;
      const data = action.data || action.input || {};

      prompt = `
Task: ${intent}

Input data:
${JSON.stringify(data, null, 2)}

Context:
${JSON.stringify(context, null, 2)}

Execute this task and return the result as JSON.
`;
    }

    return await this.llmProvider.callJSON(prompt, this);
  }

  /**
   * Answer a question from a delegate agent.
   * Called when a delegate uses the ask_parent action.
   * Uses this agent's LLM to generate an answer, then re-delegates with the answer.
   */
  async _answerDelegateQuestion(question, delegateData, delegateName = 'Delegate') {
    cliLogger.print(`💬 ${delegateName} asks: \x1b[2m${question}\x1b[0m`);

    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }

    // Gather all available context so System can answer intelligently
    const contextStr = delegateData ? JSON.stringify(delegateData, null, 2) : '(none)';

    // Include shared session knowledge (facts discovered by any agent)
    let knowledgeStr = '';
    try {
      const { sessionKnowledge: _sk } = await import('./session-knowledge.js');
      const formatted = _sk.format();
      if (formatted) knowledgeStr = `\n\nShared session knowledge (facts discovered so far):\n${formatted}`;
    } catch { /* non-fatal */ }

    // Include System's own memory context (ALL tiers — long, medium, short)
    let memoryStr = '';
    try {
      const ctxMem = this._activeContextMemory;
      if (ctxMem?.entries) {
        const relevant = ctxMem.entries
          .map(e => e.permanent || e.shortTerm)
          .filter(Boolean)
          .slice(-40); // Last 40 entries max
        if (relevant.length > 0) memoryStr = `\n\nYour conversation memory (all tiers):\n${relevant.join('\n')}`;
      }
    } catch { /* non-fatal */ }

    // Include project root for orientation
    const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();

    const prompt = `A delegate agent (${delegateName}) you invoked has a question and cannot continue without your answer.

Question: "${question}"

Task context that was given to the delegate:
${contextStr}

Project root: ${projectRoot}
${knowledgeStr}${memoryStr}

INSTRUCTIONS:
1. First check if the answer is in your session knowledge or conversation memory above.
2. If you know the answer, respond: { "answer": "your answer here" }
3. If you DON'T know but the answer could be found by exploring the filesystem (e.g. checking sibling directories, reading config files), respond: { "answer": "Try looking at [specific suggestion based on project structure]" }
4. ONLY if the answer requires information that truly only the user knows (credentials, business decisions, external service details), respond: { "askUser": true, "question": "clear, specific question for the user" }

CRITICAL — NEVER escalate to the user for these (the delegate MUST handle them itself):
- Command errors (exit code != 0, connection refused, timeouts, missing packages, etc.) → Tell the delegate to diagnose and fix the error itself
- Technical problems that the delegate has the tools to solve → Tell the delegate to investigate and fix
- Missing files or dependencies → Tell the delegate to install/create them
- Questions about how to implement something → Tell the delegate to explore the codebase and figure it out

The user should ONLY be asked for things that are impossible to discover programmatically: passwords, API keys, business decisions, personal preferences, account credentials.

Be specific and concise. Never ask the user for things you or the delegate can discover by exploring.`;

    const response = await this.llmProvider.callJSON(prompt, this);

    // If the parent says "ask the user", use prompt_user style (not chat bubble)
    if (response?.askUser === true) {
      const userQuestion = response.question || question;
      cliLogger.clearProgress();
      // Show context: which agent is asking and what task it's working on
      const taskDesc = delegateData?.description || delegateData?.userRequest || delegateData?.goal || '';
      const taskHint = taskDesc ? ` \x1b[2m(working on: ${taskDesc.substring(0, 120)}${taskDesc.length > 120 ? '…' : ''})\x1b[0m` : '';
      cliLogger.print(`\x1b[1m${delegateName}\x1b[0m needs your input${taskHint}:`);
      cliLogger.print(userQuestion);
      const { cliInput } = await import('./cli-input.js');
      const userAnswer = await cliInput('❯ ');
      return typeof userAnswer === 'string' ? userAnswer : (userAnswer?.text ?? String(userAnswer ?? ''));
    }

    const rawAnswer = response?.answer ?? response;
    const answer = (rawAnswer !== null && typeof rawAnswer === 'object')
      ? JSON.stringify(rawAnswer)
      : String(rawAnswer ?? '');

    cliLogger.print(`💬 ${this.name} responds to ${delegateName}: \x1b[2m${answer}\x1b[0m`);
    return answer;
  }

  /**
   * Find a skill that matches the given intent
   */
  findMatchingSkill(intent) {
    if (!this.skills || this.skills.length === 0) {
      return null;
    }

    if (!intent || typeof intent !== 'string') {
      return null;
    }

    const intentLower = intent.toLowerCase();

    // Try exact or partial match
    for (const skill of this.skills) {
      const skillLower = skill.toLowerCase();

      if (intentLower.includes(skillLower) || skillLower.includes(intentLower)) {
        return skill;
      }
    }

    // Try keyword matching
    const keywords = intentLower.split(/\s+/);

    for (const skill of this.skills) {
      const skillLower = skill.toLowerCase();

      for (const keyword of keywords) {
        if (keyword.length > 3 && skillLower.includes(keyword)) {
          return skill;
        }
      }
    }

    return null;
  }

  /**
   * Execute legacy action (fallback for actions without executors)
   * This should rarely be used now - most actions have executors
   */
  async executeLegacyAction(action) {
    throw new Error(`Action type "${action.type}" has no executor registered and no legacy handler`);
  }


  async callSkill(skillName, functionNameOrInput, inputOrUndefined) {
    if (!this.skills.includes(skillName)) {
      throw new Error(`Agent ${this.name} does not have skill: ${skillName}`);
    }

    // Support two calling conventions:
    // 1. callSkill(skillName, functionName, input) - call specific function
    // 2. callSkill(skillName, input) - legacy: find matching function by intent
    let functionName, input;

    if (inputOrUndefined !== undefined) {
      // Convention 1: explicit function name
      functionName = functionNameOrInput;
      input = inputOrUndefined;
    } else {
      // Convention 2: auto-select function (legacy)
      input = functionNameOrInput;

      // Try to find a matching function using skill selector
      // For now, we'll just use the first available function
      const skillFunctions = globalThis.SkillRegistry?.getAll(skillName);
      if (!skillFunctions || Object.keys(skillFunctions).length === 0) {
        throw new Error(`No functions found in skill: ${skillName}`);
      }

      functionName = Object.keys(skillFunctions)[0];
    }

    // Get the function from SkillRegistry
    const skillFunction = globalThis.SkillRegistry?.get(skillName, functionName);

    if (!skillFunction) {
      throw new Error(`Function ${functionName} not found in skill ${skillName}`);
    }

    // Execute the skill function
    try {
      const result = await skillFunction.fn(input);
      return result;
    } catch (error) {
      throw new Error(`Skill ${skillName}.${functionName} failed: ${error.message}`);
    }
  }

  /**
   * Get available skill functions for tool calling
   * Returns an array of { name, fn, description } for each available function
   */
  getSkillFunctions() {
    const functions = [];

    // Access SkillRegistry from global scope (set by transpiled code)
    if (typeof globalThis.SkillRegistry !== 'undefined') {
      for (const skillName of this.skills) {
        const skillFunctions = globalThis.SkillRegistry.getAll(skillName);
        for (const [funcName, { fn, metadata }] of Object.entries(skillFunctions)) {
          functions.push({
            name: funcName,
            fn,
            description: metadata.affordance || `Function from ${skillName} skill`
          });
        }
      }
    }

    return functions;
  }


  /**
   * Get MCP tool summaries for system prompt generation.
   * Returns tool info from all MCP servers this agent has access to.
   */
  getMCPToolsSummary() {
    const mcpRegistry = globalThis.mcpRegistry;
    if (!mcpRegistry) return [];

    const summaries = [];
    const seen = new Set();

    // Agent-specific MCPs (declared with `uses mcp`)
    for (const mcpName of this.usesMCPNames) {
      const client = mcpRegistry.get(mcpName);
      if (client && client.tools.length > 0) {
        seen.add(mcpName);
        summaries.push({
          name: mcpName,
          tools: client.tools.map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema
          }))
        });
      }
    }

    // Global MCPs (from .mcp.json / KOI_GLOBAL_MCP_SERVERS) — available to all agents
    for (const [mcpName, client] of mcpRegistry.entries()) {
      if (!seen.has(mcpName) && mcpRegistry.isGlobal(mcpName) && client.tools.length > 0) {
        summaries.push({
          name: mcpName,
          tools: client.tools.map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema
          }))
        });
      }
    }

    return summaries;
  }

  toString() {
    return `Agent(${this.name}:${this.role.name})`;
  }
}
