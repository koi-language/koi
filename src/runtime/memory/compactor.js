/**
 * Task → episode writer.
 *
 * Fires when a user-facing task plan drains (all tasks `completed` or
 * `deleted`). Takes each agent's in-process turn buffer and stores it in
 * the memory vault as a `type: "episode"` note. Then resets the buffer so
 * the next user request starts clean.
 *
 * Two paths, picked automatically by transcript size:
 *
 *   - SMALL (default) — just move. Title from the task; description is
 *     the first user turn; body is the literal transcript. No LLM. A
 *     30-character "port is 224" exchange is preserved exactly as-is.
 *
 *   - LARGE — when a transcript is genuinely big (lots of debugging,
 *     long delegation chain), an LLM call adds a real summary that
 *     callers can read at a glance instead of scanning the whole thing.
 *     The full transcript is still preserved in the body — the summary
 *     is just on top.
 *
 * The size threshold is necessarily a number. We pick something
 * defensible: a transcript becomes worth summarising when it crosses
 * roughly the size of a single LLM message (~5K chars ≈ 1.2K tokens) OR
 * when it accumulates 20+ turns. Below both, scanning the raw transcript
 * is cheaper than burning a model round-trip.
 */

import * as memory from './index.js';
import { makeLlmAdapter, isNullLlm } from './rmh/_koi-bridge.js';

/** Description preview cap — keeps the frontmatter readable. */
const _DESCRIPTION_PREVIEW_CHARS = 200;

/**
 * Boundary between "just move" and "summarise too". Below both thresholds
 * we skip the LLM. Either threshold being crossed is enough to summarise.
 *   - 5000 chars ≈ 1.2K tokens — a single LLM message worth of content.
 *   - 20 turns — a substantive multi-step conversation.
 */
const _SUMMARY_CHAR_THRESHOLD = 5000;
const _SUMMARY_TURN_THRESHOLD = 20;

const _SUMMARY_PROMPT =
  'You are a journaling assistant. Below is a transcript of an AI agent ' +
  'conversation that just completed a task. Produce a short title and a ' +
  '2-3 sentence summary describing what was done and any noteworthy ' +
  'decisions or outcomes. Return ONLY valid JSON of the form ' +
  '{"title":"<5-9 words>","summary":"<2-3 sentences>"}. No markdown.';

/** Cap the transcript fed to the summariser. */
const _MAX_SUMMARY_INPUT_CHARS = 12000;

/**
 * Move one ContextMemory's turn buffer into an episode note.
 *
 * @param {object} opts
 * @param {object} opts.contextMemory  ContextMemory instance with `_buffer`
 *                                      and `resetTurnBuffer`.
 * @param {string} [opts.agentName]
 * @param {string[]} [opts.taskTitles]  Titles of completed tasks (used to
 *                                       title the episode + tag it).
 * @param {string} [opts.planId]        Optional plan identifier for traceability.
 * @returns {Promise<{title: string, path: string}|null>}
 *          null if there was nothing to write.
 */
export async function compactSessionToEpisode({
  contextMemory,
  agentName = 'agent',
  taskTitles = [],
  planId = null,
} = {}) {
  if (!contextMemory || !Array.isArray(contextMemory._buffer)) return null;
  if (contextMemory._buffer.length === 0) return null;

  const transcript = contextMemory._buffer
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  const totalChars = transcript.length;
  const turnCount = contextMemory._buffer.length;
  const isLarge = totalChars >= _SUMMARY_CHAR_THRESHOLD || turnCount >= _SUMMARY_TURN_THRESHOLD;

  // ── Defaults (used when isLarge=false OR when LLM is unavailable) ──
  let title = taskTitles.length > 0
    ? `Episode: ${taskTitles[0].slice(0, 60)}`
    : `Episode ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const firstUserTurn = contextMemory._buffer.find((m) => m.role === 'user');
  const previewSource = firstUserTurn?.content || contextMemory._buffer[0]?.content || '';
  let description = previewSource
    .replace(/\s+/g, ' ')
    .slice(0, _DESCRIPTION_PREVIEW_CHARS)
    .trim();
  let llmSummary = null;

  // ── Large episodes: enrich title + description via LLM ──
  if (isLarge) {
    const llm = makeLlmAdapter();
    if (!isNullLlm(llm)) {
      try {
        const truncated = transcript.length > _MAX_SUMMARY_INPUT_CHARS
          ? transcript.slice(0, _MAX_SUMMARY_INPUT_CHARS) + '\n\n[…truncated…]'
          : transcript;
        const response = await llm.chat([
          { role: 'system', content: _SUMMARY_PROMPT },
          { role: 'user', content: truncated },
        ], { maxTokens: 300, temperature: 0 });
        if (typeof response === 'string') {
          const match = response.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (typeof parsed.title === 'string' && parsed.title.trim()) {
              title = parsed.title.trim();
            }
            if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
              llmSummary = parsed.summary.trim();
              description = llmSummary.slice(0, _DESCRIPTION_PREVIEW_CHARS);
            }
          }
        }
      } catch {
        // LLM fail → keep the raw fallbacks above.
      }
    }
  }

  // ── Body structure ──
  // Small episodes: just transcript (the transcript IS the summary).
  // Large episodes with LLM summary: ## Summary (visible) + ## Transcript
  // (loaded on-demand via read_memory).
  let body;
  if (llmSummary) {
    body = `## Summary\n\n${llmSummary}\n\n## Transcript\n\n${transcript}`;
  } else {
    body = `## Transcript\n\n${transcript}`;
  }

  let result = null;
  try {
    result = await memory.write({
      title,
      description,
      type: 'episode',
      project: planId ? [`_plan_${planId}`, '_episode'] : ['_episode'],
      body,
    });
  } catch {
    result = null;
  }

  // Always reset the buffer, even if the write failed.
  contextMemory.resetTurnBuffer();

  return result ? { title: result.title, path: result.path, summarised: !!llmSummary } : null;
}

/**
 * Compact every agent reachable from `rootAgent` (root + members of any
 * teams it owns). Convenience wrapper for the task-manager drain hook.
 *
 * @param {object} rootAgent
 * @param {{ taskTitles?: string[], planId?: string }} [opts]
 */
export async function compactAllAgents(rootAgent, opts = {}) {
  if (!rootAgent) return [];
  const seen = new Set();
  const agents = [];
  const visit = (a) => {
    if (!a || seen.has(a)) return;
    seen.add(a);
    agents.push(a);
    for (const team of (a.usesTeams || [])) {
      for (const member of Object.values(team?.members || {})) {
        if (member) visit(member);
      }
    }
  };
  visit(rootAgent);

  const out = [];
  for (const a of agents) {
    if (!a.contextMemory) continue;
    try {
      const r = await compactSessionToEpisode({
        contextMemory: a.contextMemory,
        agentName: a.name,
        taskTitles: opts.taskTitles ?? [],
        planId: opts.planId ?? null,
      });
      if (r) out.push({ agent: a.name, ...r });
    } catch {
      // Per-agent compaction failure shouldn't block the rest.
    }
  }
  return out;
}
