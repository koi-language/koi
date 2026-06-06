/**
 * Media cost permission — confirm the MAXIMUM credit cost of a media
 * generation with the user JUST BEFORE the request is dispatched to the
 * backend gateway.
 *
 * Mirrors the shell permission round-trip (see tools/shell/shell.js): the
 * tool emits a `channel.select` carrying a `media_cost` meta blob; the GUI
 * renders it as a cost card (Model / Resolution / Aspect ratio / Available
 * balance + an Auto-approve toggle), and the terminal renders the readable
 * `message` text. The user's choice comes back as 'yes' | 'always' | 'no'.
 *
 * The "up to X credits" figure is the per-model `maxCredits` watermark the
 * backend learns from real charges and ships in models/{kind}.json. Until a
 * model has been billed at least once `maxCredits` is null — we still ask for
 * confirmation but show "cost not available" instead of a figure.
 *
 * Auto-approve is SESSION-SCOPED (an in-memory flag, exactly like the shell
 * tool's 'always'): once the user enables it on any media confirmation we
 * stop asking for EVERY future media generation — image, video and audio —
 * for the lifetime of the process.
 */

import { getAuthHeaders } from '../../llm/providers/gateway.js';

// Session-scoped auto-approve. One flag for ALL media kinds — per the product
// spec, enabling auto-approve on any media confirmation suppresses the prompt
// for every subsequent media generation.
let _autoApproveMedia = false;

export function isMediaAutoApproved() {
  return _autoApproveMedia;
}

// Test/utility hook — clears the session auto-approve (not used in normal flow).
export function resetMediaAutoApprove() {
  _autoApproveMedia = false;
}

// Best-effort fetch of the user's available credit balance. Returns null on
// any failure so the card renders "balance unknown" rather than blocking the
// generation on a balance lookup.
async function fetchAvailableBalance(abortSignal) {
  try {
    const base = process.env.KOI_API_URL || 'http://localhost:3000';
    const res = await fetch(`${base}/users/me`, {
      headers: getAuthHeaders(),
      signal: abortSignal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const v = data?.credits?.available;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Ask the user to confirm a media generation by its maximum credit cost.
 *
 * @param {object} channel  the runtime Channel (provides `select`)
 * @param {object} info     { kind, model, resolution, aspectRatio, maxCredits, abortSignal }
 * @returns {Promise<boolean>} true → proceed, false → user declined
 */
export async function confirmMediaCost(channel, info = {}) {
  // Headless / scripted runs and an active session auto-approve both proceed
  // without prompting. `KOI_YES=1` is the same global "yes to everything"
  // escape hatch the shell tool honours.
  if (process.env.KOI_YES === '1') return true;
  if (_autoApproveMedia) return true;
  if (!channel || typeof channel.select !== 'function') return true;

  const { kind, model, resolution, aspectRatio, maxCredits } = info;
  const balance = await fetchAvailableBalance(info.abortSignal);

  const hasCost = maxCredits != null && Number(maxCredits) > 0;
  const costLabel = hasCost
    ? `up to ${Math.ceil(Number(maxCredits))} credits`
    : 'cost not available';
  const header = `Cost · ${costLabel}`;

  // Readable fallback for the terminal — the GUI ignores this and renders the
  // structured card from the top-level meta mirrors instead.
  const lines = [header];
  if (model) lines.push(`Model: ${model}`);
  if (resolution) lines.push(`Resolution: ${resolution}`);
  if (aspectRatio) lines.push(`Aspect ratio: ${aspectRatio}`);
  if (balance != null) lines.push(`Available balance: ${balance}`);
  const message = lines.join('\n');

  const value = await channel.select(message, [
    { title: 'Approve', value: 'yes' },
    { title: 'Auto-approve future media generations', value: 'always' },
    { title: 'Cancel', value: 'no' },
  ], 0, {
    meta: {
      type: 'media_cost',
      kind: kind || null,
      header,
      costLabel,
      maxCredits: hasCost ? Number(maxCredits) : null,
      model: model || null,
      resolution: resolution || null,
      aspectRatio: aspectRatio || null,
      availableBalance: balance != null ? balance : null,
    },
  });

  if (value === 'always') {
    _autoApproveMedia = true;
    return true;
  }
  return value === 'yes';
}
