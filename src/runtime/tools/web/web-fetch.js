/**
 * Web Fetch Action - Fetch a URL and return its content as text, or download
 * binary files (PDF, ZIP, images, etc.) to disk.
 *
 * Uses Mozilla Readability (Firefox Reader View) + linkedom to extract
 * the main readable content from web pages. For JSON APIs, returns raw JSON.
 * For binary content (or when "saveTo" is specified), saves the file to disk.
 */

import fs from 'fs';
import path from 'path';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

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
function _deriveFilename(url, res) {
  // Try Content-Disposition header first
  const disposition = res.headers.get('content-disposition') || '';
  const filenameMatch = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
  if (filenameMatch) return decodeURIComponent(filenameMatch[1].replace(/"/g, ''));

  // Fall back to URL path
  try {
    const pathname = new URL(url).pathname;
    const basename = path.basename(pathname);
    if (basename && basename.includes('.')) return basename;
  } catch { /* ignore */ }

  // Last resort: use content-type to guess extension
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
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

export default {
  type: 'web_fetch',
  intent: 'web_fetch',
  description: 'Fetch a URL and return its content as readable text, or download files (PDF, ZIP, images, etc.) to disk. For web pages, extracts main content (like Firefox Reader View); for JSON APIs, returns raw JSON; for binary files (PDF, ZIP, images), downloads and saves to disk. Fields: "url" (required), optional "saveTo" (local file path to save the downloaded file — required for binary downloads, optional for any URL), optional "mode" ("readable"|"raw"), optional "maxChars" (default 8000). When downloading PDFs or binary files, always provide "saveTo". Returns: { success, url, savedTo?, fileSize?, text?, contentType }. IMPORTANT: If web_fetch fails (404, timeout, redirect, empty), do NOT give up — use web_search to find the correct or updated URL, then web_fetch the result.',
  permission: 'web_access',
  thinkingHint: (action) => {
    try { return `Fetching from ${new URL(action.url).hostname}`; } catch { return 'Fetching URL'; }
  },

  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      saveTo: { type: 'string', description: 'Local file path to save the downloaded file. Required for binary files (PDF, ZIP, images). If omitted for binary content, auto-derives filename in current directory.' },
      mode: { type: 'string', description: 'Response mode: "readable" (default) extracts main content as clean text; "raw" returns the full raw HTML as-is, unmodified' },
      maxChars: { type: 'number', description: 'Maximum characters to return (default 8000)' }
    },
    required: ['url']
  },

  examples: [
    { intent: 'web_fetch', url: 'https://docs.flutter.dev/get-started/install' },
    { intent: 'web_fetch', url: 'https://example.com', mode: 'raw' },
    { intent: 'web_fetch', url: 'https://api.github.com/repos/flutter/flutter/releases/latest' },
    { intent: 'web_fetch', url: 'https://example.com/document.pdf', saveTo: '/tmp/document.pdf' },
    { intent: 'web_fetch', url: 'https://example.com/archive.zip', saveTo: '/tmp/archive.zip' }
  ],

  async execute(action) {
    const url = action.url || action.data?.url;
    const saveTo = action.saveTo || action.data?.saveTo;
    const mode = action.mode || action.data?.mode || 'readable';
    const maxChars = action.maxChars || action.data?.maxChars || 8000;

    if (!url) throw new Error('web_fetch: "url" is required');

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KoiAgent/1.0)',
        'Accept': 'text/html,application/json,application/pdf,*/*'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      return { success: false, status: res.status, error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const contentType = res.headers.get('content-type') || '';
    const isBinary = _isBinaryContentType(contentType) || _isBinaryUrl(url);

    // --- Binary download path (or explicit saveTo) ---
    if (isBinary || saveTo) {
      const buffer = Buffer.from(await res.arrayBuffer());

      // Sanity check: if we expected binary (by URL or saveTo extension) but got HTML
      // (e.g. a login page, Wikimedia file page, or redirect), warn instead of saving garbage.
      const saveToLooksImage = saveTo && /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i.test(saveTo);
      if (!_isBinaryContentType(contentType) && (_isBinaryUrl(url) || saveToLooksImage)) {
        const head = buffer.slice(0, 20).toString('utf8').trim().toLowerCase();
        if (head.startsWith('<!doc') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<?xml') || head.startsWith('<svg')) {
          // It's actually an HTML page, not the expected binary file
          const raw = buffer.toString('utf8');
          const text = _extractReadable(raw, url);
          const maxC = maxChars;
          const truncated = text.length > maxC;
          return {
            success: false,
            url,
            contentType,
            error: 'Expected a binary file (based on URL) but received an HTML page instead. The server may require authentication, or the URL may have changed.',
            text: truncated ? text.slice(0, maxC) + '\n\n[truncated]' : text,
          };
        }
      }

      const filePath = saveTo || _deriveFilename(url, res);
      const resolvedPath = path.resolve(filePath);

      // Ensure parent directory exists
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(resolvedPath, buffer);

      return {
        success: true,
        url,
        contentType,
        savedTo: resolvedPath,
        fileSize: buffer.length,
        fileName: path.basename(resolvedPath),
      };
    }

    // --- Text content path ---
    const raw = await res.text();

    let text;
    if (mode === 'raw' || mode === 'html') {
      // Raw HTML as-is
      text = raw;
    } else if (contentType.includes('application/json')) {
      // Pretty-print JSON
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        text = raw;
      }
    } else {
      // Use Mozilla Readability to extract main content
      text = _extractReadable(raw, url);
    }

    const truncated = text.length > maxChars;
    return {
      success: true,
      url,
      contentType,
      mode,
      text: truncated ? text.slice(0, maxChars) + '\n\n[truncated]' : text,
      chars: text.length,
      truncated
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
    // Readability needs a documentURI for relative URL resolution
    const reader = new Readability(document, { url });
    const article = reader.parse();
    if (article && article.textContent) {
      // textContent is clean text extracted by Readability
      return article.textContent
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  } catch { /* fall through to regex fallback */ }

  // Fallback: basic regex stripping
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
