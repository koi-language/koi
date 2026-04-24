import fs from 'fs';
import path from 'path';

import { actionRegistry } from '../agent/action-registry.js';
import { getUserAgentsTeam } from '../agent/md-agent-loader.js';

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
  // Platform — tell the agent explicitly so it picks the right shell
  // builtins. Without this, agents guess from cwd shape ("/Users/..." →
  // mac, "C:\..." → Windows) and often propose bash-only commands
  // (`ls`, `chmod`, `rm -rf`) on Windows where they don't exist.
  const _platformLabel = process.platform === 'darwin' ? 'macOS (darwin)'
    : process.platform === 'win32' ? 'Windows (win32) — shell is cmd.exe / PowerShell, NOT bash. Use `dir`, `type`, `copy`, `move`, `del`, `where`, `mkdir`. PowerShell cmdlets also work: `Get-ChildItem`, `Remove-Item`, `Test-Path`'
    : process.platform === 'linux' ? 'Linux'
    : process.platform;
  const platformField = `\n| Platform | ${_platformLabel} |`;
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
  //
  // NOTE: koiMd (BRAXIL.md / CLAUDE.md) is returned separately so
  // buildReactiveSystemPrompt can inject it as the VERY FIRST thing in the
  // prompt, before even the agent's playbook.
  const staticPart = `
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
2. Never invent intents
3. Never fabricate facts not present in action results
4. Never emit incomplete actions
5. Never return before the whole task is done
6. Always prefer evidence over speculation

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
      let anyHasComposite = false;
      for (const d of docs) {
        const loc = d.path || d.url || '';
        const isActive = active && d.id === active.id;
        const activeTag = isActive ? ' **(ACTIVE — what the user is currently looking at)**' : '';
        lines.push(`- [${d.type}] ${d.title}${loc ? ' — `' + loc + '`' : ''}${activeTag}`);

        // DocumentBundle — compact rendering. Only the fields the agent
        // actually needs to route a media action: annotation path (the
        // visual intent spec), reference paths (forwarded to
        // generate_image as extra refs). Roles are implicit in the
        // labels ("composite", "references"); per-resource prose lives
        // in the code, not in the prompt.
        const b = d.bundle;
        if (b && typeof b === 'object') {
          if (b.annotation?.path) {
            anyHasComposite = true;
            lines.push(`    ↳ composite: \`${b.annotation.path}\``);
          }
          if (Array.isArray(b.references) && b.references.length > 0) {
            anyHasComposite = true;
            const refPaths = b.references
              .map((r, i) => `        ${i + 1}. \`${r.path}\``)
              .join('\n');
            lines.push(`    ↳ references (${b.references.length}):`);
            lines.push(refPaths);
          }
          if (b.primary?.path && b.primary.path !== loc) {
            lines.push(`    ↳ snapshot: \`${b.primary.path}\``);
          }
        }
      }

      // Crystal-clear routing guidance when the active doc carries any
      // user-placed spatial guidance (annotations or pasted cutouts).
      // Without this block the agent keeps calling generate_image with
      // the reference paths in an unlabelled flat array and the model
      // has no idea which is base / composite / source — it just
      // averages them, which is exactly the "model invents things"
      // failure mode the user was hitting.
      if (anyHasComposite && active && (active.path || active.url)) {
        const activeLoc = active.path || active.url;
        const activeBundle = active.bundle || {};
        const activeRefs = Array.isArray(activeBundle.references)
          ? activeBundle.references.map((r) => r.path).filter(Boolean)
          : [];
        const activeOverlay = activeBundle.annotation?.path || null;
        const refList = [activeLoc, activeOverlay, ...activeRefs].filter(Boolean);
        const refJson = JSON.stringify(refList);
        const saveDir = activeLoc.replace(/\/[^/]+$/, '');
        lines.push('');
        lines.push('## ⚠ ACTIVE document is a photomontage — act, do not ask');
        lines.push('');
        lines.push('The composite IS the spec. Forbidden to ask "qué composición?" / "which composition?"; the answer is the image already attached.');
        lines.push('');
        lines.push(`1. **read_file "${activeLoc}"** first. Vision receives the base + composite in order; pasted-cutout sources ride along in the bundle but are NOT auto-attached (they flow into generate_image as refs).`);
        lines.push('2. Then dispatch the real work: `generate_image` for edits/compositions, `background_removal`, `upscale_image`, etc.');
        lines.push('3. For `generate_image` use EXACTLY this shape (base → composite → sources):');
        lines.push('');
        lines.push('```json');
        lines.push(`{ "intent": "generate_image", "prompt": "Edit the FIRST reference image. The SECOND is a composite snapshot showing EXACTLY where and at what size/angle the pasted elements land — use as PLACEMENT guide. The REMAINING refs are the high-fidelity sources. Apply: <paraphrase the user's request>.", "referenceImages": ${refJson}, "saveTo": "${saveDir}" }`);
        lines.push('```');
      }

      // When the ACTIVE doc is a video and the user asks for an edit /
      // restyle / motion change, the video itself is the subject — pass
      // its path as `referenceVideos` so the router can pick a v2v model.
      // Without this block the agent routinely calls generate_video with
      // only `prompt` set (no refs) → the router classifies it as pure
      // text-to-video and rejects any video-to-video specialist, even
      // when the user clearly meant "edit this video".
      if (active && active.type === 'video' && active.path) {
        const activeLoc = active.path;
        const saveDir = activeLoc.replace(/\/[^/]+$/, '');
        lines.push('');
        lines.push('## 🎬 ACTIVE document is a video — route edits via video-to-video');
        lines.push('');
        lines.push('The video IS the subject. "Cambia el color", "make it slow-motion", "apply cinematic grading", "remove the watermark", "extend", "restyle", "add audio", etc. → the ACTIVE video is the input.');
        lines.push('');
        lines.push(`For **any edit / restyle / transformation** of the active video, call \`generate_video\` with its path in \`referenceVideos\`. The router uses that to pick a video-to-video model; omitting it forces text-to-video routing and the call will be rejected.`);
        lines.push('');
        lines.push('```json');
        lines.push(`{ "intent": "generate_video", "prompt": "<paraphrase the user's request, describing the desired result>", "referenceVideos": ["${activeLoc}"], "saveTo": "${saveDir}" }`);
        lines.push('```');
        lines.push('');
        lines.push('Only skip `referenceVideos` if the user is asking for a brand-new clip that does NOT reference the active video (e.g. "generate a video of a sunset" while a different video is open).');
      }
      lines.push('');
      lines.push('**ACTIVE doc = default target.** Demonstratives ("this", "esto", "the image", "the pdf", …) always mean the ACTIVE document — never the project codebase. Use only paths / URLs listed above, never invent.');
      lines.push('- **Read** active doc → `read_file` with its path/URL. Images & web come back as vision; if there\'s a composite, it\'s queued right after as `[ANNOTATIONS OVERLAY]`.');
      lines.push('- **Write/edit text docs** → `edit_file` / `write_file` directly, inline — never delegate to a sub-agent for working-area edits. "continúa / sigue / añade" = append; "replace / rewrite" = replace. Never report success without a real tool call.');
      lines.push('- **Non-text active docs** (image/pdf/web) — dispatch to the right media tool (`generate_image`, `background_removal`, …); never claim to have edited in place.');
      lines.push('- **Ambiguity** between open text docs → `prompt_user` before writing.');
      lines.push('- **Caret/selection** — if `read_file` returns an `editor.summary`, that selection is the anchor for "this / aquí / change this".');
      if (active && (active.path || active.url)) {
        const activeLoc = active.path || active.url;
        const isText = active.type === 'text' || active.type === 'html';
        lines.push('');
        lines.push('Example — read the active document:');
        lines.push('```json');
        lines.push(`{ "intent": "read_file", "path": "${activeLoc}" }`);
        lines.push('```');
        if (isText) {
          lines.push('');
          lines.push('Example — write into the active text document (default target for "add/write/fill" requests):');
          lines.push('```json');
          lines.push(`{ "intent": "write_file", "path": "${activeLoc}", "content": "..." }`);
          lines.push('```');
        }
      }
      openDocumentsBlock = lines.join('\n') + '\n';
    }
  } catch { /* store not available — skip */ }

  // Expanded tool schemas: full docs for every tool the agent has
  // already requested via `get_tool_info` this session. Lives in the
  // DYNAMIC section (not static) — the static prefix must stay stable
  // across turns so the prompt cache hits; if we put this here it
  // would change every time the agent asked for a new tool and every
  // subsequent call would re-tokenise the entire prefix.
  const expandedToolsBlock = actionRegistry.generateExpandedToolsBlock(agent);

  // ── Dynamic section: runtime context, project map, language, non-interactive ──
  // Changes every turn (timestamp, task counts, phase). Placed AFTER the agent's
  // playbook so the static prefix (generic rules + agent playbook) is maximally cacheable.
  const dynamic = `${now} | ${timezone || 'unknown'}
${phaseSystemBlock}
# RUNTIME CONTEXT

| Field | Value |
|---|---|
| Working directory | \`${cwd}\` |${platformField}${langField}

All file paths (read_file, edit_file, write_file, shell) are relative to working directory unless absolute.
**LANGUAGE:** The "User language" field above is set automatically by the runtime whenever a new user message arrives — trust it. All user-facing output (print, prompt_user, questions) must be in that language. Code and technical identifiers stay in English. You do not need (and cannot) change the language yourself — it tracks the user's latest message natively.
${openDocumentsBlock}${nonInteractiveBlock}${expandedToolsBlock}
REMINDER: intent must be one of AVAILABLE ACTIONS (enum). Never invent new intents. Descriptions go in query / other fields.`;

  return { static: staticPart, dynamic, koiMd };
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
        description: mcp.description || '',
        lazy: mcp.lazy !== false,
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

  // User-defined markdown agents (.koi/agents/*.md)
  // Available to any agent with delegate permission.
  if (agent.role?.can('delegate')) {
    try {
      const userTeam = getUserAgentsTeam();
      if (userTeam?.members) {
        for (const [name, member] of Object.entries(userTeam.members)) {
          collectFrom(name, member, null);
        }
      }
    } catch { /* non-fatal */ }
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
  // Toolset mode: show toolset groups (table) + core tools inline.
  // Agents call open_toolset/get_tool_info for details on demand.
  for (const resource of resources) {
    if (resource.type === 'direct') {
      doc += actionRegistry.generateToolsetDocumentation(agent);
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

  // ── AVAILABLE MCP SERVERS ───────────────────────────────────────────────
  // Lazy by default: advertise the server name + short description + tool
  // count only. The agent calls open_mcp(name) to see the tool list and
  // get_mcp_tool_info(mcp, tool) for a specific schema. This keeps the
  // system prompt small when several MCPs are connected (each can expose
  // dozens of tools, and the full schemas add up fast).
  // Opt out per-server via `"lazy": false` in .mcp.json.
  let mcpResources = resources.filter(r => r.type === 'mcp');
  if (Array.isArray(disabledPerms) && disabledPerms.includes('call_mcp')) {
    mcpResources = [];
  }
  if (mcpResources.length > 0) {
    const lazyResources = mcpResources.filter(r => r.lazy !== false);
    const eagerResources = mcpResources.filter(r => r.lazy === false);

    if (lazyResources.length > 0) {
      doc += '## AVAILABLE MCP SERVERS\n\n';
      doc += 'Call **open_mcp("<server>")** to see the tools exposed by a server, then **get_mcp_tool_info({ mcp, tool })** for the full parameter schema of a specific tool before invoking it with call_mcp.\n\n';
      doc += '| Server | Tools | Description |\n|---|---|---|\n';
      for (const resource of lazyResources) {
        const count = resource.intents.length;
        const desc = (resource.description || '').trim() || '(no description)';
        doc += `| ${resource.name} | ${count} | ${desc.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |\n`;
      }
      doc += '\n';
    }

    if (eagerResources.length > 0) {
      doc += '## AVAILABLE MCP TOOLS\n\n';
      for (const resource of eagerResources) {
        doc += `### ${resource.name}\n`;
        if (resource.description) doc += `${resource.description}\n`;
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
    // Prefer an eager resource for the example so the sample tool name is
    // actually visible in the prompt. Fall back to a lazy server with a
    // placeholder — the agent is expected to call open_mcp first anyway.
    const eager = mcpResources.find(r => r.lazy === false);
    const ex = eager ?? mcpResources[0];
    const exTool = ex.intents[0]?.name ?? 'tool_name';
    doc += '\nTo call an MCP tool (ALWAYS use this format — NEVER use delegate for MCP tools):\n';
    doc += `{ "actionType": "direct", "intent": "call_mcp", "mcp": "${ex.name}", "tool": "${exTool}", "input": { ... } }\n`;
    if (!eager) {
      doc += 'For lazy servers, first call open_mcp("<server>") to discover tool names, then get_mcp_tool_info for the exact parameter schema.\n';
    }
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
  const { static: staticBase, dynamic, koiMd: projectSpec } = await buildSystemPrompt(agent);
  // Layout:
  //   1. BRAXIL.md / CLAUDE.md (project specification — MUST be first, always)
  //   2. Agent playbook (agent's own instructions — what matters most)
  //   3. Dynamic runtime context (timestamp, phase, task state)
  //   4. Static generic rules (output contract, golden rule, action model, tools)

  // Structured cache-aware playbook from compiler taint analysis
  if (typeof playbook === 'object' && playbook?._cacheKey !== undefined) {
    const _s = (v) => typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v));
    return {
      _cacheKey: playbook._cacheKey,
      static: [projectSpec, _s(playbook.static), staticBase].filter(Boolean).join('\n\n'),
      dynamic: [_s(playbook.dynamic), dynamic].filter(Boolean).join('\n\n'),
    };
  }

  // Legacy: plain string playbook (or flatten object without _cacheKey)
  let playbookStr = '';
  if (typeof playbook === 'string') {
    playbookStr = playbook.trim();
  } else if (typeof playbook === 'object' && playbook !== null) {
    playbookStr = typeof playbook.static === 'string' && typeof playbook.dynamic === 'string'
      ? [playbook.static, playbook.dynamic].filter(Boolean).join('\n')
      : typeof playbook.text === 'string'
        ? playbook.text
        : String(playbook);
  }
  const parts = [];
  if (projectSpec) parts.push(projectSpec); // BRAXIL.md / CLAUDE.md — always first
  if (playbookStr) parts.push(playbookStr);
  parts.push(dynamic);
  parts.push(staticBase);
  return parts.join('\n\n');
}
