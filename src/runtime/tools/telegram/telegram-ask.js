// telegram_ask — send a question to the user over Telegram and WAIT for their
// reply. The bridge (agenda-daemon poller) sees the user's reply in the topic
// and drops it into <workDir>/.koi/tg-reply.json, which we poll for here. Use
// ONLY when the task explicitly needs an answer from the user via Telegram.
import fs from 'fs';
import path from 'path';
import { resolveTarget, tgSend } from './_tg.js';

export default {
  type: 'telegram_ask',
  intent: 'telegram_ask',
  toolset: 'telegram',
  description:
    'Send a question to the user via Telegram and WAIT for their reply. Use ONLY '
    + 'when the task explicitly needs an answer from the user over Telegram. '
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
  async execute(action) {
    const question = action?.question ?? action?.args?.question ?? '';
    if (!question) return { error: 'question required' };
    const timeoutMs = (Number(action?.timeoutSec ?? action?.args?.timeoutSec) || 3600) * 1000;
    let t;
    try { t = await resolveTarget(); } catch (err) { return { error: `Telegram error: ${err.message}` }; }
    if (!t) return { error: 'Telegram is not configured (no bot/group set up). Cannot ask the user.' };

    const koiDir = path.join(t.workDir, '.koi');
    const awaitFile = path.join(koiDir, 'tg-await.json');
    const replyFile = path.join(koiDir, 'tg-reply.json');
    try { fs.mkdirSync(koiDir, { recursive: true }); } catch { /* */ }
    try { fs.unlinkSync(replyFile); } catch { /* */ }

    // Mark "a task is waiting for a reply on this thread", then ask.
    fs.writeFileSync(awaitFile, JSON.stringify({ threadId: t.threadId, ts: Date.now() }));
    try {
      await tgSend(t.token, t.chatId, t.threadId, question);
    } catch (err) {
      try { fs.unlinkSync(awaitFile); } catch { /* */ }
      return { error: err.message };
    }

    // Poll for the bridge to deliver the user's reply.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(replyFile, 'utf8');
        try { fs.unlinkSync(replyFile); } catch { /* */ }
        try { fs.unlinkSync(awaitFile); } catch { /* */ }
        return { answer: JSON.parse(raw).text };
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    try { fs.unlinkSync(awaitFile); } catch { /* */ }
    return { answer: null, timedOut: true };
  },
};
