/**
 * API Key Manager — prompt the user for missing provider API keys,
 * persist them to .env (without overwriting existing content), and
 * set them in process.env for immediate use.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const GLOBAL_ENV_PATH = path.join(os.homedir(), '.koi', '.env');

export const PROVIDER_KEYS = {
  openai:    'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini:    'GEMINI_API_KEY',
};

const PROVIDER_NAMES = {
  openai:    'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini:    'Google Gemini',
};

// All providers that should be configured for full functionality
const REQUIRED_PROVIDERS = ['openai', 'anthropic', 'gemini'];

/**
 * Persist a key to the global ~/.koi/.env, replacing any existing definition.
 */
function _saveKeyToEnv(keyName, key) {
  const dotenvPath = GLOBAL_ENV_PATH;
  const dir = path.dirname(dotenvPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    let existing = '';
    if (fs.existsSync(dotenvPath)) {
      existing = fs.readFileSync(dotenvPath, 'utf8');
    }
    const cleaned = existing
      .split('\n')
      .filter(line => !line.startsWith(`${keyName}=`) && line !== keyName)
      .join('\n');
    const body = cleaned.endsWith('\n') || cleaned === '' ? cleaned : cleaned + '\n';
    fs.writeFileSync(dotenvPath, `${body}${keyName}=${key}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * At startup: check all required providers and prompt for any missing keys.
 * If the user skips a provider, a warning is shown at the end.
 * Called once after the CLI is bootstrapped.
 */
export async function promptMissingApiKeys() {
  const missing = REQUIRED_PROVIDERS.filter(p => !process.env[PROVIDER_KEYS[p]]);
  if (missing.length === 0) return;

  const { cliLogger } = await import('./cli-logger.js');
  const { cliInput }  = await import('./cli-input.js');

  const skipped = [];

  for (const provider of missing) {
    const keyName = PROVIDER_KEYS[provider];
    const providerName = PROVIDER_NAMES[provider];

    cliLogger.print(`No ${keyName} found. Enter your ${providerName} API key (Enter to skip):`);
    const raw = await cliInput(`${providerName}: `);
    const key = (typeof raw === 'string' ? raw : (raw?.text ?? '')).trim();

    // Handle /exit typed during API key prompts
    if (key === '/exit' || key === 'exit') {
      process.exit(0);
    }

    if (!key) {
      skipped.push(providerName);
      continue;
    }

    const saved = _saveKeyToEnv(keyName, key);
    if (!saved) {
      cliLogger.print(`Could not write to ~/.koi/.env — ${keyName} will be active for this session only`);
    }
    process.env[keyName] = key;
  }

  if (skipped.length > 0) {
    cliLogger.print(
      `Warning: no API key configured for ${skipped.join(', ')}. ` +
      `Provider availability and quality will be limited.`
    );
  }
}

/**
 * Ensure an API key exists for the given provider.
 * If missing, prompts the user (no skip option — used when a specific provider is required).
 *
 * @param {string} provider - 'openai' | 'anthropic' | 'gemini'
 * @returns {Promise<string>} the API key
 * @throws if the user provides an empty key
 */
export async function ensureApiKey(provider) {
  const keyName = PROVIDER_KEYS[provider];
  if (!keyName) throw new Error(`Unknown provider: ${provider}`);

  if (process.env[keyName]) return process.env[keyName];

  const { cliLogger } = await import('./cli-logger.js');
  const { cliInput }  = await import('./cli-input.js');

  const providerName = PROVIDER_NAMES[provider] || provider;
  cliLogger.print(`No ${keyName} found. Enter your ${providerName} API key:`);

  const raw = await cliInput('API key: ');
  const key = (typeof raw === 'string' ? raw : (raw?.text ?? '')).trim();

  if (!key) {
    throw new Error(`${keyName} is required — no key provided`);
  }

  const saved = _saveKeyToEnv(keyName, key);
  if (saved) {
    cliLogger.print(`Saved ${keyName} to ~/.koi/.env`);
  } else {
    cliLogger.print(`Could not write to ~/.koi/.env — key will be active for this session only`);
  }

  process.env[keyName] = key;
  return key;
}
