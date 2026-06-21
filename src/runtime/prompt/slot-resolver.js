/**
 * Slot resolver — dispatches each slot to the right source resolver.
 *
 * Sources registered: static, trigger, memory, event_log, file, runtime.
 *
 * Loads slot maps from agents/<name>/slots.yaml on demand, with a small
 * in-memory parsed cache.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

import * as staticSrc from './sources/static.js';
import * as triggerSrc from './sources/trigger.js';
import * as memorySrc from './sources/memory.js';
import * as eventLogSrc from './sources/event-log.js';
import * as fileSrc from './sources/file.js';
import * as runtimeSrc from './sources/runtime.js';
import * as conversationsSrc from './sources/conversations.js';
import { getBuiltinSlotMap } from './builtin-slot-maps.js';

const SOURCES = {
  static: staticSrc,
  trigger: triggerSrc,
  memory: memorySrc,
  event_log: eventLogSrc,
  file: fileSrc,
  runtime: runtimeSrc,
  conversations: conversationsSrc,
};

const _slotMapCache = new Map(); // agent name → parsed slot map

/**
 * Load a slot map for an agent. Returns the parsed object.
 * Caches the parsed YAML; cache is invalidated when the file mtime changes.
 *
 * @param {string} agentName
 * @param {string} agentsRoot   Absolute path to the agents directory.
 */
export async function loadSlotMap(agentName, agentsRoot) {
  // Built-in maps win over disk: the core agents (System / Worker /
  // Planner) ship their slot maps inside the bundle as static JS so
  // they survive the pkg binary build (no FS-relative YAML lookup
  // there). Project-defined agents continue to live on disk.
  const builtin = getBuiltinSlotMap(agentName);
  if (builtin) return builtin;

  if (!agentsRoot) {
    throw new Error(`No slot map for agent "${agentName}": agentsRoot not provided and no built-in entry`);
  }
  const slotsPath = path.join(agentsRoot, agentName, 'slots.yaml');
  let stat;
  try { stat = await fs.stat(slotsPath); }
  catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`No slot map at ${slotsPath} — create agents/${agentName}/slots.yaml`);
    }
    throw err;
  }
  const cacheKey = `${agentName}::${stat.mtimeMs}`;
  if (_slotMapCache.has(cacheKey)) return _slotMapCache.get(cacheKey);

  const text = await fs.readFile(slotsPath, 'utf8');
  const parsed = yaml.parse(text);
  if (!parsed || !Array.isArray(parsed.slots)) {
    throw new Error(`${slotsPath}: must export top-level "slots:" array`);
  }
  _slotMapCache.set(cacheKey, parsed);
  return parsed;
}

/**
 * Resolve all slots in a slot map.
 *
 * @param {object} slotMap   Parsed slots.yaml content.
 * @param {object} ctx       { agent, sessionId, trigger, agentsRoot, projectRoot, ... }
 * @returns {Promise<Array<{ id, mode, content, slotConfig }>>}
 */
export async function resolveSlots(slotMap, ctx) {
  // Resolve slots CONCURRENTLY. Each slot's source is independent — they only
  // READ ctx and (memory/conversation slots) issue their own embedding +
  // vector-search round-trip; the only shared write is `ctx.warnings.push`,
  // which is safe to interleave. This used to be a serial `for await` loop, so
  // the System agent's 4 memory/conversation slots each paid their ~700ms
  // round-trip one after another (~2-3s of the per-turn recall latency). Run
  // in parallel and the wall time collapses to roughly the slowest single
  // slot. Promise.all preserves array order, so slot ordering is unchanged.
  return Promise.all(slotMap.slots.map(async (slotConfig) => {
    if (!slotConfig.id) throw new Error('slot map: every slot needs an id');
    const source = SOURCES[slotConfig.source];
    let content = '';
    if (source) {
      try {
        content = await source.resolve(slotConfig, ctx);
      } catch (err) {
        // Non-fatal: a single broken slot shouldn't kill the prompt.
        ctx.warnings?.push(`slot "${slotConfig.id}" failed: ${err.message}`);
        content = '';
      }
    }
    // Unknown source → leave empty (marked via empty content in metadata).
    return {
      id: slotConfig.id,
      mode: _normalizeBudget(slotConfig.budget),
      content: content ?? '',
      slotConfig,
    };
  }));
}

function _normalizeBudget(budget) {
  if (budget === 'fixed' || budget === 'flex') return budget;
  if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) return budget;
  // Default: numeric soft-cap of 4000 tokens per slot.
  return 4000;
}

export { registerProvider } from './sources/runtime.js';
