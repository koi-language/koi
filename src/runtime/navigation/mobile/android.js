/**
 * Android Emulator Platform Driver
 *
 * Uses ADB for all interactions. Coordinates are always in pixels (no scaling needed).
 * UI elements are parsed from uiautomator XML dump using regex (no external XML parser).
 *
 * Requirements:
 *   - Android SDK installed
 *   - ADB available in PATH or standard SDK locations
 *   - An emulator running (or physical device connected)
 */

import { execSync, exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export class AndroidPlatform {
  constructor() {
    this.type = 'android';
    this.adbPath = null;
    this.deviceId = null;
  }

  async init() {
    this.adbPath = findAdbPath();
    this.deviceId = findDevice(this.adbPath);
    if (!this.deviceId) {
      throw new Error(
        'No Android device/emulator found.\n' +
        '  emulator -avd <name>\n' +
        '  adb devices  # should list a device'
      );
    }
  }

  /**
   * Capture a PNG screenshot.
   * @returns {Buffer}
   */
  screenshot() {
    try {
      const buffer = execSync(`${this.adbPath} -s ${this.deviceId} exec-out screencap -p`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 20 * 1024 * 1024,
        timeout: 15000,
      });
      return buffer;
    } catch (err) {
      throw new Error(`Android screenshot failed: ${err.message}`);
    }
  }

  /**
   * Capture a PNG screenshot asynchronously (non-blocking).
   * @returns {Promise<Buffer>}
   */
  screenshotAsync() {
    return new Promise((resolve, reject) => {
      exec(`${this.adbPath} -s ${this.deviceId} exec-out screencap -p`, {
        encoding: 'buffer',
        maxBuffer: 20 * 1024 * 1024,
        timeout: 15000,
      }, (err, stdout) => {
        if (err) reject(new Error(`Android async screenshot failed: ${err.message}`));
        else resolve(stdout);
      });
    });
  }

  /**
   * Get all UI elements by dumping and parsing the uiautomator XML.
   * @returns {Array<{ type, text, label, identifier, x, y, width, height }>}
   */
  getElements() {
    try {
      // Dump UI hierarchy to device storage
      execSync(`${this.adbPath} -s ${this.deviceId} shell uiautomator dump /sdcard/ui_dump.xml`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      });

      // Read the dump
      const xml = execSync(`${this.adbPath} -s ${this.deviceId} shell cat /sdcard/ui_dump.xml`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
        maxBuffer: 10 * 1024 * 1024,
      });

      return parseUiAutomatorXml(xml);
    } catch (err) {
      throw new Error(`Android getElements failed: ${err.message}`);
    }
  }

  /**
   * Get all UI elements asynchronously (non-blocking).
   * @returns {Promise<Array<{ type, text, label, identifier, x, y, width, height }>>}
   */
  getElementsAsync() {
    const adbPath = this.adbPath;
    const deviceId = this.deviceId;
    return new Promise((resolve, reject) => {
      // Step 1: dump UI hierarchy
      exec(`${adbPath} -s ${deviceId} shell uiautomator dump /sdcard/ui_dump.xml`, {
        timeout: 15000,
      }, (err) => {
        if (err) { reject(new Error(`Android getElements dump failed: ${err.message}`)); return; }
        // Step 2: read the dump
        exec(`${adbPath} -s ${deviceId} shell cat /sdcard/ui_dump.xml`, {
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 10 * 1024 * 1024,
        }, (err2, stdout) => {
          if (err2) { reject(new Error(`Android getElements read failed: ${err2.message}`)); return; }
          try {
            resolve(parseUiAutomatorXml(stdout));
          } catch (parseErr) {
            reject(new Error(`Android getElements parse failed: ${parseErr.message}`));
          }
        });
      });
    });
  }

  /**
   * Tap at pixel coordinates (no scaling needed on Android).
   */
  tap(x, y) {
    execSync(`${this.adbPath} -s ${this.deviceId} shell input tap ${Math.round(x)} ${Math.round(y)}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
  }

  /**
   * Tap at point coordinates (same as tap on Android — no scaling needed).
   */
  tapPoints(x, y) {
    this.tap(x, y);
  }

  /**
   * Double tap at point coordinates (same as doubleTap on Android).
   */
  doubleTapPoints(x, y) {
    this.doubleTap(x, y);
  }

  /**
   * Long press at point coordinates (same as longPress on Android).
   */
  longPressPoints(x, y, durationMs = 1000) {
    this.longPress(x, y, durationMs);
  }

  /**
   * Double tap at pixel coordinates.
   */
  doubleTap(x, y) {
    const rx = Math.round(x);
    const ry = Math.round(y);
    execSync(`${this.adbPath} -s ${this.deviceId} shell input tap ${rx} ${ry}`, {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    execSync(`${this.adbPath} -s ${this.deviceId} shell input tap ${rx} ${ry}`, {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
  }

  /**
   * Long press at pixel coordinates.
   */
  longPress(x, y, durationMs = 1000) {
    const rx = Math.round(x);
    const ry = Math.round(y);
    // ADB: swipe from same point to same point with duration = long press
    execSync(`${this.adbPath} -s ${this.deviceId} shell input swipe ${rx} ${ry} ${rx} ${ry} ${durationMs}`, {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 + durationMs,
    });
  }

  /**
   * Type text. By default clears existing input first.
   *
   * For ASCII-only text, uses `adb shell input text` with percent-encoding.
   * For non-ASCII text (accents, CJK, emoji), uses clipboard paste because
   * `adb shell input text` does not reliably handle multi-byte UTF-8 —
   * it writes literal `%C3%B3` instead of `ó` on most Android versions.
   */
  typeText(text, { clear = true } = {}) {
    if (clear) this.clearInput();

    // Non-ASCII → clipboard paste (like iOS does)
    if (/[^\x00-\x7F]/.test(text)) {
      this._pasteText(text);
      return;
    }

    const encoded = _adbEncodeText(text);
    execSync(`${this.adbPath} -s ${this.deviceId} shell input text '${encoded}'`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
  }

  /**
   * Paste text via Android emulator clipboard (handles any Unicode).
   * Used for non-ASCII text (accents, CJK, emoji) since `adb shell input text`
   * only handles ASCII reliably.
   *
   * Strategy (tried in order):
   * 1. `adb emu clipboard paste` — works on all Android Emulator instances
   * 2. Fallback: split text into ASCII/non-ASCII segments, type ASCII normally,
   *    skip or approximate non-ASCII.
   */
  _pasteText(text) {
    try {
      // The Android Emulator exposes a telnet-like console via `adb emu`.
      // `adb emu clipboard set <text>` sets the emulator clipboard directly
      // (not the Android OS clipboard — the emulator's own clipboard).
      // Then KEYCODE_PASTE (279) pastes into the focused field.
      //
      // Write text to a temp file and pipe to avoid shell escaping issues.
      const localTmp = path.join(os.tmpdir(), '_koi_clip.txt');
      fs.writeFileSync(localTmp, text, 'utf8');

      // Use adb push + shell to set clipboard from file content
      const deviceTmp = '/data/local/tmp/_koi_clip.txt';
      execSync(`${this.adbPath} -s ${this.deviceId} push "${localTmp}" ${deviceTmp}`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      try { fs.unlinkSync(localTmp); } catch { /* non-fatal */ }

      // Set clipboard via Android's `cmd clipboard` (API 29+) or `am` approach.
      // Try multiple methods — emulator versions vary.
      let clipboardSet = false;

      // Method 1: `cmd clipboard set` (Android 10+ / API 29+)
      if (!clipboardSet) {
        try {
          execSync(
            `${this.adbPath} -s ${this.deviceId} shell "cmd clipboard set_text \\"$(cat ${deviceTmp})\\""`,
            { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
          );
          clipboardSet = true;
        } catch { /* not available on this API level */ }
      }

      // Method 2: Write to clipboard via Android broadcast + Clipper app
      if (!clipboardSet) {
        try {
          execSync(
            `${this.adbPath} -s ${this.deviceId} shell "am broadcast -a clipper.set -e text \\"$(cat ${deviceTmp})\\" 2>/dev/null"`,
            { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
          );
          clipboardSet = true;
        } catch { /* Clipper not available */ }
      }

      // Method 3: Split into ASCII + non-ASCII segments, type ASCII parts,
      // and for non-ASCII characters use input text with individual char encoding
      if (!clipboardSet) {
        try {
          execSync(`${this.adbPath} -s ${this.deviceId} shell rm -f ${deviceTmp}`, {
            stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000,
          });
        } catch { /* non-fatal */ }
        // Fallback: type with encoding — imperfect but better than nothing
        const encoded = _adbEncodeText(text);
        execSync(`${this.adbPath} -s ${this.deviceId} shell input text '${encoded}'`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });
        return;
      }

      // Paste via KEYCODE_PASTE (279)
      execSync(`${this.adbPath} -s ${this.deviceId} shell input keyevent 279`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });

      // Clean up temp file
      try {
        execSync(`${this.adbPath} -s ${this.deviceId} shell rm -f ${deviceTmp}`, {
          stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000,
        });
      } catch { /* non-fatal */ }
    } catch {
      // Last resort fallback — type with encoding
      try {
        const encoded = _adbEncodeText(text);
        execSync(`${this.adbPath} -s ${this.deviceId} shell input text '${encoded}'`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });
      } catch { /* nothing more we can do */ }
    }
  }

  /**
   * Swipe from (sx,sy) to (ex,ey) in pixels.
   */
  swipe(sx, sy, ex, ey, durationMs = 300) {
    execSync(
      `${this.adbPath} -s ${this.deviceId} shell input swipe ${Math.round(sx)} ${Math.round(sy)} ${Math.round(ex)} ${Math.round(ey)} ${durationMs}`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
    );
  }

  /**
   * Send a special key.
   */
  sendKey(key) {
    const keycodeMap = {
      enter: 'KEYCODE_ENTER',
      back: 'KEYCODE_BACK',
      home: 'KEYCODE_HOME',
      delete: 'KEYCODE_DEL',
      tab: 'KEYCODE_TAB',
    };
    const keycode = keycodeMap[key.toLowerCase()];
    if (!keycode) {
      throw new Error(`Android sendKey: unsupported key "${key}". Use: enter, back, home, delete, tab`);
    }
    execSync(`${this.adbPath} -s ${this.deviceId} shell input keyevent ${keycode}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
  }

  /**
   * Clear current text input by pressing delete 30 times.
   */
  clearInput() {
    for (let i = 0; i < 30; i++) {
      try {
        execSync(`${this.adbPath} -s ${this.deviceId} shell input keyevent 67`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        });
      } catch { break; }
    }
  }

  /**
   * Get screen size in pixels.
   */
  getScreenSize() {
    try {
      const out = execSync(`${this.adbPath} -s ${this.deviceId} shell wm size`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      const match = out.match(/(\d+)x(\d+)/);
      if (match) {
        return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
      }
    } catch { /* fallback */ }
    return { width: 1080, height: 2400 };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Encode text for `adb shell input text`.
 *
 * ADB conventions:
 *   - Space → `%s`
 *   - ASCII printable (except shell-special) → literal
 *   - Everything else (accented chars, CJK, emoji) → percent-encode each
 *     UTF-8 byte as `%XX`
 *
 * Shell-special characters (' " ` \ $ ! & | ; ( ) < > { } # ~ ? * [ ])
 * are also percent-encoded so we can safely wrap the whole thing in single
 * quotes without further escaping.
 */
function _adbEncodeText(text) {
  // Characters that are safe to pass as-is inside single-quoted ADB command.
  // Letters, digits, and a small set of punctuation that doesn't collide with
  // ADB's own % syntax or the shell.
  const SAFE = /^[A-Za-z0-9\-_.,:+=@/]$/;
  let out = '';
  const buf = Buffer.from(text, 'utf8');
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    const ch = String.fromCharCode(byte);
    if (byte === 0x20) {
      out += '%s';                         // ADB space convention
    } else if (byte < 0x80 && SAFE.test(ch)) {
      out += ch;                           // safe ASCII literal
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/**
 * Find ADB binary path, checking standard SDK locations then PATH.
 */
function findAdbPath() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),       // macOS
    path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'),                  // Linux
    path.join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'), // Windows
    '/usr/local/bin/adb',
    '/usr/bin/adb',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Try from PATH
  try {
    execSync('adb version', {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return 'adb';
  } catch { /* not in PATH */ }

  return 'adb'; // fallback, may fail at usage time with a clear error
}

/**
 * Find the first connected device/emulator.
 */
function findDevice(adbPath) {
  try {
    const out = execSync(`${adbPath} devices`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    const lines = out.split('\n').filter(l => l.includes('\tdevice'));
    if (lines.length > 0) {
      return lines[0].split('\t')[0].trim();
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Parse uiautomator XML dump using regex (no external XML parser).
 * Extracts node attributes: text, content-desc, resource-id, class, bounds.
 */
function parseUiAutomatorXml(xml) {
  const elements = [];
  const nodeRegex = /<node\s([^>]+)/g;
  let match;

  while ((match = nodeRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const text = extractAttr(attrs, 'text');
    const label = extractAttr(attrs, 'content-desc');
    const identifier = extractAttr(attrs, 'resource-id');
    const type = extractAttr(attrs, 'class');
    const bounds = extractAttr(attrs, 'bounds');

    if ((!text && !label && !identifier) || !bounds) continue;

    const boundsMatch = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!boundsMatch) continue;

    const x1 = parseInt(boundsMatch[1], 10);
    const y1 = parseInt(boundsMatch[2], 10);
    const x2 = parseInt(boundsMatch[3], 10);
    const y2 = parseInt(boundsMatch[4], 10);

    elements.push({
      type: type || '',
      text: text || '',
      label: label || '',
      identifier: identifier || '',
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
    });
  }

  return elements;
}

/**
 * Extract an XML attribute value from a string of attributes.
 */
function extractAttr(attrs, name) {
  const regex = new RegExp(`${name}="([^"]*)"`, 'i');
  const match = attrs.match(regex);
  return match ? match[1] : '';
}
