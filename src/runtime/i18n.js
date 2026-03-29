/**
 * Runtime i18n — Translation function for the Koi runtime.
 *
 * Has its own locale files (i18n/en.js, i18n/es.js, etc.) as fallback.
 * The host CLI (koi-cli) can override strings via globalThis.__koiStrings.
 *
 * Language detection: KOI_LANG env var → system LANG → 'en'
 */

import _en from './i18n/en.js';

// Lazy-load locale to avoid importing all languages at startup
let _runtimeStrings = null;

function _detectLang() {
  const lang = process.env.KOI_LANG || (process.env.LANG || '').split(/[_.@-]/)[0]?.toLowerCase() || 'en';
  return lang;
}

async function _loadLocale() {
  if (_runtimeStrings) return;
  const lang = _detectLang();
  if (lang === 'en') {
    _runtimeStrings = _en;
    return;
  }
  try {
    const mod = await import(`./i18n/${lang}.js`);
    _runtimeStrings = { ..._en, ...(mod.default || mod) };
  } catch {
    _runtimeStrings = _en;
  }
}

// Sync init attempt (for the common case where the locale is already cached)
const _lang = _detectLang();
if (_lang === 'en') {
  _runtimeStrings = _en;
} else {
  // Kick off async load — t() will use English until it resolves
  _loadLocale().catch(() => { _runtimeStrings = _en; });
}

/**
 * Get a translated string by key.
 * Priority: globalThis.__koiStrings (host override) → runtime locale → key itself
 */
export function t(key) {
  return globalThis.__koiStrings?.[key] ?? _runtimeStrings?.[key] ?? _en[key] ?? key;
}
