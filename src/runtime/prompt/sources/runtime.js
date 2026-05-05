/**
 * Runtime source — calls a registered provider function from the host.
 *
 * Slot config:
 *   { source: 'runtime', provider: 'extractAffordances', args: { agent: 'planner' } }
 *
 * Providers are registered via registerProvider(name, fn). The host wires
 * its runtime-specific data sources (available agents, tool affordances,
 * working directory, etc.) without the slot resolver knowing about them.
 *
 * Provider fn signature: async (args, ctx) => string
 */

const _providers = new Map();

export function registerProvider(name, fn) {
  if (typeof fn !== 'function') throw new Error('runtime source: fn must be function');
  _providers.set(name, fn);
}

export function _clearProviders() {
  _providers.clear();
}

export async function resolve(slotConfig, ctx) {
  const name = slotConfig.provider;
  if (!name) throw new Error('runtime source: provider required');
  const fn = _providers.get(name);
  if (!fn) {
    // Unknown provider — return empty so missing wiring doesn't crash compile.
    return '';
  }
  const result = await fn(slotConfig.args || {}, ctx);
  if (result == null) return '';
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}
