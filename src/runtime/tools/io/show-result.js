import { channel } from '../../io/channel.js';
import fs from 'fs';

/**
 * show_result — Present a result to the user directly.
 * Opens the resource in whatever way the current channel/UI supports
 * (new tab in GUI, printed reference in CLI). Generic result presenter.
 */

export default {
  type: 'show_result',
  intent: 'show_result',
  description: 'Present a result to the user — a file, image, video, or URL. The UI opens it in the most appropriate way (new tab, preview, etc). Use when you want to proactively surface a result instead of waiting for the user to click.',
  instructions: `Use show_result when the main output of a task is a file, image, video, or URL that the user should see immediately.

Examples:
- After generating an image: show_result with resourceType=image and the path
- After generating a video: show_result with resourceType=video and the path
- After creating/modifying a file: show_result with resourceType=file and the path
- When presenting a webpage as a result: show_result with resourceType=url

Do NOT use for every file path mentioned in a response — only for the primary result(s) the user is expected to see.`,
  thinkingHint: 'Presenting result',
  permission: null,
  hidden: () => process.env.KOI_EXIT_ON_COMPLETE === '1',

  schema: {
    type: 'object',
    properties: {
      resourceType: {
        type: 'string',
        enum: ['file', 'image', 'video', 'url'],
        description: 'Type of resource: "file" for text/code, "image" for images, "video" for videos, "url" for web pages',
      },
      path: {
        type: 'string',
        description: 'Absolute file path (required when resourceType is "file", "image" or "video")',
      },
      url: {
        type: 'string',
        description: 'URL to open (required when resourceType is "url")',
      },
      title: {
        type: 'string',
        description: 'Optional custom title',
      },
    },
    required: ['resourceType'],
  },

  examples: [
    { type: 'show_result', resourceType: 'image', path: '/tmp/braxil-images/generated-123.png' },
    { type: 'show_result', resourceType: 'video', path: '/Users/me/.koi/videos/video_1234_abc.mp4' },
    { type: 'show_result', resourceType: 'file', path: '/Users/me/project/src/config.ts' },
    { type: 'show_result', resourceType: 'url', url: 'https://example.com/article' },
  ],

  async execute(action) {
    // Accept several field names the LLM might use.
    const resourceType = action.resourceType || action.kind || action.mediaType;
    const path = action.path;
    const url = action.url;
    const title = action.title;

    if (!resourceType) {
      return { success: false, error: 'Missing "resourceType" field (file|image|video|url)' };
    }

    const needsPath = resourceType === 'file' || resourceType === 'image' || resourceType === 'video';
    if (needsPath && !path) {
      return { success: false, error: `resourceType=${resourceType} requires "path"` };
    }
    if (resourceType === 'url' && !url) {
      return { success: false, error: 'resourceType=url requires "url"' };
    }

    // Verify file exists for file/image/video types
    if (needsPath && !fs.existsSync(path)) {
      return { success: false, error: `File not found: ${path}` };
    }

    if (channel.canPresentResources()) {
      channel.presentResource({ type: resourceType, path, url, title });
      return { success: true, shown: resourceType, target: path || url };
    }

    // CLI fallback — mention the resource so user sees it
    channel.print(`\x1b[2m→ ${resourceType}: ${path || url}\x1b[0m`);
    return { success: true, shown: resourceType, target: path || url, note: 'CLI mode — printed reference only' };
  },
};
