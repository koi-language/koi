/**
 * Shell Action - Execute a shell command with user permission.
 *
 * The LLM must provide a human-readable description of what the command does.
 * Before execution, the user is prompted for permission unless the command
 * has been "Always allow"-ed for this agent during the current session.
 *
 * Safe read-only commands (pwd, whoami, date, which, uname, hostname)
 * run silently without asking for permission or showing output chrome.
 *
 * Permission options:
 *   - Yes            → execute this time only
 *   - Always allow   → execute without asking again for this category + directory
 *   - No             → skip this time (can be asked again later)
 *
 * Permission grouping (shared with file actions read_file/write_file/edit_file):
 *   - READ commands (ls, cat, grep, …)  → shared with read_file / search per directory
 *   - WRITE commands (mkdir, rm, cp, …) → shared with write_file / edit_file per directory
 *   - Other commands (node, npm, …)     → individual permission per command + directory
 *
 * Permissions are per-agent and in-memory only (reset between sessions).
 */

import { spawn } from 'child_process';
import path from 'path';
import { cliLogger } from '../cli-logger.js';
import { cliSelect } from '../cli-select.js';
import { getFilePermissions } from '../file-permissions.js';

// Use the user's preferred shell so that PATH and shell functions loaded via
// .zshrc/.bashrc (e.g. nvm, rbenv, pyenv, conda, fnm) are available.
// Falls back to /bin/zsh on macOS and /bin/sh elsewhere.
const USER_SHELL = process.env.SHELL ||
  (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');

// Source the user's interactive rc file before running the command so that shell
// functions (nvm, rbenv, pyenv, …) are available. We do NOT use the -i flag because
// interactive shells call tcsetpgrp() to take over the controlling terminal, which
// puts the parent process (koi-cli/Ink) in the background and triggers SIGTTIN.
// Instead, we source the rc file explicitly and suppress its output so it doesn't
// pollute the command's stdout/stderr.
function _shellArgs(cmd) {
  const shellName = path.basename(USER_SHELL);
  let rcSource = '';
  if (shellName === 'zsh') {
    rcSource = '[ -f ~/.zshrc ] && source ~/.zshrc >/dev/null 2>&1; ';
  } else if (shellName === 'bash') {
    rcSource = '[ -f ~/.bashrc ] && source ~/.bashrc >/dev/null 2>&1; ';
  }
  return ['-c', rcSource + cmd];
}


let _pty = null;
let _ptyChecked = false;
async function _loadPty() {
  if (_ptyChecked) return;
  _ptyChecked = true;
  try {
    _pty = (await import('node-pty')).default;
    cliLogger.log('shell', 'node-pty loaded ✓');
    // Inside a pkg snapshot, spawn-helper is readable but not executable.
    // Extract it to a real temp path so posix_spawnp can exec it.
    _extractSpawnHelperIfNeeded();
  } catch (e) {
    cliLogger.log('shell', `node-pty unavailable, using spawn fallback`);
  }
}

/** Extract node-pty's spawn-helper from pkg snapshot to a real filesystem path. */
function _extractSpawnHelperIfNeeded() {
  try {
    const fs = require('fs');
    const os = require('os');
    const nodePtyDir = require.resolve('node-pty');
    // Only needed inside a pkg snapshot
    if (!nodePtyDir.startsWith('/snapshot') && !nodePtyDir.startsWith('C:\\snapshot')) return;
    const ptyLibDir = require('path').dirname(nodePtyDir);
    const prebuildDir = require('path').join(ptyLibDir, '..', 'prebuilds', `${process.platform}-${process.arch}`);
    const snapshotHelper = require('path').join(prebuildDir, 'spawn-helper');
    if (!fs.existsSync(snapshotHelper)) return;
    const tempHelper = require('path').join(os.tmpdir(), 'koi-pty-spawn-helper');
    if (!fs.existsSync(tempHelper)) {
      fs.copyFileSync(snapshotHelper, tempHelper);
      fs.chmodSync(tempHelper, 0o755);
      cliLogger.log('shell', `spawn-helper extracted to ${tempHelper}`);
    }
    // Patch node-pty's unixTerminal module to use the extracted helper
    const unixTerminalPath = require.resolve('node-pty/lib/unixTerminal');
    const unixTerminal = require(unixTerminalPath);
    // The helperPath is a module-level var used in the UnixTerminal constructor.
    // We can't change it directly, but we can monkey-patch the constructor
    // to override the env before fork.  Alternatively, node-pty checks
    // the helperPath at pty.fork() — let's replace the pty.fork binding.
    const nativeUtils = require('node-pty/lib/utils');
    const native = nativeUtils.loadNativeModule('pty');
    const origFork = native.module.fork;
    native.module.fork = function(file, args, env, cwd, cols, rows, uid, gid, utf8, _helperPath, onexit) {
      return origFork.call(this, file, args, env, cwd, cols, rows, uid, gid, utf8, tempHelper, onexit);
    };
    cliLogger.log('shell', `spawn-helper patched → ${tempHelper}`);
  } catch (e) {
    cliLogger.log('shell', `spawn-helper extraction skipped: ${e.message}`);
  }
}

// Semaphore — limits simultaneous PTY spawns to avoid spawn-helper concurrency
// issues on macOS and OS limits under high parallel concurrency.
const _PTY_MAX = 4;
let _ptyActive = 0;
function _tryAcquirePty() {
  if (_ptyActive < _PTY_MAX) { _ptyActive++; return true; }
  return false;
}
function _releasePty() { _ptyActive = Math.max(0, _ptyActive - 1); }

/**
 * Injectable callback — wired by ink-bootstrap.js to uiBridge.submitInput().
 * When a background process exits unexpectedly, we inject a system message
 * into the agent's input queue so it can react (retry, inform user, etc.).
 */
let _bgNotify = null;
export function setBackgroundNotifyCallback(fn) {
  _bgNotify = fn;
}

// Injectable callback for live shell output streaming.
// Called with null to signal a new command started (reset), or a string chunk.
let _shellOutputCallback = null;
export function setShellOutputCallback(fn) {
  _shellOutputCallback = fn;
}

// Injectable callback for secret prompts (passwords, API keys) detected in shell output.
// Kept for backwards-compatibility — wired by ink-bootstrap.js to uiBridge.promptSecret().
// In practice, interactive prompt detection is now handled by the running agent via the
// _inputNeeded generator yield, so this callback is rarely called directly.
let _passwordPromptCallback = null;
export function setPasswordPromptCallback(fn) {
  _passwordPromptCallback = fn;
}

/**
 * Detect potentially dangerous command patterns and return a warning string,
 * or null if no concerns are found.
 */
function detectWarnings(command) {
  const warnings = [];
  if (/(?<![|>])<(?!\s*<)/.test(command))          warnings.push('Command contains input redirection (<) which could read sensitive files');
  if (/rm\s+(-\w*r\w*|-r\w*f\w*)\s/i.test(command)) warnings.push('Command contains recursive deletion (rm -r) which permanently removes files');
  if (/\bsudo\b/.test(command))                     warnings.push('Command runs with elevated (sudo) privileges');
  if (/\bcurl\b.*\|\s*(bash|sh)\b/.test(command) || /\bwget\b.*\|\s*(bash|sh)\b/.test(command))
                                                    warnings.push('Command pipes remote content directly into a shell');
  return warnings.length > 0 ? warnings.join('\n ') : null;
}

/**
 * Extract the base command from a shell command string.
 * E.g. "npm install foo" → "npm", "ls -la /tmp" → "ls"
 */
function extractBaseCommand(command) {
  const trimmed = command.trim();
  // Skip env vars at the start (e.g. FOO=bar npm install)
  const parts = trimmed.split(/\s+/);
  for (const part of parts) {
    if (!part.includes('=')) return part.replace(/^.*\//, ''); // strip path
  }
  return parts[0] || '';
}

/**
 * Extract the target directory from a command (for per-directory permissions).
 */
function extractTargetDir(command, cwd) {
  return cwd || process.cwd();
}

/**
 * Command categories for permission grouping.
 *
 * READ  → permission covers ALL read commands in a directory
 * WRITE → permission covers ALL write/modify commands in a directory
 * other → individual permission per base command
 */
const READ_COMMANDS = new Set([
  'ls', 'll', 'la', 'cat', 'head', 'tail', 'less', 'more', 'bat',
  'find', 'grep', 'rg', 'ag', 'ack', 'fd',
  'wc', 'sort', 'uniq', 'tr', 'cut', 'diff', 'cmp', 'comm',
  'file', 'stat', 'du', 'df', 'ps', 'lsof', 'tree',
  'strings', 'xxd', 'od', 'hexdump',
]);

const WRITE_COMMANDS = new Set([
  'mkdir', 'rmdir', 'touch', 'rm', 'cp', 'mv', 'ln',
  'chmod', 'chown', 'chgrp', 'tee', 'rsync', 'install',
]);

/**
 * Return the permission category key for a base command:
 *   'READ'  – grouped with all read commands
 *   'WRITE' – grouped with all write/modify commands
 *   baseCmd – individual (execution commands like node, flutter, etc.)
 */
function permissionCategory(baseCmd) {
  if (READ_COMMANDS.has(baseCmd)) return 'READ';
  if (WRITE_COMMANDS.has(baseCmd)) return 'WRITE';
  return baseCmd;
}

/**
 * Global per-command permission tracker for non-READ/WRITE commands
 * (node, npm, flutter, etc.) — shared across all agents.
 */
class IndividualPermissions {
  constructor() {
    this._map = new Map();
  }
  isAllowed(baseCmd, dir) {
    return this._map.has(`${baseCmd}:${dir}`) || this._map.has(`${baseCmd}:*`);
  }
  allow(baseCmd, dir) {
    this._map.set(`${baseCmd}:${dir}`, true);
  }
}

const _globalIndividualPerms = new IndividualPermissions();

/**
 * Global serial queue for permission requests.
 * Parallel shell actions must not show overlapping permission menus — the last
 * uiBridge.select() call would overwrite the previous resolve, leaving earlier
 * promises permanently stuck and hanging the entire parallel batch.
 * Queuing ensures prompts appear one at a time regardless of parallelism.
 *
 * Additionally, each queue item waits for the previous command to finish
 * executing before showing its menu. This prevents command output (stderr,
 * "Failed" messages, clearProgress calls) from corrupting the next SelectMenu's
 * keyboard input focus in Ink.
 */
const _permQueue = [];
let _permQueueRunning = false;

/**
 * Cancel function for the currently active permission dialog.
 * Set inside _drainPermQueue while awaiting cliSelect; cleared when done.
 * Called by cancelActivePermission() to unblock a stuck queue.
 */
let _activeSelectCancel = null;

/**
 * Cancel any active permission dialog and drain the queue with 'no'.
 * Must be called when a parallel delegate times out so the locked queue
 * is released and the next attempt can show a fresh permission prompt.
 */
export function cancelActivePermission() {
  _activeSelectCancel?.(); // resolve the active cliSelect with null (= denied)
  // Deny and clear all remaining queued items
  while (_permQueue.length > 0) {
    const item = _permQueue.shift();
    item.resolve({ answer: 'no', reportDone: () => {}, descriptionShown: false });
  }
  _permQueueRunning = false; // allow the next drain to start fresh
}

async function _drainPermQueue() {
  if (_permQueueRunning) return;
  _permQueueRunning = true;
  let waitForPrev = Promise.resolve();
  while (_permQueue.length > 0) {
    const { command, baseCmd, description, agentName, resolve, checkPermitted } = _permQueue.shift();

    // If a prior grant in this queue run already covers this command, skip the prompt.
    if (checkPermitted && checkPermitted()) {
      resolve({ answer: 'yes', reportDone: () => {}, descriptionShown: false });
      continue;
    }

    // Wait for the previous command to finish executing before showing the next
    // permission prompt. Without this, command output (stderr, clearProgress)
    // fires while the SelectMenu is active, disrupting Ink's input handling.
    await waitForPrev;

    // Check again after the await — a timeout may have drained the queue already.
    if (!_permQueueRunning) break;

    cliLogger.clearProgress();
    // Build the "Always allow" label based on the command's category
    const alwaysLabel = (() => {
      const cat = permissionCategory(baseCmd);
      if (cat === 'READ')  return 'Always allow read commands in this directory';
      if (cat === 'WRITE') return 'Always allow write commands in this directory';
      return `Always allow ${baseCmd}`;
    })();

    // Detect dangerous patterns for the warning message
    const warning = detectWarnings(command);

    // Race the cliSelect against a cancel token so that if the delegate times out
    // and cancelActivePermission() is called, the dialog resolves immediately with
    // null (treated as 'no') instead of blocking the queue forever.
    let _cancelDialog;
    const _cancelToken = new Promise(r => { _cancelDialog = r; });
    _activeSelectCancel = () => _cancelDialog(null);

    // Pass command + warning as meta so the UI can render the Claude-style layout
    const value = await Promise.race([
      cliSelect(description, [
        { title: 'Yes', value: 'yes' },
        { title: alwaysLabel, value: 'always' },
        { title: 'No', value: 'no' }
      ], 0, { meta: { type: 'bash', command, warning } }),
      _cancelToken,
    ]);

    _activeSelectCancel = null;

    // If the queue was cancelled while we were waiting, bail out.
    if (!_permQueueRunning) break;

    // Create a done signal: execute() calls reportDone() when the command
    // finishes. The next queue iteration awaits this before showing its menu.
    let reportDone;
    waitForPrev = new Promise(r => { reportDone = r; });
    resolve({ answer: value || 'no', reportDone, descriptionShown: false });
  }
  _permQueueRunning = false;
}

async function askPermission(command, baseCmd, description, agentName, checkPermitted) {
  return new Promise((resolve) => {
    _permQueue.push({ command, baseCmd, description, agentName, resolve, checkPermitted });
    _drainPermQueue();
  });
}

export default {
  type: 'shell',
  intent: 'shell',
  description: 'Execute a shell command (requires user permission). Requires: command (the shell command), description (human-friendly explanation of what it does and why). Optional: cwd (working directory), background (boolean — launch without waiting, for apps/servers)',
  instructions: `If a shell command returns "command not found" or exit code 127, the required tool is missing:
1) stop the current task
2) ask permission with prompt_user using options ["Yes", "No"]
3) if Yes, install the tool first
4) if No, tell the user what is missing and stop

If an action fails, do not guess. Choose another valid action only if it is meaningfully different and can resolve the issue.

Commands that launch long-running processes MUST use "background": true. Examples: npm start, flutter run, python server.py, open -a Simulator.`,
  thinkingHint: (action) => `Executing ${extractBaseCommand(action.command || '')}`,
  permission: 'execute',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      description: { type: 'string', description: 'Human-friendly reason WHY this command is needed (shown to user). Express NEED, not action. Good: "Need to install X because Y". Bad: "Installing X".' },
      cwd: { type: 'string', description: 'Working directory for the command (optional)' },
      background: { type: 'boolean', description: 'If true, launch without waiting for completion. Use for commands that start long-running processes: apps, emulators, dev servers (e.g. flutter run, open -a Simulator, npm start).' },
      timeout: { type: 'number', description: 'Timeout in milliseconds before the command is killed (default: 120000 = 2 min). Set higher for long-running commands like terraform apply, docker build, long test suites.' },
      stream_interval: { type: 'number', description: 'How often (in ms) to snapshot streaming output for agent analysis during long-running commands (default: 30000 = 30s). Set lower for commands where you want more frequent progress checks.' }
    },
    required: ['command', 'description']
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'shell',
      command: 'npm install',
      description: 'Need to install Node.js dependencies required by the project',
      cwd: '/path/to/project'
    }
  ],

  async * execute(action, agent) {
    const { command, description: _desc, cwd, background = false, timeout: timeoutMs = 120000, stream_interval = 30000 } = action;

    if (!command) {
      throw new Error('shell: "command" field is required');
    }
    const description = _desc || command;

    const _cmdFull = command.split('\n')[0];
    const cmdPreview = _cmdFull.length > 60 ? _cmdFull.substring(0, 60) + '...' : _cmdFull;

    // Reject commands with obvious placeholder values like <your_api_key>, <TOKEN>, etc.
    const placeholderMatch = command.match(/<[a-zA-Z_][a-zA-Z0-9_]*>/);
    if (placeholderMatch) {
      return {
        success: false,
        error: `Command contains a placeholder "${placeholderMatch[0]}" instead of a real value. Do NOT use placeholder values — use actual values or ask the user for them with prompt_user.`
      };
    }

    const baseCmd = extractBaseCommand(command);
    const effectiveDir = extractTargetDir(command, cwd);
    const cat = permissionCategory(baseCmd);

    // Safe read-only commands that run silently (no permission, no output chrome)
    const ALWAYS_ALLOWED = new Set(['pwd', 'whoami', 'date', 'which', 'uname', 'hostname']);
    const isSilent = ALWAYS_ALLOWED.has(baseCmd);

    // Check permission — READ/WRITE share the same FilePermissions instance as
    // read_file / write_file / edit_file, so a grant in one covers the other.
    const checkPermitted = () => {
      if (cat === 'READ')  return getFilePermissions(agent).isAllowed(effectiveDir, 'read');
      if (cat === 'WRITE') return getFilePermissions(agent).isAllowed(effectiveDir, 'write');
      return _globalIndividualPerms.isAllowed(baseCmd, effectiveDir);
    };

    let permitted = isSilent || process.env.KOI_YES === '1' || checkPermitted();
    let reportDone;
    let descriptionShown = false;

    if (!permitted) {
      let answer;
      ({ answer, reportDone, descriptionShown } = await askPermission(command, baseCmd, description, agent?.name, checkPermitted));

      if (answer === 'always') {
        if (cat === 'READ')       getFilePermissions(agent).allow(effectiveDir, 'read');
        else if (cat === 'WRITE') getFilePermissions(agent).allow(effectiveDir, 'write');
        else                      _globalIndividualPerms.allow(baseCmd, '*'); // global — not directory-scoped
        permitted = true;
      } else if (answer === 'yes') {
        permitted = true;
      }
    }

    if (!permitted) {
      reportDone?.();
      cliLogger.print(`\x1b[2mSkipped\x1b[0m`);
      yield {
        success: false,
        denied: true,
        message: `User denied execution: ${description}`
      };
      return;
    }

    // Background launch: spawn detached, don't wait for completion.
    if (background) {
      const bgChild = spawn(USER_SHELL, _shellArgs(command), {
        cwd: cwd || process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'ignore', 'pipe'],  // pipe stderr to catch startup errors
        detached: true
      });

      // Collect stderr for error reporting (capped at 4KB)
      const bgStderr = [];
      let bgStderrBytes = 0;
      bgChild.stderr.on('data', (chunk) => {
        if (bgStderrBytes < 4096) {
          bgStderr.push(chunk);
          bgStderrBytes += chunk.length;
        }
      });

      // Notify when the background process exits
      bgChild.on('close', (code) => {
        const stderrStr = Buffer.concat(bgStderr).toString().trim();
        cliLogger.log('background', `PID ${bgChild.pid} exited code=${code ?? 'signal'} cmd="${cmdPreview}"`);
        if (code === null) return; // killed by signal (intentional Ctrl+C etc.) — ignore

        // Clear the "background · PID" from the progress bar
        cliLogger.clearProgress();

        if (code !== 0) {
          // Crashed: show error + stderr indented below
          if (stderrStr) {
            cliLogger.printCompact(`\x1b[31m↗  ${cmdPreview} (crashed · code ${code})\x1b[0m`);
            const dimmedStderr = stderrStr
              .split('\n')
              .map(line => `\x1b[2m   ${line}\x1b[0m`)
              .join('\n');
            cliLogger.print(dimmedStderr);
          } else {
            cliLogger.print(`\x1b[31m↗  ${cmdPreview} (crashed · code ${code})\x1b[0m`);
          }
          _bgNotify?.(`[System notification] Background process crashed: "${cmdPreview}" exited with code ${code}.${stderrStr ? ` Error output:\n${stderrStr}` : ''} Please handle this.`);
        } else {
          // Finished cleanly — replaces the progress bar PID line with a ✓ in scroll
          cliLogger.print(`\x1b[2m✓  ${cmdPreview} (finished)\x1b[0m`);
        }
      });

      bgChild.unref();
      reportDone?.();
      if (!isSilent) {
        cliLogger.printCompact(description);
        // Show PID in progress bar (replaceable) instead of scroll (permanent)
        cliLogger.progress(`\x1b[2m↗  ${cmdPreview} (background · PID ${bgChild.pid})\x1b[0m`);
      }
      yield { success: true, background: true, pid: bgChild.pid };
      return;
    }

    // Load node-pty lazily (no-op if already loaded or unavailable).
    await _loadPty();

    // Capture abort signal NOW (before any await) so we have a reference
    // even after uiBridge nulls the controller on Ctrl+C.
    const abortSignal = agent?.constructor?._cliHooks?.getAbortSignal?.() ?? null;

    const startTime = Date.now();
    let timerInterval = null;

    const _fmtElapsed = (ms) => {
      const s = Math.floor(ms / 1000);
      return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    };

    if (!isSilent) {
      cliLogger.progress(`\x1b[2m→  ${cmdPreview} (running for 0s)\x1b[0m`);
      timerInterval = setInterval(() => {
        const elapsed = _fmtElapsed(Date.now() - startTime);
        // Show description in the progress bar after 2s so the user sees
        // what's happening for long-running commands.
        if (!descriptionShown && Date.now() - startTime >= 2000) {
          cliLogger.printCompact(description);
          descriptionShown = true;
        }
        cliLogger.progress(`\x1b[2m→  ${cmdPreview} (running for ${elapsed})\x1b[0m`);
      }, 1000);
    }

    // State for generator coordination
    let isClosed = false;
    let closeCode = null;
    let closeError = null;
    let _wakeUp = null;
    const _notify = () => { const fn = _wakeUp; _wakeUp = null; fn?.(); };

    // Unified output chunks — with PTY stdout+stderr are merged (as in a real terminal).
    const outputChunks = [];
    const stderrChunks = []; // only populated in spawn fallback

    _shellOutputCallback?.(null); // signal: new command, reset log buffer

    let _passwordPending = false;
    let _inputNeededInfo = null; // Set by _scheduleDetect; consumed by the generator loop.

    // Fast-path password detection: matches sudo/ssh/git prompts like:
    //   "[sudo] password for user:"  "Password:"  "Enter passphrase for key '...':"
    // Fires _passwordPromptCallback immediately — no 10s wait, no LLM round-trip.
    const PASSWORD_PROMPT_RE = /(?:(?:\[sudo\]\s+)?password(?:\s+for\s+\S+)?|passphrase(?:\s+for\s+key\s+'\S+')?)\s*:\s*$/im;

    function _checkPasswordPrompt(text) {
      if (_passwordPending || !_passwordPromptCallback) return false;
      const m = text.match(PASSWORD_PROMPT_RE);
      if (!m) return false;
      _passwordPending = true;
      clearTimeout(_detectTimer); _detectTimer = null;
      _passwordPromptCallback(m[0].trim()).then(pwd => {
        _passwordPending = false;
        if (pwd != null && !isClosed) proc.writeStdin(pwd + '\n');
      }).catch(() => { _passwordPending = false; });
      return true;
    }

    // Interactive prompt pattern detection: fires _inputNeeded immediately
    // when the output matches common interactive prompt patterns, without
    // waiting for the 10-second silence timeout. This catches tools like
    // drizzle-kit, inquirer, prompts, etc. that may keep emitting spinner
    // frames or cursor codes while waiting for user input.
    //
    // Patterns detected:
    //   ? Question text (y/N)       — inquirer/prompts yes/no
    //   ? Question text › ...       — prompts select
    //   ❯ Option                    — inquirer list/select (arrow menu)
    //   > Option / ● Option         — alternative menu indicators
    //   (Y/n) / (y/N) at end        — generic yes/no confirmation
    //   ~ Rename X / + Create X     — drizzle-kit enum prompts
    //   Is X renamed from Y? (yes/no) — drizzle-kit specific
    const INTERACTIVE_PROMPT_RE = /(?:^\s*\?\s+.+\s*(?:\(y\/n\)|›|\(yes\/no\))|(?:^\s*[❯>●]\s+)|(?:\(Y\/n\)|\(y\/N\)|\(yes\/no\))\s*$|^\s*[~+]\s+\w+.*(?:rename|create))/im;
    let _interactivePromptDebounce = null;

    function _checkInteractivePrompt(text) {
      if (_passwordPending || _inputNeededInfo || isClosed) return;
      // Only check the last few lines of the new chunk
      const lastLines = text.split('\n').slice(-5).join('\n');
      if (!INTERACTIVE_PROMPT_RE.test(lastLines)) return;
      // Debounce: wait 1s after detecting the pattern to let the tool finish
      // rendering its prompt before we snapshot the output for the agent.
      if (_interactivePromptDebounce) clearTimeout(_interactivePromptDebounce);
      _interactivePromptDebounce = setTimeout(() => {
        _interactivePromptDebounce = null;
        if (isClosed || _passwordPending || _inputNeededInfo) return;
        const allOutput = Buffer.concat(outputChunks).toString();
        const promptLines = allOutput.split('\n').slice(-30).join('\n');
        _inputNeededInfo = { promptContext: promptLines };
        clearTimeout(_detectTimer); _detectTimer = null;
        _notify(); // Wake the generator immediately
      }, 1000);
    }

    // proc is assigned below in the PTY/spawn branches. Declared here so
    // the finally block and the timeout can reference it after assignment.
    let proc;
    let timeout;
    let ptyProc = null;
    let child = null;

    // Use node-pty if available and a semaphore slot is free; otherwise fall
    // back to plain spawn() (output may be buffered by non-TTY-aware programs).
    const usePty = _pty && _tryAcquirePty();

    // Data-driven yield: wake up the generator ~2 s after new data arrives so
    // the model sees incremental output without waiting the full stream_interval.
    let _dataWakeupTimer = null;
    const _scheduleDataWakeup = () => {
      if (_dataWakeupTimer || isClosed) return;
      _dataWakeupTimer = setTimeout(() => {
        _dataWakeupTimer = null;
        _notify();
      }, 2000);
    };

    // Interactive prompt detector: fires 10 s after the last data chunk if the
    // process has gone silent. Instead of calling a standalone context-free LLM,
    // we signal the generator to yield { _inputNeeded: true } so the running
    // agent (which has full task context) can decide what value to enter.
    let _detectTimer = null;
    const _scheduleDetect = () => {
      if (_detectTimer) clearTimeout(_detectTimer);
      _detectTimer = setTimeout(() => {
        _detectTimer = null;
        if (isClosed || _passwordPending) return;
        const lastLines = Buffer.concat(outputChunks).toString().split('\n').slice(-20).join('\n');
        // Signal the generator: process may be waiting for input.
        // _passwordPending prevents re-triggering while the agent is deciding.
        _inputNeededInfo = { promptContext: lastLines };
        _notify(); // Wake the generator so it yields _inputNeeded to the agent.
      }, 10000);
    };

    // Helper: wire up the 'close' and 'error' events shared by both spawn paths.
    const _onClose = (code) => {
      clearTimeout(timeout);
      clearTimeout(_dataWakeupTimer); _dataWakeupTimer = null;
      clearTimeout(_detectTimer); _detectTimer = null;
      if (_interactivePromptDebounce) { clearTimeout(_interactivePromptDebounce); _interactivePromptDebounce = null; }
      if (timerInterval) clearInterval(timerInterval);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      if (!isSilent) cliLogger.clearProgress();
      isClosed = true;
      closeCode = code;
      _notify();
    };
    const _onError = (err) => {
      clearTimeout(timeout);
      clearTimeout(_dataWakeupTimer); _dataWakeupTimer = null;
      clearTimeout(_detectTimer); _detectTimer = null;
      if (_interactivePromptDebounce) { clearTimeout(_interactivePromptDebounce); _interactivePromptDebounce = null; }
      if (timerInterval) clearInterval(timerInterval);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      if (!isSilent) cliLogger.clearProgress();
      isClosed = true;
      closeCode = 1;
      closeError = err;
      _notify();
    };
    if (usePty) {
      // ── PTY path: node-pty (all platforms) ────────────────────────────────
      ptyProc = _pty.spawn(USER_SHELL, _shellArgs(command), {
        name: 'xterm-256color',
        cols: 220,
        rows: 50,
        cwd: cwd || process.cwd(),
        env: { ...process.env },
      });

      proc = {
        kill: () => ptyProc.kill(),
        writeStdin: (data) => ptyProc.write(data),
      };

      ptyProc.onData((data) => {
        outputChunks.push(Buffer.from(data));
        _shellOutputCallback?.(data);
        const dataStr = Buffer.from(data).toString();
        if (!_checkPasswordPrompt(dataStr)) {
          _checkInteractivePrompt(dataStr);
          _scheduleDataWakeup();
          _scheduleDetect();
        }
      });

      ptyProc.onExit(({ exitCode }) => {
        _releasePty();
        _onClose(exitCode);
      });

    } else {
      // ── Plain spawn fallback ───────────────────────────────────────────────
      // node-pty unavailable or semaphore limit reached.
      // Output may be buffered for programs that check isatty().
      child = spawn(USER_SHELL, _shellArgs(command), {
        cwd: cwd || process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc = {
        kill: () => child.kill('SIGTERM'),
        writeStdin: (data) => { if (!child.stdin.destroyed) child.stdin.write(data); },
      };

      child.stdout.on('data', (data) => {
        outputChunks.push(data);
        const str = data.toString();
        _shellOutputCallback?.(str);
        if (!_checkPasswordPrompt(str)) {
          _checkInteractivePrompt(str);
          _scheduleDataWakeup();
          _scheduleDetect();
        }
      });

      child.stderr.on('data', (data) => {
        outputChunks.push(data);
        stderrChunks.push(data);
        const str = data.toString();
        _shellOutputCallback?.(str);
        if (!_checkPasswordPrompt(str)) {
          _checkInteractivePrompt(str);
          _scheduleDataWakeup();
          _scheduleDetect();
        }
      });

      child.on('close', _onClose);
      child.on('error', _onError);
    }

    // Kick off the interactive-prompt detector immediately so that commands
    // producing zero output (e.g. `sudo` writing "Password:" to /dev/tty,
    // not stdout/stderr) are still detected after 10 s of silence.
    _scheduleDetect();

    // Timeout and abort handler are set up AFTER proc is assigned above.
    timeout = setTimeout(() => proc.kill(), timeoutMs);
    const onAbort = () => proc.kill();
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

    try {
      // Yield progress snapshots at stream_interval while process runs.
      // Each yield gives the agent a window to inspect streaming output.
      //
      // Two special yield types:
      //   _inputNeeded: true  — process went silent; agent must decide what to enter.
      //                         The caller (agent.js) passes the answer back via iter.next(answer).
      //   (normal)            — periodic streaming snapshot for agent context.
      while (!isClosed) {
        await new Promise(r => { _wakeUp = r; setTimeout(r, stream_interval); });
        if (!isClosed) {
          const outputSoFar = Buffer.concat(outputChunks).toString();
          const elapsed = Math.floor((Date.now() - startTime) / 1000);

          if (_inputNeededInfo && !isClosed) {
            const info = _inputNeededInfo;
            _inputNeededInfo = null;
            // Block re-triggering while the agent is deciding.
            _passwordPending = true;
            // Two-way yield: agent.js passes the answer back via iter.next(answer).
            const agentAnswer = yield {
              _isProgress: true,
              _inputNeeded: true,
              promptContext: info.promptContext,
              output_so_far: outputSoFar,
              elapsed,
              command: cmdPreview
            };
            _passwordPending = false;
            _inputNeededInfo = null;
            if (agentAnswer != null && !isClosed && proc) {
              cliLogger.log('shell', `[agent-input] writing answer to stdin`);
              // If answer is just "\n" (Enter for menu selection), don't add extra newline
              const _stdinData = agentAnswer.endsWith('\n') ? agentAnswer : agentAnswer + '\n';
              proc.writeStdin(_stdinData);

              // After writing auto-input, check if the process responds.
              // If it stays silent for 8s, the input likely didn't work (e.g. interactive
              // menu that requires a real TTY). Kill the process and report the failure.
              const _outputLenBefore = Buffer.concat(outputChunks).length;
              await new Promise(r => setTimeout(r, 8000));
              if (!isClosed) {
                const _outputLenAfter = Buffer.concat(outputChunks).length;
                if (_outputLenAfter === _outputLenBefore) {
                  cliLogger.log('shell', `[agent-input] process did not respond after auto-input — killing (likely needs interactive TTY)`);
                  proc.kill();
                  // Wait for close event
                  await new Promise(r => setTimeout(r, 500));
                }
              }
            }
          } else {
            yield {
              _isProgress: true,
              output_so_far: outputSoFar,
              elapsed,
              command: cmdPreview
            };
          }
        }
      }

      // Process finished — build and yield final result.
      // With PTY, stdout+stderr are merged in outputChunks. With spawn fallback,
      // stderrChunks has the stderr portion separately.
      const combinedStr = Buffer.concat(outputChunks).toString().trim();
      const stderrStr   = stderrChunks.length
        ? Buffer.concat(stderrChunks).toString().trim()
        : '';
      // For the result we report stdout as the combined output (PTY merges them),
      // and stderr only when running in spawn fallback mode.
      const stdoutStr = combinedStr;
      const elapsed = _fmtElapsed(Date.now() - startTime);

      if (closeError) {
        _shellOutputCallback?.(false);
        reportDone?.();
        yield { success: false, exitCode: 1, stdout: '', stderr: '', error: closeError.message };
      } else if (closeCode !== 0) {
        if (!isSilent) {
          if (!descriptionShown) cliLogger.printCompact(`${description}`);
          const errOut = stderrStr || combinedStr;
          if (errOut) {
            cliLogger.printCompact(`\x1b[31m✗  ${cmdPreview} (${elapsed})\x1b[0m`);
            const dimmed = errOut
              .split('\n')
              .map(line => `\x1b[2m   ${line}\x1b[0m`)
              .join('\n');
            cliLogger.print(dimmed);
          } else {
            cliLogger.print(`\x1b[31m✗  ${cmdPreview} (${elapsed})\x1b[0m`);
          }
        }
        _shellOutputCallback?.(false);
        reportDone?.();
        yield {
          success: false,
          exitCode: closeCode || 1,
          stdout: stdoutStr,
          stderr: stderrStr,
          error: stderrStr || combinedStr || `Command exited with code ${closeCode}`
        };
      } else {
        if (!isSilent) {
          if (!descriptionShown) cliLogger.printCompact(`${description}`);
          cliLogger.print(`\x1b[2m✓  ${cmdPreview} (${elapsed})\x1b[0m`);
        }
        _shellOutputCallback?.(false);
        reportDone?.();
        yield { success: true, exitCode: 0, stdout: stdoutStr, stderr: stderrStr };
      }
    } finally {
      // Clean up if the generator was aborted early (consumer broke out of for await).
      if (!isClosed) {
        if (usePty) _releasePty();
        clearTimeout(timeout);
        clearTimeout(_dataWakeupTimer);
        clearTimeout(_detectTimer);
        if (_interactivePromptDebounce) clearTimeout(_interactivePromptDebounce);
        if (timerInterval) clearInterval(timerInterval);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        if (!isSilent) cliLogger.clearProgress();
        proc.kill();
        if (ptyProc?.removeAllListeners) ptyProc.removeAllListeners();
        if (child) {
          child.stdout?.removeAllListeners();
          child.stderr?.removeAllListeners();
          child.removeAllListeners();
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
        _shellOutputCallback?.(false);
        reportDone?.();
      }
    }
  }
};
