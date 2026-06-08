/**
 * Built-in media provider profiles.
 *
 * A profile supplies a `media` mapping (see docs/mcp-media-facade.md) for a
 * known MCP server that doesn't declare its own `media` block in .mcp.json.
 * The media resolver tries each profile's `match(name, client)` in order.
 *
 * Each profile: { name, label, match(name, client) → bool, media }.
 */

import { magnificProfile } from './magnific.js';

export const PROFILES = [
  magnificProfile,
];
