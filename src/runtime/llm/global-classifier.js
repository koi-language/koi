/**
 * Global Message Classifier — single decision point for every user
 * message into the runtime.
 *
 * Unlike the per-agent classifier (message-classifier.js) which only saw
 * its own agent's workQueue, this one receives a full runtime snapshot
 * (active workflow, every agent's queue items, taskManager plan tasks,
 * running delegates, recent conversation) and decides — on one LLM call
 * — what should happen with the incoming message.
 *
 * Decision kinds (v1):
 *   - new_task   → add item to the root's workqueue.
 *   - modify_task→ rewrite an existing task (workqueue OR taskManager).
 *                 Returns target {id, source, owner} so the dispatcher
 *                 knows which container to mutate.
 *   - noop       → conversational / acknowledgement / clarification
 *                 question — no task action.
 *
 * Future kinds (Phase D): cancel_task, cancel_plan, pause, resume,
 * redirect. The return shape already carries `abortInFlight` so the
 * dispatcher can interrupt a delegate's LLM stream when a modification
 * to an in-progress task demands immediate attention.
 *
 * Pure classification — no state mutation. Mutation happens in the
 * dispatcher that consumes this result (see agent.js inbox drain).
 */

import { channel } from '../io/channel.js';
import { buildGlobalSnapshot, renderSnapshotForPrompt } from '../state/global-snapshot.js';

/**
 * @typedef {Object} GlobalClassifierResult
 * @property {'new_task'|'modify_task'|'cancel_task'|'cancel_plan'|'noop'} kind
 * @property {{id: string, source: 'taskManager' | `workqueue:${string}`, owner: string | null} | null} target
 *   For modify_task + cancel_task. Identifies where the task lives so
 *   the dispatcher picks the right container. `null` for cancel_plan
 *   (applies to every active task) and for new_task / noop.
 * @property {{subject: string, description: string, activeForm?: string} | null} rewrite
 *   For new_task + modify_task. The new subject/description (merged
 *   with the current one when modifying).
 * @property {string | null} targetDelegateAgent
 *   Name of the delegate currently working on `target` — set when the
 *   classifier decides the message should interrupt ongoing work.
 * @property {boolean} abortInFlight
 *   When true, the dispatcher aborts the delegate's current LLM
 *   stream / tool call so the change is seen without waiting for the
 *   ongoing action to finish. Only meaningful when `targetDelegateAgent`
 *   is set.
 * @property {string | null} language
 *   Natural language of the user's message, e.g. "Spanish". Dispatcher
 *   writes it to `root.state.userLanguage` for downstream turns.
 * @property {string} reasoning
 *   Short (<= 160 chars) classifier explanation. Goes into context
 *   memory so the agent's next turn can see why something moved.
 */

/**
 * @param {import('../agent/agent.js').Agent} agent  The agent receiving the msg (usually root).
 * @param {import('../agent/message-inbox.js').InboxMessage} message
 * @returns {Promise<GlobalClassifierResult>}
 */
export async function classifyGlobalMessage(agent, message) {
  // Agent-to-agent broadcasts (parentTaskId set) already went through
  // the coordinator upstream — inject as noop so the local agent's
  // contextMemory picks it up without re-classifying.
  if (message.parentTaskId) {
    return _noop('broadcast from parent — already classified upstream');
  }

  // Strict user-only: only `from === 'user'` triggers full global
  // classification. Other agent-to-agent messages fall through as noop.
  if (message.from !== 'user') {
    return _noop('non-user message — skipping global classification');
  }

  // Get the cheap classifier from the agent's llmProvider. The same
  // shared client is reused for routing / task classification.
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

  // Build the runtime snapshot — all tasks (queue + plan), running
  // delegates, recent dialogue. The classifier sees the whole picture
  // in ONE prompt and decides accordingly.
  let snapshot;
  try {
    snapshot = await buildGlobalSnapshot();
  } catch (err) {
    channel.log('inbox', `${agent.name}: snapshot failed (${err.message}) — defaulting to new_task`);
    return _defaultNewTask(message);
  }
  const snapshotStr = renderSnapshotForPrompt(snapshot);

  // Build the list of valid target references so the classifier can
  // only pick IDs that actually exist. Keys are `<source>#<id>` to
  // disambiguate between taskManager and per-agent workQueue spaces.
  const validTargets = snapshot.tasks
    .filter((t) => t.status === 'pending' || t.status === 'in_progress')
    .map((t) => `${t.source}#${t.id}`);

  const prompt = `You are the GLOBAL message router for an AI agent runtime. A user message just arrived. You see the complete runtime state: all pending/in-progress tasks (across the root's workqueue AND the global task plan), any delegate currently executing one of them, and the recent dialogue.

Decide ONE of:

1. "new_task"     — the user asks for something NEW that doesn't refine or alter any existing task. Produces a fresh workqueue item.
2. "modify_task"  — the user amends, corrects, clarifies, adds scope to, or removes scope from an EXISTING task. You MUST pick which one by its \`source#id\` key. Does NOT mean "stop doing it" — that's cancel_task.
3. "cancel_task"  — the user explicitly wants to STOP / ABORT / CANCEL / DISCARD / DROP a specific existing task without replacing it. Example: "cancela la búsqueda del carrot cake", "olvida eso", "no hagas la tarea de X". Requires a concrete target task (source#id).
4. "cancel_plan"  — the user explicitly wants to ABORT THE ENTIRE PLAN / STOP EVERYTHING / DROP ALL PENDING WORK. Applies when NO single task is singled out — they want everything cleared. Examples: "para todo", "cancela todo", "stop everything", "olvida todo lo que estábamos haciendo".
5. "noop"         — greetings, acknowledgements, thanks, conversational questions not related to changing work. The agent will respond naturally.

STRICT RULES:
- "modify_task" / "cancel_task" require a concrete target. If no existing task clearly matches, downgrade to "new_task" (for modify) or "noop" (for cancel).
- Thematic overlap alone is NOT enough for "modify_task" — the user must be refining or altering the SAME work. "Research X, now also look up Y" → modify. "Research X. Now tell me about Z" → new_task.
- DISTINGUISH modify vs cancel: "better do lentils instead" = modify (replace subject of same task). "forget the recipe, never mind" = cancel_task. "do lentils in a new file" (while old task continues) = new_task.
- DISTINGUISH cancel_task vs cancel_plan: "cancel the lentil search" (one specific task) = cancel_task. "cancel everything" / "stop all work" = cancel_plan. When in doubt and there's only ONE active task, prefer cancel_task.
- The rewrite (for new_task OR modify_task) MUST merge the user's new intent with the original description — not replace it unless the user explicitly changes the scope. rewrite is NOT used for cancel_task / cancel_plan (set it to null).
- Prefer "noop" for short greetings ("hola", "thanks", "ok") and conversational messages that don't create or alter work.
- Never invent a target id. ONLY pick from the list of VALID TARGETS provided.

ABORT-IN-FLIGHT:
- For modify_task / cancel_task where the task is currently \`in_progress\` AND there's a delegate listed as working on it, set \`abortInFlight: true\` — the runtime interrupts the delegate's current LLM / tool call so the change is seen immediately.
- For cancel_plan, \`abortInFlight\` is always true (implicit) and targetDelegateAgent does not apply.
- If the task is still \`pending\` or no delegate is running it, set \`abortInFlight: false\`.

LANGUAGE:
- Detect the natural language of the user's message and return its English name in "language" (e.g. "Spanish", "English", "French"). Return null for single emoji / code-only / language-neutral messages.

RUNTIME STATE:
${snapshotStr}

VALID TARGETS (only these keys are allowed for modify_task / cancel_task):
${validTargets.length > 0 ? validTargets.map(k => `  - ${k}`).join('\n') : '  (none — no active tasks)'}

Each key above has the shape \`<source>#<numeric-id>\`. When you pick one, you MUST split it into two separate fields in your response:
- "source": the part BEFORE the # (e.g. "taskManager" or "workqueue:Worker")
- "id": the part AFTER the # (just the number, e.g. "1")
DO NOT put the full key in either field. "id" is ONLY the number.

USER MESSAGE:
${message.text}

Return ONLY a single JSON object (no prose, no markdown fences):
{
  "kind": "new_task" | "modify_task" | "cancel_task" | "cancel_plan" | "noop",
  "target": { "id": "<numeric id only, NO prefix>", "source": "taskManager" | "workqueue:<AgentName>", "owner": "<agent>" | null } | null,
  "rewrite": { "subject": "<short English title>", "description": "<merged full context in English>", "activeForm": "<present continuous in English>" } | null,
  "targetDelegateAgent": "<name of the delegate currently working on this target, if any>" | null,
  "abortInFlight": true | false,
  "language": "<language name in English>" | null,
  "reasoning": "<≤160 char explanation>"
}`;

  let json;
  try {
    json = await classifier.runCheapJsonCompletion(prompt, {
      timeoutMs: 30000,
      maxTokens: 1000,
      label: 'global-classify',
    });
  } catch (err) {
    channel.log('inbox', `${agent.name}: global classifier threw (${err.message}) — defaulting to new_task`);
    return _defaultNewTask(message);
  }
  if (!json || typeof json !== 'object') {
    channel.log('inbox', `${agent.name}: global classifier returned no JSON — defaulting to new_task`);
    return _defaultNewTask(message);
  }

  const kind = json.kind;
  const validKinds = ['new_task', 'modify_task', 'cancel_task', 'cancel_plan', 'noop'];
  if (!validKinds.includes(kind)) {
    channel.log('inbox', `${agent.name}: global classifier invalid kind "${kind}" — defaulting to new_task`);
    return _defaultNewTask(message, json.language);
  }

  // modify_task AND cancel_task both need a valid target. Share the
  // parsing / validation path and downgrade gracefully when the target
  // is missing or phantom:
  //   - modify_task  → fall back to new_task (user probably meant new)
  //   - cancel_task  → fall back to noop (no task to cancel, so say
  //                   nothing — the LLM will ask for clarification)
  if (kind === 'modify_task' || kind === 'cancel_task') {
    const target = json.target;
    if (!target || !target.id || !target.source) {
      channel.log('inbox', `${agent.name}: global ${kind} missing target — downgrade`);
      return kind === 'modify_task'
        ? _defaultNewTask(message, json.language)
        : _noop('cancel_task without target — conversational response');
    }

    // Tolerant parsing: some LLMs return the id with the source prefix
    // baked in (e.g. id="workqueue:Worker#1" instead of id="1"). Also
    // handle the rarer inverse where source already contains a #id
    // suffix. Strip / split as needed before validating.
    let _src = String(target.source).trim();
    let _id = String(target.id).trim();
    if (_id.includes('#')) {
      const parts = _id.split('#');
      _id = parts[parts.length - 1];
      if (!_src || _src === 'null' || _src === 'undefined') {
        _src = parts.slice(0, -1).join('#');
      }
    }
    if (_src.includes('#')) {
      const parts = _src.split('#');
      _src = parts[0];
    }

    const key = `${_src}#${_id}`;
    if (!validTargets.includes(key)) {
      channel.log('inbox', `${agent.name}: global ${kind} target "${key}" not in valid set — downgrade`);
      return kind === 'modify_task'
        ? _defaultNewTask(message, json.language)
        : _noop(`cancel_task target ${key} no longer exists`);
    }

    // modify_task additionally requires a rewrite (subject is mandatory).
    // cancel_task has no rewrite — always null.
    if (kind === 'modify_task' && (!json.rewrite || !json.rewrite.subject)) {
      channel.log('inbox', `${agent.name}: global modify_task missing rewrite — downgrade to new_task`);
      return _defaultNewTask(message, json.language);
    }

    json.target = { id: _id, source: _src, owner: target.owner || null };
  }

  if (kind === 'new_task' && (!json.rewrite || !json.rewrite.subject)) {
    return _defaultNewTask(message, json.language);
  }

  // cancel_plan is implicit: no target, no rewrite, abort all delegates.
  // Force abortInFlight=true regardless of what the model said so the
  // dispatcher cleans up aggressively.
  const abortInFlight = kind === 'cancel_plan' ? true : !!json.abortInFlight;

  return {
    kind,
    target: (kind === 'modify_task' || kind === 'cancel_task') ? {
      id: String(json.target.id),
      source: String(json.target.source),
      owner: json.target.owner || null,
    } : null,
    rewrite: (kind === 'new_task' || kind === 'modify_task') ? (json.rewrite || null) : null,
    targetDelegateAgent: json.targetDelegateAgent || null,
    abortInFlight,
    language: _normalizeLanguage(json.language),
    reasoning: typeof json.reasoning === 'string' ? json.reasoning : '',
  };
}

function _noop(reasoning) {
  return {
    kind: 'noop',
    target: null,
    rewrite: null,
    targetDelegateAgent: null,
    abortInFlight: false,
    language: null,
    reasoning,
  };
}

function _defaultNewTask(message, language = null) {
  const subject = message.text.length > 80 ? message.text.substring(0, 77) + '...' : message.text;
  return {
    kind: 'new_task',
    target: null,
    rewrite: {
      subject: subject || 'Untitled message',
      description: message.text,
      activeForm: 'Processing the request',
    },
    targetDelegateAgent: null,
    abortInFlight: false,
    language: _normalizeLanguage(language),
    reasoning: 'default (classifier unavailable or invalid output)',
  };
}

function _normalizeLanguage(lang) {
  if (!lang || typeof lang !== 'string') return null;
  const trimmed = lang.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'unknown') return null;
  return trimmed;
}
