# KOI Installation Guide

## Quick Install (Recommended)

Install KOI with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/koi-language/Koi/main/install.sh | bash
```

### What it does:

1. ✅ Detects your OS (macOS or Linux)
2. ✅ Checks for Node.js >= 18.0.0 and npm
3. ✅ Clones KOI repository to `~/.koi`
4. ✅ Installs all dependencies
5. ✅ Builds the PEG.js grammar
6. ✅ Creates symlink in `~/.local/bin/koi`
7. ✅ Adds `~/.local/bin` to your PATH (if needed)
8. ✅ Verifies installation

### After Installation

Restart your shell or run:

```bash
source ~/.bashrc  # or ~/.zshrc, ~/.bash_profile, etc.
```

Verify the installation:

```bash
koi --version
```

Set up your LLM API keys:

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
```

Try the examples:

```bash
cd ~/.koi/examples
koi run hello.koi
```

## Requirements

- **Node.js**: >= 18.0.0
- **npm**: Comes with Node.js
- **git**: For cloning the repository
- **OS**: macOS or Linux

### Installing Requirements

#### macOS

```bash
# Install Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js
brew install node

# Install git (usually pre-installed)
brew install git
```

#### Linux (Ubuntu/Debian)

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install git
sudo apt-get install -y git
```

#### Linux (Fedora/RHEL)

```bash
# Install Node.js 18+
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Install git
sudo yum install -y git
```

## Manual Installation

If you prefer to install manually:

```bash
# Clone repository
git clone https://github.com/koi-language/Koi.git ~/.koi
cd ~/.koi

# Install dependencies
npm install --production

# Build grammar
npm run build:grammar

# Create symlink
mkdir -p ~/.local/bin
ln -sf ~/.koi/src/cli/koi.js ~/.local/bin/koi
chmod +x ~/.koi/src/cli/koi.js

# Add to PATH (add to your ~/.bashrc or ~/.zshrc)
export PATH="$PATH:$HOME/.local/bin"
```

## Testing the Installer (for Contributors)

If you're contributing to the installer, test it locally:

```bash
# Test the script without actually installing
bash install.sh

# Or test specific functions
bash -c "source install.sh && check_dependencies"
```

### Local Testing with Different URLs

To test from a local clone or fork:

```bash
# Edit the REPO_URL in install.sh
REPO_URL="https://github.com/YOUR_USERNAME/koi.git"

# Or use local path
REPO_URL="file:///path/to/your/local/koi"

# Then run the installer
bash install.sh
```

## Uninstall

Remove KOI completely:

```bash
# Remove installation directory
rm -rf ~/.koi

# Remove symlink
rm -f ~/.local/bin/koi

# Remove PATH entry (edit your ~/.bashrc, ~/.zshrc, etc.)
# Remove these lines:
# # KOI Language
# export PATH="$PATH:$HOME/.local/bin"
```

## Updating KOI

To update to the latest version:

```bash
cd ~/.koi
git pull origin main
npm install --production
npm run build:grammar
```

Or simply run the installer again (it will remove the old installation):

```bash
curl -fsSL https://raw.githubusercontent.com/koi-language/Koi/main/install.sh | bash
```

## Troubleshooting

### Command not found: koi

If you get "command not found" after installation:

1. Verify the symlink exists:
   ```bash
   ls -la ~/.local/bin/koi
   ```

2. Check if `~/.local/bin` is in your PATH:
   ```bash
   echo $PATH | grep ".local/bin"
   ```

3. If not in PATH, restart your shell or run:
   ```bash
   source ~/.bashrc  # or ~/.zshrc
   ```

4. If still not working, add manually to your shell config:
   ```bash
   echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.bashrc
   source ~/.bashrc
   ```

### Node.js version too old

If you get an error about Node.js version:

```bash
# Check current version
node --version

# Update Node.js (macOS)
brew upgrade node

# Update Node.js (Linux with nvm)
nvm install 18
nvm use 18
```

### Permission denied errors

If you get permission errors during installation:

1. Don't use `sudo` with the installer
2. Make sure you own the installation directories:
   ```bash
   mkdir -p ~/.koi ~/.local/bin
   ```

### Installation fails on npm install

If npm install fails:

1. Clear npm cache:
   ```bash
   npm cache clean --force
   ```

2. Try manual installation instead (see above)

3. Check your internet connection

### Behind a proxy

If you're behind a corporate proxy:

```bash
# Set proxy for npm
npm config set proxy http://proxy.company.com:8080
npm config set https-proxy http://proxy.company.com:8080

# Set proxy for git
git config --global http.proxy http://proxy.company.com:8080

# Then run installer
curl -fsSL https://raw.githubusercontent.com/koi-language/Koi/main/install.sh | bash
```

## Support

- **Issues**: [github.com/koi-language/Koi/issues](https://github.com/koi-language/Koi/issues)
- **Discussions**: [github.com/koi-language/Koi/discussions](https://github.com/koi-language/Koi/discussions)

## Alternative Installation Methods

### Using npm (when published)

Once KOI is published to npm:

```bash
npm install -g koi-lang
```

### Using Homebrew (future)

Future support for Homebrew:

```bash
brew install koi-lang
```

### Using Docker (future)

Future support for Docker:

```bash
docker pull koilang/koi
docker run -it koilang/koi
```

---

**Quick Links:**
- [Quick Start Guide](QUICKSTART.md)
- [Documentation](doc/)
- [Examples](examples/)
- [README](README.md)
