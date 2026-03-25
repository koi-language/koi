/**
 * iOS Simulator Platform Driver
 *
 * Uses xcrun simctl (screenshots) + Facebook IDB (interactions + accessibility tree).
 * Coordinate system: IDB expects logical points, not pixels.
 *   points = pixels / scaleFactor (2x or 3x for modern iPhones)
 *
 * Requirements:
 *   - Xcode installed
 *   - brew install idb-companion
 *   - pip install fb-idb (or pip3 install fb-idb)
 */

import { execFileSync, execSync, execFile, exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export class IosPlatform {
  constructor() {
    this.type = 'ios';
    this.udid = null;
    this.scaleFactor = 3; // default for modern iPhones
    this.logicalSize = null;
    this._reconnecting = false;
  }

  async init() {
    this.udid = findBootedUdid();
    if (!this.udid) {
      throw new Error(
        'No booted iOS Simulator found.\n' +
        '  open -a Simulator\n' +
        '  xcrun simctl boot <device-id>'
      );
    }
    await this._detectScale();
    // Ensure idb-companion is connected to this device
    this._connectIdb();
  }

  /**
   * Connect idb-companion to the simulator.
   * This is idempotent — if already connected, it's a no-op.
   */
  _connectIdb() {
    try {
      execSync(`idb connect ${this.udid}`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
    } catch { /* best effort — idb may auto-connect */ }
  }

  /**
   * Force-reconnect idb-companion after a "Mach port invalid" error.
   * A simple `idb connect` is not enough — the companion daemon has a
   * stale Mach port and must be fully restarted:
   *   1. Disconnect the stale session
   *   2. Kill the idb_companion process for this device
   *   3. Wait for cleanup
   *   4. Reconnect fresh
   */
  _forceReconnectIdb() {
    if (process.env.KOI_DEBUG_LLM) {
      console.error('[iOS] 🔧 Force-reconnecting idb (kill companion + reconnect)...');
    }
    // 1. Disconnect stale session
    try {
      execSync(`idb disconnect ${this.udid}`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
    } catch { /* may already be disconnected */ }
    // 2. Kill idb_companion processes (they hold the stale Mach ports)
    try {
      execSync(`pkill -f "idb_companion.*${this.udid}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
    } catch { /* no matching process — ok */ }
    // Also try killing all companions (some setups use a single daemon)
    try {
      execSync(`pkill -f idb_companion`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
    } catch { /* ok */ }
    // 3. Wait for process cleanup (sync delay)
    const _end = Date.now() + 1000;
    while (Date.now() < _end) { /* busy-wait 1s for companion to die */ }
    // 4. Fresh connect
    this._connectIdb();
  }

  /**
   * Detect "Mach port invalid" / "device disconnected" errors from idb
   * and attempt to reconnect. Returns true if the error is a disconnect.
   */
  _isDisconnectError(err) {
    const msg = (err?.message || '') + (err?.stderr?.toString?.() || '');
    return /mach port invalid|device disconnected|not connected/i.test(msg);
  }

  /**
   * Attempt to reconnect to the iOS Simulator after a disconnect.
   * Re-detects the UDID (in case the simulator was restarted) and reconnects idb.
   * Returns true if reconnection succeeded.
   */
  async _reconnect() {
    if (this._reconnecting) return false;
    this._reconnecting = true;
    try {
      if (process.env.KOI_DEBUG_LLM) {
        console.error('[iOS] 🔄 Attempting to reconnect idb...');
      }
      // Re-detect UDID in case the simulator was restarted
      const newUdid = findBootedUdid();
      if (!newUdid) {
        if (process.env.KOI_DEBUG_LLM) {
          console.error('[iOS] ❌ No booted simulator found during reconnect');
        }
        return false;
      }
      this.udid = newUdid;
      // Reconnect idb-companion
      this._connectIdb();
      // Verify connection works with a simple describe call
      execSync(`idb describe --udid ${this.udid}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      if (process.env.KOI_DEBUG_LLM) {
        console.error('[iOS] ✅ Reconnected to simulator %s', this.udid);
      }
      return true;
    } catch (e) {
      if (process.env.KOI_DEBUG_LLM) {
        console.error('[iOS] ❌ Reconnect failed: %s', e.message);
      }
      return false;
    } finally {
      this._reconnecting = false;
    }
  }

  /**
   * Run an IDB command synchronously with auto-reconnect on disconnect.
   * If the command fails with "Mach port invalid" / "device disconnected",
   * reconnects idb-companion and retries once.
   */
  _idbSync(cmd, opts = {}) {
    try {
      return execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, ...opts });
    } catch (err) {
      if (this._isDisconnectError(err)) {
        if (process.env.KOI_DEBUG_LLM) {
          console.error('[iOS] 🔄 idb disconnected, force-reconnecting...');
        }
        // Re-detect UDID + force-restart companion + reconnect
        const newUdid = findBootedUdid();
        if (newUdid) {
          this.udid = newUdid;
          this._forceReconnectIdb();
          // Rebuild command with new UDID if it contained the old one
          const updatedCmd = cmd.replace(/--udid\s+\S+/, `--udid ${this.udid}`);
          return execSync(updatedCmd, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, ...opts });
        }
      }
      throw err;
    }
  }

  /**
   * Run an IDB command asynchronously with auto-reconnect on disconnect.
   */
  _idbAsync(cmd, opts = {}) {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: 30000, ...opts }, (err, stdout, stderr) => {
        if (err && this._isDisconnectError(err)) {
          if (process.env.KOI_DEBUG_LLM) {
            console.error('[iOS] 🔄 idb disconnected (async), force-reconnecting...');
          }
          const newUdid = findBootedUdid();
          if (newUdid) {
            this.udid = newUdid;
            this._forceReconnectIdb();
            const updatedCmd = cmd.replace(/--udid\s+\S+/, `--udid ${this.udid}`);
            exec(updatedCmd, { timeout: 30000, ...opts }, (err2, stdout2) => {
              if (err2) reject(err2);
              else resolve(stdout2);
            });
            return;
          }
        }
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  /**
   * Capture a PNG screenshot of the booted simulator.
   * @returns {Buffer}
   */
  screenshot() {
    const tmp = path.join(os.tmpdir(), `koi-ios-ss-${Date.now()}.png`);
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
      throw new Error(`iOS screenshot failed: ${err.message}`);
    }
  }

  /**
   * Capture a PNG screenshot asynchronously (non-blocking).
   * Pipes directly to stdout instead of using a temp file.
   * @returns {Promise<Buffer>}
   */
  screenshotAsync() {
    return new Promise((resolve, reject) => {
      execFile('xcrun', ['simctl', 'io', 'booted', 'screenshot', '--type=png', '-'], {
        encoding: 'buffer',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 15000,
      }, (err, stdout) => {
        if (err) reject(new Error(`iOS async screenshot failed: ${err.message}`));
        else resolve(stdout);
      });
    });
  }

  /**
   * Get all UI elements from the accessibility tree via IDB.
   * @returns {Array<{ type, text, label, identifier, x, y, width, height }>}
   */
  getElements() {
    try {
      const raw = this._idbSync(`idb ui describe-all --json --udid ${this.udid}`, {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const hierarchy = JSON.parse(raw);
      const elements = [];
      this._parseHierarchy(hierarchy, elements);
      return elements;
    } catch (err) {
      throw new Error(
        `iOS getElements failed: ${err.message}\n` +
        'Make sure idb is installed:\n' +
        '  brew install idb-companion\n' +
        '  pip3 install fb-idb'
      );
    }
  }

  /**
   * Get all UI elements asynchronously (non-blocking).
   * @returns {Promise<Array<{ type, text, label, identifier, x, y, width, height }>>}
   */
  async getElementsAsync() {
    try {
      const stdout = await this._idbAsync(`idb ui describe-all --json --udid ${this.udid}`, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
      const hierarchy = JSON.parse(stdout);
      const elements = [];
      this._parseHierarchy(hierarchy, elements);
      return elements;
    } catch (err) {
      throw new Error(`iOS getElements failed: ${err.message}`);
    }
  }

  /**
   * Tap at pixel coordinates (converted to logical points).
   */
  tap(x, y) {
    const px = Math.round(x / this.scaleFactor);
    const py = Math.round(y / this.scaleFactor);
    this._idbSync(`idb ui tap ${px} ${py} --udid ${this.udid}`);
  }

  /**
   * Tap at logical point coordinates (no scaling).
   */
  tapPoints(px, py) {
    this._idbSync(`idb ui tap ${Math.round(px)} ${Math.round(py)} --udid ${this.udid}`);
  }

  /**
   * Double tap at pixel coordinates (converted to logical points).
   */
  doubleTap(x, y) {
    const px = Math.round(x / this.scaleFactor);
    const py = Math.round(y / this.scaleFactor);
    this._idbSync(`idb ui tap ${px} ${py} --udid ${this.udid}`);
    this._idbSync(`idb ui tap ${px} ${py} --udid ${this.udid}`);
  }

  /**
   * Double tap at logical point coordinates (no scaling).
   */
  doubleTapPoints(px, py) {
    const x = Math.round(px);
    const y = Math.round(py);
    this._idbSync(`idb ui tap ${x} ${y} --udid ${this.udid}`);
    this._idbSync(`idb ui tap ${x} ${y} --udid ${this.udid}`);
  }

  /**
   * Long press at pixel coordinates (converted to logical points).
   */
  longPress(x, y, durationMs = 1000) {
    const px = Math.round(x / this.scaleFactor);
    const py = Math.round(y / this.scaleFactor);
    const sec = (durationMs / 1000).toFixed(2);
    this._idbSync(`idb ui tap ${px} ${py} --duration ${sec} --udid ${this.udid}`, {
      timeout: 10000 + durationMs,
    });
  }

  /**
   * Long press at logical point coordinates (no scaling).
   */
  longPressPoints(px, py, durationMs = 1000) {
    const sec = (durationMs / 1000).toFixed(2);
    this._idbSync(`idb ui tap ${Math.round(px)} ${Math.round(py)} --duration ${sec} --udid ${this.udid}`, {
      timeout: 10000 + durationMs,
    });
  }

  /**
   * Type text. By default clears existing input first.
   * Uses clipboard paste for non-ASCII text (ó, ñ, é, ü, etc.) since idb
   * only supports ASCII HID keycodes. Falls back to clipboard for any idb failure.
   */
  typeText(text, { clear = true } = {}) {
    if (clear) this.clearInput();

    // Fast path: if text contains non-ASCII, skip idb entirely → clipboard paste
    if (/[^\x00-\x7F]/.test(text)) {
      this._pasteText(text);
      return;
    }

    const escaped = text.replace(/"/g, '\\"');
    try {
      this._idbSync(`idb ui text "${escaped}" --udid ${this.udid}`);
    } catch {
      // idb failed for some other reason → clipboard fallback
      this._pasteText(text);
    }
  }

  /**
   * Paste text via simulator clipboard (handles any Unicode).
   * Used as fallback when idb can't type non-ASCII chars (ó, ñ, é, ü, etc.).
   * 1. Copy text to simulated pasteboard via xcrun simctl pbcopy
   * 2. Simulate Cmd+V via AppleScript System Events
   */
  _pasteText(text) {
    // Put text in the simulator's pasteboard (stdin avoids shell escaping issues)
    execSync(`xcrun simctl pbcopy ${this.udid}`, {
      input: text,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    // Cmd+V paste via AppleScript — works with any Unicode content
    execSync(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
  }

  /**
   * Swipe from (sx,sy) to (ex,ey) in pixels (converted to points).
   */
  swipe(sx, sy, ex, ey, durationMs = 300) {
    const psx = Math.round(sx / this.scaleFactor);
    const psy = Math.round(sy / this.scaleFactor);
    const pex = Math.round(ex / this.scaleFactor);
    const pey = Math.round(ey / this.scaleFactor);
    const sec = (durationMs / 1000).toFixed(2);
    this._idbSync(
      `idb ui swipe ${psx} ${psy} ${pex} ${pey} --duration ${sec} --udid ${this.udid}`,
    );
  }

  /**
   * Send a special key.
   */
  sendKey(key) {
    const k = key.toLowerCase();
    switch (k) {
      case 'home': {
        // Send Cmd+Shift+H to iOS Simulator via AppleScript — the standard Home shortcut.
        // This is more reliable than idb swipe gestures (which are in-app, not system gestures)
        // and idb key events (wrong keycode for Home hardware button).
        try {
          execSync(
            `osascript -e 'tell application "Simulator" to activate' -e 'delay 0.2' -e 'tell application "System Events" to keystroke "h" using {command down, shift down}'`,
            { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
          );
        } catch {
          // Fallback: try idb swipe from bottom edge
          const homeH = this.logicalSize ? this.logicalSize.height : 844;
          const centerX = Math.round((this.logicalSize?.width || 390) / 2);
          try {
            this._idbSync(
              `idb ui swipe ${centerX} ${homeH - 5} ${centerX} ${Math.round(homeH * 0.10)} --duration 0.25 --udid ${this.udid}`,
            );
          } catch { /* best effort */ }
        }
        break;
      }
      case 'back': {
        // Swipe from left edge to simulate back navigation
        const midY = this.logicalSize ? Math.round(this.logicalSize.height / 2) : 400;
        this._idbSync(
          `idb ui swipe 5 ${midY} 150 ${midY} --duration 0.25 --udid ${this.udid}`,
        );
        break;
      }
      case 'enter':
        this._idbSync(`idb ui key 40 --udid ${this.udid}`);
        break;
      case 'delete':
        this._idbSync(`idb ui key 42 --udid ${this.udid}`);
        break;
      case 'tab':
        this._idbSync(`idb ui key 43 --udid ${this.udid}`);
        break;
      default:
        throw new Error(`iOS sendKey: unsupported key "${key}". Use: home, back, enter, delete, tab`);
    }
  }

  /**
   * Clear current text input via Cmd+A (select all) + Delete.
   * Much faster than pressing delete 30 times individually (~0.2s vs ~6s).
   */
  clearInput() {
    try {
      // Cmd+A to select all text in the focused field
      execSync(`osascript -e 'tell application "System Events" to keystroke "a" using command down'`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      // Single delete to remove selected text
      this._idbSync(`idb ui key 42 --udid ${this.udid}`, { timeout: 5000 });
    } catch {
      // Fallback: press delete a few times if Cmd+A fails
      for (let i = 0; i < 10; i++) {
        try {
          this._idbSync(`idb ui key 42 --udid ${this.udid}`, { timeout: 5000 });
        } catch { break; }
      }
    }
  }

  /**
   * Get screen size in pixels.
   */
  getScreenSize() {
    if (this.logicalSize) {
      return {
        width: this.logicalSize.width * this.scaleFactor,
        height: this.logicalSize.height * this.scaleFactor,
      };
    }
    // Fallback: iPhone 14 @3x
    return { width: 1170, height: 2532 };
  }

  // ─── Private ─────────────────────────────────────────────────────────

  /**
   * Detect scale factor from IDB describe output.
   */
  async _detectScale() {
    try {
      const raw = execSync(`idb describe --json --udid ${this.udid}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      const info = JSON.parse(raw);

      // Get logical screen size from device name
      const deviceName = info.name || '';
      this.logicalSize = getLogicalSize(deviceName);

      // Try to compute scale from screen_dimensions
      if (info.screen_dimensions) {
        const pixelWidth = info.screen_dimensions.width;
        if (pixelWidth && this.logicalSize) {
          const raw = pixelWidth / this.logicalSize.width;
          this.scaleFactor = Math.max(1, Math.min(3, Math.round(raw)));
        }
      }
    } catch {
      // Defaults are fine (3x scale)
    }
  }

  /**
   * Recursively parse IDB accessibility hierarchy into flat element list.
   */
  _parseHierarchy(node, elements) {
    if (!node) return;

    // Process arrays (top-level can be an array)
    if (Array.isArray(node)) {
      for (const child of node) this._parseHierarchy(child, elements);
      return;
    }

    const type = node.type || node.AXRole || '';
    const text = node.title || node.AXTitle || node.value || node.AXValue || '';
    const label = node.label || node.AXLabel || node.AXDescription || '';
    const identifier = node.identifier || node.AXIdentifier || '';
    const frame = node.frame;

    if ((text || label || identifier) && frame) {
      elements.push({
        type,
        text: String(text),
        label: String(label),
        identifier: String(identifier),
        x: frame.x || 0,
        y: frame.y || 0,
        width: frame.width || 0,
        height: frame.height || 0,
      });
    }

    // Recurse into children
    if (node.children) {
      for (const child of node.children) this._parseHierarchy(child, elements);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Find the UDID of the first booted iOS Simulator.
 */
function findBootedUdid() {
  try {
    const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    const data = JSON.parse(raw);
    const runtimes = data.devices || {};

    for (const [runtime, devices] of Object.entries(runtimes)) {
      if (!runtime.includes('iOS') && !runtime.includes('iphone') && !runtime.includes('ipad')) continue;
      for (const device of devices) {
        if (device.state === 'Booted') return device.udid;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Get logical screen size based on device name.
 */
function getLogicalSize(deviceName) {
  const name = deviceName.toLowerCase();
  if (name.includes('pro max') || name.includes('plus')) {
    return { width: 430, height: 932 };
  }
  if (name.includes('pro') || name.includes('17') || name.includes('16') ||
      name.includes('15') || name.includes('14')) {
    return { width: 393, height: 852 };
  }
  if (name.includes('ipad')) {
    return { width: 1024, height: 1366 };
  }
  // Default iPhone
  return { width: 390, height: 844 };
}
