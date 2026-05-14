/**
 * `requireVideoSeen(toolName, videoFile, agent)`
 *
 * Guard for audio-from-video flows (`generate_audio` mode='sfx' with a
 * `videoFile`). Ensures the agent has visually inspected the reference
 * video via `read_file` before generating audio for it. Without this,
 * the agent writes a generic prompt ("ambient cinematic sound") guessed
 * from the filename, which:
 *   - On video-conditioned models (mmaudio-v2 etc.) wastes the prompt
 *     channel — the model has the video but no specific intent.
 *   - On text-only fallback models (ElevenLabs) generates audio entirely
 *     uncorrelated with the visuals — the model never sees the frames
 *     and the prompt is uninformative.
 *
 * The system prompt's "Workflow — strictly required before generate_audio"
 * (system-prompt-builder.js) already mandates this read_file step, but
 * only fires when the active doc is a video/timeline. UI flows that link
 * a video reference to an audio track from a different active context
 * skip the guidance, and even when it lands some models ignore "strictly
 * required" instructions. This is the runtime backstop.
 *
 * Returns a tool-result-shaped object when the guard fires (caller should
 * `return` it verbatim), or `null` when the agent has already read the
 * video and execution can proceed.
 */

import path from 'path';

export function requireVideoSeen(toolName, videoFile, agent) {
  if (!videoFile) return null;
  const session = agent?._activeSession;
  const history = session?.actionHistory;
  if (!Array.isArray(history) || history.length === 0) return null;

  const target = String(videoFile);
  // Mentions (@handle) and URLs are matched by string equality only —
  // resolving them at this layer would require the MediaLibrary handle
  // resolver which lives elsewhere; a plain string match handles the
  // common case where the agent passes the same handle/URL to both
  // read_file and generate_audio in the same turn.
  const isMention = target.startsWith('@');
  const isUrl = /^https?:\/\//i.test(target);
  const targetAbs = isMention || isUrl
    ? target
    : (path.isAbsolute(target) ? target : path.resolve(target));
  const targetBase = path.basename(target);

  const seen = history.some((entry) => {
    if (!entry?.action) return false;
    const intent = entry.action.intent || entry.action.type;
    if (intent !== 'read_file') return false;
    // Don't count a failed read — the agent didn't actually get frames.
    if (entry.error) return false;
    if (entry.result && entry.result.success === false) return false;
    const p = entry.action.path;
    if (!p) return false;
    if (p === target || p === targetAbs) return true;
    if (!isMention && !isUrl) {
      const pAbs = path.isAbsolute(p) ? p : path.resolve(p);
      if (pAbs === targetAbs) return true;
      // Basename fallback covers the case where one side is a handle
      // already resolved to a path and the other is the raw filename.
      if (path.basename(p) === targetBase) return true;
    }
    return false;
  });

  if (seen) return null;

  return {
    success: false,
    error:
      `${toolName}: refused — no \`read_file\` on the reference video "${target}" was found in this session. ` +
      `Before generating audio for a video, you MUST visually inspect it so the prompt describes the ACTUAL on-screen action, not a guess from the filename. ` +
      `The text-only fallback model (ElevenLabs) never sees the frames; even the video-conditioned model (mmaudio-v2) needs a specific prompt to disambiguate which sounds to emphasise.\n\n` +
      `Required workflow:\n` +
      `  1. Call \`read_file\` on "${target}" — samples 4 evenly-spaced frames via ffmpeg; constant cost regardless of file size.\n` +
      `  2. Identify the dominant on-screen action / texture / mood (e.g. "wooden building engulfed in flames, crackling and roaring, people shouting and running with metal buckets").\n` +
      `  3. Re-issue this \`generate_audio\` call with that detailed sensory description as \`prompt\`. The router will pick a video-conditioned model when available; if not, the text-only fallback still produces aligned audio because the prompt itself is video-informed.\n`,
    hint: `Step 1: read_file("${target}"). Step 2: write video-aware prompt. Step 3: re-call generate_audio.`,
  };
}
