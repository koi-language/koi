# Koi Language Extension - Visual Examples

## Syntax Highlighting

The Koi extension provides beautiful, semantic syntax highlighting:

### Agent Declaration
```koi
Agent Greeter : Worker {
  llm default = { provider: "openai", model: "gpt-4o-mini" }

  on greet(args: Json) {
    playbook """
    Generate a warm greeting for args.name.
    Return JSON: { "greeting": "...", "style": "..." }
    """
  }
}
```

**Colors Applied:**
- `Agent` - Purple (bold)
- `Greeter` - Yellow (bold, agent name)
- `Worker` - Purple (role name)
- `llm default` - Green (bold)
- `on greet` - Orange (bold)
- `playbook """..."""` - Italic yellow
- `args: Json` - Parameters and types

### Team & Role Definition
```koi
role Worker { can execute, can propose }
role Lead { can delegate, can decide }

Team Development {
  greeter = Greeter
  processor = Processor
}
```

**Colors Applied:**
- `role` - Purple (bold)
- Role names - Purple
- `Team` - Purple (bold)
- Team name - Yellow (bold)
- Properties - Light blue

### Complete Example

```koi
// Comments in gray italic
package "demo.koi.example"

role Worker { can execute }

Agent Calculator : Worker {
  on add(args: Json) {
    const a = args.a
    const b = args.b
    return { result: a + b }
  }
}

Team CalcTeam {
  calc = Calculator
}

Agent Orchestrator : Worker {
  uses Team CalcTeam

  on start(args: Json) {
    const sum = await send peers.event("add").role(Worker).any()({ a: 10, b: 5 })
    return sum
  }
}

run Orchestrator.start({})
```

## Theme Comparison

### With Koi Dark Theme
- Optimized color palette for Koi syntax
- Distinct colors for each construct
- Easy to distinguish agents, roles, events

### With Your Favorite Theme
- Extension works with any VS Code theme
- Uses semantic token scopes
- Colors adapt to your theme

## Color Reference

| Element | Koi Dark Color | Scope |
|---------|---------------|-------|
| `Agent`, `Team`, `Skill` | Purple (bold) | `keyword.control.*.koi` |
| Agent/Team names | Yellow (bold) | `entity.name.class.*.koi` |
| `on`, `playbook` | Orange (bold) | `keyword.control.on.koi` |
| Event names | Cyan | `entity.name.function.event.koi` |
| `llm`, `run` | Green (bold) | `keyword.control.llm.koi` |
| Playbooks `"""..."""` | Yellow (italic) | `string.quoted.triple.playbook.koi` |
| Role names | Purple | `entity.name.type.role.koi` |
| Types (`Json`, `Int`) | Blue | `entity.name.type.koi` |
| Strings | Light green | `string.quoted.*.koi` |
| Numbers | Red | `constant.numeric.*.koi` |
| Comments | Gray (italic) | `comment.*.koi` |

## File Icon

`.koi` files get a custom icon with wave symbol 🌊 in the file explorer.

## Features in Action

### Auto-Closing
- Type `{` → automatically adds `}`
- Type `"""` → automatically adds closing `"""`
- Works for brackets, quotes, comments

### Comment Toggle
- `Cmd+/` (Mac) or `Ctrl+/` (Windows/Linux)
- Toggles `//` line comments
- Supports block comments with `/* */`

### Smart Indentation
- Auto-indent after `{`
- Auto-dedent on `}`
- Preserves indentation in playbooks

### Bracket Matching
- Click on any bracket to highlight its pair
- Works for `{}`, `[]`, `()`

## Tips

1. **Use Koi Dark theme** for best experience
2. **Enable bracket pair colorization** in VS Code settings
3. **Use folding markers** for large files (comments with `region`/`endregion`)
4. **Minimap shows syntax** - easy navigation in large files

---

Enjoy coding in Koi! 🌊
