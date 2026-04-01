/**
 * Add Dependency Action — Register a local project dependency.
 *
 * Agents use this when the user mentions that a related project (e.g. "../backend")
 * is a dependency of the current project, even if it's not declared in any config file.
 * The dependency is saved to .koi/dependencies.json and included in semantic indexing.
 *
 * Permission: read
 */

import path from 'path';

import { addManualDependency, removeManualDependency, listManualDependencies } from '../../code/local-dependency-detector.js';
import { backgroundTaskManager } from '../../api/background-task-manager.js';
import { channel } from '../../io/channel.js';

export default {
  type: 'add_dependency',
  intent: 'add_dependency',
  description: 'Register a LOCAL SIBLING PROJECT DIRECTORY as a workspace dependency so it can be indexed and searched. This is NOT for installing packages (npm, pip, flutter pub, etc.) — use shell for that. Only for linking related local projects like "../backend", "../shared-lib". Fields: "path" (directory path to sibling project), "name" (display name), "reason" (why), "operation" (add|remove|list, default: add)',
  thinkingHint: (action) => `Registering dependency: ${action.path || 'listing'}`,
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the dependency directory (absolute or relative to project root)',
      },
      name: {
        type: 'string',
        description: 'Display name for the dependency (defaults to directory basename)',
      },
      reason: {
        type: 'string',
        description: 'Why this is a dependency (e.g. "user mentioned backend is at ../backend")',
      },
      operation: {
        type: 'string',
        enum: ['add', 'remove', 'list'],
        description: 'Operation to perform (default: add)',
      },
    },
    required: [],
  },

  examples: [
    { actionType: 'direct', intent: 'add_dependency', path: '../backend', name: 'backend', reason: 'User mentioned the backend API is in ../backend' },
    { actionType: 'direct', intent: 'add_dependency', path: '../shared-lib', reason: 'Shared types used by this frontend project' },
    { actionType: 'direct', intent: 'add_dependency', operation: 'list' },
    { actionType: 'direct', intent: 'add_dependency', operation: 'remove', path: '../old-backend' },
  ],

  async execute(action) {
    const projectDir = process.env.KOI_PROJECT_ROOT || process.cwd();
    const operation = action.operation || 'add';

    if (operation === 'list') {
      const deps = listManualDependencies(projectDir);
      return {
        success: true,
        dependencies: deps,
        count: deps.length,
      };
    }

    if (!action.path) {
      return { success: false, error: 'add_dependency requires a "path" field' };
    }

    if (operation === 'remove') {
      const result = removeManualDependency(projectDir, action.path);
      if (result.removed) {
        channel.print(`Dependency removed: ${action.path}`);
      }
      return { success: result.removed, ...result };
    }

    // Reject if the path is inside the current project (implicit, not a dependency)
    const resolved = path.resolve(action.path);
    const projRoot = path.resolve(projectDir);
    if (resolved === projRoot || resolved.startsWith(projRoot + path.sep)) {
      return {
        success: false,
        error: `"${action.path}" is inside the current project — it's already indexed implicitly. add_dependency is only for EXTERNAL sibling projects (e.g. "../backend"). To install packages, use shell (npm install, flutter pub add, pip install, etc.).`,
      };
    }

    // Default: add
    const result = addManualDependency(projectDir, action.path, action.name, action.reason);
    if (result.added) {
      channel.print(`Dependency registered: ${result.path} — indexing now...`);
      backgroundTaskManager.restartSemanticIndexing();
    }
    return { success: result.added, ...result };
  },
};
