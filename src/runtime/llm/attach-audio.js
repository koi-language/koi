// attach-audio.js — queue an audio file as NATIVE audio input for the next LLM
// turn, the same way read_file attaches images (vision) and videos.
//
// The bytes are pushed onto `session._pendingMcpAudios`; llm-provider.js turns
// them into `input_audio` content blocks on the next request, and the flag
// `session._hasAudioAttachments` makes the auto-selector pick a model whose
// catalog row has `inputAudio:true` (the Gemini family today). No transcription
// turn needed — the model "hears" the audio directly.
//
// OpenRouter's `input_audio` content type accepts mp3 / wav. Telegram voice
// notes (and many other sources) are OGG/Opus, so anything that isn't already
// mp3/wav is transcoded to mp3 with the bundled ffmpeg before attaching.
import fs from 'fs';
import path from 'path';
import os from 'os';

// Formats OpenRouter's input_audio accepts as-is; everything else → mp3.
const _NATIVE = new Set(['mp3', 'wav']);
// base64 inflates ~33%; keep the raw upload comfortably under the ~20 MB
// per-request inline cap shared by Gemini / OpenRouter.
const MAX_RAW_BYTES = 14 * 1024 * 1024;

async function _transcodeToMp3(srcPath) {
  let ffmpegBin = 'ffmpeg';
  try {
    const installer = await import('../media/ffmpeg-installer.js');
    const r = await installer.ensureFfmpeg();
    if (r?.ffmpeg) ffmpegBin = r.ffmpeg;
  } catch { /* fall back to PATH */ }
  const { spawn } = await import('child_process');
  const out = path.join(os.tmpdir(), `koi-audio-${process.pid}-${Date.now()}.mp3`);
  const argv = ['-y', '-i', srcPath, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', out];
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-200)}`))));
  });
  return out;
}

/**
 * Read an audio file and return it as a ready-to-send block payload (base64 +
 * format), transcoding to mp3 when the source isn't natively mp3/wav. Pure: it
 * does NOT touch any session — callers either push it onto `_pendingMcpAudios`
 * or build an `input_audio` content block inline.
 * @returns {Promise<{ ok: true, data: string, format: string, mimeType: string, sizeBytes: number, transcoded: boolean, path: string }
 *                   | { ok: false, reason: string, sizeBytes?: number }>}
 */
export async function loadAudioBlock(audioPath) {
  try {
    const resolved = path.resolve(audioPath);
    if (!fs.existsSync(resolved)) return { ok: false, reason: 'not-found' };
    const stat = fs.statSync(resolved);
    if (stat.size === 0) return { ok: false, reason: 'empty' };

    const ext = path.extname(resolved).slice(1).toLowerCase();
    let uploadPath = resolved;
    let format = ext;
    let transcoded = false;
    if (!_NATIVE.has(ext)) {
      uploadPath = await _transcodeToMp3(resolved); // OGG/Opus/m4a/flac/… → mp3
      format = 'mp3';
      transcoded = true;
    }

    const uploadBytes = fs.statSync(uploadPath).size;
    if (uploadBytes > MAX_RAW_BYTES) {
      if (transcoded) { try { fs.unlinkSync(uploadPath); } catch { /* */ } }
      return { ok: false, reason: 'too-large', sizeBytes: uploadBytes };
    }

    const data = fs.readFileSync(uploadPath).toString('base64');
    if (transcoded) { try { fs.unlinkSync(uploadPath); } catch { /* */ } }

    const mimeType = format === 'wav' ? 'audio/wav' : 'audio/mpeg';
    return { ok: true, data, format, mimeType, sizeBytes: stat.size, transcoded, path: resolved };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

/**
 * Attach an audio file to the session for native model input on the NEXT turn
 * (used by tool paths like read_file / telegram_ask). Pushes the bytes onto
 * `_pendingMcpAudios` and flags the session so the auto-selector picks a model
 * with inputAudio:true (the Gemini family today).
 * @returns same shape as loadAudioBlock (minus `data`).
 */
export async function attachAudioFileToSession(session, audioPath) {
  if (!session) return { ok: false, reason: 'no-session' };
  const r = await loadAudioBlock(audioPath);
  if (!r.ok) return r;
  if (!session._pendingMcpAudios) session._pendingMcpAudios = [];
  session._pendingMcpAudios.push({ data: r.data, format: r.format, mimeType: r.mimeType, _debugPath: r.path, role: 'audio_full' });
  session._hasAudioAttachments = true;
  return { ok: true, format: r.format, mimeType: r.mimeType, sizeBytes: r.sizeBytes, transcoded: r.transcoded };
}
