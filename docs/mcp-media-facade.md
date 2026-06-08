# MCP Media Facade

Route Koi's media tools (`generate_image`, `generate_video`, `generate_audio`,
`upscale_image`, …) through a connected **MCP media provider** (e.g. Magnific)
instead of the Koi backend gateway — **without changing any tool**. The existing
tools become a thin facade: when a media MCP is active they call it; when it's
not, they fall back to the backend exactly as today.

> Status: design agreed, not yet implemented. This doc is the contract.

## Why this works cleanly

The media tools already dispatch through a provider abstraction, not the backend
directly:

```
generate_image  →  factory.resolve({type:'image'})  →  resolved.instance  →  instance.generate(prompt, opts)
upscale_image   →  factory.resolve({type:'image'})  →  resolved.instance  →  instance.runOperation('upscale', …)
```

- `factory.js` (`resolve` / `createImageGen` …) is the **single routing seam**.
  Today `createImageGen` only accepts `koi-gateway`.
- `mcp-registry.js` exposes `callTool(server, tool, args)`, `getServerSummaries()`,
  `getToolSummaries()` (each tool's `name` / `description` / `inputSchema`).

So we add a new provider whose `instance` methods call the MCP, and branch to it
in `factory.resolve`. Tools are untouched.

## Design decisions (locked)

1. **Capability declaration: explicit metadata** (not pure auto-detect). A `media`
   block on the MCP server config (`.mcp.json`) maps each Koi operation to the MCP
   tool that serves it. Auto-detection only *pre-fills* this; it's never the source
   of truth.
2. **Coexistence, not replacement.** While a media MCP is active it's used; when
   deactivated, the backend is used. Resolution is **per call/operation**: if the
   active MCP doesn't cover a given method, that one call falls back to the backend
   (not all-or-nothing).
3. **Credits & consent are backend-only.** MCP calls skip `preflightMediaCost` /
   the cost card and never charge Koi credits (the MCP bills the user's own account).
   Implemented by setting `confirmCost = false` when routing to MCP.
4. **Schema/capabilities come from the MCP metadata** (aspect ratios, params),
   falling back to a generic schema when unknown.

## Architecture

```
generate_image/video/audio, upscale_image, …   (UNCHANGED — facade)
        │
   factory.resolve({type})
        │
   mcpMediaResolver.activeFor(kind)  ── single source of truth ──┐
        │                                                        │
        ├─ MCP active & covers method → McpMediaProvider.<m>()   │ (also used by the banner
        │        └─ mcpRegistry.callTool(server, tool, args)     │  to label the provider)
        │                                                        │
        └─ else → GatewayImageGen / … (backend: credits+consent) ┘
```

### Single source of truth: `mcp-media-resolver.js`

```
activeFor(kind /* 'image'|'video'|'audio' */) → { server, label, media } | null
```

Scans `mcpRegistry` for a **connected** server whose config has a `media` block
covering `kind`. Used by BOTH `factory.resolve` (to route) and the banner (to label),
so what runs and what's shown can never diverge.

## Provider interface (`McpMediaProvider`)

Mirrors the methods the tools already call, so no tool changes:

| Method | Used by |
|---|---|
| `generate(prompt, opts)` | `generate_image`, `generate_video` |
| `speech(text, opts)` | `generate_audio` (mode=speech / tts) |
| `music(prompt, opts)` | `generate_audio` (mode=music) |
| `sfx(prompt, opts)` | `generate_audio` (mode=sfx) |
| `generateAvatar(imageBuf, audioBuf, opts)` | `generate_avatar_video` |
| `runOperation(op, input, opts)` | `upscale_image`, `background_removal`, … |
| `cloneVoice(audioBuf, opts)` / `transcribe(audioBuf, opts)` | `create_voice`, `transcribe_audio` |

Any method not covered by the active MCP's metadata **throws "not supported"** → the
caller's `factory.resolve` (or the tool) falls back to the backend for that call.

## Tool → provider-method → Magnific mapping

### Generation
| Koi intent | provider method | Magnific tool | Facade |
|---|---|---|---|
| `generate_image` | `generate()` | `images_generate` | ✅ |
| `generate_image` + `cameraAngles` | `generate()` | `images_change_camera` (rotate=horizontal, vertical=vertical, closeup=zoom) | ✅ |
| `generate_video` | `generate()` | `video_generate` (+ optional `video_plan`) | ✅ |
| `generate_audio` (speech) | `speech()` | `audio_tts` | ✅ |
| `generate_audio` (music) | `music()` | `audio_music_generate` | ✅ |
| `generate_audio` (sfx) | `sfx()` | — (none) | ⤵️ backend |
| `generate_avatar_video` | `generateAvatar()` | `video_speak` | ✅ |

### Operations (`runOperation`)
| Koi intent | Magnific tool | Facade |
|---|---|---|
| `upscale_image` | `images_upscale` (scale 2/4 = `upscaleFactor`) | ✅ |
| `background_removal` | `images_remove_background` | ✅ |
| `outpaint_image` | (delegates to `generate_image` → `images_generate` "extend…") | ✅ transitive |

### Stays on backend (no clear Magnific equivalent)
`create_voice` (clone), `transcribe_audio` (STT), `segment_image` (mask segmentation),
and the local utilities `image_info` / `extract_frame` / `screenshot` / `tag_media`.

### Magnific extras not yet wired (future tools)
`images_relight`, `images_skin_enhancer`, `images_variations`, `images_crop`,
`images_resize`, `images_to_svg`, `models3d_generate`, `video_upscale`,
`video_concatenate`, `design_*`, `flows_*`, `stock_*`.

## The async + asset-registry reality

Real media MCPs (Magnific) are **submit → poll → fetch**, not "call returns bytes":

- `images_generate` / `video_generate` / `images_upscale` return a **creation
  identifier**, not the asset.
- Poll with `creations_wait` (long-poll, returns `poll_after_seconds`).
- Fetch with `creations_get` → `url` (full-res). Download → save to media library.

This is the **same shape** `gateway.js generate()` already uses for fal (submit +
poll + `onStatus`), so the adapter reuses that pattern; only the transport
(`callTool`) differs. `poll_after_seconds` / status feed `opts.onStatus` → banner.

### Reference / input upload

References are creation ids or URLs, **not base64**. Local `referenceImages`
(and the input image for `upscale`/`change_camera`) must be uploaded first:

```
creations_request_upload(mimeType) → presigned PUT → upload bytes → creations_finalize_upload → identifier
```
or `creations_upload_image(url)` for a public URL.

## Metadata format (`media` block in `.mcp.json`)

```json
"mcpServers": {
  "magnific": {
    "command": "…",
    "media": {
      "generate": {
        "image": { "tool": "images_generate", "promptParam": "prompt", "refsParam": "references", "aspectRatioParam": "aspectRatio" },
        "video": { "tool": "video_generate", "planTool": "video_plan" },
        "audio": {
          "speech": { "tool": "audio_tts", "textParam": "text" },
          "music":  { "tool": "audio_music_generate", "promptParam": "prompt" }
        }
      },
      "operations": {
        "upscale":            { "tool": "images_upscale",          "idParam": "creationIdentifier", "scaleParam": "scale" },
        "background_removal": { "tool": "images_remove_background", "idParam": "creationIdentifier" }
      },
      "avatar":     { "tool": "video_speak" },
      "cameraAngles": { "tool": "images_change_camera", "idParam": "creationIdentifier",
                        "map": { "horizontal": "rotate", "vertical": "vertical", "zoom": "closeup" } },
      "async":      { "poll": "creations_wait", "pollIdParam": "identifiers", "retryField": "poll_after_seconds",
                      "fetch": "creations_get", "fetchIdParam": "creationIdentifier", "urlField": "url" },
      "uploadRef":  { "request": "creations_request_upload", "finalize": "creations_finalize_upload", "byUrl": "creations_upload_image" }
    }
  }
}
```

`async` and `uploadRef` are defined once and shared by all routes.

### Activation: detect → opt-in dialog → map (no profiles)

Routing media to an MCP **requires explicit user opt-in** — the facade never
silently replaces the native backend:

1. **Detect.** When a connected MCP exposes media-looking tools
   (`detectMediaKinds` — cheap keyword scan → which of image/video/audio), the
   MCP tab surfaces it.
2. **Ask.** A one-time dialog: *"'Magnific' can generate images, video, audio.
   Use it instead of the native backend? Generations run on its own quota and
   won't spend Koi credits."* → Use this MCP / Keep native backend. The decision
   ('enabled' | 'declined') is persisted so it's asked once.
3. **Map (only on accept).** An LLM reads the server's live tools
   (`getToolSummaries()` → name + description + inputSchema) and emits the
   `media` block above — one call per (server, toolset version), validated (every
   referenced tool must really exist) and cached. No hardcoded profiles.

Decision + map live in `~/.koi/mcp-media-maps/<server>.json`
(`{ decision, toolsetHash, media }`). The resolver only routes to an MCP whose
decision is 'enabled' (or which has an explicit `.mcp.json media` override). A
lazy re-map runs if an enabled server's toolset hash later changes.

ws commands: `mediaMcpStatus` (GUI polls for undecided capable servers),
`enableMediaMcp` (sets enabled + maps), `declineMediaMcp` (remembers no).

- **Auto-invalidation:** the cached map is stamped with a hash of the toolset
  (`mcp-media-store.toolsetHash`). If the server adds/renames a tool or param, the
  hash changes → the map is regenerated on next use. This is the real answer to
  "what if Magnific changes?" — it just re-maps itself.
- **Persistence:** `~/.koi/mcp-media-maps/<server>.json` (runtime-owned, same
  pattern as `media-cost-approve.json` / voice-registry).
- **Manual override always wins:** an explicit `media` block in `.mcp.json` skips
  auto-mapping entirely.
- The call-time reconciliation (`_resolveToolName` / `_param`) remains a safety net
  for drift between mapping and call.

## Cost / consent (decision 3)

When `mcpMediaResolver.activeFor(kind)` returns a provider, the routing path sets
`act.confirmCost = false` so `preflightMediaCost` (action-registry banner wrapper)
and the per-tool `confirmMediaCost` (upscale/bg-removal) are skipped. No card, no
credit charge. Side effect: `upscale_image` works even when the user is NOT signed
in to Koi, because the MCP provider supplies `runOperation`.

## Banner: show the active provider

The banner payload (`mediaToolStart` in `ws-channel.js`) gains a `provider` field.

- `action-registry.js` `_wrapWithBanner`: `provider = mcpMediaResolver.activeFor(action.bannerKind)?.label ?? null`, passed into `channel.mediaToolStart({…, provider})`.
- `ws-channel.js mediaToolStart`: add `provider` to destructure + `_send`.
- `chat_provider.dart`: parse `provider`.
- Banner widget: render it.

```
🎬  Generating new camera angle…                    (cancel)
     vía Magnific
```

`null` (= backend) renders nothing (or "vía Koi", TBD). This also explains to the
user *why* no credit card appeared: they're spending Magnific's quota.
Optional (phase 2): show Magnific balance via `account_balance`.

## Deferred jobs (video / avatar)

Video and avatar are **deferred jobs in Braxil**, not synchronous — and the MCP
facade preserves that. The provider's `generate()` (video) / `generateAvatar()`
**submit and return `{ id, status: 'pending' }`**; the tool then drives
`getStatus(jobId)` via `_pollUntilTerminal` (generate-video.js) until terminal,
exactly like the gateway video provider. Image and audio stay INLINE (one call
returns the asset). `getStatus` polls the MCP's `status` tool (`creation_status`)
and fetches the URL when terminal.

⚠️ Crash-recovery caveat: the pending-jobs-watcher reconstructs jobs against the
gateway, not MCP. A video whose engine crashes mid-flight won't auto-resume for
MCP jobs (normal runs are fine — `_pollUntilTerminal` runs inline with the live
provider). Wiring MCP into the recovery watcher is a follow-up.

## Self-adaptation (resilience to Magnific changes)

Two layers, both keying off the **live `tools/list` + `inputSchema`** (never a
frozen profile):

1. **Re-mapping (primary):** the cached map is stamped with the toolset hash. Any
   add/rename/param change flips the hash → the LLM mapper rebuilds the map on next
   use. The integration heals itself without a release.
2. **Call-time reconciliation (safety net):** the cached map is a HINT; the adapter
   still reconciles against the live schema per call:
   - `_resolveToolName(wanted)` — exact, else normalized/substring match. Missing
     tool → falls back to the gateway (graceful degrade), not a hard failure.
   - `_param(tool, candidates, preferred, optional)` — resolves each logical param
     to the tool's actual `inputSchema` key (hint → candidates → fuzzy contains).
     Unknown optional params are dropped rather than sent.

Renames of tools/params self-heal; only semantic changes (e.g. `scale` 2/4 → an
enum) need the map to be regenerated (which the hash already forces).

## Tricky bits (tracked, non-blocking)

- **Image I/O**: MCP results arrive as content blocks (`type:"image"` + data/mimeType),
  `resource://` URIs, or text URLs — adapter handles all three; same for sending refs.
- **Koi-specific params** the MCP doesn't model: fold into the prompt or drop (unless
  the metadata maps them, e.g. `cameraAngles → images_change_camera`).
- **Progress**: best-effort via the MCP's poll/status; the banner's ETA is the fallback.
- **UI/picker tools** (`creations_show`, `*_show`, `audio_voices_show`, …): never mapped.

## Phasing

1. **Phase 1 (done)** — image end-to-end via Magnific: `generate_image` (incl.
   `cameraAngles → images_change_camera`) and `upscale_image → images_upscale`,
   with ref/input upload, async poll → media library, and the banner "vía Magnific".
2. **Phase 2 (done, pending live verification)** — audio (TTS + music, inline,
   returns Buffer), video + avatar (DEFERRED jobs via `getStatus`),
   `background_removal`; plus the **self-adaptation** layer (tool/param
   reconciliation against the live schema). Routes wired in `factory._resolveAudio`
   / `_resolveVideo`.
3. **Phase 3 (done)** — detect → opt-in dialog → map flow: `detectMediaKinds` +
   per-server decision in the store; ws `mediaMcpStatus`/`enableMediaMcp`/
   `declineMediaMcp`; the MCP-tab dialog (`mcp_tab._checkMediaMcps`); resolver
   gated on opt-in.
4. **Phase 4 (todo, larger / needs live MCP)** — MCP model catalog injected into
   the dynamic tool schema (so the agent picks the provider's slugs);
   MCP-aware crash recovery for deferred video jobs (the pending-jobs watcher
   reconstructs against the gateway today); optional provider balance in the
   banner (e.g. Magnific `account_balance`); a "re-map / view map" affordance in
   the MCP tab.

## Files (planned)

- `Koi/src/runtime/llm/providers/mcp-media.js` — `McpMediaProvider` (the adapter).
- `Koi/src/runtime/llm/providers/mcp-media-resolver.js` — `activeFor(kind)`.
- `Koi/src/runtime/llm/providers/mcp-media-store.js` — sidecar persistence + toolset hash + media-capable pre-filter.
- `Koi/src/runtime/llm/providers/mcp-media-mapper.js` — LLM that builds the `media` map from the live tools (`ensureMediaMapsForKind`).
- `Koi/src/runtime/llm/providers/factory.js` — branch to MCP in `_resolveImage/_resolveAudio/_resolveVideo`.
- `Koi/src/runtime/agent/action-registry.js` — `provider` on the banner; skip cost when MCP; lazy re-map trigger.
- `Koi/src/runtime/mcp/mcp-registry.js` — keep `media`/`config` on the client.
- `koi-cli/src/cli/ws-channel.js` — pass `provider` through `mediaToolStart`.
- `koi-cli/src/cli/ws-protocol-server.js` — `mediaMcpStatus` / `enableMediaMcp` / `declineMediaMcp`.
- `koi-cli/gui/lib/services/engine_connection.dart` — the three media-MCP client methods.
- `koi-cli/gui/lib/widgets/mcp_tab.dart` — detection + opt-in dialog (`_checkMediaMcps`).
- `koi-cli/gui/lib/providers/chat_provider.dart` + `widgets/message_bubble.dart` — render `provider` ("vía X").
- `koi-cli/gui/lib/services/i18n.dart` — dialog + banner strings.
```
