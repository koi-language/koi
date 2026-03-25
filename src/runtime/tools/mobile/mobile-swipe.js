/**
 * Mobile Swipe Action — swipe on the mobile screen.
 *
 * Supports named directions, grid cells, or explicit coordinates.
 * Direction = finger movement direction:
 *   "down"  → finger moves down: center-30% → center+30%
 *   "up"    → finger moves up:   center+30% → center-30%
 *   "left"  → finger moves left: center+30% → center-30%
 *   "right" → finger moves right: center-30% → center+30%
 */

import { getPlatform, getLastFrameInfo, invalidateElementsCache } from '../../navigation/mobile/platform.js';
import { cellToCoordinates, isValidCell } from '../../navigation/mobile/grid-overlay.js';

export default {
  type: 'mobile_swipe',
  intent: 'mobile_swipe',
  description:
    'Swipe on the mobile screen (direction = finger movement). Three ways to specify (in order of preference): ' +
    '1. "direction" ("up", "down", "left", "right") — finger movement direction. "down" moves finger down (scrolls content up), "up" moves finger up (scrolls content down). ' +
    '2. "startCell","endCell" — grid cell IDs for precise swipes (e.g. startCell="F10", endCell="F30"). ' +
    '3. "startX","startY","endX","endY" — raw pixel coordinates. ' +
    '"duration" (optional, ms, default 300).',
  thinkingHint: (action) => `Swiping ${action.direction || action.startCell || 'custom'}`,
  permission: 'use_mobile',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Swipe direction (content perspective)',
      },
      startCell: { type: 'string', description: 'Starting grid cell ID like "F10" (PREFERRED for precise swipes)' },
      endCell: { type: 'string', description: 'Ending grid cell ID like "F30" (PREFERRED for precise swipes)' },
      startX: { type: 'number', description: 'Start X pixel coordinate' },
      startY: { type: 'number', description: 'Start Y pixel coordinate' },
      endX: { type: 'number', description: 'End X pixel coordinate' },
      endY: { type: 'number', description: 'End Y pixel coordinate' },
      duration: { type: 'number', description: 'Swipe duration in ms (default 300)' },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'mobile_swipe', direction: 'down' },
    { actionType: 'direct', intent: 'mobile_swipe', startCell: 'L10', endCell: 'L35' },
    { actionType: 'direct', intent: 'mobile_swipe', startX: 540, startY: 1800, endX: 540, endY: 600 },
  ],

  async execute(action) {
    const driver = await getPlatform();
    const duration = action.duration || 300;
    invalidateElementsCache(); // UI will change after swipe
    let sx, sy, ex, ey;
    let source = 'custom';

    // Option 1: Named direction
    if (action.direction) {
      const screen = driver.getScreenSize();
      const cx = screen.width / 2;
      const cy = screen.height / 2;
      const offsetX = screen.width * 0.3;
      const offsetY = screen.height * 0.3;

      switch (action.direction) {
        case 'down':
          sx = cx; sy = cy - offsetY;
          ex = cx; ey = cy + offsetY;
          break;
        case 'up':
          sx = cx; sy = cy + offsetY;
          ex = cx; ey = cy - offsetY;
          break;
        case 'left':
          sx = cx + offsetX; sy = cy;
          ex = cx - offsetX; ey = cy;
          break;
        case 'right':
          sx = cx - offsetX; sy = cy;
          ex = cx + offsetX; ey = cy;
          break;
        default:
          throw new Error(`mobile_swipe: unknown direction "${action.direction}". Use: up, down, left, right`);
      }
      source = action.direction;

    // Option 2: Grid cells
    } else if (action.startCell && action.endCell) {
      const startId = action.startCell.toUpperCase().trim();
      const endId = action.endCell.toUpperCase().trim();
      const frameInfo = getLastFrameInfo();

      if (!frameInfo || !frameInfo.gridCols) {
        throw new Error('No grid info available. Call mobile_observe first to capture a screenshot with grid overlay.');
      }

      if (!isValidCell(startId, frameInfo.gridCols, frameInfo.gridRows)) {
        return { success: false, error: `Invalid startCell "${action.startCell}". Grid is ${frameInfo.gridCols}x${frameInfo.gridRows}.` };
      }
      if (!isValidCell(endId, frameInfo.gridCols, frameInfo.gridRows)) {
        return { success: false, error: `Invalid endCell "${action.endCell}". Grid is ${frameInfo.gridCols}x${frameInfo.gridRows}.` };
      }

      const startPixel = cellToCoordinates(startId, frameInfo.imageWidth, frameInfo.imageHeight, frameInfo.gridCols, frameInfo.gridRows);
      const endPixel = cellToCoordinates(endId, frameInfo.imageWidth, frameInfo.imageHeight, frameInfo.gridCols, frameInfo.gridRows);

      if (!startPixel || !endPixel) {
        return { success: false, error: `Could not convert cells to coordinates.` };
      }

      // Scale from resized image → original screenshot pixels
      const scaleX = (frameInfo.originalWidth || frameInfo.imageWidth) / frameInfo.imageWidth;
      const scaleY = (frameInfo.originalHeight || frameInfo.imageHeight) / frameInfo.imageHeight;
      sx = Math.round(startPixel.x * scaleX);
      sy = Math.round(startPixel.y * scaleY);
      ex = Math.round(endPixel.x * scaleX);
      ey = Math.round(endPixel.y * scaleY);
      source = `${startId}->${endId}`;

    // Option 3: Raw coordinates
    } else if (action.startX != null && action.startY != null && action.endX != null && action.endY != null) {
      sx = action.startX; sy = action.startY;
      ex = action.endX; ey = action.endY;

    } else {
      throw new Error('mobile_swipe: provide "direction", "startCell"+"endCell", or "startX"+"startY"+"endX"+"endY".');
    }

    driver.swipe(sx, sy, ex, ey, duration);
    await sleep(300);
    return { success: true, swipe: source, duration };
  },
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
