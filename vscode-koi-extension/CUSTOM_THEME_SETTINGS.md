# Aplicar Colores de Koi a Tu Tema Actual

Si no quieres usar el tema "Koi Dark" pero quieres los colores de Koi, añade esto a tu `settings.json`:

## Paso 1: Abrir Settings JSON

1. `Cmd + Shift + P` (o `Ctrl + Shift + P`)
2. Escribir: `Preferences: Open User Settings (JSON)`
3. Presionar Enter

## Paso 2: Añadir Reglas de Color

Copia y pega esto en tu `settings.json`:

```json
{
  "editor.tokenColorCustomizations": {
    "textMateRules": [
      {
        "scope": [
          "string.quoted.triple.playbook.koi",
          "string.quoted.triple.affordance.koi"
        ],
        "settings": {
          "foreground": "#F7DF1E"
        }
      },
      {
        "scope": "keyword.control.playbook.koi",
        "settings": {
          "foreground": "#fb923c",
          "fontStyle": "bold"
        }
      },
      {
        "scope": "keyword.control.affordance.koi",
        "settings": {
          "foreground": "#fb923c",
          "fontStyle": "bold"
        }
      },
      {
        "scope": "entity.name.class.agent.koi",
        "settings": {
          "foreground": "#fbbf24",
          "fontStyle": "bold"
        }
      },
      {
        "scope": "keyword.control.agent.koi",
        "settings": {
          "foreground": "#a78bfa",
          "fontStyle": "bold"
        }
      }
    ]
  }
}
```

## Paso 3: Guardar y Ver Cambios

Los cambios se aplican inmediatamente.

---

**Nota**: Esto sobrescribe los colores de Koi en cualquier tema que uses.
