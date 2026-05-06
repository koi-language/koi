/**
 * SQLite-backed adapter that mimics the slice of @lancedb/lancedb's API used
 * by semantic-index.js and media-library.js. Lets us drop the LanceDB
 * dependency without rewriting either consumer.
 *
 * Storage:
 *   - One SQLite file per "database" (LanceDB.connect(dbPath) → file).
 *   - One SQLite table per LanceDB table.
 *   - Schema is derived from the sample row passed to createTable():
 *       string  → TEXT
 *       number  → REAL
 *       boolean → INTEGER (0/1)
 *       Float32Array / Array<number> → BLOB (the vector field; key = 'vector')
 *       object  → TEXT (JSON-stringified)
 *       null/undefined → NULL
 *   - Always stores `id TEXT PRIMARY KEY` so deletes by `id = "..."` are fast.
 *
 * Queries: WHERE clauses come straight from the consumer as raw SQL fragments
 * (e.g. `file_id = "abc"` / `content_hash = '0xff' AND favorite = '1'`). They
 * are passed through untouched. Vector search loads all rows into memory and
 * runs JS cosine — fine for project-scoped corpora (≤50k vectors).
 *
 * NOT implemented (consumers don't use them):
 *   - hybrid search, secondary indexes, schema migration, alterTable
 *   - distinct query types beyond .query() / .search(vec)
 *   - stream API
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// koi-fork: pkg-aware better-sqlite3 require — same pattern as rmh/engine.js
const _vecRequire = createRequire(import.meta.url);
const Database = (typeof process.pkg !== 'undefined' && process.env.KOI_EXTRACTED_NODE_MODULES)
  ? _vecRequire(path.join(process.env.KOI_EXTRACTED_NODE_MODULES, 'better-sqlite3'))
  : _vecRequire('better-sqlite3');

// ─── connect() — entry point ────────────────────────────────────────────

/**
 * Open (or create) a SQLite-backed vector "database" at the given path.
 * Mimics @lancedb/lancedb's `connect(dbPath)` entry point.
 */
export async function connect(dbPath) {
  // LanceDB accepts a directory; we use a single sqlite file inside it so the
  // existing layout (one dir per index) is preserved. Callers can rm -rf the
  // dir to wipe the index.
  mkdirSync(dbPath, { recursive: true });
  const file = path.join(dbPath, 'index.sqlite');
  return new SqliteVectorDB(file);
}

// ─── SqliteVectorDB ─────────────────────────────────────────────────────

class SqliteVectorDB {
  constructor(dbFile) {
    this._dbFile = dbFile;
    this._db = new Database(dbFile);
    this._db.pragma('journal_mode = WAL');
    // LanceDB callers write WHERE clauses with double-quoted string literals
    // (`id = "abc"`). Stock SQLite rejects DQS in DML/DQL since it expects
    // those to be identifiers. Either pragma below permits the legacy form;
    // safe because we control the SQL — no untrusted input is ever quoted
    // in this way (consumers compose with their own sanitised values).
    try { this._db.pragma('legacy_double_quoted_strings = 1'); } catch { /* older sqlite */ }
    try { this._db.pragma('writable_schema_compat = 1'); } catch { /* ignore */ }
    this._tables = new Map();
  }

  async tableNames() {
    const rows = this._db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    return rows.map((r) => r.name).filter((n) => !n.startsWith('_meta'));
  }

  async openTable(name) {
    if (this._tables.has(name)) return this._tables.get(name);
    const exists = this._db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
    if (!exists) throw new Error(`Table not found: ${name}`);
    const t = new SqliteTable(this._db, name, this._loadSchema(name));
    this._tables.set(name, t);
    return t;
  }

  async createTable(name, sampleRows) {
    if (!Array.isArray(sampleRows) || sampleRows.length === 0) {
      throw new Error('createTable: pass at least one sample row to derive the schema');
    }
    const sample = sampleRows[0];
    const schema = _deriveSchema(sample);
    this._writeSchema(name, schema);
    const colDefs = schema.columns.map((c) => `${_qid(c.name)} ${c.sqlType}`).join(', ');
    const pk = schema.columns.some((c) => c.name === 'id') ? ', PRIMARY KEY (id)' : '';
    this._db.exec(`CREATE TABLE IF NOT EXISTS ${_qid(name)} (${colDefs}${pk})`);
    const t = new SqliteTable(this._db, name, schema);
    await t.add(sampleRows);
    this._tables.set(name, t);
    return t;
  }

  async dropTable(name) {
    this._db.exec(`DROP TABLE IF EXISTS ${_qid(name)}`);
    this._db.prepare(`DELETE FROM _meta_schema WHERE table_name = ?`).run(name);
    this._tables.delete(name);
  }

  _writeSchema(name, schema) {
    this._db.exec(
      'CREATE TABLE IF NOT EXISTS _meta_schema (table_name TEXT PRIMARY KEY, schema_json TEXT)',
    );
    this._db
      .prepare('INSERT OR REPLACE INTO _meta_schema(table_name, schema_json) VALUES (?, ?)')
      .run(name, JSON.stringify(schema));
  }

  _loadSchema(name) {
    try {
      const row = this._db
        .prepare('SELECT schema_json FROM _meta_schema WHERE table_name = ?')
        .get(name);
      if (row && row.schema_json) return JSON.parse(row.schema_json);
    } catch { /* fall through */ }
    // Fallback: rebuild schema from PRAGMA. Vector column detected by name.
    const cols = this._db.prepare(`PRAGMA table_info(${_qid(name)})`).all();
    return {
      columns: cols.map((c) => ({
        name: c.name,
        sqlType: c.type,
        kind: c.name === 'vector' ? 'vector' : (c.type === 'TEXT' ? 'text' : c.type === 'REAL' ? 'real' : c.type === 'INTEGER' ? 'integer' : 'unknown'),
      })),
    };
  }
}

// ─── SqliteTable ────────────────────────────────────────────────────────

class SqliteTable {
  constructor(db, name, schema) {
    this._db = db;
    this._name = name;
    this._schema = schema;
  }

  async add(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const cols = this._schema.columns.map((c) => c.name);
    const placeholders = cols.map(() => '?').join(', ');
    const stmt = this._db.prepare(
      `INSERT OR REPLACE INTO ${_qid(this._name)} (${cols.map(_qid).join(', ')}) VALUES (${placeholders})`,
    );
    const tx = this._db.transaction((batch) => {
      for (const row of batch) stmt.run(...this._encodeRow(row));
    });
    tx(rows);
  }

  async delete(whereClause) {
    if (!whereClause || typeof whereClause !== 'string') return;
    this._db.exec(`DELETE FROM ${_qid(this._name)} WHERE ${_normaliseWhere(whereClause)}`);
  }

  /**
   * Update rows matching `where`. Mimics the two LanceDB shapes used by
   * media-library.js:
   *   1) `update({ col: val, ... }, { where: "..." })`        ← legacy 2-arg
   *   2) `update({ values: { col: val }, where: "..." })`     ← explicit 1-arg
   * Values are bound via SQLite parameters (no SQL splicing), so JSON blobs
   * and strings with quotes are safe — that's the whole reason the consumer
   * had to use the explicit shape on LanceDB.
   */
  async update(arg1, arg2) {
    let values, where;
    if (arg2 !== undefined) {
      values = arg1 || {};
      where = (arg2 && typeof arg2 === 'object') ? arg2.where : null;
    } else if (arg1 && typeof arg1 === 'object'
        && (arg1.values !== undefined || arg1.where !== undefined)) {
      values = arg1.values || {};
      where = arg1.where;
    } else {
      values = arg1 || {};
      where = null;
    }

    const keys = Object.keys(values);
    if (keys.length === 0) return;

    const setClauses = keys.map((k) => `${_qid(k)} = ?`).join(', ');
    const params = keys.map((k) => {
      const col = this._schema.columns.find((c) => c.name === k);
      // If the column wasn't in the seed row (shouldn't happen in practice
      // — consumers add it via the seed), fall back to a sensible kind so
      // we still write SOMETHING usable instead of throwing.
      const kind = col?.kind
        ?? (typeof values[k] === 'number' ? 'real'
          : typeof values[k] === 'boolean' ? 'boolean'
          : typeof values[k] === 'string' ? 'text'
          : 'json');
      return _encodeValue(values[k], kind);
    });

    let sql = `UPDATE ${_qid(this._name)} SET ${setClauses}`;
    if (where) sql += ` WHERE ${_normaliseWhere(where)}`;
    this._db.prepare(sql).run(...params);
  }

  query() {
    return new SqliteQueryBuilder(this);
  }

  search(vector) {
    return new SqliteSearchBuilder(this, vector);
  }

  _encodeRow(row) {
    return this._schema.columns.map((c) => _encodeValue(row[c.name], c.kind));
  }

  _decodeRow(row) {
    const out = {};
    for (const c of this._schema.columns) {
      out[c.name] = _decodeValue(row[c.name], c.kind);
    }
    return out;
  }
}

// ─── Query builder (no-vector lookups) ──────────────────────────────────

class SqliteQueryBuilder {
  constructor(table) {
    this._table = table;
    this._where = null;
    this._limit = null;
  }

  where(clause) { this._where = clause; return this; }
  limit(n) { this._limit = n; return this; }

  async toArray() {
    let sql = `SELECT * FROM ${_qid(this._table._name)}`;
    if (this._where) sql += ` WHERE ${_normaliseWhere(this._where)}`;
    if (this._limit != null) sql += ` LIMIT ${Math.max(0, Math.floor(this._limit))}`;
    const rows = this._table._db.prepare(sql).all();
    return rows.map((r) => this._table._decodeRow(r));
  }
}

// ─── Search builder (vector cosine) ─────────────────────────────────────

class SqliteSearchBuilder {
  constructor(table, vector) {
    this._table = table;
    this._vector = vector;
    this._where = null;
    this._limit = 10;
  }

  where(clause) { this._where = clause; return this; }
  limit(n) { this._limit = n; return this; }

  async toArray() {
    let sql = `SELECT * FROM ${_qid(this._table._name)}`;
    if (this._where) sql += ` WHERE ${_normaliseWhere(this._where)}`;
    const rows = this._table._db.prepare(sql).all();
    const decoded = rows.map((r) => this._table._decodeRow(r));
    const queryVec = _toFloat32(this._vector);
    const vectorCol = this._table._schema.columns.find((c) => c.kind === 'vector')?.name;
    const scored = [];
    for (const row of decoded) {
      const v = vectorCol ? row[vectorCol] : null;
      const score = (v && v.length === queryVec.length) ? _cosine(queryVec, v) : 0;
      scored.push({ row, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, Math.max(0, Math.floor(this._limit)));
    // LanceDB returns a `_distance` field on search results (lower = closer).
    // Match that contract: distance = 1 - cosine_similarity (since vectors are
    // typically L2-normalised, this approximates Euclidean rank).
    return top.map((s) => ({ ...s.row, _distance: 1 - s.score }));
  }
}

// ─── Schema derivation + value encoding ─────────────────────────────────

function _deriveSchema(sample) {
  const columns = [];
  for (const [key, value] of Object.entries(sample)) {
    columns.push(_classify(key, value));
  }
  // Ensure id column exists (semantic-index relies on `id = "..."` lookups).
  if (!columns.some((c) => c.name === 'id')) {
    columns.unshift({ name: 'id', sqlType: 'TEXT', kind: 'text' });
  }
  return { columns };
}

function _classify(name, value) {
  // Vector heuristic: a Float32Array of any size, or a plain Array<number>
  // of length ≥ 64. The 64 floor comfortably excludes regular tuples (e.g.
  // `[width, height]`, `[r, g, b, a]`) but accepts every embedding size we
  // care about (384, 768, 1024, 1536, 3072 …). The column name is no
  // longer required to be `vector` — `embedding` works too.
  if (value instanceof Float32Array
      || (Array.isArray(value) && value.length >= 64 && typeof value[0] === 'number')) {
    return { name, sqlType: 'BLOB', kind: 'vector' };
  }
  if (Buffer.isBuffer(value)) return { name, sqlType: 'BLOB', kind: 'blob' };
  if (typeof value === 'number') return { name, sqlType: 'REAL', kind: 'real' };
  if (typeof value === 'boolean') return { name, sqlType: 'INTEGER', kind: 'boolean' };
  if (typeof value === 'string') return { name, sqlType: 'TEXT', kind: 'text' };
  if (value === null || value === undefined) return { name, sqlType: 'TEXT', kind: 'text' };
  // arrays / objects → JSON-encoded TEXT
  return { name, sqlType: 'TEXT', kind: 'json' };
}

function _encodeValue(value, kind) {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'vector':
      return Buffer.from(_toFloat32(value).buffer);
    case 'blob':
      return Buffer.isBuffer(value) ? value : Buffer.from(value);
    case 'real':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      return value ? 1 : 0;
    case 'text':
      return typeof value === 'string' ? value : String(value);
    case 'integer':
      return typeof value === 'number' ? value : Number(value);
    case 'json':
      return JSON.stringify(value);
    default:
      return value;
  }
}

function _decodeValue(value, kind) {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'vector':
      // Buffer back into Float32Array (no copy if alignment OK).
      if (!Buffer.isBuffer(value)) return null;
      return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
    case 'blob':
      return value;
    case 'real':
    case 'integer':
      return value;
    case 'boolean':
      return value === 1;
    case 'text':
      return value;
    case 'json':
      try { return JSON.parse(value); } catch { return value; }
    default:
      return value;
  }
}

// ─── Math + util ────────────────────────────────────────────────────────

function _toFloat32(v) {
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return new Float32Array(v);
  return new Float32Array(0);
}

function _cosine(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i], vb = b[i];
    dot += va * vb; magA += va * va; magB += vb * vb;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function _qid(name) {
  // Simple safe quoting for identifiers (column/table names).
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * LanceDB callers freely use double-quoted string literals inside WHERE
 * clauses (`id = "abc"`). Stock SQLite treats those as identifiers and
 * errors. We rewrite them to single-quoted, escaping internal single
 * quotes by doubling them (SQL standard).
 *
 * The regex tokenises on:
 *   1. existing single-quoted strings (passed through verbatim, with internal
 *      doublings preserved)
 *   2. double-quoted strings → converted
 *   3. everything else → passed through
 */
function _normaliseWhere(clause) {
  if (!clause) return clause;
  let out = '';
  let i = 0;
  const n = clause.length;
  while (i < n) {
    const ch = clause[i];
    if (ch === "'") {
      // existing single-quoted literal — find matching close, copy as-is.
      out += ch; i++;
      while (i < n) {
        out += clause[i];
        if (clause[i] === "'" && clause[i + 1] !== "'") { i++; break; }
        if (clause[i] === "'" && clause[i + 1] === "'") { out += clause[++i]; i++; continue; }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      // double-quoted literal — find close, escape any ' inside.
      i++; // skip opening "
      let lit = '';
      while (i < n && clause[i] !== '"') {
        // Preserve escaped backslashes so `\"` etc. don't confuse us.
        if (clause[i] === '\\' && i + 1 < n) { lit += clause[i] + clause[i + 1]; i += 2; continue; }
        lit += clause[i]; i++;
      }
      i++; // skip closing "
      out += "'" + lit.replace(/'/g, "''") + "'";
      continue;
    }
    out += ch; i++;
  }
  return out;
}
