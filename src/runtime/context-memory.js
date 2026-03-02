/**
 * ContextMemory — Brain-inspired tiered memory for agent conversations.
 *
 * Memory tiers:
 *   SHORT-TERM  → full detail, lasts ~6 turns (working memory)
 *   MEDIUM-TERM → condensed summary, lasts ~20 turns (episodic)
 *   LONG-TERM   → permanent facts, never expires (semantic)
 *   LATENT      → embedded, out of context, recoverable by similarity (dormant)
 *
 * Lifecycle:
 *   Born → short-term → medium-term → { permanent? long-term : latent }
 *   Latent memories can be hydrated back into context when relevant.
 */

import { cliLogger } from './cli-logger.js';
import { taskManager } from './task-manager.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  return (magA && magB) ? dot / (magA * magB) : 0;
}

// ─── Classification ───────────────────────────────────────────────────────

/**
 * Classify a feedback message (user role) based on the action that just executed.
 * Returns { immediate, shortTerm, permanent }.
 */
export function classifyFeedback(action, result, error) {
  const intent = action.intent || action.type || 'unknown';
  const id = action.id ? ` [${action.id}]` : '';

  // Parallel group synthetic record — show all results to the LLM at once
  if (intent === '_parallel_done' && result?._parallelResults) {
    const immediate = `Parallel actions completed:\n${result._parallelResults}`;
    return {
      immediate,
      shortTerm: 'Parallel group done.',
      permanent: null,
      imageBlocks: result._parallelImageBlocks ?? null,
    };
  }

  // Error path
  if (error) {
    const errMsg = error.message || String(error);
    const immediate = `❌${id} ${intent} failed: ${errMsg}`;
    return { immediate, shortTerm: immediate, permanent: null };
  }

  // Build full-detail immediate string — no truncation here.
  // The tiered memory system (short→medium→latent) handles context size over time.
  // Actions with inherently large output (shell, search, grep) truncate in their own case blocks.
  let resultStr = result ? JSON.stringify(result) : 'ok';

  // User denied the action (file edit/write rejected, shell denied, etc.)
  // This is NOT an error — it's a deliberate user decision. Do NOT retry or re-ask.
  if (result && result.denied) {
    const feedback = result.feedback ? ` Feedback: ${result.feedback}` : '';
    const immediate = `🚫${id} ${intent} DENIED by user.${feedback} Do NOT retry this action or ask again — the user said No. Move on.`;
    const shortTerm = `🚫 ${intent}: denied by user`;
    return { immediate, shortTerm, permanent: null };
  }

  // Handle error-like results (success: false)
  if (result && result.success === false && result.error) {
    // Include stdout if present — many CLI tools (flutter analyze, tsc, etc.) write
    // their useful output to stdout even when exiting with a non-zero code.
    const stdoutPart = result.stdout ? `\nOutput:\n${result.stdout.substring(0, 3000)}` : '';
    const immediate = `❌${id} ${intent}: ${result.error}${stdoutPart}${result.fix ? '\nFIX: ' + result.fix : ''}`;
    return { immediate, shortTerm: `❌ ${intent}: ${result.error}`, permanent: null };
  }

  // Extract image blocks generically from any action that returns MCP-style content
  let _imageBlocks = null;
  if (!error && result?.content && Array.isArray(result.content)) {
    const imgs = result.content.filter(c => c.type === 'image' && c.data);
    if (imgs.length > 0) _imageBlocks = imgs.map(c => ({ mimeType: c.mimeType || 'image/png', data: c.data }));
  }

  const immediate = `✅${id} ${intent} -> ${resultStr}`;

  switch (intent) {
    case 'prompt_user': {
      const answer = result?.answer || '';
      const perm = `User: "${answer}"`;
      // Explicit signal: new user input arrived — focus on THIS, not previous results
      const newImmediate = `✅${id} prompt_user: User says: "${answer}"\n\nNEW USER INPUT. Answer only this new question. Do not re-print results from previous commands.`;
      return { immediate: newImmediate, shortTerm: perm, permanent: perm };
    }

    case 'read_file': {
      const content = result?.content || '';
      const totalLines = result?.totalLines || content.split?.('\n')?.length || 0;
      const from = result?.from || 1;
      const to = result?.to || totalLines;
      const MAX_READ_CHARS = 6000;
      const truncContent = content.length > MAX_READ_CHARS
        ? content.substring(0, MAX_READ_CHARS) + `\n...[truncated at char ${MAX_READ_CHARS} — showing lines ${from}–${to} of ${totalLines} total. Use offset/limit to read more.]`
        : content;
      const truncImmediate = `✅${id} read_file ${action.path} (lines ${from}–${to} of ${totalLines}):\n${truncContent}`;
      // Medium-term: include a useful content preview (first ~800 chars) so the agent
      // does not lose the file's substance when the entry ages out of short-term.
      // Without this, the agent only sees "✅ read schema.ts" and re-reads it.
      const contentPreview = content.substring(0, 800) + (content.length > 800 ? '\n...[see full read in history]' : '');
      const shortTermRead = `✅ read ${action.path} (lines ${from}–${to} of ${totalLines}):\n${contentPreview}`;
      return { immediate: truncImmediate, shortTerm: shortTermRead, permanent: null };
    }

    case 'edit_file':
      return { immediate, shortTerm: `✅ edit ${action.path}`, permanent: null };

    case 'write_file':
      return { immediate, shortTerm: `✅ write ${action.path}`, permanent: null };

    case 'search': {
      const query = action.query || action.pattern || action.path || '';
      const hits = result?.matches?.length || result?.results?.length || 0;
      return { immediate, shortTerm: `✅ search "${query.substring(0, 40)}" (${hits} hits)`, permanent: null };
    }

    case 'shell': {
      const shellOut = result?.stdout || result?.output || result?.content || '';
      const truncOut = shellOut.length > 3000 ? shellOut.substring(0, 3000) + '...[truncated]' : shellOut;
      const shellMsg = truncOut
        ? `✅${id} shell output:\n${truncOut}`
        : `✅${id} shell: ${action.description || 'command'} (no output)`;
      return { immediate: shellMsg, shortTerm: `✅ shell: ${action.description || 'command'}`, permanent: null };
    }

    case 'print':
      return { immediate, shortTerm: `✅ print`, permanent: null };

    case 'call_llm':
      return { immediate, shortTerm: `✅ call_llm`, permanent: null };

    case 'registry_set':
      return { immediate, shortTerm: `✅ registry_set "${action.key}"`, permanent: null };

    case 'registry_get':
      return { immediate, shortTerm: `✅ registry_get "${action.key}"`, permanent: null };

    case 'registry_delete':
      return { immediate, shortTerm: `✅ registry_delete "${action.key}"`, permanent: null };

    case 'registry_search':
      return { immediate, shortTerm: `✅ registry_search`, permanent: null };

    case 'call_mcp': {
      const mcpText = _imageBlocks
        ? `✅${id} call_mcp ${action.tool} -> [${_imageBlocks.length} image(s) — see attached]`
        : immediate;
      return {
        immediate: mcpText,
        shortTerm: `✅ call_mcp ${action.tool || ''}`,
        permanent: null,
        imageBlocks: _imageBlocks,
      };
    }

    case 'screenshot': {
      const imgId = result?.imageId || '?';
      const src = result?.source || '?';
      const desc = action.description || '';
      return {
        immediate: _imageBlocks
          ? `📷${id} screenshot ${imgId} (${src}) — [image attached]${desc ? ': ' + desc : ''}`
          : immediate,
        shortTerm: `📷 ${imgId}: ${desc || src}`,
        permanent: null,
        imageBlocks: _imageBlocks,
      };
    }

    case 'recall_image': {
      const imgId = result?.imageId || '?';
      return {
        immediate: _imageBlocks
          ? `🔍${id} recall_image ${imgId} — [image attached]`
          : immediate,
        shortTerm: `🔍 recalled ${imgId}`,
        permanent: null,
        imageBlocks: _imageBlocks,
      };
    }

    case 'mobile_observe': {
      const mobSrc = result?.platform || '?';
      const elCount = result?.elementCount || '?';
      // Extract element text from content array (content[1] is the text summary)
      const _obsTxt = result?.content?.find(c => c.type === 'text')?.text || '';
      return {
        immediate: _imageBlocks
          ? `📱${id} mobile_observe (${mobSrc}) — ${elCount} elements [image attached]\n${_obsTxt}`
          : immediate,
        shortTerm: `📱 observe: ${elCount} elements (${mobSrc})`,
        permanent: null,
        imageBlocks: _imageBlocks,
      };
    }

    case 'mobile_elements': {
      const elSrc = result?.platform || '?';
      const elCnt = result?.elementCount || '?';
      // CRITICAL: include the actual element list so the LLM can see element names
      const _elTxt = result?.content?.find(c => c.type === 'text')?.text || '';
      return {
        immediate: `📱${id} mobile_elements (${elSrc}) — ${elCnt} elements\n${_elTxt}`,
        shortTerm: `📱 elements: ${elCnt} (${elSrc})`,
        permanent: null,
      };
    }

    case 'mobile_tap':
    case 'mobile_type':
    case 'mobile_swipe':
    case 'mobile_key': {
      let _mobShort;
      if (intent === 'mobile_tap') _mobShort = `📱 tap: ${action.element || action.cell || `(${action.x},${action.y})`}`;
      else if (intent === 'mobile_type') _mobShort = `📱 type: "${(action.text || '').substring(0, 30)}"`;
      else if (intent === 'mobile_swipe') _mobShort = `📱 swipe: ${action.direction || 'custom'}`;
      else _mobShort = `📱 key: ${action.key}`;
      return { immediate, shortTerm: _mobShort, permanent: null };
    }

    case 'task_list': {
      // Preserve task subjects+descriptions in memory so they survive context compression.
      // Without this, after a few shell commands the agent loses the task details and asks the user.
      const allTasks = result?.tasks || [];
      const pending = allTasks.filter(t => t.status !== 'completed');
      if (pending.length === 0) {
        return { immediate, shortTerm: '✅ task_list (all done)', permanent: null };
      }
      const taskLines = pending.map(t => {
        const icon = t.status === 'in_progress' ? '●' : '☐';
        const desc = t.description ? ` — ${t.description}` : '';
        return `  [${t.id}] ${icon} ${t.subject}${desc}`;
      }).join('\n');
      const shortTerm = `Pending tasks:\n${taskLines}`;
      // Do NOT use permanent here: making this long-term freezes stale task state
      // forever, causing the agent to loop re-reading files because it always sees
      // "all tasks pending" even after task_update marks them complete.
      return { immediate, shortTerm, permanent: null };
    }

    case 'task_get': {
      // Preserve the full task description in short-term memory
      const task = result?.task || result;
      if (task?.subject) {
        const desc = task.description ? ` — ${task.description}` : '';
        const shortTerm = `Task [${task.id}] (${task.status}): ${task.subject}${desc}`;
        return { immediate, shortTerm, permanent: null };
      }
      return { immediate, shortTerm: `✅ task_get`, permanent: null };
    }

    case 'task_update':
      return { immediate, shortTerm: `✅ task_update [${action.taskId}] → ${action.status || 'updated'}`, permanent: null };

    case 'task_create': {
      const subject = result?.subject || action.subject || '';
      return { immediate, shortTerm: `✅ task_create: ${subject}`, permanent: null };
    }

    default: {
      // Delegate action: surface the result clearly so the parent agent can answer the user
      if (action.actionType === 'delegate') {
        const delegateResult = result?.output ?? result?.summary ?? result?.result ?? result;
        const delegateStr = typeof delegateResult === 'string'
          ? delegateResult
          : JSON.stringify(delegateResult);
        // After a delegate returns, remind the LLM of ALL unfinished tasks.
        // Check BOTH in_progress (need to be marked completed) AND pending (need to be started).
        let taskReminder = '';
        try {
          const allTasks = taskManager.list();
          const inProgress = allTasks.filter(t => t.status === 'in_progress');
          const pending    = allTasks.filter(t => t.status === 'pending');

          if (inProgress.length > 0) {
            const list = inProgress.map(t => `[${t.id}] "${t.subject}"`).join(', ');
            taskReminder += `\n\nMANDATORY NEXT STEP 1: Mark in_progress task(s) as completed NOW: ${list}. Call task_update with status='completed' immediately.`;
          }
          if (pending.length > 0) {
            const list = pending.map(t => `[${t.id}] "${t.subject}"`).join(', ');
            taskReminder += `\n\nMANDATORY NEXT STEP 2: There are still PENDING tasks that have NOT been executed yet: ${list}. You MUST continue — do NOT call prompt_user or return until every task is completed.`;
          }
          if (inProgress.length === 0 && pending.length === 0 && allTasks.length > 0) {
            taskReminder += `\n\nAll tasks completed. You may now print a summary and call prompt_user.`;
          }
        } catch { /* non-fatal */ }

        const msg = `✅${id} delegate ${intent} returned:\n${delegateStr}${taskReminder}`;
        return { immediate: msg, shortTerm: `✅ delegate ${intent} → answer ready`, permanent: null };
      }
      return { immediate, shortTerm: `✅ ${intent}`, permanent: null };
    }
  }
}

/**
 * Classify an assistant response based on the parsed action.
 * Returns { immediate, shortTerm, permanent }.
 */
export function classifyResponse(responseText, action) {
  if (!action) {
    return { immediate: responseText, shortTerm: '→ ?', permanent: null };
  }

  // Handle batched actions
  if (Array.isArray(action)) {
    const intents = action.map(a => a.intent || a.type || '?').join(', ');
    return { immediate: responseText, shortTerm: `→ [${intents}]`, permanent: null };
  }

  const intent = action.intent || action.type || 'unknown';
  let permanent = null;
  let shortTerm = `→ ${intent}`;

  switch (intent) {
    case 'print': {
      const msg = action.message || '';
      permanent = `Told user: "${msg.substring(0, 120)}"`;
      shortTerm = `→ print "${msg.substring(0, 60)}"`;
      break;
    }
    case 'prompt_user': {
      const q = action.question || action.prompt || '';
      shortTerm = `→ prompt "${q.substring(0, 60)}"`;
      break;
    }
    case 'edit_file':
      shortTerm = `→ edit ${action.path || ''}`;
      break;
    case 'read_file':
      shortTerm = `→ read ${action.path || ''}`;
      break;
    case 'write_file':
      shortTerm = `→ write ${action.path || ''}`;
      break;
    case 'search':
      shortTerm = `→ search`;
      break;
    case 'shell':
      shortTerm = `→ shell: ${(action.description || '').substring(0, 40)}`;
      break;
    case 'return':
      shortTerm = `→ return`;
      break;
    case 'call_llm':
      shortTerm = `→ call_llm`;
      break;
    case 'call_mcp':
      shortTerm = `→ call_mcp ${action.tool || ''}`;
      break;
    default:
      if (action.actionType === 'delegate') {
        shortTerm = `→ delegate ${intent}`;
      }
  }

  return { immediate: responseText, shortTerm, permanent };
}

// ─── ContextMemory ─────────────────────────────────────────────────────────

export class ContextMemory {
  constructor({ agentName, llmProvider, shortTermTTL, mediumTermTTL } = {}) {
    this.agentName = agentName || 'unknown';
    this.llmProvider = llmProvider;
    this.entries = [];
    this.latentPool = [];
    this.turnCounter = 0;
    this.systemPrompt = null;

    // TTLs (in turns — a turn is one user+assistant exchange)
    // Delegates do focused multi-step tasks (read files, then implement).
    // Use longer TTLs for delegates so file contents don't evaporate mid-task.
    this.shortTermTTL = shortTermTTL ?? 6;
    this.mediumTermTTL = mediumTermTTL ?? 20;

    // Hydration config
    this.latentThreshold = 0.35;
    this.maxLatent = 100;
    this.maxHydrate = 3;
  }

  /**
   * Clear all conversation history and reset state.
   */
  clear() {
    this.entries = [];
    this.latentPool = [];
    this.turnCounter = 0;
  }

  /**
   * Set the system prompt (separate from entries, always present).
   */
  setSystem(prompt) {
    this.systemPrompt = prompt;
  }

  /**
   * Add a conversation entry with tiered representations.
   * @param {'user'|'assistant'} role
   * @param {string} immediate  - Full detail (short-term representation)
   * @param {string|null} shortTerm  - Condensed (medium-term representation)
   * @param {string|null} permanent  - Irreplaceable (long-term representation, null = forgettable)
   */
  add(role, immediate, shortTerm = null, permanent = null, opts = {}) {
    const entry = {
      role,
      immediate,
      shortTerm: shortTerm || immediate,
      permanent,
      turnAdded: this.turnCounter,
      tier: 'short-term'
    };
    if (opts.ephemeral) entry.ephemeral = true;
    this.entries.push(entry);
  }

  /**
   * Advance the clock by one turn.
   * Ages entries: short→medium→long-term or latent.
   * Call once per reactive loop iteration.
   */
  async tick() {
    this.turnCounter++;
    const toLatent = [];

    for (const entry of this.entries) {
      if (entry.tier === 'long-term') continue;

      const age = this.turnCounter - entry.turnAdded;

      if (entry.tier === 'medium-term' && age > this.mediumTermTTL) {
        // Consolidation rule (C): promote or fade
        if (entry.permanent) {
          entry.tier = 'long-term';
          cliLogger.log('memory', `↑ long-term: "${entry.permanent.substring(0, 60)}"`);
        } else {
          toLatent.push(entry);
          entry.tier = 'expired';
        }
      } else if (entry.tier === 'short-term' && age > this.shortTermTTL) {
        entry.tier = 'medium-term';
      }
    }

    // Move expired entries to latent pool (async: needs embeddings)
    for (const entry of toLatent) {
      await this._moveToLatent(entry);
    }

    // Remove expired entries from active context
    this.entries = this.entries.filter(e => e.tier !== 'expired');
  }

  /**
   * Search latent pool by semantic similarity and inject relevant memories.
   * Call after prompt_user or when past context might help.
   * @param {string} query - Text to match against (e.g. user's answer)
   */
  async hydrate(query) {
    if (this.latentPool.length === 0 || !this.llmProvider) return;

    try {
      const queryEmbedding = await this.llmProvider.getEmbedding(query);
      if (!queryEmbedding) return;

      const matches = this.latentPool
        .map(m => ({ ...m, score: cosineSimilarity(queryEmbedding, m.embedding) }))
        .filter(m => m.score >= this.latentThreshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, this.maxHydrate);

      if (matches.length === 0) return;

      cliLogger.log('memory', `Hydrated ${matches.length} latent memories`);
      for (const m of matches) {
        cliLogger.log('memory', `  score=${m.score.toFixed(3)} "${m.summary.substring(0, 60)}"`);
      }

      const recallText = matches.map(m => `- ${m.summary}`).join('\n');
      // Inject as volatile short-term entry (will age and fade normally)
      this.add('user', `RECALLED:\n${recallText}`, null, null);
    } catch (err) {
      cliLogger.log('memory', `Hydration failed: ${err.message}`);
    }
  }

  /**
   * Serialize entries to messages for the LLM API.
   * Each entry uses its tier-appropriate representation:
   *   long-term  → permanent text (condensed, essential)
   *   medium-term → shortTerm text (summary)
   *   short-term → immediate text (full detail)
   */
  toMessages() {
    const messages = [];

    // System prompt (always first)
    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }

    // Entries in chronological order, representation based on tier
    for (const entry of this.entries) {
      let content;
      switch (entry.tier) {
        case 'long-term':
          content = entry.permanent;
          break;
        case 'medium-term':
          content = entry.shortTerm;
          break;
        case 'short-term':
          content = entry.immediate;
          break;
      }
      if (content) {
        messages.push({ role: entry.role, content });
      }
    }

    // Merge consecutive same-role messages (can happen after expiration gaps)
    return this._mergeConsecutive(messages);
  }

  /**
   * Check if there are any user/assistant entries.
   */
  hasHistory() {
    return this.entries.some(e => e.role === 'user' || e.role === 'assistant');
  }

  /**
   * Get the count of active entries.
   */
  get length() {
    return this.entries.length;
  }

  /**
   * Serialize full state for persistence (session tracker).
   */
  serialize() {
    return {
      version: 1,
      systemPrompt: this.systemPrompt,
      entries: this.entries.filter(e => !e.ephemeral).map(e => ({
        role: e.role,
        immediate: e.immediate,
        shortTerm: e.shortTerm,
        permanent: e.permanent,
        turnAdded: e.turnAdded,
        tier: e.tier
      })),
      latentPool: this.latentPool,
      turnCounter: this.turnCounter
    };
  }

  /**
   * Restore from serialized state.
   * Handles both new format (version 1) and legacy format (raw message array).
   */
  restore(data) {
    if (!data) return;

    // New format
    if (data.version === 1) {
      // Restore system prompt so token/memory display works immediately
      if (data.systemPrompt) {
        this.systemPrompt = data.systemPrompt;
      }

      this.latentPool = data.latentPool || [];
      this.turnCounter = data.turnCounter || 0;

      // Restore all entries as-is, demoting short-term to medium-term
      this.entries = [];
      for (const e of (data.entries || [])) {
        if (e.tier === 'short-term') {
          // Demote: no longer "just happened"
          this.entries.push({ ...e, tier: 'medium-term' });
        } else {
          this.entries.push({ ...e });
        }
      }

      // Trim latent pool
      if (this.latentPool.length > this.maxLatent) {
        this.latentPool = this.latentPool.slice(-this.maxLatent);
      }
      return;
    }

    // Legacy format: array of { role, content }
    if (Array.isArray(data)) {
      for (const msg of data) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          this.add(msg.role, msg.content, null, null);
        }
      }
      return;
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────

  /**
   * Move an expired entry to the latent pool with embedding.
   */
  async _moveToLatent(entry) {
    const text = entry.shortTerm || entry.immediate?.substring(0, 200);
    if (!text || !this.llmProvider) return;

    try {
      const embedding = await this.llmProvider.getEmbedding(text);
      if (!embedding) return;

      this.latentPool.push({
        summary: text,
        embedding,
        ts: Date.now(),
        role: entry.role
      });

      // Trim pool if too large
      if (this.latentPool.length > this.maxLatent) {
        this.latentPool = this.latentPool.slice(-this.maxLatent);
      }

      cliLogger.log('memory', `→ latent: "${text.substring(0, 60)}"`);
    } catch { /* non-fatal */ }
  }

  /**
   * Merge consecutive messages with the same role.
   * This can happen when medium-term entries between two same-role entries expire.
   * Handles multimodal content (array) by merging text blocks and preserving image blocks.
   */
  _mergeConsecutive(messages) {
    if (messages.length <= 1) return messages;

    const _textOf = (content) => {
      if (Array.isArray(content)) return content.find(p => p.type === 'text')?.text ?? '';
      return content ?? '';
    };
    const _nonTextOf = (content) => Array.isArray(content) ? content.filter(p => p.type !== 'text') : [];

    const merged = [{ ...messages[0] }];
    for (let i = 1; i < messages.length; i++) {
      const prev = merged[merged.length - 1];
      if (messages[i].role === prev.role && messages[i].role !== 'system') {
        const prevIsArray  = Array.isArray(prev.content);
        const nextIsArray  = Array.isArray(messages[i].content);

        if (prevIsArray || nextIsArray) {
          // Multimodal merge: combine text blocks, preserve image blocks
          const mergedText   = _textOf(prev.content) + '\n' + _textOf(messages[i].content);
          const nonTextParts = [..._nonTextOf(prev.content), ..._nonTextOf(messages[i].content)];
          if (nonTextParts.length > 0) {
            prev.content = [{ type: 'text', text: mergedText }, ...nonTextParts];
          } else {
            prev.content = mergedText;
          }
        } else {
          prev.content += '\n' + messages[i].content;
        }
      } else {
        merged.push({ ...messages[i] });
      }
    }
    return merged;
  }
}
