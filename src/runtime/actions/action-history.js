/**
 * Action History — returns a compact summary of recent actions executed by the agent.
 *
 * Used by compose prompt resolvers to include action history in the system prompt.
 * The compose template can say "include last N actions" and the generated resolver
 * calls this action to get the data, then concatenates it into the prompt.
 */

export default {
  type: 'action_history',
  intent: 'action_history',
  description:
    'Get a compact summary of the last N actions executed by this agent. ' +
    'Returns: { summary: string, total: number, step: number }. ' +
    'The summary is a formatted text listing each action with its result (ok/FAILED). ' +
    'Use this in compose prompts to give the LLM visibility into its own action history.',
  thinkingHint: () => 'Reading action history',
  hidden: true, // Not shown to the LLM as an available action — only used by compose resolvers

  schema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description: 'Number of recent actions to return (default: 15)',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'action_history', count: 15 },
  ],

  async execute(action, agent) {
    const session = agent?._activeSession;
    if (!session || !session.actionHistory || session.actionHistory.length === 0) {
      return { summary: '', total: 0, step: 0 };
    }

    const count = action.count || 15;
    const history = session.actionHistory;
    const total = history.length;
    const step = session.iteration + 1;

    // Take the last N actions
    const recent = history.slice(-count);
    if (recent.length === 0) {
      return { summary: '', total, step };
    }

    const lines = recent.map((entry, i) => {
      const idx = total - recent.length + i + 1;
      const intent = entry.action.intent || entry.action.type || '?';
      const args = _formatArgs(entry.action);
      if (entry.error) {
        return `  ${idx}. ${intent}${args} → FAILED: ${entry.error.message || entry.error}`;
      }
      const ok = entry.result?.success === false ? '→ FAILED' : '→ ok';
      return `  ${idx}. ${intent}${args} ${ok}`;
    });

    const summary = `ACTIONS SO FAR (${total} total, showing last ${recent.length}):\n${lines.join('\n')}\nSTEP: ${step}`;
    return { summary, total, step };
  },
};

/**
 * Format a compact description of an action's arguments.
 */
function _formatArgs(action) {
  const a = action;
  if (a.element) return `(element="${a.element}")`;
  if (a.cell) return `(cell="${a.cell}")`;
  if (a.direction) return `(direction="${a.direction}")`;
  if (a.startCell && a.endCell) return `(${a.startCell}→${a.endCell})`;
  if (a.text) return `(text="${a.text.length > 30 ? a.text.substring(0, 30) + '…' : a.text}")`;
  if (a.key) return `(key="${a.key}")`;
  if (a.path) return `("${a.path}")`;
  if (a.file) return `("${a.file}")`;
  if (a.command) return `("${a.command.length > 40 ? a.command.substring(0, 40) + '…' : a.command}")`;
  if (a.query) return `("${a.query}")`;
  if (a.pattern) return `("${a.pattern}")`;
  if (a.data?.description) return `("${a.data.description.substring(0, 40)}…")`;
  return '';
}
