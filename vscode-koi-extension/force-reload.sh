#!/bin/bash

echo "🔄 Forzando recarga de la extensión Koi..."
echo ""

# Eliminar y reinstalar symlinks
echo "1. Eliminando symlinks antiguos..."
rm -f ~/.vscode/extensions/koi-lang
rm -f ~/.cursor/extensions/koi-lang

echo "2. Recreando symlinks..."
ln -sf "$(pwd)" ~/.vscode/extensions/koi-lang
ln -sf "$(pwd)" ~/.cursor/extensions/koi-lang 2>/dev/null

echo ""
echo "✅ Extensión reinstalada"
echo ""
echo "IMPORTANTE: Ahora debes:"
echo "  1. Cerrar COMPLETAMENTE tu editor (Cmd+Q en Mac)"
echo "  2. Volver a abrirlo"
echo "  3. Abrir un archivo .koi"
echo ""
echo "O más rápido:"
echo "  1. Cmd+Shift+P (o Ctrl+Shift+P)"
echo "  2. Escribir: 'Developer: Reload Window'"
echo "  3. Enter"
echo ""
