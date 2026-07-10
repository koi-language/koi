/**
 * Format a per-model catalog as a MARKDOWN TABLE. Used by
 * generate-image / generate-video / generate-audio at import time to
 * append a "Catalog" section to the tool description, so the agent can
 * see — for the SAME tool call — every model it may pick, together with
 * the Koi-owned CATEGORIES each one carries and any LABELS that bias it.
 *
 * The agent MUST pick the model itself (`model` is a required parameter):
 * there is no auto-router any more. The rule the agent follows is
 * category-matching — pick a slug whose Categories column contains the
 * bucket for the operation it is performing (generation / editing /
 * extend / upscaling / background_removal / avatar / tts / sfx / music /
 * transcribe …). NEVER pick a model that lacks the category for the
 * operation (e.g. never edit with a generation-only model). The skills
 * (image-generator / video-generator / audio-generator) explain what each
 * category is for; this table is the live inventory.
 *
 * Table columns: `Model` | `Categories` | `Labels` | `Price`.
 * A label glossary follows the table so the agent knows what each label
 * MEANS (e.g. that "face-consistency" keeps people in ref images looking
 * identical, not a generic quality knob).
 */

function _labelSlugs(m) {
  if (!Array.isArray(m?.labels)) return [];
  return m.labels.map((l) => {
    if (typeof l === 'string') return l;
    if (l && typeof l === 'object' && typeof l.slug === 'string') return l.slug;
    return null;
  }).filter(Boolean);
}

function _categorySlugs(m) {
  return Array.isArray(m?.categories) && m.categories.length > 0
    ? m.categories.slice()
    : ['(uncategorised)'];
}

// Escape a value for a markdown table cell (pipes would break columns).
function _cell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|');
}

function _tableRow(m) {
  const display = m.displayName && m.displayName !== m.slug ? ` (${m.displayName})` : '';
  const name = `\`${m.slug}\`${display}`;
  const cats = _categorySlugs(m).join(', ');
  const labels = _labelSlugs(m).join(', ') || '—';
  const price = (typeof m.pricePerUnit === 'number' && m.pricePerUnit > 0)
    ? `$${m.pricePerUnit}/${m.unitType || 'unit'}`
    : '—';
  return `| ${_cell(name)} | ${_cell(cats)} | ${_cell(labels)} | ${_cell(price)} |`;
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
 * @returns {string} a leading-newline markdown-table section listing every
 *   model with its categories + labels + price, or '' when the list is empty.
 */
export function formatModelCatalog(models) {
  if (!Array.isArray(models) || models.length === 0) return '';

  // Sort rows by first category, then slug, so models of the same operation
  // sit together in the table and the agent can scan a bucket at a glance.
  const rows = models.slice().sort((a, b) => {
    const ca = _categorySlugs(a)[0] || '';
    const cb = _categorySlugs(b)[0] || '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return String(a.slug) < String(b.slug) ? -1 : 1;
  });

  const table = [
    '| Model | Categories | Labels | Price |',
    '| --- | --- | --- | --- |',
    ...rows.map(_tableRow),
  ].join('\n');

  // Glossary block — the table only shows the label slug so it stays tight;
  // the agent reads what each label MEANS here.
  const glossary = _collectLabelGlossary(models);
  let glossaryBlock = '';
  if (glossary.size > 0) {
    const slugs = [...glossary.keys()].sort();
    const lines = slugs.map((slug) => {
      const desc = glossary.get(slug);
      return desc ? `  - \`${slug}\` — ${desc}` : `  - \`${slug}\``;
    }).join('\n');
    glossaryBlock = (
      '\n\nLabel glossary — a label marks the content / subject / style a model ' +
      'is BEST-SUITED for (e.g. `cities` → city photos, `manga` → manga ' +
      'drawings). If the request matches a model\'s label, PREFER that model ' +
      'within its category. Labels are context for choosing, NOT an input ' +
      'parameter:\n' + lines
    );
  }

  return (
    '\n\n## Catalog — pick a model (`model` is REQUIRED)\n' +
    'This table below IS the authoritative, live model catalog — every model ' +
    'with its **Categories** and **Labels**. Read it RIGHT HERE to choose; ' +
    'do NOT grep files, `references/`, or the backend for models / categories ' +
    '/ labels. You MUST pass `model` with one of the slugs below — there is no ' +
    'auto-selection. Pick a model whose **Categories** column contains the ' +
    'bucket for the operation you are doing, and NEVER pick one that lacks ' +
    'it (e.g. do not edit with a generation-only model, do not upscale with ' +
    'an editing model). When several models fit, choose on price / labels / ' +
    'the per-model notes in the matching skill (image-generator / video-generator ' +
    '/ audio-generator).\n\n' +
    table +
    glossaryBlock
  );
}
