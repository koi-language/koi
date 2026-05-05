/**
 * Feedback / response classifiers — pure utilities extracted from the
 * legacy context-memory.js as part of Phase 8b.3 (delete legacy).
 *
 * Two callers consume these in llm-provider.js:
 *   - classifyFeedback(action, result, error)  — for action results coming back
 *   - classifyResponse(responseText, action)    — for assistant messages
 *
 * Both return objects shaped like { immediate, shortTerm, permanent, ... }
 * where the new Event Log–driven loop only uses `immediate`. The other
 * fields are kept for compatibility with any downstream code that still
 * peeks at them.
 *
 * No imports beyond standard helpers — these are pure functions and have
 * no dependency on any storage layer.
 */
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
    // Rich tool errors (generate_image/upscale_image/etc.) already come with
    // actionable fields — errorType, requirements, alternatives, hint. The
    // old classifier only surfaced `error`, so the LLM got "FAILED: No
    // active image model matches…" with no way to recover. Now we also
    // serialise the diagnostic payload so the LLM can cross-reference the
    // alternatives list and retry with a compatible request. Kept compact
    // (5kb cap) to avoid ballooning context.
    const diagParts = [];
    // `model` (resolved slug) is critical for media tools: when the
    // upstream provider rejects (likeness filter, content policy, etc.)
    // the agent's recovery path is to retry with `excludeModels: [<slug>]`.
    // Without the slug in the failure message the agent guesses (often
    // wrongly — e.g. inventing `excludeProviders: ["fal-ai"]` which the
    // schema doesn't accept). Keep this line FIRST in diagParts so it
    // sits right under the FAILED header.
    if (result.model) diagParts.push(`model: ${result.model}`);
    if (result.errorType) diagParts.push(`errorType: ${result.errorType}`);
    if (result.hint) diagParts.push(`hint: ${result.hint}`);
    if (result.requirements) {
      try { diagParts.push(`requirements: ${JSON.stringify(result.requirements)}`); } catch { /* ignore */ }
    }
    if (result.alternatives) {
      try {
        let alt = JSON.stringify(result.alternatives);
        if (alt.length > 5000) alt = alt.substring(0, 5000) + '...[truncated]';
        diagParts.push(`alternatives: ${alt}`);
      } catch { /* ignore */ }
    }
    // `capabilities` is what the media tools (generate_image, upscale_image,
    // generate_video, …) emit on upstream 4xx/5xx — it enumerates every
    // aspect_ratio, resolution, quality and output_format the model
    // actually accepts. Without it in the immediate message, the LLM
    // sees a bare "Unprocessable Entity" and re-emits the same invalid
    // parameter on its retry (we hit this on `resolution: "2K"` vs a
    // fleet that only advertised ["low","medium","high","ultra"]).
    if (result.capabilities) {
      try {
        let caps = JSON.stringify(result.capabilities);
        if (caps.length > 2000) caps = caps.substring(0, 2000) + '...[truncated]';
        diagParts.push(`capabilities: ${caps}`);
      } catch { /* ignore */ }
    }
    const diagBlock = diagParts.length > 0 ? `\n${diagParts.join('\n')}` : '';
    const immediate = `❌${id} ${intent} FAILED${exitCodeStr}: ${errText}${stdoutPart}${result.fix ? '\nFIX: ' + result.fix : ''}${diagBlock}`;
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

    case 'get_tool_info': {
      // The full schema is shown ONCE — on the first iteration after
      // execution. From the next iteration onwards, the doc is pinned
      // in the dynamic system-prompt block ("Tool schemas you recently
      // requested"), and toMessages() rewrites this entry to a tiny
      // placeholder so we don't carry the doc in two places. The
      // expansionIter that drives the rewrite lives on
      // agent._expandedTools (set in get-tool-info.execute).
      const tool = action.tool || result?.tool || '';
      const documentation = result?.documentation || '';
      const fullDoc = documentation
        ? `📎${id} get_tool_info(${tool}):\n${documentation}`
        : `📎${id} get_tool_info(${tool}) — no documentation returned`;
      const placeholder = `📎 get_tool_info(${tool}) — schema previously fetched (collapsed to free context).`;
      const expansionIter = typeof result?.expansionIter === 'number' ? result.expansionIter : null;
      return {
        immediate: fullDoc,
        shortTerm: placeholder,
        permanent: null,
        _toolInfo: { tool, placeholder, expansionIter },
        ...getTTL(intent),
      };
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
