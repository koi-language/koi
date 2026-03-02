# ✨ Color Actualizado - Playbooks y Affordances

## Cambios Realizados

### 🎨 Nuevo Color: Amarillo Oro Uniforme

Los bloques `playbook` y `affordance` ahora tienen:
- **Color**: `#fbbf24` (amarillo oro vibrante)
- **Estilo**: Normal (sin cursiva)
- **Contenido**: Todo el texto en el mismo color, sin resaltado interno

### Antes vs Después

**❌ Antes:**
```koi
playbook """
Este texto estaba en amarillo pálido cursiva
Y tenía resaltado markdown interno como **negrita** o `código`
```

**✅ Ahora:**
```koi
playbook """
Todo este texto es amarillo oro uniforme #fbbf24
Sin importar lo que escribas **aquí** o `aquí`
Todo mantiene el mismo color dorado
"""
```

## 🔧 Archivos Modificados

1. **`syntaxes/koi.tmLanguage.json`**
   - Eliminado `contentName: "meta.embedded.block.markdown"` de playbooks
   - Ahora playbooks y affordances son strings simples sin sintaxis interna
   - Añadidos scopes específicos:
     - `string.quoted.triple.playbook.koi`
     - `string.quoted.triple.affordance.koi`

2. **`themes/koi-dark.json`**
   - Color cambiado de `#fde68a` (amarillo pálido) a `#fbbf24` (amarillo oro)
   - Removida la cursiva (`fontStyle: ""` en lugar de `"italic"`)
   - Aplicado tanto a playbooks como affordances

## 🧪 Probar los Cambios

### 1. Recargar VS Code/Cursor

**Opción A - Reload Window (Recomendado):**
- Press `Cmd+Shift+P` (Mac) o `Ctrl+Shift+P` (Windows/Linux)
- Escribir "Reload Window"
- Presionar Enter

**Opción B - Reiniciar Completamente:**
- Cerrar VS Code/Cursor completamente
- Volver a abrir

### 2. Abrir Archivo de Prueba

```bash
code vscode-koi-extension/TEST_COLORS.koi
# o
cursor vscode-koi-extension/TEST_COLORS.koi
```

### 3. Verificar Colores

Deberías ver:

✅ **Playbooks y Affordances:**
- Color amarillo oro brillante (`#fbbf24`)
- Todo el texto del mismo color
- Sin cursiva
- Sin colores internos para markdown

✅ **Otros Elementos Mantienen sus Colores:**
- `Agent` - Purple
- `playbook` (keyword) - Orange
- `llm default` - Green
- Strings normales `"..."` - Light green

## 🎨 Paleta de Colores Actualizada

| Elemento | Color | Hex | Ejemplo |
|----------|-------|-----|---------|
| Playbook content | Amarillo Oro | `#fbbf24` | `"""texto"""` |
| Affordance content | Amarillo Oro | `#fbbf24` | `"""texto"""` |
| `playbook` keyword | Naranja | `#fb923c` | `playbook` |
| `affordance` keyword | Naranja | `#fb923c` | `affordance` |
| Agents/Teams | Amarillo | `#fbbf24` | `Agent Foo` |
| Strings normales | Verde Claro | `#86efac` | `"hello"` |

## 📸 Ejemplo Visual

```koi
Agent Greeter : Worker {
  llm default = { provider: "openai" }  // verde

  on greet(args: Json) {  // naranja
    playbook """
    TODO ESTE TEXTO ES AMARILLO ORO #fbbf24
    Sin importar qué escribas aquí
    # Títulos
    **Negrita**
    `Código`
    [Links](url)
    Todo es del mismo amarillo oro uniforme
    """  // naranja al cerrar
  }
}
```

## ✅ Checklist de Verificación

- [ ] Recargué VS Code/Cursor (`Cmd+Shift+P` → "Reload Window")
- [ ] Abrí `TEST_COLORS.koi`
- [ ] Playbooks tienen color amarillo oro uniforme
- [ ] Affordances tienen color amarillo oro uniforme
- [ ] No hay cursiva en playbooks/affordances
- [ ] Keywords `playbook` y `affordance` siguen en naranja
- [ ] No veo colores diferentes dentro del texto

## 🐛 Troubleshooting

### El color no cambió

1. **Forzar recarga de extensión:**
   ```bash
   # Reinstalar
   cd vscode-koi-extension
   rm ~/.vscode/extensions/koi-lang
   ln -s "$(pwd)" ~/.vscode/extensions/koi-lang
   ```

2. **Limpiar caché de VS Code:**
   - `Cmd+Shift+P` → "Developer: Reload Window"
   - O cerrar y reabrir completamente

3. **Verificar que estás usando el tema correcto:**
   - Si no usas "Koi Dark", el color puede ser diferente
   - Activa "Koi Dark": `Cmd+K Cmd+T` → "Koi Dark"

### Veo cursiva o colores internos

1. Verifica que el archivo tenga extensión `.koi`
2. Click en el indicador de lenguaje (abajo derecha) → Selecciona "Koi"
3. Recarga la ventana completamente

### Los keywords no tienen color

Si `playbook` o `affordance` no se ven naranjas:
- Verifica que la sintaxis sea correcta: `playbook """`
- Debe haber un espacio entre la palabra y las comillas triple

## 🎉 ¡Listo!

Ahora tus playbooks y affordances tienen un hermoso color amarillo oro uniforme, perfecto para distinguirlos del resto del código.

---

**Koi**: Agent-first language. Calm orchestration. 🌊
