/**
 * THE single global serial queue for EVERY user-facing permission /
 * confirmation dialog — file write/edit, shell commands, AND media-cost
 * confirmation. There must be exactly ONE such queue process-wide.
 *
 * Why: the GUI (and the Ink terminal) can only surface ONE permission card at
 * a time. If two dialogs are requested concurrently — e.g. a parallel batch
 * where one worker wants to write a file while another wants to generate an
 * image — the second `channel.select` overwrites/loses the first's resolver,
 * so one promise never settles and that worker hangs forever (the live
 * "1 of N runs, the rest stay blocked" deadlock). Per-feature queues (one for
 * files, one for shell, one for media) each prevent SAME-type overlap but do
 * NOTHING for CROSS-type overlap — which is still a deadlock. Hence a single
 * shared queue: prompts are shown strictly one at a time, whatever asked.
 *
 * Usage:
 *   const value = await runPermissionDialog(() => channel.select(...));
 */

let _tail = Promise.resolve();

/**
 * Run `fn` (an async dialog) serially with respect to ALL other permission
 * dialogs. Returns fn's promise. An error in fn propagates to the caller but
 * never breaks the chain for subsequent waiters.
 */
export function runPermissionDialog(fn) {
  const result = _tail.then(() => fn());
  _tail = result.then(() => {}, () => {});
  return result;
}
