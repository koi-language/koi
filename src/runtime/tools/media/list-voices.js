/**
 * list_voices — enumerate the voices you can speak a TTS model with.
 *
 * Returns, for a given TTS model (or provider), the provider's built-in PRESET
 * voices PLUS the user's CLONED voices for that provider. The preset tokens are
 * exactly the values `generate_audio`'s `voice` accepts for each provider
 * (ElevenLabs voice NAMES, MiniMax preset voice_ids, OpenAI presets) — sourced
 * from the audio-generator skill, the sanctioned contract. There is no stored
 * sample for a preset: a short preview is produced on demand by calling
 * generate_audio with the chosen voice.
 */

import { channel } from '../../io/channel.js';
import { listVoices as listClones } from '../../state/voice-registry.js';

// Provider preset voices. A reference CATALOG (not a routing table), mirroring
// the audio-generator skill's models.md + usage/elevenlabs-v3.md. Providers'
// default sets rotate over time, so treat these as a starting list, not a hard
// enum — any valid voice name for the provider also works.
const PRESETS = {
  elevenlabs: [
    { id: 'Rachel', label: 'Rachel', gender: 'female' },
    { id: 'Aria', label: 'Aria', gender: 'female' },
    { id: 'Sarah', label: 'Sarah', gender: 'female' },
    { id: 'Laura', label: 'Laura', gender: 'female' },
    { id: 'River', label: 'River', gender: 'nonbinary' },
    { id: 'Charlotte', label: 'Charlotte', gender: 'female' },
    { id: 'Alice', label: 'Alice', gender: 'female' },
    { id: 'Matilda', label: 'Matilda', gender: 'female' },
    { id: 'Jessica', label: 'Jessica', gender: 'female' },
    { id: 'Lily', label: 'Lily', gender: 'female' },
    { id: 'Roger', label: 'Roger', gender: 'male' },
    { id: 'Charlie', label: 'Charlie', gender: 'male' },
    { id: 'George', label: 'George', gender: 'male' },
    { id: 'Callum', label: 'Callum', gender: 'male' },
    { id: 'Liam', label: 'Liam', gender: 'male' },
    { id: 'Will', label: 'Will', gender: 'male' },
    { id: 'Eric', label: 'Eric', gender: 'male' },
    { id: 'Chris', label: 'Chris', gender: 'male' },
    { id: 'Brian', label: 'Brian', gender: 'male' },
    { id: 'Daniel', label: 'Daniel', gender: 'male' },
    { id: 'Bill', label: 'Bill', gender: 'male' },
  ],
  minimax: [
    { id: 'Wise_Woman', label: 'Wise Woman', gender: 'female' },
    { id: 'Calm_Woman', label: 'Calm Woman', gender: 'female' },
    { id: 'Lively_Girl', label: 'Lively Girl', gender: 'female' },
    { id: 'Deep_Voice_Man', label: 'Deep Voice Man', gender: 'male' },
    { id: 'Casual_Guy', label: 'Casual Guy', gender: 'male' },
    { id: 'Patient_Man', label: 'Patient Man', gender: 'male' },
  ],
  openai: [
    { id: 'alloy', label: 'Alloy' },
    { id: 'echo', label: 'Echo' },
    { id: 'fable', label: 'Fable' },
    { id: 'onyx', label: 'Onyx' },
    { id: 'nova', label: 'Nova' },
    { id: 'shimmer', label: 'Shimmer' },
  ],
};

// Coarse provider key from a model slug (structured id match, not NL).
function _providerKey(slug) {
  if (typeof slug !== 'string') return null;
  const s = slug.toLowerCase();
  if (s.includes('elevenlabs') || s.includes('eleven-') || s.includes('eleven_')) return 'elevenlabs';
  if (s.includes('minimax')) return 'minimax';
  if (s.includes('openai') || s.includes('gpt-') || s.includes('tts-1')) return 'openai';
  return null;
}

// Provider namespace of a slug (drop the last '/' segment), matching
// generate-audio.js so a clone links to its provider's TTS model.
function _namespace(slug) {
  if (typeof slug !== 'string' || !slug) return '';
  const parts = slug.split('/');
  return parts.length <= 1 ? slug : parts.slice(0, -1).join('/');
}

export default {
  type: 'list_voices',
  intent: 'list_voices',
  description:
    'List the voices you can speak a TTS model with: the provider\'s built-in PRESET voices (accepted directly as generate_audio `voice`) plus the user\'s CLONED voices for that provider. ' +
    'Pass the TTS model slug (best — it determines the provider) or a provider key (elevenlabs / minimax / openai). ' +
    'Returns { success, provider, presets: [{ id, label, gender? }], clones: [{ id, name, providerVoiceId, samplePath? }] }. ' +
    'Use a returned preset `id` (or clone name/id) as generate_audio\'s `voice`. Presets have NO stored sample — synthesize a short preview by calling generate_audio with that voice.',
  thinkingHint: () => 'Listing voices',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'TTS model slug (e.g. fal-ai/elevenlabs/tts/eleven-v3). Determines the provider.' },
      provider: { type: 'string', description: 'OPTIONAL provider key (elevenlabs / minimax / openai) when you have no slug.' },
    },
  },

  async execute(action) {
    const model = (typeof action?.model === 'string') ? action.model.trim() : '';
    const key = (typeof action?.provider === 'string' && action.provider.trim())
      ? action.provider.trim().toLowerCase()
      : _providerKey(model);
    const presets = (key && PRESETS[key]) ? PRESETS[key] : [];

    let clones = [];
    try {
      const ns = _namespace(model);
      const all = listClones() || [];
      clones = all
        .filter((v) => {
          if (!key) return true; // no provider resolved → show all clones
          if (v.modelSlug && ns && _namespace(v.modelSlug) === ns) return true;
          if (v.provider && String(v.provider).toLowerCase() === key) return true;
          return false;
        })
        .map((v) => ({
          id: v.id,
          name: v.name,
          providerVoiceId: v.providerVoiceId,
          samplePath: v.samplePath || null,
        }));
    } catch (e) {
      channel.log('list_voices', `clone enumeration failed: ${e.message}`);
    }

    return { success: true, provider: key || null, presets, clones };
  },
};
