/**
 * save_composite_image — register a PARTIAL edit (a "master" composite) as a
 * first-class creation.
 *
 * In the image-generator skill's "master" edit mode the agent edits the clean
 * MASTER with a model, then pastes ONLY the changed region of that edit back
 * onto the master locally. The resulting file is made outside generate_image,
 * so without this tool it would be an anonymous PNG: no Info metadata, not in
 * the creations drawer, no @mention. This tool saves it to the media library
 * like a generated image, inheriting the generation data of the edit it was
 * cut from (prompt, model, references…) and recording the two images it was
 * built from:
 *   - compositeMasterPath — the master the cut was pasted onto;
 *   - compositeEditPath   — the generated edit the region was cut FROM.
 * `partialEdit: true` makes the Info panel flag it as a partial edit.
 */

import fs from 'fs';
import path from 'path';
import { channel } from '../../io/channel.js';

// Everything of the edit's generation is inherited (prompt, model, params,
// references, credits, provider job…). Only the fields that describe the
// edit's FILE itself or its library identity are not.
const NOT_INHERITED = new Set([
  'id', 'mediaId', 'path', 'filePath', 'fileName', 'fileSize', 'size', 'hash',
  'contentHash', 'width', 'height', 'dimensions', 'mention', 'favorite',
  'visible', 'description', 'summary', 'created', 'modified', 'excerpt',
  'categories', 'usedForGeneration',
]);

function _imageSize(file) {
  // PNG IHDR: width/height are big-endian u32 at bytes 16..24.
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf.toString('ascii', 1, 4) === 'PNG') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch { /* unknown */ }
  return {};
}

const saveCompositeImageAction = {
  type: 'save_composite_image',
  intent: 'save_composite_image',
  description:
    'Register a PARTIAL edit (master-mode composite: only the changed region of a generated edit pasted onto the master) as a creation, ' +
    'so it shows in the creations drawer, can get an @mention and its Info panel shows the master + the edit it was cut from. ' +
    'Required: "path" (the composite file), "masterImage" (the master it was pasted onto), "editImage" (the generated edit the region was cut FROM). Optional: "summary".',
  thinkingHint: 'Saving composite',
  permission: 'write',

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the composite image file.' },
      masterImage: { type: 'string', description: 'Absolute path of the master the region was pasted onto.' },
      editImage: { type: 'string', description: 'Absolute path of the generated edit the region was cut from.' },
      summary: { type: 'string', description: 'One-line ledger blurb (optional).' },
    },
    required: ['path', 'masterImage', 'editImage'],
  },

  async execute(action, agent) {
    const abs = (p) => (typeof p === 'string' && p.trim() ? path.resolve(p.trim()) : null);
    const filePath = abs(action.path);
    const masterPath = abs(action.masterImage);
    const editPath = abs(action.editImage);
    for (const [k, p] of [['path', filePath], ['masterImage', masterPath], ['editImage', editPath]]) {
      if (!p) return { success: false, error: `save_composite_image: "${k}" is required (absolute path).` };
      if (!fs.existsSync(p)) return { success: false, error: `save_composite_image: "${k}" not found: ${p}` };
    }

    const { MediaLibrary, autoDescribeImage } = await import('../../state/media-library.js');
    const lib = MediaLibrary.global();

    // Inherit the generation data of the edit the region was cut from.
    let inherited = {};
    try {
      const editRow = await lib.getByPath(editPath);
      const meta = editRow?.metadata && typeof editRow.metadata === 'object' ? editRow.metadata : {};
      const nested = meta.metadata && typeof meta.metadata === 'object' ? meta.metadata : {};
      for (const [k, v] of Object.entries({ ...nested, ...meta })) {
        if (k === 'metadata' || NOT_INHERITED.has(k)) continue;
        inherited[k] = v;
      }
    } catch { /* edit not catalogued: register with the provenance only */ }

    // A row already at this path (the file was opened / used as a reference
    // before) makes the save an UPDATE, which skips the creations ledger.
    // Registering it as a composite for the first time IS its creation.
    let priorRow = null;
    try { priorRow = await lib.getByPath(filePath); } catch { /* none */ }
    const ledgerSkipped = !!priorRow && priorRow.metadata?.partialEdit !== true;

    const { width, height } = _imageSize(filePath);
    const prompt = typeof inherited.prompt === 'string' ? inherited.prompt : '';
    const description = prompt || path.basename(filePath);
    let embedding = null;
    const llm = agent?.llmProvider || null;
    if (llm) {
      try { embedding = await llm.getEmbedding(description); } catch { /* save without */ }
    }

    const saved = await lib.save({
      filePath,
      metadata: {
        ...inherited,
        source: 'generated',
        partialEdit: true,
        compositeMasterPath: masterPath,
        compositeEditPath: editPath,
        ...(width ? { width, height } : {}),
      },
      description,
      embedding,
      replaceByPath: true,
      summary: typeof action.summary === 'string' ? action.summary : undefined,
    });
    const summary = typeof action.summary === 'string' && action.summary.trim()
      ? action.summary.trim() : (description.length > 200 ? description.slice(0, 197) + '…' : description);
    if (ledgerSkipped && saved?.id) {
      try {
        const { recordCreation } = await import('../../state/creations-ledger.js');
        await recordCreation({ id: saved.id, kind: 'image', summary, filePath });
      } catch { /* best-effort */ }
    }
    if (llm && saved?.id) {
      autoDescribeImage(saved.id, filePath, description, llm).catch(() => {});
    }

    try {
      const { recordImageOp } = await import('../../state/image-lineage.js');
      recordImageOp({ op: 'composite', outputPath: filePath, sourcePath: masterPath, params: { cutFrom: path.basename(editPath) }, agentName: agent?.name });
    } catch { /* best-effort */ }

    channel.log('image', `Composite registered: ${filePath} (master ${masterPath}, cut from ${editPath})`);
    return { success: true, savedTo: filePath, id: saved?.id || null, masterImage: masterPath, editImage: editPath };
  },
};

export default saveCompositeImageAction;
