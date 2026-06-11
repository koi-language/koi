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
  description: 'Open something in the user\'s work area (the panel beside the chat) — a file (.md/.txt/.pdf/.docx/.html/code), image, video, URL, or timeline. The UI picks the right viewer/editor by extension. THIS is how you let the user SEE a file: reading a file loads it into YOUR context only, it does NOT show it to the user. You can pass just a `path` (or `url`) — the type is inferred.',
  instructions: `Use show_result whenever the user should SEE something on disk or on the web — both when YOU produced it and when the user asks to view it.

ALWAYS call it (don't paste content into chat instead) when:
- The user asks to SEE / SHOW / OPEN / VIEW / "muéstrame" / "enséñame" / "ábreme" a file that exists (a .md report, a document, "el guion", "la secuencia", "los correos"…) → show_result resourceType=file + absolute path. read_file does NOT show it to the user.
- You created or modified a file the user wants to read → show_result resourceType=file + path.
- After generating an image / video → show_result with the path (type is auto-detected).
- Presenting a webpage as a result → show_result resourceType=url.
- After assembling a timeline (create_timeline + add_clip_to_timeline) and BEFORE rendering → show_result resourceType=timeline + timelineId (opens the editor to preview/scrub/mute).

You usually don't need read_file first — if you have the path, call show_result directly. Passing just \`path\` works; resourceType is optional.

Do NOT use for every file path mentioned in passing — only the primary result(s) the user is expected to see.`,
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
    let resourceType = action.resourceType || action.kind || action.mediaType;
    let resolvedPath = action.path || action.file || action.filePath;
    const url = action.url;
    const title = action.title;

    // Be forgiving: when the agent passes just a path (or url) without a
    // resourceType, infer it. The GUI routes any 'file' by extension anyway —
    // .md/.pdf/.txt/.html/.docx all open in their proper viewer — so the only
    // thing inference buys is not failing the call. Image/video get their
    // dedicated types so the inline chat preview is right.
    if (!resourceType) {
      if (resolvedPath) {
        const ext = path.extname(resolvedPath).toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.heic'].includes(ext)) resourceType = 'image';
        else if (['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'].includes(ext)) resourceType = 'video';
        else resourceType = 'file';
      } else if (url) {
        resourceType = 'url';
      }
    }

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
