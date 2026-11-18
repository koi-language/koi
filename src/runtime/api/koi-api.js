/**
 * The Koi API: the one backend every model call can go through.
 *
 * Any server that speaks the Koi API (`<url>/gateway/...`: chat, models,
 * embeddings, image, video, audio) can be used. braxil.ai is the default;
 * api.brabier.com serves the same API, and so can a local one.
 *
 *   KOI_API_URL   where the API lives          (default https://api.braxil.ai)
 *   KOI_API_KEY   the key sent as `Bearer`     (a fixed key, e.g. brb_… on brabier.com)
 *   KOI_AUTH_TOKEN  alias of KOI_API_KEY, kept because a host app (koi-cli)
 *                   stores its signed-in session there and refreshes it.
 *
 * KOI_API_KEY wins over KOI_AUTH_TOKEN: a key written in `.env` is a deliberate
 * choice. With neither, chat and embeddings use the providers' own keys
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY); image, video and audio
 * are only ever generated through the Koi API.
 *
 * Read these at call time, never cache them: a host may sign in, refresh the
 * session or change the URL while the runtime is running.
 */

export const DEFAULT_KOI_API_URL = 'https://api.braxil.ai';

/** Base URL of the Koi API, without a trailing slash. */
export function koiApiUrl() {
  return (process.env.KOI_API_URL || DEFAULT_KOI_API_URL).trim().replace(/\/+$/, '');
}

/** `<KOI_API_URL>/gateway`, the OpenAI-compatible root of the model routes. */
export function koiGatewayUrl() {
  return `${koiApiUrl()}/gateway`;
}

/** The credential for the Koi API, or null when none is configured. */
export function koiApiKey() {
  return process.env.KOI_API_KEY || process.env.KOI_AUTH_TOKEN || null;
}

/** True when model calls go through the Koi API. */
export function hasKoiApi() {
  return !!koiApiKey();
}

/**
 * True when the credential is a fixed key from the environment rather than a
 * session a host can refresh. A 401 on a fixed key means the key is wrong: there
 * is nothing to re-login, and the host's saved session must not be touched.
 */
export function isFixedKoiApiKey() {
  return !!process.env.KOI_API_KEY;
}

/** The message for anything that can only run through the Koi API. */
export function koiApiRequiredMessage(what) {
  return `${what} goes through the Koi API: set KOI_API_KEY (and KOI_API_URL to use a server other than ${DEFAULT_KOI_API_URL}), or sign in from the app that runs Koi.`;
}
