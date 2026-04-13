/**
 * Shared quota-exceeded dialog — renders the "no credits" options that the
 * backend returns inside a 402 body, letting the user subscribe, paste API
 * keys, log out, or exit.
 *
 * Historically this logic lived only inside the prompt_user tool, because the
 * backend used to inject a synthetic prompt_user action via SSE. Now the
 * backend returns a proper 402 JSON body; we parse it at the fetch boundary
 * and call this helper directly from any catch site that wants to surface
 * the dialog (e.g. when indexing fails mid-batch).
 *
 * Both paths go through this single helper so the UX is identical.
 */

import { channel } from '../io/channel.js';

/**
 * Show the quota-exceeded interactive menu. Accepts either a
 * QuotaExceededError or a plain `{ message, options }` object.
 *
 * Returns after the selected action has been dispatched. `exit` and `logout`
 * terminate the process from within this function, matching the legacy
 * prompt_user behaviour.
 */
export async function showQuotaExceededDialog(errOrPayload) {
  const payload = errOrPayload || {};
  const message = payload.message || 'You have no credits left.';
  const options = Array.isArray(payload.options) ? payload.options : [];

  channel.clearProgress();

  if (options.length === 0) {
    // No actionable options — just surface the message so the user sees why
    // their request was blocked.
    channel.print(channel.renderMarkdown(message));
    return;
  }

  const labels = options.map(o => o.label);
  const selected = await channel.select(
    message,
    labels.map((l, i) => ({ title: l, value: i })),
    0,
  );
  const chosen = options[selected ?? 0];
  if (!chosen) return;

  if (chosen.action === 'open_url' && chosen.url) {
    try {
      const { exec } = await import('child_process');
      const cmd = process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} "${chosen.url}"`);
    } catch {}
  } else if (chosen.action === 'print') {
    channel.print(channel.renderMarkdown(chosen.text || ''));
  } else if (chosen.action === 'show_api_keys_prompt') {
    const isGui = process.env.KOI_GUI_MODE === '1';
    if (isGui && typeof channel.showWelcomeApiKeysPrompt === 'function') {
      channel.showWelcomeApiKeysPrompt();
    } else if (chosen.text) {
      channel.print(channel.renderMarkdown(chosen.text));
    }
  } else if (chosen.action === 'logout') {
    try {
      const os = await import('os');
      const path = await import('path');
      const fs = await import('fs');
      fs.unlinkSync(path.join(os.homedir(), '.koi', '.token'));
    } catch {}
    // GUI mode: broadcast to Flutter so it shows the welcome dialog and the
    // engine stays alive. Terminal mode: exit so the user can relaunch with
    // different credentials.
    try {
      const { Agent } = await import('../agent/agent.js');
      const handled = await Agent?._cliHooks?.onLogoutRequested?.('user');
      if (handled) return;
    } catch { /* fall through to exit */ }
    channel.print('Logged out. Please restart koi-cli to log in with a different account.');
    process.exit(0);
  } else if (chosen.action === 'exit') {
    process.exit(0);
  }
}
