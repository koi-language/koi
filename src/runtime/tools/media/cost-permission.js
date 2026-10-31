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
 * Auto-approve is PERSISTENT: once the user enables it on any media
 * confirmation we stop asking for EVERY future media generation — image,
 * video and audio — forever, across app restarts. The flag is stored in a
 * dedicated runtime-owned file (`<project>/media-cost-approve.json`) rather than
 * koi-cli's shared `config.json`, because the latter is cached whole in
 * koi-cli's process and rewritten on every settings change — a direct write
 * there could be clobbered. The runtime owns this file outright (same pattern
 * as voice-registry), so there's no write race. Delete the file (or flip
 * `autoApprove` to false) to start being asked again.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { isAutoApprove } from '../../util/interactivity.js';
import { getAuthHeaders, fetchMediaCapabilities } from '../../llm/providers/gateway.js';
import { channel } from '../../io/channel.js';
import { runPermissionDialog } from '../../code/permission-queue.js';

// One flag for ALL media kinds — per the product spec, enabling auto-approve
// on any media confirmation suppresses the prompt for every subsequent media
// generation. Lazily hydrated from disk on first use, then kept in memory.
let _autoApproveMedia = false;
let _hydrated = false;

// The media-cost confirmation shares the ONE global permission-dialog queue
// (`permission-queue.js`) with file + shell prompts. A per-media queue would
// stop media↔media overlap but NOT file↔media or shell↔media — those would
// still fire two `channel.select`s at once and deadlock. One queue = never two
// dialogs concurrently, whatever asked.

function _stateFile() {
  return path.join(os.homedir(), '.koi', 'media-cost-approve.json');
}

// Read the persisted flag once per process. Best-effort: a missing or
// malformed file means "not auto-approved".
function _hydrate() {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const raw = fs.readFileSync(_stateFile(), 'utf8');
    const data = JSON.parse(raw);
    if (data && data.autoApprove === true) _autoApproveMedia = true;
  } catch {
    /* no file / unreadable → stays false */
  }
}

// Persist the flag atomically (tmp + rename), mirroring voice-registry. Best-
// effort: a failed write only means the user is asked again next session.
function _persist(value) {
  try {
    const dir = path.join(os.homedir(), '.koi');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = _stateFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ autoApprove: value }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* non-fatal */
  }
}

export function isMediaAutoApproved() {
  _hydrate();
  return _autoApproveMedia;
}

// Clear the persistent auto-approve (used by a future settings toggle / reset).
export function resetMediaAutoApprove() {
  _autoApproveMedia = false;
  _hydrated = true;
  _persist(false);
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
  // Headless / scripted runs and a persisted auto-approve both proceed
  // without prompting. `KOI_YES=1` is the same global "yes to everything"
  // escape hatch the shell tool honours.
  if (isAutoApprove()) return true;
  _hydrate();
  if (_autoApproveMedia) return true;
  if (!channel || typeof channel.select !== 'function') return true;

  // Ask ONE AT A TIME. Concurrent media generations would otherwise each fire a
  // `channel.select` simultaneously and the extra dialogs never resolve → those
  // workers hang. Serialising also lets a single "Auto-approve" answer release
  // every queued sibling (we re-check the flag below after taking our turn).
  return runPermissionDialog(async () => {
  // A sibling prompt that resolved while we waited in the queue may have just
  // enabled auto-approve — honour it and skip asking again.
  if (_autoApproveMedia) return true;

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
    _hydrated = true;
    _persist(true); // durable across restarts — never ask for media again
    return true;
  }
  return value === 'yes';
  });
}

/**
 * Pre-flight cost gate, run by the media banner wrapper BEFORE the banner is
 * shown and BEFORE any server request. This is the single choke point that
 * guarantees nothing happens — no "Generating…" banner, no gateway call — until
 * the user consents. It predicts the model the dispatcher will bill (a pinned
 * model wins, otherwise the same peek the router uses), reads its learned
 * `maxCredits` watermark from the live catalog, and asks for confirmation.
 *
 * Returns true to proceed, false if the user declined. Fail-open on any
 * plumbing error — a broken confirmation must never wedge generation.
 *
 * @param {string} bannerKind  'image' | 'video' | 'audio'
 * @param {object} act         the action params
 * @param {object} agent       the executing agent (for llm clients / abort)
 */
export async function preflightMediaCost(bannerKind, act, agent) {
  // Programmatic opt-out (e.g. the interactive storyboard renders its own
  // thumbnails and owns its UX). `confirmCost` defaults to true everywhere else.
  if (act && act.confirmCost === false) return true;

  const kind = (bannerKind === 'image' || bannerKind === 'video' || bannerKind === 'audio')
    ? bannerKind : null;
  if (!kind) return true;

  // Auto-approve / KOI_YES short-circuit before we even touch the catalog.
  if (isAutoApprove()) return true;
  _hydrate();
  if (_autoApproveMedia) return true;

  // Audio transcription is speech-to-text, not media generation — never gate it.
  let audioMode = null;
  if (kind === 'audio') {
    const raw = (act && act.mode) || 'speech';
    audioMode = raw === 'tts' ? 'speech' : raw;
    if (audioMode === 'transcribe') return true;
  }

  let slug = (act && act.model && act.model !== 'auto') ? act.model : null;
  let name = slug;
  let max = null;
  const resolution = (act && act.resolution) || null;
  const aspectRatio = (act && act.aspectRatio) || null;

  try {
    const caps = await fetchMediaCapabilities(kind);
    const models = (caps && Array.isArray(caps.models)) ? caps.models : [];
    if (!slug && models.length) {
      const router = await import('../../llm/providers/media-model-router.js');
      if (kind === 'image' && typeof router.peekImageModel === 'function') {
        const p = router.peekImageModel(models, {
          intent: (act && (act.intent || act.operation)) || '',
          refsCount: (act && Array.isArray(act.referenceImages)) ? act.referenceImages.length : 0,
          hasMaskImage: !!(act && act.maskImage),
          hasSourceImage: !!(act && act.sourceImage),
          hasTargetSize: !!(act && act.targetSize && act.targetSize.width && act.targetSize.height),
        });
        slug = (p && (p.slug || p.model)) || null;
      } else if (kind === 'video' && typeof router.peekVideoModel === 'function') {
        const p = router.peekVideoModel(models, {
          aspectRatio, resolution,
          kind: act && act.kind,
          referenceImages: act && act.referenceImages,
          referenceVideos: act && act.referenceVideos,
          startFrame: (act && act.startFrame) ? { data: '_peek' } : undefined,
          endFrame: (act && act.endFrame) ? { data: '_peek' } : undefined,
          withAudio: !(act && act.withAudio === false),
        });
        slug = (p && (p.slug || p.model)) || null;
      } else if (kind === 'audio' && typeof router.peekAudioModel === 'function') {
        const p = router.peekAudioModel(models, {
          kind: audioMode === 'speech' ? 'tts' : audioMode,
        });
        slug = (p && (p.slug || p.model)) || null;
      }
    }
    const row = slug ? models.find((m) => m.slug === slug) : null;
    if (row) { max = row.maxCredits != null ? row.maxCredits : null; name = row.displayName || slug; }
  } catch { /* peek/catalog failed → card shows "cost not available" */ }

  return confirmMediaCost(channel, {
    kind,
    model: name || 'Auto',
    resolution: kind === 'audio' ? null : resolution,
    aspectRatio: kind === 'audio' ? null : aspectRatio,
    maxCredits: max,
    abortSignal: agent && agent.abortSignal,
  });
}
