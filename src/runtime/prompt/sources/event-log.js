/**
 * Event-log source — reads the last N events from the active session log.
 *
 * Slot config:
 *   {
 *     source: 'event_log',
 *     query: {
 *       types: ['DecisionMade', 'TaskCompleted'],
 *       last_n: 10,
 *       actor: 'planner',          // optional filter
 *     }
 *   }
 *
 * Returns a compact markdown bullet list of the matched events.
 */

import * as memory from '../../memory/index.js';

export async function resolve(slotConfig, ctx) {
  const q = slotConfig.query || {};
  const sessionId = ctx.sessionId;
  if (!sessionId) return '';

  const events = await memory.eventLog.load(memory.getVaultRoot(), sessionId, {
    types: q.types,
    actor: q.actor,
    limit: q.last_n ?? 10,
  });
  if (events.length === 0) return '';

  const lines = events.map((e) => {
    const ts = e.ts ? `${e.ts.slice(11, 19)}` : '';
    const summary = _summarizeEvent(e);
    return `- ${ts} **${e.type}** [${e.actor}] ${summary}`;
  });
  return lines.join('\n');
}

function _summarizeEvent(e) {
  const p = e.payload || {};
  if (e.type === 'UserMessage') return `"${(p.content || '').slice(0, 80)}"`;
  if (e.type === 'AgentDelegated') return `→ ${p.target}: ${(p.task || '').slice(0, 60)}`;
  if (e.type === 'DecisionMade') return `${(p.decision || '').slice(0, 80)}`;
  if (e.type === 'ToolCalled') return `${p.name}(${Object.keys(p.args || {}).join(',')})`;
  if (e.type === 'FileEdited') return `${p.op || 'edit'} ${p.path}`;
  if (e.type === 'CommandExecuted') return `\`${(p.cmd || '').slice(0, 60)}\` exit=${p.exit ?? '?'}`;
  if (e.type === 'TaskCompleted') return `${(p.task || '').slice(0, 60)} (ok=${p.ok})`;
  if (e.type === 'MemoryWritten') return `${p.title} [${p.type}]`;
  return JSON.stringify(p).slice(0, 80);
}
