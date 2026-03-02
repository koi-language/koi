# Quick Install Guide

## 🚀 Fastest Installation (1 command)

### macOS/Linux

**For VS Code:**
```bash
ln -s "$(pwd)" ~/.vscode/extensions/koi-lang && echo "✓ Installed! Restart VS Code"
```

**For Cursor:**
```bash
ln -s "$(pwd)" ~/.cursor/extensions/koi-lang && echo "✓ Installed! Restart Cursor"
```

### Windows (PowerShell as Administrator)

**For VS Code:**
```powershell
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.vscode\extensions\koi-lang" -Target (Get-Location)
```

**For Cursor:**
```powershell
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.cursor\extensions\koi-lang" -Target (Get-Location)
```

---

## 📋 Step-by-Step

1. **Navigate to extension directory:**
   ```bash
   cd vscode-koi-extension
   ```

2. **Run installer:**

   **macOS/Linux:**
   ```bash
   ./install.sh
   ```

   **Windows:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```

3. **Restart your editor**

4. **Test it:**
   - Open any `.koi` file
   - Syntax highlighting should work automatically

---

## ✅ Verify Installation

```bash
# Check VS Code
ls -la ~/.vscode/extensions/ | grep koi

# Check Cursor
ls -la ~/.cursor/extensions/ | grep koi
```

You should see `koi-lang` listed.

---

## 🎨 Enable Koi Dark Theme (Optional)

1. Press `Cmd+K Cmd+T` (Mac) or `Ctrl+K Ctrl+T` (Windows/Linux)
2. Select "Koi Dark" from the theme list

---

## 🆘 Troubleshooting

**Extension not appearing:**
- Make sure you restarted VS Code/Cursor completely
- Run: `code --list-extensions | grep koi`

**Syntax not highlighting:**
- Check file has `.koi` extension
- Click language indicator (bottom right) → Select "Koi"

**Permission denied on Windows:**
- Run PowerShell as Administrator
- Or use the copy method in `install.ps1`

---

## 🗑️ Uninstall

```bash
# Remove from VS Code
rm -rf ~/.vscode/extensions/koi-lang

# Remove from Cursor
rm -rf ~/.cursor/extensions/koi-lang
```

Then restart your editor.
