/**
 * PlaybookSession - Tracks state for the reactive agentic loop.
 *
 * In reactive mode, the LLM decides ONE action per iteration,
 * receives feedback from the result, and adapts its strategy.
 * This class maintains the state across iterations.
 *
 * The loop runs indefinitely until the agent decides to terminate
 * via a "return" action, or consecutive errors exceed the threshold.
 */
export class PlaybookSession {
  constructor({ playbook, agentName } = {}) {
    this.playbook = playbook;
    this.agentName = agentName;

    // Iteration tracking
    this.iteration = 0;
    this.isTerminated = false;
    this.finalResult = null;

    // Action history: { action, result, error, timestamp, iteration }
    this.actionHistory = [];
    // Index into actionHistory up to which feedback has already been fed to the LLM.
    // Allows multiple actions executed between LLM calls (e.g. a batch of prompt_user)
    // to each be added as individual messages instead of only the last one.
    this._lastFeedbackIdx = 0;

    // Action context
    this.actionContext = {
      state: {},
      args: {}
    };

    // Error tracking
    this.lastError = null;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 10;

    // Error log: tracks past failures so the LLM doesn't retry actions
    // that already failed without fixing the underlying cause first.
    // Key: "intent:target" → { error, iteration }
    this._errorLog = new Map();
  }

  /**
   * Check if the loop can continue.
   * The loop only stops when the agent terminates or consecutive errors exceed threshold.
   */
  canContinue() {
    return (
      !this.isTerminated &&
      this.consecutiveErrors < this.maxConsecutiveErrors
    );
  }

  /**
   * Record an action and its result/error.
   */
  recordAction(action, result, error = null) {
    this.iteration++;

    const entry = {
      action,
      result: result || null,
      error: error ? { message: error.message || String(error) } : null,
      timestamp: Date.now(),
      iteration: this.iteration
    };

    this.actionHistory.push(entry);

    // Count both thrown errors AND result.success === false as consecutive errors.
    // User-denied actions with feedback are NOT errors — the user gave instructions.
    const isDeniedWithFeedback = !error && result && result.denied && result.feedback;
    const isResultError = !error && !isDeniedWithFeedback && result && result.success === false && result.error;
    const errorKey = this._errorKey(action);

    if (error || isResultError) {
      this.lastError = error || { message: result.error };
      this.consecutiveErrors++;

      // Log this failure so we can warn the LLM if it tries the same thing again
      const errorMsg = error ? (error.message || String(error)) : result.error;
      this._errorLog.set(errorKey, { error: errorMsg, iteration: this.iteration });
    } else {
      this.lastError = null;
      this.consecutiveErrors = 0;

      // This action+target succeeded — clear any previous failure for it
      this._errorLog.delete(errorKey);
    }
  }

  /**
   * Attempt to pivot out of a stuck state: reset error counters so the loop
   * can continue with a "try something completely different" instruction.
   * Returns true if the pivot is allowed, false if max pivots exhausted.
   */
  pivot() {
    this._pivotCount = (this._pivotCount || 0) + 1;
    if (this._pivotCount > 3) return false; // give up after 3 pivots
    this.consecutiveErrors = 0;
    this._repeatCount = 0;
    this._oscillateCount = 0;
    return true;
  }

  /**
   * Terminate the loop with a final result
   */
  terminate(result) {
    this.isTerminated = true;
    this.finalResult = result;
  }

  /**
   * Build feedback context for the next LLM iteration.
   * Kept MINIMAL to avoid context bloat — the LLM already has
   * the full conversation history with all previous actions/results.
   */
  buildFeedbackContext() {
    const parts = [];

    // Error feedback
    if (this.lastError) {
      const errorMsg = this.lastError.message || String(this.lastError);
      parts.push(`\u274c LAST ACTION FAILED: ${errorMsg}`);

      // Count recent MCP errors to suggest diagnostics
      const recentMcpErrors = this.actionHistory.slice(-5).filter(
        e => e.error && (e.action.intent === 'call_mcp' || e.action.type === 'call_mcp')
      ).length;

      if (recentMcpErrors >= 2) {
        parts.push('Multiple MCP failures detected. DIAGNOSE: check available tools on that MCP server for status/diagnostic tools and use them to understand the current state before retrying. The MCP server may have been restarted automatically.');
      }

      parts.push('NEVER give up. Try a DIFFERENT approach — do NOT repeat the same action that failed. Think about what went wrong and find an alternative path to achieve the goal.');
    }

    // Past unresolved failures — remind the LLM what already failed
    // Expire entries older than 10 iterations to avoid accumulation
    const ERROR_LOG_TTL = 10;
    for (const [key, entry] of this._errorLog) {
      if (this.iteration - entry.iteration > ERROR_LOG_TTL) {
        this._errorLog.delete(key);
      }
    }
    if (this._errorLog.size > 0) {
      const failures = [];
      for (const [key, { error }] of this._errorLog) {
        failures.push(`  • ${key} → ${error}`);
      }
      parts.push(`⚠️ PAST FAILURES (still unresolved — do NOT retry these without fixing the cause first):\n${failures.join('\n')}`);
    }

    // Recent action history summary — helps the LLM track progress and avoid loops.
    // Shows the last 5 actions with their results (condensed).
    // Especially critical for mobile navigation where the LLM does 20+ iterations
    // and older actions have already been compressed out of context.
    if (this.actionHistory.length > 1) {
      const HISTORY_WINDOW = 10;
      const recentActions = this.actionHistory.slice(-HISTORY_WINDOW, -1); // exclude last (shown separately below)
      if (recentActions.length > 0) {
        const total = this.actionHistory.length;
        const lines = recentActions.map((entry, i) => {
          const idx = total - recentActions.length + i;
          const intent = entry.action.intent || entry.action.type || '?';
          const args = this._formatActionArgs(entry.action);
          if (entry.error) {
            return `  ${idx}. ${intent}${args} → FAILED`;
          }
          const ok = entry.result?.success === false ? '→ FAILED' : '→ ok';
          return `  ${idx}. ${intent}${args} ${ok}`;
        });
        parts.push(`ACTIONS SO FAR (${total} total, last ${recentActions.length} shown):\n${lines.join('\n')}`);
      }
    }

    // Step counter
    parts.push(`STEP: ${this.iteration + 1}${this.maxIterations ? ` of ${this.maxIterations}` : ''}`);

    // Task reminder — always present so the agent never loses sight of its mission.
    const args = this.actionContext?.args;
    if (args && typeof args === 'object' && Object.keys(args).length > 0) {
      const taskLines = Object.entries(args)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v.substring(0, 500) : JSON.stringify(v).substring(0, 500)}`)
        .join('\n');
      parts.push(`📋 YOUR TASK:\n${taskLines}`);
    }

    // Loop detection warnings
    const warnings = this._detectLoops();
    for (const warning of warnings) {
      parts.push(`\u26a0\ufe0f ${warning}`);
    }

    // Last action result
    const lastEntry = this.actionHistory[this.actionHistory.length - 1];
    if (lastEntry && !lastEntry.error) {
      const intent = lastEntry.action.intent || lastEntry.action.type || 'unknown';
      const id = lastEntry.action.id ? ` [${lastEntry.action.id}]` : '';
      let resultStr = lastEntry.result ? JSON.stringify(lastEntry.result) : 'ok';
      // Actions where the LLM needs the FULL content to do its job correctly:
      //   - read_file: needs exact lines to write correct diffs
      //   - write_file: full content confirmation
      //   - web_fetch: needs the complete JSON/HTML to extract data
      // No truncation — results are passed to the LLM in full.

      // Detect when user denied an action with feedback (e.g. edit_file "No, but..." option).
      // User feedback is SACRED — it represents explicit user constraints for the next attempt.
      if (lastEntry.result && lastEntry.result.denied && lastEntry.result.feedback) {
        parts.push(`\u26d4${id} ${intent} was REJECTED by the user with feedback:\n"${lastEntry.result.feedback}"\n\nYou MUST incorporate this feedback into your next attempt. Do NOT repeat the same approach. The user's feedback overrides any previous plan or instruction.`);
      }
      // Detect when result payload indicates failure (e.g. MCP returns {success: false, error: "..."})
      else if (lastEntry.result && lastEntry.result.success === false && lastEntry.result.error) {
        const errorMsg = lastEntry.result.error;
        parts.push(`\u274c${id} ${intent} returned an error: ${errorMsg}`);

        // Include actionable fix instructions if the action provided them
        if (lastEntry.result.fix) {
          parts.push(`HOW TO FIX:\n${lastEntry.result.fix}`);
        }

        // Include stdout if present — many CLI tools (flutter analyze, tsc, cargo, etc.)
        // write their useful output to stdout even when exiting with a non-zero code.
        if (lastEntry.result.stdout) {
          parts.push(`Command output (stdout):\n${lastEntry.result.stdout.substring(0, 3000)}`);
        }

        // Include MCP server output (stderr) if available — this often contains
        // the actual installation commands or detailed error info
        if (lastEntry.result.serverOutput) {
          parts.push(`Server output:\n${lastEntry.result.serverOutput}`);
        }

        // Check if server output contains actual installation commands
        const serverOutput = lastEntry.result.serverOutput || '';
        const hasInstallCommands = /\b(brew\s+install|pip\s+install|npm\s+install|apt\s+install|apt-get\s+install)\b/i.test(serverOutput);

        // Check if this SAME error appeared before in history (fix attempt didn't work)
        const sameErrorBefore = this.actionHistory.slice(0, -1).some(
          e => e.result && e.result.success === false && e.result.error === errorMsg
        );

        if (lastEntry.result.fix) {
          // Action already provided fix instructions, don't override with generic advice
        } else if (sameErrorBefore) {
          parts.push('WARNING: This is the SAME error as before — your previous fix did NOT solve it. If you have already tried everything mentioned, inform the user and return with an error.');
        } else if (hasInstallCommands) {
          parts.push('APPLY RULE 8: Read the server output above. Use "shell" to run the EXACT commands listed there — ALL of them in a SINGLE shell command chained with && (e.g. "brew tap X && brew install Y && pip install Z"). IMPORTANT: The shell "description" field must express NEED, not action (e.g. "Need to install X, Y, and Z because the MCP server requires IDB for iOS Simulator control" — NOT "Installing X..."). Then RETRY the failed action.');
          parts.push('SHELL RULES: NEVER use placeholder values like <your_api_key> or <TOKEN> in commands — they cause syntax errors. NEVER try to set/export API keys — they are already in the environment. ONLY install what the server output explicitly lists.');
        } else {
          parts.push('This is a configuration or environment error (e.g. missing API key, wrong path). Do NOT try to install anything. Inform the user what is wrong and return with an error explaining how to fix it.');
        }
      } else {
        parts.push(`\u2705${id} ${intent} -> ${resultStr}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Format a compact description of an action's arguments for the history summary.
   * e.g. mobile_tap → '(element="Settings")', shell → '("ls -la")', read_file → '("src/index.js")'
   */
  _formatActionArgs(action) {
    const a = action;
    // Mobile actions
    if (a.element) return `(element="${a.element}")`;
    if (a.cell) return `(cell="${a.cell}")`;
    if (a.direction) return `(direction="${a.direction}")`;
    if (a.startCell && a.endCell) return `(${a.startCell}→${a.endCell})`;
    if (a.text) return `(text="${a.text.length > 30 ? a.text.substring(0, 30) + '…' : a.text}")`;
    if (a.key) return `(key="${a.key}")`;
    // File/shell actions
    if (a.path) return `("${a.path}")`;
    if (a.file) return `("${a.file}")`;
    if (a.command) return `("${a.command.length > 40 ? a.command.substring(0, 40) + '…' : a.command}")`;
    if (a.query) return `("${a.query}")`;
    if (a.pattern) return `("${a.pattern}")`;
    // Delegate
    if (a.data?.description) return `("${a.data.description.substring(0, 40)}…")`;
    return '';
  }

  /**
   * Broad key for the error log: "intent:target".
   * Intentionally coarse — catches the same type of action on the same file/command
   * even if other parameters differ slightly.
   */
  _errorKey(action) {
    const intent = action.intent || action.type || '';
    const target = action.path || action.file || action.command || '';
    return `${intent}:${target}`;
  }

  /**
   * Build a stable key for an action that includes all identifying fields.
   */
  _actionKey(action) {
    return JSON.stringify({
      intent:  action.intent  ?? action.type ?? null,
      tool:    action.tool    ?? null,
      path:    action.path    ?? null,
      file:    action.file    ?? null,
      key:     action.key     ?? null,
      query:   action.query   ?? null,
      pattern: action.pattern ?? null,
      command: action.command ?? null,
      data:    action.data    ?? null,
      input:   action.input   ?? null,
    });
  }

  /**
   * Detect loop patterns in action history. Returns warnings.
   */
  _detectLoops() {
    const warnings = [];
    const history = this.actionHistory;

    if (history.length < 2) return warnings;

    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    const lastKey = this._actionKey(last.action);
    const prevKey = this._actionKey(prev.action);

    // Same action repeated consecutively
    if (lastKey === prevKey) {
      this._repeatCount = (this._repeatCount || 0) + 1;
      if (this._repeatCount >= 5) {
        // LLM is ignoring warnings — force terminate
        this.consecutiveErrors = this.maxConsecutiveErrors;
        warnings.push('FORCED STOP: Same action repeated 5+ times. You are stuck in a loop.');
      } else {
        warnings.push('You repeated the exact same action. Stop and try a completely different approach!');
      }
    } else {
      this._repeatCount = 0;
    }

    // Consecutive errors
    if (this.consecutiveErrors >= 2) {
      warnings.push(`${this.consecutiveErrors} consecutive errors. Try a completely different approach!`);
    }

    // Oscillating pattern A-B-A-B
    if (history.length >= 4) {
      const h = history.slice(-4);
      const keys = h.map(e => this._actionKey(e.action));
      if (keys[0] === keys[2] && keys[1] === keys[3] && keys[0] !== keys[1]) {
        this._oscillateCount = (this._oscillateCount || 0) + 1;
        const intent0 = h[0].action.tool || h[0].action.intent || h[0].action.type;
        const intent1 = h[1].action.tool || h[1].action.intent || h[1].action.type;
        if (this._oscillateCount >= 3) {
          // Force terminate — LLM is ignoring oscillation warnings
          this.consecutiveErrors = this.maxConsecutiveErrors;
          warnings.push(`FORCED STOP: Oscillating pattern (${intent0} <-> ${intent1}) repeated ${this._oscillateCount} times.`);
        } else {
          warnings.push(`Oscillating pattern detected (${intent0} <-> ${intent1}). Break the cycle — do something different!`);
        }
      } else {
        this._oscillateCount = 0;
      }
    }

    // Circular exploration: re-reading the same files repeatedly
    const lastAction = history[history.length - 1].action;
    const lastIntent = lastAction.intent || lastAction.type;
    if (lastIntent === 'read_file' || lastIntent === 'grep' || lastIntent === 'search') {
      const target = lastAction.path || lastAction.file || '';
      if (target) {
        if (!this._fileReadCounts) this._fileReadCounts = {};
        this._fileReadCounts[target] = (this._fileReadCounts[target] || 0) + 1;
        if (this._fileReadCounts[target] >= 6) {
          this.consecutiveErrors = this.maxConsecutiveErrors;
          warnings.push(`FORCED STOP: You have read/searched "${target}" ${this._fileReadCounts[target]} times. You are stuck re-exploring the same files.`);
        } else if (this._fileReadCounts[target] >= 4) {
          warnings.push(`WARNING: You have read/searched "${target}" ${this._fileReadCounts[target]} times. If you need this file, read it ENTIRELY in one shot: read_file(path:"${target}") with NO offset/limit. Then synthesize and move on — do NOT read it again.`);
        }
      }
    }

    return warnings;
  }

}
