/**
 * CostCenter — Session-level cost and token usage tracker.
 *
 * Records per-model token usage and API call durations.
 * Provides a formatted report via getReport().
 *
 * Usage:
 *   costCenter.recordUsage(model, provider, inputTokens, outputTokens, apiMs)
 *   const report = costCenter.getReport(sessionTracker)
 */

// ─── Model Database (loaded from models.json) ─────────────────────────────
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const _modelsJson = _require('./models.json');

// Flatten { provider: { modelId: {...} } } → { modelId: { provider, ...fields } }
const MODEL_DB = {};
for (const [provider, models] of Object.entries(_modelsJson)) {
  if (provider.startsWith('_')) continue; // skip _comment and similar meta keys
  for (const [modelId, info] of Object.entries(models)) {
    MODEL_DB[modelId] = { provider, ...info };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function lookupModel(model) {
  if (MODEL_DB[model]) return MODEL_DB[model];
  // Partial match (e.g. "gpt-4o-mini-2024-07-18" → "gpt-4o-mini")
  for (const key of Object.keys(MODEL_DB)) {
    if (model.startsWith(key)) return MODEL_DB[key];
  }
  return null;
}

/**
 * Returns capability flags for a model.
 * @param {string} model
 * @returns {{ noTemperature: boolean, noMaxTokens: boolean }}
 */
export function getModelCaps(model) {
  const info = lookupModel(model);
  return {
    noTemperature: info?.noTemperature ?? false,
    noMaxTokens:   info?.noMaxTokens   ?? false,
    api:           info?.api           ?? 'chat',
  };
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtMs(ms) {
  if (ms < 1_000)  return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

function fmtUsd(usd) {
  if (usd === 0) return '$0.0000';
  if (usd < 0.000001) return '$0.000000';
  if (usd < 0.0001)   return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

// ─── CostCenter class ─────────────────────────────────────────────────────

class CostCenter {
  constructor() {
    this.sessionStart = Date.now();
    this.totalApiMs   = 0;

    // Map<model, { provider, calls, inputTokens, outputTokens, apiMs }>
    this._models = new Map();
  }

  /**
   * Record one LLM call.
   * @param {string} model      - Exact model ID (e.g. 'gpt-4o-mini')
   * @param {string} provider   - 'openai' | 'anthropic' | 'gemini'
   * @param {number} inputTokens
   * @param {number} outputTokens
   * @param {number} apiMs      - Duration of the HTTP call in ms
   */
  recordUsage(model, provider, inputTokens, outputTokens, apiMs = 0) {
    if (!this._models.has(model)) {
      this._models.set(model, { provider, calls: 0, inputTokens: 0, outputTokens: 0, apiMs: 0 });
    }
    const entry = this._models.get(model);
    entry.calls        += 1;
    entry.inputTokens  += inputTokens  || 0;
    entry.outputTokens += outputTokens || 0;
    entry.apiMs        += apiMs        || 0;

    this.totalApiMs += apiMs || 0;
  }

  /**
   * Compute lines added / removed from the session's cumulative diff.
   * @param {import('./session-tracker.js').SessionTracker|null} tracker
   * @returns {{ added: number, removed: number, files: number }}
   */
  _lineStats(tracker) {
    if (!tracker) return { added: 0, removed: 0, files: 0 };
    try {
      const diff = tracker.getDiff();
      if (!diff || diff.startsWith('(')) return { added: 0, removed: 0, files: 0 };

      let added = 0, removed = 0;
      for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
      }
      const files = tracker.getChangedFiles().length;
      return { added, removed, files };
    } catch {
      return { added: 0, removed: 0, files: 0 };
    }
  }

  /**
   * Generate a formatted cost/usage report string.
   * @param {import('./session-tracker.js').SessionTracker|null} tracker
   * @returns {string}
   */
  getReport(tracker = null) {
    const wall = Date.now() - this.sessionStart;
    const lines = this._lineStats(tracker);
    const models = [...this._models.entries()];

    const W = 52; // bar width
    const BAR  = '\x1b[2m' + '─'.repeat(W) + '\x1b[0m';
    const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;
    const DIM  = (s) => `\x1b[2m${s}\x1b[0m`;
    const CYAN = (s) => `\x1b[36m${s}\x1b[0m`;
    const GRN  = (s) => `\x1b[32m${s}\x1b[0m`;
    const YLW  = (s) => `\x1b[33m${s}\x1b[0m`;

    // IMPORTANT: pad raw strings BEFORE applying any ANSI codes.
    // ANSI escape sequences add invisible chars that break padStart/padEnd.
    const LBL  = 14; // label column width
    const VAL  =  9; // value column width (right-aligned)
    const COST =  9; // cost column width  (right-aligned)

    // row(label, value, cost?, extra?, boldCost?)
    // All padding done on plain strings; ANSI applied after.
    const row = (label, value, cost = '', extra = '', boldCost = false) => {
      const l = label.padEnd(LBL);
      const v = String(value).padStart(VAL);
      const c = cost ? String(cost).padStart(COST) : ' '.repeat(COST);
      const cColored = cost
        ? (boldCost ? `\x1b[1m${c}\x1b[0m` : `\x1b[2m${c}\x1b[0m`)
        : ' '.repeat(COST);
      const e = extra ? `  \x1b[2m${extra}\x1b[0m` : '';
      return `    \x1b[2m${l}\x1b[0m${v}  ${cColored}${e}`;
    };

    const out = [];
    out.push('');
    out.push(BOLD('Session Cost Report'));
    out.push(BAR);

    // ── Overview ──────────────────────────────────────────────────────────
    const overviewRow = (label, value) => {
      const l = label.padEnd(16);
      return `  \x1b[2m${l}\x1b[0m\x1b[36m${value}\x1b[0m`;
    };
    out.push(overviewRow('Wall time:', fmtMs(wall)));
    out.push(overviewRow('API time:', fmtMs(this.totalApiMs)));

    if (lines.added > 0 || lines.removed > 0) {
      const f = lines.files === 1 ? '1 file' : `${lines.files} files`;
      const chg = `${GRN('+' + lines.added)} ${DIM('/')} ${YLW('-' + lines.removed)} ${DIM('lines  (' + f + ')')}`;
      out.push(`  ${DIM('Code changes:   ')}${chg}`);
    } else {
      out.push(overviewRow('Code changes:', 'none'));
    }

    if (models.length === 0) {
      out.push('');
      out.push(`  ${DIM('No LLM calls recorded yet.')}`);
      out.push(BAR);
      out.push('');
      return out.join('\n');
    }

    // ── Per-model breakdown ───────────────────────────────────────────────
    let grandTotal = 0;
    let grandInput = 0, grandOutput = 0, grandCalls = 0;

    for (const [model, entry] of models) {
      const info = lookupModel(model);
      const inputCost  = info ? (entry.inputTokens  / 1_000_000) * info.inputPer1M  : null;
      const outputCost = info ? (entry.outputTokens / 1_000_000) * info.outputPer1M : null;
      const totalCost  = (inputCost ?? 0) + (outputCost ?? 0);
      grandTotal  += totalCost;
      grandInput  += entry.inputTokens;
      grandOutput += entry.outputTokens;
      grandCalls  += entry.calls;

      const ctxK   = info?.contextK ?? null;
      const ctxStr = ctxK
        ? (ctxK >= 1_000 ? ctxK / 1_000 + 'M' : ctxK + 'K') + ' ctx'
        : '? ctx';

      // Average context % per call
      const ctxPct = ctxK && entry.inputTokens > 0
        ? Math.round((entry.inputTokens / entry.calls) / (ctxK * 1_000) * 100)
        : null;
      const pctStr = ctxPct !== null ? `~${ctxPct}% avg ctx/call` : '';

      out.push('');
      out.push(BAR);
      // Header: model name + provider/ctx info + calls + api time
      const callsInfo = `${entry.calls} call${entry.calls !== 1 ? 's' : ''}  ${fmtMs(entry.apiMs)}`;
      out.push(`  ${BOLD(model)}  ${DIM('(' + entry.provider + '  ' + ctxStr + ')')}  ${DIM(callsInfo)}`);

      if (info) {
        const pricing = `$${info.inputPer1M.toFixed(2)}/1M in  ·  $${info.outputPer1M.toFixed(2)}/1M out`;
        out.push(`    \x1b[2m${'Pricing:'.padEnd(LBL)}${pricing}\x1b[0m`);
      }

      // Column header (plain, no ANSI)
      out.push(`    \x1b[2m${''.padEnd(LBL)}${'tokens'.padStart(VAL)}  ${'cost'.padStart(COST)}\x1b[0m`);

      out.push(row('Input:',  fmtTokens(entry.inputTokens),  inputCost  !== null ? fmtUsd(inputCost)  : '?', pctStr, true));
      out.push(row('Output:', fmtTokens(entry.outputTokens), outputCost !== null ? fmtUsd(outputCost) : '?', '',     true));

      // Subtotal — bold, padding done on plain string before ANSI
      const subtotalVal = totalCost > 0 ? fmtUsd(totalCost) : '?';
      const subtotalPadded = subtotalVal.padStart(VAL + 2 + COST);
      out.push(`    \x1b[2m${'Subtotal:'.padEnd(LBL)}\x1b[0m\x1b[1m\x1b[36m${subtotalPadded}\x1b[0m`);
    }

    // ── Grand Total ───────────────────────────────────────────────────────
    out.push('');
    out.push(BAR);

    const tokenSummary = `${fmtTokens(grandInput + grandOutput)}  (${fmtTokens(grandInput)} in · ${fmtTokens(grandOutput)} out)`;
    out.push(`  \x1b[2m${'Total calls:'.padEnd(16)}\x1b[0m${grandCalls}`);
    out.push(`  \x1b[2m${'Total tokens:'.padEnd(16)}\x1b[0m${tokenSummary}`);

    const grandStr = fmtUsd(grandTotal);
    out.push(`  \x1b[1m${'Grand Total:'.padEnd(16)}\x1b[0m\x1b[1m\x1b[36m${grandStr}\x1b[0m`);
    out.push(BAR);
    out.push('');

    return out.join('\n');
  }

  /** Reset all counters (for tests or explicit reset). */
  reset() {
    this.sessionStart = Date.now();
    this.totalApiMs   = 0;
    this._models.clear();
  }
}

// Singleton
export const costCenter = new CostCenter();
