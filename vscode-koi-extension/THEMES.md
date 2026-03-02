# 🎨 Koi Themes Guide

La extensión de Koi incluye **tres temas oscuros** con colores optimizados para la sintaxis de Koi.

## Temas Disponibles

### 1. 🌊 Koi Dark (Original)
- Tema completamente personalizado
- Paleta de colores diseñada específicamente para Koi
- Fondo: `#1a1e2e` (azul oscuro)
- **Mejor para**: Usuarios que quieren una experiencia visual completamente nueva

### 2. ⚡ Koi Dark+
- Basado en el tema **Dark+** (default de VS Code)
- Mantiene los colores familiares de Dark+
- Añade colores de Koi para archivos `.koi`
- Fondo: `#1e1e1e` (negro carbón)
- **Mejor para**: Usuarios que prefieren Dark+ pero quieren resaltado de Koi

### 3. 🎯 Koi Dark Modern
- Basado en el tema **Dark Modern** de VS Code
- Look moderno y limpio
- Colores de Koi integrados
- Fondo: `#1f1f1f` (negro suave)
- **Mejor para**: Usuarios que prefieren Dark Modern pero quieren resaltado de Koi

## 🎨 Colores de Koi (Aplicados en los 3 Temas)

Todos los temas incluyen estos colores para archivos `.koi`:

| Elemento | Color | Hex | Descripción |
|----------|-------|-----|-------------|
| **Playbook Content** | Amarillo JS Brillante | `#F7DF1E` | Contenido de `playbook """..."""` |
| **Affordance Content** | Amarillo JS Brillante | `#F7DF1E` | Contenido de `affordance """..."""` |
| Keywords `playbook/on` | Naranja/Terracota | `#CE9178` | Palabras clave de eventos |
| Keywords `Agent/Team` | Púrpura | `#C586C0` | Declaraciones principales |
| Agent/Team Names | Amarillo Suave | `#DCDCAA` | Nombres de entidades |
| `llm`/`run` | Verde Agua | `#4EC9B0` | Keywords de ejecución |
| Types | Verde Agua | `#4EC9B0` | `Json`, `Int`, etc. |
| Properties | Azul Claro | `#9CDCFE` | Propiedades y parámetros |

## 🔧 Cómo Cambiar de Tema

### Método 1: Atajo de Teclado (Más Rápido)

1. Presiona `Cmd + K` luego `Cmd + T` (Mac)
   - O `Ctrl + K` luego `Ctrl + T` (Windows/Linux)

2. Escribe el nombre del tema:
   - `Koi Dark`
   - `Koi Dark+`
   - `Koi Dark Modern`

3. Selecciona con Enter

### Método 2: Command Palette

1. `Cmd + Shift + P` (Mac) o `Ctrl + Shift + P` (Windows/Linux)
2. Escribe: `Preferences: Color Theme`
3. Busca `Koi` para ver los 3 temas
4. Selecciona tu favorito

### Método 3: Settings UI

1. Abre Settings (`Cmd + ,` o `Ctrl + ,`)
2. Busca: `Color Theme`
3. Click en el dropdown
4. Selecciona un tema Koi

## 📊 Comparación Visual

### Koi Dark (Original)
```koi
// Fondo azul oscuro (#1a1e2e)
Agent Greeter : Worker {
  on greet(args: Json) {
    playbook """
    Amarillo brillante #F7DF1E
    """
  }
}
```
- ✨ Paleta completamente custom
- 🌊 Look único de Koi
- 🎨 Contraste optimizado

### Koi Dark+ (Familiar)
```koi
// Fondo negro carbón (#1e1e1e) - como Dark+
Agent Greeter : Worker {
  on greet(args: Json) {
    playbook """
    Amarillo brillante #F7DF1E
    """
  }
}
```
- 👍 Familiarity con Dark+
- 🔥 Playbooks destacan
- ⚡ Lo mejor de ambos mundos

### Koi Dark Modern (Limpio)
```koi
// Fondo negro suave (#1f1f1f) - como Dark Modern
Agent Greeter : Worker {
  on greet(args: Json) {
    playbook """
    Amarillo brillante #F7DF1E
    """
  }
}
```
- 🎯 Look moderno
- ✨ Limpio y profesional
- 🚀 Performance optimizado

## 💡 Recomendaciones

### Usa **Koi Dark** si:
- Quieres experimentar algo nuevo
- Te gusta el azul oscuro
- Prefieres máximo contraste

### Usa **Koi Dark+** si:
- Ya usas Dark+ para otros lenguajes
- Quieres consistencia visual
- Prefieres lo familiar

### Usa **Koi Dark Modern** si:
- Ya usas Dark Modern
- Prefieres look minimalista
- Te gusta lo moderno y limpio

## 🔄 Cambiar entre Temas Rápidamente

**Pro Tip**: Prueba los 3 temas con el mismo archivo abierto:

1. Abre un archivo `.koi`
2. Presiona `Cmd+K Cmd+T` (o `Ctrl+K Ctrl+T`)
3. Usa flechas ↑↓ para ver preview en tiempo real
4. Presiona Enter cuando encuentres tu favorito

## 🎨 El Amarillo Brillante

Todos los temas usan **`#F7DF1E`** (amarillo JavaScript) para los playbooks:
- 🌟 Muy visible y llamativo
- 📝 Destaca los prompts de LLM
- ✨ Uniforme en todo el bloque `"""..."""`
- 🎯 Sin resaltado markdown interno

## ✅ Verificar que Funcionó

Después de cambiar el tema, verifica:
- [ ] Playbooks tienen color amarillo brillante uniforme
- [ ] Keywords `Agent`, `Team` tienen colores distintos
- [ ] `playbook` keyword está resaltado
- [ ] El fondo cambió al del tema seleccionado

---

¿Tienes preguntas sobre los temas? Revisa [README.md](README.md) para más info.

**Koi**: Agent-first language. Calm orchestration. 🌊
