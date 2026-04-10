import fs from 'fs';
import path from 'path';

import { actionRegistry } from '../agent/action-registry.js';

// =========================================================================
// SYSTEM PROMPT BUILDER — standalone functions extracted from LLMProvider
// =========================================================================

/**
 * Build the system prompt for all agents.
 * Single unified prompt — only the available intents change per agent.
 * @param {Agent} agent - The agent
 * @returns {{ static: string, dynamic: string }} Complete system prompt
 */
export async function buildSystemPrompt(agent) {
  const hasTeams = agent && agent.usesTeams && agent.usesTeams.length > 0;
  const resourceSection = await buildSmartResourceSection(agent);
  const intentNesting = hasTeams ? '\nIMPORTANT: Do NOT nest "intent" inside "data". The "intent" field must be at the top level.' : '';
  const koiMd = loadKoiMd(); // Always inject — project specs apply to all agents

  // ── Runtime Context block (universal for all agents) ──
  // Use local time with UTC offset so the LLM knows the user's timezone.
  // e.g. "2026-03-22T21:53:14+01:00" instead of "2026-03-22T20:53:14" (ambiguous UTC)
  const _now = new Date();
  const _pad = (n) => String(n).padStart(2, '0');
  const _offsetMin = _now.getTimezoneOffset(); // negative for east of UTC
  const _absH = _pad(Math.floor(Math.abs(_offsetMin) / 60));
  const _absM = _pad(Math.abs(_offsetMin) % 60);
  const _offsetStr = `${_offsetMin <= 0 ? '+' : '-'}${_absH}:${_absM}`;
  const now = `${_now.getFullYear()}-${_pad(_now.getMonth() + 1)}-${_pad(_now.getDate())}T${_pad(_now.getHours())}:${_pad(_now.getMinutes())}:${_pad(_now.getSeconds())}${_offsetStr}`;
  const cwd = process.cwd();
  const agentDisplayName = agent?.name || 'unknown';
  const statusPhase = agent?.state?.statusPhase || null;
  const phaseField = statusPhase ? `\n| Current phase | \`${statusPhase}\` |` : '';
  // User language — set automatically by the inbox classifier ("ear")
  // when a user message arrives. Agents never set it themselves; it is
  // always authoritative for the language of the user's latest message.
  const stateLanguage = agent?.state?.userLanguage;
  if (stateLanguage) globalThis.__koiUserLanguage = stateLanguage;
  const userLanguage = globalThis.__koiUserLanguage || null;
  const langField = userLanguage ? `\n| User language | ${userLanguage} |` : '';

  // Timezone (IANA)
  let timezone = '';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}

  // ── Phase system explanation (only when agent uses phases) ──
  const hasPhaseDone = agent?.hasPermission?.('phase_done') ?? (agent?._availableActions?.has?.('phase_done') ?? true);
  const phaseSystemBlock = statusPhase ? `
========================================
PHASE SYSTEM
========================================

You operate in phases. Each phase controls which actions, agents, and rules are loaded — keeping your context focused and minimal.

Your current phase is \`${statusPhase}\`. Only the actions and agents relevant to this phase are shown below.

**You do NOT choose your phase.** Phase transitions are handled by the runtime based on events declared in the agent's reactions block (user messages, delegate returns, errors, phase completion). The \`statusPhase\` field is read-only from your point of view — any attempt to change it via \`update_state\` will be silently ignored.

When you finish all the work that belongs to the current phase, call \`phase_done\` to signal completion. The runtime will then fire the \`phase.done\` event and transition to the next phase based on the agent's reactions. Do not try to pick the next phase yourself.
` : '';

  // prompt_user requires 'prompt_user' permission — only System and ProjectOnBoarding have it
  const hasPromptUser = agent?.hasPermission?.('prompt_user') ?? false;

  // Non-interactive mode: agent must act without asking for confirmation
  const nonInteractiveBlock = process.env.KOI_EXIT_ON_COMPLETE === '1' ? `

========================================
NON-INTERACTIVE MODE
========================================

You are running in non-interactive (headless) mode. There is no human to answer follow-up questions.

**CRITICAL RULES:**
- Do NOT ask for confirmation — execute actions directly.
- Do NOT use prompt_user to ask "Do you want me to...?" — just do it.
- Complete the ENTIRE task autonomously: investigate, implement, verify.
- Only call prompt_user at the very end to report what you did.

**USE TOOLS, NOT YOUR OWN KNOWLEDGE:**
- You are an agent with access to tools (shell, web_search, read_file, etc.). Use them.
- If a task requires domain expertise you lack (chess, math, science, music, etc.), search the web for APIs, libraries, or tools that can help. Install them with shell and use them programmatically.
- Example: for chess analysis, install stockfish or python-chess. For math proofs, use sympy. For image processing, use python libraries. Never try to solve domain-specific problems from memory alone.

**ANNOTATION IMAGES — user instructions drawn on screen:**
- Attachments marked as ANNOTATION are screenshots where the user has drawn arrows, circles, crosses, or text directly on the screen to indicate changes they want.
- Annotations are INSTRUCTIONS, not decorations. Examine them carefully to understand what the user wants changed: circled elements mean "change this", crossed-out elements mean "remove this", arrows mean "move this", text annotations are literal instructions.
- IGNORE annotation colors (red, blue, green, etc.) — they are just visual markers to make annotations visible. The color of an annotation does NOT mean "make it this color". A red circle around text means "change this text", not "make this text red".
- When the user says "haz ese cambio" / "make that change" with annotations attached, the annotations ARE the change description. Do NOT ask what to change — look at the annotations.
- If both an original image and an annotated version are attached, compare them to understand the differences the user wants.

**VERIFY DATA EXTRACTED FROM IMAGES:**
- When you extract spacial data from an image (positions, coordinates, ...), ALWAYS verify it programmatically before using it.
- If validation fails, re-read the image more carefully and try again.${agent?.hasPermission?.('delegate') ? '\n- When delegating a task that depends on image data, reference attachments by their ID (e.g. att-1). The delegate can call read_file("att-1") to access the image. NEVER include raw file paths — always use attachment IDs.' : ''}
` : '';

  // BRAXIL.md / CLAUDE.md is already injected via koiMd (_loadKoiMd) above.

  // ── Prompt layout: STATIC content first (cacheable), DYNAMIC content last ──
  // LLM prompt caching works on identical prefixes — the longer the unchanging
  // prefix, the higher the cache hit rate. Static rules/tools go first;
  // runtime context (timestamp, phase, cwd) goes at the end.
  const staticPart = `${koiMd}
========================================
OUTPUT CONTRACT (MUST FOLLOW)
========================================

Return exactly ONE valid JSON object and nothing else.
- No markdown
- No explanations
- No prose
- Response must start with { and end with }

Never output invalid JSON. Invalid JSON crashes the system.

========================================
GOLDEN RULE (ABSOLUTE)
========================================

You are FORBIDDEN from generating any fact, summary, analysis, conclusion, or user-facing content that has not been obtained from an actual action result in this conversation.

If the task requires reading a file, fetching a URL, running a command, or retrieving any external/internal data, you MUST do it in separate steps:

1) emit only the retrieval action
2) wait for the real result
3) only then emit analysis, summary, print, or return content based on that result

NEVER combine in the same batch:
- a retrieval action (read_file, shell, web_fetch, web_search, grep, search, semantic_code_search, etc.)
with
- a print, answer, summary, conclusion, or return payload that depends on that retrieval

Until the action result exists in the conversation, any such content would be fabricated.

Always follow:
retrieve first → wait for result → analyze/respond

This rule overrides any optimization, batching preference, or attempt to save steps.
Correctness beats fewer steps.

========================================
ACTION MODEL
========================================

Every action object MUST include:
- "actionType"
- "intent"

ONE action = ONE intent = ONE object. Each object contains ONLY the fields defined for that specific intent. NEVER add fields from a different intent into the same object — extra fields are silently ignored and the second action will NOT execute. If you need two actions, use a batch with two separate objects.

Valid action types:
- "direct"${hasTeams ? '\n- "delegate"' : ''}

Intent rules:
- For direct actions: "intent" MUST be exactly one of AVAILABLE ACTIONS.${hasTeams ? '\n- For delegate actions: "intent" MUST follow "agentKey::eventName" and refer to a valid available agent/event.' : ''}
- Never invent new intents.
- Never put descriptive text inside "intent". Put that text in "query", "pattern", "message", "question", or other parameters.

Invalid:
{ "actionType": "direct", "intent": "semantic index supported languages" }

Valid:
{ "actionType": "direct", "intent": "semantic_code_search", "query": "semantic index language parser support" }

========================================
BATCH
========================================

"batch" is a TOP-LEVEL-ONLY key. It cannot coexist with "actionType", "intent", or any other action field. If you need to do multiple things in one turn (e.g. print + phase_done), use a batch:

{ "batch": [
  { "actionType": "direct", "intent": "print", "message": "Here is the result." },
  { "actionType": "direct", "intent": "phase_done" }
]}

========================================
EXECUTION FLOW
========================================

Your response MUST be ONE JSON object per step and it MUST be one of two forms — never mix them:
1. A single action: { "actionType": "direct", "intent": "...", ... }
2. A batch: { "batch": [ ...actions... ] }

Use sequential steps only when later actions depend on earlier results.

Parallelism is mandatory:
- If 2+ actions are independent, they MUST go inside a "parallel" block
- Never place independent actions sequentially in a batch${hasPromptUser ? '\n- EXCEPTION: prompt_user must NEVER be inside a parallel block' : ''}

Examples:

Single action:
{ "actionType": "direct", "intent": "semantic_code_search", "query": "authentication login session token" }

Parallel:
{
  "batch": [
    {
      "parallel": [
        { "actionType": "direct", "intent": "semantic_code_search", "query": "semantic index build embed vector store" },
        { "actionType": "direct", "intent": "semantic_code_search", "query": "language support parser javascript typescript python" }
      ]
    }
  ]
}

Sequential then parallel:
{
  "batch": [
    { "actionType": "direct", "intent": "read_file", "path": "src/index.ts", "offset": 0, "limit": 120 },
    {
      "parallel": [
        { "actionType": "direct", "intent": "grep", "pattern": "semanticIndex" },
        { "actionType": "direct", "intent": "grep", "pattern": "supportedLanguages" }
      ]
    }
  ]
}

Only emit:
{ "actionType": "direct", "intent": "return", "data": { ... } }
when the full task is complete.

Do not return early.
Do not treat exploration alone as task completion.
You must complete all required follow-up actions before returning.

========================================
FINAL NON-NEGOTIABLE RULES
========================================

1. Never answer in natural language
2. Never explain reasoning
3. Never describe what you will do
4. Never invent intents
5. Never fabricate facts not present in action results
6. Never emit incomplete actions
7. Never return before the whole task is done
8. Always prefer evidence over speculation

${resourceSection}${intentNesting}

CRITICAL: Return a single JSON action or { "batch": [...] }. No markdown.`;

  // ── Working area: documents the user has open in the GUI ──
  // Pulled from the in-memory store (open-documents-store), populated by the
  // CLI layer when the GUI reports tab changes.
  let openDocumentsBlock = '';
  try {
    const { openDocumentsStore } = await import('../state/open-documents-store.js');
    if (openDocumentsStore.hasAny()) {
      const docs = openDocumentsStore.getAll();
      const active = openDocumentsStore.getActive();
      const lines = ['', '# WORKING AREA', '', `The user has ${docs.length} document(s) open next to the chat:`];
      for (const d of docs) {
        const loc = d.path || d.url || '';
        const isActive = active && d.id === active.id;
        lines.push(`- [${d.type}] ${d.title}${loc ? ' — `' + loc + '`' : ''}${isActive ? ' **(ACTIVE — what the user is currently looking at)**' : ''}`);
      }
      lines.push('');
      lines.push('**The active document is what the user is currently looking at on their screen.** When the user says "this", "esto", "ves esto?", "the document", "the pdf", "the image", or refers to something visible without naming it — they mean the ACTIVE document.');
      lines.push('');
      lines.push('To read any of these documents, use `read_file` with the exact path shown above. Do NOT invent paths — only use paths from this list.');
      if (active && (active.path || active.url)) {
        lines.push('');
        lines.push('Example — read the active document:');
        lines.push('```json');
        lines.push(`{ "intent": "read_file", "path": "${active.path || active.url}" }`);
        lines.push('```');
      }
      openDocumentsBlock = lines.join('\n') + '\n';
    }
  } catch { /* store not available — skip */ }

  // ── Dynamic section: runtime context, project map, language, non-interactive ──
  // Changes every turn (timestamp, task counts, phase). Placed AFTER the agent's
  // playbook so the static prefix (generic rules + agent playbook) is maximally cacheable.
  const dynamic = `${now} | ${timezone || 'unknown'}
${phaseSystemBlock}
# RUNTIME CONTEXT

| Field | Value |
|---|---|
| Working directory | \`${cwd}\` |${langField}

All file paths (read_file, edit_file, write_file, shell) are relative to working directory unless absolute.
**LANGUAGE:** The "User language" field above is set automatically by the runtime whenever a new user message arrives — trust it. All user-facing output (print, prompt_user, questions) must be in that language. Code and technical identifiers stay in English. You do not need (and cannot) change the language yourself — it tracks the user's latest message natively.
${openDocumentsBlock}${nonInteractiveBlock}
REMINDER: intent must be one of AVAILABLE ACTIONS (enum). Never invent new intents. Descriptions go in query / other fields.`;

  return { static: staticPart, dynamic };
}

/**
 * Load BRAXIL.md (or KOI.md) from the project root (cwd) if it exists.
 * Similar to CLAUDE.md — project-specific instructions appended to the system prompt.
 */
export function loadKoiMd() {
  const candidates = [
    path.join(process.cwd(), 'BRAXIL.md'),
    path.join(process.cwd(), 'braxil.md'),
    path.join(process.cwd(), 'CLAUDE.md'),
    path.join(process.cwd(), 'claude.md'),
    path.join(process.cwd(), 'KOI.md'),
    path.join(process.cwd(), 'koi.md'),
  ];
  // Find the first candidate that exists — on case-insensitive FS (macOS),
  // BRAXIL.md and braxil.md resolve to the same file, so just use the first hit.
  let found = null;
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) { found = filePath; break; }
  }
  if (found) {
    try {
      const content = fs.readFileSync(found, 'utf8').trim();
      const name = path.basename(found);
      if (content) {
        return `\n\n── PROJECT SPECIFICATIONS (from ${name}) ──────────────────────────\n${content}\n── END ${name} ──────────────────────────────────────────────────`;
      }
    } catch { /* ignore read errors */ }
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
export async function buildSmartResourceSection(agent) {
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

  // Team members (delegation targets) — only if agent can delegate
  const peerIntents = agent.hasPermission('delegate') ? collectPeerIntents(agent) : [];
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
  return buildExpandedResourceSection(resources, agent);
}

/**
 * Collect peer intents (handler names + descriptions) from accessible teams.
 * @param {Agent} agent
 * @returns {Array<{agentName, handlers: Array<{name, description}>}>}
 */
export function collectPeerIntents(agent) {
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

      handlers.push({ name: handlerName, description, params, isAsync: !!handlerFn?.__async__ });
    }

    result.push({
      agentName: teamName ? `${memberKey} (${teamName})` : memberKey,
      agentPureName: memberKey,
      teamName: teamName || null,
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
export function buildExpandedResourceSection(resources, agent) {
  let doc = '';

  // ── AVAILABLE ACTIONS ───────────────────────────────────────────────────
  for (const resource of resources) {
    if (resource.type === 'direct') {
      doc += actionRegistry.generatePromptDocumentation(agent);
    }
  }

  // ── AVAILABLE AGENTS ────────────────────────────────────────────────────
  let delegateResources = resources.filter(r => r.type === 'delegate');

  // Phase-based filtering: if 'delegate' permission is disabled, hide all agents
  const disabledPerms = agent?.state?.disabledPermissions;
  if (Array.isArray(disabledPerms) && disabledPerms.includes('delegate')) {
    delegateResources = [];
  }

  if (delegateResources.length > 0) {
    doc += '## AVAILABLE AGENTS\n\n';
    for (const resource of delegateResources) {
      doc += `### ${resource.agentPureName}\n`;
      if (resource.agentDescription) {
        doc += `${resource.agentDescription}\n`;
      }
      for (const handler of resource.intents) {
        const _asyncTag = handler.isAsync ? ' [async — runs in background, add "await": true to wait]' : '';
        doc += ` - ${handler.name}${_asyncTag}: ${handler.description}\n`;
        if (handler.params?.length > 0) {
          doc += `    In: { ${handler.params.map(p => `"${p}"`).join(', ')} }\n`;
        }
      }
      doc += '\n';
    }
  }

  // ── AVAILABLE MCP TOOLS ─────────────────────────────────────────────────
  let mcpResources = resources.filter(r => r.type === 'mcp');
  if (Array.isArray(disabledPerms) && disabledPerms.includes('call_mcp')) {
    mcpResources = [];
  }
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
  doc += '{ "actionType": "direct", "intent": "<action_name>", "<param1>": "<value1>", "<param2>": "<value2>" }\n\n';

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
// REACTIVE SYSTEM PROMPT
// =========================================================================

/**
 * Build the system prompt for reactive mode.
 * Wraps buildSystemPrompt + playbook injection.
 * @param {Agent} agent - The agent
 * @param {string|object|null} playbook - The agent's playbook
 * @returns {string|object} Complete system prompt
 */
export async function buildReactiveSystemPrompt(agent, playbook = null) {
  const { static: staticBase, dynamic } = await buildSystemPrompt(agent);
  // Layout for maximum cache hit rate:
  //   1. Agent header (agent + phase — static per variant, cacheable)
  //   2. Static generic rules (output contract, golden rule, action model, tools) — never changes
  //   3. Agent playbook (changes per agent but stable within an agent's session)
  //   4. Dynamic runtime context (timestamp, task counts, phase) — changes every turn
  // Structured cache-aware playbook from compiler taint analysis
  if (typeof playbook === 'object' && playbook?._cacheKey !== undefined) {
    const _s = (v) => typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v));
    return {
      _cacheKey: playbook._cacheKey,
      static: [staticBase, _s(playbook.static)].filter(Boolean).join('\n\n'),
      dynamic: [_s(playbook.dynamic), dynamic].filter(Boolean).join('\n\n'),
    };
  }

  // Legacy: plain string playbook (or flatten object without _cacheKey)
  const parts = [staticBase];
  let playbookStr = '';
  if (typeof playbook === 'string') {
    playbookStr = playbook.trim();
  } else if (typeof playbook === 'object' && playbook !== null) {
    // Flatten any object that slipped through without _cacheKey
    playbookStr = typeof playbook.static === 'string' && typeof playbook.dynamic === 'string'
      ? [playbook.static, playbook.dynamic].filter(Boolean).join('\n')
      : typeof playbook.text === 'string'
        ? playbook.text
        : String(playbook);
  }
  if (playbookStr) parts.push(playbookStr);
  parts.push(dynamic);
  return parts.join('\n\n');
}
