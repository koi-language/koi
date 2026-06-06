/**
 * Recall Media Action — resolve a MEDIA / FILE reference ("the video",
 * "el vídeo", "esta imagen", "el fichero que te pasé") to a concrete,
 * usable absolute path WITHOUT searching the filesystem.
 *
 * Why this exists:
 *   When the user says "the video", it can ONLY be one of three things,
 *   and they have a strict priority order:
 *
 *     1. VISIBLE   — the media open/active in the GUI working area RIGHT
 *                    NOW (the storyboard visor, the video player, the
 *                    active tab). This is what the user is literally
 *                    pointing at.
 *     2. CONVERSATION — a file the user ATTACHED earlier in THIS session.
 *                    Its absolute path lives in `dialogue.jsonl`
 *                    (`user_input.attachments[]`) even after it scrolls
 *                    out of the agent's live context window. This is the
 *                    case the agent kept "forgetting" — it had seen the
 *                    video once, lost the path N turns later, and resorted
 *                    to `find ~/.koi -name "*pepsi*"` (which surfaces
 *                    OTHER sessions' files). That disk hunt is the bug
 *                    this tool replaces.
 *     3. CREATION  — something the agent PRODUCED this session
 *                    (`recall_creations`). Last because a user reference
 *                    usually means "the thing I gave you / am looking at",
 *                    not "the thing you made", unless tiers 1-2 are empty.
 *
 *   There is no fourth source. So a reference is ALWAYS resolvable from
 *   these three tiers — `find` / `ls` / `shell` is never needed and is
 *   forbidden (it mixes in files from other projects/sessions).
 *
 * Output is ordered by tier (visible first), deduped by absolute path
 * (highest-priority source wins). Each candidate carries the `path` the
 * agent can hand straight to `read_file` / `generate_video` / etc.
 */

import fs from 'fs';
import path from 'path';

const _VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpeg', 'mpg']);
const _IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'heic']);
const _AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus']);

const _VALID_KINDS = new Set(['image', 'video', 'audio', 'document']);

function _err(msg) { return { success: false, error: `recall_media: ${msg}` }; }

/** Infer a media kind from a file path's extension. Attachments arrive
 *  typed only as `image | file` (a video is a `file`), so the kind must
 *  be derived here, not trusted from the attachment record. */
function _kindFromPath(p) {
  const ext = String(p || '').split('.').pop()?.toLowerCase() || '';
  if (_VIDEO_EXT.has(ext)) return 'video';
  if (_IMAGE_EXT.has(ext)) return 'image';
  if (_AUDIO_EXT.has(ext)) return 'audio';
  return 'document';
}

function _sessionDir() {
  const sessionId = process.env.KOI_SESSION_ID;
  if (!sessionId) return null;
  const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
  return path.join(projectRoot, '.koi', 'sessions', sessionId);
}

/** Tier 1 — media open/visible in the GUI working area (turn snapshot,
 *  active doc first). */
async function _visibleCandidates() {
  const out = [];
  try {
    const { openDocumentsStore } = await import('../../state/open-documents-store.js');
    const all = openDocumentsStore.getSnapshotAll?.() || [];
    const active = openDocumentsStore.getSnapshotActive?.() || null;
    const ordered = active ? [active, ...all.filter(d => d !== active)] : all;
    for (const d of ordered) {
      const loc = d?.path || d?.url || '';
      if (!loc) continue;
      out.push({
        source: 'visible',
        active: active != null && d === active,
        path: loc,
        kind: d?.type && _VALID_KINDS.has(d.type) ? d.type : _kindFromPath(loc),
        title: d?.title || '',
        id: d?.id || undefined,
      });
    }
  } catch { /* store unavailable → no visible tier */ }
  return out;
}

/** Tier 2 — files the user ATTACHED earlier in this conversation, newest
 *  first, read straight from the canonical session dialogue log. */
function _conversationCandidates() {
  const out = [];
  const dir = _sessionDir();
  if (!dir) return out;
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'dialogue.jsonl'), 'utf8');
  } catch {
    return out; // no dialogue yet
  }
  // Newest first: dialogue is appended chronologically.
  const lines = raw.split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'user_input') continue;
    const atts = Array.isArray(entry.attachments) ? entry.attachments : [];
    for (const a of atts) {
      if (!a || !a.path) continue;
      out.push({
        source: 'conversation',
        path: a.path,
        kind: _kindFromPath(a.path),
        ts: typeof entry.ts === 'number' ? entry.ts : undefined,
      });
    }
  }
  return out;
}

/** Tier 3 — creations the agent produced this session. */
async function _creationCandidates(kind) {
  const out = [];
  try {
    const { readCreations } = await import('../../state/creations-ledger.js');
    const creations = await readCreations({ kind: kind || undefined });
    for (const c of creations) {
      if (!c?.filePath) continue;
      out.push({
        source: 'creation',
        path: c.filePath,
        kind: c.kind || _kindFromPath(c.filePath),
        id: c.id,
        summary: c.summary || '',
        ts: c.ts,
      });
    }
  } catch { /* ledger unavailable */ }
  return out;
}

export default {
  type: 'recall_media',
  intent: 'recall_media',
  description:
    'Resolve a MEDIA / FILE reference ("the video", "el vídeo", "esta imagen", "the file I gave you", "el fichero que te pasé") to its real absolute path. ' +
    'This is THE way to find a file the user is referring to — use it INSTEAD of `find` / `ls` / `read_dir` / `shell`, which are forbidden for locating user references (they surface files from OTHER sessions/projects).\n\n' +
    'A media reference can ONLY be one of three things, returned in this PRIORITY order:\n' +
    '  1. **visible** — what is open/active in the working area RIGHT NOW (the user is literally pointing at it).\n' +
    '  2. **conversation** — a file the user ATTACHED earlier in THIS session (its path is kept even after it scrolls out of your context).\n' +
    '  3. **creation** — something YOU produced this session.\n\n' +
    'There is no fourth source, so a reference is ALWAYS resolvable here — never fall back to disk search. ' +
    'Pick the top candidate of the right `kind`; its `path` goes straight into `read_file` (to re-watch a video/see an image), `generate_video`, etc.\n\n' +
    'Returns: { success, candidates: [{ source, path, kind, active?, title?, id?, ts? }, …], count }. ' +
    'When `count` is 0 for the kind you asked: the user is referring to something you genuinely do not have — ASK them, do NOT search disk.',
  thinkingHint: (action) =>
    `Resolving${action?.kind ? ' ' + action.kind : ''} reference`,
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['image', 'video', 'audio', 'document'],
        description:
          'OPTIONAL. Restrict candidates to this media kind (inferred from file extension for visible/attached files). Pass "video" when the user said "el vídeo", "image" for "la imagen", etc. Omit to get every kind.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'recall_media' },
    { actionType: 'direct', intent: 'recall_media', kind: 'video' },
  ],

  async execute(action) {
    const kind = typeof action?.kind === 'string' ? action.kind.trim() : '';
    if (kind && !_VALID_KINDS.has(kind)) {
      return _err(`invalid kind "${kind}". Allowed: ${[..._VALID_KINDS].join(', ')}.`);
    }

    const visible = await _visibleCandidates();
    const conversation = _conversationCandidates();
    const creations = await _creationCandidates(kind);

    // Tier order is the priority order; dedupe by absolute path keeping
    // the highest-priority (earliest) occurrence.
    const merged = [...visible, ...conversation, ...creations];
    const seen = new Set();
    const candidates = [];
    for (const c of merged) {
      if (kind && c.kind !== kind) continue;
      const key = path.resolve(c.path);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(c);
    }

    return { success: true, count: candidates.length, candidates, ...(kind ? { kind } : {}) };
  },
};
