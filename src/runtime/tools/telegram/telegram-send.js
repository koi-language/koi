// telegram_send — send a message to the user over Telegram. Use ONLY when the
// task's own instructions say to notify/message the user via Telegram. NOT a
// default communication channel.
import { resolveTarget, tgSend } from './_tg.js';

export default {
  type: 'telegram_send',
  intent: 'telegram_send',
  toolset: 'telegram',
  description:
    'Send a message to the user via Telegram (this project\'s topic). Use ONLY '
    + 'when the task explicitly requires notifying/messaging the user over '
    + 'Telegram — it is NOT the default way to talk. Args: { message }.',
  schema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Text to send to the user' } },
    required: ['message'],
  },
  async execute(action) {
    const message = action?.message ?? action?.args?.message ?? '';
    if (!message) return { error: 'message required' };
    let t;
    try { t = await resolveTarget(); } catch (err) { return { error: `Telegram error: ${err.message}` }; }
    if (!t) return { error: 'Telegram is not configured (no bot/group set up). Cannot message the user.' };
    try {
      await tgSend(t.token, t.chatId, t.threadId, message);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  },
};
