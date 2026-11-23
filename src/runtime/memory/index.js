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
import { initDB } from './rmh/engine.js';
import { initQValueTables, updateQ } from './rmh/qvalue.js';
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
  // Titles surfaced by retrieve() this session. When a later write() cites
  // one via a [[wiki-link]], that's a forward citation → RL reward. Map so
  // each note is credited at most once per session.
  retrievedThisSession: new Map(),
  // Per-scope cached vault index (titles + frontmatter + link graph) for
  // promote's link/area suggestions. Built once, patched incrementally per
  // promoted note, so add_memory doesn't re-read the whole vault each time.
  promoteCache: new Map(),
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
// ─── Snapshot cache ─────────────────────────────────────────────────────────
// The retrieval snapshot (link graph, note index, graph metrics, BM25 index, vectors loaded from SQLite) is built
// from the notes, held in memory and reused for every retrieve until the notes change (23/11/2026). It used to be
// rebuilt from scratch on EVERY retrieve («For v1, snapshot is per-call… Cache later»), and the context compiler
// retrieves before every model call. «Changed» is a signature of the notes folder: each .md file's path, size and
// modification time (stat only, nothing is read), so a note written by this process or by any other is seen.
const _snapshots = new Map(); // vaultRoot → { signature, snapshot }

async function _notesSignature(notesDir) {
  const parts = [];
  const walk = async (dir) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.md')) {
        try { const st = await fs.stat(full); parts.push(`${full}:${st.size}:${st.mtimeMs}`); } catch { /* gone meanwhile */ }
      }
    }
  };
  await walk(notesDir);
  parts.sort();
  return parts.join('|');
}

async function _snapshotFor(vaultRoot) {
  const signature = await _notesSignature(getVaultPaths(vaultRoot).notes);
  const cached = _snapshots.get(vaultRoot);
  if (cached && cached.signature === signature) return cached.snapshot;
  const snapshot = await buildSnapshot({ vaultRoot });
  _snapshots.set(vaultRoot, { signature, snapshot });
  // The replaced snapshot's SQLite handle is closed a little later, so a retrieve still using it can finish.
  if (cached?.snapshot?.db && cached.snapshot.db !== snapshot.db) {
    const old = cached.snapshot.db;
    setTimeout(() => { try { old.close(); } catch { /* already closed */ } }, 30_000).unref?.();
  }
  return snapshot;
}

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
    retrievedThisSession: new Map(),
    promoteCache: new Map(),
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
 * Idempotent lazy init from an agent. Used by tool handlers (add_memory,
 * recall_memory, …) so they can transparently use memory without the runtime
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
  const llmProvider = agent?.llmProvider;

  // Resolve an embedding provider. Three places to look, in order:
  //   1. agent.embeddingProvider — explicit, if a caller wired one.
  //   2. llmProvider itself — Koi's LLMProvider duck-types as an embedding
  //      provider via its public getEmbedding/getEmbeddingDim methods. Those
  //      lazy-create the internal _embeddingProvider on first call, so we
  //      MUST go through the methods, not poke at the private field (which
  //      is null until then — that was the source of the "Memory unavailable"
  //      bug seen in the chat).
  //   3. Direct llmProvider._embeddingProvider / .embeddingProvider — last-
  //      ditch shapes for any non-Koi providers that pre-instantiate.
  let embeddingProvider = agent?.embeddingProvider ?? null;
  if (!embeddingProvider && llmProvider && typeof llmProvider.getEmbedding === 'function') {
    embeddingProvider = {
      getEmbedding: (t) => llmProvider.getEmbedding(t),
      getEmbeddingDim: () => llmProvider.getEmbeddingDim(),
    };
  }
  if (!embeddingProvider) {
    embeddingProvider = llmProvider?._embeddingProvider
      ?? llmProvider?.embeddingProvider
      ?? null;
  }

  if (!embeddingProvider) {
    throw new Error('memory.ensureInit: no embedding provider available on agent or its llmProvider');
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
  _snapshots.clear(); // a note is coming in: the next retrieve rebuilds the snapshot with it
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

  // RL reward: any note this new note cites via [[wiki-link]] that we
  // surfaced earlier this session was clearly useful → reinforce it.
  _rewardForwardCitations(note.body ?? '');

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
 * Close the RL loop: scan a freshly written note's body for [[wiki-links]]
 * to notes we retrieved earlier this session and reward each one (reward=1,
 * the strongest signal in rmh/reward.js). Credit is one-shot per session —
 * a cited note is removed from the tracking set so it isn't double-counted.
 * Best-effort: a failure here must never break a memory write.
 */
function _rewardForwardCitations(body) {
  try {
    if (!body || _state.retrievedThisSession.size === 0) return;
    const links = body.match(/\[\[([^\]]+)\]\]/g) || [];
    if (links.length === 0) return;
    const cited = [];
    for (const raw of links) {
      const title = raw.slice(2, -2).trim();
      if (_state.retrievedThisSession.has(title)) cited.push(title);
    }
    if (cited.length === 0) return;

    const dbPath = path.resolve(_state.vaultRoot, _state.config.engine.db_path);
    const db = initDB(dbPath);
    try {
      initQValueTables(db);
      for (const title of cited) {
        updateQ(db, title, 1, _state.sessionId);
        _state.retrievedThisSession.delete(title);
      }
    } finally {
      db.close();
    }
  } catch {
    // Reward is non-critical — swallow and move on.
  }
}

/**
 * List notes by filter (no ranking by query — just enumeration).
 * Used by callers that want all notes of a given type/project, e.g.
 * `recall_memory` with no query. Sorted by `created` desc.
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
 * Retrieve relevant notes by query. Full multi-signal pipeline: composite
 * vector (vitality-weighted) + BM25 + PPR graph expansion + warmth, fused
 * via RRF, then re-ranked by learned Q-value + UCB exploration. Surfaced
 * notes are logged for RL credit; forward citations in later write()s feed
 * the reward back.
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

  const snapshot = await _snapshotFor(scope === 'project' ? _state.vaultRoot : scopePaths.root);
  const results = await runRetrieve(snapshot, opts.query, {
    limit: opts.limit,
    filter: opts.filter,
    sessionId: _state.sessionId,
    agent: opts.agent,
  });

  // Remember what we surfaced so a later write() that cites one of these
  // notes can reward it (forward citation → RL credit). First-wins so the
  // best (earliest) rank is what gets credited.
  for (const r of results) {
    if (!_state.retrievedThisSession.has(r.title)) {
      _state.retrievedThisSession.set(r.title, true);
    }
  }

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
  const scopePaths = _resolveScopePaths(scope);
  // Reuse a cached vault index instead of re-reading + re-parsing EVERY note
  // on every save. The agent is the only writer within a session, so the
  // cache is kept exact by patching in each promoted note incrementally
  // (O(1)) rather than rebuilding it (O(N file reads)). This index only
  // feeds promote's link/area suggestions; retrieval builds its own fresh
  // snapshot, so a little staleness here never affects recall.
  const vault = await _ensurePromoteVaultIndex(scope, scopePaths);
  const existingTitles = [...vault.titles];
  const vaultIndex = { titles: existingTitles, frontmatter: vault.frontmatter, graph: vault.graph };

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

  const promotedTitle = path.basename(promo.destinationFilename, '.md');
  // Patch the cached index so the NEXT save sees this note without a re-read.
  _addToPromoteVaultIndex(scope, promotedTitle, promo.updatedFrontmatter, promo.updatedBody);

  // NOTE: semantic (embedding) indexing is deferred to retrieve()'s snapshot.
  // The old inline indexNote call here was a no-op (wrong arg shape → always
  // threw) plus a full extra vault read, so it's removed rather than fixed —
  // fixing it would put an embedding round-trip on the save path (rejected:
  // saves must stay network-free).
  return { title: promotedTitle, status: 'active', path: destPath };
}

/**
 * Lazily build (once per scope per session) the vault index that promote's
 * link/area suggestions need — titles + frontmatter map + wiki-link graph —
 * then keep it fresh via _addToPromoteVaultIndex. Replaces the O(N) full
 * re-read that used to run on every add_memory.
 */
async function _ensurePromoteVaultIndex(scope, scopePaths) {
  let cache = _state.promoteCache.get(scope);
  if (cache) return cache;
  const titles = await listNoteTitles(scopePaths.notes);
  const noteIndex = await buildNoteIndex(scopePaths.notes, titles);
  const linkGraph = await buildGraph(scopePaths.notes);
  cache = {
    titles: new Set(titles),
    frontmatter: noteIndex.frontmatter,
    graph: linkGraph,
  };
  _state.promoteCache.set(scope, cache);
  return cache;
}

/** Patch a freshly promoted note into the cached vault index (O(1)), so the
 *  next save reflects it without re-reading the whole vault. */
function _addToPromoteVaultIndex(scope, title, frontmatter, body) {
  const cache = _state.promoteCache.get(scope);
  if (!cache) return;
  cache.titles.add(title);
  cache.frontmatter.set(title, frontmatter);
  const out = new Set();
  for (const m of String(body || '').matchAll(/\[\[([^\]]+)\]\]/g)) {
    const t = m[1]?.trim();
    if (t) out.add(t);
  }
  cache.graph.outgoing.set(title, out);
  for (const tgt of out) {
    let inc = cache.graph.incoming.get(tgt);
    if (!inc) { inc = new Set(); cache.graph.incoming.set(tgt, inc); }
    inc.add(title);
  }
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

// ─── read() — fetch the full content of a single note ──────────────────
//
// Default retrieval (recall_memory / explore_memory) returns title + score
// + frontmatter (description, type, project…) but NOT the body. That's
// the right default — the agent gets a discriminating preview without
// loading walls of text. When the preview is not enough — typically for
// `episode` notes whose body holds a `## Transcript` of past turns the
// agent now needs to inspect — the agent calls `read({title})`.

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.scope='project']
 * @returns {Promise<{title, frontmatter, body}|null>}
 *          null if the note doesn't exist.
 */
export async function read(opts = {}) {
  _ensureInit();
  if (!opts.title || typeof opts.title !== 'string') {
    throw new Error('memory.read: title (string) required');
  }
  const scope = opts.scope || 'project';
  const scopePaths = _resolveScopePaths(scope);
  const filePath = path.join(scopePaths.notes, `${opts.title}.md`);
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    // Note may live in inbox if it wasn't auto-promoted yet.
    const inboxPath = path.join(scopePaths.inbox, `${opts.title}.md`);
    try {
      content = await fs.readFile(inboxPath, 'utf8');
    } catch {
      return null;
    }
  }
  // Inline frontmatter parse (avoids pulling rmh into the public surface
  // for a one-off read that already lives behind memory.write/list).
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { title: opts.title, frontmatter: {}, body: content };
  let frontmatter = {};
  try { frontmatter = yaml.parse(m[1]) || {}; } catch { /* keep empty */ }
  return { title: opts.title, frontmatter, body: m[2].trim() };
}

// ─── explore() — multi-hop graph traversal (RMH explore.js) ─────────────
//
// Wraps rmh/explore.js's exploreRecursive with the snapshot setup that
// runRetrieve uses for seeding. The LLM provider configured at init() drives
// sub-question decomposition; if no LLM is configured (NullProvider), explore
// degrades to a single-pass result identical to retrieve().

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {object} [opts.filter]    { type, status, project }
 * @param {number} [opts.limit]     Default 8.
 * @param {number} [opts.depth]     1=shallow, 2=standard, 3=deep. Default 2.
 * @param {string} [opts.scope='project']
 * @param {string} [opts.agent]
 * @returns {Promise<{
 *   results: Array<{title, score, source, frontmatter, snippet?}>,
 *   paths: Array<{from, to, via}>,
 *   subQueries: string[],
 *   converged: boolean,
 *   recursionDepth: number,
 *   perPassResults: Array<{query, depth, notesFound, newNotesAdded}>,
 * }>}
 */
export async function explore(opts = {}) {
  _ensureInit();
  if (!opts.query || typeof opts.query !== 'string') {
    throw new Error('memory.explore: query (string) required');
  }
  const scope = opts.scope || 'project';
  const scopePaths = _resolveScopePaths(scope);

  const snapshot = await _snapshotFor(scope === 'project' ? _state.vaultRoot : scopePaths.root);

  if (snapshot.titles.length === 0) {
    await eventLog.append(eventTypes.MemoryRetrieved, opts.agent || 'system', {
      query: opts.query,
      mode: 'explore',
      scope,
      results: [],
    });
    return {
      results: [],
      paths: [],
      subQueries: [],
      converged: true,
      recursionDepth: 0,
      perPassResults: [],
    };
  }

  // Seed via the same single-pass pipeline retrieve() uses.
  const seedResults = await runRetrieve(snapshot, opts.query, {
    limit: (opts.limit ?? 8) * 2,
    filter: opts.filter,
  });

  const { explore: rmhExplore, exploreRecursive } = await import('./rmh/explore.js');
  const { classifyIntent } = await import('./rmh/intent.js');
  const { makeLlmAdapter } = await import('./rmh/_koi-bridge.js');
  // makeLlmAdapter() with no arg falls back to the bridge's wired _llmProvider
  // (set by configureKoiBridge at init). If unwired, returns NullLLM and
  // exploreRecursive degrades to single-pass internally via isNullLlm().
  const llmAdapter = makeLlmAdapter();

  const classified = classifyIntent(opts.query, snapshot.titles);
  const exploreConfig = {
    ...snapshot.config.explore,
    default_limit: opts.limit ?? snapshot.config.explore.default_limit,
  };
  if (typeof opts.depth === 'number') {
    const base = exploreConfig.ppr_iterations;
    exploreConfig.ppr_iterations = opts.depth <= 1 ? Math.round(base * 0.5)
      : opts.depth >= 3 ? Math.round(base * 1.67)
      : base;
  }

  const reseed = async (subQuery) => {
    const sub = await runRetrieve(snapshot, subQuery, {
      limit: (opts.limit ?? 8) * 2,
      filter: opts.filter,
    });
    return sub;
  };

  const exploreParams = {
    query: opts.query,
    classified,
    linkGraph: snapshot.linkGraph,
    notesDir: snapshot.paths.notes,
    warmthSignals: new Map(),
    flatResults: seedResults,
    config: exploreConfig,
    qValueLookup: () => 0.5,
    seedResults,
    llmProvider: llmAdapter,
    allTitles: snapshot.titles,
    reseed,
  };

  let result;
  try {
    result = await exploreRecursive(exploreParams);
  } catch (err) {
    // Fall back to single-pass on any explore error (LLM failure, etc.)
    const single = await rmhExplore(exploreParams);
    result = {
      ...single,
      recursionDepth: 0,
      subQueries: [],
      converged: false,
      perPassResults: [{ query: opts.query, depth: 0, notesFound: single.results.length, newNotesAdded: single.results.length }],
    };
  }

  // Hydrate frontmatter for caller
  const hydrated = result.results.map((r) => {
    const fm = snapshot.noteIndex.frontmatter.get(r.title) || {};
    return { ...r, frontmatter: fm };
  });

  await eventLog.append(eventTypes.MemoryRetrieved, opts.agent || 'system', {
    query: opts.query,
    mode: 'explore',
    scope,
    sub_queries: result.subQueries,
    converged: result.converged,
    results: hydrated.map((r) => ({ title: r.title, score: r.score })),
  });

  return {
    results: hydrated,
    paths: result.paths || [],
    subQueries: result.subQueries || [],
    converged: !!result.converged,
    recursionDepth: result.recursionDepth || 0,
    perPassResults: result.perPassResults || [],
  };
}

// ─── getStatus() — vault snapshot for orient/diagnostic ─────────────────
//
// Mirrors Ori's `health` / `status` output. Cheap enough to call at the
// start of a task: counts notes, breaks them down by type and project,
// surfaces the lowest-vitality notes ("fading"), and returns recent
// memory writes from the event log.

/**
 * @param {object} [opts]
 * @param {number} [opts.fadingLimit=5]
 * @param {number} [opts.recentLimit=10]
 * @param {string} [opts.scope='project']
 * @returns {Promise<{
 *   noteCount: number,
 *   inboxCount: number,
 *   types: Record<string, number>,
 *   projects: Record<string, number>,
 *   fading: Array<{title: string, vitality: number}>,
 *   recent: Array<{title: string, type: string|null, agent: string, ts: string}>,
 *   vaultRoot: string,
 *   vaultSource: string,
 * }>}
 */
export async function getStatus(opts = {}) {
  _ensureInit();
  const scope = opts.scope || 'project';
  const scopePaths = _resolveScopePaths(scope);
  const fadingLimit = opts.fadingLimit ?? 5;
  const recentLimit = opts.recentLimit ?? 10;

  // Note count + breakdowns
  const titles = await listNoteTitles(scopePaths.notes);
  const noteIndex = titles.length > 0
    ? await buildNoteIndex(scopePaths.notes, titles)
    : { frontmatter: new Map() };

  const types = {};
  const projects = {};
  for (const title of titles) {
    const fm = noteIndex.frontmatter.get(title) || {};
    const t = fm.type || 'unspecified';
    types[t] = (types[t] || 0) + 1;
    const projs = Array.isArray(fm.project) ? fm.project : [];
    for (const p of projs) projects[p] = (projects[p] || 0) + 1;
  }

  // Inbox count
  let inboxCount = 0;
  try {
    const entries = await fs.readdir(scopePaths.inbox);
    inboxCount = entries.filter((f) => f.endsWith('.md')).length;
  } catch { /* inbox dir may not exist yet */ }

  // Fading: notes whose `created` date is oldest and that have low or
  // unknown confidence. A cheap proxy for ACT-R vitality without needing a
  // full snapshot — vitality.computeAllVitality requires linkGraph + bridges
  // + config + boost scores which is way too much for a status call.
  // Returns notes sorted by created ASC; caller can interpret.
  const fading = [];
  if (titles.length > 0 && fadingLimit > 0) {
    const candidates = [];
    for (const title of titles) {
      const fm = noteIndex.frontmatter.get(title) || {};
      candidates.push({
        title,
        created: fm.created || '',
        confidence: fm.confidence || null,
      });
    }
    candidates.sort((a, b) => {
      // Speculative first, then oldest created date.
      const ca = a.confidence === 'speculative' ? 0 : 1;
      const cb = b.confidence === 'speculative' ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return a.created.localeCompare(b.created);
    });
    for (const c of candidates.slice(0, fadingLimit)) {
      fading.push({ title: c.title, created: c.created, confidence: c.confidence });
    }
  }

  // Recent writes from the event log (last N MemoryWritten events)
  const recent = [];
  try {
    const sid = _state.sessionId;
    if (sid) {
      const events = await eventLog.load(_state.vaultRoot, sid, {
        types: [eventTypes.MemoryWritten],
        limit: recentLimit,
      });
      for (const e of events) {
        recent.push({
          title: e.payload?.title ?? '(unknown)',
          type: e.payload?.type ?? null,
          agent: e.actor || e.agent || 'system',
          ts: e.ts || e.timestamp || '',
        });
      }
    }
  } catch { /* event log read is best-effort */ }

  return {
    noteCount: titles.length,
    inboxCount,
    types,
    projects,
    fading,
    recent,
    vaultRoot: _state.vaultRoot,
    vaultSource: _state.vaultSource,
  };
}

// Re-exports for convenience
export { eventLog };
export const types = eventTypes;
