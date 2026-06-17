/**
 * skill-usage-store.js — Persist skill activation usage (counts + recency).
 *
 * The system prompt lists skills by NAME only (to stay small); to keep the
 * agent's most-relevant skills one glance away, we pre-expand the descriptions
 * of the most-USED and most-RECENTLY-used skills. That ranking comes from here:
 * every `activate_skill` records a use, persisted globally so a user's habits
 * survive across sessions.
 *
 * Storage: ~/.koi/skill-usage.json, keyed by canonical skill id (`plugin:name`
 * or a bare standalone name) → { count, lastUsedMs }.
 *
 * NOT a tool (no default export) — a helper consumed by activate-skill.js and
 * the skills block in llm-provider.js. action-registry's loader skips files
 * without a `default.type`.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const USAGE_FILE = path.join(os.homedir(), '.koi', 'skill-usage.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(data) {
  try {
    const dir = path.dirname(USAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort — usage stats are a nicety, never block activation on them */
  }
}

/** Record one activation of a skill (bumps count + recency). */
export function recordSkillUse(skillId) {
  if (!skillId) return;
  const all = readAll();
  const entry = all[skillId] || { count: 0, lastUsedMs: 0 };
  entry.count = (entry.count || 0) + 1;
  entry.lastUsedMs = Date.now();
  all[skillId] = entry;
  writeAll(all);
}

/** Top N skill ids by cumulative activation count (ties broken by recency). */
export function topUsedSkillIds(n = 3) {
  const all = readAll();
  return Object.entries(all)
    .filter(([, v]) => (v?.count || 0) > 0)
    .sort((a, b) =>
      (b[1].count || 0) - (a[1].count || 0) ||
      (b[1].lastUsedMs || 0) - (a[1].lastUsedMs || 0))
    .slice(0, n)
    .map(([id]) => id);
}

/** Most recently activated N skill ids (desc by lastUsedMs). */
export function recentSkillIds(n = 3) {
  const all = readAll();
  return Object.entries(all)
    .filter(([, v]) => (v?.lastUsedMs || 0) > 0)
    .sort((a, b) => (b[1].lastUsedMs || 0) - (a[1].lastUsedMs || 0))
    .slice(0, n)
    .map(([id]) => id);
}
