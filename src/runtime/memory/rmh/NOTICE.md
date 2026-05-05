# Vendored from Ori-Mnemos

This directory contains code vendored from the Ori-Mnemos project.

- **Upstream:** https://github.com/aayoawoyemi/Ori-Mnemos
- **Original license:** Apache-2.0 (see `LICENSE`)
- **Vendor version:** 0.5.5
- **Vendor commit:** `8db691aabb4e838e414fedd789b9ab7cb867c358`
- **Vendor date:** 2026-05-05
- **Original location:** `src/core/*.ts`
- **Transpiled with:** esbuild (TS → ESM JS, `--target=node18 --format=esm --platform=node`)

## What we vendored

32 files from `src/core/` covering the RMH retrieval stack: BM25, embeddings,
PPR, RRF fusion, ACT-R vitality, spreading activation, Hebbian co-occurrence,
multi-hop explore, Q-learning RL on retrieval, frontmatter/wiki-link parsers,
warmth + explore audit logs, vault management, schema validation.

## What we deliberately did not vendor

| File | Reason |
|---|---|
| `llm.ts` | Koi has its own `llm-provider.js` with credit system, factory, multi-provider fallback. Vendoring would create duplicate config. |
| `update-check.ts` | Pings npm for ori-memory updates. Irrelevant for vendored code. |
| `bridge.ts` | Builds Ori install plans for claude-code, cursor, hermes adapters. Not relevant for Koi's embedded use. |
| `*.test.ts` | Tests stay upstream. We write our own integration tests. |

The Ori CLI (`src/cli/`), MCP server (`src/serve.ts`), benchmarks (`bench/`),
adapters (`adapters/`), and agent protocol (`src/agents/`) were also not
vendored — they are not part of the retrieval engine.

## Divergences from upstream (koi-fork modifications)

Each modified file carries `// koi-fork: <reason>` comments at the lines that
diverge from upstream. The full list of modified files:

- `engine.js` — replaced `@huggingface/transformers` pipeline with Koi's
  `embedding-provider.js` (cloud embeddings via `_koi-bridge.js`).
- `vault.js` — vault root is `<project>/.koi/memory/`; global vault is
  `~/.koi-memory/`. Added `getAgentScopePaths()` for self/<agent> scope.
- `config.js` — inline `DEFAULT_LLM_CONFIG` (was imported from `./llm.js`).
- `explore.js` — replaced `NullProvider instanceof` check with `isNullLlm()`
  duck-typing via bridge (was imported from `./llm.js`).
- `explore-audit.js` — env var `ORI_EXPLORE_AUDIT` → `KOI_EXPLORE_AUDIT`.
- `warmth-audit.js` — env var `ORI_WARMTH_AUDIT` → `KOI_WARMTH_AUDIT`.

Reward signal wiring (`reward.js`) and event-log emission live in the Koi
memory wrapper layer at `../index.js`, not as in-file modifications. The RL
`SessionRewardAccumulator` is fed from Koi-side at retrieve/write time.

`promote.js` and `classify.js` are pinned unchanged — they are 100%
heuristic-based in v0.5.5 and do not call LLM directly.

## Bridge file (not vendored)

`_koi-bridge.js` is a koi-side file that lives inside `rmh/` for path
co-location. It is the single point through which vendored code reaches
into Koi runtime (embeddings, LLM, event log). Vendored files import from
this bridge, never from outside `rmh/`.

## Update policy

Manual review every ~3 months against upstream. No automatic updates.

When merging upstream changes:
1. Read the CHANGELOG of new releases.
2. Cherry-pick bug fixes to algorithms (BM25, PPR, RRF, ACT-R, etc.) — these
   are pinned and unmodified, so merging is safe.
3. Re-evaluate any new features case by case.
4. Bump `VERSION` and update this file with the new commit hash.
5. Re-apply koi-fork modifications.

## Post-modification state (Day 2 complete)

All koi-fork modifications applied. The vendored layer parses cleanly under
`node --check` and has zero imports outside `rmh/` other than `_koi-bridge.js`.
Functional integration with Koi runtime happens via `configureKoiBridge()`
called from the wrapper at `../index.js`.
