/**
 * Web Search Action - Search the internet for up-to-date information.
 *
 * Supported providers (checked in order):
 *   - Brave Search  (BRAVE_SEARCH_API_KEY)
 *   - Tavily        (TAVILY_API_KEY)
 */

export default {
  type: 'web_search',
  intent: 'web_search',
  description: 'Search the internet for current information. Returns titles, URLs, and snippets. Use when you need up-to-date data beyond your training knowledge.',
  thinkingHint: 'Searching the web',
  permission: 'web_access',

  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      count: { type: 'number', description: 'Number of results (default 5, max 10)' }
    },
    required: ['query']
  },

  examples: [
    { intent: 'web_search', query: 'Flutter 3.x release notes' },
    { intent: 'web_search', query: 'how to configure CocoaPods for iOS', count: 3 }
  ],

  async execute(action) {
    const query = action.query || action.data?.query;
    const count = Math.min(Number(action.count || action.data?.count) || 5, 10);

    if (!query) throw new Error('web_search: "query" is required');

    if (process.env.BRAVE_SEARCH_API_KEY) {
      return searchBrave(query, count);
    }
    if (process.env.TAVILY_API_KEY) {
      return searchTavily(query, count);
    }

    return {
      success: false,
      error: 'No search API key configured. Set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY in your environment.'
    };
  }
};

async function searchBrave(query, count) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY
    }
  });

  if (!res.ok) {
    throw new Error(`Brave Search error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const results = (data.web?.results || []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description
  }));

  return { success: true, source: 'brave', query, results };
}

async function searchTavily(query, count) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: count
    })
  });

  if (!res.ok) {
    throw new Error(`Tavily error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const results = (data.results || []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.content
  }));

  return { success: true, source: 'tavily', query, results };
}
