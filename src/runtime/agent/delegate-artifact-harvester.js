/**
 * Delegate Artifact Harvester
 *
 * When a delegate agent (typically a Worker) completes its reactive loop
 * and returns to its caller, the durable artifacts it produced —
 * URLs visited by web_search / web_fetch, files it wrote or edited — live
 * only inside its own `session.actionHistory`. Once the session is
 * terminated that history is gone: the next task that asks "where did
 * you get this recipe?" / "which file did you edit?" has no way to find
 * out without re-running the whole search.
 *
 * This module plugs that hole. Right before the delegate's session is
 * terminated the runtime calls `harvestAndPersist(agent, session)` —
 * fire-and-forget — which walks the action history, extracts the
 * artifacts, and writes one compact memory note per source / file in
 * the project vault. Future memory.retrieve() / recall_facts calls can
 * then surface those trails to any sibling or follow-up task without a
 * single extra LLM token being spent rediscovering them.
 *
 * Design notes
 *  - Fire-and-forget: the caller awaits nothing. Any thrown error is
 *    caught and logged; it never propagates into the return path.
 *  - One note per artifact (not one big blob). Each fits the memory
 *    note description budget, and semantic recall can match on the
 *    exact URL / path without having to destructure JSON.
 *  - Keyed by task id when available, otherwise by agent + timestamp.
 *    Keeping the key unique per invocation prevents one Worker's facts
 *    from being overwritten by a later invocation's.
 *  - Only successful tool results count. We never persist an artifact
 *    that was produced by a failed or denied action.
 */

// Migrated from legacy sessionKnowledge to the new memory subsystem.
// Each harvested artifact (URL or file) is written as a separate memory
// note so semantic recall + multi-hop retrieval can surface it later.
import * as memory from '../memory/index.js';
import { channel } from '../io/channel.js';

const MAX_URLS = 5;
const MAX_FILES = 5;

/** Keep URLs short enough to fit the fact value budget (300 chars). */
const clip = (s, n) => {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) : s;
};

const dedupBy = (arr, keyFn) => {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
};

/**
 * Walk the delegate's action history and pull out the durable artifacts.
 *
 * @param {{ actionHistory?: Array }} session
 * @returns {{ urls: Array<{url:string,title:string}>, filesWritten: Array<{path:string,action:string}> }}
 */
function _extract(session) {
  const history = session?.actionHistory || [];
  const urls = [];
  const filesWritten = [];

  for (const entry of history) {
    const action = entry?.action || {};
    const result = entry?.result;
    if (!result || result.success === false) continue;

    const intent = action.intent || action.type || '';

    // web_search → { results: [{ title, url, snippet }] }
    if (intent === 'web_search' && Array.isArray(result.results)) {
      for (const r of result.results) {
        if (r?.url) {
          urls.push({
            url: clip(String(r.url), 260),
            title: clip(String(r.title || ''), 120),
          });
        }
      }
      continue;
    }

    // web_fetch → usually returns { url, title, content, ... } or saves to a file
    if (intent === 'web_fetch') {
      const u = result.url || action.url || '';
      if (u) {
        urls.push({
          url: clip(String(u), 260),
          title: clip(String(result.title || ''), 120),
        });
      }
      continue;
    }

    // File-writing tools. `create_file` is included for the occasional
    // alias; `edit_file` and `write_file` are the common ones.
    if (intent === 'edit_file' || intent === 'write_file' || intent === 'create_file') {
      const p = result.path || action.path || '';
      if (p) filesWritten.push({ path: String(p), action: intent });
      continue;
    }
  }

  return {
    urls: dedupBy(urls, u => u.url).slice(0, MAX_URLS),
    filesWritten: dedupBy(filesWritten, f => f.path).slice(0, MAX_FILES),
  };
}

/**
 * Best-effort pull of (taskId, subject) from the agent's work queue so the
 * resulting fact keys are meaningful. Returns { taskId: null, subject: null }
 * when the agent has no work queue, the queue is empty, or disk access
 * fails. Callers should tolerate both being null.
 */
function _taskContext(agent) {
  try {
    const queue = agent?._workQueue;
    if (!queue) return { taskId: null, subject: null };
    // The delegate is about to `return`, so its work item is likely still
    // `in_progress`. Fall back to the most recent completed/anything if
    // in_progress has already been cleared.
    const inProgress = queue.list({ status: 'in_progress' }) || [];
    const all = inProgress.length > 0 ? inProgress : (queue.list() || []);
    const item = all[all.length - 1];
    if (!item) return { taskId: null, subject: null };
    return { taskId: item.id, subject: item.subject || null };
  } catch {
    return { taskId: null, subject: null };
  }
}

/**
 * Main entry. Fire-and-forget: returns a resolved Promise even on error.
 * Never throws.
 */
export async function harvestAndPersist(agent, session) {
  try {
    const { urls, filesWritten } = _extract(session);
    if (urls.length === 0 && filesWritten.length === 0) return;

    const { taskId, subject } = _taskContext(agent);
    const agentSlug = (agent?.name || 'delegate').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const keyPrefix = taskId
      ? `task_${taskId}`
      : `${agentSlug}_${Date.now().toString(36)}`;

    const agentName = agent?.name || 'delegate';

    // Defensive: memory may not be initialised yet (very early in boot, or
    // when running a fixture without an embedding provider). Do not crash —
    // the harvest is fire-and-forget and the agent must continue regardless.
    let memReady = false;
    try {
      await memory.ensureInit(agent);
      memReady = true;
    } catch (err) {
      channel.log('knowledge', `delegate harvest: memory init skipped (${err?.message || err})`);
    }

    const writeNote = async (titleSuffix, description, project, body) => {
      if (!memReady) return;
      try {
        await memory.write({
          title: `${keyPrefix}_${titleSuffix}`,
          description: clip(description, 200),
          type: 'insight',
          project,
          confidence: 'validated',
          body,
        });
      } catch (err) {
        channel.log('knowledge', `delegate harvest write failed: ${err?.message || err}`);
      }
    };

    // Stamp the task subject first: gives semantic recall something to
    // hang the rest of the artifacts off of for vague follow-ups like
    // "the one where you wrote the recipe".
    if (subject) {
      await writeNote('subject', subject, ['delegate-artifact', agentName], `${agentName} delegate task: ${subject}`);
    }

    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      const value = u.title ? `${u.title} — ${u.url}` : u.url;
      await writeNote(
        `source_${i + 1}`,
        value,
        ['delegate-artifact', 'source', agentName],
        `URL discovered by ${agentName}: ${u.url}${u.title ? ` (${u.title})` : ''}`,
      );
    }

    for (let i = 0; i < filesWritten.length; i++) {
      const f = filesWritten[i];
      const detail = subject ? ` — ${clip(subject, 120)}` : '';
      await writeNote(
        `file_${i + 1}`,
        `${f.path} (${f.action})${detail}`,
        ['delegate-artifact', 'file', agentName],
        `${agentName} ${f.action} ${f.path}${detail}`,
      );
    }

    channel.log(
      'knowledge',
      `${agentName}: harvested ${urls.length} source(s) and ${filesWritten.length} file(s) from delegate trace` +
        (taskId ? ` (task #${taskId})` : ''),
    );
  } catch (err) {
    channel.log('knowledge', `delegate harvest failed: ${err?.message || err}`);
  }
}
