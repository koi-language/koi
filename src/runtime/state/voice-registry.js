/**
 * Voice Registry — persist user-created voices (e.g. via create_voice voice
 * cloning) so subsequent generate_audio calls can refer to them by name.
 *
 * Storage: ~/.koi/voices/voices.json — a JSON array of entries shaped like:
 *
 *   {
 *     id:        string,           // canonical id we mint = "voice-<timestamp>-<rnd>"
 *     name:      string,           // user-chosen display name (unique)
 *     providerVoiceId: string,     // the id the provider uses internally
 *     provider:  string,           // e.g. "elevenlabs", "playai"
 *     modelSlug: string,           // resolved fal slug at clone time, e.g. "fal-ai/elevenlabs/voice-cloning"
 *     description?: string,
 *     language?: string,
 *     samplePath?: string,         // local copy of the sample audio (~/.koi/voices/<id>/sample.<ext>)
 *     createdAt: ISO string,
 *   }
 *
 * Cross-project: voices live under $HOME so they survive moving between
 * projects. The companion sample file is what the GUI drawer plays as a
 * preview, so we keep a local copy even when the provider also hosts the
 * audio remotely.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

function _voicesDir() {
  return path.join(os.homedir(), '.koi', 'voices');
}

function _voicesJson() {
  return path.join(_voicesDir(), 'voices.json');
}

function _ensureDir() {
  const dir = _voicesDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read every voice entry, oldest first. Returns [] when the registry
 *  doesn't exist or is malformed (the file is treated as best-effort —
 *  we never fail a tool call because the registry can't be parsed). */
export function listVoices() {
  try {
    const file = _voicesJson();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e) => e && typeof e === 'object' && typeof e.id === 'string');
  } catch {
    return [];
  }
}

/** Look up an entry by display name (case-insensitive). The matching is
 *  exact (after lowercasing) — partial matches would silently route a
 *  generate_audio call to the wrong voice, so we leave fuzzy lookup to
 *  callers that want it. */
export function findVoiceByName(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const target = name.trim().toLowerCase();
  for (const e of listVoices()) {
    if (typeof e.name === 'string' && e.name.trim().toLowerCase() === target) return e;
  }
  return null;
}

/** Append (or replace, by id) a voice entry. Atomic write via tmp+rename
 *  so a crash mid-write doesn't corrupt the registry. */
export function saveVoice(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
    throw new Error('saveVoice: entry must be an object with a string id');
  }
  _ensureDir();
  const all = listVoices();
  const idx = all.findIndex((e) => e.id === entry.id);
  if (idx >= 0) all[idx] = entry; else all.push(entry);
  const file = _voicesJson();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, file);
  // Mirror into the media library (single source of truth for the GUI
  // drawer / strip). The voice's `samplePath` IS the row's filePath —
  // the audio file already exists by the time saveVoice is called.
  if (entry.samplePath) {
    _mirrorVoiceToMediaLibrary(entry).catch(() => { /* best-effort */ });
  }
  return entry;
}

/** Remove an entry by id. Does NOT delete the on-disk sample (caller's
 *  responsibility — keeps undo/restore simple). */
export function deleteVoice(id) {
  const all = listVoices();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  const removed = all[idx];
  const next = all.filter((e) => e.id !== id);
  _ensureDir();
  const file = _voicesJson();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  // Best-effort removal of the matching media-library row.
  if (removed?.samplePath) {
    (async () => {
      try {
        const { MediaLibrary } = await import('./media-library.js');
        await MediaLibrary.global().removeByPath(removed.samplePath);
      } catch { /* best-effort */ }
    })();
  }
  return true;
}

/** Best-effort upsert of the voice row in the media library. */
async function _mirrorVoiceToMediaLibrary(entry) {
  try {
    const { saveVoiceEntry } = await import('./media-library.js');
    await saveVoiceEntry(entry.samplePath, entry, null);
  } catch (e) {
    process.stderr.write(`[voice-registry] mirror to media-library failed: ${e.message}\n`);
  }
}

/** Allocate the directory where a freshly-minted voice's local sample
 *  copy should live. Caller writes the sample bytes; we just make sure
 *  the directory exists and return the absolute path to use. */
export function voiceAssetDir(voiceLocalId) {
  const safe = String(voiceLocalId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) throw new Error('voiceAssetDir: voiceLocalId is empty after sanitisation');
  const dir = path.join(_voicesDir(), safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Mint a new local id for a voice. Stable across the registry and used
 *  as the directory name for the sample file. */
export function newVoiceLocalId() {
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
