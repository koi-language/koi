# Advanced Topics

Advanced features for production use, debugging, and optimization.

## Source Maps

Koi generates source maps automatically. Runtime errors point to original `.koi` files, not generated `.js`.

**Example error**:
```
Error in hello.koi:8:10

  6 │ Agent Greeter : Worker {
  7 │   on greet(args: Json) {
> 8 │     const x = undefinedVariable
    │               ^^^^^^^^^^^^^^^^^
  9 │     return { x }
```

## Debugging

### View Generated JavaScript

```bash
koi compile examples/hello.koi
cat examples/hello.js
```

### Enable Debug Mode

```bash
DEBUG=llm,router koi run examples/hello.koi
```

### Node Inspector

```bash
node --inspect $(which koi) run examples/hello.koi
```

Open `chrome://inspect` in Chrome.

## Performance Optimization

### 1. Use Code for Deterministic Tasks

```koi
// ✅ Fast: Pure code
on add(args: Json) {
  return { result: args.a + args.b }
}

// ❌ Slow: Unnecessary LLM call
on add(args: Json) {
  playbook """Calculate {{args.a}} + {{args.b}}"""
}
```

### 2. Cache LLM Responses

See [Caching Guide](13-caching.md).

### 3. Use Faster Models

- `gpt-4o-mini` instead of `gpt-4o`
- `claude-3-5-haiku` instead of `claude-3-5-sonnet`

### 4. Reduce max_tokens

```koi
llm { max_tokens: 200 }  // Instead of default 1000+
```

## Hot Reload

Not yet implemented (roadmap feature).

Workaround: Use `nodemon`:

```bash
npm install -g nodemon
nodemon --exec "koi run examples/hello.koi" --watch examples --ext koi
```

## Editor Integration

### VS Code Extension

Syntax highlighting for `.koi` files:

```bash
cd vscode-koi-extension
ln -s "$(pwd)" ~/.vscode/extensions/koi-lang
```

Restart VS Code.

## Building for Production

### 1. Compile All Files

```bash
koi compile src/**/*.koi
```

### 2. Bundle with esbuild (optional)

```bash
npm install -g esbuild
esbuild src/.build/main.js --bundle --platform=node --outfile=dist/app.js
```

### 3. Set Production Environment

```bash
export NODE_ENV=production
export OPENAI_API_KEY=sk-...
node dist/app.js
```

## Environment Variables Reference

```bash
# LLM Configuration
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Caching
KOI_CACHE_ENABLED=true
KOI_CACHE_DIR=.koi-cache
KOI_CACHE_SIMILARITY_THRESHOLD=0.95

# MCP
MCP_AUTH_<SERVER>=token
KOI_MCP_REGISTRY=https://registry.example.com
KOI_MCP_TIMEOUT=30000

# Debugging
DEBUG=llm,router,agent
KOI_MCP_DEBUG=true
```

## Troubleshooting

### High Memory Usage

**Cause**: Large LLM response cache
**Solution**: Clear cache or reduce threshold

```bash
rm -rf .koi-cache
export KOI_CACHE_SIMILARITY_THRESHOLD=0.98
```

### Slow Startup

**Cause**: TypeScript transpilation on first run
**Solution**: Pre-compile TypeScript files

```bash
npx tsc utils/**/*.ts
```

### Module Resolution Errors

**Cause**: Incorrect import paths
**Solution**: Use correct relative paths

```koi
// ✅ Correct
import "./utils/math.ts"

// ❌ Wrong
import "utils/math.ts"
```

## Roadmap

- [ ] Hot reload in development
- [ ] Visual debugging tools
- [ ] Performance profiling
- [ ] Distributed tracing
- [ ] Metrics collection

---

**Back to**: [Documentation Index](README.md)
