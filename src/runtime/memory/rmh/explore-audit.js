// koi-fork: env vars renamed ORI_* → KOI_*
import { promises as fs } from "node:fs";
import path from "node:path";
const DEFAULT_EXPLORE_AUDIT_PATH = ".ori/explore-audit.jsonl";
function isExploreAuditEnabled() {
  const value = process.env.KOI_EXPLORE_AUDIT;
  if (!value) return false;
  return value !== "0" && value.toLowerCase() !== "false";
}
function getExploreAuditPath(vaultRoot) {
  const override = process.env.KOI_EXPLORE_AUDIT_PATH;
  return path.resolve(vaultRoot, override && override.trim() ? override : DEFAULT_EXPLORE_AUDIT_PATH);
}
async function logExploreAudit(vaultRoot, event) {
  const logPath = getExploreAuditPath(vaultRoot);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify(event) + "\n", "utf8");
}
async function loadExploreAudit(vaultRoot) {
  const logPath = getExploreAuditPath(vaultRoot);
  let raw;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
    }
  }
  return events;
}
async function queryExploreAudit(vaultRoot, options) {
  const events = await loadExploreAudit(vaultRoot);
  const needle = options?.query?.trim().toLowerCase();
  const filtered = needle ? events.filter((event) => event.query.toLowerCase().includes(needle)) : events;
  const limit = options?.limit ?? 10;
  return filtered.slice(-limit).reverse();
}
export {
  DEFAULT_EXPLORE_AUDIT_PATH,
  isExploreAuditEnabled,
  loadExploreAudit,
  logExploreAudit,
  queryExploreAudit
};
