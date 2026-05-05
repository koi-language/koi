/**
 * Trigger source — extracts data from the event that triggered compilation.
 *
 * Slot config:
 *   { source: 'trigger' }                 → entire trigger.payload as JSON
 *   { source: 'trigger', field: 'task' }  → trigger.payload.task
 *   { source: 'trigger', field: 'payload.task' }  → nested via dotted path
 *
 * Returns a string (JSON-stringified for objects).
 */

export async function resolve(slotConfig, ctx) {
  const trigger = ctx.trigger;
  if (!trigger) return '';
  if (!slotConfig.field) {
    return JSON.stringify(trigger.payload ?? {}, null, 2);
  }
  const value = _lookup(trigger, slotConfig.field);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function _lookup(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
