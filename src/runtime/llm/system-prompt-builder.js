import fs from 'fs';
import os from 'os';
import path from 'path';

import { actionRegistry } from '../agent/action-registry.js';
import { getUserAgentsTeam } from '../agent/md-agent-loader.js';
import { compile as compileContext } from '../prompt/compiler.js';
import { getBuiltinSlotMap } from '../prompt/builtin-slot-maps.js';
import { channel } from '../io/channel.js';
import * as memory from '../memory/index.js';
import { listWorkflowsCatalog } from '../state/workflows-catalog.js';
import { readDocJson, parseDocJson } from '../state/project-paths.js';
import { isNonInteractive, isYoloMode } from '../util/interactivity.js';

// ── Active-document kind classifier ─────────────────────────────────────────
// Robustly identify WHAT the user is actually looking at, so the WORKING AREA
// header label and the per-kind guidance blocks key off a reliable signal
// instead of brittle `type !== 'video'`-style guesses (which mislabelled a .md
// as an image and injected generate_video rules with the .md as startFrame).
//
// App-native doc types (timeline / storyboard / web) win first — their backing
// file is a .json / URL whose extension isn't meaningful. Otherwise we classify
// by file EXTENSION (unambiguous), falling back to the declared `type`.
const _DOC_EXT_KINDS = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'svg'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'],
  pdf: ['pdf'],
  document: ['doc', 'docx', 'odt', 'rtf', 'epub', 'pages'],
  spreadsheet: ['csv', 'tsv', 'xls', 'xlsx', 'ods'],
  markdown: ['md', 'markdown', 'mdx'],
  code: ['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'json', 'yaml', 'yml', 'toml', 'html', 'css', 'koi', 'sql'],
};
const _DOC_EXT_LOOKUP = (() => {
  const m = {};
  for (const [kind, exts] of Object.entries(_DOC_EXT_KINDS)) for (const e of exts) m[e] = kind;
  return m;
})();

/**
 * Return the canonical kind of the active doc: image | video | audio | pdf |
 * document | spreadsheet | markdown | code | timeline | storyboard | web |
 * text | unknown. Used for both the WORKING AREA label and block gating.
 */
function _classifyDoc(active) {
  if (!active) return 'unknown';
  const t = active.type;
  // App-native types take precedence over their .json/url backing extension.
  if (t === 'timeline' || t === 'storyboard') return t;
  if (t === 'html' || t === 'web') return 'web';
  const loc = String(active.path || active.url || '').toLowerCase();
  const m = loc.match(/\.([a-z0-9]+)(?:[?#].*)?$/);
  const ext = m ? m[1] : '';
  if (ext && _DOC_EXT_LOOKUP[ext]) return _DOC_EXT_LOOKUP[ext];
  // No (or unknown) extension → trust the declared type, normalising aliases.
  if (t === 'image' || t === 'video' || t === 'audio') return t;
  if (t === 'html') return 'web';
  return t || 'unknown';
}

// Pinned ffmpeg version installed by `ffmpeg-installer.js`. Mirrored
// here as a constant so we don't have to import the installer (and
// trigger its side effects) just to know the version string for the
// RUNTIME CONTEXT block.
const _PINNED_FFMPEG_VERSION = '8.1.1';

/// Resolve the ffmpeg binary path without forcing an install. Order:
///   1. `KOI_FFMPEG_PATH` env var (set by the Flutter bundle).
///   2. Pinned cache `~/.koi/bin/ffmpeg-<PINNED>/ffmpeg`.
///   3. null — caller falls back to assuming `ffmpeg` is on PATH.
/// Cached per process (the file system check is cheap, but we'd
/// re-stat on every prompt build otherwise — hundreds of times a
/// session for a chatty agent).
let _ffmpegInfoCache;
function _resolveFfmpegInfo() {
  if (_ffmpegInfoCache) return _ffmpegInfoCache;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const envPath = process.env.KOI_FFMPEG_PATH;
  let resolved = null;
  let source = null;
  if (envPath && fs.existsSync(envPath)) {
    resolved = envPath;
    source = 'env';
  } else {
    const cached = path.join(
      os.homedir(),
      '.koi',
      'bin',
      `ffmpeg-${_PINNED_FFMPEG_VERSION}`,
      `ffmpeg${exe}`,
    );
    if (fs.existsSync(cached)) {
      resolved = cached;
      source = 'cache';
    }
  }
  _ffmpegInfoCache = { path: resolved, version: _PINNED_FFMPEG_VERSION, source };
  return _ffmpegInfoCache;
}

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
  lines.push('**TRANSCRIBE every annotation as INTERNAL reasoning BEFORE acting.** The single most common failure mode is the agent looking at a mark, guessing which subject it refers to, and getting it wrong because the mark sat near multiple candidates. To prevent that, walk through the transcription IN YOUR HEAD (thinking tokens if the model supports them, otherwise just as careful internal reasoning before writing the action YAML). For EACH distinct mark, mentally fill out:');
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
  lines.push('**0. MARK-AS-IDENTITY-POINTER (PRIMARY — strongest possible anchor)** — the user\'s mark itself is visible in the annotation composite that ships as `referenceImages[i]`. Cite it POSITIONALLY as **`Image 1`, `Image 2`, …** — 1-indexed by array order: `Image 1` IS `referenceImages[0]`, `Image 2` IS `referenceImages[1]`, etc. Reference VIDEOS have their OWN counter: **`Video 1`, `Video 2`, …** = `referenceVideos[0]`, `[1]`, … Video models are trained on exactly this positional naming, so it binds reliably.');
  lines.push('   - *"the subject identified by the prominent red X mark visible in Image 1 (the annotated frame at 00:03.042) — the person on whom the red X is overlaid"*');
  lines.push('   - *"the figure covered by the red scribble in Image 2 (annotated frame at 00:04.250)"*');
  lines.push('   This bypasses every prose ambiguity (colour, ordinals, geometry) because the model\'s vision encoder DIRECTLY SEES which pixels are marked and locks onto the subject under those pixels. Anchors 1-3 below act as REINFORCEMENTS in case the model under-weights the visual mark.');
  lines.push('');
  lines.push('   **Use the plain positional form `Image N` / `Video N` — NEVER an invented syntax like `Image 1`, `@Image1`, `<image>`, `[image-1]` (models don\'t understand those and the generation comes out ignoring the reference). `Image 1` = the first reference image you attached, `Image 2` = the second, in array order; videos count separately as `Video 1`, `Video 2`. This is the single convention every media tool here uses.**');
  lines.push('');
  lines.push('   **Hard limit: max 4 reference images total** (some video adapters cap at 4; safer ceiling for the rest). If the user marked more than 4 frames, prioritise the frames with the most distinct subjects/instructions and drop the rest.');
  lines.push('');
  lines.push('⏱ **TIMESTAMPED + TRACKED** — every spatial description anchors to the EXACT timestamp of the marked frame, plus a tracking clause so the model carries identity through subject/camera motion across the rest of the clip.');
  lines.push('');
  lines.push('1. **One natural-language landmark (mandatory, TIMESTAMPED)** — on top of the Image 1 mark, give the model ONE simple human-language description that any human caption-writer would write spontaneously, NOT engineering pseudo-coordinates. Diffusion models were trained on natural image captions, not on UI percent bands.');
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
  lines.push('   Pick **ONE** such anchor — not five. More anchors compete for attention and the model averages them, often landing on the wrong subject. The Image 1 mark is the primary signal; one simple natural-language landmark reinforces it.');
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
  lines.push('   ✓ Example for the ambiguous SUV-with-two-women-in-back case (user marked frame at 00:03.042 with a red X; that composite ships as `referenceImages[0]` ↔ `Image 1`):');
  lines.push('     *"The female passenger identified by the prominent red X mark visible in Image 1 (the annotated frame at 00:03.042 — the person on whom the red X is overlaid). She is the woman seated nearest the back of the vehicle, the one whose face is partly cropped by the edge of the shot at 00:03.042. Track this same subject across every frame of the source clip — her position on screen will shift as the camera tracks the moving vehicle, but identity stays locked to whoever the red X in Image 1 marks. Throughout the entire output she is absent, replaced by the vehicle\'s interior visible behind her seat. Keep the OTHER woman in the back of the vehicle (the one seated closer to the driver) unchanged across every frame, and keep the man with green-and-orange face paint, the boy leaning out of the front window, the wood-panel exterior, the desert background, and the camera framing exactly as in the source."*');
  lines.push('     Notice: ONE strong identity pointer (red X in Image 1) + ONE natural-language anchor ("seated nearest the back of the vehicle / face partly cropped by the edge"). The OTHER woman is described positively by her OWN landmark ("seated closer to the driver"), not negatively as "not the rightmost". Tracking clause. No engineering jargon ("rightmost 18% of frame", "frame-right of"), no vehicle 3D reasoning ("passenger side", "far-right window"), no colour adjectives. Less prose, less competition for attention, stronger signal.');
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

/** Render the user's text selection (if any) as a markdown block for the
 *  WORKING AREA. The selection lives on the active doc payload as
 *  `selectionStart` / `selectionEnd` (character offsets, not line/col),
 *  pushed by the GUI on every workingAreaState broadcast.
 *
 *  Returns an array of lines to splice into the WORKING AREA, or `[]`
 *  when there's nothing to render — caller iterates and pushes.
 *
 *  Why explicit lines vs a single-string block: callers already build
 *  the WORKING AREA as a `lines.push(...)` rope, so returning a list
 *  matches the surrounding style and the empty-array path is a clean
 *  no-op.
 *
 *  Trade-offs:
 *   - Reads the file SYNCHRONOUSLY each prompt build. The cost is one
 *     fs read per turn for the active text doc — negligible vs the
 *     LLM call latency. We could cache by mtime, but invalidation is
 *     a separate problem to introduce when reads start to dominate.
 *   - Caps the rendered snippet at MAX_SNIPPET chars. Multi-thousand-
 *     char selections happen (a whole scene block); the agent only
 *     needs an unambiguous reference, so truncation with a tail
 *     marker is sufficient.
 *   - Skips collapsed selections (caret only). A bare caret has no
 *     text antecedent — adding "the user's caret is on line 42" to
 *     EVERY prompt build would dilute the working-area block and
 *     mislead "esto" resolution. The `read_file` `editor.summary`
 *     path still reports caret position when the agent actually
 *     reads the doc.
 *   - Skips non-text docs. Image / video / pdf / web don't have a
 *     character-offset selection in this sense; their per-doc
 *     overlays use a different mechanism (DocumentBundle).
 */
function _renderTextSelection(active) {
  try {
    if (!active) return [];
    const isText = active.type === 'text' || active.type === 'html';
    if (!isText) return [];
    const start = typeof active.selectionStart === 'number' ? active.selectionStart : null;
    const end = typeof active.selectionEnd === 'number' ? active.selectionEnd : null;
    if (start == null || end == null) return [];
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    if (lo === hi) return []; // collapsed caret — no antecedent
    const filePath = active.path;
    if (!filePath || !fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const len = content.length;
    const a = Math.max(0, Math.min(lo, len));
    const b = Math.max(0, Math.min(hi, len));
    if (a === b) return [];

    // Convert (offset → 1-based line/col) by walking once. Faster than
    // splitting the whole file and works correctly with arbitrary line
    // endings (only \n is treated as a break, matching the editor).
    const offsetToLineCol = (off) => {
      let line = 1;
      let col = 1;
      for (let i = 0; i < off; i++) {
        if (content.charCodeAt(i) === 10 /* \n */) {
          line++;
          col = 1;
        } else {
          col++;
        }
      }
      return { line, col };
    };
    const startPos = offsetToLineCol(a);
    const endPos = offsetToLineCol(b);

    const MAX_SNIPPET = 1500;
    let snippet = content.slice(a, b);
    let truncated = false;
    if (snippet.length > MAX_SNIPPET) {
      snippet = snippet.slice(0, MAX_SNIPPET);
      truncated = true;
    }
    const sameLine = startPos.line === endPos.line;
    const rangeDesc = sameLine
      ? `line ${startPos.line}, columns ${startPos.col}–${endPos.col}`
      : `line ${startPos.line} col ${startPos.col} → line ${endPos.line} col ${endPos.col}`;

    const out = [''];
    out.push(
      `**The user has TEXT SELECTED** in this document — ${rangeDesc} (chars ${a}–${b} of ${len}).` +
      ' When they say "esto / this / esa parte / cambia esto / replace this / shorten this / resume eso", they mean THIS exact selection — NOT the whole document. Apply edits to this range only.',
    );
    out.push('');
    // Use a fenced code block with a hint of the file extension so the
    // markdown renderer doesn't try to interpret backticks inside the
    // snippet. Choice of `text` is conservative — every editor we
    // care about handles it, and the agent doesn't need syntax
    // highlighting to reason about prose.
    out.push('```text');
    out.push(snippet);
    if (truncated) out.push(`… [selection truncated to ${MAX_SNIPPET} chars; full range is chars ${a}–${b}]`);
    out.push('```');
    return out;
  } catch {
    // Best-effort: a missing file or a malformed offset shouldn't
    // crash prompt build. Drop the block and let the rest of the
    // WORKING AREA still render.
    return [];
  }
}

/**
 * Build the system prompt for all agents.
 * Single unified prompt — only the available intents change per agent.
 * @param {Agent} agent - The agent
 * @returns {{ static: string, dynamic: string }} Complete system prompt
 */
/**
 * Build the `# WORKING AREA` prompt block from the open-documents turn
 * snapshot (the docs/images/annotations the user has open in the GUI, plus
 * the guidance on how to use them). Extracted from buildSystemPrompt so
 * EXTERNAL callers (e.g. the Claude driver) inject the EXACT same context
 * instead of duplicating the logic. Reads the process-global
 * openDocumentsStore snapshot; returns a markdown string ('' when there is
 * no active document).
 */
export async function buildWorkingAreaBlock() {
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
    const _allDocs = openDocumentsStore.getSnapshotAll();
    // Render only the ACTIVE document. Non-visible tabs are intentionally
    // omitted — they add noise without helping the agent route the
    // current request. With no active doc there's nothing to surface, so
    // the # WORKING AREA block is dropped entirely.
    if (active) {
      let anyHasComposite = false;
      const lines = ['', '# WORKING AREA', ''];
      {
        const loc = active.path || active.url || '';
        lines.push(`The user is currently looking at: [${_classifyDoc(active)}] ${active.title}${loc ? ' — `' + loc + '`' : ''}`);
        // Precedence rule: an image attached to the latest message (a result
        // you just generated, or a file the user attached this turn) is the
        // CURRENT subject and takes priority over this working-area file as the
        // reference — otherwise an iterative edit ("make the lines thicker")
        // keeps re-editing the original here instead of your own last output.
        lines.push('If an image is attached to the latest message (one you just generated, or a file the user attached this turn), THAT image is the current subject — use it as your reference/edit base, NOT this working-area file, unless the user clearly means the document above.');
        // For videos, surface the exact playhead position so the agent
        // knows which frame the user is paused on. The GUI stamps
        // `playheadMs` onto the video doc payload at submit time.
        if (active.type === 'video' && typeof active.playheadMs === 'number') {
          lines.push(`Playhead paused at \`${_formatVideoTs(active.playheadMs)}\` (MM:SS.ms).`);
        }
        // Segment selection: the user has dragged the segment tool over the
        // filmstrip (they armed it, or you did with show_result selectSegment
        // because the clip is longer than an edit can cover). THAT window is
        // what they mean by "this part" — edit exactly it, never the whole clip.
        const _seg = active.type === 'video' ? active.selectedSegment : null;
        if (_seg && typeof _seg.startMs === 'number' && typeof _seg.endMs === 'number') {
          const _durS = ((_seg.endMs - _seg.startMs) / 1000).toFixed(1);
          lines.push(
            `The user has SELECTED the segment \`${_formatVideoTs(_seg.startMs)}\` → \`${_formatVideoTs(_seg.endMs)}\` `
            + `(${_seg.startMs}ms → ${_seg.endMs}ms, ${_durS}s) with the segment tool. Any edit they ask for applies to THAT segment: `
            + `cut it out of the source and edit the cut, never the whole clip.`,
          );
        }

        // Text selection: when the user has highlighted a range in a
        // text-like active doc, that range IS the demonstrative
        // antecedent ("esto / this / esa parte / change this"). Without
        // surfacing the selected snippet here, the agent only learns
        // about the highlight if it happens to call `read_file` —
        // which it often skips when the request feels like a
        // continuation ("resúmelo más corto", "cámbialo a tercera
        // persona"). The selection block must reach the prompt the
        // moment the user submits, not a turn later.
        const _selBlock = _renderTextSelection(active);
        if (_selBlock.length > 0) {
          for (const line of _selBlock) lines.push(line);
        }

        // Timeline + selected clip: when the user has clicked a specific
        // clip on the timeline, EVERY action they describe scopes to
        // that clip alone — not the whole timeline. Surface the clip's
        // source path so the agent passes IT (not the timeline JSON) as
        // videoFile / startFrame / referenceVideos / etc. Without this,
        // the agent treats "ponle sonido a este clip" as "render the
        // whole timeline and generate audio for it" — wrong scope.
        if (active.type === 'timeline' && active.path) {
          try {
            const _tlRaw = fs.readFileSync(active.path, 'utf8');
            const _tlJson = parseDocJson(_tlRaw, active.path);
            const _clips = Array.isArray(_tlJson?.clips) ? _tlJson.clips : [];
            const _selId = typeof active.selectedClipId === 'string' ? active.selectedClipId : null;
            const _selClip = _selId ? _clips.find((c) => c?.id === _selId) : null;

            const _3d = _clips.filter((c) => c?.scene3d?.sceneId && c.scene3d?.shotId);
            if (_3d.length > 0) {
              lines.push('');
              lines.push(`3D previz clips on this timeline (${_3d.length}) — the 3D is the SOURCE of each clip's real video:`);
              for (const c of _3d) {
                const _real = typeof c.path === 'string' && !c.path.startsWith('scene3d:');
                const _side = _real ? `showing its real take \`${c.path}\`${c.scene3d.renderStale ? ' (3D changed since — take out of date)' : ''}` : 'showing the 3D';
                lines.push(`- ${c.track || 'V1'} id ${c.id} (${(c.durationMs / 1000).toFixed(2)}s) scene3d ${c.scene3d.sceneId}/${c.scene3d.shotId}, ${_side}`);
              }
              lines.push('"Pásalo/pásalos a vídeo", "genera el vídeo real" on these clips: activate scene-3d + video-generator + cinematic-video-prompt-engineer and call prepare_scene3d_video { timelineId, clipIds } FIRST (it joins consecutive clips into ONE take — one longer generation, better continuity), generate each take with Seedance 2.5 and land it with assign_scene3d_take — never pass a `scene3d:` path to any media tool, it is not a file. Their length is protected: never trim them to fit a take.');
            }

            if (_selClip && typeof _selClip.path === 'string' && _selClip.scene3d) {
              lines.push('');
              lines.push(`**Selected clip on this timeline**: the 3D previz clip id ${_selClip.id} (scene3d ${_selClip.scene3d.sceneId}/${_selClip.scene3d.shotId}). "Este clip" means it; its real video comes from prepare_scene3d_video.`);
            } else if (_selClip && typeof _selClip.path === 'string') {
              // A specific clip is selected — narrow the agent's scope
              // to JUST that clip's source. Override beats listing.
              const _durSec = typeof _selClip.durationMs === 'number' ? (_selClip.durationMs / 1000).toFixed(2) : '?';
              const _trackLbl = _selClip.track ? ` on track ${_selClip.track}` : '';
              lines.push('');
              lines.push(`**Selected clip on this timeline${_trackLbl}**: \`${_selClip.path}\` (id ${_selClip.id}, ${_durSec}s of source).`);
              lines.push('When the user says "este clip", "esto", "this", "el segmento" — they mean this clip ONLY, not the whole timeline. Scope every media call to its source path: pass it as `videoFile` / `startFrame` / `referenceVideos` / `image` (whatever the tool expects), and use the clip\'s duration (not the timeline\'s) for any `durationSeconds` parameter. Reading the timeline JSON to find the clip is unnecessary — its source path is right above.');
            } else if (_clips.length > 0) {
              // No selection — list every clip's underlying source path
              // so the agent has the actual files in hand. Without this
              // the timeline JSON is the ONLY path the agent sees and
              // it ends up passing the JSON (or, worse, the last path
              // it saw in history — a generated SFX mp3, an image,
              // etc.) into tools like extract_frame, which then fail
              // with "Output file does not contain any stream".
              const _vClips = _clips.filter((c) => c?.path && /\.(mp4|mov|webm|mkv|avi|m4v|mpeg|mpg)$/i.test(c.path));
              const _aClips = _clips.filter((c) => c?.path && /\.(mp3|wav|m4a|flac|ogg|opus|aac)$/i.test(c.path));
              if (_vClips.length > 0) {
                lines.push('');
                lines.push(`Video clips inside this timeline (${_vClips.length}):`);
                for (const c of _vClips) {
                  const _durSec = typeof c.durationMs === 'number' ? (c.durationMs / 1000).toFixed(2) : '?';
                  const _trackLbl = c.track ? `${c.track} ` : '';
                  lines.push(`- ${_trackLbl}\`${c.path}\` (${_durSec}s, id ${c.id || '?'})`);
                }
              }
              if (_aClips.length > 0) {
                lines.push('');
                lines.push(`Audio clips inside this timeline (${_aClips.length}):`);
                for (const c of _aClips) {
                  const _durSec = typeof c.durationMs === 'number' ? (c.durationMs / 1000).toFixed(2) : '?';
                  const _trackLbl = c.track ? `${c.track} ` : '';
                  lines.push(`- ${_trackLbl}\`${c.path}\` (${_durSec}s, id ${c.id || '?'})`);
                }
              }
              if (_vClips.length > 0) {
                lines.push('');
                lines.push('When the user says "el vídeo" / "the video" / "este vídeo" / refers to "the last frame" or any moment of "the video", they mean **the video clip(s) above** — pass one of THESE paths to `extract_frame`, `generate_video`, `generate_audio.videoFile`, etc. NEVER pass the timeline JSON path itself, NEVER pass an audio file, NEVER pass a generated image — those are not videos and the underlying tools (ffmpeg) will fail with cryptic stream errors.');
              }
            }
          } catch { /* malformed JSON or fs error — fall through silently */ }
        }

        // Storyboard on its TIMELINE view: every scene in 3D beside the
        // montage. "Este plano / la cámara / que entre antes" = the 3D shot
        // the user picked (or the montage as a whole).
        if (active.type === 'storyboard' && active.montage && typeof active.montage.timelinePath === 'string') {
          lines.push('');
          lines.push(`The storyboard is on its TIMELINE view: the 3D scenes (free camera, every shot camera in place) beside the montage timeline \`${active.montage.timelinePath}\` (one 3D shot per storyboard shot, in script order; trims / reorders there are written back to the storyboard automatically).`);
          try {
            const _tl = readDocJson(active.montage.timelinePath);
            const _sel = typeof active.montage.selectedClipId === 'string'
              ? (_tl.clips || []).find((c) => c?.id === active.montage.selectedClipId) : null;
            if (_sel?.scene3d) {
              const _l = _sel.scene3d;
              lines.push(`**Selected 3D shot**: storyboard shot \`${_l.storyboardShotId || '?'}\` (scene ${_l.storyboardSceneId || '?'}) = scene3d \`${_l.sceneId}\` shot \`${_l.shotId}\`${_sel.path && !_sel.path.startsWith('scene3d:') && !_sel.path.includes('/scenes3d/') ? `, real video \`${_sel.path}\`${_sel.scene3d?.renderStale ? ' (3D changed since — out of date)' : ''}` : ''}.`);
              lines.push('"Este plano", "la cámara", "que entre antes", "más cerrado" mean THIS shot: change its staging / camera / timing with get_scene3d → update_scene3d (scene-3d skill) — the card and the montage re-render by themselves; change its script text (dialogue, action wording) with update_storyboard. Generating its real video ("pásalo a vídeo"): prepare_scene3d_video { timelineId: "' + path.basename(active.montage.timelinePath, '.json') + '", clipIds: ["' + _sel.id + '"] } first, then generate_video (Seedance 2.5) + assign_scene3d_take — the clip keeps its length and the 3D stays its source.');
            } else {
              lines.push('No shot is selected: a request about "the scene" / "the 3D" applies to the scene(s) it names — use get_scene3d { storyboardId } to find them.');
              lines.push('To turn montage clips into real video: prepare_scene3d_video { timelineId: "' + path.basename(active.montage.timelinePath, '.json') + '", clipIds? } (omit clipIds = every clip still in 3D) — consecutive clips come back as ONE take; generate it with Seedance 2.5 and land it with assign_scene3d_take.');
            }
          } catch { /* montage not on disk yet */ }
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

      // Other open media (videos / timelines that aren't the active
      // doc). When the user asks for "una imagen del último fotograma"
      // / "el primer frame" / "este momento del vídeo" the right answer
      // is `extract_frame` on that source first, then pass the PNG as
      // `referenceImages` to generate_image — NOT a text-only prompt.
      // Surfacing the path here gives the agent the input it needs to
      // wire that chain even when the active tab is unrelated (e.g.
      // the user is looking at an image they just generated and asks
      // about a video that's still open behind it).
      try {
        const _otherMedia = (_allDocs || [])
          .filter((d) => d && d !== active && (d.type === 'video' || d.type === 'timeline') && (d.path || d.url));
        if (_otherMedia.length > 0) {
          lines.push('');
          lines.push('Other open media (not the active tab, but the user may still be referring to them):');
          for (const d of _otherMedia) {
            const _loc = d.path || d.url;
            lines.push(`- [${d.type}] ${d.title || d.id} — \`${_loc}\``);
          }
          lines.push('');
          lines.push('**Frame-reference rule** — when the user\'s request mentions a specific frame or moment of any video/timeline ("último fotograma", "primer frame", "este instante", "ese momento", "the last frame", "frame at 0:03", "como se vería desde otro ángulo en este punto"), DO NOT go straight to text-to-image. Chain:');
          lines.push('  1. `extract_frame` on the referenced source — `lastFrame: true` for "último/last frame", or `timeMs: <ms>` for a specific moment. Yields a still PNG.');
          lines.push('  2. `generate_image` with that PNG in `referenceImages` and a MINIMAL prompt that describes ONLY the variation requested.');
          lines.push('  3. (Optional) `generate_video` with the result image as `startFrame` if the user wanted motion.');
          lines.push('');
          lines.push('**Prompt discipline for step 2 — read this twice.** When the user asks for "otro ángulo de la misma escena" / "another angle of the same scene" / "vista desde X" / "POV de Y", the prompt must:');
          lines.push('- Describe ONLY the camera change (angle, position, distance, height) and any explicitly-requested edit. Ten to thirty words is plenty.');
          lines.push('- **NEVER invent setting, location, or weather** that aren\'t in the reference. If the reference shows a Manhattan street at sunset, do NOT write "jungle floor", "humid jungle atmosphere", "forest", "desert", "snow", "underwater", or any other ambient description that contradicts what\'s on screen. The reference IS the setting; trust it.');
          lines.push('- **NEVER add new subjects** (a fallen woman, extra animals, bystanders, vehicles…) that weren\'t in the reference. The user wants the same scene from a new viewpoint, not a different scene.');
          lines.push('- Optionally end with a short anchor like *"preserve the setting, lighting, palette, weather, time of day, and surrounding architecture from the reference image."* This explicit anchor counters the edit model\'s tendency to drift toward generic dinosaur tropes (jungle / Jurassic Park).');
          lines.push('');
          lines.push('Concrete example for "vista aérea desde detrás del T-Rex en el último fotograma" with a Manhattan reference:');
          lines.push('  - ✅ GOOD: `"Aerial high-angle shot from directly above and behind the T-Rex\'s head, camera pointing forward down the same street. Preserve the Manhattan setting, sunset lighting, taxis and skyscrapers from the reference image."`');
          lines.push('  - ❌ BAD: `"Aerial bird\'s-eye view of a T-Rex in a humid jungle. A young woman lies on the jungle floor looking up in terror. Cinematic dinosaur encounter."` (invented jungle, invented woman, ignored Manhattan setting → result is a totally different scene).');
          lines.push('');
          lines.push('Skipping step 1 makes generate_image hallucinate a plausible-but-wrong scene. Even with the frame as reference, an over-elaborate prompt at step 2 ALSO drifts away from the source — the model has to choose between your prose and the picture, and a wordy prose wins. Keep prose short, factual, scoped to the change.');
          lines.push('');
          lines.push('**`extract_frame.video` MUST be a video file path** (`.mp4` / `.mov` / `.webm` / etc.) — one of the paths listed above. NEVER pass an audio file you just generated (`sfx_*.mp3`, `*.wav`), an image (`.png`/`.jpg`), or a timeline JSON (`.json`) here. ffmpeg will fail with "Output file does not contain any stream" and you\'ll loop. If unsure which is the source video, look for the `.mp4` under `<project>/videos/` or the path surfaced in the read_file result of the timeline.');
        }
      } catch { /* best-effort surfacing */ }

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
      // ONLY genuine image docs, via the robust classifier (type + extension).
      // The old `type !== 'video'` matched text/html/pdf/timeline/storyboard
      // too, so a .md (type 'text') wrongly got the "Active document is an
      // IMAGE — generate_video rules" block with the .md as `startFrame`.
      const activeIsImage = _classifyDoc(active) === 'image';
      const activeAnnsForBlock = activeIsImage && active.bundle?.annotations
        ? active.bundle.annotations.filter((a) => a?.role === 'composite-snapshot')
        : [];

      // ── "Animate this image" — ALWAYS applies when the active doc is
      // an image, with or without annotations. The photomontage block
      // below only fires for annotated images, so without this general
      // block the agent had no anchor for plain "anima esta imagen" /
      // "give this life" / "make a video out of this" requests and
      // would happily route the image through `referenceImages` (which
      // sends it to seedance-2.0/reference-to-video — wrong shape, ends
      // up generating an unrelated clip) or split the task into
      // multiple `shots` / a generate_image → generate_video pipeline
      // the user did not ask for. Both regressions were reported by
      // the user as "$216 wasted on a random clip" and "no quiero
      // múltiples clips ni montajes ni pollas si no lo especifica
      // claramente el usuario". The block below makes the contract
      // explicit and includes the verbatim call shape.
      if (activeIsImage && active && (active.path || active.url)) {
        const activeLoc = active.path || active.url;
        const saveDir = path.dirname(activeLoc);
        lines.push('');
        lines.push('## ⚠ Active document is an IMAGE — `generate_video` rules');
        lines.push('');
        lines.push('> **FIRST, and ADDITIONALLY to these rules: scan the AVAILABLE SKILLS catalog and `activate_skill` every skill whose description is on-topic with what the user is asking.** These active-document rules are a generic FALLBACK recipe, NOT a replacement for skill activation — a matching skill carries the specialised recipe and MUST be loaded before you compose the call. **A loaded SKILL\'s instructions take PRECEDENCE over these generic active-document rules: when they differ, follow the SKILL — these rules are only the fallback for when no skill covers the request.** So: activate the matching skill(s) first, then compose the call driven by the skill\'s instructions. Do not let this block short-circuit skill routing.');
        lines.push('');
        lines.push('When the user asks to ANIMATE / move / "darle vida a" / "make a video out of" this image — or any similar request whose subject is the active image — the call MUST be:');
        lines.push('');
        lines.push('```yaml');
        lines.push(`intent: generate_video
startFrame: "${activeLoc}"
prompt: |
  <short, concrete motion brief — what moves, how, camera behaviour>
duration: 5
saveTo: "${saveDir}"`);
        lines.push('```');
        lines.push('');
        lines.push('Hard rules (violating any of these is a bug):');
        lines.push('  • The active image goes in `startFrame`, NEVER in `referenceImages`. `startFrame` = the literal first frame of the video (image-to-video conditioning). `referenceImages` = unrelated style / subject sheets, which routes to a reference-to-video model that has no concept of a starting frame and will invent a clip unrelated to your image. This is a routing-changer, not a stylistic choice.');
        lines.push('  • ONE SINGLE `generate_video` call. Do NOT split into multiple shots, do NOT chain `generate_image` → `generate_video`, do NOT propose a montage, do NOT add `shots[]` unless the user explicitly asked for several segments. "Animar" means a single image-to-video pass, full stop.');
        lines.push('  • Do NOT pass `referenceVideos` here.');
        lines.push('  • Do NOT pass `aspectRatio` or `resolution` — the model preserves the input dimensions; setting them forces a downsample/crop.');
        lines.push('  • Pass `duration` only when the user named a length; otherwise omit and let the router use the model default.');
        lines.push('');
        lines.push('If the user explicitly asks for MORE than one clip, a sequence, a storyboard, or specific named shots, only then is multi-shot or pipelined generation appropriate.');
        lines.push('');
      }

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
        const saveDir = path.dirname(activeLoc);
        lines.push('');
        lines.push('## ⚠ ACTIVE document is a photomontage — act, do not ask');
        lines.push('');
        lines.push('The composite IS the spec. Forbidden to ask "qué composición?" / "which composition?"; the answer is the image already attached.');
        lines.push('');
        lines.push(`1. **read_file "${activeLoc}"** first. Vision receives the base + composite in order; pasted-cutout sources ride along in the bundle but are NOT auto-attached (they flow into generate_image as refs).`);
        lines.push('2. Then dispatch the real work: `generate_image` for edits/compositions, `background_removal`, `upscale_image`, or — when the user asks to animate / move / "give it life" / make a video out of it — `generate_video`.');
        lines.push('3. For `generate_image` use EXACTLY this shape (base → composite → sources):');
        lines.push('');
        lines.push('```yaml');
        lines.push(`intent: generate_image
prompt: |
  Edit the FIRST reference image. The SECOND is a composite snapshot showing EXACTLY where and at what size/angle the pasted elements land — use as PLACEMENT guide. The REMAINING refs are the high-fidelity sources. Apply: <paraphrase the user's request>.
referenceImages: ${refJson}
saveTo: "${saveDir}"`);
        lines.push('```');
        lines.push('');
        lines.push('4. For `generate_video` (animate the marked image) — image-to-video models REQUIRE the source image as `startFrame` (the first frame of the animation). The annotated composite goes in `referenceImages` as supplementary visual context — DO NOT put the base image in both fields, that\'s redundant and some adapters reject duplicates.');
        lines.push('');
        lines.push('```yaml');
        lines.push(`intent: generate_video
prompt: |
  <detailed brief — describe the marked subject by physical attributes + position + pose, name what should move/change, then explicitly list what to keep static/intact>
startFrame: "${activeLoc}"
referenceImages: ${animRefJson}
saveTo: "${saveDir}"`);
        lines.push('```');
        lines.push('');
        lines.push('**Critical**: `startFrame` is mandatory for image-to-video. Omitting it causes the call to fail with `body.image_url: Field required` because the gateway only sets `image_url` when a `startFrame` is provided (see `gateway.service.ts`).');
        if (hasDrawnMarks) {
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
        const saveDir = path.dirname(activeLoc);
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
        lines.push('```yaml');
        lines.push(`intent: generate_video
prompt: |
  <paraphrase the user's request, describing the desired result>
referenceVideos: ["${activeLoc}"]
saveTo: "${saveDir}"`);
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
          lines.push('```yaml');
          lines.push(`intent: generate_video
prompt: |
  <numbered, timestamp-anchored directives per step 3>
referenceVideos: ["${activeLoc}"]
referenceImages: ${refImagesJson}
saveTo: "${saveDir}"`);
          lines.push('```');
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
        // Resolve the actual scope path: if the user has a clip
        // selected on a timeline, every audio call must target that
        // clip's source — NOT the timeline JSON. Falls back to the
        // active doc path when there's no selection (whole timeline /
        // raw video). Computed once so the example JSON below shows
        // the right thing in both cases.
        let _scopePath = _activeLoc;
        let _scopeIsSelectedClip = false;
        let _scopeDurationMs = null;
        if (active.type === 'timeline' && typeof active.selectedClipId === 'string') {
          try {
            const _tlRaw = fs.readFileSync(active.path, 'utf8');
            const _tlJson = parseDocJson(_tlRaw, active.path);
            const _clip = Array.isArray(_tlJson?.clips)
              ? _tlJson.clips.find((c) => c?.id === active.selectedClipId)
              : null;
            if (_clip && typeof _clip.path === 'string') {
              _scopePath = _clip.path;
              _scopeIsSelectedClip = true;
              if (typeof _clip.durationMs === 'number') _scopeDurationMs = _clip.durationMs;
            }
          } catch { /* fall back to active doc path */ }
        }
        lines.push('');
        lines.push(`## 🔊 ACTIVE document is a ${_activeKind} — adding audio`);
        if (_scopeIsSelectedClip) {
          const _durSec = _scopeDurationMs != null ? (_scopeDurationMs / 1000).toFixed(2) : '?';
          lines.push('');
          lines.push(`**Scope: a single clip is SELECTED on the timeline.** Every audio call below MUST target \`${_scopePath}\` (the clip's source video, ${_durSec}s) — NOT the timeline JSON. This is non-negotiable: ignoring the selection means generating audio for a section the user wasn't pointing at.`);
        }
        lines.push('');
        lines.push('### C) ADD SFX / SOUND / FOLEY (the user said "sonido" / "audio" / "SFX" / "Foley" / "ambient sound")');
        lines.push('');
        lines.push('**This is NOT a clarification step.** Do NOT call `prompt_user`. Do NOT propose music chips. Do NOT ask "qué tipo de música prefieres". The user said "sonido" — that means **diegetic SFX synchronised to what\'s on screen**, not music. Go straight to the workflow below.');
        lines.push('');
        lines.push('**Workflow — strictly required before calling `generate_audio`:**');
        lines.push('');
        lines.push(`1. **Call \`read_file\` on \`${_scopePath}\`.** Do NOT use shell, ls, stat, or any size check first — \`read_file\` on a video samples four evenly-spaced frames via ffmpeg, the cost is constant regardless of file size, and there is no other path to vision here. Skipping this step is the canonical failure mode: the agent guesses "cinematic ambient sound design" from the filename and generates audio unrelated to the content.${_scopeIsSelectedClip ? ' (For the selected clip, this is the clip\'s source video.)' : (active.type === 'timeline' ? ' (For a timeline, the engine renders / picks a representative video automatically — you still call read_file on the timeline JSON path.)' : '')}`);
        lines.push('');
        lines.push('2. Identify the dominant on-screen action / texture / mood (e.g. "wooden building engulfed in flames, crackling and roaring, people running with metal buckets"; "calm forest path with leaves rustling and footsteps on gravel"; "underwater scene with bubbles and muffled ambient hum").');
        lines.push('');
        lines.push(`3. Write the \`generate_audio\` call with \`mode: "sfx"\`. **Pass \`videoFile: "${_scopePath}"\`** — with \`videoFile\` present the router lands on a video-conditioned model (mmaudio-v2) that synchronises the SFX to the visible action: silence for the silent moments, peaks at impact frames. Without \`videoFile\` you fall back to a text-only sfx model (ElevenLabs) which produces a generic clip that won't sync.${_scopeIsSelectedClip ? ' DO NOT use the timeline JSON path here — it would generate audio for the WHOLE timeline; the user has a single clip selected and that\'s the scope.' : ''}`);
        lines.push('');
        lines.push(`**\`durationSeconds\` is non-negotiable**: copy it VERBATIM from the \`durationSec\` field in your \`read_file\` result (or the clip\'s duration if a clip is selected). NEVER round to 10, 12, 15, etc. Audio that runs longer than the source plays past the end of the video — the SFX track and the visual cease being in sync. If you can\'t see a numeric \`durationSec\` in the previous tool results, re-read the file before calling this.`);
        lines.push('');
        lines.push('```yaml');
        const _durExample = _scopeDurationMs != null ? (_scopeDurationMs / 1000).toFixed(2) : '<exact durationSec from read_file — do NOT default to 10>';
        lines.push(`intent: generate_audio
mode: sfx
prompt: |
  <concrete sound description anchored in what's on-screen>
videoFile: "${_scopePath}"
durationSeconds: ${_durExample}
saveTo: "<absolute path>.mp3"`);
        lines.push('```');
        lines.push('');
        lines.push('Even with the video-conditioned model, the prompt still matters — it disambiguates which sounds to emphasise. Specific sensory prompts ("crackling fire, collapsing wooden beams, distant shouts and metal buckets clanging") produce specific audio; vague prompts ("background sound") get vague audio.');
        lines.push('');
        lines.push('### D) ADD MUSIC / SCORE / SOUNDTRACK (only when the user explicitly says "música" / "soundtrack" / "score" / "backing track")');
        lines.push('');
        lines.push('Music is text-only, NOT video-conditioned — the model does not watch the frames. Read the active doc anyway so you can describe the mood / genre / pacing that fits the visuals, then call `generate_audio` with `mode: "music"`. **Do NOT pass `videoFile`** — in music mode it would be ignored.');
        lines.push('');
        lines.push('```yaml');
        lines.push(`intent: generate_audio
mode: music
prompt: |
  <mood + instrumentation + tempo + structure, e.g. 'epic orchestral score with cellos and percussion, slow build into a crescendo at 0:20'>
durationSeconds: <duration>
saveTo: "<absolute path>.mp3"`);
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
      lines.push('- **DO NOT NAME OR DESCRIBE THE SUBJECT** of the active media doc before you have `read_file`\'d it. The "Recalled Context" / "Previous Sessions" / "@mention handles" blocks above may name characters, locations, or themes from prior work in this project — those memories tell you NOTHING about what is actually inside THIS specific file. If the user says "anima esta imagen" and you reply "voy a animar la imagen de \\<character_X\\>" without having read the file, you are confabulating from project history. The image may be of something completely different. This applies to EVERY text-emitting action — `print`, `prompt_user`, and delegate task `description` / `subject` fields. Use neutral language ("esta imagen", "la imagen activa", "this image", "the active document") until a `read_file` result is in your context. Only AFTER you have visually inspected the file are you allowed to name what you see.');
      lines.push('- **READ BEFORE DELEGATING** when the task depends on content. If the user uses a demonstrative ("esta imagen", "este video", "this clip") AND the requested action requires understanding the contents (animate, describe, edit, generate a variation, write a prompt about the subject, identify the character/scene, …) → `read_file` the active doc FIRST, then craft the delegate task with grounded facts. Batching `read_file` + `worker::do_task` in the SAME response is forbidden (no fact may be referenced before its retrieval result lands — see the GOLDEN RULE block). Spend one turn reading, then delegate on the next turn with what you actually saw.');
      lines.push('- **Read** active doc → `read_file` with its path/URL. Images & web come back as vision; if there\'s a composite, it\'s queued right after as `[ANNOTATIONS OVERLAY]` (image) or `[ANNOTATIONS @ MM:SS.ms]` (video — one per annotated frame, chronological).');
      lines.push('- **Write/edit text docs** → `edit_file` / `write_file` directly, inline — never delegate to a sub-agent for working-area edits. "continúa / sigue / añade" = append; "replace / rewrite" = replace. Never report success without a real tool call.');
      lines.push('- **Non-text active docs** (image/pdf/web) — dispatch to the right media tool (`generate_image`, `background_removal`, …); never claim to have edited in place.');
      lines.push('- **Ambiguity** between open text docs → `prompt_user` before writing.');
      lines.push('- **Text selection** — if a "**The user has TEXT SELECTED**" block appears above, that range IS the demonstrative antecedent ("esto / this / change this / shorten this") and the only thing your edit must touch. Do NOT replace the whole file.');
      if (active && (active.path || active.url)) {
        const activeLoc = active.path || active.url;
        const isText = active.type === 'text' || active.type === 'html';
        lines.push('');
        lines.push('Example — read the active document:');
        lines.push('```yaml');
        lines.push(`intent: read_file
path: "${activeLoc}"`);
        lines.push('```');
        if (isText) {
          lines.push('');
          lines.push('Example — write into the active text document (default target for "add/write/fill" requests):');
          lines.push('```yaml');
          lines.push(`intent: write_file
path: "${activeLoc}"
content: "..."`);
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
  return openDocumentsBlock;
}

/** The fixed rules for a phase that cannot `return`: finishing the phase is `phase_done`, and `return` is never named. */
function _withoutReturn(text) {
  return text
    .replace(/Only emit this when the full task is complete:\nactionType: direct\nintent: return\ndata:\n  \.\.\.\n/,
      'Only emit this when the work of THIS phase is complete (it moves the run on; you cannot end the task from this phase):\nactionType: direct\nintent: phase_done\n')
    .replace('Do not return early.', 'Do not finish the phase early.')
    .replace('You must complete all required follow-up actions before returning.', 'You must complete all required follow-up actions of this phase before calling phase_done.')
    .replace('5. Never return before the whole task is done', '5. Never call phase_done before the work of this phase is done')
    .replace('emit analysis, summary, print, or return content based on that result', 'emit analysis, summary or print content based on that result')
    .replace('- a print, answer, summary, conclusion, or return payload that depends on that retrieval', '- a print, answer, summary or conclusion that depends on that retrieval');
}

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

  // Non-interactive mode: agent must act without asking for confirmation.
  // Fires for BOTH the headless `--exit` mode and the per-session YOLO toggle
  // (same "never ask" behavior, centralized in isNonInteractive()). The header
  // surfaces YOLO explicitly in the prompt so the model knows the user enabled
  // it for this chat.
  const nonInteractiveBlock = isNonInteractive() ? `

========================================
${isYoloMode() ? 'YOLO MODE ACTIVATED — FULL AUTOPILOT' : 'NON-INTERACTIVE MODE'}
========================================
${isYoloMode() ? '\nThe user has enabled YOLO mode for this chat. Act fully autonomously: assume every answer is "yes / go ahead", never pause to confirm, and keep working until the task is done.\n' : ''}
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

Return exactly ONE valid YAML document and nothing else.
- No markdown code fences
- No explanations
- No prose outside the YAML
- The ENTIRE response is the YAML: either a single action mapping (top-level keys like actionType/intent) or a "batch:" mapping.

Use block style with 2-space indentation. For ANY multi-line or punctuation-heavy text value (a prompt, a message, a director's brief), use a YAML block scalar with "|" so colons, quotes, "#" and newlines inside it are safe:

intent: print
message: |
  Multi-line text goes here.
  Colons (a: b), "quotes", and # are all safe inside a | block.

FILE CONTENT (write_file "content", edit_file "diff"): do NOT inline HTML/CSS/code as a YAML value and do NOT use a "|" block for it — punctuation like "line-height: 1.6;" or "{ margin: 0; }" breaks the parser, and block-scalar indentation is the #1 batch-breaker. Instead pass it as a HEREDOC: set the field to a reference token "KOI_HEREDOC_<n>", then place the verbatim payload between sentinel lines AFTER the YAML document. The body is taken literally — no escaping, no indentation, any characters are safe:

batch:
  - actionType: direct
    intent: write_file
    path: page.html
    content: KOI_HEREDOC_1
###KOI_HEREDOC_1_START###
<!doctype html>
<style>body { margin: 0; line-height: 1.6; }</style>
<h1>Hi: there # really</h1>
###KOI_HEREDOC_1_END###

Use a distinct number per file (KOI_HEREDOC_1, KOI_HEREDOC_2, …) and one START/END pair per token. Put all heredoc blocks after the YAML. The START/END marker lines must each be on their own line.

Never output invalid YAML. Invalid YAML crashes the system.

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

Every action mapping MUST include:
- actionType
- intent

ONE action = ONE intent = ONE mapping. Each mapping contains ONLY the fields defined for that specific intent. NEVER add fields from a different intent into the same mapping — extra fields are silently ignored and the second action will NOT execute. If you need two actions, use a batch with two separate mappings.

Valid action types:
- direct${hasTeams ? '\n- delegate' : ''}

Intent rules:
- For direct actions: "intent" MUST be exactly one of AVAILABLE ACTIONS.${hasTeams ? '\n- For delegate actions: "intent" MUST follow "agentKey::eventName" and refer to a valid available agent/event.' : ''}
- Never invent new intents.
- Never put descriptive text inside "intent". Put that text in "query", "pattern", "message", "question", or other parameters.

Invalid:
actionType: direct
intent: semantic index supported languages

Valid:
actionType: direct
intent: semantic_code_search
query: semantic index language parser support

========================================
BATCH
========================================

"batch" is a TOP-LEVEL-ONLY key. It cannot coexist with actionType, intent, or any other action field. If you need to do multiple things in one turn (e.g. print + phase_done), use a batch — a "batch:" key whose value is a sequence ("- ") of action mappings:

batch:
  - actionType: direct
    intent: print
    message: "Here is the result."
  - actionType: direct
    intent: phase_done

CRITICAL YAML INDENTATION (this is the #1 way a batch breaks): every "- actionType:" in a
batch MUST sit at the SAME indent. When an action has a multi-line value ("message: |" /
"prompt: |"), EVERY line of that block MUST be indented DEEPER than its key, and the NEXT
"- actionType:" MUST dedent back to the sequence indent — otherwise the block silently
swallows the following actions and they never run. If you are unsure about indentation for a
long value, prefer a single-line double-quoted string with \\n escapes over a "|" block.

========================================
EXECUTION FLOW
========================================

Each response is ONE YAML document — a single action mapping or a "batch:" (per OUTPUT CONTRACT above). Use sequential steps only when later actions depend on earlier results.

Parallelism is mandatory:
- If 2+ actions are independent, they MUST go inside a "parallel" block
- Never place independent actions sequentially in a batch${hasPromptUser ? '\n- EXCEPTION: prompt_user must NEVER be inside a parallel block' : ''}

Examples:

Single action:
actionType: direct
intent: semantic_code_search
query: authentication login session token

Parallel:
batch:
  - parallel:
      - actionType: direct
        intent: semantic_code_search
        query: semantic index build embed vector store
      - actionType: direct
        intent: semantic_code_search
        query: language support parser javascript typescript python

Sequential then parallel:
batch:
  - actionType: direct
    intent: read_file
    path: src/index.ts
    offset: 0
    limit: 120
  - parallel:
      - actionType: direct
        intent: grep
        pattern: semanticIndex
      - actionType: direct
        intent: grep
        pattern: supportedLanguages

Only emit this when the full task is complete:
actionType: direct
intent: return
data:
  ...

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

${resourceSection}${intentNesting}`;

  // ── Working area: documents the user has open in the GUI ──
  // Pulled from the in-memory store (open-documents-store), populated by the
  // CLI layer when the GUI reports tab changes.
  const openDocumentsBlock = await buildWorkingAreaBlock();

  // KNOWN MEDIA HANDLES block REMOVED on purpose.
  //
  // Previously this dumped every `@mention` pinned via tag_media into
  // the prompt — up to 50 entries with type + description per turn,
  // worth several hundred tokens. In practice the agent almost never
  // looked at it: (a) when the user actually wants a specific handle,
  // they type `@xxx` into their message and the handle arrives in the
  // user content directly, so the inventory adds nothing; (b) when the
  // agent wants to discover existing media before generating new
  // assets, it can call `list_media` / `recall_image` on demand at the
  // moment it needs them, which is far cheaper than carrying the whole
  // catalog in every turn's static prefix; (c) the @ autocomplete in
  // the chat input is the right surface for users browsing handles,
  // not the agent's prompt. Removed the block; left this comment so a
  // future maintainer doesn't re-add it without thinking through these
  // points first.
  const mentionVocabularyBlock = '';

  // Expanded tool schemas: full docs for every tool the agent has
  // already requested via `get_tool_info` this session. Lives in the
  // DYNAMIC section (not static) — the static prefix must stay stable
  // across turns so the prompt cache hits; if we put this here it
  // would change every time the agent asked for a new tool and every
  // subsequent call would re-tokenise the entire prefix.
  const expandedToolsBlock = actionRegistry.generateExpandedToolsBlock(agent);

  // ── Dynamic section: runtime context, project map, language, non-interactive ──
  // ffmpeg path/version — the agent's media tools and ad-hoc shell
  // calls (e.g. `ffmpeg -i in.mp4 -c copy ...`) all need to know where
  // the controlled binary lives. The Koi pipeline pins ffmpeg 8.1.1
  // via `ffmpeg-installer.js`; surface that path here so the agent
  // doesn't shell out to `which ffmpeg` and accidentally pick up a
  // system ffmpeg 4.x or 5.x with stale flags.
  const _ffmpeg = _resolveFfmpegInfo();
  const ffmpegField = _ffmpeg.path
    ? `\n| ffmpeg | \`${_ffmpeg.path}\` (v${_ffmpeg.version}) |`
    : `\n| ffmpeg | not yet installed — runs via Koi's installer on first media call (pinned v${_ffmpeg.version}). Prefer the high-level media actions over raw shell \`ffmpeg\` calls. |`;

  // Session working dir — the per-session scratch area at
  // `<projectRoot>/.koi/sessions/<sessionId>`. Surfacing it in the
  // runtime context (and pinning it with the `*` note below) is what
  // pushes the agent to drop intermediate artefacts (downloaded inputs,
  // generated assets, scratch JSON, tool outputs) inside the session
  // folder instead of polluting the project root with random files
  // that survive after the session ends.
  const _projectRoot = process.env.KOI_PROJECT_ROOT || cwd;
  const _sessionId = process.env.KOI_SESSION_ID || agent?.sessionId || null;
  const sessionWorkingDirField = _sessionId
    ? `\n| Session working dir | \`${path.join(_projectRoot, '.koi', 'sessions', _sessionId)}\` |`
    : '';

  // When the agent is executing a step of a workflow run, expose the run's
  // workspace dir so it can save/read step<N>_output.json there without
  // having to glob-search across all `.koi/workflows/wfr-*` runs (the user
  // reported Step N+1 picking up the wrong run's snapshot). Set on the
  // agent by the delegate-args handler in agent.js when args carry
  // `workflowWorkspace`.
  const _workflowWorkspace = agent?._currentWorkflowWorkspace || null;
  const _workflowRunId = agent?._currentWorkflowRunId || null;
  const workflowWorkspaceField = _workflowWorkspace
    ? `\n| Workflow workspace | \`${_workflowWorkspace}\`${_workflowRunId ? ` (runId \`${_workflowRunId}\`)` : ''} |`
    : '';

  // Changes every turn (timestamp, task counts, phase). Placed AFTER the agent's
  // playbook so the static prefix (generic rules + agent playbook) is maximally cacheable.
  const dynamic = `${phaseSystemBlock}
# RUNTIME CONTEXT

| Field | Value |
|---|---|
| Current date/time | \`${now}\`${timezone ? ` (${timezone})` : ''} |
| Working directory | \`${cwd}\` |${platformField}${sessionWorkingDirField}${workflowWorkspaceField}${langField}${ffmpegField}

All file paths (read_file, edit_file, write_file, shell) are relative to working directory unless absolute.
${_sessionId ? `* **Session working dir**: write every intermediate / process file you produce during this session (downloads, scratch JSON, tool outputs, generated assets you don't intend to ship as final deliverables, transient logs) inside the "Session working dir" above. Keep the project root clean — only files the user explicitly asked to create/edit in the project belong there.\n` : ''}${_workflowWorkspace ? `* **Workflow workspace**: shared scratch space across the steps of THIS workflow run. Save your step's persistent outputs here (e.g. \`step<N>_output.json\` with paths/IDs the next step needs) and read prior steps' outputs from here. Do NOT glob-search the parent \`.koi/workflows/\` directory — other concurrent / older runs live there.\n` : ''}
**LANGUAGE:** The "User language" field above is set automatically by the runtime whenever a new user message arrives — trust it. All user-facing output (print, prompt_user, questions) must be in that language. Code and technical identifiers stay in English. You do not need (and cannot) change the language yourself — it tracks the user's latest message natively.
${openDocumentsBlock}${mentionVocabularyBlock}${nonInteractiveBlock}${expandedToolsBlock}
REMINDER: intent must be one of AVAILABLE ACTIONS (enum). Never invent new intents. Descriptions go in query / other fields.`;

  // A phase that denies `return` (`cant return`) must not see it anywhere (Antonio, 23/11/2026): the action list
  // already hid it, but the fixed rules above still taught «intent: return … when the task is complete», and an
  // agent in a middle phase followed them. In such a phase every mention of returning becomes `phase_done`.
  const _phaseCfg = statusPhase ? agent?.phases?.[statusPhase] : null;
  const _cantReturn = Array.isArray(_phaseCfg?.deniedPermissions) && _phaseCfg.deniedPermissions.includes('return');
  const staticOut = _cantReturn ? _withoutReturn(staticPart) : staticPart;

  return { static: staticOut, dynamic, koiMd };
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

  // Shared budgeted listing for AGENTS and WORKFLOWS. Same idea as the skill
  // catalog: show a description per entry, but bound the total with a budget
  // and each entry with a per-entry cap so one giant description (or a long
  // list) can't bloat the prompt. There is no usage store for agents/workflows,
  // so every entry is treated EQUALLY — same per-entry cap = min(maxEntry,
  // budget/count) — and when that falls below a useful floor they ALL drop to
  // name-only together (no list-order entry is singled out). The full text is
  // always available via describe_agent / describe_workflow.
  const _budgetedDescList = (entries, { budget, maxEntry, floor = 80 }) => {
    const cut = (text, max) => {
      const s = String(text || '').trim();
      if (s.length <= max) return s;
      const slice = s.slice(0, max);
      const sp = slice.lastIndexOf(' ');
      return (sp > max * 0.6 ? slice.slice(0, sp) : slice).trimEnd() + '…';
    };
    const cap = entries.length > 0 ? Math.min(maxEntry, Math.floor(budget / entries.length)) : 0;
    return entries.map(e => {
      const natural = String(e.description || '').trim();
      const give = Math.min(natural.length, cap);
      const body = (give >= floor && natural) ? ` — ${cut(natural, give)}` : '';
      return `- ${e.label}${body}`;
    });
  };

  // ── AVAILABLE AGENTS ────────────────────────────────────────────────────
  let delegateResources = resources.filter(r => r.type === 'delegate');

  // Phase-based filtering: if 'delegate' permission is disabled, hide all agents
  const disabledPerms = agent?.state?.disabledPermissions;
  if (Array.isArray(disabledPerms) && disabledPerms.includes('delegate')) {
    delegateResources = [];
  }

  if (delegateResources.length > 0) {
    doc += '## AVAILABLE AGENTS\n\n';
    doc += 'You can delegate work to these agents. Descriptions are budgeted (some may be '
      + 'shortened or omitted to keep this prompt small). Call `describe_agent({ "name" })` '
      + 'to read an agent\'s FULL description and its delegable intents (with params) before '
      + 'delegating — WHEN IN DOUBT about which agent fits or how to call it, describe_agent '
      + 'first.\n\n';
    const _agentBudget = Number(process.env.KOI_AGENT_LISTING_BUDGET) || 4000;
    const _agentMaxEntry = Number(process.env.KOI_AGENT_DESC_MAX_CHARS) || 300;
    const _agentLines = _budgetedDescList(
      delegateResources.map(r => ({ label: r.agentPureName, description: r.agentDescription })),
      { budget: _agentBudget, maxEntry: _agentMaxEntry },
    );
    doc += _agentLines.join('\n') + '\n\n';
  }

  // ── AVAILABLE WORKFLOWS ─────────────────────────────────────────────────
  // List each workflow with its description so the agent can match the
  // user's intent against a workflow BEFORE falling through to
  // planner::do_plan. The agent gets ONLY the name + description here —
  // never the WORKFLOW.md body. The body is the property of
  // `run_workflow`: when it was previously exposed (via describe_workflow
  // returning `body`), the agent read the body and started executing the
  // workflow's steps directly in its own turn, silently skipping
  // run_workflow → no tasks created, no workspace, no planner.result fired.
  // Only surfaced to agents with `delegate` permission (root coordinators)
  // — delegates execute the tasks a workflow creates, they don't pick
  // which workflow to run.
  if (agent?.role?.can('delegate')) {
    try {
      const catalog = listWorkflowsCatalog();
      if (catalog.length > 0) {
        doc += '## AVAILABLE WORKFLOWS\n\n';
        doc += 'Pre-approved task plans curated for this project. **WORKFLOW-FIRST routing rule**: when one of these clearly matches the user\'s request, invoke `run_workflow("<name>")` INSTEAD of delegating to `planner::do_plan`. The planner is the fallback for requests no workflow covers. Descriptions are budgeted (some may be shortened or omitted) — call `describe_workflow({ "name" })` for the full text if a name looks relevant but its description is short. Do NOT pre-fetch the workflow body before deciding to run it (the body is internal to `run_workflow`; reading it would just lead you to inline its steps instead of running it).\n\n';
        const _wfBudget = Number(process.env.KOI_WORKFLOW_LISTING_BUDGET) || 4000;
        const _wfMaxEntry = Number(process.env.KOI_WORKFLOW_DESC_MAX_CHARS) || 400;
        const _wfLines = _budgetedDescList(
          catalog.map(wf => ({
            label: `**${wf.name}**${wf.scope ? ` _(${wf.scope})_` : ''}`,
            description: wf.description,
          })),
          { budget: _wfBudget, maxEntry: _wfMaxEntry },
        );
        doc += _wfLines.join('\n') + '\n\n';
      }
    } catch { /* non-fatal */ }
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
  // (The direct actionType/intent/params shape is already defined by ACTION
  // MODEL above; here we only show the concrete delegate + MCP examples with
  // real names, which ACTION MODEL does not carry.)
  doc += '---\n';

  if (delegateResources.length > 0) {
    const ex = delegateResources[0];
    const exEvent = ex.intents[0]?.name ?? 'handle';
    doc += 'To call an agent:\n';
    doc += `actionType: delegate\nintent: ${ex.agentPureName}::${exEvent}\ndata:\n  ...\n\n`;
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
    doc += `actionType: direct\nintent: call_mcp\nmcp: ${ex.name}\ntool: ${exTool}\ninput:\n  ...\n`;
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
  // Layout (optimized for prompt caching — STABLE prefix first, volatile suffix last):
  //   1. BRAXIL.md / CLAUDE.md   (stable, project-level)
  //   2. Agent playbook          (stable, agent-level)
  //   3. Static generic rules    (stable, framework-level — output contract, tools, etc.)
  //   4. RECALLED CONTEXT (RMH)  (changes when user message changes)
  //   5. Dynamic runtime context (changes every turn — timestamp, phase, task state)
  //
  // Putting the volatile bits at the END is the cache-friendly order:
  // most providers do byte-prefix caching (OpenAI, DeepSeek) and any
  // mutation in earlier bytes invalidates everything after. Anthropic's
  // explicit cache_control is honored separately by the structured
  // path below.

  // RMH retrieval — Recursive Memory Harness via the Context Compiler.
  // Runs the agent's slot map (memory.retrieve over the project vault +
  // KNN over the conversations index) BEFORE every turn. Cached per
  // (agent, project, session, last-user-message) for ~60s so a single
  // user turn that loops 4-6× through the LLM only pays the retrieval
  // cost ONCE.
  const retrieved = await _runContextCompiler(agent);

  // Structured cache-aware playbook (Anthropic cache_control path).
  // Static block carries the stable prefix; dynamic carries everything
  // that changes per-turn. RECALLED CONTEXT is per-turn-volatile so it
  // belongs in dynamic, NOT in static.
  if (typeof playbook === 'object' && playbook?._cacheKey !== undefined) {
    const _s = (v) => typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v));
    return {
      _cacheKey: playbook._cacheKey,
      static: [projectSpec, _s(playbook.static), staticBase].filter(Boolean).join('\n\n'),
      dynamic: [_s(playbook.dynamic), retrieved, dynamic].filter(Boolean).join('\n\n'),
    };
  }

  // Legacy: plain string playbook (or flatten object without _cacheKey).
  // Keep the SAME stable-first / volatile-last order as the structured
  // path so byte-prefix caches still see a long stable prefix.
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
  if (projectSpec) parts.push(projectSpec); // BRAXIL.md / CLAUDE.md — stable
  if (playbookStr) parts.push(playbookStr); // agent playbook — stable
  parts.push(staticBase);                   // generic rules — most stable
  if (retrieved) parts.push(retrieved);     // RECALLED CONTEXT — changes per user msg
  parts.push(dynamic);                      // runtime state — changes per turn
  return parts.join('\n\n');
}

// ─── Context Compiler (RMH auto-retrieval) ───────────────────────────────

/**
 * Per-process LRU-ish cache for compile() output. Keyed by
 *   `${agentName}|${projectRoot}|${sessionId}|${normalizedTask}`
 * with a soft TTL. The killer use-case: a single user turn fans out
 * into 4-6 LLM calls (initial → recall → exec → continue → …); the
 * `lastUserMessage` doesn't change across those, so the same compile
 * output is reused. Only when a NEW user message lands does the cache
 * key change and we re-run RMH.
 *
 * Sized to bound memory in long-lived processes; stale entries are
 * dropped on every read attempt.
 */
const _COMPILE_CACHE_TTL_MS = 60 * 1000;
const _COMPILE_CACHE_MAX = 64;
const _compileCache = new Map(); // key -> { value: string, expires: ms }

function _compileCacheGet(key) {
  const e = _compileCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) {
    _compileCache.delete(key);
    return null;
  }
  // LRU bump — re-insert to push to the back of the iteration order.
  _compileCache.delete(key);
  _compileCache.set(key, e);
  return e.value;
}

function _compileCacheSet(key, value) {
  if (_compileCache.size >= _COMPILE_CACHE_MAX) {
    // Map iteration order is insertion order — drop the oldest.
    const oldest = _compileCache.keys().next().value;
    if (oldest !== undefined) _compileCache.delete(oldest);
  }
  _compileCache.set(key, { value, expires: Date.now() + _COMPILE_CACHE_TTL_MS });
}

/** Hand-tuned default slot map for agents WITHOUT a built-in entry
 *  (custom md-loaded agents, project-defined planners, etc.). Same
 *  shape as the System map but more conservative — no per-type
 *  filters, just a generic relevant-notes pull plus previous-session
 *  hint. Prevents the early-return that used to skip Context
 *  Compiler entirely for non-builtin agents. */
const _DEFAULT_SLOT_MAP = Object.freeze({
  template: null,
  slots: [
    {
      id: 'relevant_notes',
      source: 'memory',
      query: { semantic: '{{trigger.payload.task}}', limit: 6, scope: 'project' },
      budget: 1800,
    },
    {
      id: 'previous_sessions',
      source: 'conversations',
      query: { semantic: '{{trigger.payload.task}}', k: 3, projectScope: true },
      budget: 800,
    },
  ],
});

/**
 * Run the RMH Context Compiler for [agent]'s current turn. Returns a
 * markdown block ready to splice into the system prompt, or '' when
 * there's nothing relevant / the compiler isn't applicable.
 *
 * Failure mode is silent-with-log: a broken slot or missing vault
 * never blocks the agent's turn — the prompt simply lands without
 * the auto-retrieval block.
 */
async function _runContextCompiler(agent) {
  if (!agent || !agent.name) return '';

  const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd();
  const sessionId = process.env.KOI_SESSION_ID || agent.sessionId || null;

  // Trigger payload that slot maps interpolate as `{{trigger.payload.task}}`.
  // The naive "use _lastUserMessage" fails for short/generic inputs
  // ("continue", "sigue", "ok", "no", "y entonces…") — the embedding
  // of those words against a project vault returns near-zero scores,
  // so RMH retrieves nothing and the agent ends up amnesic.
  //
  // We enrich the trigger by combining (in priority order):
  //   1. The current message if substantive (≥ ~25 chars, not in the
  //      short-list of generic continuation words).
  //   2. The last 2 substantive USER messages from contextMemory —
  //      these are the actual conversation context the user just had
  //      with the agent and are the strongest signal of "what is this
  //      turn about".
  //   3. agent._currentTaskText — the delegate task brief (Worker /
  //      Planner path) when no user_input is in scope.
  //   4. The active task description from task-manager — what the
  //      agent was told to work on by the planner.
  // Concatenated, deduped, capped — RMH gets a rich semantic query
  // even when the user types a one-word follow-up.
  const triggerInfo = await _buildTriggerTask(agent);
  const triggerTask = triggerInfo.task;
  const trigger = { payload: { task: triggerTask } };

  // ── Cache check ───────────────────────────────────────────────────
  // Hash the trigger task into a compact key — content of the task
  // string can be huge (a long delegate brief plus enriched history).
  // The agent name + project + session pin the cache to the right
  // scope (different sessions in the same project DO get different
  // `previous_sessions` results because the slot filters out the
  // current sessionId).
  const cacheKey = `${agent.name}|${projectRoot}|${sessionId || ''}|${_djb2(triggerTask)}`;
  const cached = _compileCacheGet(cacheKey);
  if (cached !== null) {
    channel.log('memory', `Context Compiler: cache hit (${agent.name})`);
    return cached;
  }

  // Lazy-init the memory subsystem if needed. Idempotent across
  // turns; only the first call pays the cost. Skip gracefully when
  // no embedding/llmProvider is wired yet — first turn of a fresh
  // process can race with provider construction.
  if (!memory.isInitialized()) {
    try { await memory.ensureInit(agent); }
    catch (err) {
      channel.log('memory', `Context Compiler skipped (memory init failed): ${err.message}`);
      _compileCacheSet(cacheKey, ''); // negative cache so we don't retry every turn
      return '';
    }
  }

  // Resolve the slot map: built-in first (System / Worker / Planner),
  // then fall back to a default map so EVERY agent — including
  // user-defined md-loaded ones — gets RMH auto-retrieval. The
  // builtin-slot-maps module is the source of truth for tuned
  // per-agent budgets; the default map is the safety net.
  const slotMap = getBuiltinSlotMap(agent.name) || _DEFAULT_SLOT_MAP;

  let compiled;
  try {
    compiled = await compileContext({
      agent: agent.name,
      agentObject: agent,
      sessionId,
      trigger,
      projectRoot,
      // agentsRoot only matters when the slot-resolver falls through to
      // a disk lookup (no built-in entry); harmless to pass otherwise.
      agentsRoot: process.env.KOI_AGENTS_ROOT || projectRoot,
      // Inject the resolved slot map directly so the resolver doesn't
      // have to re-load it (built-ins always hit memory; the default
      // map is in-process). This also guarantees that compile() sees
      // the default map even for agents the resolver doesn't know.
      slotMapOverride: slotMap,
    });
  } catch (err) {
    channel.log('memory', `Context Compiler failed: ${err.message}`);
    _compileCacheSet(cacheKey, '');
    return '';
  }

  // Drop empty slots (the resolver returns '' for misses). Render the
  // remaining ones with their id as a heading so the LLM can tell
  // sections apart.
  const filledSlots = (compiled?.slots || []).filter(
    (s) => s.included && String(s.included).trim().length > 0,
  );

  // CURRENT FOCUS header — the most recent substantive user message
  // (or the most recent pivot / redirect, when present). This tells
  // the LLM "this is what we are doing now" with no ambiguity, so a
  // generic "continue / sigue / sigamos" doesn't drift back to the
  // active document or a stale task-queue entry. The pivot detector
  // catches "no, me referia…" / "wait, actually…" so a redirect
  // overrides whatever was happening before.
  const focus = (triggerInfo.focus || '').trim();
  const focusBlock = focus
    ? (triggerInfo.isPivot
        ? `## CURRENT FOCUS — IMPORTANT\nThe user just redirected the conversation. The active topic is now:\n\n> ${focus.replace(/\n/g, ' ')}\n\nWhen the next user input is a continuation marker ("continue", "sigue", "sigamos", "ok", etc.), it refers to THIS topic — NOT to the active document, NOT to the task queue, NOT to any earlier thread.`
        : `## CURRENT FOCUS\nThe user's most recent substantive message:\n\n> ${focus.replace(/\n/g, ' ')}\n\nWhen the next user input is a continuation marker ("continue", "sigue", "ok"), it refers to THIS topic.`)
    : '';

  // Nothing to emit at all — no slots filled AND no focus header.
  if (filledSlots.length === 0 && !focusBlock) {
    _compileCacheSet(cacheKey, '');
    return '';
  }

  const parts = [];
  if (focusBlock) parts.push(focusBlock);
  if (filledSlots.length > 0) {
    const sections = filledSlots.map((s) => {
      const title = _humanizeSlotId(s.id);
      return `### ${title}\n${s.included.trim()}`;
    });
    parts.push(`## RECALLED CONTEXT — REFERENCE ONLY (facts about PRIOR work; NOT input for the current turn)\n\nThese are facts from past sessions / past projects that the Context Compiler surfaced because they may be relevant. **Do NOT silently treat them as if the user just stated them.** When the current user message is brief or generic and these recalled facts would "fill the gap" (a prior character name, a prior topic, a prior style), STOP and propose reuse via \`prompt_user\` — never adopt them into a new workflow's \`context\` without explicit user confirmation in THIS session.\n\n${sections.join('\n\n')}`);
  }
  const out = parts.join('\n\n');
  _compileCacheSet(cacheKey, out);
  return out;
}

/**
 * Words / short phrases that mean "keep going with whatever we were
 * doing" and carry zero semantic content for RMH retrieval. When
 * `_lastUserMessage` matches one of these (case-insensitive, trimmed),
 * we look back through contextMemory for the previous substantive
 * input and use THAT as the semantic query instead.
 */
const _GENERIC_CONTINUATIONS = new Set([
  // English
  'continue', 'go on', 'go', 'ok', 'okay', 'yes', 'yeah', 'yep', 'sure',
  'k', 'kk', 'no', 'nope', 'and', 'next', 'more', 'do it', 'proceed',
  'thanks', 'thank you', 'pls', 'please',
  // Spanish
  'sigue', 'continúa', 'continua', 'continuar', 'sí', 'si', 'ok ya',
  'vale', 'venga', 'dale', 'ya', 'no', 'siguiente', 'ahora', 'porfa',
  // French
  'continue', 'oui', 'non', 'ok', 'd\'accord', 'vas-y',
]);

const _MIN_SUBSTANTIVE_LEN = 25;

function _isSubstantive(text) {
  if (!text) return false;
  const t = String(text).trim().toLowerCase();
  if (t.length === 0) return false;
  if (_GENERIC_CONTINUATIONS.has(t)) return false;
  // Strip common punctuation-only prefixes / emojis before measuring length.
  const stripped = t.replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
  return stripped.length >= _MIN_SUBSTANTIVE_LEN;
}

/**
 * Phrases that mark a CONVERSATIONAL PIVOT — the user is overriding
 * the previous direction. Anything starting with these (case-insensitive,
 * with optional leading spaces / punctuation) is the new "active topic"
 * and must dominate the trigger over older history.
 *
 * Without this, "sigue/continue" after a redirect would fall back to
 * the older task-queue / active-document state and pick the wrong
 * thread (the bug the user hit on 2026-05-10: "sigamos, no?" picked
 * Plano 006 instead of the burrow-consistency analysis the user had
 * just redirected toward).
 */
const _PIVOT_PREFIXES = [
  // English
  'no,', 'no ', "no.", 'wait', 'actually', 'hold on', 'hang on',
  'let me clarify', 'what i meant', "i meant", 'hmm', 'rather',
  'instead', 'forget that', 'cancel that',
  // Spanish
  'no,', 'no ', 'no.', 'espera', 'espérate', 'esperate', 'en realidad',
  'mejor', 'olvida', 'olvídalo', 'olvidalo', 'cancela', 'me referia',
  'me refería', 'lo que quiero', 'lo que queria', 'lo que quería',
  // French
  'attends', 'en fait', 'oublie', 'plutôt',
];

function _isPivotMessage(text) {
  if (!text) return false;
  const t = String(text).trim().toLowerCase();
  if (!t) return false;
  for (const prefix of _PIVOT_PREFIXES) {
    if (t.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Build the trigger task for RMH retrieval. Returns:
 *   { task, pivot }
 * where:
 *   - task: concatenated/capped semantic-query string for embedding.
 *   - pivot: the most recent SUBSTANTIVE user input that looks like a
 *           conversational pivot (or the most recent substantive
 *           input if none qualify), so the prompt builder can render
 *           it as a CURRENT FOCUS header. Drives the LLM to read it
 *           as authoritative for "what are we doing now" instead of
 *           defaulting to active document / task queue.
 *
 * Combines current input, prior substantive user messages from
 * contextMemory, the delegate task text, and any active task-manager
 * task description. Capped at ~600 chars so the embedding stays
 * focused and we don't waste tokens hashing the cache key.
 */
async function _buildTriggerTask(agent) {
  const pieces = [];
  const seen = new Set();
  const push = (s) => {
    if (!s) return;
    const t = String(s).trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    pieces.push(t);
  };

  // Most-recent substantive user input — used both for the trigger
  // and for the CURRENT FOCUS header. Walks the buffer / dialogue.
  let mostRecentSubstantive = '';
  let pivotCandidate = '';

  // 1. Current user message (always include even if short — it IS
  //    the active turn).
  const lastUser = agent._lastUserMessage || '';
  push(lastUser);
  if (_isSubstantive(lastUser)) {
    mostRecentSubstantive = lastUser;
    if (_isPivotMessage(lastUser)) pivotCandidate = lastUser;
  }

  // Helper: scan a chronological list of user-input strings (most
  // recent first) and add them to pieces while tracking the most
  // recent substantive + pivot. Stops after `maxAdded` substantive
  // adds so the trigger stays focused.
  const _scanUserInputs = (textsNewestFirst, maxAdded = 2) => {
    let added = 0;
    for (const t of textsNewestFirst) {
      if (added >= maxAdded) break;
      if (!_isSubstantive(t)) continue;
      if (!mostRecentSubstantive) mostRecentSubstantive = t;
      if (!pivotCandidate && _isPivotMessage(t)) pivotCandidate = t;
      push(t);
      added++;
    }
    return added;
  };

  // 2. If the current message is short/generic, walk contextMemory
  //    for the last substantive user inputs. We only need the last
  //    two — they describe the active topic. Even if the current IS
  //    substantive, still scan a couple back so the pivot detector
  //    can find a recent redirect ("no, me referia a…") even when
  //    the latest line is just "sigue".
  const cm = _lookupContextMemory(agent);
  const buffer = (cm && Array.isArray(cm._buffer)) ? cm._buffer : [];
  const bufferUserTexts = [];
  for (let i = buffer.length - 1; i >= 0; i--) {
    const e = buffer[i];
    if ((e?.role || '') !== 'user') continue;
    const content = typeof e?.content === 'string' ? e.content : '';
    if (content) bufferUserTexts.push(content);
  }
  let addedFromBuffer = 0;
  if (!_isSubstantive(lastUser) || !pivotCandidate) {
    addedFromBuffer = _scanUserInputs(bufferUserTexts, 3);
  }

  // 3. Delegate task brief (Workers / Planners).
  push(agent._currentTaskText);

  // 4. Active task from task-manager — what the planner / queue is
  //    currently driving. Imported lazily so this file stays decoupled
  //    from task-manager's own state machinery.
  try {
    const { taskManager } = await import('../state/task-manager.js');
    if (taskManager?.getCurrentForAgent) {
      const t = taskManager.getCurrentForAgent(agent.name);
      if (t?.description) push(t.description);
      else if (t?.subject) push(t.subject);
    }
  } catch { /* not all builds expose task-manager helpers; non-fatal */ }

  // Cap each piece individually so a giant task description doesn't
  // crowd out the others.
  const capped = pieces.map((p) => p.length > 240 ? p.slice(0, 237) + '…' : p);
  const out = capped.join(' \n ').trim();
  // Final guard: cap to 600 chars so the embedding stays focused.
  const task = out.length > 600 ? out.slice(0, 597) + '…' : out;
  return {
    task,
    // Surface the most relevant single user message for the prompt
    // header. Pivot wins over plain-recent if both exist (a pivot
    // overrides whatever else was happening).
    focus: pivotCandidate || mostRecentSubstantive || '',
    isPivot: !!pivotCandidate,
  };
}

/** Best-effort lookup of the agent's contextMemory instance. The
 *  agent stashes the active one on `_activeContextMemory` (per-slot
 *  copies live in `_contextMemoryBySlot` inside agent.js). For our
 *  purposes the active one is what's currently being assembled. */
function _lookupContextMemory(agent) {
  return agent?._activeContextMemory ?? agent?._contextMemory ?? null;
}

/** djb2 string hash — small, collision-rare for our scale (≤64 cache
 *  entries), avoids pulling in crypto. Used purely as a cache-key
 *  squashing function; never as a security primitive. */
function _djb2(str) {
  let h = 5381;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function _humanizeSlotId(id) {
  return String(id || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || 'Section';
}
