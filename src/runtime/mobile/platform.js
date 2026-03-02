/**
 * Mobile Platform Abstraction — singleton with lazy init and auto-detection.
 *
 * Detects whether an iOS Simulator or Android Emulator is running and returns
 * the appropriate driver. The driver is cached as a singleton.
 */

import { execFileSync } from 'child_process';

let _instance = null;
let _forcedType = null;

/**
 * Last frame info from mobile_observe — used by tap/swipe to convert cell coordinates.
 * Updated every time mobile_observe runs.
 */
let _lastFrameInfo = null;

export function setLastFrameInfo(info) { _lastFrameInfo = info; }
export function getLastFrameInfo() { return _lastFrameInfo; }

/**
 * Cached elements from the last getElements() call.
 * Avoids re-fetching the accessibility tree when the UI hasn't changed (<1s).
 */
let _elementsCache = null;
let _elementsCacheTime = 0;
const ELEMENTS_CACHE_TTL = 1000; // ms

/**
 * Get cached elements if fresh enough, otherwise fetch new ones.
 * @param {object} driver — platform driver
 * @returns {Promise<Array>}
 */
export async function getCachedElements(driver) {
  if (_elementsCache && (Date.now() - _elementsCacheTime) < ELEMENTS_CACHE_TTL) {
    return _elementsCache;
  }
  let elements = [];
  try {
    elements = driver.getElementsAsync
      ? await driver.getElementsAsync()
      : driver.getElements();
  } catch { /* ignore */ }
  _elementsCache = elements;
  _elementsCacheTime = Date.now();
  return elements;
}

/**
 * Invalidate the elements cache (call after tap/type/swipe/key actions).
 */
export function invalidateElementsCache() {
  _elementsCache = null;
  _elementsCacheTime = 0;
}

/**
 * Auto-detect which mobile platform is available.
 * @returns {'ios'|'android'|null}
 */
export function detectPlatform() {
  // Check iOS Simulator
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    if (out.includes('Booted')) return 'ios';
  } catch { /* not available */ }

  // Check Android emulator
  try {
    const out = execFileSync('adb', ['devices'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    const lines = out.split('\n').filter(l => l.includes('\tdevice'));
    if (lines.length > 0) return 'android';
  } catch { /* not available */ }

  return null;
}

/**
 * Force a specific platform (useful for testing or explicit user choice).
 * Resets the cached singleton.
 * @param {'ios'|'android'} type
 */
export function setPlatform(type) {
  if (type !== 'ios' && type !== 'android') {
    throw new Error(`setPlatform: invalid type "${type}". Use "ios" or "android".`);
  }
  _forcedType = type;
  _instance = null;
}

/**
 * Get the platform driver (lazy singleton).
 * @returns {Promise<IosPlatform|AndroidPlatform>}
 */
export async function getPlatform() {
  if (_instance) return _instance;

  const type = _forcedType || detectPlatform();

  if (!type) {
    throw new Error(
      'No mobile platform detected.\n\n' +
      'iOS Simulator:\n' +
      '  open -a Simulator\n' +
      '  xcrun simctl boot <device-id>\n\n' +
      'Android Emulator:\n' +
      '  emulator -avd <name>\n' +
      '  adb devices  # should list a device'
    );
  }

  if (type === 'ios') {
    const { IosPlatform } = await import('./ios.js');
    _instance = new IosPlatform();
  } else {
    const { AndroidPlatform } = await import('./android.js');
    _instance = new AndroidPlatform();
  }

  await _instance.init();
  return _instance;
}

/**
 * Reset the cached singleton (for testing).
 */
export function resetPlatform() {
  _instance = null;
  _forcedType = null;
}

// ─── Frame Server re-exports ─────────────────────────────────────────────

export {
  start as startFrameServer,
  stop as stopFrameServer,
  getLatestFrame,
  getLatestElements,
  forceCapture,
  isRunning as isFrameServerRunning,
} from './frame-server.js';
