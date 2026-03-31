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

// Providers required for basic local functionality
const REQUIRED_PROVIDERS = ['openai'];

// Optional providers to recommend during initial setup
const RECOMMENDED_PROVIDERS = ['anthropic', 'gemini'];

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
 * Internal helper to prompt for an API key using the runtime's prompt_user action.
 * This ensures the UI (Ink) handles the input correctly.
 */
async function _promptForApiKey(executor, { provider, keyName, providerName, allowSkip }) {
  const question = allowSkip
    ? `No ${keyName} found. Enter your ${providerName} API key (Enter to skip):`
    : `No ${keyName} found. Enter your ${providerName} API key:`;
  const label = `API Key for ${providerName}`;
  const hint = allowSkip ? 'Press Enter to skip.' : undefined;

  // If no executor (agent) is provided, we can't use the action system.
  // This shouldn't happen in CLI mode after bootstrap.
  if (!executor || typeof executor.executeActions !== 'function') {
    const { channel: cliLogger } = await import('../io/channel.js');
    const cliInput = (await import('../io/channel.js')).channel.prompt;
    cliLogger.print(question);
    const raw = await cliInput(`${providerName}: `);
    return (typeof raw === 'string' ? raw : (raw?.text ?? '')).trim();
  }

  const result = await executor.executeActions([
    {
      actionType: 'direct',
      intent: 'prompt_form',
      title: question,
      fields: [
        {
          label,
          question: `Enter your ${providerName} API key:`,
          ...(hint ? { hint } : {})
        }
      ]
    }
  ]);

  if (result?.cancelled) return '';
  const key = (result?.answers?.[label] || '').trim();
  if (key === '/exit' || key === 'exit') process.exit(0);
  return key;
}

/**
 * At startup: check all required providers and prompt for any missing keys.
 * If the user skips a provider, a warning is shown at the end.
 * Called once after the CLI is bootstrapped.
 * 
 * @param {Agent} agent - The agent instance to use for executing the prompt action
 */
export async function promptMissingApiKeys(agent) {
  // When authenticated via braxil.ai account, API keys are not needed —
  // the gateway proxies LLM calls using the auth token.
  if (process.env.KOI_AUTH_TOKEN) return;

  // If at least one API key is already configured, don't prompt for the missing ones.
  // The user can add more anytime via .env or /config.
  const allKeys = Object.values(PROVIDER_KEYS);
  const hasAnyKey = allKeys.some(k => process.env[k]);
  if (hasAnyKey) return;

  const configuredProvider = process.env.KOI_DEFAULT_PROVIDER;
  const includeRecommended = !configuredProvider
    || configuredProvider === 'auto'
    || !Object.prototype.hasOwnProperty.call(PROVIDER_KEYS, configuredProvider)
    || REQUIRED_PROVIDERS.includes(configuredProvider)
    || RECOMMENDED_PROVIDERS.includes(configuredProvider);

  const providerPool = includeRecommended
    ? REQUIRED_PROVIDERS.concat(RECOMMENDED_PROVIDERS)
    : REQUIRED_PROVIDERS;

  // If a default provider is explicitly set (e.g., openai), skip recommending other providers.
  const missing = providerPool.filter(p => !process.env[PROVIDER_KEYS[p]]);
  if (missing.length === 0) return;

  const { channel: cliLogger } = await import('../io/channel.js');

  const skipped = [];

  for (const provider of missing) {
    const keyName = PROVIDER_KEYS[provider];
    const providerName = PROVIDER_NAMES[provider];

    const key = await _promptForApiKey(agent, { provider, keyName, providerName, allowSkip: true });

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
      `Hint: optional API keys not configured for ${skipped.join(', ')}. ` +
      `You can add them anytime in ~/.koi/.env or via /config. ` +
      `Optional providers expand availability and model quality.`
    );
  }
}

/**
 * Ensure an API key exists for the given provider.
 * If missing, prompts the user (no skip option — used when a specific provider is required).
 *
 * @param {string} provider - 'openai' | 'anthropic' | 'gemini'
 * @param {Agent} [agent] - Optional agent instance for prompting
 * @returns {Promise<string>} the API key
 * @throws if the user provides an empty key
 */
export async function ensureApiKey(provider, agent) {
  const keyName = PROVIDER_KEYS[provider];
  if (!keyName) throw new Error(`Unknown provider: ${provider}`);

  if (process.env[keyName]) return process.env[keyName];

  // When authenticated via braxil.ai account, the gateway handles provider access.
  if (process.env.KOI_AUTH_TOKEN) return '__KOI_ACCOUNT__';

  const providerName = PROVIDER_NAMES[provider] || provider;
  const key = await _promptForApiKey(agent, { provider, keyName, providerName, allowSkip: false });

  if (!key) {
    throw new Error(`${keyName} is required — no key provided`);
  }

  const { channel: cliLogger } = await import('../io/channel.js');
  const saved = _saveKeyToEnv(keyName, key);
  if (saved) {
    cliLogger.print(`Saved ${keyName} to ~/.koi/.env`);
  } else {
    cliLogger.print(`Could not write to ~/.koi/.env — key will be active for this session only`);
  }

  process.env[keyName] = key;
  return key;
}
