/**
 * Message Classifier — classifies incoming inbox messages for an agent.
 *
 * Given a message and the agent's current WorkQueue, this module calls a
 * cheap LLM (via TaskClassifier.runCheapJsonCompletion) and decides:
 *
 *   - kind === 'new_task'     → enqueue as a fresh WorkQueue item
 *   - kind === 'modify_task'  → rewrite an existing WorkQueue item
 *                               (targetTaskId, rewrittenTask)
 *   - kind === 'noop'         → conversational / irrelevant — inject as
 *                               context note, no task action
 *
 * When the classifier chooses `modify_task` on an in-progress task, the
 * agent's main loop is responsible for broadcasting the message to any
 * active delegate that is working on that task (see agent.js drain hook).
 *
 * The classifier itself only makes the decision — it does NOT mutate the
 * WorkQueue. Mutation happens in the agent's main-loop drain step so we
 * can also update the UI, push to delegates, etc., in one place.
 */

import { channel } from './../io/channel.js';

/**
 * Classify an inbox message.
 *
 * For messages from the user, the classifier also detects the message
 * language (e.g. "Spanish", "English", "French") and returns it in the
 * result so the agent can natively update `state.userLanguage` before
 * the next LLM iteration. The LLM is never asked to set the language
 * itself — the "ear" does it automatically.
 *
 * @param {import('../agent/agent.js').Agent} agent
 * @param {import('../agent/message-inbox.js').InboxMessage} message
 * @returns {Promise<import('../agent/message-inbox.js').ClassifierResult>}
 */
export async function classifyInboxMessage(agent, message) {
  // If the message was broadcast from a parent agent as a task modification,
  // we skip re-classification — the parent already decided. Inject as noop
  // (the main loop will still surface it in context memory).
  if (message.parentTaskId) {
    return {
      kind: 'noop',
      reasoning: 'broadcast from parent — already classified upstream',
      parentTaskId: message.parentTaskId,
    };
  }

  // STRICT: only an explicit `from === 'user'` counts as a user message.
  // Agent-to-agent broadcasts (where `from` is an agent name) must never
  // trigger language detection or affect the agent's active language.
  const isFromUser = message.from === 'user';

  // Lazy access to the LLM provider — agent may still be starting up.
  const llmProvider = agent.llmProvider;
  if (!llmProvider || typeof llmProvider._getClassifier !== 'function') {
    channel.log('inbox', `${agent.name}: llmProvider not ready — defaulting to new_task`);
    return _defaultNewTask(message);
  }

  let classifier;
  try {
    classifier = llmProvider._getClassifier();
  } catch (err) {
    channel.log('inbox', `${agent.name}: classifier unavailable (${err.message}) — defaulting to new_task`);
    return _defaultNewTask(message);
  }

  // Snapshot the current WorkQueue for the classifier prompt.
  const queue = agent.workQueue || (await agent.ensureWorkQueue?.());
  const items = queue ? queue.list() : [];
  const activeItems = items.filter(i => i.status === 'pending' || i.status === 'in_progress');

  // If the queue is empty and the message is from a non-user (agent
  // broadcast), we skip the LLM call — it's always a new task. For user
  // messages we still call the LLM so it can detect the language.
  if (activeItems.length === 0 && !isFromUser) {
    return _defaultNewTask(message);
  }

  const queueSnippet = activeItems.length > 0
    ? activeItems.map(i => {
        const desc = (i.description || '').substring(0, 300);
        return `#${i.id} [${i.status}] ${i.subject}${desc ? '\n    ' + desc.replace(/\n/g, ' ') : ''}`;
      }).join('\n')
    : '(empty)';

  const languageInstruction = isFromUser
    ? `\nAdditionally, detect the natural language the user wrote this message in, and return its English name in the "language" field (e.g. "Spanish", "English", "French", "German", "Portuguese", "Italian", "Japanese"). If the message is too short or language-neutral (single emoji, code snippet only), return null.`
    : '\nThe message is from another agent, not the user — do not set "language".';

  const prompt = `You are a message router for an AI agent. The agent has a queue of work items. A new message just arrived. Decide ONE of:

1. "new_task"    — the message is a request for something NEW that is unrelated to the queue.
2. "modify_task" — the message amends, corrects, cancels, or adds detail to an existing queue item.
3. "noop"        — the message is conversational / acknowledgement / thanks / greeting with no actionable work.

When picking "modify_task", also pick which queue item (by id) and rewrite it (subject + description + activeForm) so it reflects the combined intent of the original task PLUS the new message. The activeForm should be in present continuous tense (e.g., "Implementing the login flow").

IMPORTANT: When in doubt between "new_task" and "modify_task", prefer "modify_task" only if there is clear thematic overlap. Unrelated topics should be "new_task".
${languageInstruction}

CURRENT QUEUE:
${queueSnippet}

NEW MESSAGE (from ${message.from}):
${message.text}

Respond with ONLY a single JSON object (no prose, no markdown) of the form:
{
  "kind": "new_task" | "modify_task" | "noop",
  "targetTaskId": "<id>" | null,
  "rewrittenTask": { "subject": "...", "description": "...", "activeForm": "..." } | null,
  "language": "<language name in English>" | null,
  "reasoning": "<short reason, <= 120 chars>"
}`;

  const json = await classifier.runCheapJsonCompletion(prompt, {
    // 30s timeout — matches the skill classifier. Gateway classifier
    // models can be slow on cold starts; aborting at 8s produced empty
    // classifications and cascading errors.
    timeoutMs: 30000,
    maxTokens: 800,
    label: 'inbox-classify',
  });

  if (!json || typeof json !== 'object') {
    channel.log('inbox', `${agent.name}: classifier returned no JSON — defaulting to new_task`);
    return _defaultNewTask(message);
  }

  const kind = json.kind;
  if (kind !== 'new_task' && kind !== 'modify_task' && kind !== 'noop') {
    channel.log('inbox', `${agent.name}: invalid kind "${kind}" — defaulting to new_task`);
    return _defaultNewTask(message, json.language);
  }

  // Validate shape per kind
  if (kind === 'modify_task') {
    if (!json.targetTaskId || !json.rewrittenTask || !json.rewrittenTask.subject) {
      channel.log('inbox', `${agent.name}: modify_task missing fields — defaulting to new_task`);
      return _defaultNewTask(message, json.language);
    }
    // Confirm the target task still exists in the queue
    const exists = activeItems.some(i => String(i.id) === String(json.targetTaskId));
    if (!exists) {
      channel.log('inbox', `${agent.name}: modify_task targetTaskId "${json.targetTaskId}" not found — defaulting to new_task`);
      return _defaultNewTask(message, json.language);
    }
  }

  return {
    kind,
    targetTaskId: json.targetTaskId || null,
    rewrittenTask: json.rewrittenTask || null,
    language: _normalizeLanguage(json.language),
    reasoning: json.reasoning || '',
  };
}

function _defaultNewTask(message, language = null) {
  const subject = message.text.length > 80 ? message.text.substring(0, 77) + '...' : message.text;
  return {
    kind: 'new_task',
    targetTaskId: null,
    rewrittenTask: {
      subject: subject || 'Untitled message',
      description: message.text,
      activeForm: 'Processing the request',
    },
    language: _normalizeLanguage(language),
    reasoning: 'default (empty queue or classifier unavailable)',
  };
}

function _normalizeLanguage(lang) {
  if (!lang || typeof lang !== 'string') return null;
  const trimmed = lang.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'unknown') return null;
  return trimmed;
}
