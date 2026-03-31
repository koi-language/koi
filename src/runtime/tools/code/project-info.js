/**
 * Project Info Action — Returns structured knowledge about the current project.
 *
 * Agents can call this to understand the project layout, tech stack,
 * build scripts, directory structure, requirements, and shared knowledge
 * before making decisions.
 */

import fs from 'fs';
import path from 'path';
import { t } from '../../i18n.js';

export default {
  type: 'project_info',
  intent: 'project_info',
  description: 'Get project knowledge: tech stack, directory structure, build scripts, requirements, and shared facts. Use this BEFORE exploring files to understand the project layout and make informed decisions. Fields: optional "section" (all|structure|stack|scripts|requirements|knowledge). Returns: { success, info }',
  thinkingHint: 'Reading project info',
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: ['all', 'structure', 'stack', 'scripts', 'requirements', 'knowledge'],
        description: 'Which section to return (default: all)',
      },
    },
    required: [],
  },

  examples: [
    { actionType: 'direct', intent: 'project_info' },
    { actionType: 'direct', intent: 'project_info', section: 'structure' },
    { actionType: 'direct', intent: 'project_info', section: 'scripts' },
  ],

  async execute(action, agent) {
    const section = action.section || 'all';
    const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
    const koiDir = path.join(projectRoot, '.koi');
    const result = {};

    // ── Stack & project map ──────────────────────────────────────────
    if (section === 'all' || section === 'stack') {
      try {
        const { getProjectMap } = await import('../code/project-map.js');
        result.projectMap = await getProjectMap(projectRoot);
      } catch (err) {
        result.projectMap = `Error: ${err.message}`;
      }
    }

    // ── Directory structure (scan) ───────────────────────────────────
    if (section === 'all' || section === 'structure') {
      try {
        const scanPath = path.join(koiDir, 'project-scan.md');
        if (fs.existsSync(scanPath)) {
          result.structure = fs.readFileSync(scanPath, 'utf8');
        } else {
          // Generate on demand if not cached
          const { ensureProjectScan } = await import('../code/project-map.js');
          result.structure = await ensureProjectScan(projectRoot);
        }
      } catch (err) {
        result.structure = `Error: ${err.message}`;
      }
    }

    // ── Build scripts ────────────────────────────────────────────────
    if (section === 'all' || section === 'scripts') {
      const scripts = {};
      // package.json scripts
      const pkgPath = path.join(projectRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.scripts) scripts.npm = pkg.scripts;
        } catch {}
      }
      // Makefile targets
      const makePath = path.join(projectRoot, 'Makefile');
      if (fs.existsSync(makePath)) {
        try {
          const content = fs.readFileSync(makePath, 'utf8');
          const targets = content.match(/^([a-zA-Z_-]+):/gm);
          if (targets) scripts.make = targets.map(t => t.replace(':', ''));
        } catch {}
      }
      result.scripts = scripts;
    }

    // ── Requirements (.koi/requirements.md) ──────────────────────────
    if (section === 'all' || section === 'requirements') {
      const reqPath = path.join(koiDir, 'requirements.md');
      if (fs.existsSync(reqPath)) {
        try {
          const content = fs.readFileSync(reqPath, 'utf8');
          result.requirements = content.length > 3000 ? content.substring(0, 3000) + '\n...(truncated)' : content;
        } catch {}
      }
      // Also check project-brief.md
      const briefPath = path.join(koiDir, 'project-brief.md');
      if (fs.existsSync(briefPath)) {
        try { result.brief = fs.readFileSync(briefPath, 'utf8'); } catch {}
      }
    }

    // ── Shared knowledge (facts) ─────────────────────────────────────
    if (section === 'all' || section === 'knowledge') {
      try {
        const { sessionTracker } = await import('../../state/session-tracker.js');
        const facts = sessionTracker?.loadKnowledge?.() || [];
        if (facts.length > 0) {
          result.knowledge = facts.map(f => ({
            key: f.key,
            category: f.category,
            value: f.value,
          }));
        }
      } catch {}
    }

    return { success: true, section, ...result };
  },
};
