/**
 * tag_media — pin a `@mention` handle on a media-library item so the agent
 * (and the user) can reference it by name in future turns.
 *
 * Same plumbing the GUI uses when the user right-clicks a thumbnail and
 * picks "Set @mention" (`MediaLibrary.setMention`). Exposing it as an
 * action lets the agent build up a vocabulary of named references —
 * "@tom" for the Tom Cruise headshot it just generated, "@castle" for a
 * recurring scene, etc. — so a later turn can write
 * `referenceImages: ['@tom']` (resolved by the runtime through
 * `MediaLibrary.findByMention()`) instead of re-passing the raw file
 * path. Critical for multi-turn consistency: once the agent (or user)
 * has named something, that handle becomes the stable identity across
 * generations, edits, swaps and re-renders.
 *
 * Mentions live in `metadata_json.mention` on the LanceDB row. They are
 * lowercase-normalised + leading-`@` stripped at write time, matching
 * the GUI's autocomplete contract.
 *
 * Auto-registration: when `mediaPath` points at a file the library
 * doesn't know about yet (typical for in-cwd artefacts the agent just
 * wrote — scripts, prompts, draft markdown), this tool registers it
 * IN-PLACE first (no copy: `MediaLibrary.registerInPlace`) and then
 * pins the mention. So tagging a freshly-generated `outline.md` is a
 * single call.
 *
 * Idempotent: setting the same handle twice is a no-op. Passing an empty
 * string CLEARS the mention (the agent can rename: clear + re-set on
 * the new owner).
 */
import fs from 'node:fs';
import { MediaLibrary } from '../../state/media-library.js';
import { channel } from '../../io/channel.js';

export default {
  type: 'tag_media',
  intent: 'tag_media',
  description:
    'Pin a `@mention` handle on a media-library item (image / video / audio / ' +
    'document) so future turns can reference it by name. Mirrors the GUI\'s ' +
    'right-click "Set @mention" affordance — agents and users share the ' +
    'same handle space, so a tag the agent sets is immediately usable in ' +
    'the chat input\'s `@` autocomplete and as a `referenceImages: ' +
    '["@name"]` argument to generate_image / generate_video. Mentions are ' +
    'cross-project (the library lives at `~/.koi/media-library/`).\n\n' +
    'WHEN TO CALL — pin a handle the moment a freshly-generated (or imported) ' +
    'asset will need to be re-referenced later. Examples:\n' +
    '  • You generated a hero portrait — tag it `@tom` so subsequent ' +
    '"draw @tom riding a horse" prompts resolve to the same face.\n' +
    '  • You produced an environment plate — tag it `@castle` so future ' +
    'shots can pull it as a reference image.\n' +
    '  • You created a voice clone — tag it `@narrator` so generate_audio ' +
    '(speech mode) calls land on the same voice.\n' +
    '  • You wrote a script / outline / shotlist into the working dir — ' +
    'tag it `@hero_script` so later turns can read it back without ' +
    'remembering the filename. The file STAYS where you wrote it; the ' +
    'cajón just indexes the path.\n\n' +
    'Auto-registration: if `mediaPath` is a real file but the library ' +
    'has no row for it yet (typical for in-cwd artefacts you just ' +
    'created — `outline.md`, `prompts.json`, etc.), this tool registers ' +
    'it in-place (no copy, no move) before pinning the mention. The ' +
    'mediaType is detected from the extension (image / video / audio / ' +
    'document — anything text-readable becomes `document`).\n\n' +
    'Inputs: `mediaPath` (absolute path to the file — preferred) OR ' +
    '`mediaId` (LanceDB row id, useful when you already have it from a ' +
    'previous tool result). `mention` (the bare handle, with or without ' +
    'a leading `@` — case-insensitive). Pass `mention: ""` to CLEAR ' +
    'an existing mention. Optional `summary` — one short sentence ' +
    'describing what the asset is, useful for documents so the drawer ' +
    'and future agents see context without opening the file.\n\n' +
    'Returns `{success, mediaId, mention, previousMention, mediaType, ' +
    'registered}`. `registered: true` means we just catalogued the file; ' +
    '`previousMention` surfaces any handle that was overwritten.',
  thinkingHint: 'Tagging media',
  permission: null,
  hidden: false,

  schema: {
    type: 'object',
    properties: {
      mediaPath: {
        type: 'string',
        description:
          'Absolute path to the media file in the gallery (e.g. ' +
          '`/Users/.../.koi/images/foo.png`). Preferred over `mediaId` ' +
          'because tool results across the runtime expose paths, not row ' +
          'ids. Resolved through `MediaLibrary.getByPath`. Either this ' +
          'OR `mediaId` is required.',
      },
      mediaId: {
        type: 'string',
        description:
          'LanceDB row id of the media item, when known (e.g. carried ' +
          'over from a previous `recall_image` result). Either this OR ' +
          '`mediaPath` is required; `mediaPath` wins if both are set.',
      },
      mention: {
        type: 'string',
        description:
          'The handle to pin. May include a leading `@` (stripped) and ' +
          'mixed case (lowercased on store). Examples: "tom", "@tom", ' +
          '"Castle". Use ASCII letters, digits, `_`, `-` for ' +
          'compatibility with the GUI\'s `@` autocomplete regex. ' +
          'Pass an empty string to CLEAR the existing mention.',
      },
      summary: {
        type: 'string',
        description:
          'Optional one-sentence description of what the asset is, ' +
          'stored in metadata for the drawer and visible to future ' +
          'agents. Particularly useful for documents (the drawer shows ' +
          'it under the filename) but works for any media. Skip when ' +
          'the file is self-explanatory.',
      },
    },
    required: ['mention'],
  },

  examples: [
    {
      actionType: 'direct',
      intent: 'tag_media',
      mediaPath: '/Users/me/.koi/images/image_1778341415770.png',
      mention: 'tom',
    },
    {
      actionType: 'direct',
      intent: 'tag_media',
      mediaId: 'img_a3f9c2',
      mention: '@castle',
    },
    {
      actionType: 'direct',
      intent: 'tag_media',
      mediaPath: '/Users/me/.koi/images/foo.png',
      mention: '',
    },
  ],

  async execute(action) {
    const { mediaPath, mediaId, summary } = action;
    const mention = action.mention == null ? '' : String(action.mention);

    if (!mediaPath && !mediaId) {
      return {
        success: false,
        error: 'tag_media: either `mediaPath` or `mediaId` is required.',
      };
    }

    const lib = MediaLibrary.global();
    if (!lib) {
      return {
        success: false,
        error:
          'tag_media: media library is not available in this session. ' +
          'Mentions can only be pinned when the runtime has a writable ' +
          'LanceDB at `~/.koi/media-library`.',
      };
    }

    let row = null;
    if (mediaPath) {
      try {
        row = await lib.getByPath(mediaPath);
      } catch (err) {
        return {
          success: false,
          error: `tag_media: getByPath("${mediaPath}") failed: ${err.message}`,
        };
      }
    }

    // Auto-registration path: caller gave us a real file the library
    // doesn't know about yet. Index it in-place (no copy) so the mention
    // has a row to land on. Skips when the agent passed a `mediaId`
    // alone (no file to inspect) — that path stays validation-only.
    let registered = false;
    let mediaType = row?.mediaType;
    if (!row && mediaPath) {
      try {
        if (!fs.existsSync(mediaPath)) {
          return {
            success: false,
            error:
              `tag_media: file does not exist at "${mediaPath}". Pass an ` +
              'absolute path to a real file (or a `mediaId` for an item ' +
              'the library already knows about).',
          };
        }
        const reg = await lib.registerInPlace(mediaPath, {
          // Mention itself is set by `setMention` below — keeping it out
          // of the registration metadata avoids racing the two writes.
          summary: typeof summary === 'string' ? summary : undefined,
          // Hint the source so a later GC pass knows this row points at
          // a cwd file (vs. a curated `~/.koi/...` artefact).
          source: 'agent-tag',
        });
        registered = reg.isNew;
        row = reg.item;
        mediaType = reg.mediaType;
      } catch (err) {
        return {
          success: false,
          error: `tag_media: registerInPlace("${mediaPath}") failed: ${err.message}`,
        };
      }
    }

    // When the caller passes a raw `mediaId` we don't try to fetch the
    // row first — the public `MediaLibrary.list()` API doesn't accept an
    // id filter, so the only way to validate would be a full scan.
    // `setMention` itself does the existence check (returns false on
    // a missing row) so we trust it as the source of truth.
    const targetId = (row && row.id) || mediaId;
    if (!targetId) {
      return {
        success: false,
        error: `tag_media: media-library row "${mediaId}" not found.`,
      };
    }

    const previousMention = (row && typeof row.mention === 'string') ? row.mention : '';

    const ok = await lib.setMention(targetId, mention);
    if (!ok) {
      return {
        success: false,
        error: `tag_media: setMention(${targetId}) returned false. The row may have been deleted underneath us.`,
      };
    }

    // Normalise for the response — same rules `setMention` applies on disk.
    let normalized = mention.trim();
    if (normalized.startsWith('@')) normalized = normalized.slice(1);
    normalized = normalized.toLowerCase();

    channel.log(
      'media-library',
      `tag_media: ${targetId} (${mediaType || 'unknown'}) mention "${previousMention}" → "${normalized || '(cleared)'}"${registered ? ' [registered]' : ''}`,
    );

    return {
      success: true,
      mediaId: targetId,
      mediaType: mediaType || row?.mediaType,
      mention: normalized,
      previousMention,
      cleared: normalized.length === 0,
      registered,
    };
  },
};
