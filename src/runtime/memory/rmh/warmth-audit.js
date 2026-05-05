// koi-fork: env vars renamed ORI_* → KOI_*
import { promises as fs } from "node:fs";
import path from "node:path";
const DEFAULT_WARMTH_AUDIT_PATH = ".ori/warmth-audit.jsonl";
function isWarmthAuditEnabled() {
  const value = process.env.KOI_WARMTH_AUDIT;
  if (!value) return false;
  return value !== "0" && value.toLowerCase() !== "false";
}
function getWarmthAuditPath(vaultRoot) {
  const override = process.env.KOI_WARMTH_AUDIT_PATH;
  return path.resolve(vaultRoot, override && override.trim() ? override : DEFAULT_WARMTH_AUDIT_PATH);
}
async function logWarmthAudit(vaultRoot, event) {
  const logPath = getWarmthAuditPath(vaultRoot);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify(event) + "\n", "utf8");
}
async function loadWarmthAudit(vaultRoot) {
  const logPath = getWarmthAuditPath(vaultRoot);
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
async function queryWarmthAudit(vaultRoot, options) {
  const events = await loadWarmthAudit(vaultRoot);
  const needle = options?.query?.trim().toLowerCase();
  const filtered = needle ? events.filter((event) => event.query.toLowerCase().includes(needle)) : events;
  const limit = options?.limit ?? 10;
  return filtered.slice(-limit).reverse();
}
export {
  DEFAULT_WARMTH_AUDIT_PATH,
  isWarmthAuditEnabled,
  loadWarmthAudit,
  logWarmthAudit,
  queryWarmthAudit
};
