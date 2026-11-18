# Contributing to Koi

Thank you for your interest in contributing to Koi!

## Development Setup

```bash
git clone https://github.com/koi-language/koi.git
cd koi
npm install
npm link            # the `koi` command now runs this clone
```

Put a model key in `.env` (see `.env.example`): a provider's key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`) or `KOI_API_KEY` for the Koi API.

## Development Workflow

1. Change the compiler or the runtime. `koi` runs your clone, so changes are live: nothing to reinstall.
2. If you changed the grammar (`src/grammar/koi.pegjs`), regenerate the parser: `npm run build:grammar`.
3. Try it:

```bash
npm test                                   # the test suite
koi run examples/hello-world.koi           # an example
koi compile examples/hello-world.koi       # see the generated code in examples/.build/
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
