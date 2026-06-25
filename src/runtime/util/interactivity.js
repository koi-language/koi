/**
 * Single source of truth for "the agent must never ask the user anything"
 * (non-interactive / autopilot / YOLO). TWO independent triggers feed the
 * SAME behavior so there is zero duplicated logic:
 *
 *   - KOI_EXIT_ON_COMPLETE — the legacy headless `--exit` one-shot mode
 *     (run with --prompt, do the task, exit). It bundles three things:
 *     never-ask + exit-the-process-on-complete + hide intermediate output.
 *
 *   - KOI_YOLO_MODE — the per-session GUI toggle. It reuses ONLY the
 *     "never ask, assume every answer" half via `isNonInteractive()`. It
 *     deliberately does NOT exit the engine or hide output (those stay gated
 *     on `isExitOnComplete()`), so a live chat tab keeps running and keeps
 *     showing results. Per-session because each GUI tab spawns its own engine
 *     process, so this env var is naturally scoped to one session.
 *
 * Every "should I prompt the user?" decision in the runtime must go through
 * `isNonInteractive()` — never read the raw env vars at the call site.
 */

/** Legacy headless one-shot mode (`--exit`): never-ask + exit + hide output. */
export function isExitOnComplete() {
  return process.env.KOI_EXIT_ON_COMPLETE === '1';
}

/** Per-session GUI autopilot toggle: never-ask only (engine stays alive). */
export function isYoloMode() {
  return process.env.KOI_YOLO_MODE === '1';
}

/**
 * True when the agent must not prompt the user — assume all answers and
 * proceed autonomously. This is the ONE predicate the prompt-suppression
 * code paths consult; both `--exit` and YOLO turn it on.
 */
export function isNonInteractive() {
  return isExitOnComplete() || isYoloMode();
}

/**
 * True when every permission gate (shell command, file write, media cost
 * consent) must auto-approve — treat the user as having said "yes" to all.
 *
 * `KOI_YES` (`--auto-accept`) is the explicit "yes to everything" flag. A
 * non-interactive run (YOLO or --exit) also implies it: there is no one to
 * ask, and YOLO's whole point is "never pause for permission". This is the
 * ONE predicate every permission short-circuit consults — don't read the raw
 * env at the call site.
 */
export function isAutoApprove() {
  return process.env.KOI_YES === '1' || isNonInteractive();
}

/**
 * Guard for tools whose ONLY purpose is to interact with a present user via the
 * chat — `prompt_form`, `prompt_files`, the `session_history` picker, and any
 * future sibling. They block on a `channel.form/files/select` call that NEVER
 * resolves in a headless `--exit` one-shot run: there is no UI to render into and
 * no user to respond, so the task hangs forever (the reported prompt_form bug).
 *
 * In `--exit` mode these tools are hidden from the agent (`hidden: () =>
 * isExitOnComplete()`); this guard is the execute-path backstop for when one is
 * invoked anyway. It returns a hard error result (so the call fails loudly and
 * the agent finishes with `return` explaining what input is missing) instead of
 * blocking. Returns `null` when interaction is allowed — call it at the top of
 * `execute` and early-return its value when non-null.
 *
 * Scoped to `isExitOnComplete()` ONLY, never the broader `isNonInteractive()`: a
 * live YOLO chat tab (and an interactive CLI) has a real user and a GUI that CAN
 * render the form/picker, so these tools must keep working there.
 */
export function blockedChatInteraction(toolName) {
  if (!isExitOnComplete()) return null;
  return {
    success: false,
    error: `${toolName} is unavailable in headless --exit (unattended) mode: no user is present to respond, so the call would hang forever. Do NOT retry this or any other interactive prompt. If you cannot proceed without the user, stop and call return() explaining exactly what input is missing.`,
  };
}

/**
 * Set/clear the per-session YOLO flag at runtime. All `isNonInteractive()`
 * call sites read `process.env` on each invocation, so flipping this takes
 * effect on the very next prompt/turn — no engine restart needed.
 */
export function setYoloMode(on) {
  if (on) process.env.KOI_YOLO_MODE = '1';
  else delete process.env.KOI_YOLO_MODE;
}
