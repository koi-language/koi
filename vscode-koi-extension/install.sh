#!/bin/bash

# Koi Language Extension Installer
# Installs the extension for VS Code and/or Cursor

echo "🌊 Koi Language Extension Installer"
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Detect which editors are installed
VSCODE_INSTALLED=false
CURSOR_INSTALLED=false

if [ -d "$HOME/.vscode/extensions" ] || command -v code &> /dev/null; then
    VSCODE_INSTALLED=true
fi

if [ -d "$HOME/.cursor/extensions" ] || [ -d "/Applications/Cursor.app" ]; then
    CURSOR_INSTALLED=true
fi

echo "Detected editors:"
if [ "$VSCODE_INSTALLED" = true ]; then
    echo -e "  ${GREEN}✓${NC} VS Code"
fi
if [ "$CURSOR_INSTALLED" = true ]; then
    echo -e "  ${GREEN}✓${NC} Cursor"
fi

if [ "$VSCODE_INSTALLED" = false ] && [ "$CURSOR_INSTALLED" = false ]; then
    echo -e "  ${YELLOW}⚠${NC}  No VS Code or Cursor installation detected"
    echo ""
    echo "Please install VS Code or Cursor first:"
    echo "  - VS Code: https://code.visualstudio.com/"
    echo "  - Cursor: https://cursor.sh/"
    exit 1
fi

echo ""
echo "Choose installation method:"
echo "  1) Symlink (recommended for development)"
echo "  2) Copy files (stable)"
echo "  3) Cancel"
echo ""
read -p "Enter choice [1-3]: " choice

case $choice in
    1)
        METHOD="symlink"
        echo -e "${BLUE}Using symlink method...${NC}"
        ;;
    2)
        METHOD="copy"
        echo -e "${BLUE}Using copy method...${NC}"
        ;;
    3)
        echo "Installation cancelled."
        exit 0
        ;;
    *)
        echo "Invalid choice. Installation cancelled."
        exit 1
        ;;
esac

echo ""

# Install for VS Code
if [ "$VSCODE_INSTALLED" = true ]; then
    VSCODE_EXT_DIR="$HOME/.vscode/extensions/koi-lang"

    # Remove existing installation
    if [ -L "$VSCODE_EXT_DIR" ] || [ -d "$VSCODE_EXT_DIR" ]; then
        echo "Removing existing VS Code installation..."
        rm -rf "$VSCODE_EXT_DIR"
    fi

    # Install
    if [ "$METHOD" = "symlink" ]; then
        ln -s "$(pwd)" "$VSCODE_EXT_DIR"
        echo -e "${GREEN}✓${NC} Symlinked to VS Code extensions"
    else
        mkdir -p "$HOME/.vscode/extensions"
        cp -r "$(pwd)" "$VSCODE_EXT_DIR"
        echo -e "${GREEN}✓${NC} Copied to VS Code extensions"
    fi
fi

# Install for Cursor
if [ "$CURSOR_INSTALLED" = true ]; then
    CURSOR_EXT_DIR="$HOME/.cursor/extensions/koi-lang"

    # Remove existing installation
    if [ -L "$CURSOR_EXT_DIR" ] || [ -d "$CURSOR_EXT_DIR" ]; then
        echo "Removing existing Cursor installation..."
        rm -rf "$CURSOR_EXT_DIR"
    fi

    # Install
    if [ "$METHOD" = "symlink" ]; then
        ln -s "$(pwd)" "$CURSOR_EXT_DIR"
        echo -e "${GREEN}✓${NC} Symlinked to Cursor extensions"
    else
        mkdir -p "$HOME/.cursor/extensions"
        cp -r "$(pwd)" "$CURSOR_EXT_DIR"
        echo -e "${GREEN}✓${NC} Copied to Cursor extensions"
    fi
fi

echo ""
echo -e "${GREEN}✅ Installation complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Restart VS Code / Cursor"
echo "  2. Open any .koi file"
echo "  3. (Optional) Enable 'Koi Dark' theme:"
echo "     ${BLUE}Cmd+K Cmd+T${NC} → Select 'Koi Dark'"
echo ""
echo "Test with:"
echo "  code ../examples/hello-world.koi"
echo ""
