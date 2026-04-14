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

import fs from 'fs';
import path from 'path';
import { channel } from '../../io/channel.js';

const generateAudioAction = {
  type: 'generate_audio',
  intent: 'generate_audio',
  description: 'Generate speech audio from text, or transcribe audio to text. Two modes: "speech" converts text to audio file (TTS), "transcribe" converts audio file to text (STT). Fields: For speech mode: "text" (required), optional "voice" (alloy|echo|fable|onyx|nova|shimmer), optional "outputFormat" (mp3|opus|aac|flac|wav), optional "speed" (0.25-4.0), "saveTo" (required, file path). For transcribe mode: "mode" must be "transcribe", "audioFile" (required, path to audio file), optional "language" (ISO code). Returns: For speech: { success, savedTo, format, fileSize }. For transcribe: { success, text, duration }',
  thinkingHint: (action) => action.mode === 'transcribe' ? 'Transcribing audio' : 'Generating speech',
  permission: 'generate_audio',

  schema: {
    type: 'object',
    properties: {
      mode:         { type: 'string', description: 'Mode: "speech" (text→audio, default) or "transcribe" (audio→text)' },
      // Speech mode fields
      text:         { type: 'string', description: 'Text to convert to speech (speech mode)' },
      voice:        { type: 'string', description: 'Voice: alloy, echo, fable, onyx, nova, shimmer (default: alloy)' },
      outputFormat: { type: 'string', description: 'Audio format: mp3, opus, aac, flac, wav, pcm (default: mp3)' },
      speed:        { type: 'number', description: 'Speed multiplier: 0.25 to 4.0 (default: 1.0)' },
      saveTo:       { type: 'string', description: 'File path to save the generated audio (required for speech mode)' },
      model:        { type: 'string', description: 'Specific model: tts-1, tts-1-hd (default: tts-1)' },
      // Transcribe mode fields
      audioFile:    { type: 'string', description: 'Path to audio file to transcribe (transcribe mode)' },
      language:     { type: 'string', description: 'ISO-639-1 language code for transcription (optional)' }
    },
    required: []
  },

  examples: [
    { intent: 'generate_audio', text: 'Hello, welcome to our product demo.', saveTo: '/tmp/welcome.mp3' },
    { intent: 'generate_audio', text: 'Narration for the video', voice: 'nova', outputFormat: 'wav', speed: 0.9, saveTo: '/tmp/narration.wav', model: 'tts-1-hd' },
    { intent: 'generate_audio', mode: 'transcribe', audioFile: '/tmp/recording.mp3', language: 'en' }
  ],

  async execute(action, agent) {
    const mode = action.mode || 'speech';

    const clients = agent?.llmProvider?.getClients?.() || {};

    let resolved;
    try {
      resolved = resolveModel({ type: 'audio', clients, model: action.model });
    } catch (err) {
      return { success: false, error: err.message };
    }

    const instance = resolved.instance;

    // ── Speech mode (TTS) ─────────────────────────────────────────────
    if (mode === 'speech') {
      const text = action.text;
      if (!text) throw new Error('generate_audio: "text" is required for speech mode');
      if (!action.saveTo) throw new Error('generate_audio: "saveTo" is required for speech mode — specify where to save the audio file');

      const voice = action.voice || 'alloy';
      const outputFormat = action.outputFormat || 'mp3';
      const speed = action.speed || 1.0;

      channel.log('audio', `generate_audio (speech): ${resolved.provider}/${resolved.model}, voice=${voice}, format=${outputFormat}, speed=${speed}, chars=${text.length}, text="${(action.text || '').substring(0, 100)}...", saveTo=${action.saveTo || 'default'}`);

      const result = await instance.speech(text, {
        voice,
        outputFormat,
        speed,
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
