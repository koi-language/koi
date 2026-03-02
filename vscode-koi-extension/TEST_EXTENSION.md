# Testing the Koi Extension

Quick guide to verify the extension is working correctly.

## ✅ Installation Check

1. **Verify extension is installed:**
   ```bash
   ls -la ~/.vscode/extensions/ | grep koi
   # Should show: koi-lang -> /path/to/vscode-koi-extension
   ```

2. **Restart VS Code/Cursor completely:**
   - Close all windows
   - Reopen the editor

## 🧪 Test Syntax Highlighting

1. **Open a test file:**
   ```bash
   code ../examples/hello-world.koi
   # or
   cursor ../examples/hello-world.koi
   ```

2. **Check syntax highlighting:**
   - `Agent` keyword should be purple/bold
   - Agent name (`Greeter`) should be yellow/bold
   - `on greet` should be orange/bold
   - `playbook """..."""` should be yellow/italic
   - Comments `//` should be gray/italic

3. **Verify file icon:**
   - In the file explorer, `.koi` files should show a custom icon
   - Icon has wave symbol 🌊

## 🎨 Test Theme (Optional)

1. **Open Command Palette:**
   - Mac: `Cmd+K Cmd+T`
   - Windows/Linux: `Ctrl+K Ctrl+T`

2. **Select "Koi Dark"**

3. **Verify colors:**
   - Background should be dark blue (`#1a1e2e`)
   - Keywords have distinct colors
   - Playbooks stand out in italic yellow

## 🔤 Test Auto-Features

### Auto-Closing Pairs
1. Open any `.koi` file
2. Type `{` → should auto-add `}`
3. Type `"""` → should auto-add closing `"""`
4. Type `(` → should auto-add `)`

### Comment Toggle
1. Select a line of code
2. Press `Cmd+/` (Mac) or `Ctrl+/` (Windows/Linux)
3. Line should toggle between commented and uncommented

### Bracket Matching
1. Click on any opening `{`
2. Matching closing `}` should highlight

## 🐛 Troubleshooting

### Extension Not Loading

**Check VS Code output:**
1. `Cmd+Shift+U` (Mac) or `Ctrl+Shift+U` (Windows/Linux)
2. Select "Extensions" from dropdown
3. Look for errors mentioning "koi-lang"

**Verify package.json:**
```bash
cat package.json | jq '.contributes.languages[0]'
# Should show language configuration
```

### Syntax Not Highlighting

**Manually set language:**
1. Click language indicator (bottom right of editor)
2. Type "Koi"
3. Select "Koi" from list

**Check file extension:**
- File must end with `.koi`
- If using different extension, add to VS Code settings:
  ```json
  {
    "files.associations": {
      "*.koi": "koi"
    }
  }
  ```

### Colors Not Showing

**Try different theme:**
1. The extension works with any VS Code theme
2. For best results, use "Koi Dark" theme
3. Or choose a dark theme with good contrast

**Check TextMate scopes:**
1. Press `Cmd+Shift+P` → "Developer: Inspect Editor Tokens and Scopes"
2. Click on any Koi keyword
3. Should show scopes like `keyword.control.agent.koi`

## 📊 Expected Results

### Before Extension
```koi
// All text is same color
Agent Greeter : Worker {
  on greet(args: Json) {
    playbook """
    Your playbook here
    """
  }
}
```

### After Extension
```koi
// Comments in gray italic
Agent Greeter : Worker {  // Agent=purple, Greeter=yellow, Worker=purple
  on greet(args: Json) {   // on greet=orange, args/Json=blue
    playbook """           // playbook=orange
    Your playbook here     // italic yellow
    """
  }
}
```

## 🎯 Quick Visual Test

Create a test file `test.koi`:

```koi
package "test"

role Worker { can execute }

Agent Test : Worker {
  llm default = { provider: "openai" }

  on process(args: Json) {
    playbook """
    Process the input and return results.
    """
    const x = 42
    return { result: x }
  }
}

run Test.process({})
```

**What you should see:**
- ✅ `package` in purple
- ✅ `role Worker` - purple keywords, purple role name
- ✅ `Agent Test` - purple + yellow
- ✅ `llm default` in green
- ✅ `on process` in orange
- ✅ Playbook in italic yellow
- ✅ `const` in purple/blue
- ✅ `42` in red/pink
- ✅ `run` in green

## ✨ Success Criteria

- [x] Extension appears in extensions list
- [x] `.koi` files show custom icon
- [x] Syntax highlighting is colorful
- [x] Playbooks are italic yellow
- [x] Auto-closing works for `{`, `(`, `"`
- [x] Comment toggle works (`Cmd+/`)
- [x] Bracket matching highlights pairs

If all checks pass: **Extension is working correctly!** 🎉

---

Need help? Check [README.md](README.md) or [QUICK_INSTALL.md](QUICK_INSTALL.md)
