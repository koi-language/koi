#!/bin/bash

echo "🔄 Reloading Koi extension in Cursor..."

# Kill Cursor process to force complete reload
echo "1. Closing Cursor..."
killall Cursor 2>/dev/null || echo "   Cursor was not running"

sleep 1

# Clear Cursor extension cache if it exists
CURSOR_CACHE="$HOME/Library/Application Support/Cursor/CachedExtensions"
if [ -d "$CURSOR_CACHE" ]; then
  echo "2. Clearing extension cache..."
  rm -rf "$CURSOR_CACHE"/*koi* 2>/dev/null
  echo "   ✓ Cache cleared"
fi

# Verify symlink
echo "3. Verifying installation..."
if [ -L "$HOME/.cursor/extensions/koi-lang" ]; then
  echo "   ✓ Extension symlink exists"
  ls -la "$HOME/.cursor/extensions/koi-lang" | head -5
else
  echo "   ✗ Extension symlink not found!"
  echo "   Creating symlink..."
  ln -sf "$(pwd)" "$HOME/.cursor/extensions/koi-lang"
fi

echo ""
echo "✅ Done! Now:"
echo "   1. Open Cursor"
echo "   2. Open any .koi file"
echo "   3. Check bottom-right corner - should show 'Koi' as language"
echo "   4. Press Cmd+Shift+P → 'Developer: Show Running Extensions'"
echo "      Look for 'koi-lang' in the list"
echo ""
echo "To test Go to Definition:"
echo "   - Cmd+Click on any Skill, Agent, Role, or Team name"
echo ""
