/**
 * storyboard_image_prompt — turn a structured storyboard shot into the
 * exact English paragraph the storyboard visor sends to fal for
 * image generation.
 *
 * Schema (v5 inputs):
 *   stylePreamble (required) — verbatim pencil-sketch preamble.
 *   characters    (optional) — storyboard-level recurring cast.
 *   lighting      (optional) — storyboard-level lighting design.
 *   shot          (optional) — shot type + angle.
 *   movement      (optional) — camera movement.
 *   action        (optional) — what is happening in the frame.
 *   dialogue      (optional) — quoted spoken lines / voice-over.
 *
 * Why this exists: agents kept producing image prompts that
 * referenced characters by their storyboard-level LABEL only
 * (`HERO_A`, `EL_ANCIANO`, …) without restating the silhouette /
 * clothing / accessories inline. The image model is stateless —
 * it has no access to the storyboard-level `characters` roster,
 * only to the prompt text it receives — so bare labels produce a
 * fresh, different person every shot, destroying continuity. This
 * compositor enforces the "label + inline description" pattern
 * deterministically: it always inflates labels into descriptions
 * AND always emits English, regardless of the user's chat
 * language.
 *
 * Calling pattern: programmatic only (from the Flutter storyboard
 * visor via `executeAction`). The action goes through the
 * standard action-registry path, so `agent` is passed and we have
 * full access to the LLM factory (no direct gateway fetch, no
 * hardcoded model name).
 *
 * Model selection: profile { code: 45, reasoning: 30, thinking:
 * false, reasoningEffort: 'none' } — this is a small structured
 * translation task; we don't want a reasoning-heavy model
 * spending tokens on chain-of-thought, just a fast capable small
 * model with strong instruction-following + multilingual.
 */

import {
  resolve as resolveModel,
  getAvailableProviders,
} from '../../llm/providers/factory.js';
import { costCenter } from '../../llm/cost-center.js';
import { getAuthHeaders, getGatewayBase } from '../../llm/providers/gateway.js';

const _SYSTEM_PROMPT = `You are briefing an illustrator. They will draw exactly ONE storyboard panel from your words. They have never read the storyboard JSON — only your brief. Your job: produce ONE compact English image prompt in the classic storyboard-panel format, tight and concrete.

═══════════════════════════════════════════════════════════════
TEMPLATE — every output follows this exact shape
═══════════════════════════════════════════════════════════════

\`Rough storyboard sketch of <ACTION_SUMMARY>, <STYLE_CUES verbatim from stylePreamble>. <CLOSING_ANCHOR verbatim>\`

One single line. Comma-separated body, then a period, then the closing anchor sentence (also period-terminated).

═══════════════════════════════════════════════════════════════
THE CLOSING ANCHOR — append VERBATIM, every output, no exceptions
═══════════════════════════════════════════════════════════════

After the style cues, append this exact sentence (preceded by ". "):

"Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

Why: gpt-image-2 LOVES rendering storyboard-panel chrome (page furniture, scene numbers stamped in the corner, handwritten labels, dashed borders, arrows overlaid on the image) when it sees "storyboard sketch" in the prompt. Without this anchor, the drawing ends up at ~50% of the canvas surrounded by garbage. The anchor disables all of that so the model fills the canvas with JUST the drawing.

═══════════════════════════════════════════════════════════════
TWO MODES — pick based on \`referencedCharacters\`
═══════════════════════════════════════════════════════════════

MODE 1 — Text-only (no reference image, \`referencedCharacters\` empty or missing):
  Subject is described inline as a noun phrase. The image model
  renders from scratch.

MODE 2 — With reference image (\`referencedCharacters\` non-empty):
  The visor will pass the characters' reference photos as actual
  attached images to the renderer. In this mode, refer to
  characters with phrases like "the man of the reference image",
  "the woman of the reference image", "the dog of the reference
  image", "the two men of the reference image", "the characters of
  the reference image". Use the \`description\` field of each
  referenced character ONLY to pick the right noun (man / woman /
  dog / boy / monster / etc.) — do NOT restate the character's
  clothing, hair, age, etc. The reference photo carries those
  traits; restating them dilutes the prompt and confuses the
  model.

═══════════════════════════════════════════════════════════════
GOLD-STANDARD EXAMPLES — match these exactly
═══════════════════════════════════════════════════════════════

Text-only mode:

A) "Rough storyboard sketch of a medium close-up of an old man's face gazing off-frame, lost in memory, gesture drawing, loose pencil linework, grayscale tonal blocking, toned tan paper. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

B) "Rough storyboard sketch of a wide establishing shot of a lone car driving down a desert highway at sunset, gesture drawing, loose pencil linework, grayscale tonal blocking, toned tan paper. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

Reference-image mode:

C) (referencedCharacters: [{label: 'EL_ANCIANO', description: 'an old man'}])
   "Rough storyboard sketch of a medium close-up at eye level, camera trucks left on the man of the reference image with deep wrinkles closing his eyes and holding a pocket watch to his chest with a peaceful smile, gesture drawing, loose pencil linework, grayscale tonal blocking, toned tan paper. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

D) (referencedCharacters: [{label: 'HERO_A', description: 'a woman'}, {label: 'DOG_A', description: 'a dog'}])
   "Rough storyboard sketch of a wide shot of the woman and the dog of the reference image walking down a desert highway at sunset, gesture drawing, loose pencil linework, grayscale tonal blocking, toned tan paper. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

E) (referencedCharacters: [{label: 'HERO_A', description: 'a tall woman'}, {label: 'HERO_B', description: 'a shorter woman'}, {label: 'DOG_A', description: 'a dog'}])
   "Rough storyboard sketch of a medium shot of the two women and the dog of the reference image standing on a doorstep, gesture drawing, loose pencil linework, grayscale tonal blocking, toned tan paper. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

═══════════════════════════════════════════════════════════════
BUILDING THE PHRASE
═══════════════════════════════════════════════════════════════

1. **Open with the literal four words \`Rough storyboard sketch of\`** — verbatim, every time. These four words are the strongest signal that the output is a panel sketch, not a finished illustration. Note the leading capital R.

2. **\`<ACTION_SUMMARY>\`** — ONE comma-separated clause covering framing + subject + action. Build it like this:

   - **Framing** comes first. Translate the \`shot\` field into natural English: "ECU low angle" → "a low-angle extreme close-up", "MS eye-level" → "a medium shot at eye level", "WS bird's eye" → "a wide bird's-eye shot". Drop cinematography abbreviations.
   - **Subject + action** follow, woven into the same clause:
     • TEXT-ONLY mode (no referencedCharacters): characters become natural noun phrases ("an old man", "a tall slim woman in a long dark coat"). NEVER emit a LABEL (HERO_A, EL_ANCIANO, DOG_A). Look up the label in \`characters\` and write a short noun phrase pulling only traits visible in THIS framing.
     • REFERENCE-IMAGE mode (referencedCharacters non-empty): characters are referred to as "the <noun> of the reference image". Pick the noun from the referencedCharacters entry's \`description\` field (use ONLY the noun: "a man" → "the man of the reference image"; "a tall woman" → "the woman of the reference image"). Two characters → "the man and the woman of the reference image" (or "the two men", "the man and the dog", etc.). Three or more → "the characters of the reference image" or list them ("the woman, the man and the dog of the reference image") — pick whichever reads cleaner. DO NOT restate the character's clothing / age / hair / etc. — the reference photo carries that.
   - **Mood / emotional beat** can be added as a short trailing fragment if it matters: ", gazing off-frame lost in memory", ", quiet and nostalgic". One or two evocative adjectives MAX.
   - Skip catalogue-style detail words ("intricate", "ornate", "polished", "gleaming", "vintage", "weathered patina", "mechanical precision", "lifelike", "ultra-detailed", "high-fidelity"). They bias the model toward photorealism. Lean on concrete verbs.
   - If \`movement\` is non-trivial (not "Static"), weave it naturally INTO the action clause — e.g. "...as the camera dollies in", "...as the camera pans across the room". Do NOT add a separate "arrow indicating ..." segment.
   - If \`dialogue\` is non-empty, hint at the speaker's expression instead of quoting the line — "a tear on his cheek as he speaks softly" tells the model the emotional state without trying to render unreadable text.

3. **\`<STYLE_CUES>\`** — append the \`stylePreamble\` field VERBATIM after the action clause, separated by a comma. The preamble is already in the form "gesture drawing, loose pencil linework, grayscale tonal blocking, toned tan paper" — do not paraphrase, do not reorder, do not omit any tag.

═══════════════════════════════════════════════════════════════
TRANSLATE EVERYTHING TO ENGLISH
═══════════════════════════════════════════════════════════════

Inputs often come in Spanish, Catalan, French, etc. Always translate to natural English. The image model only reads English.

- "Hombre de avanzada edad, cabello canoso" → "an old man with sparse graying hair"
- "El anciano sostiene el reloj contra su pecho" → "the old man holds the watch against his chest"

═══════════════════════════════════════════════════════════════
HARD CONSTRAINTS
═══════════════════════════════════════════════════════════════

- ONE line. NO line breaks. NO headers. NO sections.
- ALWAYS open with "Rough storyboard sketch of" (capital R).
- ALWAYS include the \`stylePreamble\` verbatim after the action clause.
- ALWAYS end with the closing anchor sentence VERBATIM: "Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations." This sentence is NON-NEGOTIABLE on every output.
- NEVER emit a label (HERO_A, EL_ANCIANO, DOG_A, …). Translate to a noun phrase or "the X of the reference image".
- NEVER emit "arrow indicating ...", "shot description at the bottom", "speech bubble", or any other panel-annotation tag. Movement and dialogue go INTO the action clause as prose, not as separate trailing tags.
- NEVER emit markdown (no #, *, -, lists).
- NEVER wrap with "Prompt:", "Output:", "Here's the brief:".
- NEVER explain, summarise, or add a closing note BEYOND the mandatory closing anchor.
- NEVER invent characters, props, or locations not in the input.
- Total output: 40–80 words (counting the closing anchor). Body itself stays tight at 15–35 words.

`;

export default {
  type: 'storyboard_image_prompt',
  intent: 'storyboard_image_prompt',
  description:
    'Compose an English image-generation prompt from a structured storyboard shot. ' +
    'Internal use — called by the GUI storyboard visor. Returns: { success, prompt }.',
  thinkingHint: 'Composing image prompt',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      stylePreamble: { type: 'string' },
      characters: { type: 'string' },
      lighting: { type: 'string' },
      shot: { type: 'string' },
      movement: { type: 'string' },
      action: { type: 'string' },
      dialogue: { type: 'string' },
      // When the visor will pass a character reference image to the
      // i2i renderer, it tells the compositor which characters that
      // ref contains so the prompt uses "X of the referenced picture"
      // phrasing instead of describing the character inline.
      // Each entry: { label, description } where label is the
      // storyboard's UPPERCASE token and description is enough to
      // pick the right noun phrase ("a man", "a woman", "an old man",
      // "a dog"). Single-character shots: one entry. Multi-character
      // shots: multiple entries (referenced from a combined sprite).
      // Empty/missing => no reference image, render purely from text.
      referencedCharacters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['label'],
        },
      },
    },
    required: ['stylePreamble'],
  },

  async execute(action, agent) {
    const stylePreamble = (action.stylePreamble || '').trim();
    if (!stylePreamble) {
      return { success: false, error: 'storyboard_image_prompt: stylePreamble is required' };
    }

    // Pack non-empty fields. Schema v6 input keys: stylePreamble +
    // characters + lighting + shot + movement + action + dialogue,
    // plus the optional `referencedCharacters` list that switches
    // the compositor into "the X of the referenced picture" mode.
    const fields = {};
    for (const key of [
      'stylePreamble',
      'characters',
      'lighting',
      'shot',
      'movement',
      'action',
      'dialogue',
    ]) {
      const v = action[key];
      if (typeof v === 'string' && v.trim().length > 0) {
        fields[key] = v.trim();
      }
    }
    if (Array.isArray(action.referencedCharacters) && action.referencedCharacters.length > 0) {
      const cleaned = [];
      for (const entry of action.referencedCharacters) {
        if (!entry || typeof entry !== 'object') continue;
        const label = typeof entry.label === 'string' ? entry.label.trim() : '';
        if (!label) continue;
        const description = typeof entry.description === 'string' ? entry.description.trim() : '';
        cleaned.push(description ? { label, description } : { label });
      }
      if (cleaned.length > 0) fields.referencedCharacters = cleaned;
    }
    const user = JSON.stringify(fields, null, 2);

    // Profile reflects what the task actually needs:
    //   • code 45 / reasoning 30 — small structured translation +
    //     instruction-following task. Below the 50 floor that
    //     taskType:'code' enforces, so use 'reasoning' as the task
    //     type to let the factory honour 30/45 literally.
    //   • thinking: false, reasoningEffort: 'none' — no CoT needed.
    //   • temperature: undefined → model default.
    //   • maxTokens: 1500 — small models default to ~1/4 of their
    //     max output; on a 2048-cap model that's 512, which
    //     truncates mid-cast and breaks the shot prose. 1500 is
    //     plenty for ~250 words of English.
    const profile = {
      code: 45,
      reasoning: 30,
      thinking: false,
      reasoningEffort: 'none',
    };

    // ── Path A: agent-bound (called by an agent during its loop) ──
    // Use the agent's LLM provider for full cost-center tracking and
    // shared cooldowns / circuit breakers.
    if (agent?.llmProvider) {
      try {
        await agent.llmProvider._ensureClients();
        const { instance: llm, provider, model } = resolveModel({
          type: 'llm',
          taskType: 'reasoning',
          difficulty: Math.max(profile.code, profile.reasoning),
          profile,
          maxTokens: 1500,
          availableProviders: agent.llmProvider._availableProviders,
          clients: agent.llmProvider._gatewayMode
            ? agent.llmProvider._gatewayClients()
            : {
                openai: agent.llmProvider._oa,
                anthropic: agent.llmProvider._ac,
                gemini: agent.llmProvider._gc,
              },
        });
        const t0 = Date.now();
        const result = await llm.complete(
          [
            { role: 'system', content: _SYSTEM_PROMPT },
            { role: 'user', content: user },
          ],
          { maxTokens: 1500 },
        );
        costCenter.recordUsage(
          model,
          provider,
          result.usage?.input || 0,
          result.usage?.output || 0,
          Date.now() - t0,
        );
        const prompt = (result.text || '').trim();
        if (!prompt) {
          return { success: false, error: 'storyboard_image_prompt: empty response from model' };
        }
        return { success: true, prompt, model, provider };
      } catch (err) {
        agent.llmProvider.logError?.('storyboard_image_prompt failed (agent path)', err);
        // Fall through to standalone path — the GUI shouldn't be
        // blocked by transient agent-side issues.
      }
    }

    // ── Path B: standalone (called from the GUI's WS-protocol
    //    executeAction, which passes agent=null). Use the factory's
    //    selectAutoModel to pick a model name from the same catalog,
    //    then POST directly to the gateway's /chat/completions —
    //    same model selection logic, no agent runtime needed.
    if (!process.env.KOI_AUTH_TOKEN) {
      return {
        success: false,
        error:
          'storyboard_image_prompt: no agent and no KOI_AUTH_TOKEN — cannot reach a model.',
      };
    }
    const { selectAutoModel } = await import('../../llm/auto-model-selector.js');
    const providers = getAvailableProviders();
    if (!providers?.length) {
      return { success: false, error: 'storyboard_image_prompt: no providers available' };
    }
    const selected = selectAutoModel('reasoning', 45, providers, { profile });
    if (!selected) {
      return { success: false, error: 'storyboard_image_prompt: no model matched profile' };
    }
    const model = selected.model;

    let res;
    try {
      res = await fetch(`${getGatewayBase()}/chat/completions`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: _SYSTEM_PROMPT },
            { role: 'user', content: user },
          ],
          max_tokens: 1500,
        }),
      });
    } catch (err) {
      return {
        success: false,
        error: `storyboard_image_prompt: gateway fetch failed: ${err?.message || err}`,
      };
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return {
        success: false,
        error: `storyboard_image_prompt: gateway returned ${res.status}: ${txt.slice(0, 300)}`,
      };
    }
    let parsed;
    try {
      parsed = await res.json();
    } catch (err) {
      return {
        success: false,
        error: `storyboard_image_prompt: gateway returned non-JSON: ${err?.message || err}`,
      };
    }
    const prompt = parsed?.choices?.[0]?.message?.content?.trim();
    if (!prompt) {
      return { success: false, error: 'storyboard_image_prompt: empty response from gateway' };
    }
    return { success: true, prompt, model };
  },
};
