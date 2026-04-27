/**
 * Generate Audio Action — Text-to-speech and speech-to-text.
 *
 * Delegates to the provider factory which auto-selects the best available
 * audio provider: OpenAI (tts-1, tts-1-hd, whisper-1).
 *
 * Two modes:
 *   - "speech" (default): Convert text to audio → saves to file
 *   - "transcribe": Convert audio file to text
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
  description: 'Generate speech audio from text, or transcribe audio to text. Model is auto-selected from the active catalog — describe what you want (mode, voice, label) and let the picker pick the cheapest capable model. Two modes: "speech" converts text to audio file (TTS), "transcribe" converts audio file to text (STT). Fields for speech mode: "text" (required), "saveTo" (required, file path), optional "voice" (preset name OR cloned-voice name from create_voice), optional "outputFormat" (mp3|opus|aac|flac|wav|pcm), optional "speed" (0.25-4.0), optional "language" (ISO-639-1 — improves quality on multilingual providers like MiniMax), optional "emotion" (provider-dependent: happy / sad / angry / calm / surprised / disgusted / fearful / neutral), optional "pitch" / "volume" voice-acting knobs (provider-dependent — ignored by OpenAI). For transcribe mode: "mode" must be "transcribe", "audioFile" (required, path to audio file), optional "language" (ISO code). Returns for speech: { success, savedTo, format, fileSize }. Returns for transcribe: { success, text, duration }',
  thinkingHint: (action) => action.mode === 'transcribe' ? 'Transcribing audio' : 'Generating speech',
  permission: 'generate_audio',

  schema: {
    type: 'object',
    properties: {
      mode:         { type: 'string', description: 'Mode: "speech" (text→audio, default) or "transcribe" (audio→text)' },
      // Speech mode fields
      text:         { type: 'string', description: 'Text to convert to speech (speech mode)' },
      voice:        { type: 'string', description: 'Voice: preset name (alloy, echo, fable, onyx, nova, shimmer for OpenAI; provider-specific names for ElevenLabs / MiniMax) OR a cloned-voice name registered via create_voice. Default: alloy.' },
      outputFormat: { type: 'string', description: 'Audio format: mp3, opus, aac, flac, wav, pcm (default: mp3)' },
      speed:        { type: 'number', description: 'Speed multiplier: 0.25 to 4.0 (default: 1.0)' },
      saveTo:       { type: 'string', description: 'File path to save the generated audio (required for speech mode)' },
      emotion:      { type: 'string', description: 'Voice emotion (MiniMax / ElevenLabs only): happy, sad, angry, calm, surprised, disgusted, fearful, neutral.' },
      pitch:        { type: 'number', description: 'Pitch offset in semitones (MiniMax: -12..12). Ignored by OpenAI.' },
      volume:       { type: 'number', description: 'Volume multiplier (MiniMax: 0..10, default 1.0). Ignored by OpenAI.' },
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
    { intent: 'generate_audio', mode: 'transcribe', audioFile: '/tmp/recording.mp3', language: 'en' }
  ],

  async execute(action, agent) {
    const mode = action.mode || 'speech';

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

    throw new Error(`generate_audio: unknown mode "${mode}" — use "speech" or "transcribe"`);
  }
};

// Fire-and-forget: rewrite the tool schema from the backend's active audio
// model set so the agent only ever sees parameters the backend can serve.
fetchMediaCapabilities('audio').then((caps) => {
  if (!caps) return;
  const props = generateAudioAction.schema.properties;

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
    delete props.outputFormat;
    delete props.speed;
    delete props.saveTo;
    delete props.voice;
  } else if (!caps.anyVoiceSelect) {
    delete props.voice;
  }

  if (!caps.anyTranscribe) {
    delete props.audioFile;
    delete props.language;
  }

  if (caps.labels?.length) {
    const list = caps.labels.map((l) => `"${l}"`).join(', ');
    props.label = {
      type: 'string',
      enum: caps.labels,
      description: `Optional ranking preference — the router prefers a model tagged with this label. Available: ${list}.`,
    };
    generateAudioAction.description += ` Optional "label" ranking hint (one of: ${list}).`;
  } else {
    delete props.label;
  }
}).catch(() => {});

export default generateAudioAction;
