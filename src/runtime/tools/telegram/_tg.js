// Shared helpers for the telegram_send / telegram_ask tools. Self-contained so
// the runtime doesn't depend on the koi-cli frontend: reads the bridge config
// (~/.koi/telegram-config.json) + bot token (keytar → file) directly, and posts
// via the Bot API. (The `_` prefix means the action loader skips this file.)
import fs from 'fs';
import os from 'os';
import path from 'path';

const KOI_DIR = path.join(os.homedir(), '.koi');
const CONFIG_FILE = path.join(KOI_DIR, 'telegram-config.json');
const TOKEN_FILE = path.join(KOI_DIR, '.telegram-token');

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

export async function readToken() {
  if (process.env.KOI_TG_BOT_TOKEN) return process.env.KOI_TG_BOT_TOKEN;
  try {
    const keytar = (await import('keytar')).default;
    const t = await keytar.getPassword('braxil', 'telegram-bot-token');
    if (t) return t;
  } catch { /* fall back to file */ }
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return null; }
}

export function topicForWorkDir(cfg, workDir) {
  const topics = cfg.topics || {};
  return topics[path.resolve(workDir)] || null;
}

async function createForumTopic(token, chatId, name) {
  const res = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, name }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || 'createForumTopic failed');
  return j.result.message_thread_id;
}

/** Persist a topic mapping into ~/.koi/telegram-config.json (the bridge reads it). */
function linkTopic(workDir, threadId, name) {
  const cfg = readConfig();
  cfg.topics = cfg.topics || {};
  cfg.topics[path.resolve(workDir)] = { threadId, name };
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch { /* */ }
}

/**
 * Resolve { token, chatId, threadId } for this task's working dir. Telegram is
 * GLOBAL: configured once (bot token + supergroup). A project doesn't need to be
 * pre-linked — if it has no topic yet, we AUTO-CREATE one in the global group on
 * first use. Returns null ONLY when Telegram isn't configured globally at all.
 */
export async function resolveTarget() {
  const workDir = process.env.KOI_PROJECT_ROOT || process.cwd();
  const cfg = readConfig();
  const token = await readToken();
  if (!cfg.supergroupId || !token) return null; // not configured globally

  let topic = topicForWorkDir(cfg, workDir);
  if (!topic) {
    const name = `${path.basename(workDir)} · ${os.hostname()}`;
    const threadId = await createForumTopic(token, cfg.supergroupId, name);
    linkTopic(workDir, threadId, name);
    topic = { threadId, name };
  }
  return { workDir, token, chatId: cfg.supergroupId, threadId: topic.threadId };
}

export async function tgSend(token, chatId, threadId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
      text,
      disable_web_page_preview: true,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || 'sendMessage failed');
  return j.result;
}
