/**
 * Generate Audio Action — Text-to-speech, speech-to-text, sound effects.
 *
 * Delegates to the provider factory which auto-selects the best available
 * audio provider for the requested kind from the active catalog.
 *
 * Modes:
 *   - "speech" (default): Convert text to audio → saves to file (TTS)
 *   - "transcribe": Convert audio file to text (STT)
 *   - "sfx": Synthesise a sound effect from a free-form prompt → saves to file
 *
 * The dynamic catalog refresh below republishes the `mode` enum using the
 * gateway's canonical names (`tts`, `transcribe`, `sfx`); execute() accepts
 * either the legacy `speech` literal or the canonical `tts`.
 *
 * Permission: 'generate_audio' (individual permission for audio generation)
 */

import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { fetchMediaCapabilities } from '../../llm/providers/gateway.js';
import { findVoiceByName } from '../../state/voice-registry.js';

import fs from 'fs';
import path from 'path';
import { channel } from '../../io/channel.js';

const generateAudioAction = {
  type: 'generate_audio',
  intent: 'generate_audio',
  description: 'Generate speech audio from text, transcribe audio to text, OR synthesise a sound effect from a prompt. Model is auto-selected from the active catalog — describe what you want (mode, voice, label) and let the picker pick the cheapest capable model. Three modes: "speech" (alias "tts") converts text to audio (TTS); "transcribe" converts audio file to text (STT); "sfx" generates a sound effect / ambient clip (door slam, rain, footsteps, sci-fi whoosh, etc.) from a free-form prompt. Fields for speech mode: "text" (required), "saveTo" (required, file path), optional "voice" (preset name OR cloned-voice name from create_voice), optional "outputFormat" (mp3|opus|aac|flac|wav|pcm), optional "speed" (0.25-4.0), optional "language" (ISO-639-1 — improves quality on multilingual providers like MiniMax), optional "emotion" (provider-dependent: happy / sad / angry / calm / surprised / disgusted / fearful / neutral), optional "pitch" / "volume" voice-acting knobs (provider-dependent — ignored by OpenAI). For transcribe mode: "mode" must be "transcribe", "audioFile" (required, path to audio file), optional "language" (ISO code). For sfx mode: "mode" must be "sfx", "prompt" (required — describe the sound), "saveTo" (required, file path), optional "durationSeconds" (provider-clamped, e.g. ElevenLabs 0.5–22), optional "promptInfluence" (0..1, ElevenLabs only), optional "outputFormat", optional "seed". Returns: { success, savedTo, format, fileSize } for speech / sfx; { success, text } for transcribe.',
  thinkingHint: (action) => {
    if (action.mode === 'transcribe') return 'Transcribing audio';
    if (action.mode === 'sfx') return 'Generating sound effect';
    return 'Generating speech';
  },
  permission: 'generate_audio',

  schema: {
    type: 'object',
    properties: {
      mode:         { type: 'string', description: 'Mode: "speech" (text→audio, default), "transcribe" (audio→text), or "sfx" (prompt→sound effect)' },
      // Speech mode fields
      text:         { type: 'string', description: 'Text to convert to speech (speech mode)' },
      voice:        { type: 'string', description: 'Voice: preset name (alloy, echo, fable, onyx, nova, shimmer for OpenAI; provider-specific names for ElevenLabs / MiniMax) OR a cloned-voice name registered via create_voice. Default: alloy.' },
      outputFormat: { type: 'string', description: 'Audio format: mp3, opus, aac, flac, wav, pcm (default: mp3)' },
      speed:        { type: 'number', description: 'Speed multiplier: 0.25 to 4.0 (default: 1.0)' },
      saveTo:       { type: 'string', description: 'File path to save the generated audio (required for speech and sfx modes)' },
      emotion:      { type: 'string', description: 'Voice emotion (MiniMax / ElevenLabs only): happy, sad, angry, calm, surprised, disgusted, fearful, neutral.' },
      pitch:        { type: 'number', description: 'Pitch offset in semitones (MiniMax: -12..12). Ignored by OpenAI.' },
      volume:       { type: 'number', description: 'Volume multiplier (MiniMax: 0..10, default 1.0). Ignored by OpenAI.' },
      // Sfx mode fields
      prompt:       { type: 'string', description: 'Free-form description of the sound effect to synthesise (sfx mode).' },
      durationSeconds: { type: 'number', description: 'Target clip length in seconds (sfx mode). Provider-clamped — ElevenLabs sound-effects/v2 accepts 0.5–22. Omit to let the provider auto-pick.' },
      promptInfluence: { type: 'number', description: 'How strictly to follow the prompt vs. take creative liberties (sfx mode, 0..1). ElevenLabs-specific; ignored elsewhere.' },
      seed:         { type: 'number', description: 'Optional reproducibility seed (sfx mode).' },
      // Transcribe mode fields
      audioFile:    { type: 'string', description: 'Path to audio file to transcribe (transcribe mode)' },
      language:     { type: 'string', description: 'ISO-639-1 language code. Speech mode: enables MiniMax language_boost ("es" → Spanish, etc.) and helps multilingual TTS pick the right pronunciation. Transcribe mode: hint for the STT model (Whisper auto-detects when omitted).' }
      // `model` is intentionally NOT declared here. Model selection is the
      // auto-picker's job — the agent should describe what it wants
      // (mode, voice, label) and let the client-side router
      // (`pickAudioModel` in media-model-router.js) pick the cheapest
      // capable model from the active backend catalog. Declaring `model`
      // in the schema would invite the agent to invent a slug ("tts-1",
      // "whisper-1", "elevenlabs-…") that the catalog may not have
      // active and bypass quota / fallback logic. Same stance as
      // generate_image. If callers truly need a forced slug they can
      // still pass `action.model` programmatically — execute() honours
      // it — it just isn't advertised to the LLM.
    },
    required: []
  },

  examples: [
    { intent: 'generate_audio', text: 'Hello, welcome to our product demo.', saveTo: '/tmp/welcome.mp3' },
    { intent: 'generate_audio', text: 'Narration for the video', voice: 'nova', outputFormat: 'wav', speed: 0.9, saveTo: '/tmp/narration.wav' },
    { intent: 'generate_audio', mode: 'transcribe', audioFile: '/tmp/recording.mp3', language: 'en' },
    { intent: 'generate_audio', mode: 'sfx', prompt: 'heavy wooden door slamming shut in a stone hallway, with a faint echo', durationSeconds: 3, saveTo: '/tmp/door-slam.mp3' },
  ],

  async execute(action, agent) {
    // Normalise the gateway's canonical kind names back to this tool's
    // legacy mode names. The dynamic catalog refresh below republishes
    // `mode` as one of the gateway kinds (`tts`, `transcribe`, `sfx`)
    // so the agent will sometimes pass `tts` even though the rest of
    // execute() is written around the older `speech` literal.
    const rawMode = action.mode || 'speech';
    const mode = rawMode === 'tts' ? 'speech' : rawMode;

    const clients = agent?.llmProvider?.getClients?.() || {};

    // Resolve `voice` against the local registry: when the agent passes
    // voice="MyVoice" and that name exists in ~/.koi/voices/voices.json,
    // we lock the model slug to whatever cloned the voice (so we hit the
    // same provider) and substitute the provider's actual voiceId before
    // reaching the TTS call. Built-in voices like "alloy" / "nova" /
    // "echo" pass through unchanged because they don't match a registry
    // entry.
    let voiceOverride = null;
    let modelOverride = action.model;
    if (mode === 'speech' && typeof action.voice === 'string' && action.voice.trim()) {
      const cloned = findVoiceByName(action.voice);
      if (cloned) {
        voiceOverride = cloned.providerVoiceId;
        // Lock to the cloning model — the cloned voice id only exists
        // within the provider that minted it.
        if (!modelOverride && cloned.modelSlug) modelOverride = cloned.modelSlug;
        channel.log(
          'audio',
          `generate_audio: resolved voice="${action.voice}" → providerVoiceId=${cloned.providerVoiceId} (model=${cloned.modelSlug})`,
        );
      }
    }

    let resolved;
    try {
      resolved = resolveModel({ type: 'audio', clients, model: modelOverride });
    } catch (err) {
      return { success: false, error: err.message };
    }

    const instance = resolved.instance;

    // ── Speech mode (TTS) ─────────────────────────────────────────────
    if (mode === 'speech') {
      const text = action.text;
      if (!text) throw new Error('generate_audio: "text" is required for speech mode');
      if (!action.saveTo) throw new Error('generate_audio: "saveTo" is required for speech mode — specify where to save the audio file');

      const voice = voiceOverride || action.voice || 'alloy';
      const outputFormat = action.outputFormat || 'mp3';
      const speed = action.speed || 1.0;

      channel.log('audio', `generate_audio (speech): ${resolved.provider}/${resolved.model}, voice=${voice}, format=${outputFormat}, speed=${speed}, chars=${text.length}, text="${(action.text || '').substring(0, 100)}...", saveTo=${action.saveTo || 'default'}`);

      const result = await instance.speech(text, {
        voice,
        outputFormat,
        speed,
        // Forward optional voice-acting modifiers — MiniMax / ElevenLabs
        // honour them via their respective adapters, OpenAI ignores them.
        ...(action.language ? { language: action.language } : {}),
        ...(action.emotion ? { emotion: action.emotion } : {}),
        ...(typeof action.pitch === 'number' ? { pitch: action.pitch } : {}),
        ...(typeof action.volume === 'number' ? { volume: action.volume } : {}),
        ...(action.extra ? { extra: action.extra } : {}),
      });

      // Save to disk
      const savePath = path.resolve(action.saveTo);
      const dir = path.dirname(savePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(savePath, result.audio);

      channel.log('audio', `Saved: ${savePath} (${result.audio.length} bytes)`);

      return {
        success: true,
        provider: resolved.provider,
        model: resolved.model,
        mode: 'speech',
        savedTo: savePath,
        format: result.format,
        fileSize: result.audio.length,
        usage: result.usage,
      };
    }

    // ── SFX mode (text→sound-effect) ──────────────────────────────────
    if (mode === 'sfx') {
      const prompt = action.prompt || action.text;
      if (!prompt) throw new Error('generate_audio: "prompt" is required for sfx mode');
      if (!action.saveTo) throw new Error('generate_audio: "saveTo" is required for sfx mode — specify where to save the audio file');
      if (typeof instance.sfx !== 'function') {
        return {
          success: false,
          error: 'Sound-effect generation is only available when signed in (gateway mode). The current audio provider does not expose sfx().',
          provider: resolved.provider,
        };
      }

      const outputFormat = action.outputFormat || 'mp3';
      channel.log(
        'audio',
        `generate_audio (sfx): ${resolved.provider}/${resolved.model}, format=${outputFormat}, ` +
        `duration=${action.durationSeconds ?? '-'}s, prompt="${String(prompt).substring(0, 100)}", saveTo=${action.saveTo}`,
      );

      const result = await instance.sfx(prompt, {
        outputFormat,
        ...(typeof action.durationSeconds === 'number' ? { durationSeconds: action.durationSeconds } : {}),
        ...(typeof action.promptInfluence === 'number' ? { promptInfluence: action.promptInfluence } : {}),
        ...(typeof action.seed === 'number' ? { seed: action.seed } : {}),
        ...(action.label ? { label: action.label } : {}),
        ...(action.extra ? { extra: action.extra } : {}),
      });

      const savePath = path.resolve(action.saveTo);
      const dir = path.dirname(savePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(savePath, result.audio);
      channel.log('audio', `Saved: ${savePath} (${result.audio.length} bytes)`);

      return {
        success: true,
        provider: resolved.provider,
        model: resolved.model,
        mode: 'sfx',
        savedTo: savePath,
        format: result.format,
        fileSize: result.audio.length,
        usage: result.usage,
      };
    }

    // ── Transcribe mode (STT) ─────────────────────────────────────────
    if (mode === 'transcribe') {
      const audioFile = action.audioFile;
      if (!audioFile) throw new Error('generate_audio: "audioFile" is required for transcribe mode');

      const resolvedPath = path.resolve(audioFile);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: `Audio file not found: ${audioFile}` };
      }

      channel.log('audio', `generate_audio (transcribe): ${resolved.provider}, file=${resolvedPath}`);

      const audioData = fs.createReadStream(resolvedPath);
      const result = await instance.transcribe(audioData, {
        language: action.language,
      });

      return {
        success: true,
        provider: resolved.provider,
        model: 'whisper-1',
        mode: 'transcribe',
        text: result.text,
        segments: result.segments,
        usage: result.usage,
      };
    }

    throw new Error(`generate_audio: unknown mode "${mode}" — use "speech", "transcribe", or "sfx"`);
  }
};

import asyncCapable from '../_async-capable.js';
import { formatModelCatalog } from './_format-model-catalog.js';

// Wrap FIRST so the catalog refresh below mutates the registered object.
// asyncCapable spreads a fresh schema/description, so any in-place edit to
// the source `generateAudioAction` would land on a copy nobody reads.
const wrappedAction = asyncCapable(generateAudioAction);

// Fire-and-forget: rewrite the tool schema from the backend's active audio
// model set so the agent only ever sees parameters the backend can serve.
//
// Exposed as `_descriptionReady` so `get_tool_info` can await the rewrite
// before reading the description (otherwise the first lookup hits the
// static fallback before the catalog has populated the enums).
wrappedAction._descriptionReady = fetchMediaCapabilities('audio').then((caps) => {
  if (!caps) return;
  const props = wrappedAction.schema.properties;

  // mode: restrict to whichever audio kinds the backend actually serves.
  if (Array.isArray(caps.kinds) && caps.kinds.length) {
    props.mode = {
      type: 'string',
      enum: caps.kinds,
      description: `Mode: ${caps.kinds.map((k) => `"${k}"`).join(', ')}.`,
    };
  } else {
    delete props.mode;
  }

  if (!caps.anyTts) {
    delete props.text;
    delete props.speed;
    delete props.voice;
    delete props.emotion;
    delete props.pitch;
    delete props.volume;
  } else if (!caps.anyVoiceSelect) {
    delete props.voice;
  }

  if (!caps.anyTranscribe) {
    delete props.audioFile;
  }
  if (!caps.anyTts && !caps.anyTranscribe) {
    delete props.language;
  }

  if (!caps.anySfx) {
    delete props.prompt;
    delete props.durationSeconds;
    delete props.promptInfluence;
    delete props.seed;
  }

  // saveTo / outputFormat are shared between speech and sfx — only
  // strip them if NEITHER is available.
  if (!caps.anyTts && !caps.anySfx) {
    delete props.saveTo;
    delete props.outputFormat;
  }

  if (caps.labels?.length) {
    const details = Array.isArray(caps.labelDetails) ? caps.labelDetails : [];
    const lines = caps.labels.map((slug) => {
      const d = details.find((x) => x && x.slug === slug);
      const desc = d && d.description ? ` — ${d.description}` : '';
      return `  • "${slug}"${desc}`;
    }).join('\n');
    props.label = {
      type: 'string',
      enum: caps.labels,
      description: `Optional ranking preference. Pick the slug whose description matches the task; the router prefers a model tagged with this label.\n${lines}`,
    };
    wrappedAction.description += `\n\nOptional "label" ranking hint:\n${lines}`;
  } else {
    delete props.label;
  }

  // Append the active-models catalog so the agent can see — for the same
  // tool — which models cover tts, transcribe, sfx, voice_clone, music
  // and what each one's per-model knobs are.
  const catalog = formatModelCatalog(caps.models);
  if (catalog) wrappedAction.description += catalog;
}).catch(() => {});

export default wrappedAction;
