import { promises as fs } from "node:fs";
import path from "node:path";
import { getVaultPaths } from "./vault.js";
const DEFAULT_STATE = {
  onboarded: false,
  version: "0.0.0"
};
function statePath(vaultDir) {
  return path.join(getVaultPaths(vaultDir).marker, "state.json");
}
async function readState(vaultDir) {
  try {
    const raw = await fs.readFile(statePath(vaultDir), "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}
async function writeState(vaultDir, updates) {
  const current = await readState(vaultDir);
  const merged = { ...current, ...updates };
  const fp = statePath(vaultDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(merged, null, 2) + "\n", "utf8");
}
function isOnboarded(state) {
  return state.onboarded === true;
}
export {
  isOnboarded,
  readState,
  writeState
};
