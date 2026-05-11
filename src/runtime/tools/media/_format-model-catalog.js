/**
 * Format a per-category, per-model catalog summary block. Used by
 * generate-image / generate-video / generate-audio at import time to
 * append a "Catalog snapshot" section to the tool description, so the
 * agent can see — for the SAME tool call — which models live in each
 * Koi-owned bucket and which labels (if any) bias them.
 *
 * Per-line output is intentionally minimal:
 *   `slug (displayName) [labels: ...] $X/unit`
 *
 * No vendor-derived knobs are surfaced (no aspectRatios, resolutions,
 * durations, maxRefImages, frame-control, image-to-video, lipsync,
 * tts/sfx/music/transcribe, ops, etc.). The router picks by category +
 * label + price; the per-slug adapter is the sole authority on what
 * each model physically accepts. If the picker lands on a model that
 * can't handle the request's input shape, the adapter rejects at
 * build-time with a clear error.
 */

function _labelSlugs(m) {
  if (!Array.isArray(m?.labels)) return [];
  return m.labels.map((l) => {
    if (typeof l === 'string') return l;
    if (l && typeof l === 'object' && typeof l.slug === 'string') return l.slug;
    return null;
  }).filter(Boolean);
}

function _modelLine(m) {
  const display = m.displayName && m.displayName !== m.slug ? ` (${m.displayName})` : '';
  const parts = [];
  const labels = _labelSlugs(m);
  if (labels.length) parts.push(`labels: ${labels.join(', ')}`);
  if (typeof m.pricePerUnit === 'number' && m.pricePerUnit > 0) {
    parts.push(`$${m.pricePerUnit}/${m.unitType || 'unit'}`);
  }
  const tail = parts.length ? ` | ${parts.join(' | ')}` : '';
  return `      - "${m.slug}"${display}${tail}`;
}

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

/**
 * @param {Array<object>} models - rows from /gateway/models/{kind}.json
 * @returns {string} a leading-newline section listing every model grouped
 *   by Koi-owned category, or '' when the list is empty.
 */
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
    '\n\nActive models in the catalog (the router auto-picks one per request ' +
    'based on Koi-owned category + label + price; per-model knobs are not ' +
    'surfaced here — pass your params and the per-slug adapter handles ' +
    'shape mismatches at execution time with a clear error):\n' +
    sections.join('\n') +
    glossaryBlock
  );
}
