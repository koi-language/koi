/**
 * Brave Search API provider implementation.
 * Uses the Brave Search REST API (no SDK — plain fetch).
 */

import { BaseSearch } from './base.js';

export class BraveSearch extends BaseSearch {
  /**
   * @param {string} apiKey - Brave Search API key
   */
  constructor(apiKey) {
    super(null, 'brave-search');
    this.apiKey = apiKey;
  }

  get providerName() { return 'brave'; }

  async search(query, opts = {}) {
    const count = Math.min(opts.count || 5, 10);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;

    const fetchOpts = {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': this.apiKey
      }
    };
    if (opts.abortSignal) fetchOpts.signal = opts.abortSignal;

    const res = await fetch(url, fetchOpts);
    if (!res.ok) {
      throw new Error(`Brave Search error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const results = (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description
    }));

    return { text: results.map(r => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n'), results, usage: { input: 0, output: 0 } };
  }
}
