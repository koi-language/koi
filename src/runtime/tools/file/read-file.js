/**
 * Read File Action - Read file contents without using shell.
 *
 * Dedicated action so the LLM doesn't need to use shell with cat/head/tail.
 * Supports reading full files or specific line ranges.
 * Permission: per directory, shared with edit_file/write_file/search.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';

import { t } from '../../i18n.js';
import { getFilePermissions } from '../../code/file-permissions.js';
import { channel } from '../../io/channel.js';

async function extractPdfPageImages(page, pdfjsLib) {
  const opList = await page.getOperatorList();
  const images = [];
  const ImageKind = pdfjsLib.ImageKind || {
    GRAYSCALE_1BPP: 1,
    RGB_24BPP: 2,
    RGBA_32BPP: 3
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (fn !== pdfjsLib.OPS.paintImageXObject && fn !== pdfjsLib.OPS.paintInlineImageXObject) continue;

    const args = opList.argsArray[i] || [];
    const imageId = args[0];
    let img = null;

    if (imageId) {
      try {
        img = page.objs.get(imageId);
      } catch {
        img = null;
      }
    }

    if (!img && fn === pdfjsLib.OPS.paintInlineImageXObject) {
      img = args[0];
    }

    if (!img || !img.data || !img.width || !img.height) continue;

    let rgba;
    if (img.kind === ImageKind.RGBA_32BPP) {
      rgba = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data);
    } else if (img.kind === ImageKind.RGB_24BPP) {
      rgba = new Uint8ClampedArray(img.width * img.height * 4);
      for (let src = 0, dest = 0; src < img.data.length; src += 3, dest += 4) {
        rgba[dest] = img.data[src];
        rgba[dest + 1] = img.data[src + 1];
        rgba[dest + 2] = img.data[src + 2];
        rgba[dest + 3] = 255;
      }
    } else if (img.kind === ImageKind.GRAYSCALE_1BPP) {
      rgba = new Uint8ClampedArray(img.width * img.height * 4);
      const rowBytes = Math.ceil(img.width / 8);
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const byte = img.data[y * rowBytes + (x >> 3)];
          const bit = (byte >> (7 - (x & 7))) & 1;
          const value = bit ? 0 : 255;
          const idx = (y * img.width + x) * 4;
          rgba[idx] = value;
          rgba[idx + 1] = value;
          rgba[idx + 2] = value;
          rgba[idx + 3] = 255;
        }
      }
    } else {
      rgba = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data);
    }

    images.push({ data: rgba, width: img.width, height: img.height });
  }

  return images;
}

/**
 * Install minimal DOM polyfills that pdfjs-dist needs at module load time.
 * Must be called BEFORE any import('pdfjs-dist/...').
 */
function _ensurePdfjsPolyfills() {
  if (typeof globalThis.DOMMatrix !== 'undefined') return; // already polyfilled or real browser

  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      const v = Array.isArray(init) ? init : [1, 0, 0, 1, 0, 0];
      this.a = v[0] ?? 1; this.b = v[1] ?? 0; this.c = v[2] ?? 0;
      this.d = v[3] ?? 1; this.e = v[4] ?? 0; this.f = v[5] ?? 0;
      this.m11 = this.a; this.m12 = this.b; this.m21 = this.c;
      this.m22 = this.d; this.m41 = this.e; this.m42 = this.f;
      this.m13 = 0; this.m14 = 0; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m43 = 0; this.m44 = 1; this.is2D = true; this.isIdentity = false;
    }
    multiplySelf(o) {
      const a = this.a * o.a + this.c * o.b, b = this.b * o.a + this.d * o.b;
      const c = this.a * o.c + this.c * o.d, d = this.b * o.c + this.d * o.d;
      const e = this.a * o.e + this.c * o.f + this.e, f = this.b * o.e + this.d * o.f + this.f;
      this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
      return this;
    }
    translate(tx, ty) { return this.multiplySelf(new DOMMatrix([1, 0, 0, 1, tx, ty])); }
    scale(sx, sy) { return this.multiplySelf(new DOMMatrix([sx, 0, 0, sy ?? sx, 0, 0])); }
    inverse() {
      const det = this.a * this.d - this.b * this.c;
      if (!det) return new DOMMatrix();
      return new DOMMatrix([this.d / det, -this.b / det, -this.c / det, this.a / det,
        (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det]);
    }
    transformPoint(p) {
      return { x: this.a * (p?.x || 0) + this.c * (p?.y || 0) + this.e,
               y: this.b * (p?.x || 0) + this.d * (p?.y || 0) + this.f };
    }
    static fromMatrix(o) { return new DOMMatrix([o?.a ?? 1, o?.b ?? 0, o?.c ?? 0, o?.d ?? 1, o?.e ?? 0, o?.f ?? 0]); }
  };

  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = class ImageData { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
  }
  if (typeof globalThis.Path2D === 'undefined') {
    globalThis.Path2D = class Path2D { constructor() {} moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} rect() {} };
  }
}

/**
 * Load pdfjs-dist in pkg binary by extracting the ESM files from the snapshot
 * to ~/.koi/runtime/{version}/pdfjs-dist/ on real disk, then importing from there.
 * Cached — only extracts once per version.
 */
let _pdfjsCached = null;
async function _loadPdfjsFromCache() {
  if (_pdfjsCached) return _pdfjsCached;

  const version = process.env.KOI_VERSION || 'dev';
  const cacheDir = path.join(os.homedir(), '.koi', 'runtime', version, 'pdfjs-dist');
  const targetFile = path.join(cacheDir, 'pdf.mjs');
  const markerFile = path.join(cacheDir, '.extracted');

  if (!fs.existsSync(markerFile)) {
    // Find pdfjs-dist in the snapshot via require.resolve
    const { createRequire } = await import('module');
    const _req = createRequire(__filename || process.argv[1]);
    let snapshotDir;
    try {
      const resolved = _req.resolve('pdfjs-dist/legacy/build/pdf.mjs');
      snapshotDir = path.dirname(resolved);
    } catch {
      throw new Error('pdfjs-dist not found in snapshot — PDF reading unavailable');
    }

    // Extract all files from the legacy/build directory
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
    fs.mkdirSync(cacheDir, { recursive: true });

    const files = fs.readdirSync(snapshotDir);
    for (const file of files) {
      const src = path.join(snapshotDir, file);
      const dest = path.join(cacheDir, file);
      try {
        const stat = fs.statSync(src);
        if (stat.isFile()) {
          fs.copyFileSync(src, dest);
        }
      } catch { /* skip unreadable files */ }
    }

    fs.writeFileSync(markerFile, version, 'utf8');
    channel.log('read_file', `Extracted pdfjs-dist to ${cacheDir}`);
  }

  // Suppress pdfjs warnings about missing optional deps (@napi-rs/canvas)
  const _origWarn = console.warn;
  console.warn = (...args) => {
    const msg = String(args[0] || '');
    if (msg.startsWith('Warning: Cannot') || msg.includes('@napi-rs/canvas')) return;
    _origWarn.apply(console, args);
  };
  try {
    const { pathToFileURL } = await import('url');
    _pdfjsCached = await import(pathToFileURL(targetFile).href);
  } finally {
    console.warn = _origWarn;
  }
  return _pdfjsCached;
}

/**
 * Queue the active working-area document (image or web screenshot) for the
 * next LLM turn as a vision input, and — if the user has drawn annotations on
 * it — also queue the annotated composite as a second image preceded by a
 * text caption marking it as user markup. This is used both for the URL
 * branch (web tabs) and as a follow-up after reading an image file that
 * happens to be the active working-area document.
 */
async function _queueActiveDocumentForVision(doc, agent, originalRequestPath) {
  const session = agent?._activeSession;
  if (!session) {
    return {
      success: false,
      error: 'No active session — cannot queue document for vision.',
    };
  }

  // New contract: the document carries a [DocumentBundle] — one primary
  // resource, an optional composite-snapshot annotation, and a list of
  // references. We queue PRIMARY + ANNOTATION to vision (those are the
  // two images the agent needs to see to understand intent). References
  // are NOT auto-queued: they're listed in the bundle so downstream
  // tools (generate_image) can forward them to the image model, but the
  // agent doesn't need to inspect each cutout source visually to act on
  // the user's request. If it ever needs to, it can `read_file` the
  // specific reference path explicitly.
  const bundle = doc.bundle || null;
  const primaryPath = bundle?.primary?.path || doc.path;
  if (!primaryPath || !fs.existsSync(primaryPath)) {
    return {
      success: false,
      error: `Active document has no readable primary on disk (looked for: ${primaryPath || 'none'}).`,
    };
  }

  const srcExt = path.extname(primaryPath).toLowerCase().slice(1);
  const srcMime = srcExt === 'jpg' ? 'image/jpeg' : `image/${srcExt}`;
  const srcB64 = fs.readFileSync(primaryPath).toString('base64');

  if (!session._pendingMcpImages) session._pendingMcpImages = [];
  session._pendingMcpImages.push({ mimeType: srcMime, data: srcB64, _debugPath: primaryPath });
  channel.log('read_file', `[bundle:${doc.id}] primary queued for vision: ${primaryPath}`);

  let annotationNote = '';
  const overlayPath = bundle?.annotation?.path || null;
  if (overlayPath && fs.existsSync(overlayPath)) {
    const ovExt = path.extname(overlayPath).toLowerCase().slice(1);
    const ovMime = ovExt === 'jpg' ? 'image/jpeg' : `image/${ovExt}`;
    const ovB64 = fs.readFileSync(overlayPath).toString('base64');
    const caption =
      '[ANNOTATIONS OVERLAY] The next image is NOT part of the original document. ' +
      'It is the user\'s hand-drawn markup (arrows, circles, boxes, freehand, text) ' +
      'AND any reference cutouts they have pasted, both painted on top of the exact ' +
      'same image you just saw. Use it as a visual guide that complements the text ' +
      'prompt: the shapes and their positions indicate what the user is referring to. ' +
      'Drawn-colour markup itself is meaningless — only the regions and the shapes\' ' +
      'intent matter. Do not treat the markup as part of the design or copy its ' +
      'colours into your output. Pasted cutouts ARE content, but you do NOT need to ' +
      'inspect their full-quality sources here — they are listed in the bundle and ' +
      'will be forwarded by generate_image as referenceImages when the edit runs.';
    session._pendingMcpImages.push({
      mimeType: ovMime,
      data: ovB64,
      _debugPath: overlayPath,
      caption,
      role: 'annotation_overlay',
    });
    channel.log('read_file', `[bundle:${doc.id}] annotation queued for vision: ${overlayPath}`);
    annotationNote = ' The user has drawn/composed on top of it — a second image labeled "ANNOTATIONS OVERLAY" follows: THAT is the visual intent spec.';
  }

  // Reference paths — surface them in the return message so the agent
  // can forward the paths to generate_image without having to inspect
  // each image visually. Intentionally NOT queued to vision.
  const refs = Array.isArray(bundle?.references) ? bundle.references : [];
  if (refs.length > 0) {
    const refList = refs.map((r, i) => `  ${i + 1}. ${r.path}`).join('\n');
    annotationNote += ` ${refs.length} reference source(s) available in the bundle for downstream tools:\n${refList}`;
    channel.log(
      'read_file',
      `[bundle:${doc.id}] ${refs.length} reference(s) listed (not vision-queued): ${refs.map((r) => path.basename(r.path)).join(', ')}`,
    );
  }

  return {
    success: true,
    path: originalRequestPath,
    type: doc.url ? 'web' : 'image',
    bundle: bundle || undefined,
    message:
      `Active working-area ${doc.url ? 'web page' : 'image'} attached for visual analysis.` +
      annotationNote,
  };
}

export default {
  type: 'read_file',
  intent: 'read_file',
  description: 'Read a file\'s contents. Supports text files, PDF files, and images (PNG, JPG, GIF, WebP). For images, the file is attached as vision input — you will see the image on your next response and can describe or analyze it visually. Fields: "path" (file path), optional "offset" (start line, 1-based, default 1), optional "limit" (number of lines, default 2000), optional "pages" (page range for PDFs). If path is a directory, lists its contents.',
  instructions: `read_file rules:
- Always use offset + limit for text files
- Prefer 50-150 lines per read
- Never read more than 200 lines at once
- For large files, never omit offset/limit
- For images (.png, .jpg, .gif, .webp): just call read_file with the path — the image will be attached for visual analysis on your next turn.`,
  thinkingHint: (action) => `Reading ${action.path ? path.basename(action.path) : 'file'}`,
  permission: 'read',
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read, or an attachment ID (e.g. att-1) to read an attached file' },
      offset: { type: 'number', description: 'Start reading from this line number (1-based, optional)' },
      limit: { type: 'number', description: 'Maximum number of lines to read (optional)' },
      pages: { type: 'string', description: 'Page range for PDF files (e.g. "1-5", "3", "10-20"). Only for .pdf files. Max 20 pages per request.' }
    },
    required: ['path']
  },

  examples: [
    { actionType: 'direct', intent: 'read_file', path: 'src/cli/koi.js' },
    { actionType: 'direct', intent: 'read_file', path: 'src/cli/koi.js', offset: 10, limit: 50 },
    { actionType: 'direct', intent: 'read_file', path: 'docs/manual.pdf', pages: '1-5' },
    { actionType: 'direct', intent: 'read_file', path: 'assets/screenshot.png' }
  ],

  async execute(action, agent) {
    let filePath = action.path;
    if (!filePath) throw new Error('read_file: "path" field is required');

    // URL branch — the system prompt tells the agent to read the active
    // working-area document with its `path or url`. For web tabs that means
    // read_file gets an http(s) URL, which is obviously not a file on disk.
    // Resolve it through the open-documents store: if the URL matches an
    // open web tab, queue the GUI-captured screenshot (and any annotation
    // overlay the user has drawn) for vision, then return.
    if (/^https?:\/\//i.test(filePath)) {
      try {
        const { openDocumentsStore } = await import('../../state/open-documents-store.js');
        const doc = openDocumentsStore.findByPathOrUrl(filePath);
        if (!doc) {
          return {
            success: false,
            error: `URL "${filePath}" is not an open working-area document. Use web_fetch for arbitrary URLs.`,
          };
        }
        const queued = await _queueActiveDocumentForVision(doc, agent, filePath);
        if (queued.success) return queued;
        return queued;
      } catch (err) {
        return { success: false, error: `Failed to read active web document: ${err.message}` };
      }
    }

    // Resolve attachment IDs (att-N) transparently via the attachment registry.
    // Agents reference attachments by ID; read_file resolves them to actual paths.
    if (/^att-\d+$/.test(filePath)) {
      try {
        const { attachmentRegistry } = await import('../../state/attachment-registry.js');
        const resolved = attachmentRegistry.resolve(filePath);
        if (!resolved) {
          return { success: false, error: `Attachment not found: ${filePath}. Use a valid attachment ID (e.g. att-1).` };
        }
        filePath = resolved;
      } catch {
        return { success: false, error: `Could not resolve attachment ID: ${filePath}` };
      }
    }

    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    // Check directory permission
    const permissions = getFilePermissions(agent);
    const targetDir = fs.statSync(resolvedPath).isDirectory() ? resolvedPath : path.dirname(resolvedPath);

    if (!permissions.isAllowed(resolvedPath, 'read')) {
      channel.clearProgress();
      const agentName = agent?.name || 'Agent';
      const _dirBase = path.basename(path.dirname(resolvedPath));
      const value = await channel.select('', [
        { title: t('permYes'), value: 'yes' },
        { title: `${t('permAlwaysAllow')} (${_dirBase}/)`, value: 'always' },
        { title: t('permNo'), value: 'no' }
      ], 0, { meta: { type: 'bash', header: `${agentName} ${t('wantsToRead')}`.replace(':', ''), command: `Read(${filePath})` } });

      if (value === 'always') {
        permissions.allowProject(resolvedPath);
      } else if (value !== 'yes') {
        return { success: false, denied: true, message: 'User denied file access' };
      }
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolvedPath);
      const listing = entries.map(e => {
        const full = path.join(resolvedPath, e);
        try {
          const s = fs.statSync(full);
          return s.isDirectory() ? `${e}/` : e;
        } catch {
          return e;
        }
      });
      return { success: true, path: filePath, type: 'directory', entries: listing };
    }

    // --- Image support (vision) ---
    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    if (IMAGE_EXTS.includes(path.extname(resolvedPath).toLowerCase())) {
      // Read image and convert to base64 for the vision pipeline.
      const b64 = fs.readFileSync(resolvedPath).toString('base64');
      const ext = path.extname(resolvedPath).toLowerCase().slice(1);
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

      // Queue the image for the next LLM turn as a vision input.
      const session = agent?._activeSession;
      if (session) {
        if (!session._pendingMcpImages) session._pendingMcpImages = [];
        session._pendingMcpImages.push({ mimeType: mime, data: b64, _debugPath: filePath });
        channel.log('read_file', `Image queued for vision: ${filePath}`);

        // If this image is also the active working-area document AND the
        // tab carries a [DocumentBundle] (annotation / references), queue
        // the annotation right after the primary so the LLM sees them as
        // a pair. References are listed in the return message but NOT
        // queued to vision — generate_image forwards them separately as
        // referenceImages, so the agent doesn't need to inspect each
        // cutout source visually to reason about the edit.
        let annotationNote = '';
        let matchedDoc = null;
        try {
          const { openDocumentsStore } = await import('../../state/open-documents-store.js');
          const doc = openDocumentsStore.findByPathOrUrl(resolvedPath) ||
                      openDocumentsStore.findByPathOrUrl(filePath);
          matchedDoc = doc;
          const bundle = doc?.bundle || null;
          const overlayPath = bundle?.annotation?.path || null;
          if (overlayPath && fs.existsSync(overlayPath)) {
            const ovExt = path.extname(overlayPath).toLowerCase().slice(1);
            const ovMime = ovExt === 'jpg' ? 'image/jpeg' : `image/${ovExt}`;
            const ovB64 = fs.readFileSync(overlayPath).toString('base64');
            const caption =
              '[ANNOTATIONS OVERLAY] The next image is NOT part of the original document. ' +
              'It is the user\'s hand-drawn markup (arrows, circles, boxes, freehand, text) ' +
              'AND any reference cutouts they have pasted, both painted on top of the exact ' +
              'same image you just saw. Use it as a visual guide that complements the text ' +
              'prompt: the shapes and their positions indicate what the user is referring to. ' +
              'Drawn-colour markup itself is meaningless — only the regions and the shapes\' ' +
              'intent matter. Do not treat the markup as part of the design or copy its ' +
              'colours into your output. Pasted cutouts ARE content, but you do NOT need to ' +
              'inspect their full-quality sources here — they are listed in the bundle and ' +
              'will be forwarded by generate_image as referenceImages when the edit runs.';
            session._pendingMcpImages.push({
              mimeType: ovMime,
              data: ovB64,
              _debugPath: overlayPath,
              caption,
              role: 'annotation_overlay',
            });
            channel.log('read_file', `[bundle:${doc.id}] annotation queued for vision: ${overlayPath}`);
            annotationNote = ' The user has drawn/composed on top of it — a second image labeled "ANNOTATIONS OVERLAY" follows: THAT is the visual intent spec.';
          }
          const refs = Array.isArray(bundle?.references) ? bundle.references : [];
          if (refs.length > 0) {
            const refList = refs.map((r, i) => `  ${i + 1}. ${r.path}`).join('\n');
            annotationNote += ` ${refs.length} reference source(s) available in the bundle for downstream tools:\n${refList}`;
            channel.log(
              'read_file',
              `[bundle:${doc?.id}] ${refs.length} reference(s) listed (not vision-queued): ${refs.map((r) => path.basename(r.path)).join(', ')}`,
            );
          }
        } catch { /* store unavailable — ignore */ }

        return {
          success: true,
          path: filePath,
          type: 'image',
          bundle: matchedDoc?.bundle || undefined,
          message: `Image loaded and attached for visual analysis. You will see the image on your next response.${annotationNote}`
        };
      }
      // Fallback: no agent available, return base64 directly
      return {
        success: true,
        path: filePath,
        type: 'image',
        mimeType: mime,
        base64: b64,
        message: 'Image data returned as base64.'
      };
    }

    // --- PDF support ---
    if (resolvedPath.toLowerCase().endsWith('.pdf')) {
      try {
        // Polyfill DOM APIs that pdfjs requires even for text extraction.
        // Must be set BEFORE import() — pdfjs accesses them at module load time.
        _ensurePdfjsPolyfills();

        // Load pdfjs-dist. Direct import works in dev; in pkg binary, pdfjs-dist
        // is ESM-only so neither require() nor import() work from the snapshot.
        // Fallback: extract the .mjs file to a real disk cache and import from there.
        let pdfjsLib;
        try {
          pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        } catch {
          pdfjsLib = await _loadPdfjsFromCache();
        }
        // Suppress benign "standardFontDataUrl" warnings from pdfjs
        pdfjsLib.VerbosityLevel && pdfjsLib.setVerbosityLevel?.(0);
        const dataBuffer = fs.readFileSync(resolvedPath);
        const uint8Array = new Uint8Array(dataBuffer);
        const MAX_PDF_PAGES = 20;

        const doc = await pdfjsLib.getDocument({ data: uint8Array, verbosity: 0 }).promise;
        const totalPages = doc.numPages;

        // Parse page range if provided
        let pagesToRead = [];
        if (action.pages) {
          const ranges = String(action.pages).split(',').map(r => r.trim());
          const pageSet = new Set();
          for (const r of ranges) {
            if (r.includes('-')) {
              const [startStr, endStr] = r.split('-');
              const start = parseInt(startStr, 10);
              const end = parseInt(endStr, 10);
              if (!isNaN(start) && !isNaN(end)) {
                for (let p = start; p <= Math.min(end, totalPages); p++) pageSet.add(p);
              }
            } else {
              const p = parseInt(r, 10);
              if (!isNaN(p) && p >= 1 && p <= totalPages) pageSet.add(p);
            }
          }
          if (pageSet.size > MAX_PDF_PAGES) {
            return { success: false, error: `Too many pages requested (max ${MAX_PDF_PAGES}). Use a smaller range.` };
          }
          pagesToRead = [...pageSet].sort((a, b) => a - b);
        } else {
          // No pages specified — read all (up to MAX_PDF_PAGES)
          const maxPage = Math.min(totalPages, MAX_PDF_PAGES);
          for (let i = 1; i <= maxPage; i++) pagesToRead.push(i);
        }

        // Extract text and images from selected pages.
        // pdfjs items have a transform matrix where [5] is the Y coordinate.
        // When Y changes between items, it means a new line in the PDF layout.
        const pageTexts = [];
        const _pdfImages = []; // { page, index, width, height, path }
        const session = agent?._activeSession;
        const _pdfImgDir = path.join(os.tmpdir(), 'koi-pdf-images');

        for (const pageNum of pagesToRead) {
          const page = await doc.getPage(pageNum);
          const textContent = await page.getTextContent();
          const items = textContent.items.filter(i => i.str !== undefined);

          // Extract images from every page. Save to temp files so the model
          // can inspect them via read_file. Small sets (≤3 total) are auto-attached
          // as vision input; larger sets are listed so the model picks which to view.
          try {
            const images = await extractPdfPageImages(page, pdfjsLib);
            if (images.length > 0) {
              if (!fs.existsSync(_pdfImgDir)) fs.mkdirSync(_pdfImgDir, { recursive: true });
              for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
                const image = images[imgIdx];
                if (image.width < 50 || image.height < 50) continue;
                const imgPath = path.join(_pdfImgDir, `pdf-p${pageNum}-img${imgIdx}-${Date.now()}.png`);
                await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
                  .png().toFile(imgPath);
                _pdfImages.push({ page: pageNum, index: imgIdx, width: image.width, height: image.height, path: imgPath });
              }
            }

            // Pages with no text: try OCR as fallback
            if (!items.length && images.length > 0) {
              const cachePath = path.join(os.homedir(), '.koi', 'tesseract-data');
              if (!fs.existsSync(cachePath)) fs.mkdirSync(cachePath, { recursive: true });
              for (const image of images) {
                const pngBuffer = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }).png().withMetadata({ density: 300 }).toBuffer();
                try {
                  const { data } = await Tesseract.recognize(pngBuffer, 'eng', { cachePath, user_defined_dpi: '300' });
                  const ocrText = data?.text ? data.text.trim() : '';
                  if (ocrText) pageTexts.push(`--- Page ${pageNum} (OCR) ---\n${ocrText}`);
                } catch { /* OCR failed */ }
              }
            }
          } catch (imgErr) {
            channel.log('read_file', `PDF image extraction failed on page ${pageNum}: ${imgErr.message}`);
          }

          if (!items.length) continue;

          let lines = [];
          let currentLine = '';
          let lastY = null;

          for (const item of items) {
            const y = item.transform ? item.transform[5] : null;
            if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
              lines.push(currentLine);
              currentLine = item.str;
            } else {
              if (currentLine && item.str && !currentLine.endsWith(' ') && !item.str.startsWith(' ')) {
                currentLine += ' ' + item.str;
              } else {
                currentLine += item.str;
              }
            }
            if (y !== null) lastY = y;
          }
          if (currentLine) lines.push(currentLine);

          const pageText = lines.join('\n').trim();
          if (pageText) {
            pageTexts.push(`--- Page ${pageNum} ---\n${pageText}`);
          }
        }

        // Handle PDF images: ≤3 → auto-attach for vision; >3 → list paths so model picks
        const _AUTO_ATTACH_MAX = 3;
        if (_pdfImages.length > 0) {
          const autoAttach = _pdfImages.length <= _AUTO_ATTACH_MAX;
          if (autoAttach && session) {
            if (!session._pendingMcpImages) session._pendingMcpImages = [];
            for (const img of _pdfImages) {
              try {
                const imgB64 = fs.readFileSync(img.path).toString('base64');
                const imgExt = path.extname(img.path).toLowerCase().slice(1) || 'png';
                const imgMime = imgExt === 'jpg' ? 'image/jpeg' : `image/${imgExt}`;
                session._pendingMcpImages.push({ mimeType: imgMime, data: imgB64, _debugPath: img.path });
                channel.log('read_file', `PDF p${img.page} image auto-attached: ${img.path}`);
              } catch { /* skip unreadable images */ }
            }
          }
          const _imgLines = _pdfImages.map(i =>
            `  - Page ${i.page}, image ${i.index} (${i.width}×${i.height}): ${i.path}${autoAttach ? ' [attached]' : ''}`
          ).join('\n');
          const _header = autoAttach
            ? `--- Images (${_pdfImages.length}, attached for vision) ---`
            : `--- Images (${_pdfImages.length} found — use read_file to inspect) ---`;
          pageTexts.push(`${_header}\n${_imgLines}`);
        }

        const text = pageTexts.join('\n\n').trim();

        if (!text && _pdfImages.length === 0) {
          return { success: true, path: filePath, type: 'pdf', totalPages, content: '(No extractable text or images found in PDF.)', hint: 'This PDF has no text layer and no extractable images.' };
        }
        if (!text) {
          return { success: true, path: filePath, type: 'pdf', totalPages, content: `(No extractable text, but ${_pdfImages.length} image(s) attached for vision.)` };
        }

        // Apply line numbering and truncation like regular files
        const allLines = text.split('\n');
        const MAX_LINES = 2000;
        const MAX_LINE_LENGTH = 2000;
        const offset = Math.max(1, action.offset || 1);
        const limit = action.limit || MAX_LINES;
        const startIdx = offset - 1;
        const endIdx = Math.min(startIdx + limit, allLines.length);
        const selectedLines = allLines.slice(startIdx, endIdx);

        const numbered = selectedLines.map((line, i) => {
          const lineNum = String(startIdx + i + 1).padStart(5);
          const truncated = line.length > MAX_LINE_LENGTH
            ? line.substring(0, MAX_LINE_LENGTH) + '...'
            : line;
          return `${lineNum} ${truncated}`;
        }).join('\n');

        const wasTruncated = endIdx < allLines.length && !action.limit;

        return {
          success: true,
          path: filePath,
          type: 'pdf',
          totalPages,
          pagesRead: pagesToRead.join(', '),
          content: numbered,
          totalLines: allLines.length,
          from: offset,
          to: endIdx,
          ...(wasTruncated && { truncated: true, hint: `PDF text has ${allLines.length} lines. Use offset/limit to read more.` }),
          ...(!action.pages && totalPages > MAX_PDF_PAGES && { hint: `PDF has ${totalPages} pages but only first ${MAX_PDF_PAGES} were read. Use "pages" field (e.g. "1-5") to read specific pages.` })
        };
      } catch (err) {
        return { success: false, error: `Failed to read PDF: ${err.message}${err.stack ? '\n' + err.stack.split('\n').slice(0, 3).join('\n') : ''}` };
      }
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const allLines = content.split('\n');

    const MAX_LINES = 2000;
    const MAX_LINE_LENGTH = 2000;

    const offset = Math.max(1, action.offset || 1);
    const limit = action.limit || MAX_LINES;
    const startIdx = offset - 1;
    const endIdx = Math.min(startIdx + limit, allLines.length);
    const selectedLines = allLines.slice(startIdx, endIdx);

    // Format with line numbers, truncating long lines
    const numbered = selectedLines.map((line, i) => {
      const lineNum = String(startIdx + i + 1).padStart(5);
      const truncated = line.length > MAX_LINE_LENGTH
        ? line.substring(0, MAX_LINE_LENGTH) + '...'
        : line;
      return `${lineNum} ${truncated}`;
    }).join('\n');

    const wasTruncated = endIdx < allLines.length && !action.limit;

    // If this file is the active working-area document and the GUI has
    // published a cursor/selection, attach it so the agent knows where the
    // user is pointing ("change this"). Only included for text-like types
    // the user can actually edit in place.
    let editor = null;
    try {
      const { openDocumentsStore } = await import('../../state/open-documents-store.js');
      const doc = openDocumentsStore.findByPathOrUrl(resolvedPath) ||
                  openDocumentsStore.findByPathOrUrl(filePath);
      if (doc && (doc.selectionStart != null || doc.selectionEnd != null)) {
        editor = _describeEditorSelection(content, doc.selectionStart, doc.selectionEnd);
      }
    } catch { /* store unavailable — ignore */ }

    return {
      success: true,
      path: filePath,
      content: numbered,
      totalLines: allLines.length,
      from: offset,
      to: endIdx,
      ...(editor && { editor }),
      ...(wasTruncated && { truncated: true, hint: `File has ${allLines.length} lines. Use offset/limit to read more.` })
    };
  }
};

/**
 * Convert a (start, end) character-offset pair from the GUI text editor
 * into a human-readable cursor/selection block the LLM can reason about.
 * Returns an object with 1-based line/column coordinates, the selected
 * text (truncated for large selections), and a short `summary` string
 * that can be shown inline or read alone.
 */
function _describeEditorSelection(content, start, end) {
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  const len = content.length;
  const lo = Math.max(0, Math.min(start, end, len));
  const hi = Math.max(0, Math.min(Math.max(start, end), len));

  const offsetToLineCol = (offset) => {
    let line = 1;
    let col = 1;
    for (let i = 0; i < offset; i++) {
      if (content.charCodeAt(i) === 10 /* \n */) {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return { line, col };
  };

  const startPos = offsetToLineCol(lo);
  if (lo === hi) {
    return {
      type: 'cursor',
      line: startPos.line,
      column: startPos.col,
      summary: `User's caret is at line ${startPos.line}, column ${startPos.col}. No text is selected; when the user says "here" or "this line" they mean that position.`,
    };
  }

  const endPos = offsetToLineCol(hi);
  const MAX_SNIPPET = 500;
  let snippet = content.slice(lo, hi);
  const truncated = snippet.length > MAX_SNIPPET;
  if (truncated) snippet = snippet.slice(0, MAX_SNIPPET) + '…';

  const sameLine = startPos.line === endPos.line;
  const rangeDesc = sameLine
    ? `line ${startPos.line}, columns ${startPos.col}–${endPos.col}`
    : `line ${startPos.line} col ${startPos.col} → line ${endPos.line} col ${endPos.col}`;

  return {
    type: 'selection',
    startLine: startPos.line,
    startColumn: startPos.col,
    endLine: endPos.line,
    endColumn: endPos.col,
    selectedText: snippet,
    truncated,
    summary:
      `User has text selected: ${rangeDesc}. When they say "this", "esto", "change this", ` +
      `"replace this", or refer to something without naming it, they mean the SELECTED text below. ` +
      `Selected text${truncated ? ' (truncated)' : ''}:\n"""${snippet}"""`,
  };
}
