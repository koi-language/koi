/**
 * Web Search Action - Search the internet for up-to-date information.
 *
 * Delegates to the provider factory which auto-selects the best available
 * search provider: Brave Search → Tavily → OpenAI search model.
 */

import { resolve as resolveModel } from '../../llm/providers/factory.js';

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

    const resolved = resolveModel({ type: 'search', clients: {} });
    if (!resolved) {
      return {
        success: false,
        error: 'No search API key configured. Set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY in your environment.'
      };
    }

    const result = await resolved.instance.search(query, { count });
    return { success: true, source: resolved.instance.providerName, query, results: result.results };
  }
};
