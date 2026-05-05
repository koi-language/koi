import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
class GraphCache {
  graph = null;
  async get(notesDir) {
    if (!this.graph) {
      this.graph = await buildGraph(notesDir);
    }
    return this.graph;
  }
  invalidate() {
    this.graph = null;
  }
}
async function buildGraph(notesDir) {
  let files;
  try {
    files = await fs.readdir(notesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      return { outgoing: /* @__PURE__ */ new Map(), incoming: /* @__PURE__ */ new Map() };
    }
    throw err;
  }
  const markdownFiles = files.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => path.join(notesDir, entry.name));
  const outgoing = /* @__PURE__ */ new Map();
  const incoming = /* @__PURE__ */ new Map();
  for (const filePath of markdownFiles) {
    const title = path.basename(filePath, ".md");
    const content = await fs.readFile(filePath, "utf8");
    const { data } = parseFrontmatter(content);
    if (data?.status === "archived") {
      continue;
    }
    const links = /* @__PURE__ */ new Set();
    for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = match[1]?.trim();
      if (target && target.length > 0) {
        links.add(target);
      }
    }
    outgoing.set(title, links);
    for (const target of links) {
      if (!incoming.has(target)) incoming.set(target, /* @__PURE__ */ new Set());
      incoming.get(target).add(title);
    }
  }
  return { outgoing, incoming };
}
function findOrphans(graph, allNotes) {
  return allNotes.filter((note) => !graph.incoming.has(note));
}
function findDanglingLinks(graph, allNotes) {
  const existing = new Set(allNotes);
  const dangling = /* @__PURE__ */ new Set();
  for (const [_, links] of graph.outgoing) {
    for (const target of links) {
      if (!existing.has(target)) {
        dangling.add(target);
      }
    }
  }
  return Array.from(dangling).sort();
}
function findBacklinks(graph, note) {
  return Array.from(graph.incoming.get(note) ?? []).sort();
}
export {
  GraphCache,
  buildGraph,
  findBacklinks,
  findDanglingLinks,
  findOrphans
};
