# Registry - Shared Data Store

The Registry provides a simple, transparent API for agents to share and persist data. It's perfect for coordination, state sharing, and inter-agent communication.

## Table of Contents

- [Overview](#overview)
- [Basic Usage](#basic-usage)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Search Queries](#search-queries)
- [Backends](#backends)
- [Best Practices](#best-practices)

## Overview

The Registry is a key-value store that:
- **Persists data** between program runs
- **Shares data** between agents
- **Supports search** with query operators
- **Backend agnostic** - configurable storage (local file, Redis, MongoDB, etc.)
- **Transparent API** - agents don't need to know where data is stored

## Basic Usage

### Option 1: Natural Language (Recommended)

**The easiest way** to use the registry is through natural language in playbooks. The LLM automatically generates the appropriate registry operations:

```koi
Agent UserManager : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on createUser(args: Json) {
    playbook """
    Create a new user with ID {{args.id}}.
    Save to registry with name: {{args.name}}, age: {{args.age}}.
    """
  }

  on getUser(args: Json) {
    playbook """
    Load user {{args.id}} from the registry and return their information.
    """
  }

  on findAdults(args: Json) {
    playbook """
    Search the registry for all users who are 18 years or older.
    Return the list of adults.
    """
  }
}
```

**How it works:**
- LLM reads your natural language instructions
- Detects registry operations ("save to registry", "load from registry", "search registry")
- Automatically generates `registry_set`, `registry_get`, `registry_search` actions
- Executes them transparently

### Option 2: Direct API (Procedural Code)

For precise control, use the registry API directly in procedural code:

```koi
Agent Writer : Worker {
  on save(args: Json) {
    // Save simple value
    await registry.set("user:123", {
      name: "Alice",
      age: 30,
      email: "alice@example.com"
    })

    // Save config
    await registry.set("config:app", {
      theme: "dark",
      language: "en"
    })

    return { saved: true }
  }
}
```

### Reading Data

```koi
Agent Reader : Worker {
  on load(args: Json) {
    // Get by key
    const user = await registry.get("user:123")

    if (!user) {
      return { found: false }
    }

    console.log("User:", user.name)
    return { found: true, user: user }
  }
}
```

### Listing Keys

```koi
Agent Lister : Worker {
  on listUsers(args: Json) {
    // Get all keys with prefix
    const userKeys = await registry.keys("user:")

    console.log("Found", userKeys.length, "users")

    // Load all users
    const users = []
    for (const key of userKeys) {
      const user = await registry.get(key)
      users.push(user)
    }

    return { users: users }
  }
}
```

### Searching

```koi
Agent Searcher : Worker {
  on findAdults(args: Json) {
    // Search with query
    const results = await registry.search({
      age: { $gte: 18 }
    })

    console.log("Found", results.length, "adults")

    return { results: results }
  }
}
```

## Configuration

Create `.koi-config.json` in your project root:

```json
{
  "registry": {
    "backend": "local",
    "options": {
      "path": ".koi-registry",
      "autoSaveInterval": 5000
    }
  }
}
```

### Configuration Options

**Local Backend:**
- `path` - Directory for data file (default: `.koi-registry`)
- `autoSaveInterval` - Auto-save interval in ms (default: `5000`)

## API Reference

### `registry.set(key, value)`

Store a value.

```koi
await registry.set("user:123", { name: "Alice", age: 30 })
```

**Parameters:**
- `key` (string) - Unique identifier
- `value` (any) - Value to store (will be JSON serialized)

**Returns:** Promise<void>

### `registry.get(key)`

Retrieve a value.

```koi
const user = await registry.get("user:123")
```

**Parameters:**
- `key` (string) - Key to retrieve

**Returns:** Promise<any> - The stored value or `null` if not found

### `registry.delete(key)`

Delete a value.

```koi
const deleted = await registry.delete("user:123")
```

**Parameters:**
- `key` (string) - Key to delete

**Returns:** Promise<boolean> - `true` if deleted, `false` if not found

### `registry.has(key)`

Check if a key exists.

```koi
const exists = await registry.has("user:123")
```

**Parameters:**
- `key` (string) - Key to check

**Returns:** Promise<boolean>

### `registry.keys(prefix)`

List keys matching a prefix.

```koi
const userKeys = await registry.keys("user:")
// Returns: ["user:123", "user:456", ...]
```

**Parameters:**
- `prefix` (string) - Prefix to match (optional, empty = all keys)

**Returns:** Promise<string[]>

### `registry.search(query)`

Search for entries matching a query.

```koi
const results = await registry.search({
  age: { $gte: 18 },
  name: { $regex: "A" }
})
```

**Parameters:**
- `query` (object) - Query object (see [Search Queries](#search-queries))

**Returns:** Promise<object[]> - Array of `{ key, value }` objects

### `registry.clear()`

Clear all data (use with caution!).

```koi
await registry.clear()
```

**Returns:** Promise<void>

### `registry.stats()`

Get registry statistics.

```koi
const stats = await registry.stats()
// Returns: { backend: "local", count: 42, file: "/path/to/data.json", size: 1024 }
```

**Returns:** Promise<object> - Stats object

## Search Queries

The Registry supports MongoDB-style query operators:

### Exact Match

```koi
// Simple equality
const results = await registry.search({
  name: "Alice"
})

// Explicit equality
const results = await registry.search({
  name: { $eq: "Alice" }
})
```

### Comparison Operators

```koi
// Greater than
const results = await registry.search({
  age: { $gt: 25 }
})

// Greater than or equal
const results = await registry.search({
  age: { $gte: 18 }
})

// Less than
const results = await registry.search({
  age: { $lt: 65 }
})

// Less than or equal
const results = await registry.search({
  age: { $lte: 30 }
})

// Not equal
const results = await registry.search({
  status: { $ne: "inactive" }
})
```

### Array Operators

```koi
// Value in array
const results = await registry.search({
  role: { $in: ["admin", "moderator"] }
})
```

### String Operators

```koi
// Regex match
const results = await registry.search({
  email: { $regex: "@gmail\\.com$" }
})
```

### Nested Fields

```koi
// Dot notation
const results = await registry.search({
  "address.city": "New York"
})
```

### Multiple Conditions

All conditions must match (AND logic):

```koi
const results = await registry.search({
  age: { $gte: 18 },
  country: "US",
  verified: true
})
```

## Backends

### Local Backend (Default)

Stores data in a JSON file with in-memory cache.

**Pros:**
- No dependencies
- Simple setup
- Perfect for development
- Good for single-machine deployments

**Cons:**
- Not suitable for distributed systems
- Limited search performance on large datasets

**Configuration:**
```json
{
  "registry": {
    "backend": "local",
    "options": {
      "path": ".koi-registry",
      "autoSaveInterval": 5000
    }
  }
}
```

### Creating Custom Backends

You can create custom backends for Redis, MongoDB, PostgreSQL, etc.

**Example: Redis Backend**

Create `src/runtime/registry-backends/redis.js`:

```javascript
import Redis from 'ioredis';

export default class RedisBackend {
  constructor(options = {}) {
    this.redis = new Redis(options);
  }

  async init() {
    // Connection setup
  }

  async get(key) {
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async set(key, value) {
    await this.redis.set(key, JSON.stringify(value));
  }

  async delete(key) {
    const result = await this.redis.del(key);
    return result > 0;
  }

  async has(key) {
    const result = await this.redis.exists(key);
    return result > 0;
  }

  async keys(prefix) {
    return await this.redis.keys(prefix + '*');
  }

  async search(query) {
    // Implement search logic using Redis features
  }

  async clear() {
    await this.redis.flushdb();
  }

  async stats() {
    const dbsize = await this.redis.dbsize();
    return {
      backend: 'redis',
      count: dbsize
    };
  }

  async close() {
    await this.redis.quit();
  }
}
```

**Configuration:**
```json
{
  "registry": {
    "backend": "redis",
    "options": {
      "host": "localhost",
      "port": 6379
    }
  }
}
```

## Best Practices

### 1. Use Namespaced Keys

```koi
// ✅ Good: Organized with prefixes
await registry.set("user:123", userData)
await registry.set("session:abc", sessionData)
await registry.set("config:app", configData)

// ❌ Bad: Flat namespace
await registry.set("123", userData)
await registry.set("abc", sessionData)
```

### 2. Store Structured Data

```koi
// ✅ Good: Rich objects
await registry.set("user:123", {
  name: "Alice",
  age: 30,
  email: "alice@example.com",
  createdAt: Date.now(),
  metadata: { verified: true }
})

// ❌ Bad: Primitive values (use for simple flags only)
await registry.set("user:123:name", "Alice")
await registry.set("user:123:age", 30)
```

### 3. Clean Up Old Data

```koi
Agent Cleaner : Worker {
  on cleanupOldSessions(args: Json) {
    const sessionKeys = await registry.keys("session:")

    let deleted = 0
    for (const key of sessionKeys) {
      const session = await registry.get(key)

      if (session.expiresAt < Date.now()) {
        await registry.delete(key)
        deleted = deleted + 1
      }
    }

    console.log("Cleaned up", deleted, "expired sessions")
    return { deleted: deleted }
  }
}
```

### 4. Use Search for Complex Queries

```koi
// ✅ Good: Use search for filtering
const activeAdmins = await registry.search({
  role: "admin",
  status: "active",
  lastLogin: { $gte: Date.now() - 86400000 } // Last 24h
})

// ❌ Bad: Manual filtering
const allUsers = await registry.keys("user:")
const activeAdmins = []
for (const key of allUsers) {
  const user = await registry.get(key)
  if (user.role === "admin" && user.status === "active") {
    activeAdmins.push(user)
  }
}
```

### 5. Error Handling

```koi
Agent SafeWriter : Worker {
  on save(args: Json) {
    try {
      await registry.set("user:" + args.id, args.data)
      return { success: true }
    } catch (error) {
      console.error("Registry error:", error.message)
      return { success: false, error: error.message }
    }
  }
}
```

## How Natural Language Works

When you write playbooks with registry instructions, the LLM generates specific action types:

### Generated Action Types

**Save to registry:**
```
"Save user data to registry"
→ { "type": "registry_set", "key": "user:123", "value": {...} }
```

**Load from registry:**
```
"Load user from registry"
→ { "type": "registry_get", "key": "user:123" }
```

**Search registry:**
```
"Find all adults in registry"
→ { "type": "registry_search", "query": { "age": { "$gte": 18 } } }
```

**List keys:**
```
"List all user keys"
→ { "type": "registry_keys", "prefix": "user:" }
```

**Delete from registry:**
```
"Delete user from registry"
→ { "type": "registry_delete", "key": "user:123" }
```

These actions are executed automatically by the agent runtime.

## Examples

See:
- [`examples/registry-demo.koi`](../examples/registry-demo.koi) - Direct API usage
- [`examples/registry-playbook-demo.koi`](../examples/registry-playbook-demo.koi) - Natural language playbooks (recommended)

## Next Steps

- **[MCP Integration](10-mcp-integration.md)** - Remote agent communication
- **[Advanced Topics](15-advanced.md)** - Performance and production tips

---

**Related**: [Skills](05-skills.md) | [Teams](04-roles-and-teams.md)
