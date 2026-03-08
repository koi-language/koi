/**
 * Browser Platform — Playwright singleton for browser automation.
 *
 * Manages a single Playwright browser instance + page.
 * Launches a VISIBLE (non-headless) Chromium browser so the user can watch.
 *
 * Binary packaging note:
 *   Playwright's JS is bundled by esbuild. The browser binary is NOT bundled —
 *   it is found at runtime via:
 *     1. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH env var (explicit override)
 *     2. Common system Chrome/Chromium locations (macOS, Linux, Windows)
 *     3. Playwright's own installed Chromium (via PLAYWRIGHT_BROWSERS_PATH)
 */

import fs from 'fs';

let _browser = null;
let _context = null;
let _page = null;
let _lastElementsSummary = '';
let _lastElements = [];

// ── Browser executable discovery ─────────────────────────────────────────────

function findBrowserExecutableSync() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) {
    try { fs.accessSync(p); return p; } catch { /* try next */ }
  }
  return null; // let Playwright use its own installed browser
}

// ── Browser lifecycle ─────────────────────────────────────────────────────────

export async function getBrowser() {
  if (_browser) return _browser;
  const { chromium } = await import('playwright');
  const executablePath = findBrowserExecutableSync();
  const launchOpts = {
    headless: false,
    args: ['--start-maximized', '--disable-infobars'],
  };
  if (executablePath) launchOpts.executablePath = executablePath;
  _browser = await chromium.launch(launchOpts);
  return _browser;
}

export async function getPage() {
  const browser = await getBrowser();
  if (!_page || _page.isClosed()) {
    if (_context) {
      try { await _context.close(); } catch { /* ignore */ }
    }
    _context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    _page = await _context.newPage();
  }
  return _page;
}

export async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch { /* ignore */ }
    _browser = null;
    _context = null;
    _page = null;
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

export async function navigate(url, opts = {}) {
  const page = await getPage();
  await page.goto(url, {
    waitUntil: opts.waitUntil || 'domcontentloaded',
    timeout: opts.timeout || 30000,
  });
  return page;
}

// ── Screenshot ────────────────────────────────────────────────────────────────

export async function screenshot() {
  const page = await getPage();
  return page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
}

// ── Element extraction ────────────────────────────────────────────────────────

const ELEMENT_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([type="hidden"]):not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export async function getElements() {
  const page = await getPage();
  const elements = await page.evaluate((selectors) => {
    const result = [];
    const seen = new WeakSet();

    for (const el of document.querySelectorAll(selectors)) {
      if (seen.has(el)) continue;
      seen.add(el);

      const rect = el.getBoundingClientRect();
      // Skip invisible / out-of-viewport elements
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.bottom < -50 || rect.top > window.innerHeight + 50) continue;
      if (rect.right < -50 || rect.left > window.innerWidth + 50) continue;

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const type = el.getAttribute('type') || '';
      const label =
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) ||
        el.getAttribute('name') ||
        el.getAttribute('id') ||
        tag;

      result.push({
        label,
        tag,
        role,
        type,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        href: el.href || null,
        value: el.value != null ? String(el.value).slice(0, 100) : null,
        placeholder: el.placeholder || null,
      });
    }
    return result;
  }, ELEMENT_SELECTORS);

  _lastElements = elements;
  _lastElementsSummary = formatElements(elements);
  return elements;
}

function formatElements(elements) {
  if (!elements.length) return '(no interactive elements found)';
  return elements
    .slice(0, 80)
    .map((el, i) => {
      const meta = [el.tag, el.role, el.type].filter(Boolean).join('/');
      const extra = el.placeholder
        ? ` [placeholder: "${el.placeholder}"]`
        : el.value
        ? ` [value: "${el.value}"]`
        : el.href
        ? ` → ${el.href.slice(0, 60)}`
        : '';
      return `${i + 1}. ${el.label} (${meta})${extra}`;
    })
    .join('\n')
    .concat(elements.length > 80 ? `\n… and ${elements.length - 80} more` : '');
}

// ── Cached state (for template injection) ─────────────────────────────────────

export function getLastElementsSummary() {
  return _lastElementsSummary;
}

export function getLastElements() {
  return _lastElements;
}

export async function getCurrentUrl() {
  if (!_page || _page.isClosed()) return null;
  return _page.url();
}

export async function getTitle() {
  if (!_page || _page.isClosed()) return null;
  return _page.title();
}
