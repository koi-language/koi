/**
 * Event Log public surface.
 * Re-exports writer + reader for ergonomic imports from outside the module.
 */
export * as types from './types.js';
export { append, init, currentSessionId, currentLogPath, emitter, _reset } from './writer.js';
export { stream, load, listSessions, replay } from './reader.js';
