# Troubleshooting Koi Extension

## Extension Not Loading

### 1. Verify Installation

```bash
ls -la ~/.cursor/extensions/koi-lang
```

Should show files like:
- `package.json`
- `src/extension.js`
- `syntaxes/koi.tmLanguage.json`

### 2. Check Extension Status

In Cursor:
1. Press `Cmd+Shift+P`
2. Type "Developer: Show Running Extensions"
3. Look for "koi-lang" in the list

**If NOT in the list:**
- Extension is not loading
- Check for errors in next step

### 3. Check for Errors

In Cursor:
1. Press `Cmd+Shift+P`
2. Type "Developer: Toggle Developer Tools"
3. Go to "Console" tab
4. Look for errors mentioning "koi" or "extension"

Common errors:
- `Cannot find module` → Missing dependencies or wrong path
- `SyntaxError` → Error in extension.js or definitionProvider.js
- `Failed to activate` → Check package.json configuration

### 4. Verify Language Recognition

Open any `.koi` file:
- Check bottom-right corner
- Should show "Koi" as the language
- If shows "Plain Text", click it and select "Koi"

### 5. Force Complete Reload

```bash
cd vscode-koi-extension
./reload-cursor.sh
```

Then open Cursor and check again.

## Go to Definition Not Working

### 1. Verify Extension is Active

Follow steps above to ensure extension is running.

### 2. Test with Simple Example

Create a test file:

```koi
// test.koi
role Worker { can work }

Skill TestSkill {
  affordance """Test"""
}

Agent TestAgent : Worker {
  uses Skill TestSkill  // Cmd+Click on "TestSkill" should jump to line 4
}
```

Try Cmd+Click on:
- "TestSkill" (line 9) → Should jump to line 4
- "Worker" (line 9) → Should jump to line 2

### 3. Check File Extension

Ensure file ends with `.koi` (not `.koi.txt` or similar)

### 4. Check Syntax

Ensure your code is syntactically correct:
- `uses Skill <Name>` ✓
- `uses <Name>` ✗ (missing "Skill")

## Syntax Highlighting Not Working

### 1. Verify Grammar File

```bash
cat ~/.cursor/extensions/koi-lang/syntaxes/koi.tmLanguage.json | grep "scopeName"
```

Should output: `"scopeName": "source.koi"`

### 2. Manually Set Language

In Cursor:
1. Click language indicator (bottom-right)
2. Type "Koi"
3. Select "Koi" from dropdown

### 3. Check File Associations

In Cursor settings (`Cmd+,`):

```json
{
  "files.associations": {
    "*.koi": "koi"
  }
}
```

## Import Syntax Not Highlighting

The import keyword should be orange/pink:

```koi
import "./skills/math.koi"  // "import" should be colored
```

If not colored:
1. Reload window: `Cmd+Shift+P` → "Reload Window"
2. Check that `koi.tmLanguage.json` includes `import-declaration`

## Advanced Debugging

### Enable Extension Development Mode

1. Open `~/.cursor/extensions/koi-lang` in Cursor
2. Press `F5` to launch Extension Development Host
3. This opens a new window with the extension loaded in debug mode
4. You can set breakpoints in `src/extension.js`

### Check Extension Logs

```bash
# View Cursor logs
tail -f ~/Library/Application\ Support/Cursor/logs/main.log
```

### Reinstall from Scratch

```bash
# Remove existing installation
rm -rf ~/.cursor/extensions/koi-lang

# Reinstall
cd /path/to/vscode-koi-extension
ln -s "$(pwd)" ~/.cursor/extensions/koi-lang

# Force reload
./reload-cursor.sh
```

## Still Not Working?

1. Check Node.js version:
   ```bash
   node --version  # Should be v18+
   ```

2. Try VS Code instead:
   ```bash
   ln -s "$(pwd)" ~/.vscode/extensions/koi-lang
   ```
   If it works in VS Code but not Cursor, might be Cursor-specific issue.

3. Create an issue with:
   - OS version
   - Cursor version
   - Output of: `ls -la ~/.cursor/extensions/koi-lang`
   - Console errors from Developer Tools
   - Example `.koi` file that doesn't work
