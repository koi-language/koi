/**
 * Web Fetch Action - Fetch a URL and return its content as text, or download
 * binary files (PDF, ZIP, images, etc.) to disk.
 *
 * Uses Mozilla Readability (Firefox Reader View) + linkedom to extract
 * the main readable content from web pages. For JSON APIs, returns raw JSON.
 * For binary content (or when "saveTo" is specified), saves the file to disk.
 *
 * Fetch strategy:
 *   1. Primary: `got-scraping` — mimics a real Chrome session (TLS/HTTP2
 *      fingerprint, rotating User-Agent + Accept-Language, cookie jar).
 *      Defeats most basic anti-bot defences without spinning up a browser.
 *   2. Fallback: headless Chromium via Playwright — used when the primary
 *      response looks like a JS challenge page (Cloudflare "Just a moment",
 *      403/429/503 with challenge markers, or a tiny HTML shell that relies
 *      on JS to render). Slower but gets through almost anything.
 *   The fallback is only loaded on demand (dynamic import) so the happy
 *   path doesn't pay the Playwright startup cost.
 */

import fs from 'fs';
import path from 'path';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { gotScraping } from 'got-scraping';
import { channel } from '../../io/channel.js';

/** Content types that are binary and should be saved to disk instead of returned as text. */
const BINARY_CONTENT_TYPES = [
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/octet-stream',
  'application/vnd.openxmlformats',     // .docx, .xlsx, .pptx
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'image/',
  'audio/',
  'video/',
];

/** Binary file extensions — used when content-type is unreliable (e.g. server says text/html for a .pdf) */
const BINARY_EXTENSIONS = ['.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.mp3', '.mp4', '.wav', '.avi', '.mov'];

function _isBinaryContentType(ct) {
  const lower = (ct || '').toLowerCase();
  return BINARY_CONTENT_TYPES.some(prefix => lower.includes(prefix));
}

function _isBinaryUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return BINARY_EXTENSIONS.includes(ext);
  } catch { return false; }
}

/** Derive a filename from URL path or Content-Disposition header. */
function _deriveFilename(url, headers) {
  const disposition = headers['content-disposition'] || '';
  const filenameMatch = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
  if (filenameMatch) return decodeURIComponent(filenameMatch[1].replace(/"/g, ''));

  try {
    const pathname = new URL(url).pathname;
    const basename = path.basename(pathname);
    if (basename && basename.includes('.')) return basename;
  } catch { /* ignore */ }

  const ct = ((headers['content-type'] || '').split(';')[0] || '').trim();
  const extMap = {
    'application/pdf': 'download.pdf',
    'application/zip': 'download.zip',
    'application/gzip': 'download.gz',
    'image/png': 'download.png',
    'image/jpeg': 'download.jpg',
    'image/gif': 'download.gif',
  };
  return extMap[ct] || 'download.bin';
}

/** Decide whether the got-scraping response looks like a challenge page or
 *  a JS-only SPA that needs a real browser to render. We err on the side of
 *  NOT escalating — the browser path is 10× slower — so the heuristics are
 *  conservative:
 *    • Cloudflare/Akamai/DataDome signatures in the body.
 *    • 403/429/503 status with challenge markers (some CDNs return 200
 *      with a challenge body instead, handled by the regex).
 *    • Tiny HTML shell (<1500 bytes) that only contains a <noscript> +
 *      script tags → likely an SPA.
 */
function _looksLikeChallenge(statusCode, body) {
  if (statusCode === 403 || statusCode === 429 || statusCode === 503) {
    // These codes frequently indicate a challenge; inspect body too to
    // avoid false positives on legit 403s (e.g. private resource).
    if (!body) return true;
  }
  if (!body) return false;
  const head = body.slice(0, 4000).toLowerCase();
  if (/cf[-_]browser[-_]verification/.test(head)) return true;
  if (/cf[-_]chl[-_]opt|__cf_chl_tk/.test(head)) return true;
  if (/checking (?:your|if the site connection is secure)/.test(head)) return true;
  if (/just a moment\.\.\./.test(head)) return true;
  if (/please enable javascript and cookies/.test(head)) return true;
  if (/captcha\s*challenge|datadome/.test(head)) return true;
  return false;
}

function _looksLikeJsOnly(body) {
  if (!body) return false;
  // Short shell with a <noscript> "please enable JS" + nothing else of
  // substance. Real pages usually have >1500 bytes even when minified.
  if (body.length > 2500) return false;
  const lower = body.toLowerCase();
  if (!/<noscript/.test(lower)) return false;
  if (/please enable javascript|requires javascript|you need to enable javascript/.test(lower)) return true;
  return false;
}

/** Primary fetch path — got-scraping with Chrome-like TLS/HTTP2
 *  fingerprint, rotating UA, cookie jar, gzip/br decompression. */
async function _fetchWithGot(url) {
  const res = await gotScraping({
    url,
    timeout: { request: 30_000 },
    responseType: 'buffer',       // uniform: text and binary both come as Buffer
    throwHttpErrors: false,       // let us classify status codes
    followRedirect: true,
    maxRedirects: 10,
    headerGeneratorOptions: {
      browsers: [{ name: 'chrome', minVersion: 120 }],
      devices: ['desktop'],
      locales: ['en-US', 'en'],
      operatingSystems: ['macos', 'windows'],
    },
  });
  return {
    body: res.body,              // Buffer
    headers: res.headers,         // object
    statusCode: res.statusCode,
    url: res.url || url,          // final URL after redirects
  };
}

/** Try to launch a headless Chromium-family browser in order of availability:
 *    1. Playwright's bundled Chromium (requires `npx playwright install
 *       chromium` to have run once — ~150 MB one-time download).
 *    2. System Chrome / Chrome Beta / Edge via Playwright's `channel` —
 *       zero extra downloads if the user already has any of these.
 *    3. If nothing works, ask the user for permission to download the
 *       bundled Chromium and retry.
 *
 *  Returns the launched browser instance ready to create contexts. The
 *  caller is responsible for closing it.  */
async function _launchBrowserWithFallbacks(playwright) {
  // Launch attempts are ordered fastest-first: bundled chromium skips any
  // system-Chrome startup quirks (extensions, profile loading). System
  // browsers are the fallback — covers the common "user has Chrome
  // installed but never ran `playwright install`" case.
  const attempts = [
    { label: 'bundled chromium', opts: {} },
    { label: 'system Chrome',    opts: { channel: 'chrome' } },
    { label: 'system Chrome Beta', opts: { channel: 'chrome-beta' } },
    { label: 'system Edge',      opts: { channel: 'msedge' } },
  ];
  const errors = [];
  for (const a of attempts) {
    try {
      const browser = await playwright.chromium.launch({ headless: true, ...a.opts });
      channel.log('web', `web_fetch: launched browser → ${a.label}`);
      return { browser, via: a.label };
    } catch (err) {
      errors.push(`${a.label}: ${err.message.split('\n')[0]}`);
    }
  }

  // Every launch failed → offer to install the bundled chromium.
  channel.log('web', `web_fetch: no browser available. Attempts:\n  - ${errors.join('\n  - ')}`);
  const proceed = await channel.select(
    'web_fetch needs a headless browser to fetch this page '
    + '(Cloudflare challenge or JS-heavy SPA).\n'
    + 'None of: Playwright Chromium, Google Chrome, Chrome Beta, or Edge '
    + 'are available on this machine.\n'
    + 'Download Playwright Chromium now (~150 MB, one-time)?',
    [
      { title: 'Yes, install Chromium', value: 'install' },
      { title: 'Cancel (use got-scraping response as-is)', value: 'cancel' },
    ],
  );
  if (proceed !== 'install') {
    throw new Error('Browser install declined by user.');
  }
  await _installChromium();
  // After install, bundled chromium should launch cleanly. Retry once.
  const browser = await playwright.chromium.launch({ headless: true });
  channel.log('web', 'web_fetch: launched freshly-installed bundled chromium');
  return { browser, via: 'bundled chromium (just installed)' };
}

/** Spawn `npx playwright install chromium` and stream progress into the
 *  log channel so the user can see it's not hung. Resolves on success,
 *  rejects on non-zero exit or if `npx` isn't in PATH. */
async function _installChromium() {
  channel.log('web', 'web_fetch: downloading Playwright chromium — this may take a minute…');
  const { spawn } = await import('child_process');
  return await new Promise((resolve, reject) => {
    // `shell: true` lets the user's shell resolve `npx` from their
    // node install even if it's not literally in PATH for the pkg
    // binary process. Minor security/perf cost is acceptable here —
    // this runs once, behind an explicit user confirmation.
    const proc = spawn('npx', ['--yes', 'playwright', 'install', 'chromium'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    const feed = (tag) => (chunk) => {
      const s = chunk.toString().trim();
      if (s) channel.log('web', `[${tag}] ${s}`);
    };
    proc.stdout?.on('data', feed('playwright-install'));
    proc.stderr?.on('data', feed('playwright-install'));
    proc.on('error', (err) => {
      reject(new Error(
        `Failed to run "npx playwright install chromium": ${err.message}. `
        + 'Node.js / npx must be available in PATH to install the browser '
        + 'automatically. Install manually and retry.'
      ));
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npx playwright install exited with code ${code}`));
    });
  });
}

/** Fallback fetch path — headless Chromium. Only loaded on demand because
 *  the browser launch adds ~2s and ~200MB resident memory. */
async function _fetchWithBrowser(url) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error(
      'Playwright package not installed in Koi runtime. '
      + 'Add `playwright` to package.json and run `npm install`.'
    );
  }
  const { browser } = await _launchBrowserWithFallbacks(playwright);
  try {
    const context = await browser.newContext({
      // Match a recent Chrome on macOS; the fingerprint generator in
      // got-scraping uses similar values so responses look consistent.
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      // deviceScaleFactor: 2 makes sites serve hi-dpi assets — useful
      // when the caller scrapes images off the page.
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    const html = await page.content();
    const headers = response?.headers() ?? {};
    return {
      body: Buffer.from(html, 'utf8'),
      headers,
      statusCode: response?.status() ?? 200,
      url: page.url(),
    };
  } finally {
    await browser.close();
  }
}

export default {
  type: 'web_fetch',
  intent: 'web_fetch',
  description: 'Fetch a URL and return its content as readable text, or download files (PDF, ZIP, images, etc.) to disk. For web pages, extracts main content (like Firefox Reader View); for JSON APIs, returns raw JSON; for binary files (PDF, ZIP, images), downloads and saves to disk. Two-tier strategy: first tries got-scraping (browser-like TLS fingerprint) for speed; if the response looks like a JS-challenge page (Cloudflare, JS-only SPA) escalates to headless Chromium via Playwright. Fields: "url" (required), optional "saveTo" (local file path to save the downloaded file — required for binary downloads, optional for any URL; relative paths are resolved against cwd but you should always pass an ABSOLUTE path), optional "mode" ("readable"|"raw"), optional "maxChars" (default 8000). When downloading PDFs or binary files, always provide "saveTo". Returns: { success, url, savedTo?, fileSize?, text?, contentType, via? }. `savedTo` is ALWAYS an absolute path regardless of what you passed in `saveTo` — use that value VERBATIM when referencing the file in any other tool (generate_image referenceImages, learn_fact path=..., read_file, shell, etc.). NEVER pass `fileName` (basename only) or the original saveTo back to other tools — only `savedTo`. IMPORTANT: If web_fetch fails (404, timeout, redirect, empty), do NOT give up — use web_search to find the correct or updated URL, then web_fetch the result. DOWNLOADING IMAGES from search results: web_search usually returns URLs of DESCRIPTOR PAGES (e.g. `commons.wikimedia.org/wiki/File:Foo.jpg`, Flickr photo pages, news article pages), not direct image files. Do NOT guess or construct the direct-image URL (e.g. the `upload.wikimedia.org/wikipedia/commons/thumb/X/YY/...` form with an invented hash — that hash is the MD5 of the filename and you CANNOT derive it). Always: (1) web_fetch the HTML page (no saveTo), (2) read the response text to find the real direct image URL — look for `<meta property="og:image" content="...">`, `<link rel="image_src" href="...">`, the "Original file" / "Download" link, or the first `<img src="...">` of the main content, (3) web_fetch THAT URL with saveTo set. Never skip step 1.',
  permission: 'web_access',
  thinkingHint: (action) => {
    try { return `Fetching from ${new URL(action.url).hostname}`; } catch { return 'Fetching URL'; }
  },

  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      saveTo: { type: 'string', description: 'Local file path to save the downloaded file. Required for binary files (PDF, ZIP, images). ALWAYS pass an absolute path (starting with "/") so the file location is deterministic regardless of where the engine was launched. Relative paths are resolved against cwd but are fragile. The response field `savedTo` is ALWAYS absolute — reuse that in downstream tools verbatim.' },
      mode: { type: 'string', description: 'Response mode: "readable" (default) extracts main content as clean text; "raw" returns the full raw HTML as-is, unmodified' },
      maxChars: { type: 'number', description: 'Maximum characters to return (default 8000)' },
      forceBrowser: { type: 'boolean', description: 'Skip the got-scraping tier and go straight to the Playwright headless-browser path. Use when you already know the URL needs JS execution or when a prior run returned a challenge page.' },
    },
    required: ['url']
  },

  examples: [
    { intent: 'web_fetch', url: 'https://docs.flutter.dev/get-started/install' },
    { intent: 'web_fetch', url: 'https://example.com', mode: 'raw' },
    { intent: 'web_fetch', url: 'https://api.github.com/repos/flutter/flutter/releases/latest' },
    { intent: 'web_fetch', url: 'https://example.com/document.pdf', saveTo: '/tmp/document.pdf' },
    { intent: 'web_fetch', url: 'https://spa-behind-cloudflare.example.com', forceBrowser: true }
  ],

  async execute(action) {
    const url = action.url || action.data?.url;
    const saveTo = action.saveTo || action.data?.saveTo;
    const mode = action.mode || action.data?.mode || 'readable';
    const maxChars = action.maxChars || action.data?.maxChars || 8000;
    const forceBrowser = action.forceBrowser ?? action.data?.forceBrowser ?? false;

    if (!url) throw new Error('web_fetch: "url" is required');

    // ── Tier 1: got-scraping (skip if caller forced browser) ──────────────
    let fetchRes;
    let via = 'got-scraping';
    if (!forceBrowser) {
      try {
        fetchRes = await _fetchWithGot(url);
      } catch (err) {
        return { success: false, url, error: `got-scraping failed: ${err.message}` };
      }
    }

    // Decide whether to escalate to the browser fallback. Escalate when:
    //   • caller forced it,
    //   • got-scraping returned a non-2xx non-redirect status AND the body
    //     looks like a challenge page,
    //   • got-scraping returned 200 but the body is a JS-only shell.
    const contentType = forceBrowser
      ? ''
      : (fetchRes.headers['content-type'] || '');
    const isBinary = !forceBrowser && (
      _isBinaryContentType(contentType) || _isBinaryUrl(url)
    );

    // Only consider escalation for non-binary responses. Binary downloads
    // through got-scraping are fine and a headless browser would just
    // navigate to the file without returning its bytes cleanly.
    let escalate = forceBrowser;
    if (!escalate && !isBinary && fetchRes) {
      const preview = fetchRes.body.toString('utf8', 0, Math.min(5000, fetchRes.body.length));
      if (_looksLikeChallenge(fetchRes.statusCode, preview)) escalate = true;
      else if (fetchRes.statusCode === 200 && _looksLikeJsOnly(preview)) escalate = true;
    }

    if (escalate) {
      channel.log('web', `web_fetch: escalating to headless browser (${forceBrowser ? 'forced' : 'challenge detected'})`);
      try {
        fetchRes = await _fetchWithBrowser(url);
        via = 'browser';
      } catch (err) {
        if (forceBrowser || !fetchRes) {
          // No got-scraping response to fall back to.
          return { success: false, url, error: `browser fetch failed: ${err.message}` };
        }
        // Use the got-scraping response even if it looked like a challenge —
        // better some text than nothing, and the caller can decide.
        channel.log('web', `web_fetch: browser fallback failed (${err.message}); returning got-scraping response`);
      }
    }

    const finalStatus = fetchRes.statusCode;
    const finalCT = (fetchRes.headers['content-type'] || '').toString();
    const bodyBuf = fetchRes.body;

    // ── Fast error return for clearly-failed responses ────────────────────
    if (finalStatus >= 400) {
      const preview = bodyBuf.toString('utf8', 0, Math.min(1000, bodyBuf.length));
      return {
        success: false,
        url: fetchRes.url,
        status: finalStatus,
        contentType: finalCT,
        via,
        error: `HTTP ${finalStatus}`,
        preview,
      };
    }

    const binary = _isBinaryContentType(finalCT) || _isBinaryUrl(url);

    // ── Binary download path ──────────────────────────────────────────────
    if (binary || saveTo) {
      // Sanity: if we expected binary (URL/ext hint) but got HTML,
      // surface that instead of saving an HTML login page to disk.
      const saveToLooksImage = saveTo && /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i.test(saveTo);
      if (!_isBinaryContentType(finalCT) && (_isBinaryUrl(url) || saveToLooksImage)) {
        const head = bodyBuf.slice(0, 20).toString('utf8').trim().toLowerCase();
        if (head.startsWith('<!doc') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<?xml') || head.startsWith('<svg')) {
          const raw = bodyBuf.toString('utf8');
          const text = _extractReadable(raw, url);
          const truncated = text.length > maxChars;
          return {
            success: false,
            url: fetchRes.url,
            contentType: finalCT,
            via,
            error: 'Expected a binary file (based on URL) but received an HTML page instead. The server may require authentication, or the URL may have changed.',
            text: truncated ? text.slice(0, maxChars) + '\n\n[truncated]' : text,
          };
        }
      }

      const filePath = saveTo || _deriveFilename(url, fetchRes.headers);
      const resolvedPath = path.resolve(filePath);

      // Image sanity check — when the download looks like an image (by
      // Content-Type OR by saveTo extension), decode the buffer with sharp
      // BEFORE writing to disk. Catches: 0-byte files, truncated downloads,
      // HTML/JSON served with an image Content-Type, CDN placeholders, and
      // anti-hotlink tracking pixels. Without this the bad image lands in
      // downstream tools (generate_image referenceImages, OCR, thumbnails)
      // and fails there with a generic provider error — exactly the loop
      // we hit with the Artemis refs.
      const isImageDownload =
        /^image\//i.test(finalCT) ||
        /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(resolvedPath);
      if (isImageDownload) {
        try {
          const sharp = (await import('sharp')).default;
          const meta = await sharp(bodyBuf).metadata();
          if (!meta?.width || !meta?.height || !meta?.format) {
            return {
              success: false,
              url: fetchRes.url,
              contentType: finalCT,
              via,
              fileSize: bodyBuf.length,
              error: `Downloaded ${bodyBuf.length} bytes but the response is not a decodable image. Content-Type=${finalCT || 'unknown'}. The server likely returned an error/placeholder page. Try a different URL.`,
            };
          }
        } catch (decodeErr) {
          return {
            success: false,
            url: fetchRes.url,
            contentType: finalCT,
            via,
            fileSize: bodyBuf.length,
            error: `Response is not a valid image (${decodeErr.message}). Content-Type=${finalCT || 'unknown'}, size=${bodyBuf.length}B. Try a different URL.`,
          };
        }
      }

      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolvedPath, bodyBuf);

      return {
        success: true,
        url: fetchRes.url,
        contentType: finalCT,
        via,
        savedTo: resolvedPath,
        fileSize: bodyBuf.length,
        fileName: path.basename(resolvedPath),
      };
    }

    // ── Text content path ────────────────────────────────────────────────
    const raw = bodyBuf.toString('utf8');

    let text;
    if (mode === 'raw' || mode === 'html') {
      text = raw;
    } else if (finalCT.includes('application/json')) {
      try { text = JSON.stringify(JSON.parse(raw), null, 2); }
      catch { text = raw; }
    } else {
      text = _extractReadable(raw, url);
    }

    const truncated = text.length > maxChars;
    return {
      success: true,
      url: fetchRes.url,
      contentType: finalCT,
      mode,
      via,
      text: truncated ? text.slice(0, maxChars) + '\n\n[truncated]' : text,
      chars: text.length,
      truncated,
    };
  }
};

/**
 * Extract readable content using Mozilla Readability (Firefox Reader View).
 * Falls back to basic regex stripping if Readability can't parse the page.
 */
function _extractReadable(html, url) {
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document, { url });
    const article = reader.parse();
    if (article && article.textContent) {
      return article.textContent
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  } catch { /* fall through to regex fallback */ }

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
