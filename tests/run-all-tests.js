#!/usr/bin/env node

/**
 * Test Runner for Koi Syntax Tests
 * Runs all syntax tests and reports results
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test configuration
const TEST_DIRS = [
  { path: join(__dirname, 'syntax'), name: 'Syntax Tests' },
  { path: join(__dirname, 'koi-features'), name: 'Koi Features Tests' }
];
const TIMEOUT = 30000; // 30 seconds per test

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m'
};

// Tests whose playbooks invoke the LLM at runtime (free-form playbook"""...""")
// and therefore need a configured provider. When no API key is set, the runtime
// triggers an interactive setup prompt that hangs in a non-TTY exec() — skip
// these cleanly instead of failing.
const LLM_REQUIRED_TESTS = new Set(['03-skills', '07-imports']);
const HAS_LLM = Boolean(
  process.env.OPENAI_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.KOI_AUTH_TOKEN,
);

async function runTest(testFile, testsDir) {
  const testName = testFile.replace('.koi', '');
  const testPath = join(testsDir, testFile);

  if (LLM_REQUIRED_TESTS.has(testName) && !HAS_LLM) {
    return { name: testName, skipped: true, reason: 'No LLM provider configured (set OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY)' };
  }

  try {
    const startTime = Date.now();
    // Invoke the koi compiler CLI directly via node — the global `koi`
    // command on a developer's machine often links to the koi-cli
    // interactive binary, which spawns a login flow under exec() and
    // crashes (no TTY for setRawMode). --no-precalculate skips the
    // LLM-driven affordance generation at compile time.
    const koiBin = join(__dirname, '..', 'src', 'cli', 'koi.js');
    const { stdout, stderr } = await execAsync(
      `KOI_RUNTIME_PATH=${join(__dirname, '../src/runtime')} node ${koiBin} run --no-precalculate ${testPath} < /dev/null`,
      { timeout: TIMEOUT }
    );
    const duration = Date.now() - startTime;

    return {
      name: testName,
      passed: true,
      duration,
      output: stdout,
      error: null
    };
  } catch (error) {
    return {
      name: testName,
      passed: false,
      duration: 0,
      output: error.stdout || '',
      error: error.stderr || error.message
    };
  }
}

async function runAllTests() {
  console.log(`${colors.blue}╔════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.blue}║         Koi Test Suite                        ║${colors.reset}`);
  console.log(`${colors.blue}╚════════════════════════════════════════════════╝${colors.reset}`);
  console.log('');

  try {
    const allResults = [];

    // Run tests from each directory
    for (const testDir of TEST_DIRS) {
      console.log(`${colors.blue}${testDir.name}${colors.reset}`);
      console.log(`${colors.blue}${'─'.repeat(48)}${colors.reset}\n`);

      // Get all test files
      const files = await readdir(testDir.path);
      const testFiles = files.filter(f => f.endsWith('.koi')).sort();

      if (testFiles.length === 0) {
        console.log(`${colors.yellow}No test files found in ${testDir.path}${colors.reset}\n`);
        continue;
      }

      console.log(`Found ${testFiles.length} test files\n`);

      // Run tests
      for (const testFile of testFiles) {
        process.stdout.write(`${colors.gray}Running ${testFile}...${colors.reset} `);
        const result = await runTest(testFile, testDir.path);
        allResults.push(result);

        if (result.skipped) {
          console.log(`${colors.yellow}⊘ SKIP${colors.reset} ${colors.gray}(${result.reason})${colors.reset}`);
        } else if (result.passed) {
          console.log(`${colors.green}✓ PASS${colors.reset} ${colors.gray}(${result.duration}ms)${colors.reset}`);
        } else {
          console.log(`${colors.red}✗ FAIL${colors.reset}`);
        }
      }

      console.log('');
    }

    const results = allResults;

    // Print summary
    console.log('');
    console.log(`${colors.blue}════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.blue}Test Summary${colors.reset}`);
    console.log(`${colors.blue}════════════════════════════════════════════════${colors.reset}`);

    const passed = results.filter(r => r.passed).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.passed && !r.skipped).length;
    const total = results.length;

    console.log(`Total: ${total}`);
    console.log(`${colors.green}Passed: ${passed}${colors.reset}`);
    if (skipped > 0) {
      console.log(`${colors.yellow}Skipped: ${skipped}${colors.reset}`);
    }
    if (failed > 0) {
      console.log(`${colors.red}Failed: ${failed}${colors.reset}`);
    }

    // Print failed tests details
    if (failed > 0) {
      console.log('');
      console.log(`${colors.red}Failed Tests:${colors.reset}`);
      for (const result of results.filter(r => !r.passed && !r.skipped)) {
        console.log(`\n${colors.red}✗ ${result.name}${colors.reset}`);
        if (result.error) {
          console.log(`${colors.gray}${result.error}${colors.reset}`);
        }
      }
    }

    console.log('');

    // Exit with error code if any tests failed (skipped are NOT failures)
    process.exit(failed > 0 ? 1 : 0);

  } catch (error) {
    console.error(`${colors.red}Error running tests: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

// Run tests
runAllTests();
