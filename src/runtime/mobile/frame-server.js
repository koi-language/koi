/**
 * Background Frame Server — pre-captures and processes mobile screenshots.
 *
 * Runs a capture loop in the background using async screenshot + resize + grid overlay.
 * Pre-generates ALL three precision levels (low, medium, high) from a single raw capture
 * and keeps them in memory for immediate consumption by mobile_observe.
 *
 * Nothing is written to disk — all frames are in-memory Buffers.
 */

import { addGridOverlay, isSharpAvailable } from './grid-overlay.js';

// Resolution presets — must match mobile-observe.js RESOLUTION_PRESETS
// 'full' is NOT pre-generated (native res is too expensive for background loop).
// It's generated on-demand when requested via getLatestFrame('full').
const PRESETS = {
  low:    { maxWidth: 360, gridCols: 8,  gridRows: 16 },
  medium: { maxWidth: 480, gridCols: 12, gridRows: 24 },
  high:   { maxWidth: 720, gridCols: 24, gridRows: 48 },
};

const FULL_PRESET = { maxWidth: 0, gridCols: 24, gridRows: 48 };

const JPEG_QUALITY = 65;       // JPEG quality for LLM — much smaller than PNG
const DEFAULT_INTERVAL = 1500; // ms between captures
const FRAME_MAX_AGE = 2000;    // ms — frames older than this are considered stale

let _driver = null;
let _running = false;
let _timer = null;

/**
 * Latest frames keyed by precision level.
 * { low: { ... }, medium: { ... }, high: { ... }, timestamp: number }
 */
let _latestFrames = null;

/**
 * Latest elements from the accessibility tree.
 * { elements: Array, timestamp: number }
 */
let _latestElements = null;

/**
 * Start the background capture loop.
 * @param {object} driver — platform driver (ios/android) with screenshotAsync()
 * @param {object} [options]
 * @param {number} [options.interval=1500] — ms between captures
 */
export function start(driver, options = {}) {
  if (_running) return;
  _driver = driver;
  _running = true;

  const interval = options.interval || DEFAULT_INTERVAL;

  if (process.env.KOI_DEBUG_LLM) {
    console.error('[frame-server] Started (interval=%dms, presets: low/medium/high)', interval);
  }

  // Kick off the first capture immediately
  _captureLoop(interval);
}

/**
 * Stop the background capture loop.
 */
export function stop() {
  _running = false;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _driver = null;
  _latestFrames = null;
  _latestElements = null;

  if (process.env.KOI_DEBUG_LLM) {
    console.error('[frame-server] Stopped');
  }
}

/**
 * Get the latest processed frame for a given precision level.
 * 'full' is generated on-demand (not in the background loop) since native
 * resolution processing is too expensive to run every 1.5s.
 * @param {string} [precision='high'] — 'low', 'medium', 'high', or 'full'
 * @returns {Promise<{ rawBuffer: Buffer, griddedBuffer: Buffer, jpegBuffer: Buffer|null, imageWidth: number, imageHeight: number, originalWidth: number, originalHeight: number, timestamp: number }|null>}
 */
export async function getLatestFrame(precision) {
  if (!_latestFrames) return null;
  if (Date.now() - _latestFrames.timestamp > FRAME_MAX_AGE) return null;

  const level = precision || 'high';

  // 'full' is generated on-demand from the raw buffer of the latest capture
  if (level === 'full') {
    return _generateFullOnDemand();
  }

  const frame = _latestFrames[level];
  if (!frame) return null;

  return frame;
}

/**
 * Check if the frame server is running.
 */
export function isRunning() {
  return _running;
}

/**
 * Get the latest elements from the accessibility tree.
 * Returns null if stale or unavailable.
 * @returns {{ elements: Array, timestamp: number }|null}
 */
export function getLatestElements() {
  if (!_latestElements) return null;
  if (Date.now() - _latestElements.timestamp > FRAME_MAX_AGE) return null;
  return _latestElements;
}

/**
 * Force an immediate capture (screenshot at all 3 resolutions + elements).
 * Called after mobile actions to get a fresh post-action state.
 * @param {string} [precision='low'] — which preset to return ('low', 'medium', 'high')
 * @returns {Promise<{ frame: object|null, elements: Array }>}
 */
export async function forceCapture(precision = 'low') {
  if (!_running || !_driver) return { frame: null, elements: [] };

  try {
    await _captureOne();
  } catch (err) {
    if (process.env.KOI_DEBUG_LLM) {
      console.error('[frame-server] forceCapture error: %s', err.message);
    }
  }

  // If elements came back empty (common during iOS home screen transitions),
  // retry once after a short delay — the accessibility tree may not be ready yet.
  let elements = _latestElements?.elements || [];
  if (elements.length === 0 && _driver) {
    await new Promise(r => setTimeout(r, 600));
    try {
      const retryElements = await _fetchElements();
      if (retryElements && retryElements.length > 0) {
        _latestElements = { elements: retryElements, timestamp: Date.now() };
        elements = retryElements;
        if (process.env.KOI_DEBUG_LLM) {
          console.error('[frame-server] forceCapture: retry got %d elements', elements.length);
        }
      }
    } catch { /* non-fatal */ }
  }

  const frame = _latestFrames?.[precision] || _latestFrames?.low || null;
  return { frame, elements };
}

// ─── Internal ────────────────────────────────────────────────────────────

async function _captureLoop(interval) {
  if (!_running || !_driver) return;

  try {
    await _captureOne();
  } catch (err) {
    if (process.env.KOI_DEBUG_LLM) {
      console.error('[frame-server] Capture error: %s', err.message);
    }
  }

  // Schedule next capture — setTimeout avoids accumulation if capture is slow
  if (_running) {
    _timer = setTimeout(() => _captureLoop(interval), interval);
  }
}

async function _captureOne() {
  if (!_driver || !_driver.screenshotAsync) return;

  // Capture screenshot and elements in parallel
  const [rawBuffer, elements] = await Promise.all([
    _driver.screenshotAsync(),
    _fetchElements(),
  ]);

  // Store elements
  _latestElements = { elements: elements || [], timestamp: Date.now() };

  const sharpOk = await isSharpAvailable();
  if (!sharpOk) {
    // Without sharp we can't resize/grid — store raw frame for all levels
    const now = Date.now();
    const fallback = {
      rawBuffer,
      griddedBuffer: rawBuffer,
      jpegBuffer: null,
      imageWidth: 0,
      imageHeight: 0,
      originalWidth: 0,
      originalHeight: 0,
      timestamp: now,
    };
    _latestFrames = { low: fallback, medium: fallback, high: fallback, timestamp: now };
    return;
  }

  const sharpMod = (await import('sharp')).default || (await import('sharp'));

  // Get original dimensions once
  const meta = await sharpMod(rawBuffer).metadata();
  const originalWidth = meta.width;
  const originalHeight = meta.height;

  const now = Date.now();

  // Process all 3 presets in parallel from the same raw capture
  const entries = await Promise.all(
    Object.entries(PRESETS).map(async ([level, preset]) => {
      // maxWidth: 0 → no resize, use original resolution
      let resizedBuffer;
      let imageWidth, imageHeight;
      if (preset.maxWidth > 0) {
        resizedBuffer = await sharpMod(rawBuffer)
          .resize(preset.maxWidth)
          .png()
          .toBuffer();
        const resizedMeta = await sharpMod(resizedBuffer).metadata();
        imageWidth = resizedMeta.width;
        imageHeight = resizedMeta.height;
      } else {
        resizedBuffer = await sharpMod(rawBuffer).png().toBuffer();
        imageWidth = originalWidth;
        imageHeight = originalHeight;
      }

      // Grid overlay
      const gridResult = await addGridOverlay(resizedBuffer, {
        cols: preset.gridCols,
        rows: preset.gridRows,
      });

      // Pre-compute JPEG for LLM (much smaller than PNG)
      let jpegBuffer = null;
      try {
        jpegBuffer = await sharpMod(gridResult.buffer).jpeg({ quality: JPEG_QUALITY }).toBuffer();
      } catch { /* fallback: no jpeg */ }

      return [level, {
        rawBuffer,
        griddedBuffer: gridResult.buffer,
        jpegBuffer,
        imageWidth,
        imageHeight,
        originalWidth,
        originalHeight,
        timestamp: now,
      }];
    })
  );

  _latestFrames = { timestamp: now };
  for (const [level, frame] of entries) {
    _latestFrames[level] = frame;
  }

}

/**
 * Generate a 'full' (native resolution) frame on-demand from the latest raw capture.
 * This avoids running expensive native-res processing every 1.5s in the background.
 */
async function _generateFullOnDemand() {
  if (!_latestFrames) return null;

  // Use the raw buffer from any existing preset (they all share the same raw capture)
  const anyFrame = _latestFrames.high || _latestFrames.medium || _latestFrames.low;
  if (!anyFrame || !anyFrame.rawBuffer) return null;

  const sharpOk = await isSharpAvailable();
  if (!sharpOk) return anyFrame; // fallback: return whatever we have

  const sharpMod = (await import('sharp')).default || (await import('sharp'));
  const rawBuffer = anyFrame.rawBuffer;

  const pngBuffer = await sharpMod(rawBuffer).png().toBuffer();
  const meta = await sharpMod(pngBuffer).metadata();

  const gridResult = await addGridOverlay(pngBuffer, {
    cols: FULL_PRESET.gridCols,
    rows: FULL_PRESET.gridRows,
  });

  let jpegBuffer = null;
  try {
    jpegBuffer = await sharpMod(gridResult.buffer).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  } catch { /* fallback: no jpeg */ }

  return {
    rawBuffer,
    griddedBuffer: gridResult.buffer,
    jpegBuffer,
    imageWidth: meta.width,
    imageHeight: meta.height,
    originalWidth: anyFrame.originalWidth,
    originalHeight: anyFrame.originalHeight,
    timestamp: anyFrame.timestamp,
  };
}

/**
 * Fetch elements from the driver's accessibility tree.
 * Returns [] on failure (non-fatal).
 */
async function _fetchElements() {
  if (!_driver) return [];
  try {
    if (_driver.getElementsAsync) return await _driver.getElementsAsync();
    if (_driver.getElements) return _driver.getElements();
  } catch { /* non-fatal */ }
  return [];
}
