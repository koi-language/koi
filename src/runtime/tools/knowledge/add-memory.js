/**
 * add_memory — store a piece of project knowledge in the persistent vault.
 *
 * Backed by the Ori-vendored RMH pipeline:
 *   memory.write() → inbox/<title>.md → promote.ts (classify + filter) → notes/
 *
 * The agent is in charge of deciding what's worth remembering. This tool is
 * the canonical entry point for that decision — it's the equivalent of Ori's
 * `ori add` CLI / `add_memory` MCP method.
 */

import * as memory from '../../memory/index.js';
import { channel } from '../../io/channel.js';

export default {
  type: 'add_memory',
  intent: 'add_memory',
  description:
    'Store a piece of project knowledge so it persists across turns and sessions. ' +
    'The note lands in the project memory vault (.koi/memory/notes/) and is ' +
    'automatically embedded for semantic recall by future agents (this turn, ' +
    'next turn, or in any future session). ' +
    '\n\n' +
    'WHEN TO CALL — store ONLY if the information is reusable AND non-obvious. ' +
    'Categories (use the `type` field to label, exact enum values listed):\n' +
    '  • decision — you (or a peer agent) chose option A over option B with rationale. ' +
    'E.g. "Use JWT instead of session cookies for compliance". Includes architecture ' +
    'choices, library picks, deployment targets, schema decisions.\n' +
    '  • learning — a non-obvious fact discovered while working that will save ' +
    'future agents from rediscovering. E.g. "`bun install` must run after every ' +
    'package.json edit, not just on first setup". Includes gotchas, version ' +
    'constraints, build quirks, env-var requirements.\n' +
    '  • insight — a synthesized observation about the codebase or domain. ' +
    'E.g. "Auth flow has 3 entry points: web /login, mobile OAuth, internal API key". ' +
    'Use for cross-cutting summaries the agent itself produced.\n' +
    '  • idea — a hypothesis or proposal not yet validated. E.g. "Could split ' +
    'the monolith into auth + content services". Marked as `confidence: speculative`.\n' +
    '  • blocker — something preventing progress that needs human attention. ' +
    'E.g. "Tests fail because Stripe sandbox key is missing in CI".\n' +
    '  • opportunity — a possible improvement or feature gap noticed. E.g. ' +
    '"No rate limiting on /api/* — should add Upstash sliding window".\n' +
    '\n' +
    'NEVER store as memory:\n' +
    '  - User\'s current request or intent (it\'s already in the conversation).\n' +
    '  - What you just did or are about to do (covered by event log + task list).\n' +
    '  - Tool results, file contents, generated code (those go in artifacts/output).\n' +
    '  - Greetings, acknowledgements, error messages, transient debugging.\n' +
    '  - Anything obvious from the codebase itself.\n' +
    '\n' +
    'A good memory is one that, if a peer agent reads it 6 months from now ' +
    'with no other context, helps them avoid repeating work or making a wrong ' +
    'choice. If you\'re unsure, skip it — wrong memories are noise, no memories ' +
    'is fine.\n' +
    '\n' +
    'Fields: `title` (≤80 chars, descriptive), `description` (≤200 chars, ' +
    'one-sentence summary of what + why), `type` (enum), `project` (array of ' +
    'tags like ["auth","api"]), `body` (optional, full markdown including ' +
    'rationale + alternatives + links to other notes via [[wiki-links]]), ' +
    '`confidence` (speculative|promising|validated, default promising). ' +
    'Returns the title slug and the auto-promoted status.',
  thinkingHint: 'Storing memory',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'Short descriptive title. Becomes the markdown filename (slugified). ' +
          'Read it as a complete thought: "Auth uses JWT" not "JWT". ≤80 chars.',
      },
      description: {
        type: 'string',
        description:
          'One-sentence summary of WHAT and WHY. ≤200 chars, no trailing period. ' +
          'This is what the Context Compiler shows to future agents when ranking — ' +
          'it must stand alone. Bad: "JWT". Good: "Use JWT for stateless auth, ' +
          'avoiding session table contention".',
      },
      type: {
        type: 'string',
        enum: ['decision', 'learning', 'insight', 'idea', 'blocker', 'opportunity'],
        description:
          'See the action description for what each type means. If unsure between ' +
          'two, prefer `learning` (catches anything reusable). The classifier in ' +
          'classify.ts will validate / refine.',
      },
      project: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Project / area tags for filtering. Examples: ["auth"], ["api","gateway"], ' +
          '["frontend","ui"]. Use 1-3 lowercase tokens. Helps slot maps filter notes ' +
          'by relevance area.',
      },
      body: {
        type: 'string',
        description:
          'Optional full markdown body. Add rationale, alternatives considered, ' +
          'examples, links to other notes via [[wiki-links]]. The body is what ' +
          'agents see when they expand the note — be detailed where it helps, ' +
          'concise where it doesn\'t.',
      },
      confidence: {
        type: 'string',
        enum: ['speculative', 'promising', 'validated'],
        description:
          'How sure are you this is correct? `validated` = tested / confirmed; ' +
          '`promising` = inferred but not verified; `speculative` = guess / hypothesis. ' +
          'Default is `promising`. Idea-type notes default to `speculative`.',
      },
    },
    required: ['title', 'description', 'type'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'add_memory',
      title: 'Auth uses JWT',
      description: 'Switch from session cookies to JWT for stateless auth and compliance with new privacy regs',
      type: 'decision',
      project: ['auth', 'api'],
      confidence: 'validated',
      body:
        'Decided after legal review flagged session-token storage as non-compliant.\n\n' +
        '## Alternatives considered\n- Session cookies (rejected: storage compliance)\n- Custom token format (rejected: standardisation)\n\n' +
        '## Rationale\nJWT is signed, stateless, and validated at the edge in [[api-gateway]].',
    },
    {
      actionType: 'direct',
      intent: 'add_memory',
      title: 'bun install required after package.json edit',
      description: 'Build silently fails if package-lock and node_modules drift from package.json — must run bun install',
      type: 'learning',
      project: ['build', 'tooling'],
      confidence: 'validated',
    },
    {
      actionType: 'direct',
      intent: 'add_memory',
      title: 'Could split auth out of monolith',
      description: 'Auth code is self-contained and could be extracted to a separate service to reduce coupling',
      type: 'idea',
      project: ['architecture', 'auth'],
      confidence: 'speculative',
    },
    {
      actionType: 'direct',
      intent: 'add_memory',
      title: 'No rate limiting on public API',
      description: 'All /api/* endpoints accept unlimited requests — vulnerable to abuse',
      type: 'opportunity',
      project: ['api', 'security'],
      confidence: 'promising',
    },
  ],

  async execute(action, agent) {
    const { title, description, type, project, body, confidence } = action;
    if (!title || !description || !type) {
      return { success: false, error: 'add_memory: title, description and type are required' };
    }

    try {
      await memory.ensureInit(agent);
    } catch (err) {
      channel.log('memory', `add_memory: memory init failed (${err.message}) — note dropped`);
      return { success: true, stored: false, message: 'Memory unavailable; note not persisted.' };
    }

    try {
      const result = await memory.write({
        title,
        description: String(description).slice(0, 200),
        type,
        project: Array.isArray(project) ? project : [],
        confidence: confidence || (type === 'idea' ? 'speculative' : 'promising'),
        body: body || '',
      });
      channel.log(
        'memory',
        `[${agent?.name || '?'}] add_memory ${type}: "${title}" → ${result.title} (${result.status})`,
      );
      return {
        success: true,
        stored: true,
        title: result.title,
        status: result.status,
        promoted: result.status === 'active',
      };
    } catch (err) {
      channel.log('memory', `add_memory write failed: ${err.message}`);
      return { success: false, error: `add_memory failed: ${err.message}` };
    }
  },
};
