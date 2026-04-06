/**
 * message-builder.js — helpers extracted from LLMProvider.executePlaybookReactive
 * for preparing messages before sending them to an LLM provider.
 */

import fs from 'fs';
import path from 'path';
import { channel } from '../io/channel.js';
import { getModelCaps } from './cost-center.js';

// ────────────────────────────────────────────────────────────────────────────
// 1. Image optimization
// ────────────────────────────────────────────────────────────────────────────

const _MAX_IMG_DIM = 1568;

/**
 * Resize / compress an image before sending to an LLM.
 * Small images (< 200 KB) are passed through as-is.
 * Larger images are resized (max 1568px) and converted to JPEG via sharp.
 *
 * @param {string} imgPath — absolute path to the image file
 * @returns {Promise<{mime: string, b64: string}|null>}
 */
export async function optimizeImage(imgPath) {
  try {
    const raw = fs.readFileSync(imgPath);
    const ext = path.extname(imgPath).toLowerCase().slice(1);
    const isJpeg = ext === 'jpg' || ext === 'jpeg';
    if (raw.length < 200_000) {
      return { mime: isJpeg ? 'image/jpeg' : `image/${ext}`, b64: raw.toString('base64') };
    }
    let optimized = raw;
    let mime = isJpeg ? 'image/jpeg' : `image/${ext}`;
    try {
      const sharp = (await import('sharp')).default;
      optimized = await sharp(raw).resize(_MAX_IMG_DIM, _MAX_IMG_DIM, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      mime = 'image/jpeg';
    } catch {}
    channel.log('llm', `[image] Optimized ${path.basename(imgPath)}: ${(raw.length/1024).toFixed(0)}KB → ${(optimized.length/1024).toFixed(0)}KB (${mime})`);
    return { mime, b64: optimized.toString('base64') };
  } catch { return null; }
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Attachment resolution
// ────────────────────────────────────────────────────────────────────────────

/**
 * Walk through `messages` and resolve any `attachments` arrays into
 * provider-specific multimodal content blocks.  The `attachments` field is
 * deleted from each message (LLM APIs don't understand it).
 *
 * Mutates `messages` in place and returns the list of attached file paths
 * (useful for debug logging).
 *
 * @param {Array} messages — the conversation messages array (mutated)
 * @param {string} provider — 'anthropic' | 'openai' | etc.
 * @returns {Promise<string[]>} — debug list of attached image paths
 */
export async function resolveAttachments(messages, provider) {
  const debugPaths = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.attachments?.length) continue;

    const imageAtts = msg.attachments.filter(a =>
      a.type === 'image' && a.path && fs.existsSync(a.path)
    );

    // Remove attachments field (LLM API doesn't understand it)
    delete msg.attachments;

    if (imageAtts.length === 0) continue;

    const textContent = typeof msg.content === 'string' ? msg.content : '';
    const imageParts = (await Promise.all(
      imageAtts.map(async a => {
        const opt = await optimizeImage(a.path);
        return opt ? { ...opt, path: a.path } : null;
      })
    )).filter(Boolean);

    if (imageParts.length === 0) continue;

    if (provider === 'anthropic') {
      messages[i] = {
        role: msg.role,
        content: [
          ...imageParts.map(p => ({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.b64 } })),
          { type: 'text', text: textContent }
        ]
      };
    } else {
      messages[i] = {
        role: msg.role,
        content: [
          { type: 'text', text: textContent },
          ...imageParts.map(p => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.b64}` } }))
        ]
      };
    }
    debugPaths.push(...imageParts.map(p => p.path));
  }

  return debugPaths;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. MCP image injection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Inject pending MCP tool-result images (e.g. get_screenshot) into the
 * last user message as multimodal content blocks.
 *
 * Mutates `messages` in place.  Returns debug paths for logging.
 *
 * @param {Array} messages — the conversation messages array (mutated)
 * @param {Array|null|undefined} pendingMcpImages — session._pendingMcpImages
 * @param {string} provider — 'anthropic' | 'openai' | etc.
 * @returns {string[]} — debug paths of injected images
 */
export function injectMcpImages(messages, pendingMcpImages, provider) {
  const debugPaths = [];

  if (!pendingMcpImages?.length) return debugPaths;

  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
  if (lastUserIdx < 0) return debugPaths;

  const existing = messages[lastUserIdx].content;
  const textContent = typeof existing === 'string' ? existing
    : Array.isArray(existing) ? existing.find(p => p.type === 'text')?.text ?? '' : '';

  if (provider === 'anthropic') {
    messages[lastUserIdx] = {
      role: 'user',
      content: [
        ...pendingMcpImages.map(p => ({
          type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data }
        })),
        { type: 'text', text: textContent },
      ]
    };
  } else {
    // OpenAI / Gemini (OpenAI-compatible)
    messages[lastUserIdx] = {
      role: 'user',
      content: [
        { type: 'text', text: textContent },
        ...pendingMcpImages.map(p => ({
          type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` }
        })),
      ]
    };
  }

  if (process.env.KOI_DEBUG_LLM) {
    debugPaths.push(...pendingMcpImages.map(p => p._debugPath || `[${p.mimeType || 'image'}]`));
  }

  return debugPaths;
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Image pruning from old messages
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip image blocks from every message EXCEPT the last user message.
 * Prevents old screenshots from accumulating and wasting tokens.
 * User-provided images are always in the last user message, so they are preserved.
 *
 * Mutates `messages` in place.
 *
 * @param {Array} messages — the conversation messages array (mutated)
 */
export function pruneOldImages(messages) {
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
  let _pruned = 0;
  for (let i = 0; i < messages.length; i++) {
    if (i === lastUserIdx) continue; // keep current images
    const c = messages[i].content;
    if (!Array.isArray(c)) continue;
    const hasImages = c.some(p => p.type === 'image' || p.type === 'image_url');
    if (!hasImages) continue;
    // Strip image blocks, keep text
    const textOnly = c.filter(p => p.type === 'text');
    const imgCount = c.length - textOnly.length;
    _pruned += imgCount;
    const textContent = textOnly.map(p => p.text).join('\n');
    messages[i] = { role: messages[i].role, content: textContent + ` [${imgCount} image(s) pruned]` };
  }
  if (_pruned > 0 && process.env.KOI_DEBUG_LLM) {
    console.error(`[image-prune] Stripped ${_pruned} old image(s) from conversation history`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 5. Cache control injection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Add `cache_control` breakpoints to the system message for providers that
 * support prompt caching (Anthropic, Gemini via OpenRouter).
 * OpenAI handles caching server-side, so no breakpoints are injected there.
 *
 * Mutates `messages` in place.
 *
 * @param {Array} messages — the conversation messages array (mutated)
 * @param {string} model — the model identifier (used to look up caching caps)
 * @param {string} provider — 'anthropic' | 'openai' | etc.
 * @param {number} [cacheBoundary=0] — session._promptCacheBoundary, the split
 *   offset between static and dynamic portions of the system prompt.
 */
export function injectCacheControl(messages, model, provider, cacheBoundary = 0) {
  const _cacheCaps = getModelCaps(model);
  if (!_cacheCaps.supportsCaching || provider === 'openai') return;

  const _sysIdx = messages.findIndex(m => m.role === 'system');
  if (_sysIdx < 0) return;

  const _sysContent = messages[_sysIdx].content;

  if (typeof _sysContent === 'string' && cacheBoundary > 0) {
    // Cache-aware: split into static (cached) + dynamic (not cached) blocks.
    // The cache_control breakpoint after the static block tells the provider
    // to cache only the static prefix. Dynamic content changes every turn.
    const _staticBlock = _sysContent.substring(0, cacheBoundary);
    const _dynamicBlock = _sysContent.substring(cacheBoundary);
    messages[_sysIdx] = {
      role: 'system',
      content: [
        { type: 'text', text: _staticBlock, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: _dynamicBlock },
      ],
    };
  } else if (typeof _sysContent === 'string') {
    // No boundary — cache the entire system message as a single block
    messages[_sysIdx] = {
      role: 'system',
      content: [{ type: 'text', text: _sysContent, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    };
  } else if (Array.isArray(_sysContent)) {
    // Already an array — add cache_control to the last text block
    const _lastText = _sysContent.map(p => p.type).lastIndexOf('text');
    if (_lastText >= 0) {
      _sysContent[_lastText] = { ..._sysContent[_lastText], cache_control: { type: 'ephemeral', ttl: '1h' } };
    }
  }
}
