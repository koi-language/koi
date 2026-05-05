import { existsSync } from "node:fs";
import path from "node:path";
import { initDB, loadVectors, cosine } from "./engine.js";
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function titleToPattern(title) {
  const flexible = escapeRegex(title).replace(/-/g, "[-\\s]");
  return new RegExp(`\\b${flexible}\\b`, "gi");
}
function isInsideWikiLink(body, offset) {
  let i = offset - 1;
  while (i >= 1) {
    if (body[i] === "[" && body[i - 1] === "[") {
      const between = body.slice(i + 1, offset);
      if (!between.includes("]]")) {
        return true;
      }
    }
    if (body[i] === "]" && i > 0 && body[i - 1] === "]") {
      break;
    }
    i--;
  }
  return false;
}
function detectLinks(body, existingTitles) {
  const sorted = [...existingTitles].sort((a, b) => b.length - a.length);
  const results = [];
  const covered = /* @__PURE__ */ new Set();
  for (const title of sorted) {
    if (title.length === 0) continue;
    const pattern = titleToPattern(title);
    let match;
    while ((match = pattern.exec(body)) !== null) {
      const offset = match.index;
      const length = match[0].length;
      let overlaps = false;
      for (let p = offset; p < offset + length; p++) {
        if (covered.has(p)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      const alreadyLinked = isInsideWikiLink(body, offset);
      results.push({ title, offset, length, alreadyLinked });
      for (let p = offset; p < offset + length; p++) {
        covered.add(p);
      }
    }
  }
  return results.sort((a, b) => a.offset - b.offset);
}
function applyLinks(body, links) {
  const toApply = links.filter((l) => !l.alreadyLinked).sort((a, b) => b.offset - a.offset);
  let result = body;
  for (const link of toApply) {
    const before = result.slice(0, link.offset);
    const after = result.slice(link.offset + link.length);
    result = `${before}[[${link.title}]]${after}`;
  }
  return result;
}
function suggestLinks(frontmatter, body, vaultIndex) {
  const suggestions = /* @__PURE__ */ new Map();
  const noteProject = Array.isArray(frontmatter.project) ? frontmatter.project : [];
  const noteTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  const detected = detectLinks(body, vaultIndex.titles);
  for (const link of detected) {
    if (!link.alreadyLinked) {
      suggestions.set(link.title, {
        title: link.title,
        reason: "title-match",
        confidence: 0.9
      });
    }
  }
  if (noteProject.length > 0) {
    const projectSizes = /* @__PURE__ */ new Map();
    for (const [, fm] of vaultIndex.frontmatter) {
      const projects = Array.isArray(fm.project) ? fm.project : [];
      for (const p of projects)
        projectSizes.set(p, (projectSizes.get(p) ?? 0) + 1);
    }
    for (const [title, fm] of vaultIndex.frontmatter) {
      if (suggestions.has(title)) continue;
      const otherProject = Array.isArray(fm.project) ? fm.project : [];
      const overlap = noteProject.filter(
        (p) => otherProject.includes(p) && (projectSizes.get(p) ?? 0) <= 10
      );
      if (overlap.length > 0) {
        suggestions.set(title, {
          title,
          reason: "project-overlap",
          confidence: 0.6 + overlap.length * 0.1
        });
      }
    }
  }
  if (noteTags.length > 0) {
    for (const [title, fm] of vaultIndex.frontmatter) {
      if (suggestions.has(title)) continue;
      const otherTags = Array.isArray(fm.tags) ? fm.tags : [];
      const overlap = noteTags.filter((t) => otherTags.includes(t));
      if (overlap.length > 0) {
        suggestions.set(title, {
          title,
          reason: "tag-overlap",
          confidence: 0.5 + overlap.length * 0.1
        });
      }
    }
  }
  const myLinks = new Set(
    detected.filter((d) => !d.alreadyLinked).map((d) => d.title)
  );
  for (const linkedTitle of myLinks) {
    const coLinkers = vaultIndex.graph.incoming.get(linkedTitle);
    if (coLinkers) {
      for (const coLinker of coLinkers) {
        if (suggestions.has(coLinker) || myLinks.has(coLinker)) continue;
        suggestions.set(coLinker, {
          title: coLinker,
          reason: "shared-neighborhood",
          confidence: 0.5
        });
      }
    }
    const outgoing = vaultIndex.graph.outgoing.get(linkedTitle);
    if (outgoing) {
      for (const target of outgoing) {
        if (suggestions.has(target) || myLinks.has(target)) continue;
        suggestions.set(target, {
          title: target,
          reason: "shared-neighborhood",
          confidence: 0.45
        });
      }
    }
  }
  return Array.from(suggestions.values()).sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}
function suggestLinksWithSemantic(noteTitle, frontmatter, body, vaultIndex, vaultRoot, engineConfig) {
  const suggestions = suggestLinks(frontmatter, body, vaultIndex);
  const existingTitles = new Set(suggestions.map((s) => s.title));
  const dbPath = path.resolve(vaultRoot, engineConfig.db_path);
  if (!existsSync(dbPath)) return suggestions;
  try {
    const db = initDB(dbPath);
    const vectors = loadVectors(db);
    db.close();
    const noteVec = vectors.get(noteTitle);
    if (!noteVec) return suggestions;
    const similarities = [];
    for (const [title, stored] of vectors) {
      if (title === noteTitle) continue;
      if (existingTitles.has(title)) continue;
      const sim = cosine(noteVec.titleVec, stored.titleVec);
      if (sim > 0.5) {
        similarities.push({ title, similarity: sim });
      }
    }
    similarities.sort((a, b) => b.similarity - a.similarity);
    for (const { title, similarity } of similarities.slice(0, 5)) {
      suggestions.push({
        title,
        reason: "semantic-similarity",
        confidence: Math.min(0.95, similarity)
        // cap confidence
      });
    }
  } catch {
  }
  suggestions.sort((a, b) => b.confidence - a.confidence);
  return suggestions;
}
export {
  applyLinks,
  detectLinks,
  suggestLinks,
  suggestLinksWithSemantic
};
