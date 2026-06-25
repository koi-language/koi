// telegram_ask — send a question to the user over Telegram and WAIT for their
// reply. When this process asks, it CLAIMS the thread for the rest of its life:
// the bridge (telegram-daemon poller) routes EVERY subsequent user message on
// that thread — text, audio, image, any format — into <workDir>/.koi/tg-inbox.jsonl,
// which we drain here. The moment this process exits, the bridge falls back to
// the normal chat reception. Audio replies are transcribed so the agent never
// receives an "empty" message. Use ONLY when the task needs an answer from the
// user via Telegram.
import fs from 'fs';
import path from 'path';
import { resolveTarget, tgSend } from './_tg.js';

// One-time per-process registration of the cleanup that releases the thread
// claim when this process exits (so replies fall back to normal reception).
let _claimRegistered = false;

function _claimThread(sessFile, inboxFile, threadId) {
  if (!_claimRegistered) {
    _claimRegistered = true;
    // First claim of this process: start from a clean inbox (so we never consume
    // queued messages left over from a previous run) BEFORE writing the marker,
    // since the bridge only starts queueing once the marker exists.
    try { fs.writeFileSync(inboxFile, ''); } catch { /* */ }
    const release = () => {
      try { fs.unlinkSync(sessFile); } catch { /* */ }
      try { fs.unlinkSync(inboxFile); } catch { /* */ }
    };
    process.once('exit', release);
    process.once('SIGTERM', () => { release(); process.exit(0); });
    process.once('SIGINT', () => { release(); process.exit(0); });
  }
  try {
    fs.writeFileSync(sessFile, JSON.stringify({ threadId, pid: process.pid, ts: Date.now() }));
  } catch { /* best-effort */ }
}

// Pop the oldest message off the inbox queue, rewriting the file without it.
// Returns the parsed entry, or null when the queue is empty.
function _drainInbox(inboxFile) {
  let raw;
  try { raw = fs.readFileSync(inboxFile, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const first = lines.shift();
  try { fs.writeFileSync(inboxFile, lines.length ? lines.join('\n') + '\n' : ''); } catch { /* */ }
  try { return JSON.parse(first); } catch { return null; }
}

// Turn a delivered message into the answer the agent receives. A voice reply is
// ATTACHED natively to the next turn (the model hears it — no transcription
// turn), with transcription as a fallback when no audio-capable model / session
// is available. Images/video are handed over as a tagged local path the agent
// can read. Any caption text is preserved alongside.
async function _toAnswer(entry, agent) {
  const text = (entry?.text || '').trim();
  const mediaPath = entry?.mediaPath || null;
  const mediaTag = entry?.mediaTag || null;
  if (!mediaPath) return text;
  if (mediaTag === 'audio') {
    // 1) Try native attach — the model will HEAR the voice note this turn.
    try {
      const { attachAudioFileToSession } = await import('../../llm/attach-audio.js');
      const r = await attachAudioFileToSession(agent?._activeSession, mediaPath);
      if (r.ok) {
        const note = '[The user replied with a voice message — it is attached as audio for you to listen to and act on.]';
        return text ? `${text}\n\n${note}` : note;
      }
    } catch { /* fall through to transcription */ }
    // 2) Fallback: transcribe to text.
    try {
      const { default: transcribeAudio } = await import('../media/transcribe-audio.js');
      const r = await transcribeAudio.execute({ audioFile: mediaPath }, agent);
      if (r?.success && r.text) return text ? `${text}\n\n${r.text}` : r.text;
    } catch { /* fall through to handing over the raw path */ }
    return text ? `${text}\n\n[audio] ${mediaPath}` : `[audio] ${mediaPath}`;
  }
  return text ? `${text}\n\n[${mediaTag}] ${mediaPath}` : `[${mediaTag}] ${mediaPath}`;
}

export default {
  type: 'telegram_ask',
  intent: 'telegram_ask',
  toolset: 'telegram',
  description:
    'Send a question to the user via Telegram and WAIT for their reply. Use ONLY '
    + 'when the task explicitly needs an answer from the user over Telegram. '
    + 'While this task is running, every reply the user sends (text, voice — '
    + 'auto-transcribed —, image, etc.) is routed to it. '
    + 'Args: { question, timeoutSec? (default 3600) }. Returns { answer } (or '
    + '{ answer: null, timedOut: true } if no reply in time).',
  schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to send the user' },
      timeoutSec: { type: 'number', description: 'How long to wait for a reply (default 3600s)' },
    },
    required: ['question'],
  },
  async execute(action, agent) {
    const question = action?.question ?? action?.args?.question ?? '';
    if (!question) return { error: 'question required' };
    const timeoutMs = (Number(action?.timeoutSec ?? action?.args?.timeoutSec) || 3600) * 1000;
    let t;
    try { t = await resolveTarget(); } catch (err) { return { error: `Telegram error: ${err.message}` }; }
    if (!t) return { error: 'Telegram is not configured (no bot/group set up). Cannot ask the user.' };

    const koiDir = path.join(t.workDir, '.koi');
    const sessFile = path.join(koiDir, 'tg-session.json');
    const inboxFile = path.join(koiDir, 'tg-inbox.jsonl');
    try { fs.mkdirSync(koiDir, { recursive: true }); } catch { /* */ }

    // Claim the thread for the lifetime of this process, then ask.
    _claimThread(sessFile, inboxFile, t.threadId);
    try {
      await tgSend(t.token, t.chatId, t.threadId, question);
    } catch (err) {
      return { error: err.message };
    }

    // Wait for the bridge to queue the user's next message into our inbox.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = _drainInbox(inboxFile);
      if (entry) return { answer: await _toAnswer(entry, agent) };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { answer: null, timedOut: true };
  },
};
