/**
 * Memory vault helpers — re-exports rmh/vault.js plus Koi-specific init.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  findVaultRoot,
  findVaultRootWithSource,
  getAgentScopePaths,
  getGlobalVaultPath,
  getVaultPaths,
  isVaultRoot,
  vaultPathFor,
} from './rmh/vault.js';

export {
  findVaultRoot,
  findVaultRootWithSource,
  getAgentScopePaths,
  getGlobalVaultPath,
  getVaultPaths,
  isVaultRoot,
  vaultPathFor,
};

const SCAFFOLD_DIRS = [
  '.ori',          // marker IS a directory — engine stores embeddings.db here
  'notes',
  'inbox',
  'templates',
  'self',
  'ops',
  'ops/sessions',
  'ops/observations',
];

const DEFAULT_NOTE_TEMPLATE = `---
_schema:
  entity_type: "note"
  applies_to: "notes/*.md"
  required:
    - description
    - type
    - project
    - status
    - created
  optional:
    - confidence
    - alternatives
    - rationale
    - superseded_by
    - source_events
  enums:
    type:
      - idea
      - decision
      - learning
      - insight
      - blocker
      - opportunity
    status:
      - inbox
      - active
      - completed
      - superseded
      - archived
    confidence:
      - speculative
      - promising
      - validated
  constraints:
    description:
      max_length: 200
      format: "One sentence adding context beyond the title"

# Template fields
description: ""
type: ""
project: []
status: active
created: YYYY-MM-DD
---

# {prose-as-title}

{body}
`;

const DEFAULT_CONFIG = `# .koi/memory/ori.config.yaml — Koi memory configuration

vault:
  version: "0.1"

templates:
  default: templates/note.md

vitality:
  model: "actr"
  actr_decay: 0.5
  decay:
    idea: 90
    decision: 30
    learning: 30
    insight: 30
    blocker: 14
    opportunity: 30
  base: 1.0
  metabolic_rates:
    self: 0.1
    notes: 1.0
  structural_boost_per_link: 0.1
  structural_boost_cap: 10
  revival_decay_rate: 0.2
  revival_window_days: 14
  access_saturation_k: 10

promote:
  auto: true
  require_llm: false
  min_confidence: 0.6
  project_keywords: {}
  project_map_routing: {}
  default_area: "index"

# llm.* is unused by Koi — Koi uses its own llm-provider.
llm:
  provider: null
  model: null
  api_key_env: null

graph:
  pagerank_alpha: 0.85
  bridge_vitality_floor: 0.5
  hub_degree_multiplier: 2.0

engine:
  embedding_dims: 1536
  piecewise_bins: 8
  community_dims: 16
  db_path: ".ori/embeddings.db"

retrieval:
  default_limit: 10
  candidate_multiplier: 5
  rrf_k: 60
  signal_weights:
    composite: 0.36
    keyword: 0.18
    graph: 0.26
    warmth: 0.20
  exploration_budget: 0.10

warmth:
  enabled: true
  surprise_threshold: 0.15
  activation_threshold: 0.35
  ppr_alpha: 0.15
  ppr_iterations: 20
  graph_weight: 0.3
  max_results: 20
  shadow_compare_enabled: false

bm25:
  k1: 1.2
  b: 0.75
  title_boost: 3.0
  description_boost: 2.0

ips:
  enabled: true
  epsilon: 0.01
  log_path: "ops/access.jsonl"
`;

/**
 * Create a fresh vault at the given path. Idempotent: if a vault already
 * exists, returns it without overwriting.
 *
 * @param {string} vaultRoot  Absolute path to vault root (e.g., <repo>/.koi/memory).
 * @returns {Promise<{paths: object, created: boolean}>}
 */
export async function initVault(vaultRoot) {
  const paths = getVaultPaths(vaultRoot);
  if (await isVaultRoot(vaultRoot)) {
    return { paths, created: false };
  }
  // Create vault root + scaffold dirs (.ori is a dir, not a file —
  // engine.js stores embeddings.db inside it)
  await fs.mkdir(vaultRoot, { recursive: true });
  for (const dir of SCAFFOLD_DIRS) {
    await fs.mkdir(path.join(vaultRoot, dir), { recursive: true });
  }
  // Write default config
  await fs.writeFile(paths.config, DEFAULT_CONFIG, 'utf8');
  // Write default note template
  await fs.writeFile(path.join(paths.templates, 'note.md'), DEFAULT_NOTE_TEMPLATE, 'utf8');
  return { paths, created: true };
}

/**
 * Resolve a vault for a project. Tries:
 *   1. <projectRoot>/.koi/memory (creates if {create: true} and missing)
 *   2. ~/.koi-memory (returns if exists)
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {boolean} [opts.create=true] Auto-create project vault if missing.
 * @returns {Promise<{path: string, source: 'project'|'global', created: boolean}>}
 */
export async function resolveVault({ projectRoot, create = true }) {
  const projectVault = vaultPathFor(projectRoot);
  if (await isVaultRoot(projectVault)) {
    return { path: projectVault, source: 'project', created: false };
  }
  if (create) {
    const { created } = await initVault(projectVault);
    return { path: projectVault, source: 'project', created };
  }
  const global = getGlobalVaultPath();
  if (await isVaultRoot(global)) {
    return { path: global, source: 'global', created: false };
  }
  throw new Error(
    `No vault at ${projectVault} or ${global}. Pass create:true or run koi memory init.`,
  );
}
