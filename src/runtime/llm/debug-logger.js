import { channel } from '../io/channel.js';

/**
 * Truncate long base64-like payloads so they don't flood the console.
 * Keeps first 20 chars … last 10 chars so the output stays readable.
 */
function _truncB64Debug(str) {
  return str.replace(/[A-Za-z0-9+/]{60,}={0,2}/g, m => `${m.slice(0, 20)}\u2026${m.slice(-10)}`);
}

/**
 * Format text for debug output with gray color.
 * Truncates long base64-like payloads so they don't flood the console.
 */
export function formatDebugText(text) {
  const str = Array.isArray(text)
    ? text.map(p => p.type === 'text' ? p.text : `[${p.type}]`).join('\n')
    : String(text ?? '');
  const lines = _truncB64Debug(str).split('\n');
  return lines.map(line => `> \x1b[90m${line}\x1b[0m`).join('\n');
}

/**
 * Log LLM request (system + user prompts)
 */
export function logRequest(model, systemPrompt, userPrompt, context = '', cacheBoundary = 0) {
  if (process.env.KOI_DEBUG_LLM !== '1') return;

  const W = 80;
  const CYAN = '\x1b[36m';
  const YELLOW = '\x1b[33m';
  const GREEN = '\x1b[32m';
  const DIM = '\x1b[2m';
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';

  console.error(DIM + '─'.repeat(W) + RESET);
  console.error(`${BOLD}[LLM Debug]${RESET} Request - Model: ${CYAN}${model}${RESET}${context ? ' | ' + context : ''}`);

  // System prompt with cache boundary visualization
  const sysText = Array.isArray(systemPrompt)
    ? systemPrompt.map(p => p.type === 'text' ? p.text : `[${p.type}]`).join('\n')
    : String(systemPrompt ?? '');

  if (cacheBoundary > 0 && cacheBoundary < sysText.length) {
    const staticPart = sysText.substring(0, cacheBoundary);
    const dynamicPart = sysText.substring(cacheBoundary);
    const staticLines = staticPart.split('\n').length;
    const dynamicLines = dynamicPart.split('\n').length;
    const staticChars = staticPart.length;
    const dynamicChars = dynamicPart.length;

    // Static header
    console.error(`${GREEN}${BOLD}${'─'.repeat(4)} STATIC PROMPT (${staticLines} lines, ${staticChars} chars) ${'─'.repeat(Math.max(0, W - 38 - String(staticLines).length - String(staticChars).length))}${RESET}`);
    const sLines = _truncB64Debug(staticPart).split('\n');
    for (const line of sLines) console.error(`${GREEN}>${RESET} ${DIM}${line}${RESET}`);

    // Dynamic header
    console.error(`${YELLOW}${BOLD}${'─'.repeat(4)} DYNAMIC PROMPT (${dynamicLines} lines, ${dynamicChars} chars) ${'─'.repeat(Math.max(0, W - 39 - String(dynamicLines).length - String(dynamicChars).length))}${RESET}`);
    const dLines = _truncB64Debug(dynamicPart).split('\n');
    for (const line of dLines) console.error(`${YELLOW}>${RESET} ${DIM}${line}${RESET}`);
  } else {
    console.error('System Prompt:');
    console.error(formatDebugText(systemPrompt));
  }

  console.error('============');
  console.error('User Prompt:');
  console.error('============');
  console.error(formatDebugText(userPrompt));
  console.error(DIM + '─'.repeat(W) + RESET);
}

/**
 * Log LLM response
 */
export function logResponse(content, context = '', usage = null) {
  if (process.env.KOI_DEBUG_LLM !== '1') return;

  const W = 80;
  const DIM = '\x1b[2m';
  const CYAN = '\x1b[36m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const MAGENTA = '\x1b[35m';
  const BOLD = '\x1b[1m';
  const RST = '\x1b[0m';
  const fmtTk = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  let usageStr = '';
  if (usage) {
    const parts = [];
    if (usage.input)       parts.push(`${CYAN}↑${fmtTk(usage.input)} in${RST}`);
    if (usage.cachedInput) parts.push(`${GREEN}⚡${fmtTk(usage.cachedInput)} cached${RST}`);
    if (usage.thinking)    parts.push(`${MAGENTA}💭${fmtTk(usage.thinking)} thinking${RST}`);
    if (usage.output)      parts.push(`${YELLOW}↓${fmtTk(usage.output)} out${RST}`);
    if (parts.length > 0) usageStr = '  ' + parts.join('  ');
  }

  console.error(`\n${BOLD}[LLM Debug]${RST} Response${context ? ' - ' + context : ''} (${content.length} chars)${usageStr}`);
  console.error(DIM + '─'.repeat(W) + RST);

  // Try to format JSON for better readability
  let formattedContent = content;
  try {
    const parsed = JSON.parse(content);
    formattedContent = JSON.stringify(parsed, null, 2);
  } catch (e) {
    // Not JSON, use as is
  }

  const lines = _truncB64Debug(formattedContent).split('\n');
  for (const line of lines) {
    console.error(`< \x1b[90m${line}\x1b[0m`);
  }
  console.error('─'.repeat(80));
}

/**
 * Log simple message
 */
export function logDebug(message) {
  if (process.env.KOI_DEBUG_LLM !== '1') return;
  console.error(`[LLM Debug] ${message}`);
}

/**
 * Log error
 */
export function logError(message, error) {
  if (process.env.KOI_DEBUG_LLM !== '1') return;
  console.error(`[LLM Debug] ERROR: ${message}`);
  if (error) {
    console.error(error.stack || error.message);
  }
}
