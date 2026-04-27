/**
 * Create Voice Action — Clone a voice from an audio sample.
 *
 * Sends the sample to the gateway's voice-clone endpoint (which routes
 * through a per-model adapter to whichever fal voice-clone provider was
 * picked: ElevenLabs, PlayAI, …) and persists the resulting voice in
 * the local registry under `~/.koi/voices/voices.json` so subsequent
 * `generate_audio` calls can reference it by name.
 *
 * Permission: 'generate_audio' (same scope — voice creation is an audio
 * operation against the same provider set).
 */

import fs from 'fs';
import path from 'path';
import { resolve as resolveModel } from '../../llm/providers/factory.js';
import { fetchMediaCapabilities } from '../../llm/providers/gateway.js';
import { channel } from '../../io/channel.js';
import {
  saveVoice,
  findVoiceByName,
  voiceAssetDir,
  newVoiceLocalId,
} from '../../state/voice-registry.js';

const createVoiceAction = {
  type: 'create_voice',
  intent: 'create_voice',
  description:
    'Clone a voice from an audio sample so subsequent generate_audio calls can use the cloned voice by name. ' +
    'Required: "audioFile" (path to a 10–60 s clean recording of the source voice) and "name" (unique display name to refer to this voice later — generate_audio will accept voice="<name>"). ' +
    'Optional: "description" (timbre / accent hint forwarded to the provider), "language" (ISO-639-1), "labels" (free-form key/value bag the provider may use for ranking), "label" (router ranking hint, picks among catalog voices). ' +
    'The model is auto-picked from active voice-clone-capable models in the catalog. ' +
    'Returns: { success, name, voiceId, provider, model, sampleSavedTo }.',
  thinkingHint: 'Cloning voice',
  permission: 'generate_audio',

  schema: {
    type: 'object',
    properties: {
      audioFile:   { type: 'string', description: 'Absolute path to the audio sample file (.mp3 / .wav / .ogg / .flac / .m4a / .aac / .webm). 10–60 seconds of clean speech is the sweet spot for most providers.' },
      name:        { type: 'string', description: 'Display name for the cloned voice. Must be unique within the local registry — calling create_voice with an existing name fails. Used as the value of generate_audio "voice" later.' },
      description: { type: 'string', description: 'Optional free-form description (accent, age, timbre) the provider may use when refining the clone.' },
      language:    { type: 'string', description: 'Optional ISO-639-1 language code. Most providers detect language automatically.' },
      labels:      { type: 'object', description: 'Optional free-form key/value labels the provider may rank against (e.g. { gender: "female", accent: "british" }).' },
    },
    required: ['audioFile', 'name'],
  },

  examples: [
    { intent: 'create_voice', audioFile: '/Users/me/Recordings/anita.mp3', name: 'Anita' },
    { intent: 'create_voice', audioFile: '/tmp/founder-pitch.wav', name: 'Founder', description: 'Mid-30s male, Spanish accent, warm conversational tone', language: 'es' },
  ],

  async execute(action, agent) {
    const audioFile = action.audioFile;
    const name = (action.name || '').trim();
    if (!audioFile) {
      return { success: false, error: 'create_voice: "audioFile" is required (path to the sample)' };
    }
    if (!name) {
      return { success: false, error: 'create_voice: "name" is required (display name for the new voice)' };
    }
    const resolvedPath = path.resolve(audioFile);
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `Audio sample not found: ${audioFile}` };
    }
    if (findVoiceByName(name)) {
      return {
        success: false,
        error: `A voice named "${name}" already exists in the local registry. Pick a different name or delete the old one first.`,
      };
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.size === 0) {
      return { success: false, error: `Audio sample is empty: ${audioFile}` };
    }
    // Soft caps that surface common mistakes before we burn a provider
    // call. Most cloning models hard-fail above ~25 MB anyway.
    if (stat.size > 50 * 1024 * 1024) {
      return {
        success: false,
        error: `Audio sample is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Voice cloning typically needs 10–60 s; trim to under ~25 MB and retry.`,
      };
    }

    const clients = agent?.llmProvider?.getClients?.() || {};
    let resolved;
    try {
      resolved = resolveModel({ type: 'audio', clients, model: action.model });
    } catch (err) {
      return { success: false, error: err.message };
    }
    const instance = resolved.instance;
    if (typeof instance.cloneVoice !== 'function') {
      return {
        success: false,
        error: 'Voice cloning is only available when signed in (gateway mode). The current audio provider does not implement cloneVoice.',
        provider: resolved.provider,
      };
    }

    const audioBuf = fs.readFileSync(resolvedPath);
    const ext = path.extname(resolvedPath).slice(1).toLowerCase() || 'mp3';
    channel.log('audio', `create_voice: name="${name}", sample=${path.basename(resolvedPath)} (${(audioBuf.length / 1024).toFixed(0)}KB)`);

    let result;
    try {
      result = await instance.cloneVoice(audioBuf, {
        name,
        sampleFilename: path.basename(resolvedPath),
        description: action.description,
        language: action.language,
        labels: action.labels,
        label: action.label,
      });
    } catch (err) {
      return { success: false, provider: resolved.provider, error: err.message || String(err) };
    }
    if (!result?.voiceId) {
      return {
        success: false,
        provider: resolved.provider,
        model: result?.model,
        error: 'Voice clone returned no voiceId — the provider may have rejected the sample.',
      };
    }

    // Persist a local copy of the sample so the GUI drawer can play it
    // back as a preview without round-tripping to the provider.
    const localId = newVoiceLocalId();
    const dir = voiceAssetDir(localId);
    const sampleSavedTo = path.join(dir, `sample.${ext}`);
    try {
      fs.writeFileSync(sampleSavedTo, audioBuf);
    } catch (err) {
      channel.log('audio', `create_voice: failed to copy sample locally (${err.message}); registry entry saved without samplePath`);
    }

    const entry = {
      id: localId,
      name,
      providerVoiceId: result.voiceId,
      provider: result.provider || resolved.provider,
      modelSlug: result.model || resolved.model,
      description: action.description || undefined,
      language: action.language || undefined,
      labels: action.labels || undefined,
      samplePath: fs.existsSync(sampleSavedTo) ? sampleSavedTo : undefined,
      providerSampleUrl: result.sampleUrl,
      createdAt: new Date().toISOString(),
    };
    saveVoice(entry);

    // Surface to the UI: the drawer's voices store watches the JSON
    // file, but emitting an explicit presentResource lets the chat
    // immediately confirm the new voice without waiting for the watcher.
    if (channel.canPresentResources?.()) {
      channel.presentResource({
        type: 'voice',
        path: entry.samplePath,
        voiceId: localId,
        name,
        provider: entry.provider,
        modelSlug: entry.modelSlug,
      });
    }

    channel.log('audio', `Voice cloned: name="${name}" voiceId=${result.voiceId} provider=${entry.provider} model=${entry.modelSlug}`);

    return {
      success: true,
      name,
      voiceId: localId,
      providerVoiceId: result.voiceId,
      provider: entry.provider,
      model: entry.modelSlug,
      sampleSavedTo: entry.samplePath,
    };
  },
};

// Hide the tool entirely when the active catalog has no voice-clone
// capable model, so the agent doesn't see an action it can't actually run.
fetchMediaCapabilities('audio').then((caps) => {
  if (!caps) return;
  const supportsClone = Array.isArray(caps.kinds) && caps.kinds.includes('voice-clone');
  if (!supportsClone) {
    // Replace description with a one-liner explaining unavailability —
    // some action-registry consumers don't honour a "hidden" flag, so
    // gating on the description string keeps the tool inert without
    // needing to delete it from the registry.
    createVoiceAction.description = 'Unavailable: no active voice-clone model in the catalog.';
  }
}).catch(() => {});

export default createVoiceAction;
