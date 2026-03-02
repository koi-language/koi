# Adding KOI to GitHub Linguist

This guide explains how to get GitHub to recognize and syntax highlight `.koi` files.

## Current Status

✅ **Local Support**: VSCode extension with full syntax highlighting
🔄 **GitHub Support**: Pending (using JavaScript highlighting temporarily)
📝 **Next Step**: Submit PR to github/linguist

## Temporary Solution

Currently, `.gitattributes` maps `.koi` files to JavaScript syntax highlighting:

```gitattributes
*.koi linguist-language=JavaScript
```

This provides basic highlighting while we wait for official support.

## Adding KOI to GitHub Linguist

To add full KOI support to GitHub, we need to contribute to the [github/linguist](https://github.com/github/linguist) repository.

### Files Needed

1. **Language Definition** (`lib/linguist/languages.yml`)
```yaml
KOI:
  type: programming
  color: "#6495ED"
  extensions:
  - ".koi"
  tm_scope: source.koi
  ace_mode: javascript
  language_id: 999999999
  aliases:
  - koi
```

2. **Grammar File** (`vendor/grammars/koi.tmLanguage.json`)
   - Already created in this repo: `vendor/grammars/koi.tmLanguage.json`
   - Based on our VSCode extension grammar

3. **Samples** (`samples/KOI/`)
   - Example `.koi` files for testing
   - We can use files from `examples/` directory

### Steps to Contribute

1. **Fork github/linguist**
   ```bash
   git clone https://github.com/github/linguist.git
   cd linguist
   ```

2. **Add language definition**
   Edit `lib/linguist/languages.yml` and add KOI entry (alphabetically)

3. **Add grammar**
   ```bash
   cp /path/to/koi/vendor/grammars/koi.tmLanguage.json vendor/grammars/
   ```

4. **Add samples**
   ```bash
   mkdir -p samples/KOI
   cp /path/to/koi/examples/hello-world.koi samples/KOI/
   cp /path/to/koi/examples/registry-demo.koi samples/KOI/
   ```

5. **Run tests**
   ```bash
   bundle install
   bundle exec rake test
   ```

6. **Generate language ID**
   ```bash
   bundle exec licensed cache
   ```

7. **Update samples.json**
   ```bash
   bundle exec rake samples
   ```

8. **Commit and submit PR**
   ```bash
   git add .
   git commit -m "Add support for KOI language"
   git push origin add-koi-language
   ```
   Then open PR at https://github.com/github/linguist/pulls

### PR Checklist

- [ ] Language entry added to `lib/linguist/languages.yml`
- [ ] Grammar file in `vendor/grammars/koi.tmLanguage.json`
- [ ] At least 2 sample files in `samples/KOI/`
- [ ] All tests pass
- [ ] `samples.json` updated
- [ ] Language ID generated

## Alternative: Vendor Grammar (Current Approach)

Until the Linguist PR is merged, we vendor the grammar in this repository:

```
vendor/
└── grammars/
    └── koi.tmLanguage.json
```

This allows tools that support vendor grammars to highlight KOI code.

## For README.md Code Blocks

In markdown files, use:

````markdown
```koi
Agent Hello : Worker {
  on greet(args: Json) {
    console.log("Hello, KOI!")
  }
}
```
````

**Current behavior**: Highlighted as JavaScript (close enough for now)
**Future behavior**: Full KOI syntax highlighting once Linguist support is added

## Resources

- [GitHub Linguist Documentation](https://github.com/github/linguist/blob/master/CONTRIBUTING.md)
- [Adding a Language Guide](https://github.com/github/linguist/blob/master/CONTRIBUTING.md#adding-a-language)
- [TextMate Grammar Documentation](https://macromates.com/manual/en/language_grammars)
- [VSCode Language Extensions](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)

## Color Choice

We chose **#6495ED** (Cornflower Blue) for KOI:
- Calming color matching the language philosophy ("calm orchestration")
- Good contrast on both light and dark GitHub themes
- Distinct from other languages in the ecosystem

## Updates

Once the Linguist PR is merged:
1. Update `.gitattributes` to use `linguist-language=KOI`
2. Remove temporary JavaScript mapping
3. Update this document with the PR link
4. Celebrate! 🎉
