#!/bin/bash

# Script to prepare files for GitHub Linguist PR
# This script helps you prepare a PR to add KOI to github/linguist

set -e

echo "🔧 Preparing KOI for GitHub Linguist PR"
echo ""

# Check if linguist repo is cloned
if [ ! -d "../linguist" ]; then
  echo "📥 Cloning github/linguist..."
  cd ..
  git clone https://github.com/github/linguist.git
  cd linguist
  bundle install
  cd ../koi
else
  echo "✅ Linguist repository found"
fi

# Copy grammar
echo "📋 Copying grammar file..."
cp vendor/grammars/koi.tmLanguage.json ../linguist/vendor/grammars/

# Copy samples
echo "📋 Copying sample files..."
mkdir -p ../linguist/samples/KOI
cp samples/KOI/*.koi ../linguist/samples/KOI/

# Create language definition snippet
echo ""
echo "📝 Add this to linguist/lib/linguist/languages.yml (alphabetically under K):"
echo ""
cat << 'EOF'
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
EOF

echo ""
echo "⚙️  Next steps:"
echo ""
echo "1. cd ../linguist"
echo "2. Edit lib/linguist/languages.yml and add the KOI entry above"
echo "3. Run: bundle exec rake samples"
echo "4. Run: bundle exec rake test"
echo "5. Run: script/licensed"
echo "6. Commit and push:"
echo "   git checkout -b add-koi-language"
echo "   git add ."
echo "   git commit -m 'Add support for KOI language'"
echo "   git push origin add-koi-language"
echo "7. Open PR at https://github.com/github/linguist/pulls"
echo ""
echo "📚 See LINGUIST.md for more details"
