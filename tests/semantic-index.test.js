/**
 * Test: SemanticIndex — build + parallel search
 *
 * Validates:
 *   1. Index builds from source files
 *   2. Single search returns results
 *   3. Two parallel searches both return results (the deadlock bug)
 *   4. Search during build returns empty
 *
 * Uses a mock LLM provider (no real API calls).
 * Run: node tests/semantic-index.test.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeDir = path.join(__dirname, '..', 'src', 'runtime');

// ─── Mock LLM Provider ──────────────────────────────────────────────────

let embeddingCallCount = 0;

const mockLlmProvider = {
  async getEmbedding(text) {
    embeddingCallCount++;
    // Deterministic pseudo-embedding based on text hash
    const hash = simpleHash(text);
    const vec = new Array(1536);
    for (let i = 0; i < 1536; i++) {
      vec[i] = Math.sin(hash + i * 0.01) * 0.5;
    }
    return vec;
  },

  async callJSON(prompt, agent, opts) {
    // Return mock descriptions
    if (prompt.includes('function')) {
      // Extract function names from prompt
      const names = [...prompt.matchAll(/\d+\.\s+(\w+)\(/g)].map(m => m[1]);
      const descriptions = {};
      for (const name of names) {
        descriptions[name] = `Mock description of ${name}`;
      }
      return { descriptions };
    }
    return { description: 'Mock file/class description' };
  }
};

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

// ─── Test Fixtures ───────────────────────────────────────────────────────

const SAMPLE_JS = `
class UserService {
  constructor(db) {
    this.db = db;
  }

  async findById(id) {
    return this.db.query('SELECT * FROM users WHERE id = ?', [id]);
  }

  async validateEmail(email) {
    const regex = /^[^@]+@[^@]+\\.[^@]+$/;
    return regex.test(email);
  }

  async createUser(name, email) {
    if (!await this.validateEmail(email)) {
      throw new Error('Invalid email');
    }
    return this.db.insert('users', { name, email });
  }
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

const parseConfig = (raw) => {
  return JSON.parse(raw);
};

export { UserService, formatDate, parseConfig };
`;

const SAMPLE_PY = `
class DataProcessor:
    def __init__(self, source):
        self.source = source
        self.cache = {}

    def load_data(self, path):
        with open(path) as f:
            return f.read()

    def transform(self, data, rules):
        for rule in rules:
            data = rule.apply(data)
        return data

def calculate_metrics(data):
    total = sum(data)
    avg = total / len(data)
    return {"total": total, "average": avg}
`;

// ─── Test Runner ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== SemanticIndex Tests ===\n');

  // Setup temp directories
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-sem-test-'));
  const projectDir = path.join(tmpBase, 'project');
  const cacheDir = path.join(tmpBase, 'cache');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });

  // Write sample files
  fs.writeFileSync(path.join(projectDir, 'src', 'user-service.js'), SAMPLE_JS);
  fs.writeFileSync(path.join(projectDir, 'src', 'processor.py'), SAMPLE_PY);

  // Import SemanticIndex
  const { SemanticIndex } = await import(path.join(runtimeDir, 'semantic-index.js'));
  const index = new SemanticIndex(cacheDir, mockLlmProvider);

  // ── Test 1: Build ──────────────────────────────────────────────────
  console.log('Test 1: Build index');
  let buildResult;
  try {
    buildResult = await withTimeout(
      index.build(projectDir, (done, total) => {
        process.stdout.write(`\r  Building: ${done}/${total}`);
      }),
      30000,
      'build'
    );
    console.log('');
    assert(buildResult.indexed > 0, `Indexed ${buildResult.indexed} files`);
    assert(buildResult.total >= 2, `Found ${buildResult.total} files`);
  } catch (err) {
    console.log('');
    assert(false, `Build failed: ${err.message}`);
    cleanup(tmpBase);
    return summary();
  }

  // ── Test 2: isReady ────────────────────────────────────────────────
  console.log('\nTest 2: isReady');
  const ready = await index.isReady();
  assert(ready === true, 'Index reports ready after build');

  // ── Test 3: Single search ──────────────────────────────────────────
  console.log('\nTest 3: Single search');
  try {
    const queryVec = await mockLlmProvider.getEmbedding('validate email address');
    const results = await withTimeout(
      index.search(queryVec, { limit: 10 }),
      5000,
      'single search'
    );
    assert(Array.isArray(results), 'Returns array');
    assert(results.length > 0, `Got ${results.length} results`);
    assert(results[0].score > 0, `Top score: ${results[0]?.score?.toFixed(3)}`);
    assert(results[0].type !== undefined, `Result type: ${results[0]?.type}`);
    assert(results[0].filePath !== undefined, `Result path: ${results[0]?.filePath}`);
    if (results[0]) {
      console.log(`    Top result: [${results[0].type}] ${results[0].name} in ${results[0].filePath} (score ${results[0].score.toFixed(3)})`);
    }
  } catch (err) {
    assert(false, `Single search failed: ${err.message}`);
  }

  // ── Test 4: PARALLEL searches (the deadlock bug) ───────────────────
  console.log('\nTest 4: Parallel searches (2 concurrent)');
  try {
    const [vecA, vecB] = await Promise.all([
      mockLlmProvider.getEmbedding('database query user'),
      mockLlmProvider.getEmbedding('data processing transform'),
    ]);

    const startMs = Date.now();
    const [resultsA, resultsB] = await withTimeout(
      Promise.all([
        index.search(vecA, { limit: 5 }),
        index.search(vecB, { limit: 5 }),
      ]),
      5000,
      'parallel searches'
    );
    const elapsed = Date.now() - startMs;

    assert(Array.isArray(resultsA), `Search A returned array (${resultsA.length} results)`);
    assert(Array.isArray(resultsB), `Search B returned array (${resultsB.length} results)`);
    assert(resultsA.length > 0, `Search A has results`);
    assert(resultsB.length > 0, `Search B has results`);
    assert(elapsed < 2000, `Parallel took ${elapsed}ms (should be <2000ms)`);
    console.log(`    Search A top: [${resultsA[0]?.type}] ${resultsA[0]?.name} (${resultsA[0]?.score?.toFixed(3)})`);
    console.log(`    Search B top: [${resultsB[0]?.type}] ${resultsB[0]?.name} (${resultsB[0]?.score?.toFixed(3)})`);
  } catch (err) {
    assert(false, `Parallel searches DEADLOCKED or failed: ${err.message}`);
  }

  // ── Test 5: THREE parallel searches ────────────────────────────────
  console.log('\nTest 5: Three parallel searches');
  try {
    const [v1, v2, v3] = await Promise.all([
      mockLlmProvider.getEmbedding('format date'),
      mockLlmProvider.getEmbedding('parse config json'),
      mockLlmProvider.getEmbedding('class constructor initialization'),
    ]);

    const startMs = Date.now();
    const [r1, r2, r3] = await withTimeout(
      Promise.all([
        index.search(v1, { limit: 5 }),
        index.search(v2, { limit: 5 }),
        index.search(v3, { limit: 5 }),
      ]),
      5000,
      '3 parallel searches'
    );
    const elapsed = Date.now() - startMs;

    assert(r1.length > 0 && r2.length > 0 && r3.length > 0, `All 3 returned results (${r1.length}, ${r2.length}, ${r3.length})`);
    assert(elapsed < 2000, `3-parallel took ${elapsed}ms`);
  } catch (err) {
    assert(false, `3 parallel searches failed: ${err.message}`);
  }

  // ── Test 6: Search with type filter ────────────────────────────────
  console.log('\nTest 6: Search with type filter');
  try {
    const vec = await mockLlmProvider.getEmbedding('user service class');
    const funcResults = await withTimeout(
      index.search(vec, { type: 'function', limit: 5 }),
      5000,
      'filtered search'
    );
    const classResults = await withTimeout(
      index.search(vec, { type: 'class', limit: 5 }),
      5000,
      'class search'
    );
    assert(funcResults.every(r => r.type === 'function'), `Function filter works (${funcResults.length} results)`);
    assert(classResults.every(r => r.type === 'class'), `Class filter works (${classResults.length} results)`);
  } catch (err) {
    assert(false, `Filtered search failed: ${err.message}`);
  }

  // ── Test 7: Search during build returns empty ──────────────────────
  console.log('\nTest 7: Search during build returns empty');
  try {
    // Modify a file to force re-index
    fs.writeFileSync(path.join(projectDir, 'src', 'new-file.js'), 'function hello() { return "world"; }');

    const index2 = new SemanticIndex(cacheDir, mockLlmProvider);
    // Start build but don't await it
    const buildPromise = index2.build(projectDir);

    // Immediately try to search
    const vec = await mockLlmProvider.getEmbedding('anything');
    const results = await index2.search(vec, { limit: 5 });

    assert(index2.isBuilding() === true, 'isBuilding() returns true during build');
    assert(results.length === 0, 'Search during build returns empty array');

    await buildPromise; // let build finish
    assert(index2.isBuilding() === false, 'isBuilding() returns false after build');

    // Now search should work
    const resultsAfter = await withTimeout(
      index2.search(vec, { limit: 5 }),
      5000,
      'search after build'
    );
    assert(resultsAfter.length > 0, `Search after build returns ${resultsAfter.length} results`);
  } catch (err) {
    assert(false, `Build-during-search test failed: ${err.message}`);
  }

  // ── Test 8: Incremental index (skip unchanged) ─────────────────────
  console.log('\nTest 8: Incremental index');
  try {
    embeddingCallCount = 0;
    const index3 = new SemanticIndex(cacheDir, mockLlmProvider);
    const result = await withTimeout(
      index3.build(projectDir),
      30000,
      'incremental build'
    );
    assert(result.skipped > 0, `Skipped ${result.skipped} unchanged files`);
    console.log(`    indexed=${result.indexed}, skipped=${result.skipped}, total=${result.total}`);
  } catch (err) {
    assert(false, `Incremental build failed: ${err.message}`);
  }

  // Cleanup
  cleanup(tmpBase);
  summary();
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function summary() {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'─'.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
