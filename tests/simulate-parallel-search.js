/**
 * Simulates EXACTLY what the agent does: two parallel semantic_code_search calls.
 * Each step has a timeout to identify WHERE it hangs.
 *
 * Run: node tests/simulate-parallel-search.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Mock LLM that adds realistic delay ──────────────────────────────────

const mockLlm = {
  async getEmbedding(text) {
    // Simulate ~200ms API call (realistic OpenAI embedding latency)
    await new Promise(r => setTimeout(r, 200));
    const hash = simpleHash(text);
    const vec = new Array(1536);
    for (let i = 0; i < 1536; i++) vec[i] = Math.sin(hash + i * 0.01) * 0.5;
    return vec;
  },
  async callJSON(prompt) {
    await new Promise(r => setTimeout(r, 100));
    const names = [...prompt.matchAll(/\d+\.\s+(\w+)\(/g)].map(m => m[1]);
    const descriptions = {};
    for (const n of names) descriptions[n] = `Mock description of ${n}`;
    return names.length ? { descriptions } : { description: 'Mock description' };
  }
};

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return h;
}

// ─── Timeout helper ──────────────────────────────────────────────────────

async function timed(label, promise, timeoutMs = 5000) {
  const start = Date.now();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HUNG at "${label}" after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    console.log(`  [${elapsed}ms] ${label} — OK`);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Simulate one semantic_code_search action ────────────────────────────

async function simulateSearchAction(index, query, label) {
  console.log(`\n  --- ${label} START ---`);

  // Step 1: isBuilding check (what the action does first)
  const building = index.isBuilding();
  console.log(`  [0ms] ${label}: isBuilding() = ${building}`);
  if (building) return { label, results: [], note: 'building' };

  // Step 2: isReady check (touches LanceDB if cache not loaded)
  const ready = await timed(`${label}: isReady()`, index.isReady(), 5000);
  if (!ready) return { label, results: [], note: 'not ready' };

  // Step 3: getEmbedding (API call to OpenAI — simulated with delay)
  const embedding = await timed(`${label}: getEmbedding("${query}")`, mockLlm.getEmbedding(query), 5000);

  // Step 4: search (should be in-memory after cache load)
  const results = await timed(`${label}: search()`, index.search(embedding, { limit: 5 }), 5000);

  console.log(`  --- ${label} END: ${results.length} results ---`);
  return { label, results };
}

// ─── Main ────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== Simulating Agent Parallel Search ===\n');

  // Setup: build a small index first
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-sim-'));
  const cacheDir = path.join(tmpBase, 'cache');
  const projectDir = path.join(tmpBase, 'project');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });

  // Write sample files (enough to make it realistic)
  fs.writeFileSync(path.join(projectDir, 'src', 'auth.js'), `
class AuthService {
  constructor(db, tokenStore) { this.db = db; this.tokenStore = tokenStore; }
  async login(email, password) { const user = await this.db.findByEmail(email); return this.tokenStore.sign(user); }
  async validateToken(token) { return this.tokenStore.verify(token); }
  async logout(token) { return this.tokenStore.revoke(token); }
}
function hashPassword(pw) { return require('crypto').createHash('sha256').update(pw).digest('hex'); }
export { AuthService, hashPassword };
`);

  fs.writeFileSync(path.join(projectDir, 'src', 'parser.py'), `
class CodeParser:
    def __init__(self, grammar):
        self.grammar = grammar
    def parse(self, source):
        return self.grammar.match(source)
    def extract_symbols(self, tree):
        return [n for n in tree.walk() if n.is_named]
def supported_languages():
    return ['javascript', 'python', 'typescript']
`);

  // 1. Build the index
  console.log('Step 1: Building index...');
  const { getSemanticIndex } = await import('../src/runtime/semantic-index.js');
  const index = getSemanticIndex(cacheDir, mockLlm);
  await timed('build()', index.build(projectDir), 30000);

  // Verify cache is loaded
  console.log(`\nCache loaded: ${index._cache !== null}`);
  if (index._cache) {
    console.log(`  files: ${index._cache.files.length}, classes: ${index._cache.classes.length}, functions: ${index._cache.functions.length}`);
  }

  // 2. Simulate what the agent does: two parallel semantic_code_search
  console.log('\n\nStep 2: Two PARALLEL searches (simulating agent)...');
  const start = Date.now();

  try {
    const [resultA, resultB] = await timed(
      'Promise.all([searchA, searchB])',
      Promise.all([
        simulateSearchAction(index, 'authentication login token', 'SearchA'),
        simulateSearchAction(index, 'supported programming languages', 'SearchB'),
      ]),
      10000
    );

    const elapsed = Date.now() - start;
    console.log(`\nTotal parallel time: ${elapsed}ms`);
    console.log(`SearchA: ${resultA.results.length} results`);
    console.log(`SearchB: ${resultB.results.length} results`);

    if (resultA.results.length > 0) {
      console.log(`  A top: [${resultA.results[0].type}] ${resultA.results[0].name} (${resultA.results[0].score?.toFixed(3)})`);
    }
    if (resultB.results.length > 0) {
      console.log(`  B top: [${resultB.results[0].type}] ${resultB.results[0].name} (${resultB.results[0].score?.toFixed(3)})`);
    }
  } catch (err) {
    console.error(`\nFAILED: ${err.message}`);
  }

  // 3. Now test with a FRESH instance (simulates restart — cache not loaded)
  console.log('\n\nStep 3: Fresh instance (cache not loaded) + two parallel searches...');

  // Create a new instance that has NO cache — simulates first search after restart
  const { SemanticIndex } = await import('../src/runtime/semantic-index.js');
  const freshIndex = new SemanticIndex(cacheDir, mockLlm);

  console.log(`Fresh cache: ${freshIndex._cache !== null}`);
  console.log(`Fresh _ready: ${freshIndex._ready}`);

  const start2 = Date.now();
  try {
    const [rA, rB] = await timed(
      'Promise.all([freshSearchA, freshSearchB])',
      Promise.all([
        simulateSearchAction(freshIndex, 'code parsing grammar', 'FreshA'),
        simulateSearchAction(freshIndex, 'hash password crypto', 'FreshB'),
      ]),
      15000
    );

    const elapsed2 = Date.now() - start2;
    console.log(`\nTotal parallel time (fresh): ${elapsed2}ms`);
    console.log(`FreshA: ${rA.results.length} results, FreshB: ${rB.results.length} results`);
  } catch (err) {
    console.error(`\nFRESH INSTANCE FAILED: ${err.message}`);
    console.error('This means _loadCacheFromDb() hangs on LanceDB read!');
  }

  // Cleanup
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}

  console.log('\n=== Done ===\n');
}

run().catch(err => {
  console.error('CRASHED:', err);
  process.exit(1);
});
