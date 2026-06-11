import fs from 'fs';
import { channel } from './channel.js';
import { isNetworkError } from '../llm/is-network-error.js';

const DEFAULT_ATTEMPTS = 5;

/**
 * Classify a download failure as transport (`network`) vs server (`http`).
 * Single source of truth for "was the asset unreachable, or genuinely not
 * servable?" — shared by the buffered downloader and the streaming video path
 * so they never drift. Pass the thrown error (if any) and/or the last non-2xx
 * HTTP status observed.
 *
 * @param {object} a
 * @param {Error|null} [a.error]      the thrown transport error, if the attempt threw
 * @param {number|null} [a.httpStatus] the last non-2xx status, if the server answered
 * @returns {{errorClass:'network'|'http', status:number|null, message:string}}
 */
export function classifyDownloadFailure({ error = null, httpStatus = null } = {}) {
  // HTTP 4xx/5xx → the server answered, the asset is genuinely not servable.
  // A thrown transport error (incl. our own abort/timeout) or no response at
  // all → WE couldn't reach it. NEVER call a transport error a generation
  // failure: we do not actually know the asset is bad.
  const isNet = error ? (isNetworkError(error) || error.name === 'AbortError') : (httpStatus == null);
  if (!isNet && httpStatus != null) {
    return { errorClass: 'http', status: httpStatus, message: `HTTP ${httpStatus}` };
  }
  const code = error?.cause?.code || error?.code || error?.name || error?.message || 'no response';
  return { errorClass: 'network', status: null, message: `connectivity error (${code})` };
}

/**
 * Fetch a provider RESULT asset (image / video / audio) into a Buffer, with
 * retry + exponential backoff, and CLASSIFY any failure.
 *
 * The whole reason this exists: an asset the provider ALREADY generated but
 * that WE couldn't download is a transport problem (DNS, CDN reset, timeout),
 * NOT a generation failure. The two demand opposite recoveries — a transport
 * error means "retry the download, the asset exists, do not regenerate"; only
 * an HTTP 4xx/5xx means the result is genuinely not servable. Every media tool
 * routes its result-asset download through here so the behaviour is identical
 * and there is no copy-pasted retry / classify logic.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.kind='media']    channel log tag ('image'|'video'|'audio')
 * @param {number} [opts.timeoutMs=30000] per-attempt abort timeout
 * @param {number} [opts.attempts=5]
 * @param {AbortSignal} [opts.signal]     external cancel, composed with the timeout
 * @returns {Promise<{ok:true, buffer:Buffer, contentType:string}
 *   | {ok:false, errorClass:'network'|'http', status?:number, error?:Error, message:string}>}
 */
export async function fetchAssetBuffer(url, { kind = 'media', timeoutMs = 30000, attempts = DEFAULT_ATTEMPTS, signal } = {}) {
  let lastError = null;
  let lastHttpStatus = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      // Exponential backoff + jitter so a transient CDN blip (pikaso etc. have
      // ~30-90s windows where every connection is reset) gets ridden out
      // instead of exhausting the retries inside ~2s. 0, ~1s, ~2s, ~4s, ~8s.
      const backoff = Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, backoff));
    }
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (resp.ok) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        return { ok: true, buffer, contentType: resp.headers.get('content-type') || '' };
      }
      lastHttpStatus = resp.status;
      lastError = null;
      channel.log(kind, `Download HTTP ${resp.status} for ${url} (attempt ${attempt + 1}/${attempts})`);
      if (resp.status >= 400 && resp.status < 500) break; // 4xx won't recover on retry
    } catch (dlErr) {
      // Node's global fetch wraps the real reason as "fetch failed" and stashes
      // it on `.cause` (ECONNRESET, UND_ERR_CONNECT_TIMEOUT, ENOTFOUND/EAI_AGAIN
      // for DNS, TLS, IPv6 Happy-Eyeballs…). Surface the cause — without it we
      // can't tell a CDN outage from broken DNS from a dead socket.
      lastError = dlErr;
      const c = dlErr?.cause;
      channel.log(kind, `Failed to download ${url} (attempt ${attempt + 1}/${attempts}): ${dlErr.message}${c ? ` (cause: ${c.code || c.message || c})` : ''}`);
    } finally {
      clearTimeout(to);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  return { ok: false, error: lastError, ...classifyDownloadFailure({ error: lastError, httpStatus: lastHttpStatus }) };
}

/**
 * fetchAssetBuffer + write to disk. Returns the same classified shape; on
 * success adds `savedTo` + `bytes`.
 */
export async function downloadAssetToFile(url, filePath, opts = {}) {
  const r = await fetchAssetBuffer(url, opts);
  if (!r.ok) return r;
  fs.writeFileSync(filePath, r.buffer);
  channel.log(opts.kind || 'media', `Downloaded and saved: ${filePath} (${(r.buffer.length / 1024).toFixed(0)}KB)`);
  return { ok: true, savedTo: filePath, bytes: r.buffer.length, contentType: r.contentType };
}

/**
 * Standard tool result for "the provider produced it, but we couldn't fetch it".
 *
 * NETWORK → transient, retryable, explicitly NOT a generation failure: the
 * asset exists and credits were already spent, so the agent must NOT regenerate
 * — it must fix connectivity and retry the SAME call to re-download.
 * HTTP → the result URL is genuinely unusable.
 *
 * @param {object} a
 * @param {string} a.tool       e.g. 'generate_image'
 * @param {string} [a.provider]
 * @param {string} [a.model]
 * @param {string} a.url        the result URL we failed to download
 * @param {object} a.dl         the failure object from fetchAssetBuffer
 * @param {string} [a.noun='asset']  'image' | 'video' | 'audio clip' | …
 */
export function undownloadableResult({ tool, provider, model, url, dl, noun = 'asset' }) {
  const prov = provider || 'the provider';
  if (dl.errorClass === 'network') {
    return {
      success: false,
      tool, provider, model, url,
      networkError: true,   // transient connectivity — NOT a generation failure
      retryable: true,
      error: `The ${noun} WAS generated by ${prov} and exists at the result URL, but Koi could not download it because of a LOCAL network/DNS/CDN connectivity problem (${dl.message}). This is NOT a generation failure and the asset is not lost. Do NOT regenerate (it would waste credits) and do NOT report it as failed content — fix connectivity and re-issue the SAME call to re-download. URL: ${url}`,
    };
  }
  return {
    success: false,
    tool, provider, model, url,
    error: `The ${noun} was generated by ${prov} but the result URL returned ${dl.message} on every attempt and could not be retrieved. Nothing was saved. Re-issue the SAME call to retry.`,
  };
}
