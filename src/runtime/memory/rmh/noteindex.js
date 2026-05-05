import path from "node:path";
import { promises as fs } from "node:fs";
import { parseFrontmatter } from "./frontmatter.js";
import { computeVitalityFull } from "./vitality.js";
async function buildNoteIndex(notesDir, titles) {
  const frontmatter = /* @__PURE__ */ new Map();
  for (const title of titles) {
    const filePath = path.join(notesDir, `${title}.md`);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const { data } = parseFrontmatter(content);
      if (data) {
        frontmatter.set(title, data);
      }
    } catch {
    }
  }
  return { frontmatter };
}
async function computeAllVitality(notesDir, titles, linkGraph, bridges, config, boostScores) {
  const scores = /* @__PURE__ */ new Map();
  const now = /* @__PURE__ */ new Date();
  for (const title of titles) {
    const filePath = path.join(notesDir, `${title}.md`);
    let accessCount = 0;
    let created = now.toISOString();
    try {
      const content = await fs.readFile(filePath, "utf8");
      const { data } = parseFrontmatter(content);
      if (data) {
        if (typeof data.access_count === "number") {
          accessCount = data.access_count;
        }
        if (typeof data.created === "string") {
          created = data.created;
        }
      }
    } catch {
    }
    const inDegree = linkGraph.incoming.get(title)?.size ?? 0;
    const vitality = computeVitalityFull({
      accessCount,
      created,
      noteTitle: title,
      inDegree,
      bridges,
      metabolicRate: config.vitality.metabolic_rates?.notes ?? 1,
      actrDecay: config.vitality.actr_decay ?? 0.5,
      accessSaturationK: config.vitality.access_saturation_k ?? 10,
      bridgeFloor: config.graph.bridge_vitality_floor,
      activationBoost: boostScores?.get(title)
    });
    scores.set(title, vitality);
  }
  return scores;
}
export {
  buildNoteIndex,
  computeAllVitality
};
