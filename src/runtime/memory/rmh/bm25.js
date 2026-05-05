import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
const STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with"
]);
function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}
const DEFAULT_BM25 = {
  k1: 1.2,
  b: 0.75,
  title_boost: 3,
  description_boost: 2
};
function buildBM25Index(docs, config = DEFAULT_BM25) {
  const termFreqs = /* @__PURE__ */ new Map();
  const docLengths = /* @__PURE__ */ new Map();
  for (const doc of docs) {
    const titleTokens = tokenize(doc.title);
    const descTokens = tokenize(doc.description);
    const bodyTokens = tokenize(doc.body);
    const bag = /* @__PURE__ */ new Map();
    for (const t of titleTokens) {
      bag.set(t, (bag.get(t) ?? 0) + config.title_boost);
    }
    for (const t of descTokens) {
      bag.set(t, (bag.get(t) ?? 0) + config.description_boost);
    }
    for (const t of bodyTokens) {
      bag.set(t, (bag.get(t) ?? 0) + 1);
    }
    let docLen = 0;
    for (const count of bag.values()) {
      docLen += count;
    }
    docLengths.set(doc.title, docLen);
    for (const [term, count] of bag) {
      let docMap = termFreqs.get(term);
      if (!docMap) {
        docMap = /* @__PURE__ */ new Map();
        termFreqs.set(term, docMap);
      }
      docMap.set(doc.title, count);
    }
  }
  const totalLength = Array.from(docLengths.values()).reduce((a, b) => a + b, 0);
  const avgDocLength = docs.length > 0 ? totalLength / docs.length : 0;
  return {
    termFreqs,
    docLengths,
    avgDocLength,
    docCount: docs.length
  };
}
function searchBM25(query, index, config = DEFAULT_BM25, limit = 10) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const { termFreqs, docLengths, avgDocLength, docCount } = index;
  const { k1, b } = config;
  const N = docCount;
  const scores = /* @__PURE__ */ new Map();
  for (const term of queryTokens) {
    const docMap = termFreqs.get(term);
    if (!docMap) continue;
    const n = docMap.size;
    const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
    for (const [docTitle, tf] of docMap) {
      const dl = docLengths.get(docTitle) ?? 0;
      const tfNorm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (dl / avgDocLength)));
      const termScore = idf * tfNorm;
      scores.set(docTitle, (scores.get(docTitle) ?? 0) + termScore);
    }
  }
  const results = [];
  for (const [title, score] of scores) {
    results.push({
      title,
      score,
      signals: { keyword: score }
    });
  }
  results.sort((a, b2) => b2.score - a.score);
  return results.slice(0, limit);
}
async function buildBM25IndexFromVault(vaultRoot, config = DEFAULT_BM25) {
  const notesDir = path.join(vaultRoot, "notes");
  const entries = await fs.readdir(notesDir);
  const mdFiles = entries.filter((e) => e.endsWith(".md"));
  const docs = [];
  for (const file of mdFiles) {
    const filePath = path.join(notesDir, file);
    const content = await fs.readFile(filePath, "utf-8");
    const { data, body } = parseFrontmatter(content);
    const title = file.replace(/\.md$/, "");
    const description = data && typeof data.description === "string" ? data.description : "";
    docs.push({ title, description, body });
  }
  return buildBM25Index(docs, config);
}
export {
  buildBM25Index,
  buildBM25IndexFromVault,
  searchBM25,
  tokenize
};
