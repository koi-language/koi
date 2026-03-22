/**
 * Screenshot Action - Capture screenshots from multiple platforms.
 *
 * Supported sources:
 *   - ios_simulator:    xcrun simctl io booted screenshot (requires Xcode + booted sim)
 *   - android_emulator: adb exec-out screencap -p (requires Android SDK + running emulator)
 *   - browser:          Playwright page.screenshot() (requires playwright installed)
 *   - screen:           Native screen capture (screencapture on macOS, scrot/import on Linux)
 *
 * Auto-detects the best source when not specified.
 * Images are persisted in the session via sessionTracker.storeImage() and
 * returned in MCP content format so the LLM can see them via the existing
 * _pendingMcpImages pipeline.
 */

import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cliLogger } from '../cli-logger.js';
import { sessionTracker } from '../session-tracker.js';

// ─── Platform capture functions ────────────────────────────────────────

function captureIosSimulator() {
  const tmp = path.join(os.tmpdir(), `koi-screenshot-${Date.now()}.png`);
  try {
    execFileSync('xcrun', ['simctl', 'io', 'booted', 'screenshot', '--type=png', tmp], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    const buffer = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return buffer;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(
      `iOS Simulator screenshot failed: ${err.message}\n` +
      'Make sure Xcode is installed and a Simulator is booted:\n' +
      '  open -a Simulator\n' +
      '  xcrun simctl boot <device-id>'
    );
  }
}

function captureAndroidEmulator() {
  try {
    const buffer = execFileSync('adb', ['exec-out', 'screencap', '-p'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15000,
    });
    return buffer;
  } catch (err) {
    throw new Error(
      `Android emulator screenshot failed: ${err.message}\n` +
      'Make sure Android SDK is installed and an emulator is running:\n' +
      '  adb devices   # should list an emulator\n' +
      '  emulator -avd <name>'
    );
  }
}

async function captureBrowser(url) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error(
      'Playwright is not installed. Install it with:\n' +
      '  npm install playwright\n' +
      '  npx playwright install chromium'
    );
  }
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    return Buffer.from(buffer);
  } finally {
    await browser.close();
  }
}

function captureScreen() {
  const platform = os.platform();
  const tmp = path.join(os.tmpdir(), `koi-screenshot-${Date.now()}.png`);

  try {
    if (platform === 'darwin') {
      execFileSync('screencapture', ['-x', tmp], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      });
    } else if (platform === 'linux') {
      // Try scrot first, then import (ImageMagick)
      try {
        execFileSync('scrot', [tmp], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });
      } catch {
        execFileSync('import', ['-window', 'root', tmp], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 15000,
        });
      }
    } else {
      throw new Error(`Screen capture is not supported on ${platform}`);
    }

    const buffer = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return buffer;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (err.message.includes('not supported')) throw err;
    throw new Error(
      `Screen capture failed: ${err.message}\n` +
      (platform === 'linux'
        ? 'Install scrot or ImageMagick: sudo apt install scrot'
        : '')
    );
  }
}

// ─── Auto-detection ────────────────────────────────────────────────────

function detectSource() {
  // Check iOS Simulator
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    if (out.includes('Booted')) return 'ios_simulator';
  } catch { /* not available */ }

  // Check Android emulator
  try {
    const out = execFileSync('adb', ['devices'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    const lines = out.split('\n').filter(l => l.includes('emulator') && l.includes('device'));
    if (lines.length > 0) return 'android_emulator';
  } catch { /* not available */ }

  // Fallback: screen capture
  return 'screen';
}

// ─── Action definition ─────────────────────────────────────────────────

export default {
  type: 'screenshot',
  intent: 'screenshot',
  description: 'Capture a screenshot from a running app, simulator, emulator, or screen. '
    + 'Fields: "source" (optional: "ios_simulator", "android_emulator", "browser", "screen" — auto-detects if omitted), '
    + '"url" (optional: URL for browser screenshots), '
    + '"description" (optional: text description for later recall). '
    + 'Returns: { imageId, source, content: [image, text] }',
  instructions: 'screenshot captures the LIVE SCREEN (desktop, simulator, browser). It is NOT for reading image files from disk. To read an image file (.png, .jpg, etc.), use read_file instead.',
  thinkingHint: (action) => `Capturing screenshot${action.source ? ` (${action.source})` : ''}`,
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        enum: ['ios_simulator', 'android_emulator', 'browser', 'screen'],
        description: 'Screenshot source. Auto-detected if omitted.',
      },
      url: {
        type: 'string',
        description: 'URL for browser screenshots (requires Playwright).',
      },
      description: {
        type: 'string',
        description: 'Description of what this screenshot shows, for later recall.',
      },
    },
  },

  examples: [
    { actionType: 'direct', intent: 'screenshot' },
    { actionType: 'direct', intent: 'screenshot', source: 'ios_simulator', description: 'Login screen after CSS fix' },
    { actionType: 'direct', intent: 'screenshot', source: 'browser', url: 'http://localhost:3000', description: 'Homepage' },
  ],

  async execute(action) {
    const source = action.source || detectSource();
    const description = action.description || '';

    cliLogger.log('screenshot', `Capturing from: ${source}`);

    // Capture the screenshot
    let buffer;
    switch (source) {
      case 'ios_simulator':
        buffer = captureIosSimulator();
        break;
      case 'android_emulator':
        buffer = captureAndroidEmulator();
        break;
      case 'browser': {
        const url = action.url;
        if (!url) throw new Error('screenshot: "url" is required when source is "browser"');
        buffer = await captureBrowser(url);
        break;
      }
      case 'screen':
        buffer = captureScreen();
        break;
      default:
        throw new Error(`screenshot: unknown source "${source}". Use: ios_simulator, android_emulator, browser, screen`);
    }

    // Persist in session
    let imageId = null;
    if (sessionTracker) {
      imageId = sessionTracker.storeImage(buffer, { source, description, mimeType: 'image/png' });
      cliLogger.log('screenshot', `Stored as ${imageId}`);
    } else {
      cliLogger.log('screenshot', 'No session tracker — image not persisted');
    }

    // Return MCP content format (consumed by classifyFeedback → _pendingMcpImages pipeline)
    const base64 = buffer.toString('base64');
    return {
      imageId: imageId || 'ephemeral',
      source,
      content: [
        { type: 'image', data: base64, mimeType: 'image/png' },
        { type: 'text', text: `Screenshot captured from ${source}${imageId ? ` (${imageId})` : ''}${description ? ': ' + description : ''}` },
      ],
    };
  },
};
