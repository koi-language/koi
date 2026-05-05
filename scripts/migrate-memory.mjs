#!/usr/bin/env node
/**
 * One-time migration of legacy memory data to the new Ori-vendored vault.
 *
 * Sources covered:
 *   - LatentStore (LanceDB at ~/.koi/sessions/<sid>/lancedb/latent) — these
 *     held SHORT/MEDIUM-tier session summaries. By design they were not
 *     long-term knowledge, so by default we DO NOT migrate them.
 *   - session-knowledge.js — was in-memory only, nothing to migrate.
 *
 * Set --include-latent to import LatentStore entries as `type=insight` notes
 * with `confidence=speculative` (so they don't pollute high-confidence
 * retrievals). Most users should NOT use this flag — old latent memories
 * are usually stale and noisy.
 *
 * Usage:
 *   node scripts/migrate-memory.mjs                # report-only (default)
 *   node scripts/migrate-memory.mjs --apply        # do nothing currently
 *   node scripts/migrate-memory.mjs --include-latent --apply  # opt-in import
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const INCLUDE_LATENT = args.has('--include-latent');

async function main() {
  console.log('koi memory migration');
  console.log('');

  // session-knowledge: nothing to migrate (was ephemeral in-memory only).
  console.log('• session-knowledge.js: ephemeral, nothing to migrate.');

  // LatentStore: discover legacy sessions
  const koiSessionsDir = path.join(os.homedir(), '.koi', 'sessions');
  let sessionDirs = [];
  try {
    sessionDirs = (await fs.readdir(koiSessionsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('• LatentStore: no legacy sessions found.');
      return;
    }
    throw err;
  }

  let lanceCount = 0;
  for (const sid of sessionDirs) {
    const lancedbPath = path.join(koiSessionsDir, sid, 'lancedb');
    try {
      const stat = await fs.stat(lancedbPath);
      if (stat.isDirectory()) lanceCount++;
    } catch { /* no lancedb in this session */ }
  }

  if (lanceCount === 0) {
    console.log('• LatentStore: no legacy LanceDB stores found across sessions.');
    return;
  }

  console.log(`• LatentStore: found ${lanceCount} session(s) with LanceDB data.`);
  if (!INCLUDE_LATENT) {
    console.log('  By default these are NOT migrated (low long-term value, often stale).');
    console.log('  Run with --include-latent --apply to import as type=insight,');
    console.log('  confidence=speculative notes in the project vault.');
    return;
  }

  if (!APPLY) {
    console.log('  --include-latent set without --apply: dry-run only.');
    return;
  }

  // The actual import would open each LanceDB session, read the `latent`
  // table, generate one markdown per row in the project vault inbox/, and
  // let promote.js handle them. This is intentionally NOT implemented yet:
  //   - Implementing it requires LanceDB still being installed (it goes
  //     away in phase 4) and depends on the old schema details.
  //   - Most users don't have meaningful LatentStore data.
  // If you find yourself with valuable old data and need this, file an
  // issue — the schema is { summary, embedding, importance, ts }.
  console.warn('  --include-latent --apply: not implemented in v1. See top-of-file comment.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
