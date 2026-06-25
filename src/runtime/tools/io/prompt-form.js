import { channel } from '../../io/channel.js';
import { isExitOnComplete, blockedChatInteraction } from '../../util/interactivity.js';

/**
 * Prompt Form Action - Multi-step form wizard for collecting multiple fields.
 *
 * Renders a wizard with:
 *   - A top navigation bar showing all field names + current position
 *   - One question per screen (text input or select menu)
 *   - A final review/submit screen
 *
 * Use this instead of calling prompt_user multiple times.
 * Returns: { answers: { [fieldLabel]: string } }
 */

const FILE_FIELD_KEYWORDS = /(\battach(?:es|ed|ment|ments|ing)?\b|\bupload(?:s|ed|ing)?\b|\bdrop\s+(?:a|any|the|some|your)?\s*(?:file|image|photo|picture|logo|screenshot|reference|ref|moodboard)|\bphotos?\b|\bimages?\b|\bpictures?\b|\bimágenes?\b|\bimagen(?:es)?\b|\bfotos?\b|\blogos?\b|\bscreenshots?\b|\bmood[\s-]?board\b|(?:reference|visual|file)\s+(?:image|photo|picture|ref)s?\b|\bficheros?\b|\barchivos?\b|\badjunt[ae]r?\b)/i;

function looksLikeFileField(field) {
  const text = `${field.label || ''} | ${field.question || ''} | ${field.hint || ''}`;
  return FILE_FIELD_KEYWORDS.test(text);
}

export default {
  type: 'prompt_form',
  intent: 'prompt_form',
  description: 'Multi-step form wizard for collecting multiple pieces of information. Shows one question at a time with a nav bar at the top, then a review/submit step. Use instead of multiple prompt_user calls. ALSO use this (even for a single question) when presenting technical options (tech stacks, frameworks, databases, etc.) because it supports "description" and "recommended" fields on each option — the user may not be technical. Any field can additionally carry a `files: { multiple?, extensions? }` config — when present, that step renders the inline file-picker (drop zone + Browse + thumbnails) instead of text/options, so you can ask for image/audio/video/document attachments in the same wizard. **Rule: if the field is asking the user to attach files or references of any kind, ALWAYS set `files`. Never a plain text field for attachments.** (If you forget, the runtime tries to detect the intent and auto-coerce — do not rely on that.) Returns: { answers: { [fieldLabel]: string | string[] } } (string for text/single-select fields, array of selected values for `multiSelect` fields, array of absolute paths for `files` fields). If the user closes the form without submitting, returns { answers: null, cancelled: true }.',
  thinkingHint: 'Waiting for your input',
  permission: null,
  // Headless `--exit` (unattended one-shot): no UI to render the form into and
  // no user to submit it — blocking on channel.form() hangs forever. Hide it
  // from the agent in that mode (execute() guards the path too). A live YOLO
  // chat tab keeps it visible: there the form renders and a user is present.
  hidden: () => isExitOnComplete(),

  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Optional form title shown in the scroll area before the form opens'
      },
      fields: {
        type: 'array',
        description: 'Ordered list of fields to collect.',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: 'Short name shown in the top nav bar (e.g. "Gateway ID"). Keep it concise — max ~12 chars.'
            },
            question: {
              type: 'string',
              description: 'The full question text shown to the user (e.g. "What is your Coinflow Gateway ID?"). Defaults to label if not provided.'
            },
            hint: {
              type: 'string',
              description: 'Optional hint line shown below the question (e.g. "Found in dashboard → Settings → API")'
            },
            options: {
              type: 'array',
              description: 'If provided, shows a select menu instead of free text. Single-select by default (user picks one with ↑↓ + Enter); set the field\'s `multiSelect: true` for a checkbox list. `label`/`description` text may contain markdown links — they render clickable.',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Option label (bold in the list)' },
                  description: { type: 'string', description: 'Optional description shown below the title in dim text (may contain markdown links)' },
                  value: { type: 'string', description: 'The value returned when this option is selected. Defaults to title if not set.' },
                  recommended: { type: 'boolean', description: 'Show "(Recommended)" after the title' },
                  disabled: { type: 'boolean', description: 'Render this option greyed-out and untoggleable (multiSelect fields only — e.g. an interaction the platform has turned off).' }
                },
                required: ['title']
              }
            },
            multiSelect: {
              type: 'boolean',
              description: 'When true AND `options` is set, render a CHECKBOX LIST — the user can pick several at once. The submitted value for this field is an array of the selected option `value`s. Default: false (single-select radio).'
            },
            allowFreeText: {
              type: 'boolean',
              description: 'When options are provided, also append a "Type something." free-text entry at the bottom. Default: false.'
            },
            files: {
              type: 'object',
              description: 'When present, this field renders the inline file-picker (drop zone + Browse + thumbnails) instead of a text input or select. Use to ask the user to attach images, audio, video, PDFs, etc. The answer for this field is an array of absolute paths. Mutually exclusive with `options` — supplying both is a contract error.',
              properties: {
                multiple: {
                  type: 'boolean',
                  description: 'Allow more than one file. Default: true.'
                },
                extensions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional whitelist of extensions WITHOUT the leading dot. When set, the native browse dialog filters by these and the drop zone rejects files outside the list. For IMAGE inputs always include iPhone formats — use ["jpg","jpeg","png","webp","heic","heif"] (the GUI auto-normalises HEIC/HEIF to PNG before upload, so models that don\'t speak HEIC still get a clean PNG). Skipping heic/heif means iPhone screenshots are silently rejected at drop time.'
                }
              }
            }
          },
          required: ['label']
        }
      }
    },
    required: ['fields']
  },

  examples: [
    {
      intent: 'prompt_form',
      title: 'A few details before I can plan the Coinflow integration:',
      fields: [
        {
          label: 'Integration',
          question: 'How should Coinflow be integrated?',
          hint: 'React SDK requires a React app; Hosted Link needs no JS',
          options: [
            { title: 'React SDK', description: 'Full checkout component — use when the app is React', recommended: true },
            { title: 'Hosted Checkout Link', description: 'Redirect to Coinflow-hosted page — works in any framework' },
            { title: 'Direct API', description: 'Custom low-level integration' }
          ],
          allowFreeText: false
        },
        {
          label: 'Environment',
          question: 'Which Coinflow environment should be used?',
          options: [
            { title: 'sandbox', description: 'Testing environment, no real money' },
            { title: 'production', description: 'Live environment' }
          ]
        },
        {
          label: 'Merchant ID',
          question: 'What is your Coinflow merchant ID?',
          hint: 'Found in Coinflow dashboard → Settings → API'
        }
      ]
    },
    {
      intent: 'prompt_form',
      title: 'A few details for the restaurant ad:',
      fields: [
        {
          label: 'Style',
          question: 'Visual style for the ad?',
          options: [
            { title: 'Photorealistic', recommended: true },
            { title: 'Stylized' }
          ]
        },
        {
          label: 'References',
          question: 'Drop a few reference photos of the restaurant.',
          hint: 'Dining room, plates, ambient. PNG/JPG.',
          files: { multiple: true, extensions: ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif'] }
        },
        {
          label: 'Voiceover',
          question: 'Pitch line for the narration:'
        }
      ]
    }
  ],

  async execute(action, agent) {
    // Backstop for the `hidden` gate above: in headless --exit mode a form can
    // never be answered, so fail loudly instead of hanging on channel.form().
    const _blocked = blockedChatInteraction('prompt_form');
    if (_blocked) return _blocked;

    const title = action.title || action.data?.title || '';
    const fields = action.fields || action.data?.fields || [];

    if (!Array.isArray(fields) || fields.length === 0) {
      return { error: 'prompt_form requires a non-empty "fields" array.' };
    }

    const coerced = [];
    const forcedMulti = [];
    for (const field of fields) {
      // ── Deterministic option normalization ──────────────────────────────
      // The schema asks for `options: [{ title, ... }]`, but the LLM very
      // often emits plain strings or objects keyed by `label`/`name`/`text`/
      // `value` instead of `title`. The renderer reads `option.title`, so any
      // other shape paints as numbered rows with NO text (the empty-options
      // bug). Coerce every option into `{ title, ... }` so the user always
      // sees the label regardless of which key the model chose.
      if (Array.isArray(field.options) && field.options.length > 0) {
        field.options = field.options.map((opt) => {
          if (typeof opt === 'string') return { title: opt, value: opt };
          if (opt && typeof opt === 'object') {
            let title = opt.title ?? opt.label ?? opt.name ?? opt.text ?? opt.value;
            if (title == null) {
              // Single hallucinated key — use the first primitive value, which
              // then doubles as both title and value (one attribute = both).
              title = Object.values(opt).find((v) => v != null && typeof v !== 'object');
            }
            const t = title != null ? String(title) : '';
            return { ...opt, title: t, value: opt.value != null ? opt.value : t };
          }
          return { title: String(opt ?? ''), value: String(opt ?? '') };
        }).filter((o) => o.title !== '');
      }

      // ── Deterministic file-field shape normalization ────────────────────
      // The runtime contract is `field.files = { multiple?, extensions? }`,
      // but the LLM frequently flattens it: `type: "files"` with `extensions`
      // and `multiple` sitting directly on the field. Rebuild the `files`
      // object from that flat shape so the picker (and its extension filter)
      // render instead of silently degrading to a text input.
      const _fieldType = typeof field.type === 'string' ? field.type.toLowerCase() : '';
      if (!field.files && (_fieldType === 'files' || _fieldType === 'file')) {
        field.files = {};
      }
      if (field.files && typeof field.files === 'object') {
        if (field.files.extensions == null && Array.isArray(field.extensions)) {
          field.files.extensions = field.extensions;
        }
        if (field.files.multiple == null && typeof field.multiple === 'boolean') {
          field.files.multiple = field.multiple;
        }
        // Extensions must be bare (no leading dot) per the browse-dialog
        // filter; the LLM often writes ".pdf", ".png". Strip + lowercase.
        if (Array.isArray(field.files.extensions)) {
          field.files.extensions = field.files.extensions
            .map((e) => String(e).replace(/^\.+/, '').toLowerCase())
            .filter(Boolean);
        }
      }

      let hasFiles = field.files && typeof field.files === 'object';
      const hasOptions = Array.isArray(field.options) && field.options.length > 0;
      if (!hasFiles && !hasOptions && looksLikeFileField(field)) {
        field.files = { multiple: true };
        hasFiles = true;
        coerced.push(field.label || field.question || '<unnamed>');
      }
      // Deterministic safety net: every files-field allows multiple
      // selections. The LLM frequently picks `multiple: false` for
      // "reference image for X" / "logo" / "screenshot" prompts where
      // the user actually has several variants to attach — and the GUI
      // dutifully replaces the prior pick instead of accumulating. The
      // single-file niche (e.g. "upload your profile picture") still
      // works fine when multiple is allowed: the user uploads one,
      // submits, the agent reads paths[0]. Inverse (forcing single
      // when user wants many) is the failure mode that actually
      // blocks work, so we err on the permissive side.
      if (hasFiles && field.files.multiple === false) {
        field.files.multiple = true;
        forcedMulti.push(field.label || field.question || '<unnamed>');
      }
    }
    if (coerced.length > 0) {
      console.warn(`[prompt_form] Auto-coerced text field(s) to file-picker because the label/question/hint matched file-attachment keywords: ${coerced.join(', ')}. Set "files" explicitly next time.`);
    }
    if (forcedMulti.length > 0) {
      console.warn(`[prompt_form] Forced multiple=true on files field(s) ${forcedMulti.join(', ')} — single-file file pickers block users who have multiple attachments to share. If you truly only need one, just use paths[0] from the response.`);
    }

    channel.clearProgress();

    // Print title to scroll area if provided (shown above the form overlay)
    if (title) {
      channel.print(title);
    }

    const answers = await channel.form(title, fields);

    if (!answers) {
      return { answers: null, cancelled: true };
    }

    return { answers };
  }
};
