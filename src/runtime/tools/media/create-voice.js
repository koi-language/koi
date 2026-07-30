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

    // Persist a local copy of the ORIGINAL sample (the audio the user
    // supplied). Kept on disk as the fallback preview if the spoken
    // render below fails, and for any future re-clone.
    const localId = newVoiceLocalId();
    const dir = voiceAssetDir(localId);
    const sampleSavedTo = path.join(dir, `sample.${ext}`);
    try {
      fs.writeFileSync(sampleSavedTo, audioBuf);
    } catch (err) {
      channel.log('audio', `create_voice: failed to copy sample locally (${err.message}); registry entry saved without samplePath`);
    }

    // Spoken preview: synthesise a short, neutral line WITH THE CLONED
    // VOICE so the creation the user hears actually demonstrates the
    // clone — not the raw audio they uploaded. The line is in the SAME
    // language as the source audio: `action.language` when the agent
    // set it, otherwise detected by transcribing the sample (the gateway
    // STT path returns the detected language). Entirely best-effort —
    // any failure falls back to the raw input sample and never blocks
    // the clone itself.
    // The slug that MINTED the clone is a *voice-clone* model — it can NOT
    // do TTS. To speak the preview (and to store a usable model for later)
    // we need a real `audio_tts` model under the SAME provider namespace
    // (e.g. clone `fal-ai/minimax/voice-clone` → TTS `fal-ai/minimax/…`).
    // Resolved from the live catalog — no hardcoded slug. Falls back to the
    // clone slug only if the lookup finds nothing (best-effort preview).
    const cloneSlug = result.model || resolved.model;
    const ttsSlug = (await _findTtsSlugForProvider(cloneSlug)) || cloneSlug;

    let previewPath;
    let previewCreditsCost;
    let previewLang = (action.language || '').trim().toLowerCase() || undefined;
    try {
      if (!previewLang && typeof instance.transcribe === 'function') {
        const stt = await instance.transcribe(audioBuf, {
          sampleFilename: path.basename(resolvedPath),
        });
        if (stt?.language) previewLang = String(stt.language).trim().toLowerCase();
      }
      // Generate a neutral sample line with the LLM (English prompt,
      // output in the source language) — no hardcoded per-language
      // strings, works for any language the voice was recorded in.
      const text = await _generateSampleLine(agent, previewLang);
      if (!text) throw new Error('sample line generation returned empty');
      const ttsResolved = resolveModel({
        type: 'audio',
        clients,
        model: ttsSlug,
      });
      if (typeof ttsResolved.instance.speech === 'function') {
        const tts = await ttsResolved.instance.speech(text, {
          voice: result.voiceId,
          outputFormat: 'mp3',
          ...(previewLang ? { language: previewLang } : {}),
        });
        if (tts?.audio?.length) {
          const p = path.join(dir, 'preview.mp3');
          fs.writeFileSync(p, tts.audio);
          previewPath = p;
          if (typeof tts.creditsCost === 'number') previewCreditsCost = tts.creditsCost;
          channel.log('audio', `create_voice: spoken preview rendered (lang=${previewLang || 'en'}) → ${p}`);
        }
      }
    } catch (err) {
      channel.log('audio', `create_voice: spoken preview failed (${err.message}); using the source sample as the voice preview`);
    }

    // Total cost of the create_voice op = the clone itself + the spoken
    // preview render (both stamped by the gateway when signed in). Stored on
    // the entry so the drawer's Info panel shows what the voice cost.
    const totalCreditsCost =
      (typeof result.creditsCost === 'number' || typeof previewCreditsCost === 'number')
        ? (result.creditsCost || 0) + (previewCreditsCost || 0)
        : undefined;

    const entry = {
      id: localId,
      name,
      providerVoiceId: result.voiceId,
      provider: result.provider || resolved.provider,
      ...(typeof totalCreditsCost === 'number' ? { creditsCost: totalCreditsCost } : {}),
      ...(typeof result.providerRequestId === 'string' ? { providerRequestId: result.providerRequestId } : {}),
      // Store the TTS model the voice is SPOKEN with (same provider as the
      // clone), NOT the voice-clone model — generate_audio needs a TTS slug
      // to sanity-check the agent's model choice against.
      modelSlug: ttsSlug,
      description: action.description || undefined,
      language: previewLang || action.language || undefined,
      labels: action.labels || undefined,
      // The playable creation = the cloned-voice preview when we have
      // it; otherwise the raw input sample.
      samplePath: previewPath
        || (fs.existsSync(sampleSavedTo) ? sampleSavedTo : undefined),
      // Keep the source clip around even when the preview is the public
      // sample — handy for re-clones and debugging.
      sourceSamplePath: fs.existsSync(sampleSavedTo) ? sampleSavedTo : undefined,
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
      ...(typeof totalCreditsCost === 'number' ? { creditsCost: totalCreditsCost } : {}),
      ...(typeof result.providerRequestId === 'string' ? { providerRequestId: result.providerRequestId } : {}),
    };
  },
};

// Given the slug that MINTED a clone (a voice-clone model), find a real
// `audio_tts` model to SPEAK it with. Fully catalog-driven and general:
// the pairing rule is "same provider namespace" (everything up to the last
// slug segment), so any future provider whose clone + TTS models live under
// the same namespace works with zero code changes — no model name is ever
// hardcoded here. Returns null when the catalog has no matching TTS model.
async function _findTtsSlugForProvider(cloneSlug) {
  try {
    if (typeof cloneSlug !== 'string' || !cloneSlug.includes('/')) return null;
    const ns = cloneSlug.trim().split('/').slice(0, -1).join('/');
    if (!ns) return null;
    const caps = await fetchMediaCapabilities('audio');
    const models = Array.isArray(caps?.models) ? caps.models : [];
    const tts = models.filter((m) =>
      typeof m?.slug === 'string' &&
      Array.isArray(m.categories) && m.categories.includes('audio_tts') &&
      m.slug.split('/').slice(0, -1).join('/') === ns);
    // Prefer an exact same-namespace match; if several, take the first the
    // catalog lists (curated order). Nothing here ranks by name.
    return tts.length ? tts[0].slug : null;
  } catch {
    return null;
  }
}

// Produce the neutral one-liner the cloned voice will speak in its
// preview. The text is generated by the LLM (via the factory — no
// hardcoded model, no hardcoded per-language strings): the PROMPT is in
// English per the project's internal-prompt rule, but the OUTPUT is
// asked for in the source audio's language so the spoken sample sounds
// natural. Returns null on any failure so the caller can fall back to
// the raw input sample. Uses the cheapest/fastest tier — this is a
// trivial one-sentence generation.
async function _generateSampleLine(agent, langCode) {
  try {
    const { resolve: resolveModel } = await import('../../llm/providers/factory.js');
    await agent?.llmProvider?._ensureClients?.();
    const { instance: llm } = resolveModel({
      type: 'llm',
      taskType: 'code',
      difficulty: 3,
      availableProviders: agent.llmProvider._availableProviders,
      clients: agent.llmProvider._gatewayMode
        ? agent.llmProvider._gatewayClients()
        : { openai: agent.llmProvider._oa, anthropic: agent.llmProvider._ac, gemini: agent.llmProvider._gc },
    });
    const langClause = langCode
      ? `in the language with ISO 639-1 code "${langCode}"`
      : 'in English';
    const prompt =
      'Write ONE short, neutral, friendly sentence (about 8 to 14 words) that a ' +
      'person would say to demonstrate what their voice sounds like — greet the ' +
      `listener and mention it is a sample of their voice. Write it ${langClause}. ` +
      'Output ONLY the sentence: no quotes, no preamble, no explanation.';
    const { text } = await llm.complete(
      [{ role: 'user', content: prompt }],
      { timeoutMs: 20000 },
    );
    const line = (text || '').trim().split('\n')[0].trim();
    // Strip a single pair of wrapping quotes the model sometimes adds.
    const unquoted = (line.startsWith('"') && line.endsWith('"')) ||
        (line.startsWith('\'') && line.endsWith('\''))
      ? line.slice(1, -1).trim()
      : line;
    return unquoted || null;
  } catch {
    return null;
  }
}

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

import asyncCapable from '../_async-capable.js';
export default asyncCapable(createVoiceAction);
