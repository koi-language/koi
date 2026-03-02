# Editor Setup for KOI

Get syntax highlighting and language support for `.koi` files in VS Code and Cursor.

## VS Code

### Method 1: Symlink (Recommended for Development)

```bash
# From the Koi repository root
ln -s "$(pwd)/vscode-koi-extension" ~/.vscode/extensions/koi-lang

# Restart VS Code
```

### Method 2: Copy Extension

```bash
# macOS/Linux
cp -r vscode-koi-extension ~/.vscode/extensions/koi-lang

# Windows (PowerShell)
xcopy vscode-koi-extension $env:USERPROFILE\.vscode\extensions\koi-lang /E /I
```

Then restart VS Code.

### Method 3: Install from VSIX

1. Package the extension:
   ```bash
   cd vscode-koi-extension
   npm install -g @vscode/vsce
   vsce package
   ```

2. Install in VS Code:
   - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
   - Type "Install from VSIX"
   - Select the generated `koi-lang-1.0.0.vsix` file

---

## Cursor

### Method 1: Symlink (Recommended)

```bash
# From the Koi repository root
ln -s "$(pwd)/vscode-koi-extension" ~/.cursor/extensions/koi-lang

# Restart Cursor
```

### Method 2: Copy Extension

```bash
# macOS/Linux
cp -r vscode-koi-extension ~/.cursor/extensions/koi-lang

# Windows (PowerShell)
xcopy vscode-koi-extension $env:USERPROFILE\.cursor\extensions\koi-lang /E /I
```

Then restart Cursor.

### Method 3: Install from VSIX

1. Package the extension (if not already done):
   ```bash
   cd vscode-koi-extension
   npm install -g @vscode/vsce
   vsce package
   ```

2. Install in Cursor:
   - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
   - Type "Install from VSIX"
   - Select the generated `koi-lang-1.0.0.vsix` file

---

## Features

Once installed, you get:

- **Syntax Highlighting** - Full highlighting for `.koi` files
- **Go to Definition** - `Cmd+Click` (Mac) or `Ctrl+Click` (Windows/Linux) to jump to:
  - Skill definitions
  - Agent definitions
  - Role definitions
  - Team definitions
  - Works across imported files
- **Custom Themes** - Three Koi-specific themes:
  - **Koi Dark** - Original Koi theme
  - **Koi Dark+** - Based on VS Code's Dark+
  - **Koi Dark Modern** - Based on VS Code's Dark Modern
- **Language Configuration** - Auto-closing brackets, comment toggling, indentation
- **Playbook Support** - Bright yellow highlighting for LLM playbooks

---

## Enabling the Koi Theme (Optional)

To use the Koi Dark theme:

1. Press `Cmd+K Cmd+T` (Mac) or `Ctrl+K Ctrl+T` (Windows/Linux)
2. Select "Koi Dark", "Koi Dark+", or "Koi Dark Modern"

---

## Color Scheme

| Element | Color | Example |
|---------|-------|---------|
| Agents/Teams/Skills | Yellow | `Agent Greeter` |
| Roles | Purple | `role Worker` |
| Events/Playbooks Keywords | Orange | `on greet`, `playbook` |
| Playbook Content | Bright Yellow | `"""text"""` |
| LLM/Run | Green | `llm default`, `run` |
| Functions | Cyan | `greet()`, `send()` |
| Strings | Light Green | `"hello"` |
| Types | Blue | `Json`, `Int` |
| Keywords | Pink | `if`, `return` |

---

## Verify Installation

1. Check the extension is installed:
   ```bash
   # VS Code
   ls -la ~/.vscode/extensions/ | grep koi

   # Cursor
   ls -la ~/.cursor/extensions/ | grep koi
   ```

2. Open any `.koi` file - syntax highlighting should activate automatically

3. If not working, manually set the language:
   - Click the language indicator (bottom right of editor)
   - Type "Koi" and select it

---

## Troubleshooting

### Extension Not Working

1. Restart your editor completely (`Cmd+Q` on Mac)
2. Check VS Code/Cursor output:
   - `Cmd+Shift+U` → Select "Extensions" from dropdown
   - Look for errors related to "koi-lang"

### Syntax Not Highlighting

1. Verify file extension is `.koi`
2. Manually set language mode (click bottom-right language indicator)

### Theme Not Available

1. Reload window: `Cmd+Shift+P` → "Reload Window"
2. Reinstall the extension

---

## More Information

- [Extension README](../vscode-koi-extension/README.md) - Full extension documentation
- [Troubleshooting Guide](../vscode-koi-extension/TROUBLESHOOTING.md) - Detailed troubleshooting
- [Custom Theme Settings](../vscode-koi-extension/CUSTOM_THEME_SETTINGS.md) - Theme customization
