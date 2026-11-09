/**
 * One-time move of the legacy global documents (~/.koi/<kind>) into project
 * packages: one `.braxil` per story project (its stories and EVERYTHING they
 * reach: 3D scenes, models, montages, cast, places, objects, voices, media,
 * panels, drawer rows), and the rest into `Archivo.braxil`.
 *
 * Files are HARD-LINKED (no extra disk); JSON documents are rewritten so
 * their paths point inside the package. The legacy folders end up moved to
 * a backup outside ~/.koi, with a manifest, for the user to delete once
 * happy.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { DOC_KINDS, PROJECT_EXT } from './doc-root.js';
import { createProject, freePackagePath } from './project-package.js';
import { toStoredPaths } from './project-paths.js';

const _require = createRequire(import.meta.url);
const _Database = () => _require('better-sqlite3');

// Legacy files kept at the ~/.koi root that belong to the documents.
const ROOT_DOC_FILES = ['creations-index.jsonl', 'collection_order.json', 'category_order.json'];
// Inside a kind, entries that hold data for ALL items (not one item).
const SHARED_ENTRIES = { storyboards: ['.cache'], scenes3d: ['.pending-takes.json'], 'media-library': true, voices: true };
const ID_KEYS = {
  characterId: 'characters', characterIds: 'characters', locationId: 'locations', locationIds: 'locations',
  objectId: 'objects', objectIds: 'objects', model: 'models3d', modelId: 'models3d',
};

function _walkStrings(v, fn, key = null) {
  if (typeof v === 'string') fn(v, key);
  else if (Array.isArray(v)) for (const x of v) _walkStrings(x, fn, key);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) _walkStrings(x, fn, k);
}

function* _files(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* _files(p); else yield p;
  }
}

function _readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

export function migrateLegacyDocuments({ destDir, log = (m) => process.stderr.write(`[migrate] ${m}\n`), dryRun = false } = {}) {
  const LEG = path.join(os.homedir(), '.koi');
  const kinds = DOC_KINDS.filter((k) => fs.existsSync(path.join(LEG, k)));
  const entry = (kind, name) => `${kind}/${name}`;
  const entryPath = (e) => path.join(LEG, e);
  const exists = (e) => fs.existsSync(entryPath(e));
  const pathRe = new RegExp(`${LEG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(${kinds.join('|')})/([^/\\s"'<>|,;)]+)`, 'g');

  // Every JSON a set of entries holds (a file, or the json files of a dir).
  const jsonsOf = (e) => {
    const p = entryPath(e);
    let st;
    try { st = fs.statSync(p); } catch { return []; }
    if (st.isFile()) return /\.json$/i.test(p) ? [p] : [];
    const out = [];
    for (const f of _files(p)) if (/\.json$/i.test(f) && fs.statSync(f).size < 20 * 1024 * 1024) out.push(f);
    return out;
  };

  const voices = _readJson(path.join(LEG, 'voices', 'voices.json')) || [];
  const scenes = fs.existsSync(path.join(LEG, 'scenes3d'))
    ? fs.readdirSync(path.join(LEG, 'scenes3d')).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => ({ id: f.slice(0, -5), doc: _readJson(path.join(LEG, 'scenes3d', f)) })).filter((s) => s.doc)
    : [];
  const timelines = fs.existsSync(path.join(LEG, 'timelines'))
    ? fs.readdirSync(path.join(LEG, 'timelines')).filter((f) => f.endsWith('.json'))
      .map((f) => ({ file: f, raw: fs.readFileSync(path.join(LEG, 'timelines', f), 'utf8') }))
    : [];

  const _sib = new Map();
  const siblings = (kind) => {
    if (!_sib.has(kind)) {
      let names = [];
      try { names = fs.readdirSync(path.join(LEG, kind)); } catch { /* none */ }
      _sib.set(kind, names);
    }
    return _sib.get(kind);
  };

  /** Everything [storyboardIds] reach. */
  function closure(storyboardIds) {
    const set = new Set();
    const voiceIds = new Set();
    const queue = [];
    const add = (e) => { if (!set.has(e) && exists(e)) { set.add(e); queue.push(e); } };
    const sbs = new Set(storyboardIds);
    for (const id of sbs) {
      add(entry('storyboards', `${id}.json`));
      add(entry('storyboards', id));
    }
    for (const s of scenes) {
      if (sbs.has(s.doc.storyboard?.id)) { add(entry('scenes3d', `${s.id}.json`)); add(entry('scenes3d', s.id)); }
    }
    while (queue.length) {
      const e = queue.shift();
      for (const fp of jsonsOf(e)) {
        let raw;
        try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
        for (const m of raw.matchAll(pathRe)) add(entry(m[1], m[2]));
        const doc = (() => { try { return JSON.parse(raw); } catch { return null; } })();
        if (!doc) continue;
        _walkStrings(doc, (v, k) => {
          const kind = ID_KEYS[k];
          if (kind && v && !v.includes('/')) {
            add(entry(kind, kind === 'models3d' ? v : `${v}.json`));
          }
          if (v && v.length < 120) voiceIds.add(v);
        });
        // Scenes of a story reached later (a scene links its story back).
        if (doc.storyboard?.id && !sbs.has(doc.storyboard.id) && e.startsWith('scenes3d/')) {
          sbs.add(doc.storyboard.id);
          add(entry('storyboards', `${doc.storyboard.id}.json`));
          add(entry('storyboards', doc.storyboard.id));
        }
      }
      // Montages of these stories / scenes.
      if (e.startsWith('storyboards/') || e.startsWith('scenes3d/')) {
        const key = path.basename(e, '.json');
        for (const t of timelines) if (t.raw.includes(`"${key}"`) || t.raw.includes(`/${key}`)) add(entry('timelines', t.file));
      }
      // A sheet's per-panel geometry and versions.
      if (e.startsWith('images/')) add(entry('panels', path.basename(e).replace(/\.[^.]+$/, '')));
      // Its siblings: the original of a `.noedts` copy, sidecars, crops.
      const [k0, n0] = e.split('/');
      if (['images', 'videos', 'audio'].includes(k0)) {
        const stem = n0.split('.')[0];
        for (const n of siblings(k0)) if (n !== n0 && n.split('.')[0] === stem) add(entry(k0, n));
      }
    }
    const vs = voices.filter((v) => voiceIds.has(v.id) || voiceIds.has(v.providerVoiceId));
    for (const v of vs) for (const k of ['samplePath', 'sourceSamplePath']) {
      if (typeof v[k] === 'string' && v[k].startsWith(`${LEG}/voices/`)) add(entry('voices', v[k].slice(`${LEG}/voices/`.length).split('/')[0]));
    }
    return { set, voices: vs, storyboards: [...sbs] };
  }

  // ── Plan ───────────────────────────────────────────────────────────────
  const projects = fs.existsSync(path.join(LEG, 'projects'))
    ? fs.readdirSync(path.join(LEG, 'projects')).filter((f) => f.endsWith('.json'))
      .map((f) => ({ file: f, doc: _readJson(path.join(LEG, 'projects', f)) })).filter((p) => p.doc)
    : [];
  fs.mkdirSync(destDir, { recursive: true });
  const plan = [];
  const claimed = new Set();
  for (const p of projects) {
    const ids = (p.doc.sequences || []).map((s) => s.storyboardId).filter(Boolean);
    const c = closure(ids);
    c.set.add(entry('projects', p.file));
    for (const e of c.set) claimed.add(e);
    plan.push({ name: p.doc.name || path.basename(p.file, '.json'), ...c });
  }
  // The rest: Archivo.
  const rest = new Set();
  for (const k of kinds) {
    for (const name of fs.readdirSync(path.join(LEG, k))) {
      if (name === '.DS_Store') continue;
      const e = entry(k, name);
      if (!claimed.has(e)) rest.add(e);
    }
  }
  plan.push({ name: 'Archivo', set: rest, voices, archive: true });

  // ── Write packages ─────────────────────────────────────────────────────
  // Legacy paths → into the package, then stored project-relative (see
  // state/project-paths.js). Text that does not parse keeps the absolute
  // in-package paths (still readable: absolute stays absolute).
  const rewrite = (s, pkg, file = '') => {
    let out = s;
    for (const k of DOC_KINDS) out = out.split(`${LEG}/${k}/`).join(`${pkg}/${k}/`);
    if (/\.jsonl$/i.test(file)) {
      return out.split('\n').map((l) => {
        if (!l.trim()) return l;
        try { return JSON.stringify(toStoredPaths(JSON.parse(l), pkg)); } catch { return l; }
      }).join('\n');
    }
    try {
      const indent = /^[[{]\s*\n( +)/.exec(out)?.[1]?.length ?? (out.includes('\n') ? 2 : 0);
      return JSON.stringify(toStoredPaths(JSON.parse(out), pkg), null, indent || undefined) + (out.endsWith('\n') ? '\n' : '');
    } catch { return out; }
  };
  const place = (src, dst, pkg) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(dst)) return;
    if (/\.(json|jsonl)$/i.test(src)) {
      fs.writeFileSync(dst, rewrite(fs.readFileSync(src, 'utf8'), pkg, src), 'utf8');
      return;
    }
    try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
  };

  const legacyDb = path.join(LEG, 'media-library', 'vector-cache', 'index.sqlite');
  if (fs.existsSync(legacyDb) && !dryRun) {
    const db = new (_Database())(legacyDb);
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
  }

  const report = [];
  for (const p of plan) {
    const pkg = freePackagePath(destDir, p.name);
    const files = new Set();
    for (const e of p.set) {
      const src = entryPath(e);
      const st = fs.statSync(src);
      if (st.isDirectory()) { for (const f of _files(src)) files.add(f); } else files.add(src);
    }
    report.push({ name: p.name, pkg, entries: p.set.size, files: files.size, ...(dryRun && !p.archive ? { list: [...p.set] } : {}) });
    if (dryRun) continue;
    createProject(pkg, { name: p.name });
    for (const f of files) {
      const rel = path.relative(LEG, f);
      if (rel === 'voices/voices.json') continue;
      place(f, path.join(pkg, rel), pkg);
    }
    // The cast's voices: only this project's entries.
    if (p.voices.length) {
      fs.mkdirSync(path.join(pkg, 'voices'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'voices', 'voices.json'), rewrite(JSON.stringify(p.voices, null, 2), pkg, 'voices.json'), 'utf8');
    }
    // Story-project file → the package's projects/ (the sequence list).
    // Root files: the creations ledger lines and drawer ordering.
    for (const f of ROOT_DOC_FILES) {
      const src = path.join(LEG, f);
      if (!fs.existsSync(src)) continue;
      let s = fs.readFileSync(src, 'utf8');
      if (f.endsWith('.jsonl') && !p.archive) {
        s = s.split('\n').filter((l) => [...files].some((x) => l.includes(x)) || p.storyboards?.some((id) => l.includes(`"${id}"`))).join('\n');
        if (s) s += '\n';
      }
      fs.writeFileSync(path.join(pkg, f), rewrite(s, pkg, f), 'utf8');
    }
    // The drawer index: its rows only, paths moved inside the package.
    if (fs.existsSync(legacyDb)) {
      const out = path.join(pkg, 'media-library', 'vector-cache', 'index.sqlite');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(legacyDb, out);
      const db = new (_Database())(out);
      try {
        const keep = new Set(files);
        const rows = db.prepare('SELECT id, file_path FROM media').all();
        const del = db.prepare('DELETE FROM media WHERE id = ?');
        const tx = db.transaction(() => {
          for (const r of rows) {
            const fp = r.file_path || '';
            const mine = keep.has(fp);
            const outside = !fp.startsWith(`${LEG}/`);
            if (p.archive ? (!mine && !outside) : !mine) del.run(r.id);
          }
          if (!p.archive) {
            for (const t of ['conversations', 'palace_meta', 'palace_drawers', 'palace_rooms']) {
              try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* absent */ }
            }
          }
          for (const k of DOC_KINDS) {
            const a = `${LEG}/${k}/`, b = `${pkg}/${k}/`;
            db.prepare('UPDATE media SET file_path = replace(file_path, ?, ?), metadata_json = replace(metadata_json, ?, ?) '
              + 'WHERE instr(file_path, ?) > 0 OR instr(metadata_json, ?) > 0').run(a, b, a, b, a, a);
          }
        });
        tx();
        db.exec('VACUUM');
      } finally {
        db.close();
      }
    }
    log(`${p.name}: ${files.size} files → ${pkg}`);
  }
  if (dryRun) return { report };

  // ── Retire the legacy store (moved aside, nothing deleted) ─────────────
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const backup = path.join(os.homedir(), `.koi-legacy-documents-${stamp}`);
  fs.mkdirSync(backup, { recursive: true });
  for (const k of kinds) fs.renameSync(path.join(LEG, k), path.join(backup, k));
  for (const f of ROOT_DOC_FILES) if (fs.existsSync(path.join(LEG, f))) fs.renameSync(path.join(LEG, f), path.join(backup, f));
  fs.writeFileSync(path.join(backup, 'MIGRATION.json'), JSON.stringify({ at: new Date().toISOString(), destDir, report }, null, 2));
  fs.writeFileSync(path.join(LEG, '.migrated-to-projects'), JSON.stringify({ at: new Date().toISOString(), destDir, backup }, null, 2));
  log(`legacy documents moved to ${backup}`);
  return { report, backup };
}
