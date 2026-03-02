/**
 * Grep Action - Search for a pattern across files and return matching lines with context.
 *
 * Token-efficient alternative to read_file + manual scanning.
 * Returns only matching lines (+ optional context) instead of full file contents.
 *
 * Permission: per directory, shared with read_file/search.
 */

import fs from 'fs';
import path from 'path';
import { cliLogger } from '../cli-logger.js';
import { cliSelect } from '../cli-select.js';
import { getFilePermissions } from '../file-permissions.js';
import { discoverFiles, IGNORE_DIRS, SOURCE_EXTS } from '../file-discovery.js';

/**
 * Expand non-ASCII characters (emoji, etc.) in a grep pattern so the search
 * also matches their unicode escape forms commonly found in source code:
 *   🔌  →  (?:🔌|\\u\{1F50C\}|\\uD83D\\uDD0C)
 *
 * Handles both ES2015 \u{XXXX} and the surrogate-pair form \uHHHH\uHHHH.
 * Returns the original pattern unchanged if it contains no non-Latin chars.
 */
function expandEmojiPattern(pattern) {
  if (!/[^\x00-\xFF]/.test(pattern)) return pattern;

  let result = '';
  let i = 0;
  let changed = false;

  while (i < pattern.length) {
    const cp = pattern.codePointAt(i);
    const charLen = cp > 0xFFFF ? 2 : 1;

    if (cp > 0xFF) {
      changed = true;
      const literal = String.fromCodePoint(cp);
      const hex = cp.toString(16).toUpperCase();

      // ES2015 \u{XXXX} — in regex pattern string: \\u\{HEX\}
      const es6form = `\\\\u\\{${hex}\\}`;
      const alts = [literal, es6form];

      if (cp > 0xFFFF) {
        // Surrogate pair \uHHHH\uHHHH
        const hi = (Math.floor((cp - 0x10000) / 0x400) + 0xD800).toString(16).toUpperCase();
        const lo = (((cp - 0x10000) % 0x400) + 0xDC00).toString(16).toUpperCase();
        alts.push(`\\\\u${hi}\\\\u${lo}`);
      }

      result += `(?:${alts.join('|')})`;
      i += charLen;
    } else {
      result += pattern[i];
      i++;
    }
  }

  return changed ? result : pattern;
}

/**
 * Convert a glob pattern (e.g. "*.js", "src/**\/*.ts") to a RegExp.
 */
function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '⭐⭐')
    .replace(/\*/g, '[^/]*')
    .replace(/⭐⭐/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(escaped, 'i');
}

/**
 * Filter a file list by a glob pattern.
 */
function filterByGlob(files, globPattern, basePath) {
  const regex = globToRegex(globPattern);
  return files.filter(f => regex.test(path.relative(basePath, f)));
}

export default {
  type: 'grep',
  intent: 'grep',
  description: 'Search files for a regex pattern. Returns matching lines with optional context. Token-efficient: only returns matches, not full file contents. Fields: "pattern" (regex or literal string), optional "path" (dir or file, default cwd), optional "glob" (file filter e.g. "*.js"), optional "context" (lines before+after each match, default 0), optional "ignoreCase" (boolean, default true), optional "maxMatches" (default 50). Returns: { success, count, results: [{ file, line, text, before?, after? }] }',
  thinkingHint: 'Searching code',
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      pattern:     { type: 'string',  description: 'Regex or literal string to search for' },
      path:        { type: 'string',  description: 'File or directory to search (default: cwd)' },
      glob:        { type: 'string',  description: 'File filter glob pattern, e.g. "*.js", "src/**/*.ts"' },
      context:     { type: 'number',  description: 'Lines of context to include before and after each match (default 0)' },
      ignoreCase:  { type: 'boolean', description: 'Case-insensitive search (default true)' },
      maxMatches:  { type: 'number',  description: 'Maximum total matches to return (default 50)' }
    },
    required: ['pattern']
  },

  examples: [
    { actionType: 'direct', intent: 'grep', pattern: 'executeOpenAI', path: 'src' },
    { actionType: 'direct', intent: 'grep', pattern: 'function\\s+\\w+', glob: '*.js', context: 2 },
    { actionType: 'direct', intent: 'grep', pattern: 'TODO', ignoreCase: true, maxMatches: 20 }
  ],

  async execute(action, agent) {
    const pattern = action.pattern;
    if (!pattern) return { success: false, error: 'grep: "pattern" field is required' };

    const searchPath = path.resolve(action.path || process.cwd());
    const contextLines = typeof action.context === 'number' ? Math.max(0, action.context) : 0;
    const ignoreCase = action.ignoreCase !== false; // default true
    const maxMatches = typeof action.maxMatches === 'number' ? action.maxMatches : 50;

    if (!fs.existsSync(searchPath)) {
      return { success: false, error: `Path not found: ${searchPath}` };
    }

    // Permission check
    const permissions = getFilePermissions(agent);
    const stat = fs.statSync(searchPath);
    const isFile = stat.isFile();
    const searchDir = isFile ? path.dirname(searchPath) : searchPath;

    if (!permissions.isAllowed(searchPath, 'read')) {
      cliLogger.clearProgress();
      const agentName = agent?.name || 'Agent';
      cliLogger.print(`🔍 ${agentName} wants to grep: \x1b[33m${searchPath}\x1b[0m`);

      const value = await cliSelect('Allow searching in this directory?', [
        { title: 'Yes',          value: 'yes',    description: 'Allow this time' },
        { title: 'Always allow', value: 'always', description: 'Always allow in this directory' },
        { title: 'No',           value: 'no',     description: 'Deny access' }
      ]);

      if (value === 'always') {
        permissions.allow(searchDir, 'read');
      } else if (value !== 'yes') {
        cliLogger.print('\x1b[2mSkipped\x1b[0m');
        return { success: false, denied: true, message: 'User denied grep access' };
      }
    }

    // Build regex
    let regex;
    try {
      regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
    } catch {
      return { success: false, error: `Invalid regex pattern: ${pattern}` };
    }

    // Collect files to search
    let files = isFile ? [searchPath] : discoverFiles(searchDir);

    if (action.glob) {
      files = filterByGlob(files, action.glob, searchDir);
    }

    if (files.length === 0) {
      return { success: true, count: 0, results: [] };
    }

    // Search
    const results = [];
    let totalMatches = 0;

    for (const filePath of files) {
      if (totalMatches >= maxMatches) break;

      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }

      const lines = content.split('\n');
      const relFile = path.relative(searchDir, filePath);

      for (let i = 0; i < lines.length; i++) {
        if (totalMatches >= maxMatches) break;

        regex.lastIndex = 0;
        if (!regex.test(lines[i])) continue;

        const match = {
          file: relFile,
          line: i + 1,
          text: lines[i]
        };

        if (contextLines > 0) {
          const before = lines.slice(Math.max(0, i - contextLines), i);
          const after  = lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines));
          if (before.length) match.before = before;
          if (after.length)  match.after  = after;
        }

        results.push(match);
        totalMatches++;
      }
    }

    return {
      success: true,
      count: results.length,
      truncated: totalMatches >= maxMatches,
      results
    };
  }
};
