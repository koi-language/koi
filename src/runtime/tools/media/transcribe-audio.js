/**
 * Transcribe Audio Action — Speech-to-text for an audio sample.
 *
 * Routes through the gateway's /media/audio/transcribe endpoint, which
 * resolves a transcribe-capable model (Whisper / ElevenLabs Scribe / …)
 * via the catalog router and normalises the response shape.
 *
 * Use cases the agent has TODAY:
 *   • Detecting the language of a voice sample BEFORE cloning it, so the
 *     create_voice preview text can be localised to the same language.
 *   • Pulling literal quotes / titles out of a recording.
 *   • Subtitling — `segments` carries word/chunk-level timestamps when
 *     the provider returns them.
 *
 * Permission: 'generate_audio' (same scope — transcription is an audio
 * operation against the same provider set).
 */

import fs from 'fs';
import path from 'path';
import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { fetchMediaCapabilities } from '../../llm/providers/gateway.js';
import { channel } from '../../io/channel.js';

const transcribeAudioAction = {
  type: 'transcribe_audio',
  intent: 'transcribe_audio',
  description:
    'Transcribe an audio file to text. Auto-picks a transcribe-capable model from the active catalog (Whisper / ElevenLabs Scribe / …). ' +
    'Required: "audioFile" (absolute path to .mp3 / .wav / .ogg / .flac / .m4a / .aac / .webm). ' +
    'Optional: "language" (ISO-639-1 hint — leave empty to let the model auto-detect, useful for sniffing the language of an unknown sample), ' +
    '"task" ("transcribe" → same-language output (default); "translate" → English output), ' +
    '"prompt" (Whisper-style decoder prompt to bias domain-specific terms), ' +
    '"diarize" (boolean — return per-speaker segments), "numSpeakers" (hint for the diarizer). ' +
    'Returns: { success, text, language?, segments?, provider, model }. `language` is the DETECTED ISO-639-1 code — even when no language hint was passed, the agent gets it back.',
  thinkingHint: 'Transcribing audio',
  permission: 'generate_audio',

  schema: {
    type: 'object',
    properties: {
      audioFile:   { type: 'string',  description: 'Absolute path to the audio file.' },
      audioUrl:    { type: 'string',  description: 'Pre-uploaded https URL — alternative to audioFile when the audio is already hosted (e.g. a previous tool result).' },
      language:    { type: 'string',  description: 'Optional ISO-639-1 hint. Omit to auto-detect.' },
      task:        { type: 'string',  enum: ['transcribe', 'translate'], description: '"transcribe" (default) keeps the original language; "translate" emits English.' },
      prompt:      { type: 'string',  description: 'Optional decoder prompt to bias toward specific terms / proper nouns.' },
      diarize:     { type: 'boolean', description: 'Return per-speaker segments when the provider supports it.' },
      numSpeakers: { type: 'number',  description: 'Diarizer hint — speaker count if known.' },
    },
    // Either audioFile OR audioUrl must be present — enforced in execute().
  },

  examples: [
    { intent: 'transcribe_audio', audioFile: '/Users/me/Recordings/voice-sample.mp3' },
    { intent: 'transcribe_audio', audioFile: '/tmp/meeting.wav', diarize: true, numSpeakers: 3 },
    { intent: 'transcribe_audio', audioUrl: 'https://v3b.fal.media/files/.../preview.mp3', language: 'es' },
  ],

  async execute(action, agent) {
    const audioFile = action.audioFile;
    const audioUrl = action.audioUrl;
    if (!audioFile && !audioUrl) {
      return { success: false, error: 'transcribe_audio: provide either "audioFile" (local path) or "audioUrl" (https URL).' };
    }

    let audioBuf;
    let sampleFilename;
    if (audioFile) {
      const resolvedPath = path.resolve(audioFile);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: `Audio file not found: ${audioFile}` };
      }
      const stat = fs.statSync(resolvedPath);
      if (stat.size === 0) {
        return { success: false, error: `Audio file is empty: ${audioFile}` };
      }
      if (stat.size > 100 * 1024 * 1024) {
        return {
          success: false,
          error: `Audio file is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Trim under ~100 MB and retry.`,
        };
      }
      audioBuf = fs.readFileSync(resolvedPath);
      sampleFilename = path.basename(resolvedPath);
    }

    const clients = agent?.llmProvider?.getClients?.() || {};
    let resolved;
    try {
      resolved = resolveModel({ type: 'audio', clients, model: action.model });
    } catch (err) {
      return { success: false, error: err.message };
    }
    const instance = resolved.instance;
    if (typeof instance.transcribe !== 'function') {
      return {
        success: false,
        provider: resolved.provider,
        error: 'Transcription is only available when signed in (gateway mode). The current audio provider does not implement transcribe.',
      };
    }

    channel.log('audio', `transcribe_audio: ${sampleFilename || audioUrl}${action.language ? ` lang=${action.language}` : ''}${action.diarize ? ' diarize' : ''}`);

    let result;
    try {
      result = await instance.transcribe(audioBuf, {
        audioUrl,
        sampleFilename,
        language: action.language,
        task: action.task,
        prompt: action.prompt,
        diarize: action.diarize,
        numSpeakers: action.numSpeakers,
        label: action.label,
        abortSignal: agent?.abortSignal,
      });
    } catch (err) {
      return { success: false, provider: resolved.provider, error: err.message || String(err) };
    }
    if (!result || typeof result.text !== 'string') {
      return {
        success: false,
        provider: resolved.provider,
        model: result?.model,
        error: 'Transcription returned no text — the provider may have rejected the sample.',
      };
    }

    channel.log(
      'audio',
      `Transcribed: ${result.text.length} chars${result.language ? ` lang=${result.language}` : ''} provider=${resolved.provider} model=${result.model || resolved.model}`,
    );

    return {
      success: true,
      text: result.text,
      language: result.language,
      segments: result.segments,
      provider: resolved.provider,
      model: result.model || resolved.model,
    };
  },
};

// Hide the tool entirely when the active catalog has no transcribe-capable
// model, so the agent doesn't see an action it can't actually run.
fetchMediaCapabilities('audio').then((caps) => {
  if (!caps) return;
  const supportsTranscribe = Array.isArray(caps.kinds) && caps.kinds.includes('transcribe');
  if (!supportsTranscribe) {
    transcribeAudioAction.description = 'Unavailable: no active transcription model in the catalog.';
  }
}).catch(() => {});

export default transcribeAudioAction;
