import { promises as fs } from "node:fs";
import path from "node:path";
async function logAccess(vaultRoot, event, config) {
  const logFile = path.resolve(vaultRoot, config.log_path);
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.appendFile(logFile, JSON.stringify(event) + "\n", "utf-8");
}
async function loadAccessLog(vaultRoot, config) {
  const logFile = path.resolve(vaultRoot, config.log_path);
  let raw;
  try {
    raw = await fs.readFile(logFile, "utf-8");
  } catch {
    return [];
  }
  const events = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      console.warn(`[tracking] skipping malformed line: ${trimmed.slice(0, 80)}`);
    }
  }
  return events;
}
function computePropensity(title, events, epsilon) {
  if (events.length === 0) return epsilon;
  let surfaced = 0;
  for (const event of events) {
    if (event.results.some((r) => r.title === title)) {
      surfaced++;
    }
  }
  if (surfaced === 0) return epsilon;
  return Math.max(surfaced / events.length, epsilon);
}
function buildPropensityMap(events, allNotes, epsilon) {
  const map = /* @__PURE__ */ new Map();
  const total = events.length;
  if (total === 0) {
    for (const note of allNotes) {
      map.set(note, epsilon);
    }
    return map;
  }
  const counts = /* @__PURE__ */ new Map();
  for (const event of events) {
    for (const result of event.results) {
      counts.set(result.title, (counts.get(result.title) || 0) + 1);
    }
  }
  for (const note of allNotes) {
    const surfaced = counts.get(note) ?? 0;
    map.set(note, Math.max(surfaced / total, epsilon));
  }
  return map;
}
function injectExploration(results, allNotes, budget) {
  if (budget <= 0 || results.length === 0) {
    return [...results];
  }
  const replaceCount = Math.max(1, Math.floor(results.length * budget));
  const existingTitles = new Set(results.map((r) => r.title));
  const candidates = allNotes.filter((n) => !existingTitles.has(n));
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picks = shuffled.slice(0, replaceCount);
  const keepCount = results.length - replaceCount;
  const output = results.slice(0, keepCount);
  for (const title of picks) {
    output.push({
      title,
      score: 0,
      signals: {},
      metadata: { wasExploration: true }
    });
  }
  if (picks.length < replaceCount) {
    const deficit = replaceCount - picks.length;
    output.push(...results.slice(keepCount, keepCount + deficit));
  }
  return output;
}
export {
  buildPropensityMap,
  computePropensity,
  injectExploration,
  loadAccessLog,
  logAccess
};
