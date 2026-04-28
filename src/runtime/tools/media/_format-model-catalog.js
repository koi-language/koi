/**
 * Format a per-category, per-model catalog summary block. Used by
 * generate-image / generate-video / generate-audio at import time to
 * append a "Catalog snapshot" section to the tool description, so the
 * agent can see — for the SAME tool call — which model handles each
 * category and what knobs each one accepts.
 *
 * The router auto-picks the cheapest capable model per request; this
 * block is purely informational, but it's the only way the agent can
 * reconcile errors like "this model doesn't support 1080p" with what
 * IS available before retrying.
 */

const _csv = (s) => {
  if (typeof s !== 'string') return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
};

// Per-model labels are now `Array<{slug, description}>` (see backend
// gateway.service.ts:getMediaModels). We list slugs only on the per-model
// line — descriptions are rendered ONCE at the top of the catalog block to
// avoid spamming the same blurb under every model that carries the label.
function _modelLine(m) {
  const display = m.displayName && m.displayName !== m.slug ? ` (${m.displayName})` : '';
  const parts = [];
  const labelSlugs = Array.isArray(m.labels)
    ? m.labels.map((l) => (typeof l === 'string' ? l : l && typeof l === 'object' ? l.slug : null)).filter(Boolean)
    : [];
  if (labelSlugs.length) parts.push(`labels: ${labelSlugs.join(', ')}`);
  const aspect = _csv(m.aspectRatios);
  if (aspect.length) parts.push(`aspectRatios: ${aspect.join('/')}`);
  const res = _csv(m.resolutions);
  if (res.length) parts.push(`resolutions: ${res.join('/')}`);
  const dur = _csv(m.durations);
  if (dur.length) parts.push(`durations: ${dur.join('/')}s`);
  const formats = _csv(m.outputFormats);
  if (formats.length) parts.push(`outputFormats: ${formats.join('/')}`);
  if (typeof m.maxImages === 'number' && m.maxImages > 0) parts.push(`maxImages: ${m.maxImages}`);
  if (m.maxRefImages != null) parts.push(`maxRefImages: ${m.maxRefImages === 0 ? 'unbounded' : m.maxRefImages}`);
  if (typeof m.maxShots === 'number' && m.maxShots > 1) parts.push(`maxShots: ${m.maxShots}`);
  if (m.imageToVideo) parts.push('image-to-video');
  if (m.videoToVideo) parts.push('video-to-video');
  if (m.frameControl) parts.push('frame-control');
  if (m.hasAudio) parts.push('with-audio');
  if (m.lipsync) parts.push('lipsync');
  if (m.tts) parts.push('tts');
  if (m.transcribe) parts.push('transcribe');
  if (m.sfx) parts.push('sfx');
  if (m.music) parts.push('music');
  if (m.voiceSelect) parts.push('voice-select');
  const ops = Array.isArray(m.operations) ? m.operations.filter(Boolean) : [];
  if (ops.length) parts.push(`ops: ${ops.join(',')}`);
  if (typeof m.pricePerUnit === 'number' && m.pricePerUnit > 0) {
    parts.push(`$${m.pricePerUnit}/${m.unitType || 'unit'}`);
  }
  const tail = parts.length ? ` | ${parts.join(' | ')}` : '';
  return `      - "${m.slug}"${display}${tail}`;
}

/**
 * @param {Array<object>} models - rows from /gateway/models/{kind}.json
 * @returns {string} a leading-newline section listing every model grouped
 *   by category, or '' when the list is empty.
 */
// Build a single global slug → description glossary from every model's
// labels. Same slug appearing on multiple models is de-duped; we keep the
// first non-empty description (curated centrally so they should agree).
function _collectLabelGlossary(models) {
  const out = new Map();
  for (const m of models) {
    if (!Array.isArray(m?.labels)) continue;
    for (const raw of m.labels) {
      if (typeof raw === 'string') {
        if (!out.has(raw)) out.set(raw, '');
      } else if (raw && typeof raw === 'object' && typeof raw.slug === 'string') {
        const prev = out.get(raw.slug);
        if (prev == null || prev === '') {
          out.set(raw.slug, typeof raw.description === 'string' ? raw.description : '');
        }
      }
    }
  }
  return out;
}

export function formatModelCatalog(models) {
  if (!Array.isArray(models) || models.length === 0) return '';
  const groups = new Map();
  for (const m of models) {
    const cats = Array.isArray(m.categories) && m.categories.length > 0
      ? m.categories
      : ['(uncategorised)'];
    for (const cat of cats) {
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(m);
    }
  }
  const sortedCats = [...groups.keys()].sort();
  const sections = sortedCats.map((cat) => {
    const list = groups.get(cat);
    const lines = list.map(_modelLine).join('\n');
    return `  • [${cat}]\n${lines}`;
  });

  // Glossary block — the per-model lines only show the label slug so the
  // listing stays tight; the agent reads what each label MEANS here. This
  // is what tells it that "face-consistency" is for keeping people in ref
  // images looking identical, not just a generic quality knob.
  const glossary = _collectLabelGlossary(models);
  let glossaryBlock = '';
  if (glossary.size > 0) {
    const slugs = [...glossary.keys()].sort();
    const lines = slugs.map((slug) => {
      const desc = glossary.get(slug);
      return desc ? `  - ${slug} — ${desc}` : `  - ${slug}`;
    }).join('\n');
    glossaryBlock = (
      '\n\nLabel glossary (use these in the "label" param to bias the picker ' +
      'toward a specialised model — pick the slug whose description matches ' +
      'the task; omit when no specialisation is needed):\n' + lines
    );
  }

  return (
    '\n\nActive models in the catalog (the router auto-picks one per request; ' +
    'each line lists the per-model knobs you can rely on, so you can match ' +
    'your params to a model that supports them):\n' +
    sections.join('\n') +
    glossaryBlock
  );
}
