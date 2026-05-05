/**
 * Event Log reader.
 *
 * Streams or eagerly loads JSONL session logs. Used by:
 *   - Memory Extractor — to derive notes from event sequences.
 *   - Context Compiler — for the `event_log` slot source.
 *   - `koi log <session>` debug command.
 *   - Replay tooling.
 */

import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

/**
 * Async iterator over events in a session log. Streams line by line so it
 * scales to large logs without buffering.
 *
 * @param {string} vaultRoot
 * @param {string} sessionId
 * @yields {object} Event
 */
export async function* stream(vaultRoot, sessionId) {
  const logPath = path.join(vaultRoot, 'ops', 'sessions', `${sessionId}.jsonl`);
  let exists = true;
  try { await fs.access(logPath); } catch { exists = false; }
  if (!exists) return;

  const rl = createInterface({
    input: createReadStream(logPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // Skip malformed lines — log corruption is non-fatal.
    }
  }
}

/**
 * Eagerly load all events from a session log into memory.
 * Convenient for short logs and tests; for large logs prefer stream().
 *
 * @param {string} vaultRoot
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {string[]} [opts.types]  Filter by event type.
 * @param {string} [opts.actor]    Filter by actor.
 * @param {number} [opts.limit]    Max events to return (most recent).
 * @returns {Promise<object[]>}
 */
export async function load(vaultRoot, sessionId, opts = {}) {
  const events = [];
  for await (const evt of stream(vaultRoot, sessionId)) {
    if (opts.types && !opts.types.includes(evt.type)) continue;
    if (opts.actor && evt.actor !== opts.actor) continue;
    events.push(evt);
  }
  if (typeof opts.limit === 'number') {
    return events.slice(-opts.limit);
  }
  return events;
}

/**
 * List all session ids that have a log file in the vault.
 *
 * @param {string} vaultRoot
 * @returns {Promise<string[]>} Session ids, sorted by mtime descending.
 */
export async function listSessions(vaultRoot) {
  const dir = path.join(vaultRoot, 'ops', 'sessions');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name);

  // Sort by mtime descending — most recent first.
  const withStats = await Promise.all(
    files.map(async (f) => {
      const stat = await fs.stat(path.join(dir, f));
      return { id: f.replace(/\.jsonl$/, ''), mtime: stat.mtimeMs };
    }),
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats.map((s) => s.id);
}

/**
 * Replay events from the log up to (and optionally including) a given event.
 * Yields events in chronological order. The caller decides what state to
 * accumulate — replay() is just a directed read.
 *
 * @param {string} vaultRoot
 * @param {string} sessionId
 * @param {string} [untilEventId]  If provided, stop after yielding this event.
 */
export async function* replay(vaultRoot, sessionId, untilEventId) {
  for await (const evt of stream(vaultRoot, sessionId)) {
    yield evt;
    if (untilEventId && evt.id === untilEventId) return;
  }
}
