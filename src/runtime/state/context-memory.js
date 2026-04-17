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

import path from 'node:path';
import fs from 'node:fs';

import { taskManager } from './task-manager.js';
import { channel } from '../io/channel.js';

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

// ─── LatentStore (LanceDB-backed persistent latent memory) ────────────────

class LatentStore {
  constructor(dbPath, embeddingDim = 1536) {
    this._dbPath = dbPath;
    this._embeddingDim = embeddingDim;
    this._db = null;
    this._dbPromise = null;
    this._table = null;
  }

  async _ensureDb() {
    if (this._db) return;
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = (async () => {
      let lancedb;
      try {
        const isBinary = typeof process.pkg !== 'undefined';
        if (isBinary && process.env.KOI_EXTRACTED_NODE_MODULES) {
          const lancedbPath = path.join(process.env.KOI_EXTRACTED_NODE_MODULES, '@lancedb', 'lancedb', 'dist', 'index.js');
          let binaryRequire = globalThis.require;
          if (!binaryRequire) {
            try { binaryRequire = eval('require'); } catch {}
          }
          lancedb = binaryRequire(lancedbPath);
          lancedb = lancedb?.default ?? lancedb;
        } else {
          lancedb = await import('@lancedb/lancedb');
        }
      } catch (err) {
        channel.log('memory', `@lancedb/lancedb failed to load: ${err.message}`);
        throw err;
      }
      fs.mkdirSync(this._dbPath, { recursive: true });
      this._db = await lancedb.connect(this._dbPath);
    })();
    await this._dbPromise;
  }

  async _ensureTable() {
    if (this._table) return this._table;
    await this._ensureDb();
    const names = await this._db.tableNames();
    if (names.includes('latent')) {
      this._table = await this._db.openTable('latent');
    } else {
      // Create with a dummy row then delete it
      const dummy = {
        id: '__init__',
        text: '',
        summary: '',
        role: 'user',
        ts: 0,
        vector: new Array(this._embeddingDim).fill(0),
      };
      this._table = await this._db.createTable('latent', [dummy]);
      await this._table.delete('id = "__init__"');
    }
    return this._table;
  }

  async add({ text, summary, embedding, role, ts }) {
    try {
      const table = await this._ensureTable();
      const id = `lat-${ts}-${Math.random().toString(36).slice(2, 8)}`;
      await table.add([{
        id,
        text,
        summary,
        role,
        ts,
        vector: embedding,
      }]);
      channel.log('memory', `→ latent (LanceDB): "${summary.substring(0, 60)}"`);
    } catch (err) {
      channel.log('memory', `LatentStore.add failed: ${err.message}`);
    }
  }

  async search(queryEmbedding, limit = 3, threshold = 0.35) {
    try {
      const table = await this._ensureTable();
      const rows = await table.query().toArray();
      if (rows.length === 0) return [];

      const results = rows.map(row => {
        const vec = row.vector
          ? (typeof row.vector.toArray === 'function' ? Array.from(row.vector.toArray()) : Array.from(row.vector))
          : null;
        return {
          text: row.text,
          summary: row.summary,
          score: vec ? cosineSimilarity(queryEmbedding, vec) : 0,
        };
      })
        .filter(r => r.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return results;
    } catch (err) {
      channel.log('memory', `LatentStore.search failed: ${err.message}`);
      return [];
    }
  }

  async count() {
    try {
      const table = await this._ensureTable();
      const rows = await table.query().toArray();
      return rows.length;
    } catch {
      return 0;
    }
  }

  async migrateFromArray(latentPool) {
    if (!latentPool || latentPool.length === 0) return;
    channel.log('memory', `Migrating ${latentPool.length} latent entries to LanceDB...`);
    for (const entry of latentPool) {
      if (!entry.embedding) continue;
      await this.add({
        text: entry.summary,
        summary: entry.summary,
        embedding: entry.embedding,
        role: entry.role || 'user',
        ts: entry.ts || Date.now(),
      });
    }
    channel.log('memory', 'Latent migration complete.');
  }
}

// ─── Per-action TTL configuration ─────────────────────────────────────────

const ACTION_TTL = {
  read_file:       { shortDuration: 12, mediumDuration: 30 },
  shell:           { shortDuration: 6,  mediumDuration: 20 },
  prompt_user:     { shortDuration: 25, mediumDuration: 20 },
  print:           { shortDuration: 25, mediumDuration: 20 },
  delegate:        { shortDuration: 25, mediumDuration: 20 },
  browser_observe: { shortDuration: 3,  mediumDuration: 0 },
  mobile_observe:  { shortDuration: 3,  mediumDuration: 0 },
  _default:        { shortDuration: 6,  mediumDuration: 20 },
};

function getTTL(intent) {
  return ACTION_TTL[intent] || ACTION_TTL._default;
}

// Compute a stable key that groups an action with previous attempts of the "same thing".
// Used to invalidate stale failure memories when a later success proves the earlier
// error was transient or already resolved.
function _computeActionKey(action) {
  if (!action) return null;
  const intent = action.intent || action.type;
  if (!intent) return null;
  if (intent === 'shell') {
    const cmd = (action.command || '').trim();
    if (!cmd) return 'shell';
    // First token of the command line (e.g. "tree src" → "shell:tree").
    const first = cmd.split(/\s+/)[0];
    return `shell:${first}`;
  }
  const target = action.path || action.file || action.url || action.tool || '';
  return target ? `${intent}:${target}` : intent;
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
    // Build a useful shortTerm from the parallel sub-actions (e.g. "read_file x.js, grep y, search z")
    const subActions = result._parallelSubActions || [];
    const shortSummary = subActions.length > 0
      ? subActions.map(a => {
          const i = a.intent || a.type || '?';
          const t = a.path || a.file || a.query || a.pattern || '';
          return t ? `${i} ${t}` : i;
        }).join(', ')
      : 'parallel group';
    return {
      immediate,
      shortTerm: `✅ ${shortSummary}`,
      needsSummary: true,
      permanent: null,
      imageBlocks: result._parallelImageBlocks ?? null,
      ...getTTL(intent),
    };
  }

  // Error path
  if (error) {
    const errMsg = error.message || String(error);
    const immediate = `❌${id} ${intent} failed: ${errMsg}`;
    return { immediate, shortTerm: immediate, permanent: null, ...getTTL(intent) };
  }

  // Build full-detail immediate string — no truncation here.
  // The tiered memory system (short→medium→latent) handles context size over time.
  // Actions with inherently large output (shell, search, grep) truncate in their own case blocks.
  let resultStr = result ? JSON.stringify(result) : 'ok';

  // User denied the action with feedback — they want a DIFFERENT approach, not silence.
  // The feedback text is SACRED user input: it overrides previous plans/instructions.
  if (result && result.denied && result.feedback) {
    const immediate = `⛔${id} ${intent} REJECTED by user with feedback:\n"${result.feedback}"\n\nYou MUST incorporate this feedback into your next attempt. The user is telling you HOW they want this done differently. Do NOT repeat the same approach. Do NOT ignore this feedback.`;
    const shortTerm = `⛔ User rejected ${intent} and said: "${result.feedback}"`;
    return { immediate, shortTerm, permanent: null, ...getTTL('prompt_user') };
  }
  // User denied the action without feedback — they just said No. Move on.
  if (result && result.denied) {
    const immediate = `🚫${id} ${intent} DENIED by user. Do NOT retry this action or ask again — the user said No. Move on.`;
    const shortTerm = `🚫 ${intent}: denied by user`;
    return { immediate, shortTerm, permanent: null, ...getTTL(intent) };
  }

  // Handle error-like results (success: false)
  if (result && result.success === false && result.error) {
    // Include stdout if present — many CLI tools (flutter analyze, tsc, etc.) write
    // their useful output to stdout even when exiting with a non-zero code.
    const exitCodeStr = result.exitCode != null ? ` (exit code ${result.exitCode})` : '';
    // Cap result.error — some tools dump the entire raw output here as a
    // fallback, and an unbounded interpolation here has already poisoned
    // contextMemory with 50MB+ entries in the past.
    const errText = typeof result.error === 'string'
      ? (result.error.length > 3000 ? result.error.substring(0, 3000) + '...[truncated]' : result.error)
      : String(result.error);
    const stdoutPart = result.stdout ? `\nOutput:\n${result.stdout.substring(0, 3000)}` : '';
    const immediate = `❌${id} ${intent} FAILED${exitCodeStr}: ${errText}${stdoutPart}${result.fix ? '\nFIX: ' + result.fix : ''}`;
    return {
      immediate,
      shortTerm: `❌ ${intent} FAILED${exitCodeStr}: ${errText.substring(0, 200)}`,
      permanent: null,
      failureKey: _computeActionKey(action),
      ...getTTL(intent),
    };
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
      // Only the user's actual text — no boilerplate. Compliance and
      // authorization rules live in the system prompt (always visible).
      const newImmediate = answer;
      const perm = `User: "${answer}"`;
      return { immediate: newImmediate, shortTerm: perm, permanent: null, ...getTTL('prompt_user') };
    }

    case 'read_file': {
      const content = result?.content || '';
      const totalLines = result?.totalLines || content.split?.('\n')?.length || 0;
      const from = result?.from || 1;
      const to = result?.to || totalLines;
      const MAX_READ_CHARS = 50000;
      let truncContent;
      if (content.length > MAX_READ_CHARS) {
        const truncText = content.substring(0, MAX_READ_CHARS);
        const linesShown = truncText.split('\n').length;
        truncContent = truncText + `\n...[truncated — showing ~${linesShown} of ${totalLines} lines. Use smaller offset/limit to read specific sections.]`;
      } else {
        truncContent = content;
      }
      const truncImmediate = `✅${id} read_file ${action.path} (lines ${from}–${to} of ${totalLines}):\n${truncContent}`;
      return { immediate: truncImmediate, shortTerm: null, needsSummary: true, permanent: null, ...getTTL('read_file') };
    }

    case 'edit_file':
      return { immediate, shortTerm: `✅ edit ${action.path}`, permanent: null, successKey: _computeActionKey(action), ...getTTL(intent) };

    case 'write_file':
      return { immediate, shortTerm: `✅ write ${action.path}`, permanent: null, successKey: _computeActionKey(action), ...getTTL(intent) };

    case 'search': {
      const query = action.query || action.pattern || action.path || '';
      const hits = result?.matches?.length || result?.results?.length || 0;
      return { immediate, shortTerm: `✅ search "${query.substring(0, 40)}" (${hits} hits)`, permanent: null, ...getTTL(intent) };
    }

    case 'shell': {
      const shellOut = result?.stdout || result?.output || result?.content || '';
      const truncOut = shellOut.length > 3000 ? shellOut.substring(0, 3000) + '...[truncated]' : shellOut;
      // Belt-and-suspenders: catch shell failures even if they slipped past the generic error check above
      // (e.g. when result.error is empty but exitCode is non-zero)
      const shellFailed = result?.success === false || (result?.exitCode != null && result?.exitCode !== 0);
      if (shellFailed) {
        const exitCodeStr = result?.exitCode != null ? ` (exit code ${result.exitCode})` : '';
        const shellMsg = truncOut
          ? `❌${id} SHELL COMMAND FAILED${exitCodeStr}. Output:\n${truncOut}`
          : `❌${id} shell: command failed${exitCodeStr} with no output`;
        return {
          immediate: shellMsg,
          shortTerm: `❌ shell FAILED${exitCodeStr}`,
          needsSummary: true,
          permanent: null,
          failureKey: _computeActionKey(action),
          ...getTTL('shell'),
        };
      }
      const shellMsg = truncOut
        ? `✅${id} shell output:\n${truncOut}`
        : `✅${id} shell: ${action.description || 'command'} (no output)`;
      return {
        immediate: shellMsg,
        shortTerm: null,
        needsSummary: true,
        permanent: null,
        successKey: _computeActionKey(action),
        ...getTTL('shell'),
      };
    }

    case 'print':
      return { immediate, shortTerm: `✅ print`, needsSummary: true, permanent: null, ...getTTL('print') };

    case 'call_llm':
      return { immediate, shortTerm: `✅ call_llm`, permanent: null, ...getTTL(intent) };

    case 'registry_set':
      return { immediate, shortTerm: `✅ registry_set "${action.key}"`, permanent: null, ...getTTL(intent) };

    case 'registry_get':
      return { immediate, shortTerm: `✅ registry_get "${action.key}"`, permanent: null, ...getTTL(intent) };

    case 'registry_delete':
      return { immediate, shortTerm: `✅ registry_delete "${action.key}"`, permanent: null, ...getTTL(intent) };

    case 'registry_search':
      return { immediate, shortTerm: `✅ registry_search`, permanent: null, ...getTTL(intent) };

    case 'call_mcp': {
      const mcpText = _imageBlocks
        ? `✅${id} call_mcp ${action.tool} -> [${_imageBlocks.length} image(s) — see attached]`
        : immediate;
      return {
        immediate: mcpText,
        shortTerm: `✅ call_mcp ${action.tool || ''}`,
        permanent: null,
        imageBlocks: _imageBlocks,
        ...getTTL(intent),
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
        ...getTTL(intent),
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
        ...getTTL(intent),
      };
    }

    case 'browser_observe': {
      const bElCount = result?.elementCount || '?';
      const bUrl = result?.url || '?';
      const _bTxt = result?.elementsSummary || result?.content?.find(c => c.type === 'text')?.text || '';
      return {
        immediate: _imageBlocks
          ? `🌐${id} browser_observe (${bUrl}) — ${bElCount} elements [screenshot attached]\n${_bTxt}`
          : immediate,
        shortTerm: `🌐 observe: ${bElCount} elements (${bUrl})`,
        permanent: null,
        imageBlocks: _imageBlocks,
        ...getTTL('browser_observe'),
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
        ...getTTL('mobile_observe'),
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
        ...getTTL(intent),
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
      return { immediate, shortTerm: _mobShort, permanent: null, ...getTTL(intent) };
    }

    case 'task_list': {
      // Preserve task subjects+descriptions in memory so they survive context compression.
      // Without this, after a few shell commands the agent loses the task details and asks the user.
      const allTasks = result?.tasks || [];
      const pending = allTasks.filter(t => t.status !== 'completed');
      if (pending.length === 0) {
        return {
          immediate, shortTerm: '✅ task_list (all done)', permanent: null,
          replaceTag: 'task_list_pending', clearTag: true,
          ...getTTL(intent),
        };
      }
      const taskLines = pending.map(t => {
        const icon = t.status === 'in_progress' ? '●' : '☐';
        const desc = t.description ? ` — ${t.description}` : '';
        return `  [${t.id}] ${icon} ${t.subject}${desc}`;
      }).join('\n');
      const shortTerm = `Pending tasks:\n${taskLines}`;
      // directLongTerm: task list goes straight to long-term, replaceTag ensures only latest snapshot
      return {
        immediate, shortTerm, permanent: shortTerm,
        directLongTerm: true, replaceTag: 'task_list_pending',
        ...getTTL(intent),
      };
    }

    case 'my_task': {
      // Assigned task goes to long-term; replace previous my_task for same id
      const taskId = result?.task?.id || action.taskId || '?';
      const task = result?.task || result;
      const desc = task?.description ? ` — ${task.description}` : '';
      const shortTerm = `My task [${taskId}] (${task?.status || '?'}): ${task?.subject || '?'}${desc}`;
      if (task?.status === 'completed') {
        return {
          immediate, shortTerm, permanent: null,
          replaceTag: `my_task_${taskId}`, clearTag: true,
          ...getTTL(intent),
        };
      }
      return {
        immediate, shortTerm, permanent: shortTerm,
        directLongTerm: true, replaceTag: `my_task_${taskId}`,
        ...getTTL(intent),
      };
    }

    case 'learn_fact': {
      const key = action.key || result?.key || '';
      const value = action.value || result?.value || '';
      const perm = `Fact: ${key} = ${value}`;
      // Facts are already stored in session-knowledge (the shared, persistent store).
      // Duplicating them in context-memory long-term is redundant and the main source
      // of memory bloat (441+ permanent entries). Keep in short/medium for immediate
      // visibility, then let them age to latent like everything else.
      return {
        immediate, shortTerm: perm, permanent: null,
        ...getTTL(intent),
      };
    }

    case 'task_get': {
      // Preserve the full task description in short-term memory
      const task = result?.task || result;
      if (task?.subject) {
        const desc = task.description ? ` — ${task.description}` : '';
        const shortTerm = `Task [${task.id}] (${task.status}): ${task.subject}${desc}`;
        return { immediate, shortTerm, permanent: null, ...getTTL(intent) };
      }
      return { immediate, shortTerm: `✅ task_get`, permanent: null, ...getTTL(intent) };
    }

    case 'task_update':
      return { immediate, shortTerm: `✅ task_update [${action.taskId}] → ${action.status || 'updated'}`, permanent: null, ...getTTL(intent) };

    case 'task_create': {
      const subject = result?.subject || action.subject || '';
      return { immediate, shortTerm: `✅ task_create: ${subject}`, permanent: null, ...getTTL(intent) };
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
        return {
          immediate: msg, shortTerm: `✅ delegate ${intent} → answer ready`,
          needsSummary: true, needsPermanentSummary: false, permanent: null,
          ...getTTL('delegate'),
        };
      }
      return { immediate, shortTerm: `✅ ${intent}`, permanent: null, ...getTTL(intent) };
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
    return { immediate: responseText, shortTerm: `→ [${intents}]`, permanent: null, ...getTTL('_default') };
  }

  const intent = action.intent || action.type || 'unknown';
  let permanent = null;
  let shortTerm = `→ ${intent}`;

  let needsSummary = false;
  let needsPermanentSummary = false;
  let ttl = getTTL(intent);

  switch (intent) {
    case 'print': {
      const msg = action.message || '';
      // Remove truncation — use LLM summarization instead
      needsSummary = true;
      needsPermanentSummary = false; // Print output is episodic, not a permanent fact
      shortTerm = `→ print "${msg.substring(0, 60)}"`;
      ttl = getTTL('print');
      break;
    }
    case 'prompt_user': {
      const q = action.question || action.prompt || '';
      shortTerm = `→ prompt "${q.substring(0, 60)}"`;
      ttl = getTTL('prompt_user');
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
        needsSummary = true;
        needsPermanentSummary = false; // Delegate results are episodic, not permanent facts
        ttl = getTTL('delegate');
      }
  }

  return { immediate: responseText, shortTerm, permanent, needsSummary, needsPermanentSummary, ...ttl };
}

// ─── ContextMemory ─────────────────────────────────────────────────────────

export class ContextMemory {
  constructor({ agentName, llmProvider, shortTermTTL, mediumTermTTL, latentDbPath } = {}) {
    this.agentName = agentName || 'unknown';
    this.llmProvider = llmProvider;
    this.entries = [];
    this.turnCounter = 0;
    this.systemPrompt = null;

    // TTLs (in turns) — fallbacks for entries without per-entry TTL
    this.shortTermTTL = shortTermTTL ?? 6;
    this.mediumTermTTL = mediumTermTTL ?? 20;

    // LanceDB-backed latent store — dimension matches the embedding provider:
    // OpenAI text-embedding-3-small = 1536, Gemini text-embedding-004 = 768.
    const _embeddingDim = llmProvider?.getEmbeddingDim?.() ?? 1536;
    this._latentStore = latentDbPath ? new LatentStore(latentDbPath, _embeddingDim) : null;
    // Fallback in-memory pool when no LanceDB path (e.g. tests)
    this._fallbackLatentPool = [];
    this._fallbackMaxLatent = 100;

    // Hydration config
    this.latentThreshold = 0.35;
    this.maxHydrate = 3;

    // Count of entries moved to latent (for token estimation)
    this._latentCount = 0;

    // Queue for entries that need to move to latent (from tag replacement)
    this._latentQueue = [];
  }

  /**
   * Clear all conversation history and reset state.
   */
  clear() {
    this.entries = [];
    this._fallbackLatentPool = [];
    this._latentQueue = [];
    this._latentCount = 0;
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
   * @param {object} opts - Classification options (shortDuration, mediumDuration, needsSummary, etc.)
   */
  add(role, immediate, shortTerm = null, permanent = null, opts = {}) {
    // Last-resort hard cap on entry size. No individual context entry should
    // ever exceed this — upstream truncation in tools/classifyFeedback is
    // expected to do the real job. Hitting this cap means a bug: some path
    // shoved a raw tool result straight into the context unchecked.
    // A single runaway grep has melted the session with 50MB+ entries before.
    const _ENTRY_CAP = 256_000; // ~64K tokens
    const _capString = (s, label) => {
      if (typeof s !== 'string' || s.length <= _ENTRY_CAP) return s;
      const half = Math.floor(_ENTRY_CAP / 2);
      const cut = s.length - _ENTRY_CAP;
      channel.log('memory', `⚠️ contextMemory entry ${label} exceeds cap (${s.length} > ${_ENTRY_CAP}) — truncating (bug: upstream failed to cap)`);
      return s.substring(0, half) + `\n\n... [${cut} chars truncated — upstream bug] ...\n\n` + s.substring(s.length - half);
    };
    immediate = _capString(immediate, 'immediate');
    shortTerm = _capString(shortTerm, 'shortTerm');
    permanent = _capString(permanent, 'permanent');

    // Handle replaceTag: expire old entries with the same tag
    if (opts.replaceTag) {
      if (opts.clearTag) {
        // Move old tagged entry to latent, then don't create a new long-term entry
        this._markTagForLatent(opts.replaceTag);
      } else {
        this._replaceTagged(opts.replaceTag);
      }
    }

    // Invalidate prior failure entries with matching key when a later success proves
    // the earlier error is stale. Prevents toxic warnings like "tree FAILED" from
    // haunting the context after a subsequent `tree src` ran successfully.
    if (opts.successKey) {
      let _invalidated = 0;
      for (const e of this.entries) {
        if (e.failureKey === opts.successKey && e.tier !== 'expired') {
          e.tier = 'expired';
          _invalidated++;
        }
      }
      if (_invalidated > 0) {
        channel.log('memory', `Invalidated ${_invalidated} prior failure(s) for key "${opts.successKey}"`);
      }
    }

    const entry = {
      role,
      immediate,
      // IMPORTANT: do NOT default shortTerm to `immediate`. The fallback
      // silently bypasses LLM summarization: `_summarizeIfNeeded` only
      // queues an entry when `!entry.shortTerm`, so leaving this populated
      // with the raw text means medium-term forever shows the literal
      // immediate — ie. no summary, ever. Callers that have a cheap
      // pre-computed short form (classifyFeedback / classifyResponse) pass
      // it explicitly; everyone else leaves it null so the summarizer
      // picks the entry up when it ages out of short-term.
      shortTerm: shortTerm ?? null,
      permanent,
      ts: Date.now(),
      turnAdded: this.turnCounter,
      tier: opts.directLongTerm ? 'long-term' : 'short-term',
      // Per-entry TTL overrides
      shortDuration: opts.shortDuration,
      mediumDuration: opts.mediumDuration,
      // Deferred summarization flags. If the caller didn't pre-compute a
      // `shortTerm`, auto-mark long immediates as needing summarization —
      // otherwise they'd transition to medium-term with `shortTerm == null`
      // and `toMessages()` would drop them, or with the silent-fallback bug
      // we just removed they'd travel forever as the literal raw text.
      needsSummary: opts.needsSummary ?? (shortTerm == null && typeof immediate === 'string' && immediate.length > 80),
      needsPermanentSummary: opts.needsPermanentSummary || false,
      // Tag for replacement tracking
      replaceTag: opts.replaceTag || null,
      // Key used to retroactively expire this entry when a later success of the
      // same "type" proves the failure was transient (see _computeActionKey).
      failureKey: opts.failureKey || null,
    };
    if (opts.ephemeral) entry.ephemeral = true;
    if (opts.attachments?.length > 0) entry.attachments = opts.attachments;

    if (opts.directLongTerm) {
      channel.log('memory', `↑ direct long-term: "${(permanent || shortTerm || immediate).substring(0, 60)}"`);
    }

    this.entries.push(entry);
  }

  /**
   * Advance the clock by one turn.
   * Ages entries: short→medium→long-term or latent.
   * Uses per-entry TTLs when available, falls back to global TTLs.
   * Call once per reactive loop iteration.
   */
  async tick() {
    this.turnCounter++;
    // Entries that need LLM summarization before they can leave short-term.
    // Keyed by entry, value is the medDur so we can complete the transition after summarization.
    const toSummarize = [];
    const toLatent = [];

    for (const entry of this.entries) {
      if (entry.tier === 'long-term' || entry.tier === 'expired') continue;

      const age = this.turnCounter - entry.turnAdded;
      const shortDur = entry.shortDuration ?? this.shortTermTTL;
      const medDur = entry.mediumDuration ?? this.mediumTermTTL;

      // Short-term expiry check
      if (entry.tier === 'short-term' && age > shortDur) {
        if (medDur === 0) {
          // Skip medium tier — go directly to long-term or latent. No summary needed.
          if (entry.permanent) {
            entry.tier = 'long-term';
            channel.log('memory', `↑ long-term (skip medium): "${entry.permanent.substring(0, 60)}"`);
          } else {
            toLatent.push(entry);
            entry.tier = 'expired';
          }
        } else if (entry.immediate && entry.immediate.length > 80 && (!entry.shortTerm || entry.needsSummary)) {
          // Must LLM-summarize BEFORE transitioning — entry stays in short-term until summary succeeds.
          // Skip summarization if a shortTerm is already set (e.g. from classifyResponse) — use it as-is.
          // Store medDur on the entry so the post-summarization step can complete the transition.
          entry._pendingMedDur = medDur;
          toSummarize.push(entry);
        } else {
          // Trivial entry (short immediate, already has a shortTerm, or
          // below the summarization threshold) — transition directly, no
          // LLM summary needed. If shortTerm is still unset (typical for a
          // ≤80-char user message that add() left null), copy immediate
          // into shortTerm so `toMessages()` keeps this entry visible in
          // medium-term — otherwise `content = entry.shortTerm` would be
          // null and the entry would vanish from the LLM context.
          if (!entry.shortTerm && entry.immediate) {
            entry.shortTerm = entry.immediate;
          }
          entry.tier = 'medium-term';
          entry.tierEnteredAt = this.turnCounter;
        }
      }

      // Medium-term expiry check (separate block — not else-if — allows same-tick transitions)
      if (entry.tier === 'medium-term') {
        const medAge = this.turnCounter - (entry.tierEnteredAt ?? entry.turnAdded);
        if (medAge > medDur) {
          if (entry.permanent) {
            entry.tier = 'long-term';
            channel.log('memory', `↑ long-term: "${entry.permanent.substring(0, 60)}"`);
          } else {
            toLatent.push(entry);
            entry.tier = 'expired';
          }
        }
      }
    }

    // Process queued latent moves from tag replacement
    for (const entry of this._latentQueue) {
      toLatent.push(entry);
      entry.tier = 'expired';
    }
    this._latentQueue = [];

    // Run LLM summarization in parallel. Only transition to medium-term on success.
    // On failure the entry stays in short-term and will retry next tick.
    if (toSummarize.length > 0 && this.llmProvider) {
      const results = await Promise.allSettled(
        toSummarize.map(entry => this._summarizeEntry(entry))
      );
      for (let i = 0; i < toSummarize.length; i++) {
        const entry = toSummarize[i];
        const ok = results[i].status === 'fulfilled' && results[i].value === true;
        if (ok) {
          entry.tier = 'medium-term';
          entry.tierEnteredAt = this.turnCounter;
        } else {
          // Summarization failed — track retries and give up after 3 attempts.
          entry._summaryRetries = (entry._summaryRetries || 0) + 1;
          if (entry._summaryRetries >= 3) {
            // Give up: transition to medium-term with a truncated fallback summary.
            entry.shortTerm = entry.shortTerm || (entry.immediate?.substring(0, 200) + '...');
            entry.tier = 'medium-term';
            entry.tierEnteredAt = this.turnCounter;
            channel.log('memory', `Summary gave up after ${entry._summaryRetries} retries, using truncated fallback`);
          } else {
            channel.log('memory', `Keeping "${entry.immediate?.substring(0, 40)}" in short-term (summary failed, retry ${entry._summaryRetries}/3)`);
          }
        }
        delete entry._pendingMedDur;
      }
    } else if (toSummarize.length > 0) {
      // No LLM provider — transition anyway but log the miss.
      for (const entry of toSummarize) {
        entry.tier = 'medium-term';
        entry.tierEnteredAt = this.turnCounter;
        delete entry._pendingMedDur;
      }
    }

    // Move expired entries to latent store (async: needs embeddings)
    for (const entry of toLatent) {
      await this._moveToLatent(entry);
    }

    // Remove expired entries from active context
    this.entries = this.entries.filter(e => e.tier !== 'expired');
  }

  /**
   * Search latent store by semantic similarity and inject relevant memories.
   * Call after prompt_user or when past context might help.
   * @param {string} query - Text to match against (e.g. user's answer)
   */
  async hydrate(query) {
    if (!this.llmProvider) return;

    try {
      const queryEmbedding = await this.llmProvider.getEmbedding(query);
      if (!queryEmbedding) return;

      let matches = [];

      if (this._latentStore) {
        matches = await this._latentStore.search(queryEmbedding, this.maxHydrate, this.latentThreshold);
      } else if (this._fallbackLatentPool.length > 0) {
        // Fallback in-memory search (tests, no latentDbPath)
        matches = this._fallbackLatentPool
          .map(m => ({ ...m, score: cosineSimilarity(queryEmbedding, m.embedding) }))
          .filter(m => m.score >= this.latentThreshold)
          .sort((a, b) => b.score - a.score)
          .slice(0, this.maxHydrate);
      }

      if (matches.length === 0) return;

      channel.log('memory', `Hydrated ${matches.length} latent memories`);
      for (const m of matches) {
        channel.log('memory', `  score=${m.score.toFixed(3)} "${(m.text || m.summary).substring(0, 60)}"`);
      }

      // Inject full text from matched entries (not just summary)
      const recallText = matches.map(m => `- ${m.text || m.summary}`).join('\n');
      // Collect all attachments from matched entries (preserved across tiers)
      const recalledAttachments = matches.flatMap(m => m.attachments || []).filter(Boolean);
      // Inject as volatile short-term entry (will age and fade normally)
      this.add('user', `RECALLED:\n${recallText}`, null, null, {
        attachments: recalledAttachments.length > 0 ? recalledAttachments : undefined,
      });
    } catch (err) {
      channel.log('memory', `Hydration failed: ${err.message}`);
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
        const msg = { role: entry.role, content };
        // Attachments are injected ONCE: on the first turn after they're added.
        // After being consumed, the entry keeps the attachments for historical
        // reference (the path is mentioned in text), but they're not re-sent to the LLM.
        if (entry.attachments?.length > 0 && !entry._attachmentsConsumed) {
          msg.attachments = entry.attachments;
          entry._attachmentsConsumed = true; // mark as consumed
        }
        messages.push(msg);
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
   * Version 2: includes per-entry TTL fields, no latentPool (stored in LanceDB).
   */
  serialize() {
    return {
      version: 2,
      systemPrompt: this.systemPrompt,
      entries: this.entries.filter(e => !e.ephemeral).map(e => ({
        role: e.role,
        immediate: e.immediate,
        shortTerm: e.shortTerm,
        permanent: e.permanent,
        ts: e.ts,
        turnAdded: e.turnAdded,
        tier: e.tier,
        shortDuration: e.shortDuration,
        mediumDuration: e.mediumDuration,
        tierEnteredAt: e.tierEnteredAt,
        needsSummary: e.needsSummary || undefined,
        needsPermanentSummary: e.needsPermanentSummary || undefined,
        replaceTag: e.replaceTag || undefined,
      })),
      latentCount: this._latentCount,
      turnCounter: this.turnCounter
    };
  }

  /**
   * Restore from serialized state.
   * Handles v2 (exact restore), v1 (migrate latentPool to LanceDB), and legacy array format.
   */
  restore(data) {
    if (!data) return;

    // Version 2: exact restore with per-entry TTL fields
    if (data.version === 2) {
      if (data.systemPrompt) {
        this.systemPrompt = data.systemPrompt;
      }
      this.turnCounter = data.turnCounter || 0;
      this._latentCount = data.latentCount || 0;
      this.entries = (data.entries || []).map(e => ({ ...e }));
      return;
    }

    // Version 1: restore entries + migrate latentPool to LanceDB
    if (data.version === 1) {
      if (data.systemPrompt) {
        this.systemPrompt = data.systemPrompt;
      }
      this.turnCounter = data.turnCounter || 0;
      this.entries = (data.entries || []).map(e => ({ ...e }));

      // Migrate old latentPool to LanceDB (async, fire-and-forget)
      if (data.latentPool && data.latentPool.length > 0) {
        this._migrateLatentPool(data.latentPool);
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

  /**
   * Get the actual count of entries in the latent store (LanceDB or fallback).
   */
  async getLatentCount() {
    if (this._latentStore) {
      return await this._latentStore.count();
    }
    return this._fallbackLatentPool.length;
  }

  // ─── Private ─────────────────────────────────────────────────────────

  /**
   * LLM-based summarization for an entry transitioning out of short-term.
   * Uses the cheapest+fastest available model (speed taskType, difficulty=1).
   * Cost is recorded in costCenter so it appears in /cost reports.
   * Returns true on success, false on failure — no truncation fallback.
   */
  async _summarizeEntry(entry) {
    if (!this.llmProvider) return false;

    // Cap input to ~8000 chars. Even models with large context windows (flash-lite: 1M)
    // produce unreliable JSON when the input is very long. The first 8K chars contain
    // enough structure (file headers, function signatures, key results) for a good summary.
    const rawText = entry.immediate || '';
    if (!rawText) return false;
    const textToSummarize = rawText.length > 8000
      ? rawText.substring(0, 8000) + '\n...[truncated]'
      : rawText;

    const _t0 = Date.now();
    try {
      const system = 'Return ONLY valid JSON. No markdown, no explanations.';
      // Code-aware summarization: read_file entries need structural summaries, not action descriptions
      const isCodeRead = textToSummarize.includes('read_file ') && (textToSummarize.startsWith('✅') || textToSummarize.includes('lines '));
      const user = isCodeRead
        ? `Summarize the CODE CONTENT below in 1-3 sentences as a flat string. Mention the most important function/class names and their purpose. Do NOT return arrays or nested objects. Return JSON: {"summary": "..."}\n\nText:\n${textToSummarize}`
        : `Summarize in 1-3 sentences. Preserve file paths, names, numbers, and errors. Return JSON: {"summary": "..."}\n\nText:\n${textToSummarize}`;
      // callSummary uses the cheapest/fastest model and records cost in costCenter.
      const raw = await this.llmProvider.callSummary(system, user);
      const _elapsed = Date.now() - _t0;
      channel.log('memory', `callSummary returned in ${_elapsed}ms, rawLen=${raw.length}, preview="${raw.substring(0, 100).replace(/\n/g, ' ')}"`);
      if (!raw || !raw.trim()) {
        channel.log('memory', `Summary empty response (${_elapsed}ms)`);
        return false;
      }
      let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        // LLM may return unescaped control chars inside JSON strings — fix common cases
        cleaned = cleaned.replace(/[\x00-\x1f]/g, ch => {
          if (ch === '\n') return '\\n';
          if (ch === '\r') return '\\r';
          if (ch === '\t') return '\\t';
          return '';
        });
        try { parsed = JSON.parse(cleaned); } catch {
          // Last resort: extract summary value from raw text (handles both string and truncated object values)
          const mStr = raw.match(/["']summary["']\s*:\s*["'](.+?)["']\s*[,}]/s);
          if (mStr) {
            parsed = { summary: mStr[1] };
          } else {
            // Flash-lite may return truncated JSON with summary as an object — salvage what we can
            const mObj = raw.match(/["']summary["']\s*:\s*(\{[\s\S]*)/);
            if (mObj) {
              // Strip the truncated object content and use the raw text up to ~300 chars as summary
              const salvaged = mObj[1].replace(/[\n\r]+/g, ' ').substring(0, 300).trim();
              parsed = { summary: `[partial] ${salvaged}` };
            } else {
              parsed = null;
            }
          }
        }
      }
      let summary = parsed?.summary;
      // Flash-lite sometimes returns summary as an object instead of a string — flatten it
      if (summary && typeof summary === 'object') {
        summary = JSON.stringify(summary);
        channel.log('memory', `Summary was object, flattened to string (${summary.length} chars)`);
      }
      if (summary && typeof summary === 'string') {
        entry.shortTerm = summary;
        if (entry.needsPermanentSummary) {
          entry.permanent = summary;
        }
        channel.log('memory', `LLM summary: "${summary.substring(0, 80)}"`);
        return true;
      }
      channel.log('memory', `Summary parse failed: no "summary" field in response. raw="${raw.substring(0, 200).replace(/\n/g, ' ')}"`);
      return false;
    } catch (err) {
      channel.log('memory', `Summarization exception: ${err.message} (${Date.now() - _t0}ms)`);
      try {
        const { surfaceQuotaIfDetected } = await import('../llm/quota-exceeded-error.js');
        await surfaceQuotaIfDetected(err);
      } catch { /* best-effort */ }
      return false;
    }
  }

  /**
   * Move an expired entry to the latent store with embedding.
   * Stores full immediate text (not just summary) for richer recall.
   */
  async _moveToLatent(entry) {
    // Use full immediate text for embedding (truncated for API limits)
    const fullText = entry.immediate || '';
    const summary = entry.shortTerm || fullText.substring(0, 200);
    const textForEmbedding = fullText.substring(0, 2000);
    if (!textForEmbedding || !this.llmProvider) return;

    // Skip trivial entries that provide no useful recall value.
    // These are action stubs with no meaningful content (e.g. "→ unknown", "→ task_list").
    const _trivialIntents = new Set(['unknown', 'task_list', 'task_get', 'task_update', 'recall_facts', 'learn_fact', '?']);
    const _stMatch = summary.match(/^→\s*(\S+)/);
    if (_stMatch && _trivialIntents.has(_stMatch[1]) && fullText.length < 300) {
      channel.log('memory', `Skip trivial latent: "${summary.substring(0, 60)}"`);
      return;
    }

    try {
      const embedding = await this.llmProvider.getEmbedding(textForEmbedding);
      if (!embedding) return;

      if (this._latentStore) {
        await this._latentStore.add({
          text: fullText.substring(0, 4000), // Cap for storage
          summary,
          embedding,
          role: entry.role,
          ts: Date.now(),
          attachments: entry.attachments || [],
        });
      } else {
        // Fallback in-memory pool (tests, no latentDbPath)
        this._fallbackLatentPool.push({
          text: fullText.substring(0, 4000),
          summary,
          embedding,
          ts: Date.now(),
          role: entry.role,
          attachments: entry.attachments || [],
        });
        if (this._fallbackLatentPool.length > this._fallbackMaxLatent) {
          this._fallbackLatentPool = this._fallbackLatentPool.slice(-this._fallbackMaxLatent);
        }
        channel.log('memory', `→ latent (in-memory): "${summary.substring(0, 60)}"`);
      }
      this._latentCount++;
    } catch (err) {
      channel.log('memory', `_moveToLatent failed: ${err.message}`);
      try {
        const { surfaceQuotaIfDetected } = await import('../llm/quota-exceeded-error.js');
        await surfaceQuotaIfDetected(err);
      } catch { /* best-effort */ }
    }
  }

  /**
   * Replace old entries with the same tag (expire them).
   */
  _replaceTagged(tag) {
    for (const entry of this.entries) {
      if (entry.replaceTag === tag && entry.tier !== 'expired') {
        entry.tier = 'expired';
        channel.log('memory', `Tag replace: expired "${tag}" entry`);
      }
    }
  }

  /**
   * Mark old tagged entries for latent move (used when clearTag is true).
   */
  _markTagForLatent(tag) {
    for (const entry of this.entries) {
      if (entry.replaceTag === tag && entry.tier !== 'expired') {
        this._latentQueue.push(entry);
        channel.log('memory', `Tag clear: queuing "${tag}" for latent`);
      }
    }
  }

  /**
   * Migrate v1 latentPool to LanceDB (async, fire-and-forget).
   */
  _migrateLatentPool(latentPool) {
    if (!this._latentStore) {
      // No LanceDB path — keep in fallback pool
      this._fallbackLatentPool = latentPool.slice(-this._fallbackMaxLatent);
      return;
    }
    // Fire-and-forget migration
    this._latentStore.migrateFromArray(latentPool).catch(err => {
      channel.log('memory', `Latent migration failed: ${err.message}`);
      // Fall back to in-memory
      this._fallbackLatentPool = latentPool.slice(-this._fallbackMaxLatent);
    });
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
