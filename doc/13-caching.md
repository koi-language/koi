# Caching Guide

Koi supports persistent caching for LLM responses to reduce costs and improve performance.

## Overview

The caching system:
- Stores LLM responses persistently
- Uses semantic matching for cache hits
- Configurable similarity threshold
- Automatic cache management

## Benefits

✅ **Reduce costs** - Reuse LLM responses
✅ **Faster execution** - Skip API calls
✅ **Offline testing** - Use cached responses
✅ **Consistent results** - Same input → same output

## Configuration

Environment variables:

```bash
# Enable persistent cache
export KOI_CACHE_ENABLED=true

# Cache directory (default: .koi-cache)
export KOI_CACHE_DIR=.koi-cache

# Similarity threshold (default: 0.95)
export KOI_CACHE_SIMILARITY_THRESHOLD=0.95
```

## How It Works

1. Agent makes LLM request
2. System checks cache for similar prompts
3. If match found (similarity > threshold) → return cached response
4. Otherwise → call LLM, cache response

## Cache Key

Cache key includes:
- Prompt content
- Model name
- Temperature
- Provider

## Cache Structure

```
.koi-cache/
├── embeddings.json       # Prompt embeddings
└── responses/
    ├── abc123.json       # Cached response 1
    └── def456.json       # Cached response 2
```

## Clearing Cache

```bash
rm -rf .koi-cache
```

For complete details, see [PERSISTENT_CACHE_GUIDE.md](../PERSISTENT_CACHE_GUIDE.md) in the root directory.

---

**Next**: [Complete Examples](14-examples.md) →
