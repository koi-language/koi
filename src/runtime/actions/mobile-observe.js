/**
 * Mobile Observe Action — screenshot + grid overlay + element detection.
 *
 * Takes a screenshot, resizes it (configurable width for precision levels),
 * overlays a labeled grid, and detects UI elements.
 * The grid allows the LLM to target taps/swipes using cell IDs like "E12".
 *
 * Supports dynamic resolution via precision presets:
 *   - low:    360px, 8×16 grid  (large buttons, app icons)
 *   - medium: 480px, 12×24 grid (search, typing, lists)
 *   - high:   720px, 24×48 grid (calendars, sliders, dense UIs)
 *   - full:   native resolution, 24×48 grid (maximum detail, map pins, tiny text)
 *   - auto:   LLM-based evaluation per screen
 *
 * Uses the background frame server when available — pre-captured frames
 * eliminate screenshot + resize + grid latency from the critical path.
 */

import {
  getPlatform, setPlatform, setLastFrameInfo,
  startFrameServer, getLatestFrame, isFrameServerRunning,
  getCachedElements,
} from '../mobile/platform.js';
import { formatElementsSummary } from '../mobile/element-matching.js';
import { addGridOverlay, isSharpAvailable, getGridInfo } from '../mobile/grid-overlay.js';
import { detectElementsViaVision } from '../mobile/vision-detector.js';
import { sessionTracker } from '../session-tracker.js';

// Resolution presets keyed by precision level
// maxWidth: 0 means no resize (use original/native resolution)
const RESOLUTION_PRESETS = {
  low:    { maxWidth: 360, gridCols: 8,  gridRows: 16 },
  medium: { maxWidth: 480, gridCols: 12, gridRows: 24 },
  high:   { maxWidth: 720, gridCols: 24, gridRows: 48 },
  full:   { maxWidth: 0,   gridCols: 24, gridRows: 48 },
};

const DEFAULT_PRECISION = 'high';
const JPEG_QUALITY = 65;  // JPEG quality for LLM — much smaller than PNG, good enough for navigation

/**
 * Evaluate screen precision using LLM vision analysis.
 * Sends the screenshot to a cheap model to determine if the screen needs
 * low, medium, or high precision for interaction.
 *
 * @param {Buffer} imageBuffer - Raw screenshot buffer
 * @param {object} llmProvider - The agent's LLM provider
 * @param {number} elementCount - Number of detected accessibility elements
 * @param {string} currentGoal - The current navigation goal (if available)
 * @returns {Promise<string>} - 'low', 'medium', or 'high'
 */
async function evaluateScreenPrecision(imageBuffer, llmProvider, elementCount, currentGoal) {
  const client = llmProvider._gc || llmProvider._oa || llmProvider.openai;
  if (!client) return DEFAULT_PRECISION;

  const prompt = `Analyze this mobile screen and determine the precision level needed for interaction.

CURRENT GOAL: "${currentGoal || 'unknown'}"
DETECTED ACCESSIBILITY ELEMENTS: ${elementCount}

What precision level is needed to interact with this screen?

PRECISION LEVELS:
- LOW (360px, 8x16 grid): Simple screens with large buttons, clear icons
- MEDIUM (480px, 12x24 grid): Most screens, search boxes, lists
- HIGH (720px, 24x48 grid): Calendar grids, date pickers, small icons, dense UIs, sliders
- FULL (native resolution, 24x48 grid): Maximum detail — tiny text, map pins, fine details that are unreadable at lower resolutions

Look at the screen and decide:
1. Are there small touch targets that need precise tapping?
2. Is this a calendar/date picker/time selector?
3. Is the UI dense with many small elements?

Respond in JSON:
{
  "precision": "low" | "medium" | "high" | "full",
  "reason": "brief explanation"
}`;

  const base64 = imageBuffer.toString('base64');
  const model = llmProvider.model || 'auto';

  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' },
            },
          ],
        },
      ],
    });

    const text = completion.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const level = (parsed.precision || '').toLowerCase();
      if (RESOLUTION_PRESETS[level]) {
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[mobile_observe] Auto-precision: ${level} (reason: ${parsed.reason})`);
        }
        return level;
      }
    }
  } catch (err) {
    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[mobile_observe] Precision evaluation failed: ${err.message}`);
    }
  }

  return DEFAULT_PRECISION;
}

export default {
  type: 'mobile_observe',
  intent: 'mobile_observe',
  description:
    'Observe the mobile screen: takes a screenshot with a grid overlay and detects all interactive UI elements. ' +
    'The grid overlay helps you specify precise tap targets using cell IDs like "E12". ' +
    'Fields: "platform" (optional: "ios" or "android" — auto-detects if omitted), ' +
    '"precision" (optional: "low", "medium", "high", "full", or "auto" — defaults to "high"). ' +
    'Returns: screenshot image with grid + text list of all screen elements. ' +
    'ALWAYS call this before interacting with the mobile screen.',
  thinkingHint: () => 'Observing mobile screen',
  permission: 'use_mobile',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      platform: {
        type: 'string',
        enum: ['ios', 'android'],
        description: 'Force a specific platform. Auto-detected if omitted.',
      },
      precision: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'full', 'auto'],
        description: 'Resolution preset: "low" (360px, 8×16), "medium" (480px, 12×24), "high" (720px, 24×48), "full" (native resolution, 24×48), or "auto" (LLM-evaluated). Defaults to "high".',
      },
      goal: {
        type: 'string',
        description: 'Current navigation goal — used by auto-precision to evaluate screen complexity.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'mobile_observe' },
    { actionType: 'direct', intent: 'mobile_observe', platform: 'ios' },
    { actionType: 'direct', intent: 'mobile_observe', precision: 'medium' },
    { actionType: 'direct', intent: 'mobile_observe', precision: 'auto', goal: 'Select March 15 on calendar' },
  ],

  async execute(action, agent) {
    if (action.platform) setPlatform(action.platform);

    const driver = await getPlatform();

    // Resolve precision level — default to 'high', support 'auto' for LLM evaluation
    let precisionLevel = (action.precision || DEFAULT_PRECISION).toLowerCase();
    const isAutoPrecision = precisionLevel === 'auto';

    // For auto, we need a fresh screenshot first to evaluate — start with 'high' defaults
    // and re-capture if the LLM says a different precision is needed.
    if (isAutoPrecision) precisionLevel = DEFAULT_PRECISION;

    let preset = RESOLUTION_PRESETS[precisionLevel] || RESOLUTION_PRESETS[DEFAULT_PRECISION];
    let GRID_COLS = preset.gridCols;
    let GRID_ROWS = preset.gridRows;
    let RESIZE_WIDTH = preset.maxWidth;

    // Frame server now pre-generates all 3 resolutions — use cache for any precision (skip for auto)
    const useCache = !isAutoPrecision;
    const cachedFrame = useCache ? await getLatestFrame(precisionLevel) : null;

    let rawBuffer, imageBuffer, gridApplied, imageWidth, imageHeight, originalWidth, originalHeight;
    let precomputedJpeg = null;

    if (cachedFrame) {
      // ── Fast path: use cached frame (0ms for screenshot + resize + grid) ──
      rawBuffer = cachedFrame.rawBuffer;
      imageBuffer = cachedFrame.griddedBuffer;
      precomputedJpeg = cachedFrame.jpegBuffer || null;
      imageWidth = cachedFrame.imageWidth;
      imageHeight = cachedFrame.imageHeight;
      originalWidth = cachedFrame.originalWidth;
      originalHeight = cachedFrame.originalHeight;
      gridApplied = imageWidth > 0;

      if (process.env.KOI_DEBUG_LLM) {
        const age = Date.now() - cachedFrame.timestamp;
        console.error('[mobile_observe] Using cached frame (age=%dms, precision=%s)', age, precisionLevel);
      }
    } else {
      // ── Fresh capture path ──
      rawBuffer = driver.screenshotAsync
        ? await driver.screenshotAsync()
        : driver.screenshot();

      imageBuffer = rawBuffer;
      gridApplied = false;
      imageWidth = undefined;
      imageHeight = undefined;
      originalWidth = undefined;
      originalHeight = undefined;

      // For auto precision: detect elements first, then evaluate precision with LLM
      if (isAutoPrecision && agent?.llmProvider) {
        let elementsForEval = await getCachedElements(driver);
        const evalPrecision = await evaluateScreenPrecision(
          rawBuffer, agent.llmProvider, elementsForEval.length, action.goal || ''
        );
        precisionLevel = evalPrecision;
        preset = RESOLUTION_PRESETS[precisionLevel];
        GRID_COLS = preset.gridCols;
        GRID_ROWS = preset.gridRows;
        RESIZE_WIDTH = preset.maxWidth;

        if (process.env.KOI_DEBUG_LLM) {
          console.error('[mobile_observe] Auto-precision resolved to: %s (%dpx, %dx%d)', precisionLevel, RESIZE_WIDTH, GRID_COLS, GRID_ROWS);
        }
      }

      const sharpOk = await isSharpAvailable();
      if (sharpOk) {
        try {
          const sharpMod = (await import('sharp')).default || (await import('sharp'));

          // Get original dimensions
          const meta = await sharpMod(rawBuffer).metadata();
          originalWidth = meta.width;
          originalHeight = meta.height;

          // Resize to preset width keeping aspect ratio (0 = no resize, native)
          let resizedBuffer;
          if (RESIZE_WIDTH > 0) {
            resizedBuffer = await sharpMod(rawBuffer)
              .resize(RESIZE_WIDTH)
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

          // Apply grid overlay on resized image with preset grid dimensions
          const gridResult = await addGridOverlay(resizedBuffer, {
            cols: GRID_COLS,
            rows: GRID_ROWS,
          });
          imageBuffer = gridResult.buffer;
          gridApplied = true;
        } catch {
          // Fallback to raw screenshot
        }
      }

      // Start frame server for subsequent calls (only for default high precision)
      if (!isFrameServerRunning() && driver.screenshotAsync) {
        startFrameServer(driver);
      }
    }

    // Fallback dimensions
    if (!imageWidth) {
      const screen = driver.getScreenSize();
      originalWidth = screen.width;
      originalHeight = screen.height;
      imageWidth = screen.width;
      imageHeight = screen.height;
    }
    if (!originalWidth) {
      originalWidth = imageWidth;
      originalHeight = imageHeight;
    }

    // Store frame info for tap/swipe cell-to-coordinate conversion
    setLastFrameInfo({
      imageWidth,
      imageHeight,
      originalWidth,
      originalHeight,
      gridCols: gridApplied ? GRID_COLS : 0,
      gridRows: gridApplied ? GRID_ROWS : 0,
      platform: driver.type,
    });

    // Element detection — use cached if fresh, fall back to LLM vision
    let elements = await getCachedElements(driver);

    if (elements.length === 0 && agent?.llmProvider) {
      try {
        elements = await detectElementsViaVision(rawBuffer, agent.llmProvider, originalWidth, originalHeight);
      } catch (err) {
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[mobile_observe] Vision detection failed: ${err.message}`);
        }
      }
    }

    const elementsSummary = formatElementsSummary(elements);

    // Build full text summary
    let fullSummary = elementsSummary;
    if (gridApplied) {
      fullSummary += `\n\n${getGridInfo(GRID_COLS, GRID_ROWS)}`;
      fullSummary += `\nPrecision: ${precisionLevel} (${RESIZE_WIDTH}px, ${GRID_COLS}×${GRID_ROWS})`;
      if (elements.length === 0) {
        fullSummary += '\nNo elements detected via accessibility. Look at the screenshot and use mobile_tap with cell="X#" (e.g. cell="E12") to tap targets visible in the grid.';
      } else {
        fullSummary += '\nUse mobile_tap with element="label" (preferred) or cell="X#" when element has no label.';
      }
    }

    // Persist raw screenshot in session
    let imageId = null;
    if (sessionTracker) {
      imageId = sessionTracker.storeImage(rawBuffer, {
        source: `mobile_observe_${driver.type}`,
        description: `Mobile screen (${elements.length} elements, precision: ${precisionLevel})`,
        mimeType: 'image/png',
      });
    }

    // Convert gridded image to JPEG for LLM (much smaller: ~200KB vs ~1.9MB PNG)
    let llmBuffer = imageBuffer;
    let llmMime = 'image/png';
    if (gridApplied) {
      if (precomputedJpeg) {
        llmBuffer = precomputedJpeg;
        llmMime = 'image/jpeg';
      } else {
        try {
          const sharpMod = (await import('sharp')).default || (await import('sharp'));
          llmBuffer = await sharpMod(imageBuffer).jpeg({ quality: JPEG_QUALITY }).toBuffer();
          llmMime = 'image/jpeg';
        } catch { /* fallback to PNG */ }
      }
    }

    const base64 = llmBuffer.toString('base64');
    return {
      platform: driver.type,
      elementCount: elements.length,
      imageId: imageId || 'ephemeral',
      gridApplied,
      precision: precisionLevel,
      content: [
        { type: 'image', data: base64, mimeType: llmMime },
        { type: 'text', text: fullSummary },
      ],
    };
  },
};
