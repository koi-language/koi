/**
 * Built-in media profile: Magnific / Freepik MCP.
 *
 * Maps Koi's media operations onto Magnific's MCP tools so a connected
 * Magnific server acts as a drop-in provider for generate_image and
 * upscale_image (Phase 1; video/audio/ops follow). See
 * docs/mcp-media-facade.md for the full design.
 *
 * Magnific is asynchronous + asset-registry based: generation tools return
 * a *creation identifier*, you long-poll `creations_wait` until terminal,
 * then read the full-res URL via `creations_get`. Local inputs (references,
 * the upscale source) must be uploaded first to become creations.
 *
 * NOTE: the exact RESPONSE field names below (identifier / url) are
 * best-effort from the tool docs and must be confirmed against a live
 * Magnific server — the resolver/adapter parse defensively, but the profile
 * is where any corrections belong.
 */

export const magnificProfile = {
  name: 'magnific',
  label: 'Magnific',

  // Recognise a Magnific server when it carries no explicit `media` block.
  // Match on the registry name OR the presence of Magnific's signature tools.
  match(name, client) {
    const n = (name || '').toLowerCase();
    if (n.includes('magnific') || n.includes('freepik')) return true;
    const tools = Array.isArray(client?.tools) ? client.tools.map(t => t.name) : [];
    if (!tools.length) return false;
    return tools.includes('images_generate') && tools.includes('creations_wait');
  },

  media: {
    label: 'Magnific',

    generate: {
      image: {
        tool: 'images_generate',
        promptParam: 'prompt',
        refsParam: 'references',
        aspectRatioParam: 'aspectRatio',
      },
      // Video is a DEFERRED job (submit → getStatus poll → fetch URL).
      video: {
        tool: 'video_generate',
        promptParam: 'video', // verify: video_generate takes the brief under `video`
      },
      audio: {
        speech: { tool: 'audio_tts', textParam: 'text' },
        music: { tool: 'audio_music_generate', promptParam: 'prompt' },
      },
    },

    operations: {
      upscale: {
        tool: 'images_upscale',
        idParam: 'creationIdentifier',
        scaleParam: 'scale',
      },
      background_removal: {
        tool: 'images_remove_background',
        idParam: 'creationIdentifier',
      },
    },

    // Orbital / camera-angle one-shot → Magnific's dedicated reframe tool.
    cameraAngles: {
      tool: 'images_change_camera',
      idParam: 'creationIdentifier',
      map: { horizontal: 'rotate', vertical: 'vertical', zoom: 'closeup' },
    },

    // Avatar / talking-head (DEFERRED job) → Veed Fabric / Lipsync.
    avatar: {
      tool: 'video_speak',
      audioParam: 'audioUrl',
      imageParam: 'imageUrl',
    },

    // Shared async wiring. `poll` (long-poll) drives INLINE image/audio;
    // `status` (single snapshot) drives DEFERRED video/avatar via getStatus().
    async: {
      poll: 'creations_wait',
      pollIdParam: 'identifiers',
      status: 'creation_status',
      statusIdParam: 'creationIdentifier',
      retryField: 'poll_after_seconds',
      timeoutParam: 'timeoutSeconds',
      timeoutSeconds: 25,
      fetch: 'creations_get',
      fetchIdParam: 'creationIdentifier',
      urlField: 'url',
    },

    // Local-file upload dance → returns a creation identifier usable as a ref.
    uploadRef: {
      request: 'creations_request_upload',
      finalize: 'creations_finalize_upload',
      byUrl: 'creations_upload_image',
    },
  },
};
