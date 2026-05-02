import fs from 'fs';
import path from 'path';

import { actionRegistry } from '../agent/action-registry.js';
import { getUserAgentsTeam } from '../agent/md-agent-loader.js';

// =========================================================================
// SYSTEM PROMPT BUILDER — standalone functions extracted from LLMProvider
// =========================================================================

/** Push the shared "TRANSCRIBE every annotation BEFORE acting" step into
 *  [lines]. The single most common failure mode is the agent looking at
 *  a mark, guessing the subject, and getting it wrong because the mark
 *  sits near multiple candidates. Forcing an explicit transcription with
 *  candidate-subjects + resolved-subject + resolution-reason as plain
 *  text in a `print` action BEFORE the real generation surfaces the
 *  agent\'s reasoning to the user (so they catch wrong picks before a
 *  generation is wasted) and reduces hallucinated subject mappings. */
function _pushAnnotationTranscribeGuide(lines) {
  lines.push('**TRANSCRIBE every annotation as INTERNAL reasoning BEFORE acting.** The single most common failure mode is the agent looking at a mark, guessing which subject it refers to, and getting it wrong because the mark sat near multiple candidates. To prevent that, walk through the transcription IN YOUR HEAD (thinking tokens if the model supports them, otherwise just as careful internal reasoning before writing the action JSON). For EACH distinct mark, mentally fill out:');
  lines.push('');
  lines.push('   - mark type — X / arrow / scribble / circle / text-label / freehand');
  lines.push('   - position of the mark on the frame');
  lines.push('   - text-on-mark — verbatim, in the original language ("(none)" if absent)');
  lines.push('   - candidate-subjects-near-mark — every subject the mark could plausibly refer to');
  lines.push('   - resolved-subject — the SINGLE subject after disambiguation');
  lines.push('   - resolution-reason — why you picked it');
  lines.push('');
  lines.push('   **Critical disambiguation rules**:');
  lines.push('   - **User-written text on the annotation OVERRIDES your visual guess.** If the text says *"esta chica"* (female), the subject is female — even if the mark is geometrically closer to a male character. The user wrote what they meant; trust it.');
  lines.push('   - **Language matters**: read the text in its native language. Spanish *"chica"* = girl/woman, *"chico"* = boy/man, *"esta mano"* = this hand (gendered demonstrative). Don\'t translate sloppily — extract gender, role, body part, action verb.');
  lines.push('   - **If the mark sits between two subjects AND the text doesn\'t disambiguate, STOP and `prompt_user`** asking which subject the user meant. Better to ask one question than to ship a generation editing the wrong person.');
  lines.push('   - **An X with text near a body part = constraint on that body part of the SUBJECT WHO OWNS IT, not the body part itself in space.** "que no suba esta mano" near a hand → constrain the woman whose hand it is, not the nearest visually salient figure.');
  lines.push('');
  lines.push('   **DO NOT dump this transcription in a `print` action.** It\'s internal reasoning — the user doesn\'t want to see structured `[transcribe @ ...]` blocks polluting the chat. Keep it in your head; only the final user-facing summary belongs in `print`.');
  lines.push('');
  lines.push('   **What the user DOES see in `print`**: a SHORT human sentence summarising what you understood, in the user\'s language, e.g. *"Entendido — voy a quitar a la chica rubia del asiento trasero derecho y haré que la morena del medio gire la cabeza hacia la derecha sin levantar la mano."* That\'s it. One sentence. No structured reasoning blocks, no candidate lists, no resolution reasons — just a clear restatement of intent.');
}

/** Push the structured-directives format into [lines]. Each user-drawn
 *  mark becomes one numbered, classified, time-anchored directive — the
 *  diffusion model loses anchoring when instructions are merged into a
 *  paragraph. The four categories (PERSISTENT REMOVAL / CONSTRAINT /
 *  TEMPORAL TRANSITION / POINT-IN-TIME) cover every plausible mark
 *  semantics. Use mode="video" when there are explicit per-frame
 *  timestamps; use mode="image" when there\'s only one source frame and
 *  timing is "throughout the clip" / "by end of clip". */
function _pushStructuredDirectivesGuide(lines, mode = 'video') {
  const ts = mode === 'video' ? '<timestamp>' : '<"throughout" | "by end of clip">';
  lines.push('**Decompose intent per individual mark, then classify it.** Treat EACH stroke / X / arrow / text label as ONE atomic instruction. For every distinct mark, identify which of these four temporal categories it belongs to:');
  lines.push('');
  lines.push('   - **PERSISTENT REMOVAL** — a subject is crossed out / X-ed / scribbled over → that subject is GONE from EVERY frame of the output, replaced by what would be behind it (background, scenery, interior). Phrasing: *"Throughout the entire clip, the [hair color + length + clothing + spatial position] is absent — the area where she sat shows [interior/background visible behind]."*');
  lines.push('');
  lines.push('   - **PERSISTENT CONSTRAINT** — an X / strikeout over a body part or gesture, with text like "no", "don\'t", "que no" → that gesture/movement does NOT happen at any moment. Phrasing: *"Throughout the entire clip, the [subject description] keeps her [body part] [described static state]; she does NOT raise/move it at any point."*');
  lines.push('');
  if (mode === 'video') {
    lines.push('   - **TEMPORAL TRANSITION** — an arrow or curve showing motion from state A to state B → describe as a smooth motion that COMPLETES by the marked timestamp, starting from the natural state in earlier frames. Phrasing: *"Between the start of the clip and {marked timestamp}, the [subject] smoothly [described motion]. By {marked timestamp} the rotation has completed."*');
  } else {
    lines.push('   - **TEMPORAL TRANSITION** — an arrow or curve showing motion from state A to state B → describe as a smooth motion that COMPLETES by the end of the generated clip, starting from the still photo\'s state at t=0. Phrasing: *"Starting from the still image and over the duration of the clip, the [subject] smoothly [described motion]. By the end of the clip the motion has completed."*');
  }
  lines.push('');
  lines.push(`   - **POINT-IN-TIME STATE** — a static pose marker pinning the subject\'s state at a specific instant → "At ${mode === 'video' ? '{timestamp}' : 'the end of the clip'}, the [subject] is [described state]." Use sparingly; most marks are one of the three above.`);
  lines.push('');
  lines.push('**Build the prompt as a numbered list with EXPLICIT time anchors**, never as a single paragraph. The diffusion model loses temporal anchoring when instructions are merged. Each directive must reference its `resolved-subject` from the transcribe step verbatim — do not paraphrase the subject description across directives, the model must see the same noun phrase to know it\'s the same person. Strict format:');
  lines.push('');
  lines.push('   ```');
  lines.push(mode === 'video'
    ? '   Edit the source video with these per-instruction directives:'
    : '   Animate the source image with these per-instruction directives:');
  lines.push(`   1. [PERSISTENT REMOVAL @ ${ts}] <one full sentence naming subject by physical attributes + spatial position + what fills the empty space>.`);
  lines.push(`   2. [PERSISTENT CONSTRAINT @ ${ts}] <one full sentence>.`);
  lines.push(`   3. [TEMPORAL TRANSITION @ ${ts}] <one full sentence with motion arc and completion ${mode === 'video' ? 'timestamp' : 'point'}>.`);
  lines.push('');
  lines.push('   Static elements to preserve unchanged across the entire clip: <explicit comma-separated list of every other subject and the background — driver, other passengers, vehicle, exterior, lighting, camera framing>.');
  lines.push('   ```');
  lines.push('');
  lines.push('   **Why this format works**: the model parses each numbered line as a separate constraint with an attached time anchor. A single paragraph blends them and the diffusion averages them across the clip — which is exactly what produced wrong outputs in earlier tests (subject X removed instead of Y, gesture happening at the wrong moment, etc.).');
}

/** Push the shared "describe the marked subject surgically" guidance
 *  into [lines]. Used by the image-photomontage block and the per-frame
 *  video-annotations block — both rely on the agent translating drawn
 *  marks into a prompt detailed enough that a model which never saw
 *  the annotation can pick out the right subject. The instructions are
 *  identical across image / video; what differs is the wrapping
 *  workflow, so we factor the inner block once and call it from both
 *  places. */
function _pushSurgicalAnnotationGuide(lines) {
  lines.push('**Interpret the marks**:');
  lines.push('   - red X / cross-out / scribble over a subject → remove that subject.');
  lines.push('   - arrow → motion direction or trajectory ("move from A to B", "swerve left", "accelerate forward").');
  lines.push('   - circle / rectangle → focus region, or "this is what I mean".');
  lines.push('   - freehand outline → the area to change.');
  lines.push('   - text label → literal instruction.');
  lines.push('');
  lines.push('**Two distinct uses of the marks — separate them carefully:**');
  lines.push('');
  lines.push('**(A) IDENTITY pointer — DO use the mark.** The annotation composite ships as a referenceImage; the model\'s vision encoder SEES the red X / red scribble / red circle overlaid on top of a specific face or object. That makes the mark a **perfect visual pointer to WHO/WHAT** the user is referring to. Reference it explicitly as your primary disambiguator:');
  lines.push('   - ✓ *"the subject identified by the prominent red X mark visible in the reference image labelled `[ANNOTATIONS @ 00:03.042]` — the person on whom the X is overlaid"*');
  lines.push('   - ✓ *"the subject covered by the red scribble in the second reference image"*');
  lines.push('   - ✓ *"the figure inside the red circle drawn at 00:04.250"*');
  lines.push('   This is by far the strongest disambiguator available because it bypasses every ambiguity in prose (colour, ordinals, geometry) — the model directly sees which pixels are marked and locks onto the subject under those pixels.');
  lines.push('');
  lines.push('**(B) ACTION semantics — do NOT use the mark.** The model sees the mark visually, but it does NOT interpret what the mark MEANS as an instruction. *"Follow the red arrow"* is meaningless to the model — it sees an arrow, but doesn\'t know "arrow = motion vector to follow". You translate the action into PROSE; the prose is what conditions the generation:');
  lines.push('   - ❌ *"follow the red arrow"* — model sees the arrow but doesn\'t know what to do with it');
  lines.push('   - ✓ *"the subject under the red arrow accelerates diagonally toward the centre-left, overtaking the black car"* — uses the arrow as identity pointer, but encodes the motion in prose');
  lines.push('');
  lines.push('Action-prose templates (paired with mark-as-pointer for identity):');
  lines.push('   - **Arrow → motion language.** Direction (left → right, top-down, foreground-to-background, diagonal sweep), speed (slow drift, accelerate, sudden burst), trajectory shape (straight line, arc, curve, zigzag), magnitude (just slightly, halfway across the frame, exits frame).');
  lines.push('   - **X / cross-out → "remove" + identity pointer.** Example: *"Remove the subject identified by the prominent red X mark visible in `[ANNOTATIONS @ 00:03.042]` — she should not appear in any frame of the output."*');
  lines.push('   - **Circle / rectangle → "focus on" + identity pointer + what to do.** *"The figure circled in red in the reference image — turn her head smoothly to the right."*');
  lines.push('');
  lines.push('**Identify the marked SUBJECT with HYPER-PRECISE, CONTRASTIVE detail.** Before writing the prompt you MUST describe the marked subject so unambiguously that a model which has never seen the annotation can pick it out from the rest of the source. Vague descriptions like "the woman" or "the blonde" are routing failures — there are typically multiple women / blondes / similar subjects in frame and the model picks the wrong one half the time.');
  lines.push('');
  lines.push('A precise description STACKS multiple disambiguators until exactly one subject in the scene fits. Provide ALL of these:');
  lines.push('');
  lines.push('**THE UNIVERSAL DISAMBIGUATION FORMULA — ALWAYS use anchor #0 + the 3 spatial anchors below, IN THIS ORDER, for EVERY subject reference. Colour/clothing/age go LAST as tie-breakers ONLY.**');
  lines.push('');
  lines.push('⏱ **CRITICAL — every spatial anchor is TEMPORAL**, because video subjects move (camera pans, people walk, cars drive). A position description without a timestamp is meaningless: the woman who is "in the right 18% of the frame" at t=0 may be at the centre at t=2 and out of frame at t=4. ALWAYS anchor every position description to the EXACT timestamp of the source frame the user marked. The temporal anchor is what lets the video model lock onto the right pixel region in the source and follow it through time.');
  lines.push('');
  lines.push('**0. MARK-AS-IDENTITY-POINTER (PRIMARY — strongest possible anchor)** — the user\'s mark itself is visible in the annotation composite that ships as `referenceImages[i]`. Use it as a visual pointer with the GENERIC placeholder syntax `@ref1`, `@ref2`, … (1-indexed). `@ref1` refers to `referenceImages[0]`, `@ref2` refers to `referenceImages[1]`, etc.');
  lines.push('   - *"the subject identified by the prominent red X mark visible in @ref1 (the annotated frame at 00:03.042) — the person on whom the red X is overlaid"*');
  lines.push('   - *"the figure covered by the red scribble in @ref2 (annotated frame at 00:04.250)"*');
  lines.push('   This bypasses every prose ambiguity (colour, ordinals, geometry) because the model\'s vision encoder DIRECTLY SEES which pixels are marked and locks onto the subject under those pixels. Anchors 1-3 below act as REINFORCEMENTS in case the model under-weights the visual mark.');
  lines.push('');
  lines.push('   **Don\'t hard-code provider-specific reference syntax** (`@Image1`, `<image>`, `[image-1]`, etc.). Always use `@refN`. The gateway translates `@refN` to whatever syntax the resolved model expects (e.g. `@ImageN` for Kling family, descriptive prose for models that don\'t support explicit refs). You don\'t know which model will be picked at write time — let the runtime handle the dialect.');
  lines.push('');
  lines.push('   **Hard limit: max 4 reference images total** (some video adapters cap at 4; safer ceiling for the rest). If the user marked more than 4 frames, prioritise the frames with the most distinct subjects/instructions and drop the rest.');
  lines.push('');
  lines.push('⏱ **TIMESTAMPED + TRACKED** — every spatial description anchors to the EXACT timestamp of the marked frame, plus a tracking clause so the model carries identity through subject/camera motion across the rest of the clip.');
  lines.push('');
  lines.push('1. **One natural-language landmark (mandatory, TIMESTAMPED)** — on top of the @ref1 mark, give the model ONE simple human-language description that any human caption-writer would write spontaneously, NOT engineering pseudo-coordinates. Diffusion models were trained on natural image captions, not on UI percent bands.');
  lines.push('');
  lines.push('   ❌ Pseudo-coordinate jargon (the model handles these badly):');
  lines.push('       *"the rightmost 18% of the camera frame"*');
  lines.push('       *"frame-right of the other woman"*');
  lines.push('       *"upper-right quadrant"*');
  lines.push('       *"rightmost in frame of the two women"*');
  lines.push('   ❌ Vehicle / 3D-scene coordinates (introduce LHD/RHD ambiguity):');
  lines.push('       *"the far-right window of the car"*');
  lines.push('       *"on the passenger side"*');
  lines.push('       *"behind the driver"*');
  lines.push('   ✓ Natural-language anchors (model resolves these well):');
  lines.push('       *"the woman closest to the camera"*');
  lines.push('       *"the woman seated nearest the back of the vehicle"*');
  lines.push('       *"the woman whose face is partly cropped by the edge of the shot"*');
  lines.push('       *"the woman next to the open window"*');
  lines.push('       *"the woman seated in the very last seat row"*');
  lines.push('       *"the woman immediately behind the man with green-and-orange face paint"* (use UNIQUE landmarks the model can\'t miss — face paint, a distinctive hat, the steering wheel, etc.)');
  lines.push('');
  lines.push('   Pick **ONE** such anchor — not five. More anchors compete for attention and the model averages them, often landing on the wrong subject. The @ref1 mark is the primary signal; one simple natural-language landmark reinforces it.');
  lines.push('');
  lines.push('2. **What to KEEP — the OTHER subject(s) by their own natural anchor.** Mirror the same single-landmark style for the subjects that must remain unchanged. Don\'t describe them by what they\'re NOT (negative anchors confuse diffusion); describe them positively by their OWN landmark:');
  lines.push('   ✓ *"keep the OTHER woman in the back of the vehicle, the one seated closer to the driver, exactly as she appears in the source"*');
  lines.push('   ✓ *"keep the man with green-and-orange face paint in the driver\'s seat"*');
  lines.push('   ✓ *"keep the boy in the front leaning out of the window"*');
  lines.push('   ❌ *"keep the woman who is NOT in the rightmost 18% of the frame"* — pure negative, hard for diffusion');
  lines.push('');
  lines.push('3. **Tracking clause (mandatory, ONCE per subject reference)** — because models don\'t implicitly assume a static frame description carries through time:');
  lines.push('   - *"Track this same subject across every frame of the source video — even when motion (camera tracking, vehicle movement, the subject\'s own movement) changes her on-screen position"*');
  lines.push('   - This signals the model to maintain identity correspondence rather than re-resolving the description per-frame.');
  lines.push('');
  lines.push('**Tie-breakers ONLY (use sparingly, after the 4 anchors above):**');
  lines.push('   - Physical attributes — hair length & style ("long straight hair past shoulders" vs "short bob"), distinctive accessories (glasses, hat, face paint, visible tattoo), pose AT THE MARKED TIMESTAMP (hand raised, looking left, sitting upright vs slouched).');
  lines.push('   - Clothing — only when the colour contrast is unmistakable (black vs white, red vs blue).');
  lines.push('');
  lines.push('**FORBIDDEN as primary disambiguators** (cause wrong-subject errors):');
  lines.push('   - ❌ Hair colour adjectives ("blonde", "brunette", "redhead") — diffusion models conflate light-brown / blonde / dirty-blonde under variable lighting.');
  lines.push('   - ❌ Clothing colour without high contrast — "navy" vs "black" vs "dark grey" all look the same in shadow.');
  lines.push('   - ❌ Subjective traits ("the older one", "the prettier one") — model can\'t resolve.');
  lines.push('   - ❌ Window-count or seat-count as the primary anchor — depends on whether you include pillar/quarter/sunroof windows.');
  lines.push('');
  lines.push('   ✓ Example for the ambiguous SUV-with-two-women-in-back case (user marked frame at 00:03.042 with a red X; that composite ships as `referenceImages[0]` ↔ `@ref1`):');
  lines.push('     *"The female passenger identified by the prominent red X mark visible in @ref1 (the annotated frame at 00:03.042 — the person on whom the red X is overlaid). She is the woman seated nearest the back of the vehicle, the one whose face is partly cropped by the edge of the shot at 00:03.042. Track this same subject across every frame of the source clip — her position on screen will shift as the camera tracks the moving vehicle, but identity stays locked to whoever the red X in @ref1 marks. Throughout the entire output she is absent, replaced by the vehicle\'s interior visible behind her seat. Keep the OTHER woman in the back of the vehicle (the one seated closer to the driver) unchanged across every frame, and keep the man with green-and-orange face paint, the boy leaning out of the front window, the wood-panel exterior, the desert background, and the camera framing exactly as in the source."*');
  lines.push('     Notice: ONE strong identity pointer (red X in @ref1) + ONE natural-language anchor ("seated nearest the back of the vehicle / face partly cropped by the edge"). The OTHER woman is described positively by her OWN landmark ("seated closer to the driver"), not negatively as "not the rightmost". Tracking clause. No engineering jargon ("rightmost 18% of frame", "frame-right of"), no vehicle 3D reasoning ("passenger side", "far-right window"), no colour adjectives. Less prose, less competition for attention, stronger signal.');
  lines.push('');
  lines.push('3. **Pose / action / framing at the marked moment** — what is the subject DOING right now (sitting still, looking out the window, hand on the door, eating, talking), which way is she/he facing (toward camera, profile-left, profile-right, three-quarter back), what part of the body is visible (face only, head and shoulders, full body cropped at chest).');
  lines.push('');
  lines.push('4. **CONTRASTIVE callout — name the OTHER subjects you are NOT referring to.** This is the single highest-leverage trick. After describing the target, immediately list every other similar subject in frame and explicitly say "NOT" them:');
  lines.push('   ✓ *"The blonde long-haired woman in the rear-right window seat (the rightmost passenger, leaning slightly toward the door, only her head and right shoulder visible above the window line) — NOT the brunette woman seated immediately to her left, NOT the man with green-and-orange face paint in the front passenger seat, NOT the young man behind the driver."*');
  lines.push('   ✗ *"The blonde woman in the back."* ← ambiguous when there are multiple women in the back.');
  lines.push('');
  lines.push('5. **What to keep static — full inventory.** List EVERY other subject AND the background AND camera AND lighting AND vehicle / setting elements, all explicitly preserved. This is one of the highest-leverage sentences in the prompt because diffusion models default to changing things you didn\'t pin down.');
  lines.push('   ✓ *"Keep ALL of the following completely unchanged across every frame: the driver with the green-and-orange face paint, the young man in the front passenger seat, the OTHER woman in the rear seat (the one closer to the centre of the back row), the SUV\'s wood-panel exterior and chrome trim, the desert highway background with sparse vegetation, the dust kicked up behind the vehicle, the mid-day sunlight, the steady tracking-shot camera framing."*');
  lines.push('');
  lines.push('6. **Add a numeric OUTCOME-VERIFICATION sentence.** Diffusion models are bad at counting and at the "remove A but keep B" task when A and B are similar adjacent subjects. They tend to "average" and remove both, or remove neither, or hallucinate a hybrid. Force the model to commit to a count by adding an explicit expected-count clause at the end of the prompt:');
  lines.push('   ✓ *"After this edit, the rear of the car must show EXACTLY ONE woman: the one previously seated in the middle of the back row (NOT two women, NOT zero women). The rear-right window where the removed woman was sitting now shows the SUV\'s interior upholstery and the desert visible through the glass — no human figure occupies that space at any frame."*');
  lines.push('   This kind of explicit count sentence acts as a self-check signal that even mid-tier video models can latch onto, reducing the "remove both" failure mode.');
  lines.push('');
  lines.push('Generic prompts ("edit this", "remove the woman", "the marked one", "animate this") will not produce the right output — the user took the time to draw, the prompt MUST reflect what they drew at the level of detail above, expressed in **frame-coordinate + visual-ordinal + relative-anchor** language. Colour and clothing are tie-breakers only.');
}

/** Format a millisecond playhead position as MM:SS.ms (zero-padded). Used
 *  to label per-frame video annotations in the WORKING AREA block so the
 *  agent can correlate marks to the source timeline. */
function _formatVideoTs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '00:00.000';
  const totalSec = Math.floor(ms / 1000);
  const millis = Math.round(ms - totalSec * 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec - minutes * 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');
  return `${mm}:${ss}.${mmm}`;
}

/**
 * Build the system prompt for all agents.
 * Single unified prompt — only the available intents change per agent.
 * @param {Agent} agent - The agent
 * @returns {{ static: string, dynamic: string }} Complete system prompt
 */
export async function buildSystemPrompt(agent) {
  const hasTeams = agent && agent.usesTeams && agent.usesTeams.length > 0;
  const resourceSection = await buildSmartResourceSection(agent);
  const intentNesting = hasTeams ? '\nIMPORTANT: Do NOT nest "intent" inside "data". The "intent" field must be at the top level.' : '';
  const koiMd = loadKoiMd(); // Always inject — project specs apply to all agents

  // ── Runtime Context block (universal for all agents) ──
  // Use local time with UTC offset so the LLM knows the user's timezone.
  // e.g. "2026-03-22T21:53:14+01:00" instead of "2026-03-22T20:53:14" (ambiguous UTC)
  const _now = new Date();
  const _pad = (n) => String(n).padStart(2, '0');
  const _offsetMin = _now.getTimezoneOffset(); // negative for east of UTC
  const _absH = _pad(Math.floor(Math.abs(_offsetMin) / 60));
  const _absM = _pad(Math.abs(_offsetMin) % 60);
  const _offsetStr = `${_offsetMin <= 0 ? '+' : '-'}${_absH}:${_absM}`;
  const now = `${_now.getFullYear()}-${_pad(_now.getMonth() + 1)}-${_pad(_now.getDate())}T${_pad(_now.getHours())}:${_pad(_now.getMinutes())}:${_pad(_now.getSeconds())}${_offsetStr}`;
  const cwd = process.cwd();
  // Platform — tell the agent explicitly so it picks the right shell
  // builtins. Without this, agents guess from cwd shape ("/Users/..." →
  // mac, "C:\..." → Windows) and often propose bash-only commands
  // (`ls`, `chmod`, `rm -rf`) on Windows where they don't exist.
  const _platformLabel = process.platform === 'darwin' ? 'macOS (darwin)'
    : process.platform === 'win32' ? 'Windows (win32) — shell is cmd.exe / PowerShell, NOT bash. Use `dir`, `type`, `copy`, `move`, `del`, `where`, `mkdir`. PowerShell cmdlets also work: `Get-ChildItem`, `Remove-Item`, `Test-Path`'
    : process.platform === 'linux' ? 'Linux'
    : process.platform;
  const platformField = `\n| Platform | ${_platformLabel} |`;
  const agentDisplayName = agent?.name || 'unknown';
  const statusPhase = agent?.state?.statusPhase || null;
  const phaseField = statusPhase ? `\n| Current phase | \`${statusPhase}\` |` : '';
  // User language — set automatically by the inbox classifier ("ear")
  // when a user message arrives. Agents never set it themselves; it is
  // always authoritative for the language of the user's latest message.
  const stateLanguage = agent?.state?.userLanguage;
  if (stateLanguage) globalThis.__koiUserLanguage = stateLanguage;
  const userLanguage = globalThis.__koiUserLanguage || null;
  const langField = userLanguage ? `\n| User language | ${userLanguage} |` : '';

  // Timezone (IANA)
  let timezone = '';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}

  // ── Phase system explanation (only when agent uses phases) ──
  const hasPhaseDone = agent?.hasPermission?.('phase_done') ?? (agent?._availableActions?.has?.('phase_done') ?? true);
  const phaseSystemBlock = statusPhase ? `
========================================
PHASE SYSTEM
========================================

You operate in phases. Each phase controls which actions, agents, and rules are loaded — keeping your context focused and minimal.

Your current phase is \`${statusPhase}\`. Only the actions and agents relevant to this phase are shown below.

**You do NOT choose your phase.** Phase transitions are handled by the runtime based on events declared in the agent's reactions block (user messages, delegate returns, errors, phase completion). The \`statusPhase\` field is read-only from your point of view — any attempt to change it via \`update_state\` will be silently ignored.

When you finish all the work that belongs to the current phase, call \`phase_done\` to signal completion. The runtime will then fire the \`phase.done\` event and transition to the next phase based on the agent's reactions. Do not try to pick the next phase yourself.
` : '';

  // prompt_user requires 'prompt_user' permission — only System and ProjectOnBoarding have it
  const hasPromptUser = agent?.hasPermission?.('prompt_user') ?? false;

  // Non-interactive mode: agent must act without asking for confirmation
  const nonInteractiveBlock = process.env.KOI_EXIT_ON_COMPLETE === '1' ? `

========================================
NON-INTERACTIVE MODE
========================================

You are running in non-interactive (headless) mode. There is no human to answer follow-up questions.

**CRITICAL RULES:**
- Do NOT ask for confirmation — execute actions directly.
- Do NOT use prompt_user to ask "Do you want me to...?" — just do it.
- Complete the ENTIRE task autonomously: investigate, implement, verify.
- Only call prompt_user at the very end to report what you did.

**USE TOOLS, NOT YOUR OWN KNOWLEDGE:**
- You are an agent with access to tools (shell, web_search, read_file, etc.). Use them.
- If a task requires domain expertise you lack (chess, math, science, music, etc.), search the web for APIs, libraries, or tools that can help. Install them with shell and use them programmatically.
- Example: for chess analysis, install stockfish or python-chess. For math proofs, use sympy. For image processing, use python libraries. Never try to solve domain-specific problems from memory alone.

**ANNOTATION IMAGES — user instructions drawn on screen:**
- Attachments marked as ANNOTATION are screenshots where the user has drawn arrows, circles, crosses, or text directly on the screen to indicate changes they want.
- Annotations are INSTRUCTIONS, not decorations. Examine them carefully to understand what the user wants changed: circled elements mean "change this", crossed-out elements mean "remove this", arrows mean "move this", text annotations are literal instructions.
- IGNORE annotation colors (red, blue, green, etc.) — they are just visual markers to make annotations visible. The color of an annotation does NOT mean "make it this color". A red circle around text means "change this text", not "make this text red".
- When the user says "haz ese cambio" / "make that change" with annotations attached, the annotations ARE the change description. Do NOT ask what to change — look at the annotations.
- If both an original image and an annotated version are attached, compare them to understand the differences the user wants.

**VERIFY DATA EXTRACTED FROM IMAGES:**
- When you extract spacial data from an image (positions, coordinates, ...), ALWAYS verify it programmatically before using it.
- If validation fails, re-read the image more carefully and try again.${agent?.hasPermission?.('delegate') ? '\n- When delegating a task that depends on image data, reference attachments by their ID (e.g. att-1). The delegate can call read_file("att-1") to access the image. NEVER include raw file paths — always use attachment IDs.' : ''}
` : '';

  // BRAXIL.md / CLAUDE.md is already injected via koiMd (_loadKoiMd) above.

  // ── Prompt layout: STATIC content first (cacheable), DYNAMIC content last ──
  // LLM prompt caching works on identical prefixes — the longer the unchanging
  // prefix, the higher the cache hit rate. Static rules/tools go first;
  // runtime context (timestamp, phase, cwd) goes at the end.
  //
  // NOTE: koiMd (BRAXIL.md / CLAUDE.md) is returned separately so
  // buildReactiveSystemPrompt can inject it as the VERY FIRST thing in the
  // prompt, before even the agent's playbook.
  const staticPart = `
========================================
OUTPUT CONTRACT (MUST FOLLOW)
========================================

Return exactly ONE valid JSON object and nothing else.
- No markdown
- No explanations
- No prose
- Response must start with { and end with }

Never output invalid JSON. Invalid JSON crashes the system.

========================================
GOLDEN RULE (ABSOLUTE)
========================================

You are FORBIDDEN from generating any fact, summary, analysis, conclusion, or user-facing content that has not been obtained from an actual action result in this conversation.

If the task requires reading a file, fetching a URL, running a command, or retrieving any external/internal data, you MUST do it in separate steps:

1) emit only the retrieval action
2) wait for the real result
3) only then emit analysis, summary, print, or return content based on that result

NEVER combine in the same batch:
- a retrieval action (read_file, shell, web_fetch, web_search, grep, search, semantic_code_search, etc.)
with
- a print, answer, summary, conclusion, or return payload that depends on that retrieval

Until the action result exists in the conversation, any such content would be fabricated.

Always follow:
retrieve first → wait for result → analyze/respond

This rule overrides any optimization, batching preference, or attempt to save steps.
Correctness beats fewer steps.

========================================
ACTION MODEL
========================================

Every action object MUST include:
- "actionType"
- "intent"

ONE action = ONE intent = ONE object. Each object contains ONLY the fields defined for that specific intent. NEVER add fields from a different intent into the same object — extra fields are silently ignored and the second action will NOT execute. If you need two actions, use a batch with two separate objects.

Valid action types:
- "direct"${hasTeams ? '\n- "delegate"' : ''}

Intent rules:
- For direct actions: "intent" MUST be exactly one of AVAILABLE ACTIONS.${hasTeams ? '\n- For delegate actions: "intent" MUST follow "agentKey::eventName" and refer to a valid available agent/event.' : ''}
- Never invent new intents.
- Never put descriptive text inside "intent". Put that text in "query", "pattern", "message", "question", or other parameters.

Invalid:
{ "actionType": "direct", "intent": "semantic index supported languages" }

Valid:
{ "actionType": "direct", "intent": "semantic_code_search", "query": "semantic index language parser support" }

========================================
BATCH
========================================

"batch" is a TOP-LEVEL-ONLY key. It cannot coexist with "actionType", "intent", or any other action field. If you need to do multiple things in one turn (e.g. print + phase_done), use a batch:

{ "batch": [
  { "actionType": "direct", "intent": "print", "message": "Here is the result." },
  { "actionType": "direct", "intent": "phase_done" }
]}

========================================
EXECUTION FLOW
========================================

Your response MUST be ONE JSON object per step and it MUST be one of two forms — never mix them:
1. A single action: { "actionType": "direct", "intent": "...", ... }
2. A batch: { "batch": [ ...actions... ] }

Use sequential steps only when later actions depend on earlier results.

Parallelism is mandatory:
- If 2+ actions are independent, they MUST go inside a "parallel" block
- Never place independent actions sequentially in a batch${hasPromptUser ? '\n- EXCEPTION: prompt_user must NEVER be inside a parallel block' : ''}

Examples:

Single action:
{ "actionType": "direct", "intent": "semantic_code_search", "query": "authentication login session token" }

Parallel:
{
  "batch": [
    {
      "parallel": [
        { "actionType": "direct", "intent": "semantic_code_search", "query": "semantic index build embed vector store" },
        { "actionType": "direct", "intent": "semantic_code_search", "query": "language support parser javascript typescript python" }
      ]
    }
  ]
}

Sequential then parallel:
{
  "batch": [
    { "actionType": "direct", "intent": "read_file", "path": "src/index.ts", "offset": 0, "limit": 120 },
    {
      "parallel": [
        { "actionType": "direct", "intent": "grep", "pattern": "semanticIndex" },
        { "actionType": "direct", "intent": "grep", "pattern": "supportedLanguages" }
      ]
    }
  ]
}

Only emit:
{ "actionType": "direct", "intent": "return", "data": { ... } }
when the full task is complete.

Do not return early.
Do not treat exploration alone as task completion.
You must complete all required follow-up actions before returning.

========================================
FINAL NON-NEGOTIABLE RULES
========================================

1. Never answer in natural language
2. Never invent intents
3. Never fabricate facts not present in action results
4. Never emit incomplete actions
5. Never return before the whole task is done
6. Always prefer evidence over speculation

${resourceSection}${intentNesting}

CRITICAL: Return a single JSON action or { "batch": [...] }. No markdown.`;

  // ── Working area: documents the user has open in the GUI ──
  // Pulled from the in-memory store (open-documents-store), populated by the
  // CLI layer when the GUI reports tab changes.
  let openDocumentsBlock = '';
  try {
    const { openDocumentsStore } = await import('../state/open-documents-store.js');
    // Diagnostic: log the working-area state at every prompt build so we
    // can tell, when the # WORKING AREA block is mysteriously absent,
    // whether the store was empty (GUI never pushed / pushed empty),
    // populated correctly, or populated then cleared. Also surfaces the
    // hash of doc ids so repeated empty pushes are visible.
    try {
      // Read from the TURN SNAPSHOT, not the LIVE store. The snapshot is
      // pinned when a user input arrives and stays immutable for the
      // rest of the turn — so the agent's WORKING AREA view stays
      // anchored to what the user saw at submit time, regardless of
      // tabs the agent or GUI auto-opens mid-turn.
      const _docs = openDocumentsStore.getSnapshotAll();
      const _active = openDocumentsStore.getSnapshotActive();
      const _pinnedAt = openDocumentsStore.snapshotPinnedAt();
      const { channel: _ch } = await import('../io/channel.js');
      _ch.log(
        'prompt',
        `[working-area] turn-snapshot has ${_docs.length} doc(s)` +
        (_docs.length > 0
          ? ` [${_docs.map((d) => `${d.type}:${d.title || d.id}`).join(', ')}]` +
            (_active ? ` active=${_active.id}` : ' active=(none)')
          : ' — # WORKING AREA block will be omitted from the system prompt') +
        (_pinnedAt ? ` (pinned ${Math.round((Date.now() - _pinnedAt) / 1000)}s ago)` : ' (no snapshot yet, falling back to live)'),
      );
      // Per-doc bundle inventory — tells us whether each doc carries
      // annotations / references when the prompt is built. The WORKING
      // AREA section only renders annotation composites when a bundle
      // is present and bundle.annotations[].length > 0; if the GUI
      // failed to attach the bundle the agent never sees the marks.
      for (const _d of _docs) {
        const _b = _d.bundle;
        if (!_b) {
          _ch.log('prompt', `[working-area] doc ${_d.type}:${_d.title || _d.id} → bundle=NONE (annotations will NOT appear in prompt)`);
          continue;
        }
        const _anns = Array.isArray(_b.annotations) ? _b.annotations : [];
        const _refs = Array.isArray(_b.references) ? _b.references : [];
        _ch.log(
          'prompt',
          `[working-area] doc ${_d.type}:${_d.title || _d.id} → ` +
          `bundle annotations=${_anns.length}` +
          (_anns.length > 0 ? ` [${_anns.map((a) => a.role || 'unknown').join(', ')}]` : '') +
          ` refs=${_refs.length}` +
          ` primary=${_b.primary?.path ? _b.primary.path.split('/').pop() : '(none)'}`,
        );
      }
    } catch { /* best-effort logging */ }
    const active = openDocumentsStore.getSnapshotActive();
    // Render only the ACTIVE document. Non-visible tabs are intentionally
    // omitted — they add noise without helping the agent route the
    // current request. With no active doc there's nothing to surface, so
    // the # WORKING AREA block is dropped entirely.
    if (active) {
      let anyHasComposite = false;
      const lines = ['', '# WORKING AREA', ''];
      {
        const loc = active.path || active.url || '';
        lines.push(`The user is currently looking at: [${active.type}] ${active.title}${loc ? ' — `' + loc + '`' : ''}`);
        // For videos, surface the exact playhead position so the agent
        // knows which frame the user is paused on. The GUI stamps
        // `playheadMs` onto the video doc payload at submit time.
        if (active.type === 'video' && typeof active.playheadMs === 'number') {
          lines.push(`Playhead paused at \`${_formatVideoTs(active.playheadMs)}\` (MM:SS.ms).`);
        }

        // DocumentBundle — compact rendering. Only the fields the agent
        // actually needs to route a media action: annotation paths (the
        // visual intent spec — one for images, one-per-frame for videos),
        // reference paths (forwarded to generate_image as extra refs).
        // Roles are implicit in the labels ("composite" / "frame
        // composites" / "references"); per-resource prose lives in the
        // code, not in the prompt.
        const b = active.bundle;
        if (b && typeof b === 'object') {
          const anns = Array.isArray(b.annotations) ? b.annotations : [];
          if (anns.length > 0) {
            anyHasComposite = true;
            const isVideo = anns.some((a) => a && a.role === 'video-frame-composite');
            if (isVideo) {
              lines.push(`    ↳ frame composites (${anns.length}):`);
              for (const a of anns) {
                const tsMs = typeof a.frameTimestampMs === 'number' ? a.frameTimestampMs : null;
                const tsLabel = tsMs != null ? _formatVideoTs(tsMs) : '?';
                const idxLabel = typeof a.frameIndex === 'number' ? ` (frame ${a.frameIndex})` : '';
                lines.push(`        @ ${tsLabel}${idxLabel}: \`${a.path}\``);
              }
            } else {
              // Image case — single composite snapshot.
              lines.push(`    ↳ composite: \`${anns[0].path}\``);
            }
          }
          if (Array.isArray(b.references) && b.references.length > 0) {
            anyHasComposite = true;
            const refPaths = b.references
              .map((r, i) => `        ${i + 1}. \`${r.path}\``)
              .join('\n');
            lines.push(`    ↳ references (${b.references.length}):`);
            lines.push(refPaths);
          }
          if (b.primary?.path && b.primary.path !== loc) {
            lines.push(`    ↳ snapshot: \`${b.primary.path}\``);
          }
        }
      }

      // Crystal-clear routing guidance when the active doc carries any
      // user-placed spatial guidance (annotations or pasted cutouts).
      // Without this block the agent keeps calling generate_image with
      // the reference paths in an unlabelled flat array and the model
      // has no idea which is base / composite / source — it just
      // averages them, which is exactly the "model invents things"
      // failure mode the user was hitting.
      // Image photomontage routing — only fires for image-type active
      // docs with at least one composite-snapshot annotation. Video docs
      // with annotations are handled in the video-to-video block below.
      const activeIsImage = active && active.type !== 'video';
      const activeAnnsForBlock = activeIsImage && active.bundle?.annotations
        ? active.bundle.annotations.filter((a) => a?.role === 'composite-snapshot')
        : [];
      if (anyHasComposite && activeIsImage && active && (active.path || active.url) && (activeAnnsForBlock.length > 0 || (active.bundle?.references?.length ?? 0) > 0)) {
        const activeLoc = active.path || active.url;
        const activeBundle = active.bundle || {};
        const activeRefs = Array.isArray(activeBundle.references)
          ? activeBundle.references.map((r) => r.path).filter(Boolean)
          : [];
        const activeOverlay = activeAnnsForBlock[0]?.path || null;
        const hasDrawnMarks = activeOverlay !== null;
        const refList = [activeLoc, activeOverlay, ...activeRefs].filter(Boolean);
        const refJson = JSON.stringify(refList);
        // Animation references: ONLY the composite — the base image goes
        // to `startFrame` (image-to-video conditioning), not to
        // `referenceImages`. Putting the base in both is redundant and
        // some adapters reject duplicates.
        const animRefList = [activeOverlay].filter(Boolean);
        const animRefJson = JSON.stringify(animRefList);
        const saveDir = activeLoc.replace(/\/[^/]+$/, '');
        lines.push('');
        lines.push('## ⚠ ACTIVE document is a photomontage — act, do not ask');
        lines.push('');
        lines.push('The composite IS the spec. Forbidden to ask "qué composición?" / "which composition?"; the answer is the image already attached.');
        lines.push('');
        lines.push(`1. **read_file "${activeLoc}"** first. Vision receives the base + composite in order; pasted-cutout sources ride along in the bundle but are NOT auto-attached (they flow into generate_image as refs).`);
        lines.push('2. Then dispatch the real work: `generate_image` for edits/compositions, `background_removal`, `upscale_image`, or — when the user asks to animate / move / "give it life" / make a video out of it — `generate_video`.');
        lines.push('3. For `generate_image` use EXACTLY this shape (base → composite → sources):');
        lines.push('');
        lines.push('```json');
        lines.push(`{ "intent": "generate_image", "prompt": "Edit the FIRST reference image. The SECOND is a composite snapshot showing EXACTLY where and at what size/angle the pasted elements land — use as PLACEMENT guide. The REMAINING refs are the high-fidelity sources. Apply: <paraphrase the user's request>.", "referenceImages": ${refJson}, "saveTo": "${saveDir}" }`);
        lines.push('```');
        lines.push('');
        lines.push('4. For `generate_video` (animate the marked image) — image-to-video models REQUIRE the source image as `startFrame` (the first frame of the animation). The annotated composite goes in `referenceImages` as supplementary visual context — DO NOT put the base image in both fields, that\'s redundant and some adapters reject duplicates.');
        lines.push('');
        lines.push('```json');
        lines.push(`{ "intent": "generate_video", "prompt": "<detailed brief — describe the marked subject by physical attributes + position + pose, name what should move/change, then explicitly list what to keep static/intact>", "startFrame": "${activeLoc}", "referenceImages": ${animRefJson}, "saveTo": "${saveDir}" }`);
        lines.push('```');
        lines.push('');
        lines.push('**Critical**: `startFrame` is mandatory for image-to-video. Omitting it causes the call to fail with `body.image_url: Field required` because the gateway only sets `image_url` when a `startFrame` is provided (see `gateway.service.ts`).');
        if (hasDrawnMarks) {
          lines.push('');
          lines.push('**Sketch-guided routing**: when `label: "sketch-guided"` appears in the `generate_video` schema enum, ADD it to the call. That label selects a model variant trained to interpret drawn marks (arrows, crosses, scribbles) as motion / edit hints visually — not just from prose. Without the label the router picks a generic image-to-video model that only sees the clean source frame + your prompt, which is why complex trajectories (swerve, overtake, multi-segment paths) often come out wrong. Example with the label:');
          lines.push('');
          lines.push('```json');
          lines.push(`{ "intent": "generate_video", "label": "sketch-guided", "prompt": "<...>", "startFrame": "${activeLoc}", "referenceImages": ${animRefJson}, "saveTo": "${saveDir}" }`);
          lines.push('```');
          lines.push('');
          lines.push('**Required workflow when annotations carry drawn marks (whether you call `generate_image` OR `generate_video`):**');
          lines.push('');
          lines.push('5. ');
          _pushAnnotationTranscribeGuide(lines);
          lines.push('');
          lines.push('6. For `generate_video` specifically, structure the prompt as numbered directives (the diffusion model loses anchoring when you merge instructions into a paragraph):');
          lines.push('');
          _pushStructuredDirectivesGuide(lines, 'image');
          lines.push('');
          _pushSurgicalAnnotationGuide(lines);
        }
      }

      // When the ACTIVE doc is a video, two distinct intents collapse into
      // the same surface ("do X with this video"): (A) transform the source
      // footage — preserve motion, change look — which is v2v; (B) reuse
      // the SUBJECTS in a new scene — new motion, new setting — which is
      // extract_frame → generate_image → generate_video (image-to-video).
      // Without this distinction the agent routinely funnels (B) through
      // v2v with `referenceVideos`, which (a) preserves source motion the
      // user didn't ask for and (b) collides with v2v specialists' tighter
      // content filters. The block below spells out both paths so the
      // planner picks the right pipeline up-front.
      if (active && active.type === 'video' && active.path) {
        const activeLoc = active.path;
        const saveDir = activeLoc.replace(/\/[^/]+$/, '');
        const videoAnns = Array.isArray(active.bundle?.annotations)
          ? active.bundle.annotations.filter((a) => a?.role === 'video-frame-composite')
          : [];
        lines.push('');
        lines.push('## 🎬 ACTIVE document is a video — pick the right path');
        lines.push('');
        lines.push('There are TWO distinct intents on a video, with two different pipelines. Pick before calling anything.');
        lines.push('');
        lines.push('### A) EDIT the video itself (transform the existing footage)');
        lines.push('');
        lines.push('"Cambia el color", "make it slow-motion", "apply cinematic grading", "remove the watermark", "extend", "restyle", "add audio". The motion of the source is preserved; only its look / length / audio changes. → v2v: call `generate_video` with the active path in `referenceVideos`.');
        lines.push('');
        lines.push('```json');
        lines.push(`{ "intent": "generate_video", "prompt": "<paraphrase the user's request, describing the desired result>", "referenceVideos": ["${activeLoc}"], "saveTo": "${saveDir}" }`);
        lines.push('```');
        lines.push('');
        lines.push('### B) REUSE the SUBJECTS of the video in a NEW scene');
        lines.push('');
        lines.push('"Haz a esta pareja en X", "ponla haciendo Y", "muéstralo en Z", "create a scene where they…". The user wants the people / characters / objects from the video doing something the source does NOT already show — new action, new setting, new pose. The source video is a character reference, not the footage to transform.');
        lines.push('');
        lines.push('**DO NOT pass the video as `referenceVideos`** in this case (that forces v2v routing, which is the wrong tool: v2v models try to preserve source motion and v2v specialists are also the most restrictive about content). Instead chain three calls:');
        lines.push('');
        lines.push(`1. \`extract_frame\` on \`${activeLoc}\` (use \`lastFrame: true\`, or a specific \`timeMs\` if a particular pose matters) — yields a still PNG of the subjects.`);
        lines.push('2. `generate_image` with that frame in `referenceImages` to compose the new scene as a still.');
        lines.push('3. `generate_video` with the generated image as `startFrame` (image-to-video) for the final clip. **No `referenceVideos`** in this call.');
        lines.push('');
        lines.push('This preserves the visual identity of the subjects while letting you generate motion / settings absent from the source.');
        lines.push('');
        lines.push('### How to choose between A and B');
        lines.push('');
        lines.push('- The request describes a **transformation of what the source already shows** (recolor, restyle, slow-mo, extend by N seconds, watermark removal) → **A (v2v)**.');
        lines.push('- The request describes **new action / new setting** the source video does NOT show → **B (frame → image → video)**.');
        lines.push('- If you are unsure, prefer **B** — it is more flexible and less likely to be rejected. Only skip `referenceVideos` entirely when the user is asking for a brand-new clip with NO connection to the active video (e.g. "generate a video of a sunset" while a different video is open) — that is text-to-video, not path B.');
        // Paths C and D (audio generation) used to live here, but they
        // also apply when the active document is a TIMELINE (which
        // references video clips) — pulled out below so the same guidance
        // fires for both kinds of doc.

        // Per-frame annotations published with the video — read them as
        // vision before writing the prompt so the marks become a SPECIFIC
        // editing brief, not a vague "edit the video".
        if (videoAnns.length > 0) {
          const stamps = videoAnns
            .map((a) => typeof a.frameTimestampMs === 'number' ? _formatVideoTs(a.frameTimestampMs) : '?')
            .join(', ');
          const annPaths = videoAnns.map((a) => a.path).filter(Boolean);
          const refImagesJson = JSON.stringify(annPaths);
          lines.push('');
          lines.push(`## 🎥 The user has marked ${videoAnns.length} frame(s) of this video`);
          lines.push('');
          lines.push(`Annotated frames at: ${stamps}.`);
          lines.push('');
          lines.push('**Required workflow before calling `generate_video`:**');
          lines.push('');
          lines.push(`1. Call \`read_file\` on \`${activeLoc}\` — vision will receive each annotated frame as \`[ANNOTATIONS @ MM:SS.ms]\` in chronological order.`);
          lines.push('');
          lines.push('2. ');
          _pushAnnotationTranscribeGuide(lines);
          lines.push('');
          lines.push('3. ');
          _pushStructuredDirectivesGuide(lines, 'video');
          lines.push('');
          lines.push('4. **Identify the marked SUBJECT in surgical detail** (per the rules below): physical attributes (hair colour & length, complexion, clothing colour & type, accessories), spatial location (specific seat, side of frame, foreground/background), pose. Without this level of detail the model picks the wrong person — there are typically 3-5 subjects in frame and "the woman" is ambiguous. Reuse the EXACT same description across all directives that reference the same subject so the model knows it\'s the same person.');
          lines.push('');
          lines.push('5. **Write the `generate_video` call.** Include the source video AND every annotation composite as references (the composites let the model VISUALLY locate the marked subjects — the red mark itself is part of the reference image; combined with the timestamp-anchored prose this makes the intent unambiguous):');
          lines.push('');
          lines.push('```json');
          lines.push(`{ "intent": "generate_video", "prompt": "<numbered, timestamp-anchored directives per step 3>", "referenceVideos": ["${activeLoc}"], "referenceImages": ${refImagesJson}, "saveTo": "${saveDir}" }`);
          lines.push('```');
          lines.push('');
          lines.push('**Sketch-guided routing**: when `label: "sketch-guided"` appears in the `generate_video` schema enum, ADD it. That label selects a model variant trained to read drawn marks visually (arrows = motion vectors, crosses = removal regions) instead of relying purely on prose. Without it the router picks a generic v2v / i2v model that only sees the source + your prompt, and complex per-frame intent gets lost.');
          lines.push('');
          _pushSurgicalAnnotationGuide(lines);
        }
      }

      // Audio generation guidance — fires for BOTH video and timeline
      // active docs. A timeline references video clips internally, so
      // "ponle sonido a esto" is the same intent regardless of which kind
      // of doc the user has focused. Without this, the timeline path
      // landed on the LLM's training priors and produced a `prompt_user`
      // with music chips even when the user said "sonido" — wrong on
      // both axes (chose music over sfx, AND asked instead of acting).
      const _audioActive = active && (active.type === 'video' || active.type === 'timeline') && (active.path || active.url);
      if (_audioActive) {
        const _activeLoc = active.path || active.url;
        const _activeKind = active.type;
        lines.push('');
        lines.push(`## 🔊 ACTIVE document is a ${_activeKind} — adding audio`);
        lines.push('');
        lines.push('### C) ADD SFX / SOUND / FOLEY (the user said "sonido" / "audio" / "SFX" / "Foley" / "ambient sound")');
        lines.push('');
        lines.push('**This is NOT a clarification step.** Do NOT call `prompt_user`. Do NOT propose music chips. Do NOT ask "qué tipo de música prefieres". The user said "sonido" — that means **diegetic SFX synchronised to what\'s on screen**, not music. Go straight to the workflow below.');
        lines.push('');
        lines.push('**Workflow — strictly required before calling `generate_audio`:**');
        lines.push('');
        lines.push(`1. Call \`read_file\` on \`${_activeLoc}\` so vision receives the source frames (for a timeline, the engine renders/serialises a representative view of the clips). WITHOUT this read you have no idea what's on screen; defaulting to "ambient electronic music" or similar generic prompts is the canonical failure mode here and produces audio unrelated to the content.`);
        lines.push('');
        lines.push('2. Identify the dominant on-screen action / texture / mood (e.g. "wooden building engulfed in flames, crackling and roaring, people running with metal buckets"; "calm forest path with leaves rustling and footsteps on gravel"; "underwater scene with bubbles and muffled ambient hum").');
        lines.push('');
        lines.push(`3. Write the \`generate_audio\` call with \`mode: "sfx"\`. **Pass \`videoFile: "${_activeLoc}"\`** — with \`videoFile\` present the router lands on a video-conditioned model (mmaudio-v2) that synchronises the SFX to the visible action: silence for the silent moments, peaks at impact frames. Without \`videoFile\` you fall back to a text-only sfx model (ElevenLabs) which produces a generic clip that won't sync.`);
        lines.push('');
        lines.push('```json');
        lines.push(`{ "intent": "generate_audio", "mode": "sfx", "prompt": "<concrete sound description anchored in what's on-screen>", "videoFile": "${_activeLoc}", "durationSeconds": <duration in seconds>, "saveTo": "<absolute path>.mp3" }`);
        lines.push('```');
        lines.push('');
        lines.push('Even with the video-conditioned model, the prompt still matters — it disambiguates which sounds to emphasise. Specific sensory prompts ("crackling fire, collapsing wooden beams, distant shouts and metal buckets clanging") produce specific audio; vague prompts ("background sound") get vague audio.');
        lines.push('');
        lines.push('### D) ADD MUSIC / SCORE / SOUNDTRACK (only when the user explicitly says "música" / "soundtrack" / "score" / "backing track")');
        lines.push('');
        lines.push('Music is text-only, NOT video-conditioned — the model does not watch the frames. Read the active doc anyway so you can describe the mood / genre / pacing that fits the visuals, then call `generate_audio` with `mode: "music"`. **Do NOT pass `videoFile`** — in music mode it would be ignored.');
        lines.push('');
        lines.push('```json');
        lines.push(`{ "intent": "generate_audio", "mode": "music", "prompt": "<mood + instrumentation + tempo + structure, e.g. 'epic orchestral score with cellos and percussion, slow build into a crescendo at 0:20'>", "durationSeconds": <duration>, "saveTo": "<absolute path>.mp3" }`);
        lines.push('```');
        lines.push('');
        lines.push('### Disambiguation C vs D — STRICT keyword rules');
        lines.push('');
        lines.push('- "sonido" / "audio" / "SFX" / "Foley" / "ambient sound" / "sound effects" → **C (sfx)**. Never music.');
        lines.push('- "música" / "soundtrack" / "score" / "backing track" / "BSO" / "musical theme" → **D (music)**.');
        lines.push('- If only neutral words appear ("ponle algo", "add audio"), default to **C (sfx)**. The user can always say "no, quiero música" on the next turn.');
        lines.push('- **Never** call `prompt_user` to disambiguate between C and D unless the user used a word that genuinely matches BOTH categories ("acompañamiento sonoro" — rare). Asking the user is the wrong default; reading the file and acting is right.');
      }

      lines.push('');
      lines.push('**ACTIVE doc = default target.** Demonstratives ("this", "esto", "the image", "the pdf", …) always mean the ACTIVE document — never the project codebase. Use only paths / URLs listed above, never invent.');
      lines.push('- **Read** active doc → `read_file` with its path/URL. Images & web come back as vision; if there\'s a composite, it\'s queued right after as `[ANNOTATIONS OVERLAY]` (image) or `[ANNOTATIONS @ MM:SS.ms]` (video — one per annotated frame, chronological).');
      lines.push('- **Write/edit text docs** → `edit_file` / `write_file` directly, inline — never delegate to a sub-agent for working-area edits. "continúa / sigue / añade" = append; "replace / rewrite" = replace. Never report success without a real tool call.');
      lines.push('- **Non-text active docs** (image/pdf/web) — dispatch to the right media tool (`generate_image`, `background_removal`, …); never claim to have edited in place.');
      lines.push('- **Ambiguity** between open text docs → `prompt_user` before writing.');
      lines.push('- **Caret/selection** — if `read_file` returns an `editor.summary`, that selection is the anchor for "this / aquí / change this".');
      if (active && (active.path || active.url)) {
        const activeLoc = active.path || active.url;
        const isText = active.type === 'text' || active.type === 'html';
        lines.push('');
        lines.push('Example — read the active document:');
        lines.push('```json');
        lines.push(`{ "intent": "read_file", "path": "${activeLoc}" }`);
        lines.push('```');
        if (isText) {
          lines.push('');
          lines.push('Example — write into the active text document (default target for "add/write/fill" requests):');
          lines.push('```json');
          lines.push(`{ "intent": "write_file", "path": "${activeLoc}", "content": "..." }`);
          lines.push('```');
        }
      }
      openDocumentsBlock = lines.join('\n') + '\n';
    }
  } catch (err) {
    // Loud catch: previously this was silent (`catch {}`), which meant any
    // runtime error inside the WORKING AREA build (a helper throwing, a
    // bad reference, etc.) was swallowed and the block silently vanished
    // from the prompt — exactly the kind of bug that took an hour to
    // diagnose. Log it so it screams.
    try {
      const { channel: _ch } = await import('../io/channel.js');
      _ch.log('prompt', `[working-area] ERROR building block — block omitted: ${err?.stack || err?.message || err}`);
    } catch {
      // eslint-disable-next-line no-console
      console.error('[prompt] [working-area] ERROR building block — block omitted:', err);
    }
  }

  // Expanded tool schemas: full docs for every tool the agent has
  // already requested via `get_tool_info` this session. Lives in the
  // DYNAMIC section (not static) — the static prefix must stay stable
  // across turns so the prompt cache hits; if we put this here it
  // would change every time the agent asked for a new tool and every
  // subsequent call would re-tokenise the entire prefix.
  const expandedToolsBlock = actionRegistry.generateExpandedToolsBlock(agent);

  // ── Dynamic section: runtime context, project map, language, non-interactive ──
  // Changes every turn (timestamp, task counts, phase). Placed AFTER the agent's
  // playbook so the static prefix (generic rules + agent playbook) is maximally cacheable.
  const dynamic = `${now} | ${timezone || 'unknown'}
${phaseSystemBlock}
# RUNTIME CONTEXT

| Field | Value |
|---|---|
| Working directory | \`${cwd}\` |${platformField}${langField}

All file paths (read_file, edit_file, write_file, shell) are relative to working directory unless absolute.
**LANGUAGE:** The "User language" field above is set automatically by the runtime whenever a new user message arrives — trust it. All user-facing output (print, prompt_user, questions) must be in that language. Code and technical identifiers stay in English. You do not need (and cannot) change the language yourself — it tracks the user's latest message natively.
${openDocumentsBlock}${nonInteractiveBlock}${expandedToolsBlock}
REMINDER: intent must be one of AVAILABLE ACTIONS (enum). Never invent new intents. Descriptions go in query / other fields.`;

  return { static: staticPart, dynamic, koiMd };
}

/**
 * Load BRAXIL.md (or KOI.md) from the project root (cwd) if it exists.
 * Similar to CLAUDE.md — project-specific instructions appended to the system prompt.
 */
export function loadKoiMd() {
  const candidates = [
    path.join(process.cwd(), 'BRAXIL.md'),
    path.join(process.cwd(), 'braxil.md'),
    path.join(process.cwd(), 'CLAUDE.md'),
    path.join(process.cwd(), 'claude.md'),
    path.join(process.cwd(), 'KOI.md'),
    path.join(process.cwd(), 'koi.md'),
  ];
  // Find the first candidate that exists — on case-insensitive FS (macOS),
  // BRAXIL.md and braxil.md resolve to the same file, so just use the first hit.
  let found = null;
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) { found = filePath; break; }
  }
  if (found) {
    try {
      const content = fs.readFileSync(found, 'utf8').trim();
      const name = path.basename(found);
      if (content) {
        return `\n\n── PROJECT SPECIFICATIONS (from ${name}) ──────────────────────────\n${content}\n── END ${name} ──────────────────────────────────────────────────`;
      }
    } catch { /* ignore read errors */ }
  }
  return '';
}

// =========================================================================
// SMART RESOURCE SECTION
// =========================================================================

/**
 * Build a smart resource section for system prompts.
 * THE RULE:
 *   - If total intents across ALL resources <= 25: show everything (1-step)
 *   - If total > 25: collapse resources with > 3 intents to summaries (2-step)
 *
 * @param {Agent} agent - The agent
 * @returns {string} Resource documentation for system prompt
 */
export async function buildSmartResourceSection(agent) {
  // 1. Collect ALL resources with their intents
  const resources = [];

  // Direct actions (from action registry)
  const directActions = actionRegistry.getAll().filter(a => {
    if (a.hidden) return false;
    if (!a.permission) return true;
    return agent.hasPermission(a.permission);
  });
  if (directActions.length > 0) {
    resources.push({
      type: 'direct',
      name: 'Built-in Actions',
      intents: directActions.map(a => ({
        name: a.intent || a.type,
        description: a.description,
        schema: a.schema,
        _actionDef: a
      }))
    });
  }

  // Team members (delegation targets) — only if agent can delegate
  const peerIntents = agent.hasPermission('delegate') ? collectPeerIntents(agent) : [];
  for (const peer of peerIntents) {
    resources.push({
      type: 'delegate',
      name: peer.agentName,
      agentPureName: peer.agentPureName,
      agentDescription: peer.agentDescription,
      intents: peer.handlers.map(h => ({
        name: h.name,
        description: h.description,
        params: h.params
      }))
    });
  }

  // MCP servers — only if agent has call_mcp permission
  if (agent.hasPermission('call_mcp')) {
    if (globalThis.mcpRegistry?.globalReady) {
      await globalThis.mcpRegistry.globalReady;
    }
    const mcpSummaries = agent.getMCPToolsSummary?.() || [];
    for (const mcp of mcpSummaries) {
      resources.push({
        type: 'mcp',
        name: mcp.name,
        description: mcp.description || '',
        lazy: mcp.lazy !== false,
        intents: mcp.tools.map(t => ({
          name: t.name,
          description: t.description || t.name,
          inputSchema: t.inputSchema
        }))
      });
    }
  }

  // 2. Count total intents
  const totalIntents = resources.reduce((sum, r) => sum + r.intents.length, 0);

  if (process.env.KOI_DEBUG_LLM) {
    console.error(`[SmartPrompt] Total intents: ${totalIntents} across ${resources.length} resources`);
    for (const r of resources) {
      console.error(`  [${r.type}] ${r.name}: ${r.intents.length} intents`);
    }
  }

  // Always expand all resources (1-step)
  return buildExpandedResourceSection(resources, agent);
}

/**
 * Collect peer intents (handler names + descriptions) from accessible teams.
 * @param {Agent} agent
 * @returns {Array<{agentName, handlers: Array<{name, description}>}>}
 */
export function collectPeerIntents(agent) {
  const result = [];
  const processedAgents = new Set();

  const collectFrom = (memberKey, member, teamName) => {
    if (!member || member === agent || processedAgents.has(member.name)) return;
    processedAgents.add(member.name);

    if (!member.handlers || Object.keys(member.handlers).length === 0) return;

    const handlers = [];
    for (const [handlerName, handlerFn] of Object.entries(member.handlers)) {
      let description = `Handle ${handlerName}`;
      let params = [];

      // Prefer LLM-generated description from build cache
      if (handlerFn?.__description__) {
        description = handlerFn.__description__;
      } else if (handlerFn?.__playbook__) {
        // Fallback: first line of playbook
        const firstLine = handlerFn.__playbook__.split('\n')[0].trim();
        description = firstLine.replace(/\$\{[^}]+\}/g, '...').substring(0, 80);
      }

      // Extract required params from ${args.X} patterns in playbook
      if (handlerFn?.__playbook__) {
        const paramMatches = handlerFn.__playbook__.matchAll(/\$\{args\.(\w+)/g);
        params = [...new Set([...paramMatches].map(m => m[1]))];
      }

      handlers.push({ name: handlerName, description, params, isAsync: !!handlerFn?.__async__ });
    }

    result.push({
      agentName: teamName ? `${memberKey} (${teamName})` : memberKey,
      agentPureName: memberKey,
      teamName: teamName || null,
      agentDescription: member.description || null,
      handlers
    });
  };

  // Peers team
  if (agent.peers?.members) {
    for (const [name, member] of Object.entries(agent.peers.members)) {
      collectFrom(name, member, agent.peers.name);
    }
  }

  // Uses teams
  for (const team of (agent.usesTeams || [])) {
    if (team?.members) {
      for (const [name, member] of Object.entries(team.members)) {
        collectFrom(name, member, team.name);
      }
    }
  }

  // User-defined markdown agents (.koi/agents/*.md)
  // Available to any agent with delegate permission.
  if (agent.role?.can('delegate')) {
    try {
      const userTeam = getUserAgentsTeam();
      if (userTeam?.members) {
        for (const [name, member] of Object.entries(userTeam.members)) {
          collectFrom(name, member, null);
        }
      }
    } catch { /* non-fatal */ }
  }

  return result;
}

/**
 * Build expanded resource section - show all intents directly.
 * This is the normal behavior when total intents <= 25.
 */
export function buildExpandedResourceSection(resources, agent) {
  let doc = '';

  // ── AVAILABLE ACTIONS ───────────────────────────────────────────────────
  // Toolset mode: show toolset groups (table) + core tools inline.
  // Agents call open_toolset/get_tool_info for details on demand.
  for (const resource of resources) {
    if (resource.type === 'direct') {
      doc += actionRegistry.generateToolsetDocumentation(agent);
    }
  }

  // ── AVAILABLE AGENTS ────────────────────────────────────────────────────
  let delegateResources = resources.filter(r => r.type === 'delegate');

  // Phase-based filtering: if 'delegate' permission is disabled, hide all agents
  const disabledPerms = agent?.state?.disabledPermissions;
  if (Array.isArray(disabledPerms) && disabledPerms.includes('delegate')) {
    delegateResources = [];
  }

  if (delegateResources.length > 0) {
    doc += '## AVAILABLE AGENTS\n\n';
    for (const resource of delegateResources) {
      doc += `### ${resource.agentPureName}\n`;
      if (resource.agentDescription) {
        doc += `${resource.agentDescription}\n`;
      }
      for (const handler of resource.intents) {
        const _asyncTag = handler.isAsync ? ' [async — runs in background, add "await": true to wait]' : '';
        doc += ` - ${handler.name}${_asyncTag}: ${handler.description}\n`;
        if (handler.params?.length > 0) {
          doc += `    In: { ${handler.params.map(p => `"${p}"`).join(', ')} }\n`;
        }
      }
      doc += '\n';
    }
  }

  // ── AVAILABLE MCP SERVERS ───────────────────────────────────────────────
  // Lazy by default: advertise the server name + short description + tool
  // count only. The agent calls open_mcp(name) to see the tool list and
  // get_mcp_tool_info(mcp, tool) for a specific schema. This keeps the
  // system prompt small when several MCPs are connected (each can expose
  // dozens of tools, and the full schemas add up fast).
  // Opt out per-server via `"lazy": false` in .mcp.json.
  let mcpResources = resources.filter(r => r.type === 'mcp');
  if (Array.isArray(disabledPerms) && disabledPerms.includes('call_mcp')) {
    mcpResources = [];
  }
  if (mcpResources.length > 0) {
    const lazyResources = mcpResources.filter(r => r.lazy !== false);
    const eagerResources = mcpResources.filter(r => r.lazy === false);

    if (lazyResources.length > 0) {
      doc += '## AVAILABLE MCP SERVERS\n\n';
      doc += 'Call **open_mcp("<server>")** to see the tools exposed by a server, then **get_mcp_tool_info({ mcp, tool })** for the full parameter schema of a specific tool before invoking it with call_mcp.\n\n';
      doc += '| Server | Tools | Description |\n|---|---|---|\n';
      for (const resource of lazyResources) {
        const count = resource.intents.length;
        const desc = (resource.description || '').trim() || '(no description)';
        doc += `| ${resource.name} | ${count} | ${desc.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |\n`;
      }
      doc += '\n';
    }

    if (eagerResources.length > 0) {
      doc += '## AVAILABLE MCP TOOLS\n\n';
      for (const resource of eagerResources) {
        doc += `### ${resource.name}\n`;
        if (resource.description) doc += `${resource.description}\n`;
        for (const tool of resource.intents) {
          doc += ` - ${tool.name}: ${tool.description || tool.name}\n`;
          if (tool.inputSchema?.properties) {
            const keys = Object.keys(tool.inputSchema.properties);
            if (keys.length > 0) doc += `    In: ${keys.map(k => `"${k}"`).join(', ')}\n`;
          }
        }
        doc += '\n';
      }
    }
  }

  // ── INVOCATION SYNTAX ───────────────────────────────────────────────────
  doc += '---\n';
  doc += 'To execute an action (intent MUST be an exact name from AVAILABLE ACTIONS):\n';
  doc += '{ "actionType": "direct", "intent": "<action_name>", "<param1>": "<value1>", "<param2>": "<value2>" }\n\n';

  if (delegateResources.length > 0) {
    const ex = delegateResources[0];
    const exEvent = ex.intents[0]?.name ?? 'handle';
    doc += 'To call an agent:\n';
    doc += `{ "actionType": "delegate", "intent": "${ex.agentPureName}::${exEvent}", "data": { ... } }\n\n`;
    doc += 'The intent for a delegate action must use the format agentKey::eventName\n';
  }

  if (mcpResources.length > 0) {
    // Prefer an eager resource for the example so the sample tool name is
    // actually visible in the prompt. Fall back to a lazy server with a
    // placeholder — the agent is expected to call open_mcp first anyway.
    const eager = mcpResources.find(r => r.lazy === false);
    const ex = eager ?? mcpResources[0];
    const exTool = ex.intents[0]?.name ?? 'tool_name';
    doc += '\nTo call an MCP tool (ALWAYS use this format — NEVER use delegate for MCP tools):\n';
    doc += `{ "actionType": "direct", "intent": "call_mcp", "mcp": "${ex.name}", "tool": "${exTool}", "input": { ... } }\n`;
    if (!eager) {
      doc += 'For lazy servers, first call open_mcp("<server>") to discover tool names, then get_mcp_tool_info for the exact parameter schema.\n';
    }
  }

  return doc;
}

// =========================================================================
// REACTIVE SYSTEM PROMPT
// =========================================================================

/**
 * Build the system prompt for reactive mode.
 * Wraps buildSystemPrompt + playbook injection.
 * @param {Agent} agent - The agent
 * @param {string|object|null} playbook - The agent's playbook
 * @returns {string|object} Complete system prompt
 */
export async function buildReactiveSystemPrompt(agent, playbook = null) {
  const { static: staticBase, dynamic, koiMd: projectSpec } = await buildSystemPrompt(agent);
  // Layout:
  //   1. BRAXIL.md / CLAUDE.md (project specification — MUST be first, always)
  //   2. Agent playbook (agent's own instructions — what matters most)
  //   3. Dynamic runtime context (timestamp, phase, task state)
  //   4. Static generic rules (output contract, golden rule, action model, tools)

  // Structured cache-aware playbook from compiler taint analysis
  if (typeof playbook === 'object' && playbook?._cacheKey !== undefined) {
    const _s = (v) => typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v));
    return {
      _cacheKey: playbook._cacheKey,
      static: [projectSpec, _s(playbook.static), staticBase].filter(Boolean).join('\n\n'),
      dynamic: [_s(playbook.dynamic), dynamic].filter(Boolean).join('\n\n'),
    };
  }

  // Legacy: plain string playbook (or flatten object without _cacheKey)
  let playbookStr = '';
  if (typeof playbook === 'string') {
    playbookStr = playbook.trim();
  } else if (typeof playbook === 'object' && playbook !== null) {
    playbookStr = typeof playbook.static === 'string' && typeof playbook.dynamic === 'string'
      ? [playbook.static, playbook.dynamic].filter(Boolean).join('\n')
      : typeof playbook.text === 'string'
        ? playbook.text
        : String(playbook);
  }
  const parts = [];
  if (projectSpec) parts.push(projectSpec); // BRAXIL.md / CLAUDE.md — always first
  if (playbookStr) parts.push(playbookStr);
  parts.push(dynamic);
  parts.push(staticBase);
  return parts.join('\n\n');
}
