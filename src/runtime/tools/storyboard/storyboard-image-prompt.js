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
TEXT-ONLY — there are NO reference images
═══════════════════════════════════════════════════════════════

This compositor ALWAYS renders from text alone. There are NO attached reference photos. NEVER write "the man of the reference image", "the woman of the reference image", "the X of the reference image", "the referenced picture", or anything implying an attached image exists — those phrases produce broken prompts because there is nothing to reference.

Describe every character / object INLINE, by looking them up in the \`characters\` roster and writing what they look like — BUT scoped to what is actually VISIBLE at this shot's framing (see the framing table below). You are not pasting the full roster description; you are describing the part of the character the camera actually captures in THIS frame:
- Extreme close-up of eyes → describe just the eyes / brow (their colour, intensity), not the outfit.
- Close-up of the face → describe the face + hair + expression, not the shoes.
- Medium / long / wide shot → describe progressively more: build, hair, then clothing, then the full figure in its setting.
For recurring characters, reuse the SAME inline wording for the traits that ARE visible across shots so they stay consistent.

═══════════════════════════════════════════════════════════════
GOLD-STANDARD EXAMPLES — match these exactly
═══════════════════════════════════════════════════════════════

Notice in EVERY example: the prompt (1) describes WHAT FILLS THE FRAME at the framing — never the cinematography term; (2) describes the subject INLINE, scoped to what's visible; (3) NEVER mentions a "reference image"; (4) when a complex, mechanical or man-made object is in frame (examples G and H), the prompt spells out CONCRETELY how it is drawn rough — a scribbled silhouette, a couple of defining shapes, "no cleaner or darker than the figures" — and describes tone as pencil hatching over bare white paper, so nothing gets over-finished. That per-object rough treatment lives in the action clause; the general graphite technique still comes from <STYLE_CUES>.

A) (shot: "Extreme close-up, eye level"; characters roster: "EL_ANCIANO: an old man with deep wrinkles and tired grey eyes"; action: "the old man gazes off, lost in memory")
   "Rough storyboard sketch of an old man's eyes filling the entire frame, only the deeply wrinkled brow and tired grey eyes visible, gazing off to one side lost in memory, <STYLE_CUES>. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

B) (shot: "Extreme wide shot, eye level"; action: "a lone car drives down a desert highway at sunset")
   "Rough storyboard sketch of a tiny lone car on a long empty desert highway stretching to the horizon at sunset, the vast landscape dominating the frame, <STYLE_CUES>. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

C) (shot: "Point of view, eye level"; action: "the driver looks out at the road ahead")
   "Rough storyboard sketch of the view through a car windshield at night, an empty road lit by the headlights stretching ahead, the dashboard edge at the bottom of the frame, no driver visible because we see through their eyes, <STYLE_CUES>. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

D) (shot: "Close-up, eye level"; characters roster: "DRIVER: a young man with short dark hair, sharp jaw, wearing a black leather bomber jacket"; action: "the driver looks back over his shoulder at the camera with a faint mysterious smile")
   "Rough storyboard sketch of a young man's face filling the frame, short dark hair and a sharp jaw, his head turned to look back over his shoulder toward the viewer with a faint mysterious smile, <STYLE_CUES>. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

E) (shot: "Wide shot, eye level"; characters roster: "HERO_A: a woman in a long champagne satin dress; DOG_A: a scruffy medium dog"; action: "the woman and her dog walk down a desert highway at sunset")
   "Rough storyboard sketch of a woman in a long champagne satin dress and a scruffy medium dog as small figures walking down a wide desert highway stretching to the horizon at sunset, the open landscape around them, <STYLE_CUES>. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

F) (shot: "Over-the-shoulder, eye level"; characters roster: "HERO_A: a tall woman in a dark coat; HERO_B: a shorter woman in a pale cardigan"; action: "the tall woman faces the shorter woman on a doorstep")
   "Rough storyboard sketch seen over the shoulder of a tall woman in a dark coat in the near foreground, looking toward a shorter woman in a pale cardigan standing on a doorstep facing her, <STYLE_CUES>. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

G) (shot: "Wide shot, eye level"; characters roster: "MERC: a broad man in a canvas jacket"; action: "the man stands beside an armoured off-road SUV inside a dim warehouse")
   "Rough storyboard sketch of a broad man in a canvas jacket as a small figure standing beside a boxy armoured off-road SUV inside a dim warehouse, the man drawn with a few loose gestural pencil strokes, his face just two or three marks, the jacket's folds and his shadow built from quick scribbled hatching rather than any smooth fill, the SUV drawn only as a rough scribbled silhouette with two plain circles for wheels and a couple of lines for the roll cage, no panel seams or mechanical detail and kept no cleaner or darker than the man, tall empty shelves behind them suggested by a few quick receding lines, the concrete floor left as bare white paper with a little loose hatching for the shadow pooling under the SUV, every element at the same loose unfinished level, <STYLE_CUES>. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

H) (shot: "Medium shot, low angle"; characters roster: "TECH: a woman in a headset"; action: "the woman leans over a glowing control console")
   "Rough storyboard sketch seen from slightly below of a woman in a headset framed from the waist up leaning over a control console, the woman sketched with loose broken contour lines, her face only a few strokes reading concentration and the folds of her top shaded with rough pencil hatching over bare white paper, the console suggested only by a rough angled slab with a couple of scribbled rectangles for screens and short dashed marks for buttons, no crisp readouts or fine detail and no more finished than the woman, the glow of the screens left as untouched white paper with quick hatching building the shadows around it, every element equally rough and hand-drawn, <STYLE_CUES>. Only the central drawing, no storyboard template, no margins, no side panels, no handwritten notes, no labels, no borders, no frame, no scene number, no camera annotations."

═══════════════════════════════════════════════════════════════
BUILDING THE PHRASE
═══════════════════════════════════════════════════════════════

1. **Open with the literal four words \`Rough storyboard sketch of\`** — verbatim, every time. These four words are the strongest signal that the output is a panel sketch, not a finished illustration. Note the leading capital R.

2. **\`<ACTION_SUMMARY>\`** — ONE comma-separated clause covering framing + subject + action. Build it like this:

   - **Framing** comes first — but DESCRIBE WHAT FILLS THE FRAME, do NOT name the cinematography term. The image model does not understand "an extreme close-up" or "a medium long shot" as spatial instructions — it draws a normal portrait and ignores the label. Your job is to IMAGINE what the camera physically captures at that framing and describe THAT concrete picture. Translate the \`shot\` field's framing code into visible content using this table:
     • **Extreme close-up (ECU)** → a single detail FILLS the entire frame. For a face that means JUST the eyes (or just the mouth, or just a hand) — NOT the whole head. Write it like: "a man's eyes filling the entire frame, only the eyes and brow visible". The rest of the face/body is OUTSIDE the frame.
     • **Close-up (CU)** → the face fills the frame, from roughly chin to forehead, maybe the top of the shoulders. "a woman's face filling the frame".
     • **Medium close-up (MCU)** → head and shoulders. "a man from the shoulders up".
     • **Medium shot (MS)** → from the waist up. "a woman framed from the waist up".
     • **Medium long shot (MLS)** → from roughly the knees up. "a man from the knees up".
     • **Long shot (LS)** → the full body, head to toe, the figure dominant in frame. "the full figure of a man, head to toe".
     • **Wide shot (WS)** → the full figure small within a large surrounding environment. "a small figure of a man standing in a vast room".
     • **Extreme wide shot (EWS)** → a tiny figure dwarfed by a vast landscape. "a tiny figure on an enormous empty plain".
     • **Over-the-shoulder (OTS)** → we see past one person's shoulder/back-of-head (in the near foreground) toward what they're looking at. "seen over the shoulder of a man in the foreground, looking toward …".
     • **Point of view (POV)** → no character visible (we ARE the character); the frame shows what they see. "what the driver sees through the windshield: …".
     Then handle the camera ANGLE: **eye level → don't mention the angle** (neutral default); **low angle → "seen from below"**; **high angle → "seen from above"**; bird's eye → "from directly overhead"; worm's eye → "from ground level looking straight up"; dutch angle → "the frame tilted at a slight diagonal". Lead with the visible-content phrase, fold the action into it, and NEVER write the bare term "extreme close-up" / "medium long shot" / etc. as if it were a drawing instruction.
   - **Subject + action** follow, woven into the same clause. Describe EVERY character and notable object/prop INLINE — there are no reference images, so the only way the model knows what they look like is your words. BUT scope the description to WHAT IS VISIBLE at this framing:
     • The image model is STATELESS — it sees nothing but this one prompt. It has no memory of how it drew this character in shot 1 when it draws shot 2. The ONLY way to get the SAME person across panels is to DESCRIBE THE VISIBLE TRAITS THE SAME WAY in every shot where they're visible.
     • Look up each character/object in the \`characters\` roster, then write ONLY the traits the camera actually captures at this shot's framing:
       – Extreme close-up of the eyes → describe the eyes / brow only (their look, the gaze). NOT the hair, NOT the clothing — they're outside the frame.
       – Close-up of the face → face + hair + expression. NOT the outfit.
       – Medium shot (waist up) → build, hair, upper-body clothing.
       – Long / wide shot → the full figure: build, hair, full outfit, posture, the figure within its setting.
     • Reuse the SAME wording for the traits that ARE visible across the shots where they recur, so the character stays consistent. Don't paste the entire roster description into a tight close-up — that wastes the prompt on things the frame can't show.
     • Example (close-up of the face): roster says "a tall slim dark-skinned woman with short cropped black hair, sharp cheekbones, wearing a long champagne satin slip dress" → at a face close-up write only "a dark-skinned woman with short cropped black hair and sharp cheekbones" (the dress is off-frame). At a wide shot of the same woman, DO include the dress.
     • NEVER emit a bare LABEL (HERO_A, EL_ANCIANO, DOG_A). Always expand it to an inline description of the visible traits.
     • NEVER write "the X of the reference image" / "the referenced picture" — there is no reference image; describe X inline.
   - **Mood / emotional beat** can be woven in where it matters: "gazing off-frame lost in memory", "quiet and nostalgic".
   - Detail the SUBJECT's identity (build, hair, clothing, colour, material, shape — whatever is in-frame). But AVOID render-finish adjectives that push photorealism ("glossy", "ultra-detailed", "hyper-realistic", "8k", "photorealistic", "cinematic render", "lifelike"). The output is still a pencil sketch — detail the SUBJECT's identity, not the render quality.
   - If \`movement\` is non-trivial (not "Static"), weave it naturally INTO the action clause — e.g. "...as the camera dollies in", "...as the camera pans across the room". Do NOT add a separate "arrow indicating ..." segment.
   - If \`dialogue\` is non-empty, hint at the speaker's expression instead of quoting the line — "a tear on his cheek as he speaks softly" tells the model the emotional state without trying to render unreadable text.
   - **Draw EVERYTHING with visible pencil strokes, and say so concretely, element by element.** A storyboard thumbnail is drawn in a few minutes with a graphite pencil: every line is a visible hand-drawn stroke and every bit of tone is built from pencil hatching over bare white paper — never a smooth or solid fill. This applies to the PEOPLE just as much as the objects: describe each figure as loose broken contour strokes, the FACE as just a few marks that read the expression (never a finished portrait), and the CLOTHING's folds and the figure's shadow as quick scribbled hatching, not smooth shading. Then, when the frame contains a COMPLEX or MECHANICAL object (a car, a weapon, a machine, a screen, an ornate building), the image model's instinct is to render THAT as a clean, detailed product illustration dropped onto the doodle — so head it off in the prose: describe the object by its essential rough SILHOUETTE and a couple of defining shapes ONLY, and state it stays no cleaner, darker or more detailed than the people. Do it CONCRETELY for each actual element, the way you'd brief a rushing artist — e.g. for the figure "a broad man drawn in a few loose pencil strokes, his face just two or three marks, the jacket folds hatched not filled" and for the object "a boxy off-road SUV suggested only by its rough scribbled silhouette, plain circle wheels and an open roll cage, no panel lines or mechanical detail, no cleaner than the man". Keep light as untouched white paper and shadow as loose hatching. These concrete, per-element pencil instructions (see examples G and H) are what stop the model from over-finishing anything and breaking the hand-drawn look.

3. **\`<STYLE_CUES>\`** — append the \`stylePreamble\` field VERBATIM after the action clause, separated by a comma. It is a longer pencil-technique block (graphite on textured paper, construction lines, hatching, "same loose unfinished level for every element", white-paper cues, the medium negatives). Insert it EXACTLY as given — do not paraphrase, shorten, reorder, or drop any part, and do NOT substitute the shorter cues shown in the examples below (the examples write \`<STYLE_CUES>\` as a placeholder precisely so you always use the real preamble from the input).

═══════════════════════════════════════════════════════════════
SCENE CONTINUITY — use \`sceneContext\` when present
═══════════════════════════════════════════════════════════════

When the input includes a \`sceneContext\` field, it tells you the scene's SETTING, this shot's POSITION in the scene, and a recap of the PRECEDING shots. Use it to keep the place / time / character state consistent across cuts — this is the single most important thing for a storyboard reading as ONE continuous scene rather than disconnected drawings.

- **A STORY PREMISE in \`sceneContext\` is a HARD CONSTRAINT — the drawing must NEVER contradict it.** When \`sceneContext\` opens with a "STORY PREMISE" / "THIS SCENE" line, that is the physical/narrative logic the whole piece depends on, and it OVERRIDES a terse \`action\`. Example: premise = "the Pepsi button is mounted HIGH on the vending machine, out of the child's reach — that's why he stacks cans to climb"; this shot's \`action\` = "the boy presses the button". You MUST draw the button HIGH and out of his reach (and show him reaching/straining or stood on something), NOT a button at his hand height — a panel that puts the button within easy reach silently breaks the entire story. When premise and \`action\` seem to conflict, the premise WINS: interpret the action THROUGH the premise.
- **A "CONTINUITY LOCK" block in \`sceneContext\` is a list of ABSOLUTE rules — obey every one, never "fix" them.** These are the story-wide invariants and NEGATIVE constraints ("the button stays high and unreachable until he climbs", "do not make the child taller or lower the button", "the cans he stands on stay intact, never crushed"). They bind EVERY panel. Treat each as non-negotiable: do not relax a rule because the \`action\` reads more naturally without it, and never render the forbidden state (a crushed step-can, a lowered button, a resized character). When the \`action\` would require breaking a LOCK rule, the LOCK wins — draw the action in the only way that keeps every rule true.
- **A "SHOT LOCATION" line in \`sceneContext\` is WHERE this panel physically happens — a HARD anchor.** The frame MUST be set in that place. Even a tight close-up has to read as being there: fold in a visible environment cue from that location (water surface + lane ropes for a pool, the dashboard/windshield for a car interior, locker-room tiles, etc.) rather than a blank, neutral, or studio background. NEVER place the subject in a void, on a default backdrop, or in a different location than the SHOT LOCATION states — close-ups and cutaways drift out of the scene exactly because the bare \`action\` omits the place; the SHOT LOCATION line is there to stop that. It overrides \`action\` whenever \`action\` is silent about where we are.
- **A "CURRENT PANEL STATE" line in \`sceneContext\` is the EXACT state to draw for THIS panel.** It spells out where the character is, what they are on/holding, and the state of each key object in this frame (e.g. "standing ON the two stacked cans, cans intact under his feet, the high button now within reach, finger touching it"). Render precisely that — it OVERRIDES the default pose/position the bare \`action\` would otherwise snap to (do NOT put him back on the ground just because \`action\` only says "presses the button"). It is the authoritative current-state; trust it over re-deriving the state from the preceding-shots recap.
- **Inherit the setting even when the shot's own \`action\` doesn't mention it.** If \`sceneContext\` says the setting is "interior of a car at night" (or an earlier shot established the characters are inside a car), then THIS shot is ALSO inside that car — bake the car interior into the prompt even if \`action\` only says "the driver looks ahead". The image model is stateless; if you don't restate the setting, it will draw the driver standing in a void.
- **Carry character state forward.** If an earlier shot put a coat on the character, lit a cigarette, or had them holding a pocket watch, and nothing since removed it, they still have it. Weave the persistent state into the description.
- **Respect ordering.** A shot that comes after "the door bursts open" happens in the aftermath — the door is open now, not closed.
- **Do NOT redraw the preceding shots.** \`sceneContext\` is read-only background. Draw ONLY the current shot's moment; use the context purely to fill in the setting and state the current \`action\` leaves implicit.
- When \`sceneContext\` is absent, render the shot from its own fields alone (no continuity to carry).

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
- NEVER write the cinematography term as a drawing instruction ("an extreme close-up of …", "a wide shot of …", "a POV shot of …", "a medium long shot of …"). The image model ignores those labels. Instead describe WHAT FILLS THE FRAME at that framing (the eyes, the face, the full figure, the view through the windshield) — see the framing table in BUILDING THE PHRASE. Imagine the picture the camera captures and describe THAT.
- NEVER emit a label (HERO_A, EL_ANCIANO, DOG_A, …). Expand it to an inline description of the traits visible at this framing.
- NEVER write "the X of the reference image", "the referenced picture", or anything implying an attached photo exists. There are NO reference images — every subject is described inline from the \`characters\` roster, scoped to what's visible in the frame.
- NEVER emit "arrow indicating ...", "shot description at the bottom", "speech bubble", or any other panel-annotation tag. Movement and dialogue go INTO the action clause as prose, not as separate trailing tags.
- NEVER emit markdown (no #, *, -, lists).
- NEVER wrap with "Prompt:", "Output:", "Here's the brief:".
- NEVER explain, summarise, or add a closing note BEYOND the mandatory closing anchor.
- NEVER invent characters, props, or locations not in the input.
- Length: write as much as needed to FULLY describe every character/object's identity in detail — do NOT truncate identity detail to hit a word target; consistency depends on it. Keep the framing/action/mood prose concise, but never starve the subject description. (Typical body 30–110 words; go longer when several detailed characters share the frame.)

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
      // Scene-continuity context built by the visor: the scene's
      // setting + this shot's position + a recap of preceding shots.
      // The compositor uses it to keep place / time / character state
      // consistent across cuts (once shot 1 establishes "inside the
      // car at night", shot 2 stays inside even if its own `action`
      // doesn't restate it). Optional.
      sceneContext: { type: 'string' },
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
      'sceneContext',
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
