/**
 * Mobile Tap Action — tap by element label, grid cell, or (x, y) coordinates.
 *
 * Priority: element label (best) → grid cell (good) → raw coordinates (last resort).
 * Grid cells (e.g. "E12") reference the grid overlay from mobile_observe.
 * Supports gestures: "tap" (default), "double" (double tap), "long" (long press).
 */

import { getPlatform, getLastFrameInfo, invalidateElementsCache, getCachedElements, getLatestElements } from '../../navigation/mobile/platform.js';
import { findElementByLabel, getElementCenter, formatElementsSummary } from '../../navigation/mobile/element-matching.js';
import { cellToCoordinates, isValidCell } from '../../navigation/mobile/grid-overlay.js';

export default {
  type: 'mobile_tap',
  intent: 'mobile_tap',
  description:
    'Tap on a mobile UI element. Three ways to specify the target (in order of preference): ' +
    '1. "element" — label/text of the element (BEST, use when element is in the SCREEN ELEMENTS list). ' +
    '2. "cell" — grid cell ID like "E12" from the grid overlay (GOOD, use when element has no label). ' +
    '3. "x","y" — raw pixel coordinates (LAST RESORT). ' +
    'Optional "gesture": "tap" (default), "double" (double tap to select text), "long" (long press for context menu). ' +
    'At least one targeting method is required.',
  thinkingHint: (action) => {
    const gesture = action.gesture === 'double' ? 'Double tapping' : action.gesture === 'long' ? 'Long pressing' : 'Tapping';
    if (action.element) return `${gesture} "${action.element}"`;
    // For cell/coordinate taps, try to find the nearest element label
    if (action.cell || action.x != null) {
      try {
        const { getLatestElements } = require('../../navigation/mobile/platform.js');
        const latest = getLatestElements();
        if (latest?.elements?.length > 0) {
          const { cellToCoordinates } = require('../../navigation/mobile/grid-overlay.js');
          const { getLastFrameInfo } = require('../../navigation/mobile/platform.js');
          const frameInfo = getLastFrameInfo();
          let tapX, tapY;
          if (action.cell && frameInfo?.gridCols) {
            const imgCoords = cellToCoordinates(action.cell.toUpperCase(), frameInfo.imageWidth, frameInfo.imageHeight, frameInfo.gridCols, frameInfo.gridRows);
            if (imgCoords) {
              const scaleX = (frameInfo.originalWidth || frameInfo.imageWidth) / frameInfo.imageWidth;
              const scaleY = (frameInfo.originalHeight || frameInfo.imageHeight) / frameInfo.imageHeight;
              tapX = imgCoords.x * scaleX;
              tapY = imgCoords.y * scaleY;
            }
          } else {
            tapX = action.x;
            tapY = action.y;
          }
          if (tapX != null && tapY != null) {
            let closest = null, closestDist = Infinity;
            for (const el of latest.elements) {
              if (!el.frame) continue;
              const cx = el.frame.x + el.frame.width / 2;
              const cy = el.frame.y + el.frame.height / 2;
              const dist = Math.hypot(tapX - cx, tapY - cy);
              if (dist < closestDist) { closestDist = dist; closest = el; }
            }
            if (closest) {
              const label = closest.label || closest.title || closest.type || 'element';
              return `${gesture} "${label}"`;
            }
          }
        }
      } catch { /* fall through */ }
      return `${gesture} ${action.cell || `(${action.x},${action.y})`}`;
    }
    return gesture;
  },
  permission: 'use_mobile',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      element: { type: 'string', description: 'Label or visible text of the element to tap (BEST)' },
      cell: { type: 'string', description: 'Grid cell ID like "E12" from the grid overlay (GOOD)' },
      x: { type: 'number', description: 'X pixel coordinate (LAST RESORT)' },
      y: { type: 'number', description: 'Y pixel coordinate (LAST RESORT)' },
      gesture: { type: 'string', enum: ['tap', 'double', 'long'], description: 'Gesture type: "tap" (default), "double" (select text), "long" (context menu)' },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'mobile_tap', element: 'Settings' },
    { actionType: 'direct', intent: 'mobile_tap', cell: 'E12' },
    { actionType: 'direct', intent: 'mobile_tap', element: 'Search Field', gesture: 'double' },
    { actionType: 'direct', intent: 'mobile_tap', cell: 'L24', gesture: 'long' },
  ],

  async execute(action) {
    if (!action.element && !action.cell && (action.x == null || action.y == null)) {
      throw new Error('mobile_tap: provide "element" (label), "cell" (grid ID), or both "x" and "y" (coordinates).');
    }

    const driver = await getPlatform();
    const gesture = (action.gesture || 'tap').toLowerCase();

    // Option 1: Element label (best)
    if (action.element) {
      // Resilient element lookup: try fresh → retry once → fall back to cache.
      // IMPORTANT: do NOT invalidate cache before lookup — we need it as a fallback
      // if idb/adb fails transiently. Cache is invalidated AFTER the tap executes.
      let elements = [];
      try {
        elements = driver.getElementsAsync
          ? await driver.getElementsAsync()
          : driver.getElements();
      } catch {
        // idb/adb can fail transiently — retry once after a short pause
        await sleep(500);
        try {
          elements = driver.getElementsAsync
            ? await driver.getElementsAsync()
            : driver.getElements();
        } catch {
          // Still failing — fall back to cached elements, then frame-server elements
          try {
            elements = await getCachedElements(driver);
          } catch {
            elements = [];
          }
          // If cache is also empty, try frame-server (background capture keeps elements fresh)
          if (elements.length === 0) {
            const fsElements = getLatestElements();
            if (fsElements?.elements?.length > 0) {
              elements = fsElements.elements;
            }
          }
        }
      }
      const found = findElementByLabel(elements, action.element);

      if (!found) {
        const summary = formatElementsSummary(elements);
        return {
          success: false,
          error: `Element "${action.element}" not found on screen.` +
            (elements.length === 0 ? ' Element detection is temporarily unavailable — use cell="X#" or x/y coordinates instead.' : ''),
          availableElements: summary,
        };
      }

      const center = getElementCenter(found);
      if (!center) {
        return { success: false, error: `Element "${action.element}" found but has no coordinates.` };
      }

      invalidateElementsCache(); // UI will change after tap
      executeTapGesture(driver, 'points', center.x, center.y, gesture);
      // Longer delay for input fields (keyboard needs time to appear)
      const isInput = /text|input|search|field|email|password|url|query/i.test(found.type || '');
      await sleep(isInput ? 800 : 500);
      return { success: true, tapped: action.element, gesture, coordinates: center };
    }

    // Option 2: Grid cell (good)
    if (action.cell) {
      const cellId = action.cell.toUpperCase().trim();
      const frameInfo = getLastFrameInfo();

      if (!frameInfo || !frameInfo.gridCols) {
        return {
          success: false,
          error: 'No grid info available. Call mobile_observe first to capture a screenshot with grid overlay.',
        };
      }

      if (!isValidCell(cellId, frameInfo.gridCols, frameInfo.gridRows)) {
        return {
          success: false,
          error: `Invalid cell "${action.cell}". Grid is ${frameInfo.gridCols}x${frameInfo.gridRows} (columns A-X, rows 1-48).`,
        };
      }

      // Cell → pixel in resized image space
      const imgCoords = cellToCoordinates(cellId, frameInfo.imageWidth, frameInfo.imageHeight, frameInfo.gridCols, frameInfo.gridRows);
      if (!imgCoords) {
        return { success: false, error: `Could not convert cell "${action.cell}" to coordinates.` };
      }

      // Scale from resized image → original screenshot pixels
      const scaleX = (frameInfo.originalWidth || frameInfo.imageWidth) / frameInfo.imageWidth;
      const scaleY = (frameInfo.originalHeight || frameInfo.imageHeight) / frameInfo.imageHeight;
      const tapX = Math.round(imgCoords.x * scaleX);
      const tapY = Math.round(imgCoords.y * scaleY);

      invalidateElementsCache(); // UI will change after tap
      executeTapGesture(driver, 'pixels', tapX, tapY, gesture);
      await sleep(500);
      return { success: true, tapped: `cell ${cellId}`, gesture, coordinates: { x: tapX, y: tapY } };
    }

    // Option 3: Raw coordinates (last resort)
    invalidateElementsCache(); // UI will change after tap
    executeTapGesture(driver, 'pixels', action.x, action.y, gesture);
    await sleep(500);
    return { success: true, tapped: `(${action.x}, ${action.y})`, gesture };
  },
};

/**
 * Execute the appropriate tap gesture on the driver.
 * @param {object} driver - Platform driver
 * @param {'points'|'pixels'} coordType - Whether coords are logical points or pixels
 * @param {number} x
 * @param {number} y
 * @param {'tap'|'double'|'long'} gesture
 */
function executeTapGesture(driver, coordType, x, y, gesture) {
  if (gesture === 'double') {
    if (coordType === 'points' && driver.doubleTapPoints) {
      driver.doubleTapPoints(x, y);
    } else {
      driver.doubleTap(x, y);
    }
  } else if (gesture === 'long') {
    if (coordType === 'points' && driver.longPressPoints) {
      driver.longPressPoints(x, y);
    } else {
      driver.longPress(x, y);
    }
  } else {
    // Default tap
    if (coordType === 'points') {
      driver.tapPoints(x, y);
    } else {
      driver.tap(x, y);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
