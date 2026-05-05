/**
 * Koi Memory — public API.
 *
 *   init({ embeddingProvider, llmProvider, sessionId, projectRoot })
 *   write({ type, description, project, body, ... })       → title
 *   retrieve({ query, filter, limit, scope, agent })        → ScoredNote[]
 *   getVaultRoot()
 *
 * Layered architecture (per the plan):
 *
 *   index.js (this file)
 *      ├── _orchestrator.js   — retrieve pipeline (BM25 + composite + RRF)
 *      ├── vault.js           — vault paths + init scaffold
 *      ├── embedding.js       — adapter for Koi's EmbeddingProvider
 *      ├── event-log/         — append-only JSONL log of session events
 *      └── rmh/               — vendored Ori-Mnemos retrieval engine
 *
 * Calling convention: `init` configures the rmh bridge with Koi's runtime
 * providers. After init, all rmh primitives that need an embedding or LLM
 * call route through the bridge. The event log emits MemoryWritten /
 * MemoryRetrieved events automatically from this layer.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

import { configureKoiBridge } from './rmh/_koi-bridge.js';
import { computePromotion } from './rmh/promote.js';
import { listNoteTitles, getVaultPaths, getAgentScopePaths } from './rmh/vault.js';
import { parseFrontmatter } from './rmh/frontmatter.js';
import { buildNoteIndex } from './rmh/noteindex.js';
import { buildGraph } from './rmh/graph.js';
import { initDB, indexNote } from './rmh/engine.js';
import { loadConfig } from './rmh/config.js';

import { buildSnapshot, runRetrieve } from './_orchestrator.js';
import { resolveVault } from './vault.js';
import { makeEmbeddingAdapter } from './embedding.js';
import * as eventLog from './event-log/index.js';
import * as eventTypes from './event-log/types.js';

let _state = {
  initialized: false,
  vaultRoot: null,
  vaultSource: null,    // 'project' | 'global'
  config: null,
  sessionId: null,
  snapshot: null,       // lazy
  snapshotMtime: null,  // for cache invalidation
};

/**
 * Initialize memory subsystem. Idempotent if called with the same args.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.sessionId
 * @param {object} opts.embeddingProvider  Koi EmbeddingProvider instance.
 * @param {object} [opts.llmProvider]      Koi LLMProvider instance (optional, only needed for explore multi-hop).
 * @param {boolean} [opts.create=true]     Auto-create project vault if missing.
 * @returns {Promise<{vaultRoot: string, vaultSource: string, created: boolean}>}
 */
export async function init({ projectRoot, sessionId, embeddingProvider, llmProvider, create = true }) {
  if (!projectRoot) throw new Error('memory.init: projectRoot required');
  if (!sessionId) throw new Error('memory.init: sessionId required');
  if (!embeddingProvider) throw new Error('memory.init: embeddingProvider required');

  const { path: vaultRoot, source, created } = await resolveVault({ projectRoot, create });
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);

  // Wire rmh/_koi-bridge to Koi's runtime providers + event log writer
  configureKoiBridge({
    embeddingProvider: makeEmbeddingAdapter(embeddingProvider),
    llmProvider: llmProvider ?? null,
    eventLog: { append: eventLog.append },
  });

  // Initialize the event log for this session (creates the JSONL file)
  await eventLog.init({ vaultRoot, sessionId });

  _state = {
    initialized: true,
    vaultRoot,
    vaultSource: source,
    config,
    sessionId,
    snapshot: null,
    snapshotMtime: null,
  };

  return { vaultRoot, vaultSource: source, created };
}

/**
 * Get the configured vault root, or throw if not initialized.
 */
export function getVaultRoot() {
  _ensureInit();
  return _state.vaultRoot;
}

/**
 * Idempotent lazy init from an agent. Used by tool handlers (learn_fact,
 * recall_facts, …) so they can transparently use memory without the runtime
 * having to wire `memory.init()` at startup.
 *
 * Reads projectRoot from KOI_PROJECT_ROOT and sessionId from KOI_SESSION_ID
 * (set by the binary entry point). Pulls embeddingProvider + llmProvider
 * off the agent object.
 *
 * @param {object} agent  Koi agent (with .embeddingProvider, .llmProvider, .name)
 * @returns {Promise<boolean>} true if init happened, false if already initialized.
 */
export async function ensureInit(agent) {
  if (_state.initialized) return false;
  const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
  const sessionId = process.env.KOI_SESSION_ID || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const embeddingProvider = agent?.embeddingProvider;
  const llmProvider = agent?.llmProvider;
  if (!embeddingProvider) {
    throw new Error('memory.ensureInit: agent.embeddingProvider missing');
  }
  await init({ projectRoot, sessionId, embeddingProvider, llmProvider, create: true });
  return true;
}

/** True after init(). */
export function isInitialized() { return _state.initialized; }

/**
 * Write a memory note. Goes through inbox/ and is auto-promoted to notes/
 * when the heuristic classifier is confident enough.
 *
 * @param {object} note
 * @param {string} note.title         Note title (becomes filename: <slug>.md).
 * @param {string} note.description   ≤200 chars, no trailing period.
 * @param {string} [note.type]        idea|decision|learning|insight|blocker|opportunity (auto if omitted).
 * @param {string[]} [note.project]   Project tags.
 * @param {string} [note.body=""]     Markdown body.
 * @param {string} [note.confidence]  speculative|promising|validated.
 * @param {string[]} [note.source_events]  Event log ids that motivated this note.
 * @param {string} [note.scope='project'] 'project' or 'self/<agent>'.
 * @returns {Promise<{title: string, status: 'inbox'|'active', path: string}>}
 */
export async function write(note) {
  _ensureInit();
  if (!note || !note.title) throw new Error('memory.write: title required');

  const scope = note.scope || 'project';
  const scopePaths = _resolveScopePaths(scope);

  await fs.mkdir(scopePaths.inbox, { recursive: true });

  const slug = _toSlug(note.title);
  const inboxPath = path.join(scopePaths.inbox, `${slug}.md`);

  const today = new Date().toISOString().slice(0, 10);
  const fm = {
    description: note.description ?? '',
    type: note.type,
    project: note.project ?? [],
    status: 'inbox',
    created: today,
  };
  if (note.confidence) fm.confidence = note.confidence;
  if (note.source_events) fm.source_events = note.source_events;

  const fmYaml = yaml.stringify(fm);
  const fileBody = `---\n${fmYaml}---\n\n# ${note.title}\n\n${note.body ?? ''}\n`;
  await fs.writeFile(inboxPath, fileBody, 'utf8');

  // Auto-promote if config says so
  let final = { title: slug, status: 'inbox', path: inboxPath };
  if (_state.config.promote?.auto !== false) {
    final = await _autoPromote({ inboxPath, frontmatter: fm, body: note.body ?? '', scope });
  }

  // Invalidate snapshot cache so next retrieve picks up the new note
  _state.snapshot = null;

  // Emit event
  await eventLog.append(eventTypes.MemoryWritten, 'system', {
    title: final.title,
    type: fm.type ?? null,
    scope,
    source_events: note.source_events ?? [],
    auto_promoted: final.status === 'active',
  });

  return final;
}

/**
 * List notes by filter (no ranking by query — just enumeration).
 * Used by callers that want all notes of a given type/project, e.g. legacy
 * `recall_facts` with no query. Sorted by `created` desc.
 *
 * @param {object} [opts]
 * @param {object} [opts.filter]  { type, status, project }
 * @param {number} [opts.limit]
 * @param {string} [opts.scope='project']
 * @returns {Promise<Array<{title, frontmatter, body?}>>}
 */
export async function list(opts = {}) {
  _ensureInit();
  const scope = opts.scope || 'project';
  const scopePaths = _resolveScopePaths(scope);
  const titles = await listNoteTitles(scopePaths.notes);
  if (titles.length === 0) return [];

  const noteIndex = await buildNoteIndex(scopePaths.notes, titles);
  const filter = opts.filter || {};
  const matched = [];
  for (const title of titles) {
    const fm = noteIndex.frontmatter.get(title);
    if (!fm) continue;
    if (!_matchFilter(fm, filter)) continue;
    matched.push({ title, frontmatter: fm });
  }
  matched.sort((a, b) => {
    const ca = a.frontmatter.created || '';
    const cb = b.frontmatter.created || '';
    return cb.localeCompare(ca);
  });
  if (typeof opts.limit === 'number') return matched.slice(0, opts.limit);
  return matched;
}

function _matchFilter(fm, filter) {
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(fm.type)) return false;
  }
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(fm.status)) return false;
  }
  if (filter.project) {
    const wanted = Array.isArray(filter.project) ? filter.project : [filter.project];
    const fmProj = Array.isArray(fm.project) ? fm.project : [];
    if (!wanted.some((w) => fmProj.includes(w))) return false;
  }
  return true;
}

/**
 * Retrieve relevant notes by query. Multi-signal: BM25 + composite vector
 * search + RRF fusion (v1 — warmth/PPR/RL come in subsequent phases).
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {object} [opts.filter]  { type, status, project }
 * @param {number} [opts.limit]
 * @param {string} [opts.scope='project']
 * @param {string} [opts.agent]   Required if scope='self'
 * @returns {Promise<Array<{title, score, frontmatter}>>}
 */
export async function retrieve(opts = {}) {
  _ensureInit();
  if (!opts.query || typeof opts.query !== 'string') {
    throw new Error('memory.retrieve: query (string) required');
  }
  const scope = opts.scope || 'project';
  const scopePaths = _resolveScopePaths(scope);

  // For v1, snapshot is per-call against the chosen scope. Cache later.
  const snapshot = await buildSnapshot({
    vaultRoot: scope === 'project' ? _state.vaultRoot : scopePaths.root,
  });
  const results = await runRetrieve(snapshot, opts.query, {
    limit: opts.limit,
    filter: opts.filter,
  });

  // Emit retrieval event for RL reward + telemetry
  await eventLog.append(eventTypes.MemoryRetrieved, opts.agent || 'system', {
    query: opts.query,
    filter: opts.filter ?? null,
    scope,
    results: results.map((r) => ({ title: r.title, score: r.score })),
  });

  return results;
}

// ─── Internals ──────────────────────────────────────────────────────────

function _ensureInit() {
  if (!_state.initialized) {
    throw new Error('memory: not initialized. Call init() first.');
  }
}

function _resolveScopePaths(scope) {
  if (scope === 'project') {
    return getVaultPaths(_state.vaultRoot);
  }
  if (scope.startsWith('self/')) {
    const agent = scope.slice('self/'.length);
    if (!agent) throw new Error('memory: scope "self/" requires an agent name');
    return getAgentScopePaths(_state.vaultRoot, agent);
  }
  if (scope === 'global') {
    // Global vault path resolution would go here (future); for v1 only project + self.
    throw new Error('memory: scope "global" not yet supported in v1');
  }
  throw new Error(`memory: unknown scope "${scope}"`);
}

async function _autoPromote({ inboxPath, frontmatter, body, scope }) {
  // Build vault index for promote (existing titles, frontmatter map, link graph)
  const scopePaths = _resolveScopePaths(scope);
  const existingTitles = await listNoteTitles(scopePaths.notes);
  const noteIndex = await buildNoteIndex(scopePaths.notes, existingTitles);
  const linkGraph = await buildGraph(scopePaths.notes);
  const vaultIndex = { titles: existingTitles, frontmatter: noteIndex.frontmatter, graph: linkGraph };

  const promotionConfig = _state.config.promote || {};
  const promo = computePromotion({
    inboxPath,
    frontmatter,
    body,
    existingTitles,
    vaultIndex,
    overrides: {
      type: frontmatter.type,
      project: frontmatter.project,
    },
    projectConfig: { keywords: promotionConfig.project_keywords ?? {} },
    mapRouting: promotionConfig.project_map_routing ?? {},
    defaultArea: promotionConfig.default_area ?? 'index',
  });

  // If classification confidence is low and no override, leave in inbox
  const minConf = promotionConfig.min_confidence ?? 0.6;
  if (promo.classification.confidence === 'low' && !frontmatter.type) {
    return { title: path.basename(inboxPath, '.md'), status: 'inbox', path: inboxPath };
  }
  // Numeric mapping for confidence levels
  const confMap = { high: 1.0, medium: 0.7, low: 0.3 };
  if (confMap[promo.classification.confidence] < minConf) {
    return { title: path.basename(inboxPath, '.md'), status: 'inbox', path: inboxPath };
  }

  // Move to notes/, write final body + frontmatter
  await fs.mkdir(scopePaths.notes, { recursive: true });
  const destPath = path.join(scopePaths.notes, promo.destinationFilename);
  const fmYaml = yaml.stringify(promo.updatedFrontmatter);
  await fs.writeFile(destPath, `---\n${fmYaml}---\n${promo.updatedBody}`, 'utf8');
  await fs.rm(inboxPath, { force: true });

  // Index it in SQLite for retrieval
  try {
    const dbPath = path.resolve(_state.vaultRoot, _state.config.engine.db_path);
    const db = initDB(dbPath);
    const fmFinal = promo.updatedFrontmatter;
    const titleSlug = path.basename(promo.destinationFilename, '.md');
    await indexNote(db, {
      title: titleSlug,
      frontmatter: fmFinal,
      body: promo.updatedBody,
      linkGraph: await buildGraph(scopePaths.notes),
      config: _state.config.engine,
      graphMetrics: null,
    });
  } catch (err) {
    // Indexing failure is non-fatal — the note exists; reindex on next retrieve.
  }

  return {
    title: path.basename(promo.destinationFilename, '.md'),
    status: 'active',
    path: destPath,
  };
}

function _toSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// ─── Conversational loop bridge (Phase 8b.2) ─────────────────────────────

/**
 * Build the conversation messages array from the event log.
 *
 * Drop-in replacement for legacy `ContextMemory.toMessages({agent})`. Used by
 * `agent.js` and `llm-provider.js` when `KOI_NEW_CONV_LOOP=1` is set —
 * otherwise those callers stay on the tiered ContextMemory path.
 *
 * Mapping (mirror of context-memory.js _emitToEventLog):
 *   UserMessage          → { role: 'user',      content: payload.content }
 *   AgentPlanned         → { role: 'assistant', content: payload.reasoning }
 *   ToolResultReceived   → { role: 'user',      content: payload.result }
 *   (everything else is skipped — those events aren't conversation turns)
 *
 * Output is run through the same consecutive-same-role merge that
 * ContextMemory.toMessages applies, so the LLM never receives two user-role
 * messages back to back when it didn't ask for them.
 *
 * @param {object} opts
 * @param {string} [opts.systemPrompt]  Prepended as `{role:'system'}` if provided.
 * @param {string} [opts.sessionId]     Defaults to current session.
 * @param {number} [opts.limit]         Cap most-recent N conversational events.
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function eventLogToMessages({ systemPrompt, sessionId, limit } = {}) {
  _ensureInit();
  const sid = sessionId ?? _state.sessionId;
  if (!sid) return systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];

  const conversational = [
    eventTypes.UserMessage,
    eventTypes.AgentPlanned,
    eventTypes.ToolResultReceived,
  ];
  const events = await eventLog.load(_state.vaultRoot, sid, {
    types: conversational,
    limit,
  });

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

  for (const e of events) {
    let role, content;
    if (e.type === eventTypes.UserMessage) {
      role = 'user';
      content = e.payload?.content ?? '';
    } else if (e.type === eventTypes.AgentPlanned) {
      role = 'assistant';
      content = e.payload?.reasoning ?? '';
    } else if (e.type === eventTypes.ToolResultReceived) {
      role = 'user';
      content = e.payload?.result ?? '';
    } else {
      continue;
    }
    if (typeof content !== 'string' || content.length === 0) continue;
    messages.push({ role, content });
  }

  // Collapse adjacent same-role messages (an emergent property of the legacy
  // tier system: an action result + a Continue. nudge would land as two
  // consecutive 'user' entries that ContextMemory then merged before sending).
  return _mergeConsecutiveMessages(messages);
}

function _mergeConsecutiveMessages(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && last.role !== 'system') {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

// Re-exports for convenience
export { eventLog };
export const types = eventTypes;
