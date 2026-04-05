/**
 * Image Info Action — Get metadata from a local image file.
 *
 * Returns width, height, aspect ratio, file size, format, and color depth
 * without requiring Python or external tools. Uses the image file headers
 * directly for fast, lightweight metadata extraction.
 *
 * Permission: 'read' (same as reading any file)
 */

import fs from 'fs';
import path from 'path';

export default {
  type: 'image_info',
  intent: 'image_info',
  description: 'Get metadata (dimensions, format, file size) from a local image file. Returns: { width, height, aspectRatio, fileSize, format, colorDepth }. Use this instead of shell/python for image dimensions.',
  thinkingHint: 'Reading image info',
  permission: 'read',

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the image file' },
    },
    required: ['path'],
  },

  async execute(params) {
    const filePath = params.path;
    if (!filePath) return { success: false, error: 'Missing "path" parameter' };
    if (!fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };

    try {
      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase().replace('.', '');
      const buffer = Buffer.alloc(32);
      const fd = fs.openSync(filePath, 'r');

      try {
        fs.readSync(fd, buffer, 0, 32, 0);
      } finally {
        fs.closeSync(fd);
      }

      let width = 0, height = 0, format = ext, colorDepth = 0;

      // PNG: bytes 0-7 = signature, 16-19 = width, 20-23 = height
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        format = 'png';
        width = buffer.readUInt32BE(16);
        height = buffer.readUInt32BE(20);
        const bitDepth = buffer[24];
        const colorType = buffer[25];
        const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
        colorDepth = bitDepth * channels;
      }
      // JPEG: bytes 0-1 = FF D8
      else if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
        format = 'jpeg';
        // Parse JPEG markers to find SOF
        const fullBuf = fs.readFileSync(filePath);
        let pos = 2;
        while (pos < fullBuf.length - 8) {
          if (fullBuf[pos] !== 0xFF) { pos++; continue; }
          const marker = fullBuf[pos + 1];
          const len = fullBuf.readUInt16BE(pos + 2);
          // SOF0-SOF3 markers contain dimensions
          if (marker >= 0xC0 && marker <= 0xC3) {
            colorDepth = fullBuf[pos + 4] * (fullBuf[pos + 9] || 3);
            height = fullBuf.readUInt16BE(pos + 5);
            width = fullBuf.readUInt16BE(pos + 7);
            break;
          }
          pos += 2 + len;
        }
      }
      // GIF: bytes 0-2 = GIF
      else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        format = 'gif';
        width = buffer.readUInt16LE(6);
        height = buffer.readUInt16LE(8);
        colorDepth = (buffer[10] & 0x07) + 1;
      }
      // WebP: bytes 0-3 = RIFF, 8-11 = WEBP
      else if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
               buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
        format = 'webp';
        // VP8 lossy
        if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x20) {
          const fullBuf = fs.readFileSync(filePath);
          // Frame header starts at byte 26
          if (fullBuf.length > 29) {
            width = (fullBuf[26] | (fullBuf[27] << 8)) & 0x3FFF;
            height = (fullBuf[28] | (fullBuf[29] << 8)) & 0x3FFF;
          }
        }
        // VP8L lossless
        else if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x4C) {
          const fullBuf = fs.readFileSync(filePath);
          if (fullBuf.length > 24) {
            const bits = fullBuf[21] | (fullBuf[22] << 8) | (fullBuf[23] << 16) | (fullBuf[24] << 24);
            width = (bits & 0x3FFF) + 1;
            height = ((bits >> 14) & 0x3FFF) + 1;
          }
        }
        colorDepth = 32;
      }
      // BMP: bytes 0-1 = BM
      else if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
        format = 'bmp';
        width = buffer.readInt32LE(18);
        height = Math.abs(buffer.readInt32LE(22));
        colorDepth = buffer.readUInt16LE(28);
      }

      // Compute aspect ratio
      let aspectRatio = '';
      if (width > 0 && height > 0) {
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
        const g = gcd(width, height);
        aspectRatio = `${width / g}:${height / g}`;
        // Simplify common ratios
        const r = width / height;
        if (Math.abs(r - 16 / 9) < 0.02) aspectRatio = '16:9';
        else if (Math.abs(r - 9 / 16) < 0.02) aspectRatio = '9:16';
        else if (Math.abs(r - 4 / 3) < 0.02) aspectRatio = '4:3';
        else if (Math.abs(r - 3 / 4) < 0.02) aspectRatio = '3:4';
        else if (Math.abs(r - 3 / 2) < 0.02) aspectRatio = '3:2';
        else if (Math.abs(r - 2 / 3) < 0.02) aspectRatio = '2:3';
        else if (Math.abs(r - 1) < 0.02) aspectRatio = '1:1';
      }

      const fileSizeKB = Math.round(stat.size / 1024);
      const fileSizeMB = (stat.size / (1024 * 1024)).toFixed(1);

      return {
        success: true,
        path: filePath,
        format,
        width,
        height,
        aspectRatio,
        colorDepth: colorDepth || undefined,
        fileSize: stat.size > 1024 * 1024 ? `${fileSizeMB} MB` : `${fileSizeKB} KB`,
        fileSizeBytes: stat.size,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
