/**
 * Token budget for the Context Compiler.
 *
 * Three slot budget modes:
 *   - 'fixed'    Always included; counted against budget but never truncated.
 *   - <number>   Hard cap; if content exceeds it, truncate by relevance score.
 *   - 'flex'     A single slot per slot-map can absorb the remaining budget.
 *
 * Token counting: rough char/4 heuristic. Good enough for budget allocation;
 * if we ever need precision, swap for tiktoken later.
 */

export function estimateTokens(text) {
  if (!text) return 0;
  // Char-to-token: empirically ~4 chars/token for English/Spanish prose,
  // ~3 for code-heavy content. Use 3.5 as a middle-ground default.
  return Math.ceil(String(text).length / 3.5);
}

/**
 * Allocate budget across resolved slots.
 *
 * Inputs:
 *   resolved: Array<{ id, mode: 'fixed'|number|'flex', content: string, score?: number }>
 *   totalBudget: total token budget for all slots combined.
 *
 * Output: Array<{ id, mode, content, allocated, included }> in input order.
 *   - allocated: tokens granted to this slot
 *   - included: final content (may be truncated to fit allocated)
 */
export function allocate(resolved, totalBudget) {
  if (!Array.isArray(resolved)) throw new Error('budget.allocate: resolved must be array');

  const result = resolved.map((s) => ({ ...s, allocated: 0, included: '' }));

  // Pass 1: fixed slots are not negotiable.
  let remaining = totalBudget;
  for (const slot of result) {
    if (slot.mode === 'fixed') {
      const need = estimateTokens(slot.content);
      slot.allocated = need;
      slot.included = slot.content;
      remaining -= need;
    }
  }

  // Pass 2: numeric-budget slots get capped.
  for (const slot of result) {
    if (typeof slot.mode === 'number') {
      const need = estimateTokens(slot.content);
      const grant = Math.min(slot.mode, need);
      slot.allocated = grant;
      slot.included = need <= grant ? slot.content : _truncateTokens(slot.content, grant);
      remaining -= grant;
    }
  }

  // Pass 3: flex slot absorbs the remainder.
  const flexSlots = result.filter((s) => s.mode === 'flex');
  if (flexSlots.length > 1) {
    throw new Error(`budget.allocate: at most one flex slot allowed; got ${flexSlots.length}`);
  }
  if (flexSlots.length === 1) {
    const flex = flexSlots[0];
    if (remaining <= 0) {
      flex.allocated = 0;
      flex.included = '';
    } else {
      const need = estimateTokens(flex.content);
      flex.allocated = Math.min(remaining, need);
      flex.included = need <= remaining ? flex.content : _truncateTokens(flex.content, remaining);
      remaining -= flex.allocated;
    }
  }

  if (remaining < 0) {
    // Fixed + numeric exceeded budget. We loaded what was fixed (correct), but
    // numeric slots should ideally have been further trimmed. v1 lets it ride
    // and surfaces it as overflow in the metadata.
  }

  const totalUsed = result.reduce((acc, s) => acc + s.allocated, 0);
  return { slots: result, totalUsed, totalBudget, overflow: Math.max(0, totalUsed - totalBudget) };
}

function _truncateTokens(text, tokens) {
  if (!text) return '';
  const charBudget = Math.max(0, Math.floor(tokens * 3.5));
  if (text.length <= charBudget) return text;
  return text.slice(0, charBudget - 1) + '…';
}
