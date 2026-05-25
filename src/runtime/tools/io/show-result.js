import { channel } from '../../io/channel.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * show_result — Present a result to the user directly.
 * Opens the resource in whatever way the current channel/UI supports
 * (new tab in GUI, printed reference in CLI). Generic result presenter.
 */

export default {
  type: 'show_result',
  intent: 'show_result',
  description: 'Present a result to the user — a file, image, video, URL, or timeline. The UI opens it in the most appropriate way (new tab, preview, editor, etc). Use when you want to proactively surface a result instead of waiting for the user to click.',
  instructions: `Use show_result when the main output of a task is a file, image, video, URL, or timeline that the user should see immediately.

Examples:
- After generating an image: show_result with resourceType=image and the path
- After generating a video: show_result with resourceType=video and the path
- After creating/modifying a file: show_result with resourceType=file and the path
- When presenting a webpage as a result: show_result with resourceType=url
- After assembling a timeline (create_timeline + add_clip_to_timeline calls) and BEFORE rendering: show_result with resourceType=timeline and timelineId — opens the timeline editor so the user can preview the cut, scrub, mute tracks, etc.

Do NOT use for every file path mentioned in a response — only for the primary result(s) the user is expected to see.`,
  thinkingHint: 'Presenting result',
  permission: null,
  hidden: () => process.env.KOI_EXIT_ON_COMPLETE === '1',

  schema: {
    type: 'object',
    properties: {
      resourceType: {
        type: 'string',
        enum: ['file', 'image', 'video', 'url', 'timeline'],
        description: 'Type of resource: "file" for text/code, "image" for images, "video" for videos, "url" for web pages, "timeline" for an editable timeline (opens the timeline editor tab).',
      },
      path: {
        type: 'string',
        description: 'Absolute file path (required when resourceType is "file", "image" or "video")',
      },
      url: {
        type: 'string',
        description: 'URL to open (required when resourceType is "url")',
      },
      timelineId: {
        type: 'string',
        description: 'Timeline id like "tl-XXXXXX" (required when resourceType is "timeline"). Resolved to <projectRoot>/.koi/timelines/<id>.json under the hood — passing the path directly via resourceType=file also works.',
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
    { type: 'show_result', resourceType: 'timeline', timelineId: 'tl-abc123' },
  ],

  async execute(action) {
    // Accept several field names the LLM might use.
    const resourceType = action.resourceType || action.kind || action.mediaType;
    let resolvedPath = action.path;
    const url = action.url;
    const title = action.title;

    if (!resourceType) {
      return { success: false, error: 'Missing "resourceType" field (file|image|video|url|timeline)' };
    }

    // Timeline → resolve the on-disk JSON. The Flutter side's
    // tabs_provider already routes any path matching
    // `<projectRoot>/.koi/timelines/<id>.json` to the timeline editor
    // (TimelineLibrary.isTimelinePath), so once we hand off a real
    // path the editor opens automatically. Accept either an explicit
    // `timelineId` or a bare `path` ending in /timelines/<id>.json.
    if (resourceType === 'timeline') {
      const id = action.timelineId || action.id;
      if (!id && !resolvedPath) {
        return { success: false, error: 'resourceType=timeline requires "timelineId" (or "path" to the timeline JSON)' };
      }
      if (id && !resolvedPath) {
        const projectRoot = process.env.KOI_PROJECT_ROOT || process.cwd() || os.homedir();
        resolvedPath = path.join(projectRoot, '.koi', 'timelines', `${id}.json`);
      }
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: `Timeline not found on disk: ${resolvedPath}` };
      }
      if (channel.canPresentResources()) {
        // 'file' is the type the GUI's openFile() routes — and it
        // already detects timeline-shaped paths and opens the editor
        // tab instead of a text view. No new channel surface needed.
        channel.presentResource({ type: 'file', path: resolvedPath, title });
        return { success: true, shown: 'timeline', target: resolvedPath };
      }
      channel.print(`\x1b[2m→ timeline: ${resolvedPath}\x1b[0m`);
      return { success: true, shown: 'timeline', target: resolvedPath, note: 'CLI mode — printed reference only' };
    }

    const needsPath = resourceType === 'file' || resourceType === 'image' || resourceType === 'video';
    if (needsPath && !resolvedPath) {
      return { success: false, error: `resourceType=${resourceType} requires "path"` };
    }
    if (resourceType === 'url' && !url) {
      return { success: false, error: 'resourceType=url requires "url"' };
    }

    // Verify file exists for file/image/video types
    if (needsPath && !fs.existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${resolvedPath}` };
    }

    if (channel.canPresentResources()) {
      channel.presentResource({ type: resourceType, path: resolvedPath, url, title });
      return { success: true, shown: resourceType, target: resolvedPath || url };
    }

    // CLI fallback — mention the resource so user sees it
    channel.print(`\x1b[2m→ ${resourceType}: ${resolvedPath || url}\x1b[0m`);
    return { success: true, shown: resourceType, target: resolvedPath || url, note: 'CLI mode — printed reference only' };
  },
};
