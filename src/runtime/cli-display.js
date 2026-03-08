/**
 * CLI Display helpers for progress spinner text.
 * Separated from agent.js to avoid circular dependencies with action files.
 */

// Bold + #addae4 color for agent name, then reset
const _A = '\x1b[1m\x1b[38;2;173;218;228m';
const _R = '\x1b[0m';
// Light grey for hint/action text (lighter than token count grey)
const _G = '\x1b[38;2;185;185;185m';

/**
 * For MCP calls: "🤖 Agent 🧩 mcp tool(summary)"
 * For others: "🤖 Agent Thinking" (or desc if provided)
 */
export function buildActionDisplay(agentName, action) {
  const intent = action.intent || action.type;

  if (intent === 'call_mcp' && action.mcp && action.tool) {
    let inputSummary = '';
    if (action.input && typeof action.input === 'object' && Object.keys(action.input).length > 0) {
      const raw = JSON.stringify(action.input);
      inputSummary = raw.length > 80 ? raw.substring(0, 77) + '...' : raw;
    }
    const toolCall = inputSummary ? `${action.tool}(${inputSummary})` : action.tool;
    return `🤖 ${_A}${agentName}${_R} ${_G}🧩 ${action.mcp} ${toolCall}${_R}`;
  }

  const displayText = action.desc ? action.desc.replace(/\.\.\.$/, '') : 'Thinking';
  return `🤖 ${_A}${agentName}${_R} ${_G}${displayText}${_R}`;
}
