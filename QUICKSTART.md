# Koi Quick Start

**Koi** - Agent-first language. Calm orchestration. 🌊

## Install

```bash
# Clone the repository
git clone <repo-url>
cd koi

# Install dependencies and build
npm install
npm run build:grammar

# Install globally (makes 'koi' command available everywhere)
npm install -g .
```

## Verify Installation

```bash
koi version
```

You should see:
```
🌊 Koi
   Agent-first language. Calm orchestration.

Version: 1.0.0
Node: vX.X.X
Platform: ...
```

## Run Your First Example

```bash
# Run a simple example
koi run examples/simple.koi
```

## Set Up LLM (Optional)

For real LLM execution:

```bash
# Create .env file with your API key
echo "OPENAI_API_KEY=your-key-here" > .env

# Run with real LLM
koi run examples/hello-world.koi
```

Get API keys:
- OpenAI: https://platform.openai.com/api-keys
- Anthropic: https://console.anthropic.com/

## Commands

```bash
koi run <file>              # Compile and run
koi compile <file>          # Just compile
koi init <project>          # Create new project
koi help                    # Show help
koi version                 # Show version
```

## Examples

```bash
koi run examples/simple.koi              # Basic agent communication
koi run examples/calculator.koi          # Procedural code
koi run examples/sentiment.koi               # LLM skill
koi run examples/pipeline.koi                # Multi-stage workflow
```

## Next Steps

1. Read the full [README.md](README.md)
2. **Explore the [Complete Documentation](doc/)** - Comprehensive guides on all features
3. Check [LLM Integration Guide](doc/06-llm-integration.md) for LLM configuration
4. Explore the [examples/](examples/) directory
5. See [Complete Examples](doc/14-examples.md) for working code samples
6. Create your first agent with `koi init my-project`

---

**Koi**: Agent-first language. Calm orchestration. 🌊
