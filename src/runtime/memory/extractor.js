/**
 * Memory Extractor — derives memory notes from the event log.
 *
 * Architecture:
 *   ┌────────────┐  emit  ┌──────────────────┐  rule.match  ┌──────────┐
 *   │ event-log  │ ─────▶│ Extractor         │ ────────────▶│ memory.  │
 *   │ writer     │        │ (rule pipeline)   │              │ write()  │
 *   └────────────┘        └──────────────────┘              └──────────┘
 *
 * The extractor subscribes to event-log writer emissions and runs each
 * incoming event through registered rules. A rule that matches returns a
 * `MemoryCandidate` which the extractor writes to the vault inbox.
 *
 * Self-emission guard: extractor-generated `MemoryWritten` events are
 * tagged so we don't recurse infinitely.
 *
 * Built-in rules (v1 — heuristic only, no LLM):
 *   - DecisionMade → type=decision note
 *   - ErrorObserved + matching CommandExecuted success later → type=learning
 *     (deferred — needs windowed correlation, in v2)
 *
 * v2 will add:
 *   - LLM batch summarizer at TaskCompleted (compresses N events to 1 note)
 *   - Pattern detection on FileEdited frequency (entity notes)
 *   - User-defined rules via config
 */

import { emitter } from './event-log/writer.js';
import * as memory from './index.js';
import * as types from './event-log/types.js';

/**
 * @typedef {object} MemoryCandidate
 * @property {string} title
 * @property {string} description
 * @property {string} type   idea|decision|learning|insight|blocker|opportunity
 * @property {string[]} [project]
 * @property {string} [body]
 * @property {string} [confidence]  speculative|promising|validated
 * @property {string[]} [source_events]
 * @property {string} [scope]       'project' (default) | 'self/<agent>'
 */

/**
 * @typedef {object} ExtractorRule
 * @property {string} id            Unique id (for telemetry/debug).
 * @property {string[]} [eventTypes] If provided, only events of these types are passed.
 * @property {(event: object, ctx: object) => Promise<MemoryCandidate|null>} match
 *           Returns a candidate to write, or null to ignore. Throwing is treated as null.
 */

/** @type {ExtractorRule[]} */
const _rules = [];

/** @type {boolean} */
let _started = false;

/** Counters for telemetry */
const _stats = {
  eventsSeen: 0,
  candidatesProduced: 0,
  writes: 0,
  errors: 0,
};

/**
 * Register a custom extraction rule.
 *
 * @param {ExtractorRule} rule
 */
export function register(rule) {
  if (!rule || !rule.id || typeof rule.match !== 'function') {
    throw new Error('extractor.register: rule needs {id, match}');
  }
  _rules.push(rule);
}

/** Unregister all rules — for tests. */
export function _clearRules() { _rules.length = 0; }

/** @returns {object} A snapshot of stats. */
export function getStats() { return { ..._stats, rules: _rules.length }; }

/**
 * Start the extractor. Subscribes to event-log emissions. Idempotent.
 *
 * @param {object} [opts]
 * @param {object} [opts.agent]  Agent context (for memory.ensureInit if needed).
 */
export function start({ agent } = {}) {
  if (_started) return;
  _started = true;
  emitter.on('event', (event) => {
    _processEvent(event, { agent }).catch(() => { _stats.errors += 1; });
  });
}

/** Stop the extractor. Removes all listeners. */
export function stop() {
  if (!_started) return;
  emitter.removeAllListeners('event');
  _started = false;
}

async function _processEvent(event, ctx) {
  _stats.eventsSeen += 1;

  // Self-emission guard: ignore MemoryWritten events emitted by the extractor.
  if (event.type === types.MemoryWritten && event.payload?._extractor === true) return;

  for (const rule of _rules) {
    if (rule.eventTypes && !rule.eventTypes.includes(event.type)) continue;
    let candidate = null;
    try {
      candidate = await rule.match(event, ctx);
    } catch {
      continue;
    }
    if (!candidate) continue;
    _stats.candidatesProduced += 1;
    try {
      // ensureInit defensively (extractor may run before agent calls memory)
      if (ctx.agent) await memory.ensureInit(ctx.agent);
      await memory.write({
        title: candidate.title,
        description: candidate.description,
        type: candidate.type,
        project: candidate.project ?? [],
        confidence: candidate.confidence ?? 'promising',
        body: candidate.body ?? '',
        source_events: candidate.source_events ?? [event.id],
        scope: candidate.scope ?? 'project',
      });
      _stats.writes += 1;
    } catch {
      _stats.errors += 1;
    }
  }
}

// ─── Built-in rules ────────────────────────────────────────────────────

/**
 * Rule: DecisionMade → write a `decision` note.
 * The agent emits DecisionMade with payload.decision (string) and optionally
 * .alternatives, .confidence (0..1), .based_on (event ids).
 */
export const decisionMadeRule = {
  id: 'builtin:decision-made',
  eventTypes: [types.DecisionMade],
  async match(event) {
    const p = event.payload || {};
    if (!p.decision || typeof p.decision !== 'string') return null;
    const description = p.decision.length > 200 ? p.decision.slice(0, 197) + '...' : p.decision;
    const conf = typeof p.confidence === 'number'
      ? (p.confidence >= 0.8 ? 'validated' : p.confidence >= 0.5 ? 'promising' : 'speculative')
      : 'promising';
    const body = [
      p.decision,
      p.alternatives && p.alternatives.length
        ? `\n## Alternatives considered\n${p.alternatives.map((a) => `- ${a}`).join('\n')}`
        : '',
      p.rationale ? `\n## Rationale\n${p.rationale}` : '',
    ].filter(Boolean).join('\n');

    const title = _slugLikeTitle(p.decision);
    return {
      title,
      description,
      type: 'decision',
      project: p.project ?? [],
      confidence: conf,
      body,
      source_events: [event.id, ...(p.based_on ?? [])],
    };
  },
};

function _slugLikeTitle(text) {
  // Keep first sentence-ish, max ~80 chars.
  const firstSentence = text.split(/[.!?]/)[0].trim();
  return (firstSentence || text).slice(0, 80);
}

/** Convenience — registers all built-ins. Call once at runtime startup. */
export function registerBuiltins() {
  register(decisionMadeRule);
}
