/**
 * Reactions dispatcher
 *
 * Evaluates `reactions { on evt { body } }` blocks declared in .koi agents.
 * Events dispatched by the runtime: user.message, session.start,
 * session.resumed, <delegateName>.result, tasks.pending, tasks.completed,
 * error.llm, error.tool.
 *
 * Body grammar (enforced by the parser):
 *   - Calls: phase(X), effort(X), score(dim, N), bump(dim, ±N [, max: N] [, min: N])
 *   - Conditional: if (expr) { ... } [else { ... }]
 *
 * Expressions support: paths (a.b.c), literals, binary (== != < > && ||), unary (!).
 *
 * All mutations go through `state.statusPhase` (for phase) and
 * `session._phaseProfile` (for effort/score/bump). The dispatcher does NOT
 * make any other side effects (no prints, no actions, no LLM calls).
 */

import { channel } from '../io/channel.js';

const LEVEL_TO_SCORE = { none: 0, low: 30, medium: 60, high: 90 };
const VALID_EFFORTS = new Set(['none', 'low', 'medium', 'high']);
const VALID_DIMS = new Set(['code', 'reasoning']);

/**
 * Fire an event on the agent. Walks reactions, runs matching bodies.
 *
 * @param {Agent} agent - The agent firing the event.
 * @param {string} eventPath - Dot-separated event path (e.g. "phase.done",
 *                             "requirementsGatherer.result", "user.message").
 * @param {string|null} eventArg - Optional argument of the event
 *                                 (e.g. phase name for "phase.done").
 * @param {Object} context - Variables visible to reaction expressions.
 */
export function fireReaction(agent, eventPath, eventArg = null, context = {}) {
  if (!agent?.reactions || !Array.isArray(agent.reactions)) return;

  for (const clause of agent.reactions) {
    const matched = clause.events.some(e => {
      if (typeof e === 'string') {
        // Legacy format (shouldn't happen after transpiler update, but safe)
        return e === eventPath && !eventArg;
      }
      if (e.path !== eventPath) return false;
      // If the reaction specifies an arg, it must match exactly.
      // If the reaction omits the arg, it matches any arg value.
      if (e.arg && e.arg !== eventArg) return false;
      return true;
    });
    if (!matched) continue;
    try {
      _runBody(agent, clause.body, context, eventPath);
    } catch (err) {
      channel.log('reactions', `Error in reaction for ${eventPath}${eventArg ? `(${eventArg})` : ''}: ${err.message}`);
    }
  }
}

function _runBody(agent, body, context, eventName) {
  for (const stmt of body) {
    if (stmt.kind === 'if') {
      const cond = _evalExpr(stmt.cond, context);
      if (cond) {
        _runBody(agent, stmt.then, context, eventName);
      } else if (stmt.else) {
        _runBody(agent, stmt.else, context, eventName);
      }
    } else if (stmt.kind === 'call') {
      _runCall(agent, stmt, eventName);
    } else if (stmt.kind === 'methodCall') {
      _runMethodCall(agent, stmt, eventName);
    }
  }
}

function _runMethodCall(agent, stmt, eventName) {
  // e.g. { subject: 'phase', subjectArg: 'exploring', method: 'start', args: [] }
  const { subject, subjectArg, method } = stmt;
  if (subject === 'phase' && method === 'start') {
    _applyPhase(agent, subjectArg, eventName);
    return;
  }
  channel.log('reactions', `Unknown reaction method call: ${subject}(${subjectArg || ''}).${method}`);
}

function _runCall(agent, call, eventName) {
  const { name, args } = call;
  switch (name) {
    case 'effort': {
      const level = _getIdentArg(args, 0, 'effort');
      if (!VALID_EFFORTS.has(level)) {
        channel.log('reactions', `Invalid effort level: ${level}`);
        return;
      }
      _applyEffort(agent, level);
      break;
    }
    case 'score': {
      const dim = _getIdentArg(args, 0, 'score');
      const value = _getNumberArg(args, 1, 'score');
      if (!VALID_DIMS.has(dim)) {
        channel.log('reactions', `Invalid score dim: ${dim}`);
        return;
      }
      _applyScore(agent, dim, value);
      break;
    }
    case 'bump': {
      const dim = _getIdentArg(args, 0, 'bump');
      const delta = _getNumberArg(args, 1, 'bump');
      const max = _getNamedArg(args, 'max');
      const min = _getNamedArg(args, 'min');
      if (!VALID_DIMS.has(dim)) {
        channel.log('reactions', `Invalid bump dim: ${dim}`);
        return;
      }
      _applyBump(agent, dim, delta, { min, max });
      break;
    }
    default:
      channel.log('reactions', `Unknown reaction call: ${name}`);
  }
}

// ─── Mutation helpers ───────────────────────────────────────────────────

function _applyPhase(agent, phaseName, eventName) {
  if (!phaseName) return;

  // Validate against declared phases if present
  const validPhases = agent.phases?._validPhases;
  if (validPhases && !validPhases.includes(phaseName)) {
    channel.log('reactions', `Invalid phase "${phaseName}". Valid: ${validPhases.join(', ')}`);
    return;
  }

  const oldPhase = agent.state?.statusPhase || '(none)';
  if (oldPhase === phaseName) return;

  if (!agent.state) agent._rootState = agent._rootState || {};
  agent.state.statusPhase = phaseName;

  channel.log('state', `\x1b[1m\x1b[36m*** [phase] ${agent.name}: ${oldPhase} → ${phaseName} (on ${eventName}) ***\x1b[0m`);

  // Reset the session profile to the phase defaults so subsequent bumps
  // apply on top of the new phase base.
  const phaseProfile = agent.phases?.[phaseName];
  if (phaseProfile) {
    const session = agent._activeSession;
    if (session) {
      session._phaseProfile = _profileFromPhase(phaseProfile);
    }
  }
}

function _applyEffort(agent, level) {
  const session = agent._activeSession;
  if (!session) return;
  if (!session._phaseProfile) session._phaseProfile = {};
  session._phaseProfile.reasoningEffort = level;
  channel.log('reactions', `${agent.name}: effort → ${level}`);
}

function _applyScore(agent, dim, value) {
  const session = agent._activeSession;
  if (!session) return;
  if (!session._phaseProfile) session._phaseProfile = {};
  const clamped = Math.max(0, Math.min(100, value));
  session._phaseProfile[dim] = _scoreToLevel(clamped);
  session._phaseProfile[`${dim}Value`] = clamped;
  channel.log('reactions', `${agent.name}: score ${dim} → ${clamped}`);
}

function _applyBump(agent, dim, delta, { min, max }) {
  const session = agent._activeSession;
  if (!session) return;
  if (!session._phaseProfile) session._phaseProfile = {};

  const currentVal = session._phaseProfile[`${dim}Value`]
    ?? _levelToScore(session._phaseProfile[dim])
    ?? 0;

  let next = currentVal + delta;
  next = Math.max(0, Math.min(100, next));
  if (typeof min === 'number') next = Math.max(min, next);
  if (typeof max === 'number') next = Math.min(max, next);

  session._phaseProfile[`${dim}Value`] = next;
  session._phaseProfile[dim] = _scoreToLevel(next);
  channel.log('reactions', `${agent.name}: bump ${dim} ${delta >= 0 ? '+' : ''}${delta} → ${next}`);
}

// ─── Helpers for phase profile ──────────────────────────────────────────

function _profileFromPhase(phaseProps) {
  // phaseProps is like { reasoning: 'high', code: 'medium', maxOutputTokens: 8000 }
  const profile = { ...phaseProps };
  if (typeof phaseProps.reasoning === 'string') {
    profile.reasoningEffort = phaseProps.reasoning;
    profile.reasoningValue = _levelToScore(phaseProps.reasoning);
  }
  if (typeof phaseProps.code === 'string') {
    profile.codeValue = _levelToScore(phaseProps.code);
  }
  // maxOutputTokens is consumed by max-tokens-policy.js as an optional override
  // on the policy's base value. Accept both camelCase and the KOI-style snake.
  if (typeof phaseProps.maxOutputTokens === 'number') {
    profile.maxOutputTokens = phaseProps.maxOutputTokens;
  } else if (typeof phaseProps.max_output_tokens === 'number') {
    profile.maxOutputTokens = phaseProps.max_output_tokens;
  }
  return profile;
}

function _levelToScore(level) {
  if (typeof level === 'number') return level;
  return LEVEL_TO_SCORE[level] ?? 0;
}

function _scoreToLevel(score) {
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  if (score >= 20) return 'low';
  return 'none';
}

// ─── Argument extraction ────────────────────────────────────────────────

function _getIdentArg(args, index, callName) {
  const positionals = args.filter(a => a.kind === 'positional');
  const arg = positionals[index];
  if (!arg) throw new Error(`${callName}: missing argument at position ${index}`);
  if (arg.value.kind !== 'ident') {
    throw new Error(`${callName}: argument at position ${index} must be an identifier`);
  }
  return arg.value.name;
}

function _getNumberArg(args, index, callName) {
  const positionals = args.filter(a => a.kind === 'positional');
  const arg = positionals[index];
  if (!arg) throw new Error(`${callName}: missing argument at position ${index}`);
  if (arg.value.kind !== 'number') {
    throw new Error(`${callName}: argument at position ${index} must be a number`);
  }
  return arg.value.value;
}

function _getNamedArg(args, key) {
  const arg = args.find(a => a.kind === 'named' && a.key === key);
  if (!arg) return undefined;
  if (arg.value.kind !== 'number') return undefined;
  return arg.value.value;
}

// ─── Expression evaluation ──────────────────────────────────────────────

function _evalExpr(expr, context) {
  if (!expr) return undefined;
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'path':
      return _resolvePath(expr.path, context);
    case 'unary':
      if (expr.op === '!') return !_evalExpr(expr.expr, context);
      return undefined;
    case 'binary': {
      const { op } = expr;
      // Short-circuit for logical ops
      if (op === '&&') return _evalExpr(expr.left, context) && _evalExpr(expr.right, context);
      if (op === '||') return _evalExpr(expr.left, context) || _evalExpr(expr.right, context);
      const left = _evalExpr(expr.left, context);
      const right = _evalExpr(expr.right, context);
      switch (op) {
        case '===': return left === right;
        case '!==': return left !== right;
        case '==':  return left == right;
        case '!=':  return left != right;
        case '<':   return left < right;
        case '>':   return left > right;
        case '<=':  return left <= right;
        case '>=':  return left >= right;
      }
      return undefined;
    }
  }
  return undefined;
}

function _resolvePath(path, context) {
  let cur = context;
  for (const part of path) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}
