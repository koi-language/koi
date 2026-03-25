/**
 * Agenda Watch Action — Set up a periodic condition check.
 *
 * Creates a watcher that periodically wakes the agent to check if a condition
 * is met. The agent receives instructions on what to check, executes the check,
 * and decides whether to notify the user.
 *
 * When the condition is met, the agent should call agenda_update with status='completed'.
 * If maxAttempts is reached without the condition being met, the watch is cancelled
 * and the user is informed.
 */

import { agendaManager } from '../../state/agenda-manager.js';

export default {
  type: 'agenda_watch',
  intent: 'agenda_watch',
  description: 'Watch for a condition by periodically checking it. The agent is woken up at each interval to verify if the condition is met. Fields: "title" (what to watch for), "checkInstructions" (detailed instructions: what command to run, what URL to check, what file to read, what condition means "done"), "interval" (cron expression for check frequency, default: "*/2 * * * *" = every 2 min), "maxAttempts" (max checks before giving up, default: 60, 0 = unlimited). → Returns: { id, title, interval, maxAttempts, status }',
  thinkingHint: 'Setting up watcher',
  permission: 'agenda',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short description of what to watch for (e.g. "Deploy completed", "PR merged", "Tests passing")',
      },
      checkInstructions: {
        type: 'string',
        description: 'Detailed instructions for the agent on what to check and how to determine if the condition is met. Be specific: what command to run, what output to look for, what URL to fetch, etc. Example: "Run `gh run view 12345 --json status -q .status` and check if the result is \'completed\'. If completed, also check the conclusion field to see if it succeeded or failed."',
      },
      interval: {
        type: 'string',
        description: 'Cron expression for how often to check. Default: "*/2 * * * *" (every 2 minutes). Examples: "*/1 * * * *" (every minute), "*/5 * * * *" (every 5 min), "*/30 * * * *" (every 30 min)',
      },
      maxAttempts: {
        type: 'number',
        description: 'Maximum number of checks before giving up. Default: 60. Set to 0 for unlimited.',
      },
    },
    required: ['title', 'checkInstructions'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'agenda_watch',
      title: 'GitHub Actions workflow completed',
      checkInstructions: 'Run `gh run view 12345 --json status,conclusion -q \'.status + " " + .conclusion\'`. If status is "completed", inform the user whether it succeeded or failed.',
      interval: '*/2 * * * *',
      maxAttempts: 30,
    },
    {
      actionType: 'direct',
      intent: 'agenda_watch',
      title: 'PR #42 merged',
      checkInstructions: 'Run `gh pr view 42 --json state -q .state`. If state is "MERGED", inform the user. If state is "CLOSED", inform the user it was closed without merging and stop watching.',
      interval: '*/5 * * * *',
      maxAttempts: 0,
    },
    {
      actionType: 'direct',
      intent: 'agenda_watch',
      title: 'Staging API healthy',
      checkInstructions: 'Run `curl -s -o /dev/null -w "%{http_code}" https://staging.example.com/health`. If the HTTP status is 200, the API is up — inform the user.',
      interval: '*/1 * * * *',
      maxAttempts: 20,
    },
  ],

  async execute(action, agent) {
    const { title, checkInstructions, interval, maxAttempts } = action;

    if (!title || !checkInstructions) {
      return { success: false, error: 'agenda_watch: "title" and "checkInstructions" are required' };
    }

    try {
      const entry = agendaManager.addWatch({
        title,
        checkInstructions,
        interval: interval || '*/2 * * * *',
        maxAttempts: maxAttempts != null ? maxAttempts : 60,
        agentName: agent?.name || 'unknown',
      });

      return {
        success: true,
        id: entry.id,
        title: entry.title,
        interval: entry.cron,
        maxAttempts: entry.maxAttempts,
        status: entry.status,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
