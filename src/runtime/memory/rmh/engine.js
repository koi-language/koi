import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
// koi-fork: cloud embeddings via Koi's EmbeddingProvider, no @huggingface/transformers
import { embedText as koiEmbedText } from "./_koi-bridge.js";
import { buildGraph } from "./graph.js";
import { parseFrontmatter } from "./frontmatter.js";
import { computeGraphMetrics } from "./importance.js";
function initDB(dbPath) {
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      title TEXT PRIMARY KEY,
      title_vec BLOB,
      desc_vec BLOB,
      body_vec BLOB,
      type_vec BLOB,
      community_vec BLOB,
      content_hash TEXT,
      indexed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS boosts (
      title TEXT PRIMARY KEY,
      boost REAL DEFAULT 0,
      updated TEXT,
      access_count INTEGER DEFAULT 1,
      sessions TEXT DEFAULT ''
    );
  `);
  try {
    db.exec(`ALTER TABLE boosts ADD COLUMN access_count INTEGER DEFAULT 1`);
  } catch {
  }
  try {
    db.exec(`ALTER TABLE boosts ADD COLUMN sessions TEXT DEFAULT ''`);
  } catch {
  }
  return db;
}
function removeNoteFromDB(db, title) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM embeddings WHERE title = ?").run(title);
    db.prepare("DELETE FROM boosts WHERE title = ?").run(title);
  });
  tx();
}
function loadVectors(db) {
  const rows = db.prepare(
    `SELECT title, title_vec, desc_vec, body_vec, type_vec, community_vec, content_hash, indexed_at FROM embeddings`
  ).all();
  const map = /* @__PURE__ */ new Map();
  for (const row of rows) {
    map.set(row.title, {
      titleVec: bufferToFloat32(row.title_vec),
      descVec: bufferToFloat32(row.desc_vec),
      bodyVec: bufferToFloat32(row.body_vec),
      typeVec: bufferToFloat32(row.type_vec),
      communityVec: bufferToFloat32(row.community_vec),
      contentHash: row.content_hash,
      indexedAt: row.indexed_at
    });
  }
  return map;
}
// koi-fork: delegate to Koi's cloud embedding provider via the bridge.
// The `config` argument is ignored — model selection happens in Koi's
// EmbeddingProvider based on KOI_AUTH_TOKEN / OPENAI_API_KEY / GEMINI_API_KEY.
async function embedText(text, _config) {
  const result = await koiEmbedText(text);
  return result instanceof Float32Array ? result : new Float32Array(result);
}
function buildKnowledgeEnrichedText(title, frontmatter, body, linkGraph) {
  const noteType = typeof frontmatter.type === "string" ? frontmatter.type : "";
  const projects = Array.isArray(frontmatter.project) ? frontmatter.project.join(", ") : typeof frontmatter.project === "string" ? frontmatter.project : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  const outgoing = linkGraph.outgoing.get(title);
  const connected = outgoing ? Array.from(outgoing).slice(0, 10).join(", ") : "";
  const parts = [];
  if (noteType || projects) {
    const typePart = noteType ? `[${noteType.toUpperCase()}]` : "";
    const projPart = projects ? `[${projects}]` : "";
    parts.push([typePart, projPart].filter(Boolean).join(" "));
  }
  parts.push(title);
  if (description) parts.push(description);
  if (connected) parts.push(`Connected: ${connected}`);
  return parts.join("\n");
}
function encodePiecewiseLinear(value, bins) {
  const vec = new Float32Array(bins);
  const v = Math.max(0, Math.min(1, value));
  const scaled = v * bins;
  const binIndex = Math.min(Math.floor(scaled), bins - 1);
  const frac = scaled - binIndex;
  for (let i = 0; i < bins; i++) {
    if (i < binIndex) {
      vec[i] = 1;
    } else if (i === binIndex) {
      vec[i] = frac;
    }
  }
  if (v >= 1) {
    for (let i = 0; i < bins; i++) {
      vec[i] = 1;
    }
  }
  return vec;
}
const TYPE_LABELS = [
  "idea",
  "decision",
  "learning",
  "insight",
  "blocker",
  "opportunity"
];
function encodeType(noteType) {
  const vec = new Float32Array(6);
  const idx = TYPE_LABELS.indexOf(
    noteType
  );
  if (idx >= 0) {
    vec[idx] = 1;
  }
  return vec;
}
const PRIMES = [
  2,
  3,
  5,
  7,
  11,
  13,
  17,
  19,
  23,
  29,
  31,
  37,
  41,
  43,
  47,
  53
];
function encodeCommunity(communityId, totalCommunities, dims) {
  const vec = new Float32Array(dims);
  const tc = Math.max(totalCommunities, 1);
  for (let d = 0; d < dims; d++) {
    const prime = PRIMES[d % PRIMES.length];
    const angle = communityId * prime / tc;
    vec[d] = d % 2 === 0 ? Math.sin(angle) : Math.cos(angle);
  }
  return vec;
}
function cosine(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
function hashContent(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
function float32ToBuffer(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
function bufferToFloat32(buf) {
  const copy = new ArrayBuffer(buf.byteLength);
  const view = new Uint8Array(copy);
  view.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(copy);
}
async function indexNote(db, title, frontmatter, body, linkGraph, communities, totalCommunities, config) {
  const enrichedText = buildKnowledgeEnrichedText(
    title,
    frontmatter,
    body,
    linkGraph
  );
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  const noteType = typeof frontmatter.type === "string" ? frontmatter.type : "";
  const communityId = communities.get(title) ?? 0;
  const [titleVec, descVec, bodyVec] = await Promise.all([
    embedText(title, config),
    embedText(description || title, config),
    embedText(enrichedText, config)
  ]);
  const typeVec = encodeType(noteType);
  const communityVec = encodeCommunity(
    communityId,
    totalCommunities,
    config.community_dims
  );
  const contentHashValue = hashContent(`${title}
${description}
${body}`);
  const indexedAt = (/* @__PURE__ */ new Date()).toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO embeddings
       (title, title_vec, desc_vec, body_vec, type_vec, community_vec, content_hash, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    title,
    float32ToBuffer(titleVec),
    float32ToBuffer(descVec),
    float32ToBuffer(bodyVec),
    float32ToBuffer(typeVec),
    float32ToBuffer(communityVec),
    contentHashValue,
    indexedAt
  );
}
async function buildIndex(vaultRoot, config, options) {
  const start = Date.now();
  const notesDir = path.join(vaultRoot, "notes");
  const dbPath = path.resolve(vaultRoot, config.db_path);
  const db = initDB(dbPath);
  const linkGraph = await buildGraph(notesDir);
  const graphMetrics = computeGraphMetrics(linkGraph);
  const totalCommunities = graphMetrics.communityStats.size;
  const existingRows = db.prepare("SELECT title, content_hash FROM embeddings").all();
  const existingHashes = new Map(
    existingRows.map((r) => [r.title, r.content_hash])
  );
  let files;
  try {
    const dirents = await fs.readdir(notesDir, { withFileTypes: true });
    files = dirents.filter((d) => d.isFile() && d.name.endsWith(".md")).map((d) => d.name);
  } catch {
    files = [];
  }
  const activeNotes = [];
  for (const file of files) {
    const title = path.basename(file, ".md");
    const filePath = path.join(notesDir, file);
    const content = await fs.readFile(filePath, "utf8");
    const { data: frontmatter, body } = parseFrontmatter(content);
    const fm = frontmatter ?? {};
    if (fm.status === "archived") {
      continue;
    }
    const description = typeof fm.description === "string" ? fm.description : "";
    const contentHashValue = hashContent(
      `${title}
${description}
${body}`
    );
    activeNotes.push({
      title,
      frontmatter: fm,
      body,
      contentHashValue
    });
  }
  const activeTitles = new Set(activeNotes.map((note) => note.title));
  for (const title of existingHashes.keys()) {
    if (!activeTitles.has(title)) {
      removeNoteFromDB(db, title);
      existingHashes.delete(title);
    }
  }
  let indexed = 0;
  let skipped = 0;
  for (const note of activeNotes) {
    if (!options?.force && existingHashes.get(note.title) === note.contentHashValue) {
      skipped++;
      continue;
    }
    await indexNote(
      db,
      note.title,
      note.frontmatter,
      note.body,
      linkGraph,
      graphMetrics.communities,
      totalCommunities,
      config
    );
    indexed++;
  }
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
  ).run("built_at", (/* @__PURE__ */ new Date()).toISOString());
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
  ).run("note_count", String(activeNotes.length));
  db.close();
  return {
    indexed,
    skipped,
    total: activeNotes.length,
    durationMs: Date.now() - start,
    model: config.embedding_model
  };
}
async function searchComposite(params) {
  const {
    queryText,
    intent,
    storedVectors,
    graphMetrics,
    vitalityScores,
    limit,
    config
  } = params;
  const queryVec = await embedText(queryText, config);
  const sw = intent.spaceWeights;
  const splitW = intent.splitWeights;
  const bins = config.piecewise_bins;
  const queryTemporalVec = encodePiecewiseLinear(1, bins);
  const queryVitalityVec = encodePiecewiseLinear(1, bins);
  const importanceTarget = intent.intent === "procedural" || intent.intent === "decision" ? 0.8 : 0.5;
  const queryImportanceVec = encodePiecewiseLinear(importanceTarget, bins);
  let maxPR = 0;
  for (const pr of graphMetrics.pagerank.values()) {
    if (pr > maxPR) maxPR = pr;
  }
  if (maxPR === 0) maxPR = 1;
  const results = [];
  for (const [title, vectors] of storedVectors) {
    const titleSim = cosine(queryVec, vectors.titleVec);
    const descSim = cosine(queryVec, vectors.descVec);
    const bodySim = cosine(queryVec, vectors.bodyVec);
    const textScore = splitW.title * titleSim + splitW.description * descSim + splitW.body * bodySim;
    const queryTypeVec = buildQueryTypeVec(intent.intent);
    const typeScore = cosine(queryTypeVec, vectors.typeVec);
    const communityScore = vectorNorm(vectors.communityVec) > 0 ? 0.5 : 0;
    const indexedDate = new Date(vectors.indexedAt);
    const now = /* @__PURE__ */ new Date();
    const daysSinceIndex = Math.max(
      0,
      (now.getTime() - indexedDate.getTime()) / (1e3 * 60 * 60 * 24)
    );
    const recency = Math.exp(-daysSinceIndex / 30);
    const temporalVec = encodePiecewiseLinear(recency, bins);
    const temporalScore = cosine(queryTemporalVec, temporalVec);
    const vitalityVal = vitalityScores.get(title) ?? 0.5;
    const vitalityVec = encodePiecewiseLinear(vitalityVal, bins);
    const vitalityScore = cosine(queryVitalityVec, vitalityVec);
    const pr = graphMetrics.pagerank.get(title) ?? 0;
    const normalizedPR = pr / maxPR;
    const importanceVec = encodePiecewiseLinear(normalizedPR, bins);
    const importanceScore = cosine(queryImportanceVec, importanceVec);
    const finalScore = sw.text * textScore + sw.temporal * temporalScore + sw.vitality * vitalityScore + sw.importance * importanceScore + sw.type * typeScore + sw.community * communityScore;
    results.push({
      title,
      score: finalScore,
      signals: { composite: finalScore },
      spaces: {
        text: textScore,
        temporal: temporalScore,
        vitality: vitalityScore,
        importance: importanceScore,
        type: typeScore,
        community: communityScore
      }
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
function buildQueryTypeVec(intent) {
  const vec = new Float32Array(6);
  switch (intent) {
    case "decision":
      vec[1] = 1;
      break;
    case "procedural":
      vec[2] = 0.7;
      vec[3] = 0.3;
      break;
    case "episodic":
      vec[0] = 0.3;
      vec[2] = 0.4;
      vec[3] = 0.3;
      break;
    case "semantic":
    default:
      vec[0] = 0.3;
      vec[2] = 0.3;
      vec[3] = 0.4;
      break;
  }
  return vec;
}
function vectorNorm(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i] * v[i];
  }
  return Math.sqrt(sum);
}
export {
  buildIndex,
  buildKnowledgeEnrichedText,
  cosine,
  embedText,
  encodeCommunity,
  encodePiecewiseLinear,
  encodeType,
  hashContent,
  indexNote,
  initDB,
  loadVectors,
  removeNoteFromDB,
  searchComposite
};
