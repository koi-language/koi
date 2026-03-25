/**
 * Tavily Search API provider implementation.
 * Uses the Tavily REST API (no SDK — plain fetch).
 */

import { BaseSearch } from './base.js';

export class TavilySearch extends BaseSearch {
  /**
   * @param {string} apiKey - Tavily API key
   */
  constructor(apiKey) {
    super(null, 'tavily-search');
    this.apiKey = apiKey;
  }

  get providerName() { return 'tavily'; }

  async search(query, opts = {}) {
    const count = Math.min(opts.count || 5, 10);

    const fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: count
      })
    };
    if (opts.abortSignal) fetchOpts.signal = opts.abortSignal;

    const res = await fetch('https://api.tavily.com/search', fetchOpts);
    if (!res.ok) {
      throw new Error(`Tavily error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const results = (data.results || []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content
    }));

    return { text: results.map(r => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n'), results, usage: { input: 0, output: 0 } };
  }
}
