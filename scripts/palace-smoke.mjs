/**
 * Smoke test for the conversation memory palace (src/runtime/state/palace.js).
 *
 * Runs fully offline with a fake LLM/embedding provider. Run it with HOME
 * pointed at a scratch dir so the real index.sqlite is never touched:
 *
 *   HOME=$(mktemp -d) node scripts/palace-smoke.mjs
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import {
  sweepSessionIntoPalace,
  backfillPalace,
  migratePalaceGlobal,
  searchPalace,
  listRooms,
  listDrawers,
  countPalaceDrawers,
} from '../src/runtime/state/palace.js';
import { upsertConversation } from '../src/runtime/state/conversations.js';

// Refuse to run against the real home — this script writes to
// ~/.koi/media-library/vector-cache/index.sqlite.
if (!process.env.HOME || process.env.HOME === path.join('/Users', os.userInfo().username)) {
  console.error('Run with a scratch HOME:  HOME=$(mktemp -d) node scripts/palace-smoke.mjs');
  process.exit(1);
}

// ─── Fake provider ──────────────────────────────────────────────────────
// Deterministic 64-dim embeddings split into two topic subspaces so the
// centroid clustering MUST form exactly two rooms. simpleChat returns a
// canned label per topic.

function fakeEmbed(text) {
  const t = String(text).toLowerCase();
  const topic = (t.includes('stripe') || t.includes('webhook')) ? 0 : 1;
  const v = new Float32Array(64);
  for (let i = 0; i < 32; i++) v[topic * 32 + i] = 1;
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  v[(h % 32) + topic * 32] += 0.3; // small per-text jitter, same-topic cosine stays ≥0.95
  return v;
}

const fakeProvider = {
  embedCalls: 0,
  chatCalls: 0,
  async getEmbedding(text) { this.embedCalls++; return fakeEmbed(text); },
  async getEmbeddingBatch(texts) { this.embedCalls += texts.length; return texts.map(fakeEmbed); },
  async simpleChat(prompt) {
    this.chatCalls++;
    // Only look at the exchange body (after ---) — the instruction half of
    // the label prompt contains the literal example "Stripe webhook retries".
    const body = String(prompt).split('---')[1] || String(prompt);
    return body.toLowerCase().includes('stripe') ? 'Stripe webhooks' : 'Logo design';
  },
};

// ─── Fixture: dialogue turns (wire shapes from agent.js) ────────────────

const PROJECT = path.join(process.env.HOME, 'fake-project');
const SESSION_1 = 'smoke-session-1';
const SESSION_1_DIR = path.join(PROJECT, '.koi', 'sessions', SESSION_1);

const turns = [
  { ts: 1000, type: 'user_input', text: 'How do stripe webhooks retry on failure?' },
  { ts: 1001, type: 'action', intent: 'print', result: 'Stripe retries with exponential backoff for up to 3 days.' },
  { ts: 1002, type: 'action', intent: 'shell', result: 'curl -s https://api.stripe.com … (truncated tool noise)' },
  { ts: 2000, type: 'user_input', text: 'And how do I verify a stripe webhook signature?' },
  { ts: 2001, type: 'action', intent: 'print', result: 'Verify the Stripe-Signature header with your endpoint secret.' },
  { ts: 3000, type: 'user_input', text: 'Unrelated: what color should our logo be?' },
  { ts: 3001, type: 'action', intent: 'print', result: 'A teal logo would contrast well with the dark UI.' },
];

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${err.message}`); }
}

// ─── 1. First sweep ─────────────────────────────────────────────────────

console.log('1. first sweep');
const r1 = await sweepSessionIntoPalace({
  sessionId: SESSION_1,
  sessionDir: SESSION_1_DIR,
  projectRoot: PROJECT,
  llmProvider: fakeProvider,
  turns,
});
await check('sweeps 3 drawers', () => assert.strictEqual(r1.swept, 3));
const rooms1 = await listRooms({ projectRoot: PROJECT });
await check('forms exactly 2 rooms', () => assert.strictEqual(rooms1.length, 2));
await check('room labels from LLM', () => {
  const labels = rooms1.map((r) => r.label).sort();
  assert.deepStrictEqual(labels, ['Logo design', 'Stripe webhooks']);
});
await check('stripe room holds 2 drawers', () => {
  const stripe = rooms1.find((r) => r.label === 'Stripe webhooks');
  assert.strictEqual(stripe.drawerCount, 2);
});
await check('drawer count = 3', async () => assert.strictEqual(await countPalaceDrawers(PROJECT), 3));
await check('LLM consulted only at room creation (2 calls)', () =>
  assert.strictEqual(fakeProvider.chatCalls, 2));

// ─── 2. Verbatim + tool-noise exclusion ─────────────────────────────────

console.log('2. drawer contents');
const drawers = await listDrawers({ projectRoot: PROJECT, limit: 10 });
await check('3 drawers listed', () => assert.strictEqual(drawers.length, 3));
const first = drawers.find((d) => d.turnIndex === 0);
await check('verbatim user text', () =>
  assert.strictEqual(first.userText, 'How do stripe webhooks retry on failure?'));
await check('verbatim assistant prose, tool noise excluded', () =>
  assert.strictEqual(first.assistantText, 'Stripe retries with exponential backoff for up to 3 days.'));

// ─── 3. Search ──────────────────────────────────────────────────────────

console.log('3. search');
const hits = await searchPalace({ query: 'stripe webhook signature', projectRoot: PROJECT, k: 3, llmProvider: fakeProvider });
await check('returns hits', () => assert.ok(hits.length >= 2));
await check('top hit is the signature drawer (BM25 + vector)', () =>
  assert.ok(hits[0].snippet.includes('signature') || hits[0].snippet.includes('Signature')));
await check('hits carry room label', () => assert.strictEqual(hits[0].room, 'Stripe webhooks'));
await check('hits carry dialoguePath', () => assert.ok(hits[0].dialoguePath.endsWith('dialogue.jsonl')));
const scoped = await searchPalace({ query: 'stripe', projectRoot: PROJECT, roomLabel: 'logo design', k: 5, llmProvider: fakeProvider });
await check('room scoping (case-insensitive) filters to that room', () =>
  assert.ok(scoped.every((h) => h.room === 'Logo design')));

// ─── 4. Idempotency + last-pair re-sweep ────────────────────────────────

console.log('4. idempotency');
const r2 = await sweepSessionIntoPalace({
  sessionId: SESSION_1, sessionDir: SESSION_1_DIR, projectRoot: PROJECT, llmProvider: fakeProvider, turns,
});
await check('re-sweep of unchanged dialogue writes nothing', () => assert.strictEqual(r2.swept, 0));
await check('drawer count still 3', async () => assert.strictEqual(await countPalaceDrawers(PROJECT), 3));

// Assistant adds another chunk to the LAST pair after the sweep — the
// inclusive watermark must fold it into the SAME drawer.
const turnsExtended = [...turns,
  { ts: 3002, type: 'action', intent: 'print', result: 'Hex suggestion: #0E7C7B.' },
];
const r3 = await sweepSessionIntoPalace({
  sessionId: SESSION_1, sessionDir: SESSION_1_DIR, projectRoot: PROJECT, llmProvider: fakeProvider, turns: turnsExtended,
});
await check('late assistant chunk re-sweeps exactly the last drawer', () => assert.strictEqual(r3.swept, 1));
await check('still 3 drawers (INSERT OR REPLACE, no dup)', async () =>
  assert.strictEqual(await countPalaceDrawers(PROJECT), 3));
const updated = (await listDrawers({ projectRoot: PROJECT, limit: 10 })).find((d) => d.turnIndex === 5);
await check('chunk folded into the same drawer', () =>
  assert.ok(updated.assistantText.includes('#0E7C7B') && updated.assistantText.includes('teal')));
const rooms2 = await listRooms({ projectRoot: PROJECT });
await check('re-embed kept its room (no new rooms, no double-count)', () => {
  assert.strictEqual(rooms2.length, 2);
  assert.strictEqual(rooms2.find((r) => r.label === 'Logo design').drawerCount, 1);
});

// ─── 5. Backfill from disk ──────────────────────────────────────────────

console.log('5. backfill');
const SESSION_2_DIR = path.join(PROJECT, '.koi', 'sessions', 'smoke-session-2');
fs.mkdirSync(SESSION_2_DIR, { recursive: true });
fs.writeFileSync(path.join(SESSION_2_DIR, 'dialogue.jsonl'), [
  JSON.stringify({ ts: 4000, type: 'user_input', text: 'Should the logo have a gradient?' }),
  JSON.stringify({ ts: 4001, type: 'action', intent: 'print', result: 'Flat color reads better at small sizes.' }),
].join('\n') + '\n');
// Persist session 1's dialogue too so backfill sees both but skips the swept one.
fs.mkdirSync(SESSION_1_DIR, { recursive: true });
fs.writeFileSync(path.join(SESSION_1_DIR, 'dialogue.jsonl'),
  turnsExtended.map((t) => JSON.stringify(t)).join('\n') + '\n');

const embedsBefore = fakeProvider.embedCalls;
await backfillPalace({ projectRoot: PROJECT, llmProvider: fakeProvider, maxConcurrency: 1 });
await check('backfill ingests the new session', async () =>
  assert.strictEqual(await countPalaceDrawers(PROJECT), 4));
await check('gradient drawer joined the logo room (centroid, no new room)', async () => {
  const rooms = await listRooms({ projectRoot: PROJECT });
  assert.strictEqual(rooms.length, 2);
  assert.strictEqual(rooms.find((r) => r.label === 'Logo design').drawerCount, 2);
});
const embedsAfterFirst = fakeProvider.embedCalls;
await backfillPalace({ projectRoot: PROJECT, llmProvider: fakeProvider, maxConcurrency: 1 });
await check('second backfill is a no-op (watermarks)', async () => {
  assert.strictEqual(await countPalaceDrawers(PROJECT), 4);
  assert.strictEqual(fakeProvider.embedCalls, embedsAfterFirst);
});
await check('first backfill only embedded the new pair', () =>
  assert.strictEqual(embedsAfterFirst - embedsBefore, 1));

// ─── 6. Degradation paths ───────────────────────────────────────────────

console.log('6. degradation');
const recents = await searchPalace({ query: '', projectRoot: PROJECT, k: 2, llmProvider: fakeProvider });
await check('empty query degrades to recents', () => assert.strictEqual(recents.length, 2));
const offline = await searchPalace({
  query: 'stripe', projectRoot: PROJECT, k: 2,
  llmProvider: { async getEmbedding() { throw new Error('offline'); }, async simpleChat() { return ''; } },
});
await check('embed failure degrades to recents (no throw)', () => assert.ok(Array.isArray(offline) && offline.length > 0));
const otherWing = await countPalaceDrawers('/nonexistent/project');
await check('wing scoping isolates projects', () => assert.strictEqual(otherWing, 0));

// ─── 7. Global migration (old conversations from OTHER projects + home) ──

console.log('7. global migration');
// An "old" project the user never reopens — known ONLY via its row in the
// conversations index (sessionDir + projectRoot).
const OLD_PROJECT = path.join(process.env.HOME, 'old-project');
const OLD_SESSION_DIR = path.join(OLD_PROJECT, '.koi', 'sessions', 'old-session-1');
fs.mkdirSync(OLD_SESSION_DIR, { recursive: true });
fs.writeFileSync(path.join(OLD_SESSION_DIR, 'dialogue.jsonl'), [
  JSON.stringify({ ts: 5000, type: 'user_input', text: 'How do we rotate the stripe API keys?' }),
  JSON.stringify({ ts: 5001, type: 'action', intent: 'print', result: 'Rotate from the dashboard, then update the env secret.' }),
].join('\n') + '\n');
await upsertConversation({
  sessionId: 'old-session-1',
  sessionDir: OLD_SESSION_DIR,
  projectRoot: OLD_PROJECT,
  title: 'Stripe key rotation',
  summary: 'Discussed rotating API keys.',
  embedding: fakeEmbed('stripe key rotation'),
});
// A home-level session (GUI, no project) — only discoverable by dir scan.
const HOME_SESSION_DIR = path.join(process.env.HOME, '.koi', 'sessions', 'home-session-1');
fs.mkdirSync(HOME_SESSION_DIR, { recursive: true });
fs.writeFileSync(path.join(HOME_SESSION_DIR, 'dialogue.jsonl'), [
  JSON.stringify({ ts: 6000, type: 'user_input', text: 'Make the logo bigger on the landing page' }),
  JSON.stringify({ ts: 6001, type: 'action', intent: 'print', result: 'Bumped the logo to 96px in the hero.' }),
].join('\n') + '\n');

await migratePalaceGlobal({ llmProvider: fakeProvider });
await check('migrates the old project found via conversations index', async () =>
  assert.strictEqual(await countPalaceDrawers(OLD_PROJECT), 1));
await check('migrates home-level sessions (wing "")', async () => {
  const homeDrawers = await listDrawers({ projectRoot: null, limit: 50 });
  assert.ok(homeDrawers.some((d) => d.sessionId === 'home-session-1' && d.projectRoot === ''));
});
await check('current project drawers survive migration untouched', async () =>
  assert.strictEqual(await countPalaceDrawers(PROJECT), 4));
const totalAfter = await countPalaceDrawers(null);
await migratePalaceGlobal({ llmProvider: fakeProvider });
await check('second migration call is a no-op', async () =>
  assert.strictEqual(await countPalaceDrawers(null), totalAfter));
await check('old-project drawer is searchable cross-wing', async () => {
  const hits = await searchPalace({ query: 'rotate stripe api keys', projectRoot: OLD_PROJECT, k: 3, llmProvider: fakeProvider });
  assert.ok(hits.length >= 1 && hits[0].snippet.includes('Rotate from the dashboard'));
});

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
