# Changelog

All notable changes to the Koi Language extension will be documented in this file.

## [1.0.3] - 2026-01-21

### Added
- **New themes**: Koi Dark+ and Koi Dark Modern
- Koi syntax colors now available in familiar Dark+ and Dark Modern base themes
- All three themes feature the bright yellow (`#F7DF1E`) playbooks

## [1.0.2] - 2026-01-21

### Changed
- **Playbook and Affordance colors**: Changed to bright JavaScript yellow (`#F7DF1E`)
- More vibrant and eye-catching color for LLM prompts

## [1.0.1] - 2026-01-21

### Changed
- **Playbook and Affordance colors**: Changed to uniform color
- Removed italic styling from playbooks and affordances
- Removed internal markdown syntax highlighting within playbooks
- Now all text within `"""..."""` blocks has the same color
- Improved visual consistency for LLM prompts

### Fixed
- Internal markdown in playbooks no longer shows different colors
- Affordances now have the same styling as playbooks

## [1.0.0] - 2026-01-21

### Added
- Initial release of Koi Language Support
- Full syntax highlighting for `.koi` files
- Custom "Koi Dark" theme
- Language configuration (brackets, comments, indentation)
- Special highlighting for:
  - Agents, Teams, Skills, Roles
  - Event handlers (`on`)
  - Playbooks (triple-quoted strings)
  - LLM configurations
  - State declarations
  - Affordances
- File icon for `.koi` files
- Auto-closing pairs
- Comment toggling support
- Installation scripts for macOS/Linux and Windows

### Features
- Distinct colors for all Koi language constructs
- Markdown embedding in playbooks
- Smart indentation rules
- Bracket matching

### Documentation
- Comprehensive README with examples
- Installation guide for VS Code and Cursor
- Troubleshooting section
- Color scheme reference
