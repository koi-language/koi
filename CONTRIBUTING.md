# Contributing to Koi

Thank you for your interest in contributing to Koi!

## Development Setup

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/koi.git
cd koi
npm install
npm run build:grammar
```

### 2. Configure Development Environment

Copy the development environment template:

```bash
cp .env.development .env
```

Edit `.env` and update `KOI_RUNTIME_PATH` to your local Koi path:

```bash
# .env
KOI_RUNTIME_PATH=/absolute/path/to/koi/src/runtime
OPENAI_API_KEY=your-key-here
```

### 3. Test Your Changes

```bash
# Run examples with your local runtime
koi run examples/hello-world.koi

# Or test on external projects
cd /path/to/test-project
koi run src/main.koi
# Will use your local runtime from KOI_RUNTIME_PATH
```

## How KOI_RUNTIME_PATH Works

When `KOI_RUNTIME_PATH` is set:
- The transpiler generates imports pointing to your local runtime
- Changes to runtime code are immediately reflected without reinstalling
- Perfect for iterating on runtime/compiler changes

When `KOI_RUNTIME_PATH` is NOT set:
- The transpiler uses package imports (`koi-lang`)
- Production behavior - uses installed npm package

## Development Workflow

1. Make changes to compiler/runtime
2. Run `npm run build:grammar` if you modified the grammar
3. Test with `koi run examples/...`
4. Changes are live - no reinstall needed!

## Testing

```bash
# Run test suite
npm test

# Run specific example
koi run examples/calculator.koi

# Compile and inspect output
koi compile examples/simple.koi
cat examples/.build/simple.js
```

## Releasing to npm

One command publishes `@koi-language/koi`, from a clean working tree (commit your changes first):

```bash
npm run release          # 1.2.0 → 1.2.1   fixes
npm run release:minor    # 1.2.0 → 1.3.0   new features
npm run release:major    # 1.2.0 → 2.0.0   breaking changes
```

Each one bumps the version from the one in `package.json`, commits it as `Release <version>` with the tag
`v<version>`, runs the tests (`prepublishOnly`; a failure stops the release), publishes (npm asks for your
two-factor confirmation in the browser) and pushes the commit and the tag to GitHub. If the npm account has
staged publishing on, approve the version under **Staged Packages** on npmjs.com afterwards.

## Pull Request Guidelines

1. Test your changes with multiple examples
2. Update documentation if adding features
3. Follow existing code style
4. Add tests for new functionality
5. Keep PRs focused on a single feature/fix

## Questions?

Open an issue or start a discussion on GitHub!
