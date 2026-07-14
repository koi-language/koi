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
import { _uploadVideoRef } from './generate-video.js';
import { exportMediaCopy } from './util/export-copy.js';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { channel } from '../../io/channel.js';

const generateAudioAction = {
  type: 'generate_audio',
  intent: 'generate_audio',
  bannerKind: 'audio',
  bannerLabel: 'Generando audio',
  bannerIconId: 'generate-audio',
  description: 'REQUIRED FIRST: the `audio-generator` skill MUST be active before you use this tool — if it is not, activate it now. It tells you which model to pick (by mode/category) and how to use each one. Generate speech, transcribe audio, synthesise a sound effect, OR generate a music track. YOU MUST choose the model: the "model" param is REQUIRED — pick a slug from the Catalog table at the END of this description whose Categories match your mode (audio_tts for speech, audio_sfx for sound effects/Foley, audio_music for music, audio_transcribe for transcription). There is no auto-selection; omitting model (or passing "auto") is an error. Four modes: "speech" (alias "tts") converts text to audio (TTS); "transcribe" converts audio file to text (STT); "sfx" generates a sound effect / Foley / ambient clip from a free-form prompt — pass "videoFile" to land on a video-conditioned model (see catalog snapshot — picker routes to a slug that supports video conditioning when one is active) that synchronises the SFX to the visible action; "music" generates a music track / score / backing — text-only, NO video conditioning, use this when the user explicitly asks for music / soundtrack / score. Fields for speech mode: "text" (required), "saveTo" (OPTIONAL, file path — omit to save only in ~/.koi/audio), optional "voice" (preset name OR cloned-voice name from create_voice), optional "outputFormat" (mp3|opus|aac|flac|wav|pcm), optional "speed" (0.25-4.0), optional "language" (ISO-639-1 — improves quality on multilingual providers like MiniMax), optional "emotion" (provider-dependent: happy / sad / angry / calm / surprised / disgusted / fearful / neutral), optional "pitch" / "volume" voice-acting knobs (provider-dependent — ignored by OpenAI). For transcribe mode: "mode" must be "transcribe", "audioFile" (required, path to audio file), optional "language" (ISO code). For sfx mode: "mode" must be "sfx", "prompt" (required — describe the sound), "saveTo" (OPTIONAL, file path — omit to save only in ~/.koi/audio), optional "videoFile" (path — enables video-conditioned model), optional "durationSeconds" (per-model range: see the `audio-generator` skill), optional "promptInfluence" (0..1, ElevenLabs only), optional "outputFormat", optional "seed". For music mode: "mode" must be "music", "prompt" (required — describe mood / genre / instrumentation / structure), "saveTo" (OPTIONAL, file path — omit to save only in ~/.koi/audio), optional "durationSeconds" (per-model range: see the `audio-generator` skill), optional "outputFormat", optional "seed". Returns: { success, savedTo, format, fileSize } for speech / sfx / music; { success, text } for transcribe.',
  thinkingHint: (action) => {
    if (action.mode === 'transcribe') return 'Transcribing audio';
    if (action.mode === 'sfx') return 'Generating sound effect';
    if (action.mode === 'music') return 'Generating music';
    return 'Generating speech';
  },
  permission: 'generate_audio',

  schema: {
    type: 'object',
    properties: {
      mode:         { type: 'string', description: 'Mode: "speech" (text→audio, default), "transcribe" (audio→text), "sfx" (prompt→sound effect, optionally video-conditioned via videoFile), or "music" (prompt→music track / score / backing — text-only, NOT video-conditioned).' },
      // Speech mode fields
      text:         { type: 'string', description: 'Text to convert to speech (speech mode)' },
      voice:        { type: 'string', description: 'Voice: preset name (alloy, echo, fable, onyx, nova, shimmer for OpenAI; provider-specific names for ElevenLabs / MiniMax) OR a cloned-voice name registered via create_voice. Default: alloy.' },
      outputFormat: { type: 'string', description: 'Audio format: mp3, opus, aac, flac, wav, pcm (default: mp3)' },
      speed:        { type: 'number', description: 'Speed multiplier: 0.25 to 4.0 (default: 1.0)' },
      saveTo:       { type: 'string', description: 'OPTIONAL file path where a COPY of the generated audio is also placed. The ORIGINAL is ALWAYS kept in ~/.koi/audio/ so the creations drawer finds it (that is the response `savedTo`); pass saveTo only to ALSO drop a named copy at your path (returned as `exportedTo`). Not required in any mode.' },
      emotion:      { type: 'string', description: 'Voice emotion (MiniMax / ElevenLabs only): happy, sad, angry, calm, surprised, disgusted, fearful, neutral.' },
      pitch:        { type: 'number', description: 'Pitch offset in semitones (MiniMax: -12..12). Ignored by OpenAI.' },
      volume:       { type: 'number', description: 'Volume multiplier (MiniMax: 0..10, default 1.0). Ignored by OpenAI.' },
      // Sfx mode fields
      prompt:       { type: 'string', description: 'Free-form description of the sound effect (sfx mode) or music track (music mode) to synthesise. MANDATORY: write the prompt in English regardless of the user\'s language — audio models are trained on English-heavy descriptions and degrade with non-English prompts. NOTE: this does NOT affect the `text` field of speech mode — actual spoken dialogue / voice-over copy stays in the user\'s language because it is reproduced verbatim by the TTS voice.' },
      durationSeconds: { type: 'number', description: 'Target clip length in seconds (sfx mode). The accepted range is per-model and documented in the `audio-generator` skill. Omit to let the model auto-pick.' },
      promptInfluence: { type: 'number', description: 'How strictly to follow the prompt vs. take creative liberties (sfx mode, 0..1). ElevenLabs-specific; ignored elsewhere.' },
      loop:         { type: 'boolean', description: 'Render a seamlessly-looping clip (sfx mode). ElevenLabs sound-effects/v2 only — useful for ambient beds (rain, engine hum, drone) where you want a stitched loop. Ignored by other SFX adapters.' },
      seed:         { type: 'number', description: 'Optional reproducibility seed (sfx mode).' },
      videoFile:    { type: 'string', description: 'Optional path to a reference video (sfx mode). When provided, the router picks a video-conditioned model (e.g. mmaudio-v2) that synchronises the generated SFX / Foley to the visible action — preferred when adding audio to a silent video. The video is uploaded to fal storage automatically. Omit for prompt-only SFX (faster / cheaper).' },
      // Transcribe mode fields
      audioFile:    { type: 'string', description: 'Path to audio file to transcribe (transcribe mode)' },
      language:     { type: 'string', description: 'ISO-639-1 language code. Speech mode: enables MiniMax language_boost ("es" → Spanish, etc.) and helps multilingual TTS pick the right pronunciation. Transcribe mode: hint for the STT model (Whisper auto-detects when omitted).' },
      summary:      { type: 'string', description: 'OPTIONAL. One-line "what was this for" — pinned to this session\'s creations ledger so you can later list / recall it via `recall_creations` without searching the filesystem. Examples: "Narrator opening line in Spanish", "Stone door slam for shot 3". Keep it short and self-evident; the agent is the one who will read it back later. When omitted, the ledger falls back to the prompt / text — usable but less semantic.' },
      model:        { type: 'string', description: 'REQUIRED. The exact model slug to run — YOU choose it; there is no auto-selection. Pick a slug from the Catalog table at the END of this description whose Categories match your mode: speech/TTS → `audio_tts`; sound effect / Foley → `audio_sfx` (video-conditioned SFX needs an `audio_sfx` model that accepts a videoFile); music → `audio_music`; transcribe → `audio_transcribe`. For a cloned voice (from create_voice) pick the speech model that minted it. NEVER pick a model that lacks the category for your mode. See the audio-generator skill for what each category is for. Omitting this (or passing "auto"/empty) is an error — the tool will refuse.' }
    },
    required: ['model']
  },

  examples: [
    { intent: 'generate_audio', text: 'Hello, welcome to our product demo.', saveTo: '/tmp/welcome.mp3' },
    { intent: 'generate_audio', text: 'Narration for the video', voice: 'nova', outputFormat: 'wav', speed: 0.9, saveTo: '/tmp/narration.wav' },
    { intent: 'generate_audio', mode: 'transcribe', audioFile: '/tmp/recording.mp3', language: 'en' },
    { intent: 'generate_audio', mode: 'sfx', prompt: 'heavy wooden door slamming shut in a stone hallway, with a faint echo', durationSeconds: 3, saveTo: '/tmp/door-slam.mp3' },
    { intent: 'generate_audio', mode: 'sfx', prompt: 'crackling fire, collapsing wooden beams, distant shouts', videoFile: '/Users/me/clips/burning-house.mp4', durationSeconds: 6, saveTo: '/tmp/burning.mp3' },
    { intent: 'generate_audio', mode: 'music', prompt: 'epic orchestral score with rising tension, cellos and percussion, building to a crescendo', durationSeconds: 30, saveTo: '/tmp/score.mp3' },
  ],

  async execute(action, agent) {
    // Guard — see generate-image.js for rationale.
    const { requireToolInfoFirst } = await import('../_require-tool-info-first.js');
    const _guard = await requireToolInfoFirst('generate_audio', agent);
    if (_guard) return _guard;

    // `model` is REQUIRED for GENERATION modes (speech/sfx/music) — the
    // agent picks the slug (no auto-selection). TRANSCRIBE is exempt: it is
    // speech-to-text with a single STT model, not a creative model choice,
    // so forcing a slug there is pure friction.
    const _audioMode = (action.mode === 'tts' ? 'speech' : action.mode) || 'speech';
    if (_audioMode !== 'transcribe') {
      if (typeof action.model !== 'string' || !action.model.trim() || action.model.trim() === 'auto') {
        return {
          success: false,
          error: 'generate_audio: "model" is required for speech/sfx/music — pick an exact model slug from the Catalog table in this tool\'s description whose Categories match your mode (audio_tts for speech, audio_sfx for sound effects/Foley, audio_music for music). There is no auto-selection; "auto" and an empty value are not accepted. (Transcribe is exempt.)',
        };
      }
      action.model = action.model.trim();
      channel.log('audio', `Using agent-chosen model="${action.model}".`);
    }

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
        // within the provider that minted it, so it OVERRIDES the agent's
        // pick (a mismatched speech model can't resolve the voiceId).
        if (cloned.modelSlug && cloned.modelSlug !== modelOverride) {
          channel.log(
            'audio',
            `generate_audio: cloned voice="${action.voice}" locks model=${cloned.modelSlug} (overriding chosen model="${modelOverride}").`,
          );
          modelOverride = cloned.modelSlug;
        }
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

    // Pipe fal-status updates from the audio submit+poll loop straight
    // to the chat banner. The banner wrapper (action-registry) sets
    // _emitMediaStatus on the action; absent for nested calls or tools
    // run outside the GUI, in which case we no-op.
    const _onStatus = typeof action._emitMediaStatus === 'function'
      ? (info) => action._emitMediaStatus(info)
      : undefined;

    // Cost consent is handled UP FRONT by the media banner wrapper
    // (action-registry.js → preflightMediaCost), before the banner and any
    // request — so by this point the user has already approved. (transcribe is
    // exempt there too, since it's speech-to-text, not generation.)

    // ── Speech mode (TTS) ─────────────────────────────────────────────
    if (mode === 'speech') {
      const text = action.text;
      if (!text) throw new Error('generate_audio: "text" is required for speech mode');

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
        ...(_onStatus ? { onStatus: _onStatus } : {}),
      });

      // Save to disk. saveTo is OPTIONAL: the ORIGINAL always lands in
      // ~/.koi/audio (the creations drawer indexes it); when a saveTo IS
      // given, an extra export COPY is placed there. MCP media tools never
      // pass saveTo, so REQUIRING it broke every generate_audio call through
      // the MCP bridge — hence the fallback auto-name here.
      const requestedSaveTo = action.saveTo ? path.resolve(action.saveTo) : null;
      const savePath = path.join(os.homedir(), '.koi', 'audio',
        requestedSaveTo ? path.basename(requestedSaveTo) : `speech-${Date.now()}.${outputFormat}`);
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, result.audio);
      const exportedTo = requestedSaveTo ? exportMediaCopy(savePath, requestedSaveTo, { logTag: 'audio' }) : null;

      channel.log('audio', `Saved: ${savePath} (${result.audio.length} bytes)`);

      try {
        const { saveGeneratedAudio } = await import('../../state/media-library.js');
        await saveGeneratedAudio(savePath, {
          mode: 'speech',
          text,
          prompt: text,
          voice,
          outputFormat: result.format || outputFormat,
          speed,
          ...(action.language ? { language: action.language } : {}),
          ...(action.emotion ? { emotion: action.emotion } : {}),
          ...(typeof action.pitch === 'number' ? { pitch: action.pitch } : {}),
          ...(typeof action.volume === 'number' ? { volume: action.volume } : {}),
          provider: resolved.provider,
          model: result?.model || resolved.model,
          fileSize: result.audio.length,
          ...(typeof result?.creditsCost === 'number' ? { creditsCost: result.creditsCost } : {}),
          ...(typeof result?.providerRequestId === 'string' ? { providerRequestId: result.providerRequestId } : {}),
          summary: typeof action.summary === 'string' ? action.summary : undefined,
        }, agent?.llmProvider || null);
        channel.log('audio', `Saved to media library: ${savePath}`);
      } catch (mlErr) {
        channel.log('audio', `Media library save failed (non-fatal): ${mlErr.message}`);
      }

      return {
        success: true,
        provider: resolved.provider,
        model: resolved.model,
        mode: 'speech',
        savedTo: savePath,
        ...(exportedTo ? { exportedTo } : {}),
        format: result.format,
        fileSize: result.audio.length,
        usage: result.usage,
      };
    }

    // ── SFX mode (text→sound-effect, optionally video-conditioned) ────
    if (mode === 'sfx') {
      const prompt = action.prompt || action.text;
      if (!prompt) throw new Error('generate_audio: "prompt" is required for sfx mode');
      if (typeof instance.sfx !== 'function') {
        return {
          success: false,
          error: 'Sound-effect generation is only available when signed in (gateway mode). The current audio provider does not expose sfx().',
          provider: resolved.provider,
        };
      }

      // Guard: when a reference video is provided, the agent MUST have
      // visually inspected it (via read_file) before getting here, so the
      // prompt is grounded in what's on-screen rather than a guess from
      // the filename. Applies regardless of whether the selected audio
      // model is video-conditioned — the text-only fallback never sees
      // frames, and even mmaudio-v2 needs a specific prompt to know
      // which sounds to emphasise. See _require-video-seen.js for the
      // full rationale.
      if (action.videoFile) {
        const { requireVideoSeen } = await import('../_require-video-seen.js');
        const _videoGuard = requireVideoSeen('generate_audio', action.videoFile, agent);
        if (_videoGuard) return _videoGuard;
      }

      // Upload reference video FIRST. Threading the resulting URL into the
      // router (`hasVideoRef: true`) is what steers the picker to a video-
      // conditioned model (e.g. mmaudio-v2) instead of a text-only one.
      // We do the upload here rather than in instance.sfx() so callers
      // see a clean failure mode if the file is missing / unreadable
      // before the (slow) inference call kicks off.
      let videoUrl;
      if (action.videoFile) {
        videoUrl = await _uploadVideoRef(action.videoFile);
        if (!videoUrl) {
          return {
            success: false,
            error: `generate_audio: failed to upload reference video "${action.videoFile}". Check the path and that fal storage is reachable.`,
          };
        }
      }

      const outputFormat = action.outputFormat || 'mp3';
      channel.log(
        'audio',
        `generate_audio (sfx): ${resolved.provider}/${resolved.model}, format=${outputFormat}, ` +
        `duration=${action.durationSeconds ?? '-'}s, prompt="${String(prompt).substring(0, 100)}", ` +
        `saveTo=${action.saveTo}${videoUrl ? ` (video-conditioned)` : ''}`,
      );

      const result = await instance.sfx(prompt, {
        outputFormat,
        ...(typeof action.durationSeconds === 'number' ? { durationSeconds: action.durationSeconds } : {}),
        ...(typeof action.promptInfluence === 'number' ? { promptInfluence: action.promptInfluence } : {}),
        ...(typeof action.loop === 'boolean' ? { loop: action.loop } : {}),
        ...(typeof action.seed === 'number' ? { seed: action.seed } : {}),
        ...(videoUrl ? { videoUrl } : {}),
        ...(action.label ? { label: action.label } : {}),
        ...(action.extra ? { extra: action.extra } : {}),
        ...(_onStatus ? { onStatus: _onStatus } : {}),
      });

      // saveTo is OPTIONAL: the ORIGINAL always lands in ~/.koi/audio (drawer
      // indexes it); a saveTo, when given, gets an extra export COPY. MCP
      // media tools don't pass saveTo, so requiring it broke the MCP path.
      const requestedSaveTo = action.saveTo ? path.resolve(action.saveTo) : null;
      const savePath = path.join(os.homedir(), '.koi', 'audio',
        requestedSaveTo ? path.basename(requestedSaveTo) : `sfx-${Date.now()}.${action.outputFormat || 'mp3'}`);
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, result.audio);
      const exportedTo = requestedSaveTo ? exportMediaCopy(savePath, requestedSaveTo, { logTag: 'audio' }) : null;
      channel.log('audio', `Saved: ${savePath} (${result.audio.length} bytes)`);

      try {
        const { saveGeneratedAudio } = await import('../../state/media-library.js');
        await saveGeneratedAudio(savePath, {
          mode: 'sfx',
          prompt,
          outputFormat: result.format || outputFormat,
          ...(typeof action.durationSeconds === 'number' ? { durationSeconds: action.durationSeconds } : {}),
          ...(typeof action.promptInfluence === 'number' ? { promptInfluence: action.promptInfluence } : {}),
          ...(typeof action.loop === 'boolean' ? { loop: action.loop } : {}),
          ...(typeof action.seed === 'number' ? { seed: action.seed } : {}),
          ...(action.videoFile ? { videoFile: action.videoFile } : {}),
          ...(videoUrl ? { videoConditioned: true } : {}),
          provider: resolved.provider,
          model: result?.model || resolved.model,
          fileSize: result.audio.length,
          ...(typeof result?.creditsCost === 'number' ? { creditsCost: result.creditsCost } : {}),
          ...(typeof result?.providerRequestId === 'string' ? { providerRequestId: result.providerRequestId } : {}),
          summary: typeof action.summary === 'string' ? action.summary : undefined,
        }, agent?.llmProvider || null);
        channel.log('audio', `Saved to media library: ${savePath}`);
      } catch (mlErr) {
        channel.log('audio', `Media library save failed (non-fatal): ${mlErr.message}`);
      }

      return {
        success: true,
        provider: resolved.provider,
        model: resolved.model,
        mode: 'sfx',
        savedTo: savePath,
        ...(exportedTo ? { exportedTo } : {}),
        format: result.format,
        fileSize: result.audio.length,
        usage: result.usage,
      };
    }

    // ── Music mode (text→music track / score / backing) ───────────────
    // Text-only: no video conditioning. For Foley / SFX synchronised to
    // a clip use mode='sfx' with a videoFile (mmaudio-v2) — that's the
    // path that watches the source frames.
    if (mode === 'music') {
      const prompt = action.prompt || action.text;
      if (!prompt) throw new Error('generate_audio: "prompt" is required for music mode');
      // saveTo is OPTIONAL (like speech/sfx): the original always lands in
      // ~/.koi/audio (see below). The MCP path never passes saveTo, so
      // REQUIRING it here broke every music call through MCP.
      if (typeof instance.music !== 'function') {
        return {
          success: false,
          error: 'Music generation is only available when signed in (gateway mode). The current audio provider does not expose music().',
          provider: resolved.provider,
        };
      }

      const outputFormat = action.outputFormat || 'mp3';
      channel.log(
        'audio',
        `generate_audio (music): ${resolved.provider}/${resolved.model}, format=${outputFormat}, ` +
        `duration=${action.durationSeconds ?? '-'}s, prompt="${String(prompt).substring(0, 100)}", saveTo=${action.saveTo || 'default'}`,
      );

      const result = await instance.music(prompt, {
        outputFormat,
        ...(typeof action.durationSeconds === 'number' ? { durationSeconds: action.durationSeconds } : {}),
        ...(typeof action.seed === 'number' ? { seed: action.seed } : {}),
        ...(action.label ? { label: action.label } : {}),
        ...(action.extra ? { extra: action.extra } : {}),
        ...(_onStatus ? { onStatus: _onStatus } : {}),
      });

      // saveTo is OPTIONAL: the ORIGINAL always lands in ~/.koi/audio (drawer
      // indexes it); a saveTo, when given, gets an extra export COPY. MCP
      // media tools don't pass saveTo, so requiring it broke the MCP path.
      const requestedSaveTo = action.saveTo ? path.resolve(action.saveTo) : null;
      const savePath = path.join(os.homedir(), '.koi', 'audio',
        requestedSaveTo ? path.basename(requestedSaveTo) : `music-${Date.now()}.${outputFormat}`);
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, result.audio);
      const exportedTo = requestedSaveTo ? exportMediaCopy(savePath, requestedSaveTo, { logTag: 'audio' }) : null;
      channel.log('audio', `Saved: ${savePath} (${result.audio.length} bytes)`);

      try {
        const { saveGeneratedAudio } = await import('../../state/media-library.js');
        await saveGeneratedAudio(savePath, {
          mode: 'music',
          prompt,
          outputFormat: result.format || outputFormat,
          ...(typeof action.durationSeconds === 'number' ? { durationSeconds: action.durationSeconds } : {}),
          ...(typeof action.seed === 'number' ? { seed: action.seed } : {}),
          provider: resolved.provider,
          model: result?.model || resolved.model,
          fileSize: result.audio.length,
          ...(typeof result?.creditsCost === 'number' ? { creditsCost: result.creditsCost } : {}),
          ...(typeof result?.providerRequestId === 'string' ? { providerRequestId: result.providerRequestId } : {}),
          summary: typeof action.summary === 'string' ? action.summary : undefined,
        }, agent?.llmProvider || null);
        channel.log('audio', `Saved to media library: ${savePath}`);
      } catch (mlErr) {
        channel.log('audio', `Media library save failed (non-fatal): ${mlErr.message}`);
      }

      return {
        success: true,
        provider: resolved.provider,
        model: resolved.model,
        mode: 'music',
        savedTo: savePath,
        ...(exportedTo ? { exportedTo } : {}),
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

    throw new Error(`generate_audio: unknown mode "${mode}" — use "speech", "transcribe", "sfx", or "music"`);
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

  // `label` is no longer an INPUT parameter — the agent picks the model
  // directly; per-model labels are shown in the Catalog table for context
  // only. Never advertise it on the schema.
  delete props.label;

  // Append the active-models catalog so the agent can see — for the same
  // tool — which models cover tts, transcribe, sfx, voice_clone, music
  // and what each one's per-model knobs are.
  const catalog = formatModelCatalog(caps.models);
  if (catalog) wrappedAction.description += catalog;
}).catch(() => {});

export default wrappedAction;
