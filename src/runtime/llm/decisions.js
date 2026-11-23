/**
 * Decisions: typed questions about a piece of content, answered with probabilities by a DECISION model (a
 * classifier such as TypeSafe's Jev) through the Koi API's `POST /gateway/decisions`.
 *
 * Three kinds of question, any number of them in ONE call (they are answered in parallel):
 *   - choice  one label of a closed list, when the labels are mutually exclusive and compete
 *             criteria: { label: "what it means", ... }
 *   - score   a level on an ordered scale, when the order matters
 *             criteria: ["lowest level", ..., "highest level"]
 *   - noul    a yes/no statement, a probability 0..1; for independent or multi-label tagging
 *             criteria (optional): { true: "...", false: "..." }
 *
 * Measured on 23/11/2026: Jev 1.13 answered three questions in ~250 ms for ~$0.00002, where an LLM classifying the
 * same task took 5-7 s. When no decision model is reachable (no Koi API, none active, the call fails), the same
 * questions are answered by a cheap LLM and returned in the SAME shape, so a caller never sees the difference
 * except in `source`.
 */
import { hasKoiApi, koiApiKey, koiGatewayUrl } from '../api/koi-api.js';

const TYPES = new Set(['choice', 'score', 'noul']);

/** Throws on a malformed question set; returns it normalised. */
export function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new Error('classify: "questions" must be an object with at least one question');
  }
  for (const [name, q] of Object.entries(questions)) {
    if (!q || !TYPES.has(q.type)) throw new Error(`classify: question "${name}" needs a type: choice, score or noul`);
    if (q.type === 'choice' && (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 2)) {
      throw new Error(`classify: choice question "${name}" needs criteria as { label: "meaning", ... } with at least two labels`);
    }
    if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2)) {
      throw new Error(`classify: score question "${name}" needs criteria as an ordered list of at least two levels`);
    }
  }
  return questions;
}

/** One answer of the provider, in the shape Koi returns. */
function normaliseAnswer(q, a) {
  if (!a || a.type === 'refusal') return { type: q.type, refused: true };
  if (a.type === 'choice') {
    return { type: 'choice', answer: a.choice, confidence: a.confidence ?? null, probabilities: a.probabilities ?? null };
  }
  if (a.type === 'noul') {
    const p = Number(a.noul);
    return { type: 'noul', answer: p >= 0.5, probability: p, confidence: a.confidence ?? null };
  }
  if (a.type === 'score') {
    const probs = a.probabilities ?? null;
    let level = null;
    if (probs) {
      level = Number(Object.entries(probs).sort((x, y) => y[1] - x[1])[0]?.[0]);
    } else if (typeof a.score === 'number' && Array.isArray(q.criteria)) {
      level = Math.round(a.score * (q.criteria.length - 1));
    }
    const label = Number.isInteger(level) && Array.isArray(q.criteria) ? q.criteria[level] ?? null : null;
    return { type: 'score', answer: level, label, score: a.score ?? null, confidence: a.confidence ?? null, probabilities: probs };
  }
  return { type: q.type, refused: true };
}

/** Through the Koi API. Returns null when no decision model can answer (the caller falls back). */
async function viaGateway({ state, questions, model, timeoutMs }) {
  if (!hasKoiApi()) return null;
  let res;
  try {
    res = await fetch(`${koiGatewayUrl()}/decisions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${koiApiKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state, questions, ...(model ? { model } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json;
  try { json = await res.json(); } catch { return null; }
  if (!json || typeof json.answers !== 'object') return null;
  const answers = {};
  for (const [name, q] of Object.entries(questions)) answers[name] = normaliseAnswer(q, json.answers[name]);
  return { answers, model: json.model ?? null, source: 'decision-model', cost: json.usage?.cost ?? null };
}

/** The same questions answered by a cheap LLM, in the same shape. `llm(prompt)` returns parsed JSON or null. */
async function viaLlm({ state, questions, llm }) {
  if (typeof llm !== 'function') return null;
  const spec = Object.entries(questions).map(([name, q]) => {
    if (q.type === 'choice') return `- "${name}" (choice): ${q.instructions ?? ''}\n  Pick exactly one label of: ${Object.entries(q.criteria).map(([k, v]) => `"${k}" = ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ')}`;
    if (q.type === 'score') return `- "${name}" (score): ${q.instructions ?? ''}\n  Levels, from 0: ${q.criteria.map((c, i) => `${i} = ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('; ')}`;
    return `- "${name}" (noul): ${q.instructions ?? ''}${q.criteria ? ` (true = ${q.criteria.true ?? 'yes'}; false = ${q.criteria.false ?? 'no'})` : ''}`;
  }).join('\n');
  const prompt = `Answer every question about the CONTENT. Return ONLY json, one key per question:
choice → {"choice": "<label>", "probabilities": {"<label>": 0..1, ...}}
score  → {"level": <integer from 0>, "probabilities": {"<level>": 0..1, ...}}
noul   → {"probability": 0..1}

QUESTIONS:
${spec}

CONTENT:
${typeof state === 'string' ? state : JSON.stringify(state).slice(0, 6000)}`;
  const json = await llm(prompt).catch(() => null);
  if (!json || typeof json !== 'object') return null;
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = json[name] || {};
    if (q.type === 'choice') answers[name] = normaliseAnswer(q, { type: 'choice', choice: a.choice, probabilities: a.probabilities });
    else if (q.type === 'score') answers[name] = { ...normaliseAnswer(q, { type: 'score', probabilities: a.probabilities }), answer: Number.isInteger(a.level) ? a.level : null, label: Number.isInteger(a.level) ? q.criteria[a.level] ?? null : null };
    else answers[name] = normaliseAnswer(q, { type: 'noul', noul: Number(a.probability ?? 0) });
  }
  return { answers, model: null, source: 'llm', cost: null };
}

/**
 * Answers `questions` about `state`. A decision model first; a cheap LLM (`llm`) when none can.
 * @returns {Promise<{answers: Record<string, object>, model: string|null, source: 'decision-model'|'llm', cost: number|null} | null>}
 */
export async function decide({ state, questions, model = null, llm = null, timeoutMs = 15000 }) {
  validateQuestions(questions);
  if (state == null || state === '') throw new Error('classify: "state" (the content to judge) is required');
  return (await viaGateway({ state, questions, model, timeoutMs })) ?? (await viaLlm({ state, questions, llm }));
}
