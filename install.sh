#!/usr/bin/env bash
#
# KOI Language Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/koi-language/Koi/main/install.sh | bash
#
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
REPO_URL="https://github.com/koi-language/Koi.git"
INSTALL_DIR="$HOME/.koi"
BIN_DIR="$HOME/.local/bin"
MIN_NODE_VERSION="18.0.0"

# Helper functions
print_banner() {
    echo -e "${CYAN}"
    cat << "EOF"
    ╔═══════════════════════════════════════╗
    ║                                       ║
    ║      KOI Language Installer           ║
    ║   Agent-first. Calm orchestration.    ║
    ║                                       ║
    ╚═══════════════════════════════════════╝
EOF
    echo -e "${NC}"
}

log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

version_compare() {
    # Compare two version numbers
    # Returns 0 if $1 >= $2, 1 otherwise
    printf '%s\n%s\n' "$2" "$1" | sort -V -C
}

check_os() {
    log_info "Detecting operating system..."

    case "$(uname -s)" in
        Darwin*)
            OS="macos"
            log_success "macOS detected"
            ;;
        Linux*)
            OS="linux"
            log_success "Linux detected"
            ;;
        *)
            log_error "Unsupported operating system: $(uname -s)"
            log_error "KOI supports macOS and Linux only"
            exit 1
            ;;
    esac
}

check_dependencies() {
    log_info "Checking dependencies..."

    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        echo ""
        echo "Please install Node.js >= ${MIN_NODE_VERSION}:"
        echo "  macOS: brew install node"
        echo "  Linux: https://nodejs.org/en/download/package-manager"
        exit 1
    fi

    NODE_VERSION=$(node --version | sed 's/v//')
    if ! version_compare "$NODE_VERSION" "$MIN_NODE_VERSION"; then
        log_error "Node.js version $NODE_VERSION is too old"
        log_error "KOI requires Node.js >= $MIN_NODE_VERSION"
        echo ""
        echo "Please upgrade Node.js:"
        echo "  macOS: brew upgrade node"
        echo "  Linux: https://nodejs.org/en/download/package-manager"
        exit 1
    fi

    log_success "Node.js $NODE_VERSION found"

    # Check npm
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed"
        exit 1
    fi

    log_success "npm $(npm --version) found"

    # Check git
    if ! command -v git &> /dev/null; then
        log_error "git is not installed"
        echo ""
        echo "Please install git:"
        echo "  macOS: brew install git"
        echo "  Linux: sudo apt-get install git (Debian/Ubuntu)"
        exit 1
    fi

    log_success "git $(git --version | awk '{print $3}') found"
}

install_koi() {
    log_info "Installing KOI..."

    # Remove old installation if exists
    if [ -d "$INSTALL_DIR" ]; then
        log_warning "Removing previous installation at $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
    fi

    # Clone repository
    log_info "Cloning KOI repository..."
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>&1 | sed 's/^/  /'

    log_success "Repository cloned to $INSTALL_DIR"

    # Install dependencies
    log_info "Installing dependencies (this may take a minute)..."
    cd "$INSTALL_DIR"
    npm install --production --silent 2>&1 | sed 's/^/  /' || {
        log_error "Failed to install dependencies"
        exit 1
    }

    log_success "Dependencies installed"

    # Build grammar
    log_info "Building KOI grammar..."
    npm run build:grammar --silent 2>&1 | sed 's/^/  /' || {
        log_error "Failed to build grammar"
        exit 1
    }

    log_success "Grammar built"
}

setup_bin() {
    log_info "Setting up koi command..."

    # Create bin directory if it doesn't exist
    mkdir -p "$BIN_DIR"

    # Create symlink
    ln -sf "$INSTALL_DIR/src/cli/koi.js" "$BIN_DIR/koi"
    chmod +x "$INSTALL_DIR/src/cli/koi.js"

    log_success "koi command linked to $BIN_DIR/koi"
}

setup_path() {
    # Check if BIN_DIR is in PATH
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        log_warning "$BIN_DIR is not in your PATH"

        # Detect shell
        SHELL_NAME=$(basename "$SHELL")
        case "$SHELL_NAME" in
            bash)
                SHELL_RC="$HOME/.bashrc"
                if [[ "$OS" == "macos" ]]; then
                    SHELL_RC="$HOME/.bash_profile"
                fi
                ;;
            zsh)
                SHELL_RC="$HOME/.zshrc"
                ;;
            fish)
                SHELL_RC="$HOME/.config/fish/config.fish"
                ;;
            *)
                SHELL_RC="$HOME/.profile"
                ;;
        esac

        log_info "Adding $BIN_DIR to PATH in $SHELL_RC"

        # Add to shell RC file
        if [[ "$SHELL_NAME" == "fish" ]]; then
            echo "" >> "$SHELL_RC"
            echo "# KOI Language" >> "$SHELL_RC"
            echo "set -gx PATH \$PATH $BIN_DIR" >> "$SHELL_RC"
        else
            echo "" >> "$SHELL_RC"
            echo "# KOI Language" >> "$SHELL_RC"
            echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$SHELL_RC"
        fi

        log_success "PATH updated in $SHELL_RC"
        log_warning "Please restart your shell or run: source $SHELL_RC"

        # Add to current session
        export PATH="$PATH:$BIN_DIR"
    else
        log_success "$BIN_DIR is already in your PATH"
    fi
}

verify_installation() {
    log_info "Verifying installation..."

    if command -v koi &> /dev/null; then
        KOI_VERSION=$(koi --version 2>/dev/null || echo "unknown")
        log_success "koi command is available"
        log_success "Installation complete!"
    else
        log_error "koi command not found in PATH"
        log_error "Please restart your shell and try again"
        exit 1
    fi
}

print_next_steps() {
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║           Installation Successful! 🎉                      ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${CYAN}Next steps:${NC}"
    echo ""
    echo "  1. Set up your LLM API keys:"
    echo -e "     ${YELLOW}export OPENAI_API_KEY=\"sk-...\"${NC}"
    echo -e "     ${YELLOW}export ANTHROPIC_API_KEY=\"sk-ant-...\"${NC}"
    echo ""
    echo "  2. Try the hello world example:"
    echo -e "     ${YELLOW}cd $INSTALL_DIR/examples${NC}"
    echo -e "     ${YELLOW}koi run hello.koi${NC}"
    echo ""
    echo "  3. Read the documentation:"
    echo -e "     ${YELLOW}cat $INSTALL_DIR/README.md${NC}"
    echo -e "     ${YELLOW}cat $INSTALL_DIR/QUICKSTART.md${NC}"
    echo ""
    echo -e "${CYAN}Useful commands:${NC}"
    echo "  koi run <file.koi>      Run a KOI program"
    echo "  koi compile <file.koi>  Compile to JavaScript"
    echo "  koi test                Run test suite"
    echo "  koi --help              Show help"
    echo ""
    echo -e "${CYAN}Resources:${NC}"
    echo "  Repository: https://github.com/koi-language/Koi"
    echo "  Issues:     https://github.com/koi-language/Koi/issues"
    echo ""
}

cleanup_on_error() {
    log_error "Installation failed"
    if [ -d "$INSTALL_DIR" ]; then
        log_info "Cleaning up..."
        rm -rf "$INSTALL_DIR"
    fi
    exit 1
}

# Main installation flow
main() {
    trap cleanup_on_error ERR

    print_banner
    check_os
    check_dependencies
    install_koi
    setup_bin
    setup_path
    verify_installation
    print_next_steps
}

main "$@"
