import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// koi-fork: vault root lives at <project>/.koi/memory/ (not at project root)
// and global vault is ~/.koi-memory/. The .ori marker file is preserved
// inside the vault root for upstream compatibility.
const KOI_MEMORY_SUBDIR = path.join(".koi", "memory");

async function isVaultRoot(dir) {
  try {
    // koi-fork: .ori is a directory in v0.5.x (was a file in older versions)
    const stat = await fs.stat(path.join(dir, ".ori"));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// koi-fork: helper — given a project dir, return its embedded vault path
function vaultPathFor(projectDir) {
  return path.join(projectDir, KOI_MEMORY_SUBDIR);
}

function getGlobalVaultPath() {
  // koi-fork: ~/.koi-memory/ (was ~/.ori-memory/)
  return path.join(os.homedir(), ".koi-memory");
}

async function findVaultRootWithSource(startDir, override) {
  if (override) {
    const resolved = path.resolve(override);
    if (await isVaultRoot(resolved)) return { path: resolved, source: "project" };
    throw new Error(
      `Vault not found at specified path: ${resolved}. Run 'koi memory init ${resolved}' to create one.`
    );
  }
  // koi-fork: walk up looking for <dir>/.koi/memory/.ori (the embedded vault)
  let current = path.resolve(startDir ?? process.cwd());
  while (true) {
    const candidate = vaultPathFor(current);
    if (await isVaultRoot(candidate)) return { path: candidate, source: "project" };
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const globalPath = getGlobalVaultPath();
  if (await isVaultRoot(globalPath)) return { path: globalPath, source: "global" };
  throw new Error(
    "No .koi/memory/.ori marker found. Run 'koi memory init' to create a vault."
  );
}
async function findVaultRoot(startDir, override) {
  const result = await findVaultRootWithSource(startDir, override);
  return result.path;
}
function getVaultPaths(root) {
  return {
    root,
    marker: path.join(root, ".ori"),
    config: path.join(root, "ori.config.yaml"),
    notes: path.join(root, "notes"),
    inbox: path.join(root, "inbox"),
    templates: path.join(root, "templates"),
    self: path.join(root, "self"),
    selfMemory: path.join(root, "self", "memory"),
    ops: path.join(root, "ops"),
    opsSessions: path.join(root, "ops", "sessions"),
    opsObservations: path.join(root, "ops", "observations")
  };
}

// koi-fork: per-agent scope helper — returns a paths struct rooted at
// <vault>/self/<agent>/ for agent-private memory. Used by Koi's memory
// wrapper to give each agent its own notes/, inbox/, etc.
function getAgentScopePaths(root, agentName) {
  if (!agentName || typeof agentName !== "string") {
    throw new Error("getAgentScopePaths requires an agentName");
  }
  const agentRoot = path.join(root, "self", agentName);
  return {
    root: agentRoot,
    notes: path.join(agentRoot, "notes"),
    inbox: path.join(agentRoot, "inbox")
  };
}
async function listNoteTitles(notesDir) {
  try {
    const entries = await fs.readdir(notesDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name.replace(/\.md$/, ""));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}
export {
  findVaultRoot,
  findVaultRootWithSource,
  getAgentScopePaths,    // koi-fork
  getGlobalVaultPath,
  getVaultPaths,
  isVaultRoot,
  listNoteTitles,
  vaultPathFor           // koi-fork
};
