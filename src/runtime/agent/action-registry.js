/**
 * Action Registry - Manages available actions for the LLM planner
 *
 * Actions are modules that define what the LLM can do in playbooks.
 * Each action has a type, description, schema, and examples.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Ensure LSP manager singleton is created on globalThis before actions load.
// LSP action files access globalThis.lspManager — without this import,
// the module is never loaded and all LSP actions silently return "LSP not available".
import '../lsp/lsp-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ActionRegistry {
  constructor() {
    this.actions = new Map(); // Map<type, actionDefinition>
    this.actionsByIntent = new Map(); // NUEVO: Map<intent, actionDefinition>
  }

  /**
   * Register an action
   */
  register(action) {
    if (!action.type || !action.description) {
      throw new Error('Action must have type and description');
    }

    // Banner middleware. If a tool declares `bannerKind` ('image' / 'video'
    // / 'audio'), wrap its execute() to emit mediaToolStart before the
    // upstream call and mediaToolEnd after, so the GUI can render an
    // asymptotic progress bar sized to the model's average latency.
    // Wrapping at registration time means each tool stays declarative —
    // it just states `bannerKind`/`bannerLabel`/`bannerIconId` and the
    // dispatch glue lives in one place.
    if (action.bannerKind && typeof action.execute === 'function' && !action.__bannerWrapped) {
      _wrapWithBanner(action);
    }

    this.actions.set(action.type, action);

    // NUEVO: indexar también por intent
    if (action.intent) {
      this.actionsByIntent.set(action.intent, action);
    }
  }

  /**
   * Get an action by type or intent
   */
  get(typeOrIntent) {
    // Intentar por intent primero (nuevo)
    const byIntent = this.actionsByIntent.get(typeOrIntent);
    if (byIntent) return byIntent;

    // Fallback a type (legacy)
    return this.actions.get(typeOrIntent);
  }

  /**
   * Get all registered actions
   */
  getAll() {
    return Array.from(this.actions.values());
  }

  /**
   * Load all actions from a directory (recursively scans subdirectories).
   */
  async loadFromDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await this.loadFromDirectory(fullPath);
      } else if (entry.name.endsWith('.js')) {
        try {
          const module = await import(`file://${fullPath}`);
          const action = module.default;

          if (action && action.type) {
            // Auto-assign toolset from parent directory name
            if (!action.toolset) {
              action.toolset = path.basename(path.dirname(fullPath));
            }
            this.register(action);
          }
        } catch (error) {
          console.warn(`[ActionRegistry] Failed to load action from ${entry.name}: ${error.message}`);
        }
      }
    }
  }

  /**
   * Generate LLM prompt documentation for actions
   * @param {Agent} agent - Agent to filter actions by permissions (null = show all actions)
   */
  generatePromptDocumentation(agent = null) {
    let actions = this.getAll();

    if (agent) {
      const disabledPerms = agent.state?.disabledPermissions;
      // Phase-scoped permission model:
      //  - `can X` in a phase → whitelist subset of the role's permissions.
      //  - `cant X` in a phase → deny list subtracted from the effective set.
      //  - Neither declared → phase inherits all role permissions.
      //  - `return` is an implicit capability every agent has (see
      //    hasPermission), and is always allowed in a phase unless explicitly
      //    denied via `cant return`.
      const _phaseName = agent.state?.statusPhase;
      const _phaseConfig = agent.phases?.[_phaseName];
      const _phaseCan = Array.isArray(_phaseConfig?.permissions)
        ? new Set(_phaseConfig.permissions)
        : null;
      const _phaseCant = Array.isArray(_phaseConfig?.deniedPermissions)
        ? new Set(_phaseConfig.deniedPermissions)
        : null;

      actions = actions.filter(action => {
        // hidden can be boolean or function(agent)
        const isHidden = typeof action.hidden === 'function' ? action.hidden(agent) : action.hidden;
        if (isHidden) return false;
        const perm = action.permission;
        if (!perm) return true;
        if (!agent.hasPermission(perm)) return false;
        // Legacy: if permission is temporarily disabled, hide the action
        if (Array.isArray(disabledPerms) && disabledPerms.includes(perm)) return false;
        // Phase deny-list takes precedence over everything else
        if (_phaseCant && _phaseCant.has(perm)) return false;
        // Whitelist mode: must be in `can` list. `return` is implicit unless
        // explicitly denied above, so it passes even without `can return`.
        if (_phaseCan && perm !== 'return' && !_phaseCan.has(perm)) return false;
        return true;
      });
    } else {
      actions = actions.filter(action => {
        const isHidden = typeof action.hidden === 'function' ? action.hidden(null) : action.hidden;
        return !isHidden;
      });
    }

    if (actions.length === 0) return '';

    // List exact valid intent names upfront so the LLM never invents one
    const validNames = actions.map(a => a.intent || a.type);
    let doc = '## AVAILABLE ACTIONS\n\n';
    doc += `Valid intent names: ${validNames.join(', ')}\n`;
    doc += 'The "intent" field MUST be one of these exact names. Never paraphrase or use free text.\n\n';
    for (const action of actions) {
      doc += this._formatActionEntry(action) + '\n';
    }
    return doc;
  }

  /**
   * Compact prompt: one line per action (name + short description + params).
   * Full details available on-demand via `get_tool_info`.
   * Saves ~7K tokens vs the full documentation.
   */
  generateCompactDocumentation(agent = null) {
    let actions = this.getAll();

    if (agent) {
      const disabledPerms = agent.state?.disabledPermissions;
      const _phaseName = agent.state?.statusPhase;
      const _phaseConfig = agent.phases?.[_phaseName];
      const _phaseCan = Array.isArray(_phaseConfig?.permissions)
        ? new Set(_phaseConfig.permissions) : null;
      const _phaseCant = Array.isArray(_phaseConfig?.deniedPermissions)
        ? new Set(_phaseConfig.deniedPermissions) : null;

      actions = actions.filter(action => {
        const isHidden = typeof action.hidden === 'function' ? action.hidden(agent) : action.hidden;
        if (isHidden) return false;
        const perm = action.permission;
        if (!perm) return true;
        if (!agent.hasPermission(perm)) return false;
        if (Array.isArray(disabledPerms) && disabledPerms.includes(perm)) return false;
        if (_phaseCant && _phaseCant.has(perm)) return false;
        if (_phaseCan && perm !== 'return' && !_phaseCan.has(perm)) return false;
        return true;
      });
    } else {
      actions = actions.filter(action => {
        const isHidden = typeof action.hidden === 'function' ? action.hidden(null) : action.hidden;
        return !isHidden;
      });
    }

    if (actions.length === 0) return '';

    const validNames = actions.map(a => a.intent || a.type);
    let doc = '## AVAILABLE ACTIONS\n\n';
    doc += `Valid intent names: ${validNames.join(', ')}\n`;
    doc += 'The "intent" field MUST be one of these exact names. Use get_tool_info for full schema.\n\n';

    for (const action of actions) {
      const intent = action.intent || action.type;
      let desc = action.description || '';
      // Truncate description to first sentence (before "Fields:", "Returns:", or ". ")
      const cutPoints = [
        desc.indexOf('Fields:'),
        desc.indexOf('Returns:'),
        desc.indexOf('→'),
        desc.indexOf('. ', 40),
      ].filter(i => i > 0);
      const cutAt = cutPoints.length > 0 ? Math.min(...cutPoints) : desc.length;
      const shortDesc = desc.substring(0, cutAt).trim().replace(/[.,]\s*$/, '');

      // Extract param names from schema
      let params = '';
      if (action.schema?.properties) {
        const keys = Object.keys(action.schema.properties);
        const required = new Set(action.schema.required || []);
        if (keys.length > 0) {
          params = keys.map(k => required.has(k) ? `"${k}"` : `"${k}"?`).join(', ');
        }
      }

      doc += `- **${intent}**: ${shortDesc}`;
      if (params) doc += ` | In: ${params}`;
      doc += '\n';
    }

    return doc;
  }

  /**
   * Toolset-level prompt: group actions by toolset, show only toolset
   * names + tool list. The agent calls open_toolset for the compact
   * list and get_tool_info for individual schemas.
   */
  generateToolsetDocumentation(agent = null) {
    const actions = this._filterActions(agent);
    if (actions.length === 0) return '';

    // Core intents shown inline (always visible, no toolset lookup needed).
    // show_result lives here because it's the canonical way to surface a
    // generated file/image/url to the user — just as fundamental as print.
    // Hiding its schema behind get_tool_info led to LLMs either skipping it
    // entirely or calling it with guessed shapes.
    const CORE_INTENTS = new Set([
      'print', 'prompt_user', 'prompt_form', 'return', 'phase_done',
      'delegate', 'open_toolset', 'get_tool_info',
      'add_memory', 'recall_memory',
      'show_result',
      // Workflow control surfaces here so the coordinator sees them as
      // first-class callable intents. The AVAILABLE WORKFLOWS section of
      // the prompt advertises both names, but hiding them behind a
      // toolset (or behind `get_tool_info`) meant the agent treated the
      // names as suggestion-only and defaulted to planner::do_plan.
      'describe_workflow', 'run_workflow',
      // Skill management surfaces here too: the AVAILABLE SKILLS section
      // of the prompt lists every skill by name + description and tells
      // the agent to call `activate_skill` / `deactivate_skill`, but
      // those intents would otherwise be hidden behind the `skills`
      // toolset and require a `get_tool_info` round-trip first. Result:
      // agents either fabricated the call shape ("get_tool_info('<skill-name>')")
      // or narrated activation in prose without ever firing the tool.
      'activate_skill', 'deactivate_skill',
      // Agenda/scheduling is core: the agent reaches for it constantly
      // ("remind me…", "every day…", "what's scheduled?") and the params are
      // simple, so surface the brief descriptions inline instead of hiding them
      // behind the `agenda` toolset + a get_tool_info round-trip.
      'agenda_add', 'agenda_list', 'agenda_update', 'agenda_remove',
      // Deciding, labelling and scoring is part of almost any job, and a decision model does it in a fraction of a
      // second for a fraction of a cent (23/11/2026): every agent sees `classify` inline, whatever its role grants.
      'classify',
    ]);

    // Mode-aware core. A truly UNATTENDED scheduled task (headless, exit-on-
    // complete, NOT a live GUI/Telegram session) has no user watching and no
    // default channel — so print/prompt_user are NOT how it communicates. The
    // explicit telegram_send/telegram_ask ARE (only when the task asks for it).
    // In an active session (GUI, or a user-initiated Telegram chat) it's the
    // opposite: print/prompt_user are core, Telegram tools are specialised.
    const _unattended = process.env.KOI_EXIT_ON_COMPLETE === '1'
      && process.env.KOI_TG_CHAT !== '1'
      && process.env.KOI_GUI_MODE !== '1';
    if (_unattended) {
      CORE_INTENTS.delete('print');
      CORE_INTENTS.delete('prompt_user');
      CORE_INTENTS.delete('prompt_form');
      CORE_INTENTS.add('telegram_send');
      CORE_INTENTS.add('telegram_ask');
    }

    // Media tools get a dedicated "always-visible with one-liner"
    // section, even though they live in the `media` toolset and still
    // require `get_tool_info` before the agent can call them. Reason:
    // when these intents only appear by name inside a toolset table,
    // the LLM systematically reaches for `write_file` + a Python
    // script (PIL, ffmpeg shell-out, etc.) when the user asks for
    // visual edits — "modify image colors", "remove background",
    // "animate this", "upscale". The dedicated AI tools win on every
    // axis (quality, speed, no temp file plumbing, no Python deps)
    // but the agent has to KNOW they exist to reach for them.
    // Surfacing the description (not just the name) here closes that
    // gap without violating the get_tool_info-first contract for
    // parameter details.
    const PROMOTED_MEDIA_INTENTS = new Set([
      'generate_image',
      'generate_video',
      'generate_audio',
      'lipsync_video',
      'background_removal',
      'upscale_image',
      'outpaint_image',
      'extract_frame',
      'image_info',
    ]);

    const coreActions = actions.filter(a => CORE_INTENTS.has(a.intent || a.type));
    const mediaActions = actions.filter(a => PROMOTED_MEDIA_INTENTS.has(a.intent || a.type));
    const toolsetActions = actions.filter(a =>
      !CORE_INTENTS.has(a.intent || a.type) && !PROMOTED_MEDIA_INTENTS.has(a.intent || a.type),
    );

    // Group non-core by toolset
    const toolsets = new Map();
    for (const action of toolsetActions) {
      const ts = action.toolset || 'other';
      if (!toolsets.has(ts)) toolsets.set(ts, []);
      toolsets.get(ts).push(action);
    }

    const tsDescriptions = {
      file: 'Read, write, edit files and search code',
      shell: 'Execute commands and manage processes',
      lsp: 'Language Server Protocol (types, definitions, references, diagnostics)',
      io: 'User interaction (show results)',
      knowledge: 'Session and plan knowledge store',
      task: 'Task management',
      queue: 'Work queue (user requests)',
      web: 'Internet access (fetch, search)',
      mcp: 'External MCP tool servers',
      media: 'Screenshots, image info, segmentation',
      session: 'Version control (diff, history, checkout)',
      agenda: 'Scheduling, reminders, watchers',
      code: 'Code analysis',
      delegation: 'Delegate to other agents',
      state: 'Agent state and control',
      llm: 'Direct LLM calls',
      browser: 'Browser automation',
      mobile: 'Mobile device interaction',
      skills: 'Skill management',
    };

    const coreNames = coreActions.map(a => a.intent || a.type);
    const toolsetNames = toolsetActions.map(a => a.intent || a.type);
    let doc = '## AVAILABLE ACTIONS\n\n';

    // Two-tier intent list — the distinction matters because toolset tools
    // accept rich parameter sets that you CANNOT guess. If we dumped every
    // intent into one "Valid intent names" line, models (especially smaller
    // ones) would recognize the name and fire away with only the obvious
    // parameter (e.g. generate_image with just "prompt", skipping size,
    // steps, model, seed, reference_image…). Splitting them into
    // "direct-safe" vs "needs-get_tool_info-first" puts the protocol
    // requirement right next to the name so the model reads them together.
    doc += `Core intents (safe to call directly): ${coreNames.join(', ')}\n`;
    if (toolsetNames.length > 0) {
      doc += `Toolset intents (**you MUST call get_tool_info(<name>) once before calling any of these** — parameters are non-obvious): ${toolsetNames.join(', ')}\n`;
    }
    doc += '\n';

    // Helper — render an action as a one-liner with its short
    // description and a parameter signature. Shared between the Core
    // and Media sections so they read consistently.
    const _renderActionLine = (action) => {
      const intent = action.intent || action.type;
      const desc = action.description || '';
      const cut = [desc.indexOf('Fields:'), desc.indexOf('Returns:'), desc.indexOf('→'), desc.indexOf('. ', 30)].filter(i => i > 0);
      const shortDesc = desc.substring(0, cut.length > 0 ? Math.min(...cut) : desc.length).trim().replace(/[.,]\s*$/, '');
      let params = '';
      if (action.schema?.properties) {
        const keys = Object.keys(action.schema.properties);
        const req = new Set(action.schema.required || []);
        if (keys.length > 0) params = keys.map(k => req.has(k) ? `"${k}"` : `"${k}"?`).join(', ');
      }
      let line = `- **${intent}**: ${shortDesc}`;
      if (params) line += ` | In: ${params}`;
      return line + '\n';
    };

    // Core tools — shown inline with params
    doc += '### Core\n';
    for (const action of coreActions) {
      doc += _renderActionLine(action);
    }

    // ── classify: its own section, WHEN and HOW (23/11/2026) ──────────────
    // As a one-liner in Core it was cut at its first sentence: the agent saw what it was but not when to reach for
    // it nor the shape of `questions`, and being "safe to call directly" it had no get_tool_info to learn it. In a
    // real run (opfh's import assistant, 37 steps deciding crop codes and name spellings) it was never called.
    if (coreActions.some(a => (a.intent || a.type) === 'classify')) {
      doc += '\n### Decide, label, score — use `classify`\n';
      doc += '**WHENEVER YOU HAVE TO DECIDE BETWEEN SEVERAL OPTIONS, OR ANSWER YES/NO, OR RATE SOMETHING ON A SCALE: CALL `classify`. Do not decide it yourself.**\n';
      doc += '**RULE**: every JUDGEMENT on a closed set of options is a `classify` call, never your own reasoning. Your instructions trigger it whenever they say things like «if there is a reasonable candidate», «if it clearly corresponds», «pick the one that fits», «decide whether», «check if», «is it…?», «how urgent / how likely / how much», «tag», «label», «categorise». The tools that FETCH data (a catalogue search, a lookup, a read) do not decide: you fetch with them, then you decide on what they returned with `classify`. `classify` is a dedicated classifier, ~0.3 s and a fraction of a cent, and gives each answer WITH its probability.\n';
      doc += 'How: put every question about the same content in ONE call; a batch of items is one call with one question per item. Act on an answer only when its probability is high (>= 0.6); below that the content is unclear: leave it for a person or look again. Question types: `choice` (one label of a closed list, add a label like "none" when none may fit; `criteria`: {label: "when it applies"}), `score` (a level on an ordered scale; `criteria`: ["lowest", ..., "highest"]), `noul` (a yes/no statement; optional `criteria`: {true: "...", false: "..."}).\n';
      doc += 'Example, deciding on what a lookup returned (a catalogue search gave candidates for «ALMENRO»): {"intent": "classify", "state": {"written": "ALMENRO", "context": "a crop name typed by a farmer"}, "questions": {"crop": {"type": "choice", "instructions": "Which catalogue entry is the written crop?", "criteria": {"3101": "Almendro (almond tree)", "3102": "Pistacho", "none": "none of them is the written crop"}}}}\n';
      doc += 'Example, several kinds at once: {"intent": "classify", "state": {"ticket": "Checkout shows a blank page"}, "questions": {"team": {"type": "choice", "instructions": "Which team owns it?", "criteria": {"payments": "Checkout and billing", "account": "Login and permissions"}}, "urgency": {"type": "score", "instructions": "How urgent?", "criteria": ["Can wait", "This week", "Blocking sales"]}, "is_bug": {"type": "noul", "instructions": "Is it broken behaviour?"}}}\n';
      doc += 'Returns: {"answers": {"crop": {"answer": "3101", "probabilities": {"3101": 0.97, ...}}, "urgency": {"answer": 2, "label": "Blocking sales", ...}, "is_bug": {"answer": true, "probability": 0.91}}}\n';
    }

    // ── Media tools (promoted from the `media` toolset) ────────────
    // Shown with their short descriptions so the agent reaches for
    // them by default on any media-editing request, instead of
    // falling back to "write a Python script with PIL/ffmpeg" — the
    // failure mode that prompted this promotion. Full parameter
    // schemas still live behind get_tool_info (these tools take
    // dozens of fields; dumping them all here would blow the prompt
    // budget). The hard rule is in the banner: use these for ANY
    // visual / audio transformation of a media file.
    if (mediaActions.length > 0) {
      doc += '\n### Media tools — ALWAYS use these for image / video / audio work\n';
      doc += '**HARD RULE**: for ANY visual/audio transformation of a media file — recolour, swap background, restyle, animate a still, trim/extend, upscale, outpaint, isolate a subject, add SFX, transcribe, generate a voice, lip-sync — call the dedicated AI tool below; NEVER a Python/shell/ffmpeg/PIL script (it bypasses the gallery/billing). The lines below say WHEN to reach for each; call `get_tool_info("<tool>")` once for the HOW (params are rich and provider-specific).\n\n';
      for (const action of mediaActions) {
        doc += _renderActionLine(action);
      }
    }

    // Toolsets — grouped table
    doc += '\n### Toolsets\n';
    doc += 'Before calling ANY tool listed below, call **get_tool_info("<tool>")** first to learn its full parameter schema. ';
    doc += 'Use **open_toolset("<toolset>")** to browse all tools in a group. ';
    doc += 'Do NOT invoke these with guessed parameters — they accept many options (size, model, seed, quality, reference files, …) that you must read from the schema.\n\n';
    doc += '| Toolset | Tools | Description |\n|---|---|---|\n';
    for (const [ts, tsActions] of toolsets) {
      const names = tsActions.map(a => a.intent || a.type).join(', ');
      const desc = tsDescriptions[ts] || ts;
      doc += `| ${ts} | ${names} | ${desc} |\n`;
    }
    doc += '\n';

    // NOTE: expanded tool schemas (from `get_tool_info`) used to live here.
    // They've been moved OUT of this static-cached output into
    // `generateExpandedToolsBlock(agent)` which is interpolated by the
    // system-prompt-builder into the DYNAMIC section of the prompt.
    // Keeping them here grew the static prefix every time the agent
    // called `get_tool_info`, busting the prompt cache on every turn.
    // See system-prompt-builder.js for where the dynamic block lands.

    return doc;
  }

  /**
   * Dynamic block: full schemas for every tool this agent has already
   * expanded via `get_tool_info`. Returns an empty string when the
   * agent hasn't expanded anything. Called by the system-prompt
   * builder to splice the schemas into the DYNAMIC part of the system
   * prompt — keeping the static/cacheable prefix stable across turns
   * even as the agent asks for more tool details mid-conversation.
   */
  generateExpandedToolsBlock(agent) {
    const map = agent?._expandedTools;
    if (!(map instanceof Map) || map.size === 0) return '';
    // Each entry's `expansionIter` is the iteration at which the doc
    // FIRST landed in the user-prompt history (set in get-tool-info).
    // We only promote it to the dynamic block AFTER that — otherwise the
    // very same iteration would carry the doc twice (once as the fresh
    // tool-result entry, once as a dynamic-block entry). Once
    // currentIter > expansionIter, the historical entry is rewritten to
    // a placeholder by ContextMemory.toMessages and the doc lives here.
    const currentIter = agent?._activeSession?.iteration ?? 0;
    const visible = new Set();
    for (const [tool, expansionIter] of map) {
      if (currentIter > expansionIter) visible.add(tool);
    }
    if (visible.size === 0) return '';
    const actions = this._filterActions(agent);
    const expandedList = actions.filter(
      (a) => visible.has(a.intent || a.type),
    );
    if (expandedList.length === 0) return '';
    let doc = '\n## Tool schemas you recently requested\n\n';
    doc += 'These are the full schemas you already asked for via `get_tool_info` — pinned here so you don\'t have to look them up again. Do NOT call `get_tool_info` again for any of these.\n\n';
    for (const action of expandedList) {
      doc += this._formatActionEntry(action) + '\n';
    }
    return doc;
  }

  /**
   * Get compact documentation for all tools in a toolset.
   */
  getToolsetDocumentation(toolsetName, agent = null) {
    const actions = this._filterActions(agent)
      .filter(a => (a.toolset || 'other') === toolsetName);
    if (actions.length === 0) return null;

    let doc = `## Toolset: ${toolsetName}\n\n`;
    for (const action of actions) {
      const intent = action.intent || action.type;
      let desc = action.description || '';
      const cutPoints = [
        desc.indexOf('Fields:'),
        desc.indexOf('Returns:'),
        desc.indexOf('→'),
        desc.indexOf('. ', 40),
      ].filter(i => i > 0);
      const cutAt = cutPoints.length > 0 ? Math.min(...cutPoints) : desc.length;
      const shortDesc = desc.substring(0, cutAt).trim().replace(/[.,]\s*$/, '');
      let params = '';
      if (action.schema?.properties) {
        const keys = Object.keys(action.schema.properties);
        const required = new Set(action.schema.required || []);
        if (keys.length > 0) {
          params = keys.map(k => required.has(k) ? `"${k}"` : `"${k}"?`).join(', ');
        }
      }
      doc += `- **${intent}**: ${shortDesc}`;
      if (params) doc += ` | In: ${params}`;
      doc += '\n';
    }
    return doc;
  }

  /** Internal: filter actions by agent permissions/phase. */
  _filterActions(agent) {
    let actions = this.getAll();
    if (agent) {
      const disabledPerms = agent.state?.disabledPermissions;
      const _phaseName = agent.state?.statusPhase;
      const _phaseConfig = agent.phases?.[_phaseName];
      const _phaseCan = Array.isArray(_phaseConfig?.permissions)
        ? new Set(_phaseConfig.permissions) : null;
      const _phaseCant = Array.isArray(_phaseConfig?.deniedPermissions)
        ? new Set(_phaseConfig.deniedPermissions) : null;
      actions = actions.filter(action => {
        const isHidden = typeof action.hidden === 'function' ? action.hidden(agent) : action.hidden;
        if (isHidden) return false;
        const perm = action.permission;
        if (!perm) return true;
        if (!agent.hasPermission(perm)) return false;
        if (Array.isArray(disabledPerms) && disabledPerms.includes(perm)) return false;
        if (_phaseCant && _phaseCant.has(perm)) return false;
        if (_phaseCan && perm !== 'return' && !_phaseCan.has(perm)) return false;
        return true;
      });
    } else {
      actions = actions.filter(action => {
        const isHidden = typeof action.hidden === 'function' ? action.hidden(null) : action.hidden;
        return !isHidden;
      });
    }
    return actions;
  }

  /**
   * Get full documentation for a single action (for get_tool_info).
   */
  getActionDocumentation(intentName) {
    const action = this.get(intentName);
    if (!action) return null;
    return this._formatActionEntry(action);
  }

  /**
   * Format a single action as a ### section.
   * Parses the description string to extract main text, In: (fields) and Out: (returns).
   */
  _formatActionEntry(action) {
    const intent = action.intent || action.type;
    let desc = action.description || '';

    // Extract "Returns: ..." (with optional "→ " prefix) from the end of description
    let outText = null;
    const returnsMatch = desc.match(/(?:→\s*)?Returns?:\s*(.+)$/s);
    if (returnsMatch) {
      outText = returnsMatch[1].trim().replace(/\s+/g, ' ');
      desc = desc.substring(0, returnsMatch.index).trim().replace(/[.,]\s*$/, '');
    }

    // Extract "Fields: ..." or "Requires: ..." block
    let inText = null;
    const fieldsMatch = desc.match(/\b(?:Fields?|Requires?):\s*(.+?)(?:\.\s*(?=[A-Z])|$)/s);
    if (fieldsMatch) {
      inText = fieldsMatch[1].trim().replace(/\.\s*$/, '');
      desc = desc.substring(0, fieldsMatch.index).trim().replace(/[.,]\s*$/, '');
    } else if (action.schema?.properties) {
      const keys = Object.keys(action.schema.properties);
      if (keys.length > 0) inText = keys.map(k => `"${k}"`).join(', ');
    }

    let out = `### ${intent}\n${desc}\n`;
    if (inText)  out += `In: ${inText}\n`;
    if (outText) out += `Out: ${outText}\n`;
    if (action.instructions) out += `\n${action.instructions}\n`;
    return out;
  }

  /**
   * Generate detailed examples for LLM prompt
   */
  generateExamples() {
    const actions = this.getAll();
    const actionsWithExamples = actions.filter(a => a.examples && a.examples.length > 0);

    if (actionsWithExamples.length === 0) {
      return '';
    }

    let examples = '\nAction Examples:\n';

    actionsWithExamples.forEach(action => {
      if (action.examples && action.examples.length > 0) {
        examples += `\n${action.type}:\n`;
        action.examples.forEach(example => {
          examples += `  ${JSON.stringify(example)}\n`;
        });
      }
    });

    return examples;
  }

  /**
   * Clear all registered actions
   */
  clear() {
    this.actions.clear();
  }
}

// ── Banner middleware (slow media generators) ─────────────────────────
// Wraps `action.execute` to emit mediaToolStart / mediaToolEnd around the
// upstream call. The expected duration comes from the gateway catalog —
// average of the last 20 successful samples for that slug, falling back
// to the kind-wide median, then to a 120 s constant. Channel + capabilities
// imports are dynamic to keep this module's startup cycle clean (the
// registry loads before the LLM provider stack initialises).
const _DEFAULT_EXPECTED_MS = 120_000;
const _MEDIA_BANNER_INTENTS = new Set();
let _channelPromise = null;
function _getChannel() {
  if (!_channelPromise) _channelPromise = import('../io/channel.js').then((m) => m.channel);
  return _channelPromise;
}
let _capsModulePromise = null;
function _getCapsModule() {
  if (!_capsModulePromise) _capsModulePromise = import('../llm/providers/gateway.js');
  return _capsModulePromise;
}

async function _resolveExpectedDurationMs(kind, slug) {
  try {
    const mod = await _getCapsModule();
    const caps = await mod.fetchMediaCapabilities(kind);
    if (!caps?.models) return _DEFAULT_EXPECTED_MS;
    if (slug && slug !== 'auto') {
      const row = caps.models.find((m) => m.slug === slug);
      if (row && Number.isFinite(row.avgLatencyMs) && row.avgLatencyMs > 0) {
        return row.avgLatencyMs;
      }
    }
    // Kind-wide median across slugs that have at least one sample.
    const samples = caps.models
      .map((m) => m.avgLatencyMs)
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    if (samples.length === 0) return _DEFAULT_EXPECTED_MS;
    return samples[Math.floor(samples.length / 2)];
  } catch {
    return _DEFAULT_EXPECTED_MS;
  }
}

function _wrapWithBanner(action) {
  const _orig = action.execute;
  _MEDIA_BANNER_INTENTS.add(action.intent || action.type);
  action.execute = async function _bannerWrapped(act, agent) {
    // Suppress the banner when another media tool is delegating to us
    // (e.g. outpaint_image → generate_image). The outer tool already
    // showed its own banner, and a nested second banner reads as two
    // independent operations to the user. The caller signals this by
    // setting `_suppressBanner: true` on the action params.
    if (act && act._suppressBanner) {
      return await _orig.call(this, act, agent);
    }
    // ── Cost consent BEFORE anything happens ────────────────────────────
    // The user MUST consent before we show the "Generating…" banner OR send
    // any request to the server. This runs here — ahead of mediaToolStart and
    // the wrapped execute() — so a pending confirmation never sits behind a
    // banner that looks like generation already started. Declining returns a
    // clean denied result without ever touching the gateway.
    //
    // BUT only ask on a call that will ACTUALLY generate. Every media tool's
    // FIRST blind call returns its documentation instead of running
    // (requireToolInfoFirst); get_tool_info populates the same `_expandedTools`
    // map, so a tool present there means the upcoming execute() will really
    // dispatch. Prompting on the doc-return call would ask consent for a
    // generation that isn't happening yet. Fail-open on plumbing errors.
    const _toolName = action.intent || action.type;
    // Media facade: if a connected MCP (e.g. Magnific) is handling this kind,
    // it bills the user's OWN provider account — not Koi credits. So skip the
    // cost/consent gate entirely (decision 3) by marking the action, and grab
    // the provider label to show on the banner ("vía Magnific"). The same
    // resolver decides routing in factory.js, so banner ↔ routing never diverge.
    let _mcpProviderLabel = null;
    try {
      // Auto-map: the first media generation after switching to a media MCP
      // triggers an LLM to read the server's tools and build the `media` map
      // (cached, hash-stamped). One call per toolset version. No profiles.
      const { ensureMediaMapsForKind } = await import('../llm/providers/mcp-media-mapper.js');
      await ensureMediaMapsForKind(action.bannerKind, agent);
      const { activeFor } = await import('../llm/providers/mcp-media-resolver.js');
      const _mcp = activeFor(action.bannerKind);
      if (_mcp) {
        _mcpProviderLabel = _mcp.label;
        if (act && typeof act === 'object') act.confirmCost = false; // no Koi credits → no cost card
      }
    } catch { /* resolver optional — fall through to normal backend behaviour */ }
    // Some calls BYPASS the schema-first guard and generate on their FIRST
    // call — notably generate_image with numeric `cameraAngles` (the orbital
    // / camera-angle one-shot, see generate-image.js: the guard is skipped so
    // the LLM doesn't mangle the angles on a forced re-issue). Those never
    // populate `_expandedTools`, so keying cost consent off that map alone let
    // camera-angle generations spend credits WITHOUT asking. Detect the same
    // bypass here so they still hit preflightMediaCost. Mirrors the
    // `_hasCameraAngles` test in generate-image.js — keep the two in sync.
    const _ca = act && act.cameraAngles;
    const _bypassesGuard = !!(_ca && typeof _ca === 'object'
      && (typeof _ca.horizontal === 'number'
        || typeof _ca.vertical === 'number'
        || typeof _ca.zoom === 'number'));
    const _willGenerate = _bypassesGuard || (agent
      && agent._expandedTools instanceof Map
      && agent._expandedTools.has(_toolName));
    if (_willGenerate) {
      try {
        const { preflightMediaCost } = await import('../tools/media/cost-permission.js');
        const _ok = await preflightMediaCost(action.bannerKind, act, agent);
        if (!_ok) {
          return { success: false, denied: true, message: 'User declined the media generation cost.' };
        }
      } catch { /* never block generation on confirmation plumbing */ }
    }
    const id = `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const slug = act?.model || null;
    const expectedDurationMs = await _resolveExpectedDurationMs(action.bannerKind, slug);
    const channel = await _getChannel();
    channel.mediaToolStart({
      id,
      intent: action.intent || action.type,
      kind: action.bannerKind,
      label: action.bannerLabel || action.intent || action.type,
      iconId: action.bannerIconId || action.intent || action.type,
      expectedDurationMs,
      // Non-null when an MCP media provider is handling this (e.g. "Magnific").
      // The GUI shows it under the banner so the user knows whose quota is used.
      provider: _mcpProviderLabel,
      input: act,
    });
    // Make the banner id + a fal-status emitter available to the wrapped
    // tool so its polling loop can pipe IN_QUEUE / IN_PROGRESS through to
    // the GUI without re-resolving the channel. Tools that don't poll just
    // ignore these — the wrapper still closes the banner via mediaToolEnd.
    if (act && typeof act === 'object') {
      act._mediaBannerId = id;
      act._emitMediaStatus = (info) => {
        try {
          channel.mediaToolStatus({
            id,
            falStatus: info?.falStatus,
            queuePosition: info?.queuePosition,
          });
        } catch { /* observability is best-effort */ }
      };
    }
    let ok = false;
    let cancelled = false;
    let deferredJobId = null;
    try {
      const result = await _orig.call(this, act, agent);
      // `_guardedAutoExpand: true` means the tool's `requireToolInfoFirst`
      // guard fired and returned the documentation INSTEAD of actually
      // generating media. The banner was started a few ms ago because
      // the wrapper sees every call the same way — and without this
      // branch it would close as a "✓ completed at 0s" bubble, which
      // the user reported verbatim: a phantom success banner appearing
      // alongside the real one when generation runs on the retry call.
      // We flag it as cancelled so the GUI can REMOVE the banner
      // entirely instead of showing a misleading completion.
      //
      // `validationError: true` is the same idea for a different reason: a
      // pre-flight lint guard (e.g. generate_video's "prompt cites Image 2
      // but only 1 reference attached", hallucinated @-handles, too many
      // shots) refused the call BEFORE submitting to the provider — nothing
      // was generated and nothing was charged, and the agent silently
      // re-issues a corrected call. Routing it through `cancelled` removes
      // the banner (no red error flashing mid-correction) AND skips the
      // credit refresh below (there was no charge to reconcile). Real
      // provider failures and timeouts do NOT set this flag, so they still
      // close the banner red as before.
      cancelled = !!(result && (result._guardedAutoExpand === true || result.validationError === true));

      // Async kickoff: when an async-capable tool is invoked with
      // `wait: false` it returns immediately with `{ success: true,
      // jobId }` while the real work runs in the background. The
      // result envelope carries NO terminal artifact (no savedTo, no
      // url, no path). Without this branch the wrapper would close the
      // banner here with ok=true, painting a "Video generated ✓" badge
      // on a clip that hasn't been rendered yet — the user reported
      // this verbatim: 8 video cards marked done while the underlying
      // seedance jobs were still in `pending`/`processing`. Detect
      // this shape and defer banner closure to the job's terminal
      // transition instead.
      const isAsyncKickoff = !cancelled
        && result
        && result.success !== false
        && typeof result.jobId === 'string'
        && !result.savedTo
        && !result.url
        && !result.path;
      if (isAsyncKickoff) {
        deferredJobId = result.jobId;
      } else {
        ok = !cancelled && !!(result && result.success !== false);
      }
      return result;
    } finally {
      if (deferredJobId) {
        try {
          const { attachBannerToJob } = await import('../state/jobs.js');
          attachBannerToJob(deferredJobId, ({ status }) => {
            try {
              channel.mediaToolEnd({
                id,
                ok: status === 'succeeded',
                cancelled: status === 'cancelled',
              });
            } catch { /* observability is best-effort */ }
          });
        } catch (err) {
          // Fallback so a missing jobs registry doesn't strand the
          // banner open forever. Mark as failed — a stuck spinner is
          // worse than a clear "failed" badge.
          try { channel.mediaToolEnd({ id, ok: false, cancelled: false }); } catch { /* */ }
          try { channel.log?.('banner', `attachBannerToJob failed for ${deferredJobId}: ${err.message}`); } catch { /* */ }
        }
      } else {
        channel.mediaToolEnd({ id, ok, cancelled });
      }
    }
  };
  action.__bannerWrapped = true;
}

// Global singleton instance
export const actionRegistry = new ActionRegistry();

// Auto-load tools from the tools directory on module load
const toolsDir = path.join(__dirname, '..', 'tools');
if (fs.existsSync(toolsDir)) {
  await actionRegistry.loadFromDirectory(toolsDir).catch(err => {
    console.warn('[ActionRegistry] Failed to auto-load tools:', err.message);
  });
}
