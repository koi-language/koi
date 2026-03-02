/**
 * Web Fetch Action - Fetch a URL and return its content as text.
 *
 * Converts HTML to plain text (strips tags) so the LLM can read it.
 * For JSON APIs, returns the raw JSON.
 */

export default {
  type: 'web_fetch',
  intent: 'web_fetch',
  description: 'Fetch a URL and return its content as readable text. Strips HTML tags for web pages; returns raw content for JSON APIs. Use to read documentation, articles, or API responses.',
  permission: 'web_access',
  thinkingHint: (action) => {
    try { return `Fetching from ${new URL(action.url).hostname}`; } catch { return 'Fetching URL'; }
  },

  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      maxChars: { type: 'number', description: 'Maximum characters to return (default 8000)' }
    },
    required: ['url']
  },

  examples: [
    { intent: 'web_fetch', url: 'https://docs.flutter.dev/get-started/install' },
    { intent: 'web_fetch', url: 'https://api.github.com/repos/flutter/flutter/releases/latest' }
  ],

  async execute(action) {
    const url = action.url || action.data?.url;
    const maxChars = action.maxChars || action.data?.maxChars || 8000;

    if (!url) throw new Error('web_fetch: "url" is required');

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KoiAgent/1.0)',
        'Accept': 'text/html,application/json,*/*'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      return { success: false, status: res.status, error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();

    let text;
    if (contentType.includes('application/json')) {
      // Pretty-print JSON
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        text = raw;
      }
    } else {
      // Strip HTML tags and collapse whitespace
      text = raw
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

    const truncated = text.length > maxChars;
    return {
      success: true,
      url,
      contentType,
      text: truncated ? text.slice(0, maxChars) + '\n\n[truncated]' : text,
      chars: text.length,
      truncated
    };
  }
};
