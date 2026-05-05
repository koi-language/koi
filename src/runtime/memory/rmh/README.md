# rmh — Recursive Memory Harness (vendored)

This directory contains the retrieval engine for Koi's memory system, vendored
from [Ori-Mnemos](https://github.com/aayoawoyemi/Ori-Mnemos) (Apache-2.0).

**Do not edit pinned files directly.** See `NOTICE.md` for the vendoring
policy and the list of files that were intentionally modified (`koi-fork`
markers) versus files that mirror upstream.

## What lives here

- BM25 keyword scoring (`bm25.js`)
- Embedding similarity + SQLite index (`engine.js` — koi-fork)
- Personalized PageRank (`ppr.js`)
- ACT-R vitality decay (`vitality.js`)
- Spreading activation (`activation.js`)
- Hebbian co-occurrence (`cooccurrence.js`)
- RRF fusion of all signals (`fusion.js`)
- Recursive multi-hop explore (`explore.js` — koi-fork)
- Q-learning over retrieval (`qvalue.js`, `reward.js` — koi-fork, `stage-learner.js`, `stage-tracker.js`)
- Wiki-link graph (`graph.js`, `linkdetect.js`)
- Frontmatter parser + schema validator (`frontmatter.js`, `schema.js`)
- Vault management (`vault.js` — koi-fork)
- Audit logs as structured JSONL (`explore-audit.js`, `warmth-audit.js` — koi-fork env-var rename)

The public API for the rest of Koi lives one level up at
`src/runtime/memory/index.js`. Code in this directory should not be imported
directly from outside `src/runtime/memory/`.

## Why vendored, not a dependency?

See `NOTICE.md` and the design rationale in `KOI.md` (memory architecture
section).
