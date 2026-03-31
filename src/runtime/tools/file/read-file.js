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
      path: { type: 'string', description: 'File path to read' },
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
    const filePath = action.path;
    if (!filePath) throw new Error('read_file: "path" field is required');

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
      // Queue the image for the next LLM turn as a vision input.
      // Uses session._pendingImages which llm-provider.js injects into the
      // next LLM message as multimodal content (base64 image blocks).
      const session = agent?._activeSession;
      if (session) {
        if (!session._pendingImages) session._pendingImages = [];
        session._pendingImages.push({ path: resolvedPath });
        channel.log('read_file', `Image queued for vision: ${filePath}`);
        return {
          success: true,
          path: filePath,
          type: 'image',
          message: `Image loaded and attached for visual analysis. You will see the image on your next response — describe what you see or answer questions about it.`
        };
      }
      // Fallback: no agent available, return base64 directly
      const b64 = fs.readFileSync(resolvedPath).toString('base64');
      const ext = path.extname(resolvedPath).toLowerCase().slice(1);
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
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
        // Try direct import first (works in pkg binary and when pdfjs-dist is a
        // direct dependency). Fall back to createRequire from cwd (works when this
        // module is symlinked via npm link and pdfjs-dist lives in the host project).
        let pdfjsLib;
        try {
          pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        } catch {
          const { createRequire } = await import('module');
          const _require = createRequire(path.join(process.cwd(), '__placeholder.js'));
          const pdfjsPath = _require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
          pdfjsLib = await import(pdfjsPath);
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

        // Extract text from selected pages, preserving line breaks.
        // pdfjs items have a transform matrix where [5] is the Y coordinate.
        // When Y changes between items, it means a new line in the PDF layout.
        const pageTexts = [];
        for (const pageNum of pagesToRead) {
          const page = await doc.getPage(pageNum);
          const textContent = await page.getTextContent();
          const items = textContent.items.filter(i => i.str !== undefined);
          if (!items.length) {
            const images = await extractPdfPageImages(page, pdfjsLib);
            if (images.length) {
              const cachePath = path.join(os.homedir(), '.koi', 'tesseract-data');
              if (!fs.existsSync(cachePath)) {
                fs.mkdirSync(cachePath, { recursive: true });
              }
              for (const image of images) {
                const pngBuffer = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }).png().withMetadata({ density: 300 }).toBuffer();
                const { data } = await Tesseract.recognize(pngBuffer, 'eng', { cachePath, user_defined_dpi: '300' });
                const ocrText = data?.text ? data.text.trim() : '';
                if (ocrText) {
                  pageTexts.push(`--- Page ${pageNum} (OCR) ---\n${ocrText}`);
                }
              }
            }
            continue;
          }

          let lines = [];
          let currentLine = '';
          let lastY = null;

          for (const item of items) {
            const y = item.transform ? item.transform[5] : null;
            if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
              // Y position changed — new line
              lines.push(currentLine);
              currentLine = item.str;
            } else {
              // Same line — append with space if needed
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

        const text = pageTexts.join('\n\n').trim();

        if (!text) {
          return { success: true, path: filePath, type: 'pdf', totalPages, content: '(No extractable text found in PDF — OCR was attempted but no text was recognized.)', hint: 'This PDF has no text layer. OCR was attempted but returned no text.' };
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
        return { success: false, error: `Failed to read PDF: ${err.message}` };
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

    return {
      success: true,
      path: filePath,
      content: numbered,
      totalLines: allLines.length,
      from: offset,
      to: endIdx,
      ...(wasTruncated && { truncated: true, hint: `File has ${allLines.length} lines. Use offset/limit to read more.` })
    };
  }
};
