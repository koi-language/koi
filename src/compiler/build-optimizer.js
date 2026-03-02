/**
 * Build-Time Optimizer
 *
 * Pre-computes handler descriptions during compilation to avoid runtime overhead.
 * One LLM call per agent (handlers + optional agent description in one JSON response).
 * Agents are processed in parallel batches of 5.
 * Uses SHA-256 content hashing to detect changes and avoid redundant API calls.
 */

import { LLMProvider } from '../runtime/llm-provider.js';
import { CacheManager } from './cache-manager.js';

const PARALLEL_BATCH_SIZE = 5;

export class BuildTimeOptimizer {
  constructor(config = {}) {
    this.enableCache = config.cache !== false;
    this.verbose = config.verbose || false;
    this.cacheManager = new CacheManager({
      verbose: config.verbose || false
    });
  }

  /**
   * Extract and pre-compute affordances from AST (with cache)
   */
  async optimizeAST(ast, sourceContent = '', sourcePath = 'unknown') {
    if (!this.enableCache) {
      if (this.verbose) console.log('[BuildOptimizer] Cache disabled, skipping');
      return null;
    }

    process.stdout.write('\r\x1b[K🔄 Checking cache...');

    const cached = this.cacheManager.get(sourceContent, sourcePath);
    if (cached) {
      process.stdout.write('\r\x1b[K');
      return cached;
    }

    process.stdout.write('\r\x1b[K🔄 Generating handler descriptions...');

    const result = await this._generateAllDescriptions(ast);

    process.stdout.write('\r\x1b[K');

    this.cacheManager.set(sourceContent, sourcePath, result);
    return result;
  }

  /**
   * Extract and pre-compute affordances from AST (without cache)
   */
  async optimizeASTWithoutCache(ast) {
    const result = await this._generateAllDescriptions(ast);
    process.stdout.write('\r\x1b[K');
    return result;
  }

  /**
   * Core: one LLM call per agent returning JSON with handler + agent descriptions.
   * Agents are processed in parallel batches of PARALLEL_BATCH_SIZE.
   */
  async _generateAllDescriptions(ast) {
    const affordances = {};
    const skillAffordances = {};
    const composeResolvers = {};

    // 1. Collect one job per agent
    const agentJobs = [];

    for (const decl of ast.declarations) {
      if (decl.type === 'AgentDecl') {
        const agentName = decl.name.name;
        const eventHandlers = decl.body.filter(b => b.type === 'EventHandler');
        const hasExplicitAffordance = decl.body.some(b => b.type === 'AffordanceDecl');

        const handlers = [];
        for (const handler of eventHandlers) {
          const eventName = handler.event.name;
          const playbook = this.findPlaybookForHandler(handler);
          if (playbook) {
            handlers.push({
              name: eventName,
              content: playbook.replace(/\$\{[^}]+\}/g, '...'),
              hasPlaybook: true
            });
          } else {
            const code = this._serializeHandlerCode(handler);
            handlers.push({ name: eventName, content: code || eventName, hasPlaybook: false });
          }
        }

        if (handlers.length > 0) {
          agentJobs.push({
            agentName,
            handlers,
            needsAgentDescription: !hasExplicitAffordance
          });
        }
      } else if (decl.type === 'SkillDecl') {
        const skillData = this.extractSkillAffordance(decl);
        if (skillData) skillAffordances[decl.name.name] = skillData;
      }
    }

    if (agentJobs.length === 0 && !ast.declarations.some(d => d.type === 'PromptDecl' && d.content?.type === 'ComposeDecl')) {
      return this._buildResult(affordances, skillAffordances, composeResolvers);
    }

    // 2. Run one LLM call per agent, parallelized in batches
    const optimizerProvider = this._pickOptimizerProvider();
    const results = [];
    for (let i = 0; i < agentJobs.length; i += PARALLEL_BATCH_SIZE) {
      const batch = agentJobs.slice(i, i + PARALLEL_BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(job => this._summarizeAgent(job, optimizerProvider)));
      results.push(...batchResults);
    }

    // 3. Apply LLM results
    for (let i = 0; i < agentJobs.length; i++) {
      const job = agentJobs[i];
      const result = results[i];

      affordances[job.agentName] = {};

      if (result.__description__) {
        affordances[job.agentName].__description__ = result.__description__;
      }

      for (const handler of job.handlers) {
        const desc = result[handler.name] || this.humanizeEventName(handler.name);
        affordances[job.agentName][handler.name] = {
          description: desc,
          confidence: handler.hasPlaybook ? 0.9 : 0.8,
          hasPlaybook: handler.hasPlaybook
        };
        if (this.verbose) {
          console.log(`    ✓ ${job.agentName}.${handler.name}: "${desc.substring(0, 60)}"`);
        }
      }

      if (this.verbose && affordances[job.agentName].__description__) {
        console.log(`    ✓ ${job.agentName} (Agent): "${affordances[job.agentName].__description__.substring(0, 60)}"`);
      }
    }

    // 4. Override with explicit agent-level affordances
    for (const decl of ast.declarations) {
      if (decl.type !== 'AgentDecl') continue;
      const agentName = decl.name.name;
      if (!affordances[agentName]) continue;

      const agentAffordance = decl.body.find(b => b.type === 'AffordanceDecl');
      if (agentAffordance) {
        affordances[agentName].__description__ = agentAffordance.content.value
          .split('\n').map(l => l.trim()).filter(l => l.length > 0).join(' ');
      }
    }

    // 5. Generate compile-time JavaScript resolvers for compose prompt blocks
    const resolvers = await this._generateComposeResolvers(ast, optimizerProvider);
    Object.assign(composeResolvers, resolvers);

    return this._buildResult(affordances, skillAffordances, composeResolvers);
  }

  /**
   * Find all ComposeDecl prompt declarations and generate JS resolver functions.
   * Returns a map: { promptName: resolverFunctionBody }
   */
  async _generateComposeResolvers(ast, provider) {
    const composeJobs = [];

    for (const decl of ast.declarations) {
      if (decl.type === 'PromptDecl' && decl.content?.type === 'ComposeDecl') {
        const name = decl.name.name;
        const { fragments, template } = decl.content;
        // Skip directive-based compose blocks — compiled deterministically by the transpiler
        if (/@let\s|@if\s/.test(template)) continue;
        const fragmentNames = fragments.map(f => f.name);
        composeJobs.push({ name, fragmentNames, template });
      }
    }

    if (composeJobs.length === 0) return {};

    process.stdout.write('\r\x1b[K🔄 Generating compose resolvers...');

    const results = {};
    for (const job of composeJobs) {
      try {
        const code = await this._generateResolverCode(job, provider);
        if (code) {
          results[job.name] = code;
          if (this.verbose) {
            console.log(`    ✓ Compose resolver for ${job.name} generated (${code.length} chars)`);
          }
        }
      } catch (error) {
        if (this.verbose) {
          console.warn(`[BuildOptimizer] Failed to generate resolver for ${job.name}: ${error.message}`);
        }
      }
    }

    return results;
  }

  /**
   * Generate a JavaScript async function body for one compose block.
   */
  async _generateResolverCode(job, provider) {
    const { name, fragmentNames, template } = job;

    const prompt = `Generate a JavaScript async function body for a KOI compose prompt resolver.

The function has this signature: async (fragments, callAction) => { YOUR CODE HERE }

## Available API
- \`fragments.NAME\` — string content of a named prompt fragment
  Fragment names available: ${fragmentNames.join(', ')}
- \`await callAction('action_name', data)\` — execute a runtime action, returns the action result
  Available actions:
    - 'task_list' → { tasks: [{id, status: 'pending'|'in_progress'|'completed', blockedBy:[]}], summary: {total, pending, in_progress, completed, blocked} }
    - 'action_history' with { count: N } → { summary: string, total: number, step: number }. Returns a formatted text of the last N actions the agent executed with their results.
    - 'frame_server_state' with optional { precision: "low"|"medium"|"high"|"full" } → { screenshot: string (base64 JPEG), mimeType: string, elements: string (formatted element list), elementCount: number } | null. Returns the current mobile screen state from the background frame server. Precision controls screenshot resolution: "low" (360px), "medium" (480px), "high" (720px), "full" (native). Default is "low". Returns null if the frame server is not running.

## Return value
- **Text only (default)**: Return a string (the assembled prompt). Use \`[...].filter(Boolean).join('\\n\\n')\` to combine fragments.
- **Multimodal (with images)**: Return \`{ text: string, images: [{ data: base64String, mimeType: 'image/jpeg' }] }\`. The text becomes the prompt and the images are injected into the LLM call. Use this when the rules mention including screenshots or images from the frame server.

## Patterns
- **Action history**: If the rules mention including recent/last N actions executed or action history, call \`await callAction('action_history', { count: N })\` (default N=15). It returns \`{ summary: string, total: number, step: number }\`. Concatenate \`result.summary\` into the output string. Also add a text section instructing the model to review the action history to detect loops and change strategy when stuck.
- **Mobile screenshot**: If the rules mention including a mobile screenshot or frame server state, call \`await callAction('frame_server_state', { precision })\` where precision matches what the rules specify ("low", "medium", "high", or "full"). If no precision is mentioned, default to "low". If it returns non-null, include \`result.elements\` in the text parts and \`{ data: result.screenshot, mimeType: result.mimeType }\` in the images array. Return the multimodal format \`{ text, images }\`.

## CRITICAL: Follow the rules LITERALLY
- Implement the rules exactly as written. Do not add, remove, or reorder anything the rules do not specify.
- If the rules say to include a fragment conditionally (e.g. "only if there are elements"), make it conditional.
- If the rules say to include a fragment unconditionally, include it always.
- If the rules specify a text format/template for presenting data (like element lists), reproduce that format literally in the output using template literals — do not summarize or omit parts of it.
- When returning multimodal format \`{ text, images }\`, all text fragments that should be included (per the rules) must still be in the text.

## Template to implement
${template}

Output ONLY the JavaScript function body code (no function declaration, no markdown fences, no explanation).`;

    try {
      const response = await provider.simpleChat(prompt);
      if (!response) return null;

      // Strip markdown fences if the LLM added them
      const cleaned = response
        .replace(/^```(?:javascript|js)?\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();

      return cleaned || null;
    } catch (error) {
      if (this.verbose) {
        console.warn(`[BuildOptimizer] Resolver generation failed for ${name}: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Single LLM call for one agent.
   * Returns JSON: { "__description__"?: string, handlerName: string, ... }
   */
  async _summarizeAgent(job, provider) {

    const handlersList = job.handlers.map(h => {
      const type = h.hasPlaybook ? 'Playbook' : 'Code';
      return `- "${h.name}" (${type}):\n${h.content.substring(0, 600)}`;
    }).join('\n\n');

    const agentDescLine = job.needsAgentDescription
      ? `  "__description__": "High-level agent role (max 50 words, DIFFERENT from any handler description)",`
      : '';

    const handlerKeys = job.handlers.map(h =>
      `  "${h.name}": "One sentence: what this handler does. Delegate here when: [3-5 concrete task examples separated by commas] (max 80 words total)"`
    ).join(',\n');

    const prompt = `Analyze agent "${job.agentName}" and summarize its handlers for use as delegation affordances. Return ONLY valid JSON, no explanation.

Each handler description must follow this format:
"One sentence about what this handler does. Delegate here when: [3-5 concrete task examples]"

Examples of good descriptions:
- "Explores and searches files in a codebase. Delegate here when: finding files by name, searching for code patterns, listing directory contents, locating function definitions, discovering project structure."
- "Implements software features and fixes bugs. Delegate here when: writing new code, editing existing files, fixing errors, refactoring, implementing a feature, debugging a crash."

Handlers:
${handlersList}

JSON format:
{
${agentDescLine}
${handlerKeys}
}`;

    try {
      const response = await provider.simpleChat(prompt);
      if (!response) return this._fallbackAgentResult(job);

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return this._fallbackAgentResult(job);

      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      if (this.verbose) {
        console.warn(`[BuildOptimizer] Failed for agent ${job.agentName}: ${error.message}`);
      }
      return this._fallbackAgentResult(job);
    }
  }

  /**
   * Fallback when LLM call fails for an agent
   */
  _fallbackAgentResult(job) {
    const result = {};
    if (job.needsAgentDescription) {
      result.__description__ = `Agent capable of ${job.handlers.map(h => h.name).join(', ')}.`;
    }
    for (const h of job.handlers) {
      result[h.name] = this.humanizeEventName(h.name);
    }
    return result;
  }

  /**
   * Serialize handler body to readable code summary
   */
  _serializeHandlerCode(handler) {
    const lines = [];
    for (const stmt of handler.body) {
      const code = this.serializeStatement(stmt);
      if (code) lines.push(code);
    }
    return lines.join('\n') || null;
  }

  _buildResult(affordances, skillAffordances, composeResolvers = {}) {
    let totalAffordances = 0;
    for (const agent of Object.values(affordances)) {
      totalAffordances += Object.keys(agent).filter(k => k !== '__description__').length;
    }
    return {
      affordances,
      skillAffordances,
      composeResolvers,
      metadata: {
        generatedAt: Date.now(),
        totalAgents: Object.keys(affordances).length,
        totalAffordances,
        totalSkills: Object.keys(skillAffordances).length,
        totalSkillAffordances: Object.keys(skillAffordances).length,
        totalComposeResolvers: Object.keys(composeResolvers).length
      }
    };
  }

  // --- Helper methods ---

  findPlaybookForHandler(handler) {
    for (const stmt of handler.body) {
      if (stmt.type === 'PlaybookStatement') {
        if (stmt.parts) {
          const firstStringPart = stmt.parts.find(p => p.type === 'StringPart');
          return firstStringPart ? firstStringPart.content.value : null;
        }
        return stmt.content ? stmt.content.value : null;
      }
    }
    return null;
  }

  extractLLMConfig(agentNode) {
    const llmConfig = agentNode.body.find(b => b.type === 'LLMConfig');
    if (!llmConfig || !llmConfig.config || !llmConfig.config.properties) return null;

    const props = {};
    for (const prop of llmConfig.config.properties) {
      const key = prop.key?.name || prop.key;
      const val = prop.value?.value;
      if (key && val !== undefined) props[key] = val;
    }
    return props.provider && props.model ? props : null;
  }

  extractSkillAffordance(skillNode) {
    const affordanceText = skillNode.affordance?.value || skillNode.affordance || '';

    if (!affordanceText || affordanceText.trim().length === 0) {
      const description = this.humanizeEventName(skillNode.name.name);
      return { description, confidence: 0.5 };
    }

    let cleanDescription = affordanceText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join(' ')
      .trim();

    if (!cleanDescription || cleanDescription.length === 0) {
      cleanDescription = this.humanizeEventName(skillNode.name.name);
    }

    if (this.verbose) {
      console.log(`    ✓ Skill ${skillNode.name.name}: "${cleanDescription.substring(0, 50)}..."`);
    }

    return { description: cleanDescription, confidence: 0.9 };
  }

  serializeStatement(stmt) {
    if (!stmt) return '';

    switch (stmt.type) {
      case 'ConstDeclaration':
        return `const ${stmt.name.name} = ...`;
      case 'ReturnStatement':
        if (stmt.value && stmt.value.type === 'ObjectLiteral') {
          const keys = stmt.value.properties?.map(p => p.key?.name || p.key).join(', ') || '';
          return `return { ${keys} }`;
        }
        return 'return ...';
      case 'SendStatement': {
        const role = stmt.role?.name || 'Role';
        const event = stmt.event?.name || 'event';
        return `send to ${role}.${event}()`;
      }
      case 'ExpressionStatement':
        if (stmt.expression?.type === 'CallExpression') {
          const callee = stmt.expression.callee?.name || stmt.expression.callee?.property?.name || 'function';
          return `${callee}(...)`;
        }
        return '...';
      default:
        return `// ${stmt.type}`;
    }
  }

  humanizeEventName(eventName) {
    return eventName
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .toLowerCase()
      .trim();
  }

  /**
   * Pick the best available LLM provider for build-time optimization,
   * based on which API keys are present in the environment.
   * Intentionally independent of agent runtime configs.
   */
  _pickOptimizerProvider() {
    if (process.env.OPENAI_API_KEY)    return this.getOrCreateChatProvider({ provider: 'openai',    model: 'gpt-4o-mini' });
    if (process.env.ANTHROPIC_API_KEY) return this.getOrCreateChatProvider({ provider: 'anthropic', model: 'haiku' });
    if (process.env.GEMINI_API_KEY)    return this.getOrCreateChatProvider({ provider: 'gemini',    model: 'gemini-2.0-flash' });
    return this.getOrCreateChatProvider(null); // fallback, will error if no key at all
  }

  getOrCreateChatProvider(agentLLM = null) {
    const provider = agentLLM?.provider || 'openai';
    const model = agentLLM?.model || 'gpt-4o-mini';
    const key = `${provider}:${model}`;

    if (!this._chatProviders) this._chatProviders = new Map();

    if (!this._chatProviders.has(key)) {
      this._chatProviders.set(key, new LLMProvider({
        provider,
        model,
        temperature: 0.1,
        maxTokens: 1000
      }));
    }

    return this._chatProviders.get(key);
  }

  generateCacheCode(cacheData) {
    if (!cacheData) return '';

    return `
// ============================================================
// Pre-computed Affordances (Build-time Cache)
// Generated at: ${new Date(cacheData.metadata.generatedAt).toISOString()}
// Total agents: ${cacheData.metadata.totalAgents || 0}
// Total agent affordances: ${cacheData.metadata.totalAffordances || 0}
// Total skills: ${cacheData.metadata.totalSkills || 0}
// Total skill affordances: ${cacheData.metadata.totalSkillAffordances || 0}
// ============================================================

const CACHED_AFFORDANCES = ${JSON.stringify(cacheData.affordances || {}, null, 2)};

const CACHED_SKILL_AFFORDANCES = ${JSON.stringify(cacheData.skillAffordances || {}, null, 2)};

`;
  }
}
