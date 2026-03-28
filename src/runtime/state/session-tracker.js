/**
 * SessionTracker - Git-based session change tracking with navigable history.
 *
 * Uses a separate GIT_DIR per session so we don't interfere with
 * the project's own .git. The working tree is the project root.
 *
 * Architecture:
 *   - trackFile() stages files (git add) but does NOT commit
 *   - commitChanges(summary) commits all staged files as one changeset
 *   - The agent calls commitChanges() after each prompt execution
 *   - getHistory() returns the full commit log with summaries + timestamps
 *   - checkoutCommit(hash) syncs working tree to any point in history
 *
 * Lazy-initialized: git repo is only created on the first file change.
 * Non-fatal: git failures never break actual file edits.
 */

import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { channel } from '../io/channel.js';

export class SessionTracker {
  constructor(sessionId, projectRoot) {
    this.sessionId = sessionId;
    this.projectRoot = projectRoot;
    this.gitDir = path.join(projectRoot, '.koi', 'sessions', sessionId);
    this.initialized = false;
    this.trackedFiles = new Set();
    this.pendingFiles = new Set(); // files staged but not yet committed
  }

  /** Run git with GIT_DIR/GIT_WORK_TREE pointing to our session repo.
   *  Uses execFileSync (no shell) to avoid pipe/special char issues. */
  _git(args, { noWorkTree = false } = {}) {
    const env = { ...process.env, GIT_DIR: this.gitDir };
    if (!noWorkTree) env.GIT_WORK_TREE = this.projectRoot;
    // Split args respecting quoted strings
    const argv = args.match(/(?:[^\s"]+|"[^"]*")+/g).map(a => a.replace(/^"|"$/g, ''));
    return execFileSync('git', argv, {
      cwd: this.projectRoot,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  }

  /** Initialize the session git repo (lazy, on first file change or query) */
  _ensureInit() {
    if (this.initialized) return;

    // Don't create .koi if it doesn't exist yet — onboarding handles that.
    const koiDir = path.join(this.projectRoot, '.koi');
    if (!fs.existsSync(koiDir)) return;

    const repoExists = fs.existsSync(path.join(this.gitDir, 'HEAD'));

    if (repoExists) {
      // Resuming an existing session — recover tracked files from git history
      this.initialized = true;
      try {
        const files = this._git('log --all --format= --name-only');
        if (files) {
          for (const f of files.split('\n').filter(Boolean)) {
            this.trackedFiles.add(f);
          }
        }
      } catch { /* non-fatal */ }
      channel.log('session', `Resumed session tracker: ${this.sessionId} (${this.trackedFiles.size} files)`);
    } else {
      // New session — create bare repo with empty initial commit
      fs.mkdirSync(this.gitDir, { recursive: true });
      this._git('init --bare', { noWorkTree: true });
      this._git('config user.email "koi-session@local"');
      this._git('config user.name "Koi Session"');
      this._git('commit --allow-empty -m "session start"');
      this.initialized = true;
      channel.log('session', `Initialized session tracker: ${this.sessionId}`);
    }
  }

  /**
   * Stage a file change. Called by edit-file/write-file after successful write.
   * On first track of a file, stages oldContent as a baseline so diffs show
   * actual changes instead of "new file mode".
   * Does NOT commit — call commitChanges() after all actions in a prompt are done.
   */
  trackFile(filePath, oldContent) {
    try {
      this._ensureInit();
      const resolved = path.resolve(filePath);
      const relative = path.relative(this.projectRoot, resolved);

      // Skip files outside the project root — git cannot stage ../paths
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        channel.log('session', `Skipping out-of-root file: ${relative}`);
        return;
      }

      // First time tracking: commit old content as baseline (silent, not a user-visible changeset)
      if (!this.trackedFiles.has(relative) && oldContent !== undefined) {
        const tmpFile = path.join(this.gitDir, 'tmp-baseline');
        fs.writeFileSync(tmpFile, oldContent, 'utf8');
        const hash = this._git(`hash-object -w "${tmpFile}"`).trim();
        fs.unlinkSync(tmpFile);
        this._git(`update-index --add --cacheinfo 100644,${hash},${relative}`);
        this._git(`commit -m "baseline: ${relative}" --allow-empty`);
      }

      this.trackedFiles.add(relative);
      this.pendingFiles.add(relative);
      this._git(`add "${relative}"`);
      channel.log('session', `Staged: ${relative}`);
    } catch (err) {
      channel.log('session', `Stage failed: ${err.message}`);
    }
  }

  /**
   * Commit all staged (pending) files as a single changeset.
   * @param {string} summary - Natural language description of the changes (LLM-generated)
   * @returns {{ success: boolean, hash?: string, files?: string[] }}
   */
  commitChanges(summary) {
    if (!this.initialized || this.pendingFiles.size === 0) {
      return { success: false, reason: 'nothing to commit' };
    }
    try {
      // Check if there are actual staged changes
      const staged = this._git('diff --cached --name-only');
      if (!staged) {
        this.pendingFiles.clear();
        return { success: false, reason: 'nothing to commit' };
      }

      const message = summary || `Changed: ${[...this.pendingFiles].join(', ')}`;
      this._git(`commit -m "${message.replace(/"/g, '\\"')}"`);
      const hash = this._git('rev-parse --short HEAD');
      const files = [...this.pendingFiles];
      this.pendingFiles.clear();

      channel.log('session', `Committed [${hash}]: ${message}`);
      return { success: true, hash, files };
    } catch (err) {
      channel.log('session', `Commit failed: ${err.message}`);
      return { success: false, reason: err.message };
    }
  }

  /** Check if there are pending (staged but uncommitted) file changes */
  hasPendingChanges() {
    return this.pendingFiles.size > 0;
  }

  // ─── Diff Methods ────────────────────────────────────────────────────

  /**
   * Find the baseline commit for a file.
   *
   * For existing files, the first commit touching the file is always a
   * "baseline: <file>" commit — return it directly so diff shows modifications.
   *
   * For new files (created during the session with no prior content), there is
   * no baseline commit — the first commit IS the changeset that added the file.
   * In that case return "<firstCommit>^" so the diff shows the file being added
   * from the parent state (where it didn't exist yet).
   */
  _findBaseline(relative) {
    try {
      const commits = this._git(`log --format=%H|%s --reverse -- "${relative}"`);
      const list = commits.split('\n').filter(Boolean);
      if (list.length === 0) return null;
      const [firstHash, ...subjectParts] = list[0].split('|');
      const firstSubject = subjectParts.join('|');
      // If the first commit is our synthetic baseline, use it directly
      if (firstSubject.startsWith('baseline:')) return firstHash;
      // New file — diff from parent so "new file" shows up
      return `${firstHash}^`;
    } catch {
      return null;
    }
  }

  /**
   * Get cumulative diff of all changes in this session.
   * Per-file: diffs from each file's baseline commit to HEAD.
   */
  getDiff() {
    this._ensureInit();
    try {
      const parts = [];
      for (const file of this.trackedFiles) {
        const baseline = this._findBaseline(file);
        if (!baseline) continue;
        const fileDiff = this._git(`diff ${baseline} HEAD -- "${file}"`);
        if (fileDiff) parts.push(fileDiff);
      }
      return parts.length > 0 ? parts.join('\n') : '(no changes)';
    } catch {
      return '(no changes)';
    }
  }

  /** Get list of changed files */
  getChangedFiles() {
    this._ensureInit();
    const changed = [];
    for (const file of this.trackedFiles) {
      try {
        const baseline = this._findBaseline(file);
        if (!baseline) continue;
        const diff = this._git(`diff --name-only ${baseline} HEAD -- "${file}"`);
        if (diff) changed.push(file);
      } catch { /* skip */ }
    }
    return changed;
  }

  /**
   * Get diff for a single file from the session.
   * @param {boolean} reverse - If true, show reverse diff (what a revert would look like)
   */
  getFileDiff(filePath, reverse = false) {
    this._ensureInit();
    try {
      const resolved = path.resolve(filePath);
      const relative = path.relative(this.projectRoot, resolved);
      const baseline = this._findBaseline(relative);
      if (!baseline) return '(no changes for this file)';
      const [from, to] = reverse ? ['HEAD', baseline] : [baseline, 'HEAD'];
      return this._git(`diff ${from} ${to} -- "${relative}"`);
    } catch {
      return '(no changes for this file)';
    }
  }

  // ─── History Methods ─────────────────────────────────────────────────

  /**
   * Get full commit history (excluding baselines and session start).
   * Returns array of { hash, shortHash, summary, date, files }
   * Most recent first.
   */
  getHistory() {
    this._ensureInit();
    try {
      // Format: hash|short|date|subject — most recent first (default git log order)
      const log = this._git('log --format=%H|%h|%aI|%s');
      if (!log) return [];

      return log.split('\n')
        .filter(Boolean)
        .map(line => {
          const [hash, shortHash, date, ...rest] = line.split('|');
          const summary = rest.join('|'); // summary might contain |
          return { hash, shortHash, summary, date };
        })
        // Exclude baseline commits and session start — only user-visible changesets
        .filter(c => !c.summary.startsWith('baseline:') && c.summary !== 'session start');
    } catch {
      return [];
    }
  }

  /**
   * Get diff between two commits (e.g. to show what a specific changeset did).
   */
  getCommitDiff(commitHash) {
    this._ensureInit();
    try {
      return this._git(`diff ${commitHash}~1 ${commitHash}`);
    } catch {
      return '(no changes)';
    }
  }

  /**
   * Checkout a specific commit — sync working tree files to that point in history.
   * Does NOT create a new commit. Only restores tracked files in the working tree.
   * New commits are only created when the user makes actual new changes.
   */
  checkoutCommit(commitHash) {
    this._ensureInit();
    try {
      const targetSummary = this._git(`log --format=%s -1 ${commitHash}`);

      // Only restore files that are tracked by this session
      for (const file of this.trackedFiles) {
        try {
          // Try to get this file's content from the target commit
          this._git(`show ${commitHash}:"${file}"`)
          // File exists in target commit — restore it
          this._git(`checkout ${commitHash} -- "${file}"`);
        } catch {
          // File doesn't exist in target commit — check if it's a baseline-only file
          // (was added AFTER this commit). Restore to its baseline state.
          try {
            const baseline = this._findBaseline(file);
            if (baseline) {
              this._git(`checkout ${baseline} -- "${file}"`);
            }
          } catch { /* leave file as-is if baseline also fails */ }
        }
      }

      // Reset HEAD to target commit without affecting working tree (soft reset)
      this._git(`reset --soft ${commitHash}`);

      return {
        success: true,
        restoredTo: commitHash,
        files: [...this.trackedFiles],
        summary: targetSummary
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /** Get current HEAD hash */
  getHead() {
    this._ensureInit();
    try {
      return this._git('rev-parse HEAD');
    } catch {
      return null;
    }
  }

  /** Get commit log (list of edits) */
  getLog() {
    this._ensureInit();
    try {
      return this._git('log --oneline --reverse');
    } catch {
      return '(no changes)';
    }
  }

  // ─── Input History Persistence ──────────────────────────────────────

  /** Save input history entries to disk.
   *  Only writes if the session dir already exists (user has already interacted). */
  saveInputHistory(entries) {
    try {
      const koiDir = path.join(this.projectRoot, '.koi');
      if (!fs.existsSync(koiDir)) return;
      fs.mkdirSync(this.gitDir, { recursive: true });
      const filePath = path.join(this.gitDir, 'input-history.json');
      fs.writeFileSync(filePath, JSON.stringify(entries), 'utf8');
    } catch { /* non-fatal */ }
  }

  /** Load input history entries from disk */
  loadInputHistory() {
    try {
      const filePath = path.join(this.gitDir, 'input-history.json');
      if (!fs.existsSync(filePath)) return [];
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return [];
    }
  }

  // ─── Dialogue Log ─────────────────────────────────────────────────

  /** Append a dialogue entry to the JSONL log */
  appendDialogue(entry) {
    // Write the dialogue entry first — independent of git init.
    // This ensures conversation data is persisted even if git init fails.
    try {
      const koiDir = path.join(this.projectRoot, '.koi');
      if (!fs.existsSync(koiDir)) return;
      fs.mkdirSync(this.gitDir, { recursive: true });
      const filePath = path.join(this.gitDir, 'dialogue.jsonl');
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* non-fatal */ }
    // Also try to initialize the git repo for diff/history tracking (best-effort).
    if (!this.initialized) {
      try { this._ensureInit(); } catch { /* non-fatal */ }
    }
  }

  /** Load last N dialogue entries */
  loadDialogue(limit = 20) {
    try {
      const filePath = path.join(this.gitDir, 'dialogue.jsonl');
      if (!fs.existsSync(filePath)) return [];
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  // ─── Commit Embeddings ────────────────────────────────────────────

  /** Save a commit embedding to the index */
  saveCommitEmbedding(hash, summary, embedding) {
    try {
      const filePath = path.join(this.gitDir, 'commit-embeddings.json');
      let data = { commits: {} };
      if (fs.existsSync(filePath)) {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
      data.commits[hash] = { summary, embedding, date: new Date().toISOString() };
      fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
    } catch { /* non-fatal */ }
  }

  /** Load all commit embeddings */
  loadCommitEmbeddings() {
    try {
      const filePath = path.join(this.gitDir, 'commit-embeddings.json');
      if (!fs.existsSync(filePath)) return { commits: {} };
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return { commits: {} };
    }
  }

  // ─── Image Storage ─────────────────────────────────────────────────

  /** Get the directory for session images */
  getImagesDir() {
    return path.join(this.gitDir, 'images');
  }

  /** Load the image index (array of entries) from disk */
  loadImageIndex() {
    try {
      const filePath = path.join(this.getImagesDir(), 'images.json');
      if (!fs.existsSync(filePath)) return [];
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return [];
    }
  }

  /** Save the image index to disk */
  saveImageIndex(index) {
    try {
      const dir = this.getImagesDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'images.json'), JSON.stringify(index, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  /**
   * Store a screenshot buffer and update the index.
   * @param {Buffer} buffer - PNG image data
   * @param {{ source?: string, description?: string, mimeType?: string }} meta
   * @returns {string} The generated image ID (e.g. "screenshot-001")
   */
  storeImage(buffer, { source, description, mimeType } = {}) {
    const index = this.loadImageIndex();
    const num = String(index.length + 1).padStart(3, '0');
    const id = `screenshot-${num}`;
    const fileName = `${id}.png`;

    const dir = this.getImagesDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), buffer);

    const entry = {
      id,
      path: fileName,
      timestamp: Date.now(),
      description: description || '',
      source: source || 'unknown',
      mimeType: mimeType || 'image/png',
    };
    index.push(entry);
    this.saveImageIndex(index);

    return id;
  }

  /**
   * Get a specific image by ID.
   * @returns {{ entry: object, buffer: Buffer } | null}
   */
  getImage(imageId) {
    try {
      const index = this.loadImageIndex();
      const entry = index.find(e => e.id === imageId);
      if (!entry) return null;
      const buffer = fs.readFileSync(path.join(this.getImagesDir(), entry.path));
      return { entry, buffer };
    } catch {
      return null;
    }
  }

  /**
   * Search images by substring match on description, source, or id.
   * @returns {object[]} Matching index entries
   */
  searchImages(query) {
    const index = this.loadImageIndex();
    if (!query) return index;
    const q = query.toLowerCase();
    return index.filter(e =>
      (e.id && e.id.toLowerCase().includes(q)) ||
      (e.description && e.description.toLowerCase().includes(q)) ||
      (e.source && e.source.toLowerCase().includes(q))
    );
  }

  // ─── Display Log ──────────────────────────────────────────────────

  /**
   * Append a print event to the display log.
   * Called every time the LLM prints text so we can replay it on resume.
   */
  saveDisplayEntry(type, text) {
    try {
      // Only create directory if the .koi parent already exists (onboarding creates it).
      // This prevents premature .koi creation before the user confirms the project.
      const koiDir = path.join(this.projectRoot, '.koi');
      if (!fs.existsSync(koiDir)) return;
      fs.mkdirSync(this.gitDir, { recursive: true });
      const filePath = path.join(this.gitDir, 'display-log.jsonl');
      fs.appendFileSync(filePath, JSON.stringify({ ts: Date.now(), type, text }) + '\n', 'utf8');
    } catch { /* non-fatal */ }
  }

  /** Clear the display log (called at the start of each run after loading). */
  clearDisplayLog() {
    try {
      const koiDir = path.join(this.projectRoot, '.koi');
      if (!fs.existsSync(koiDir)) return;
      const filePath = path.join(this.gitDir, 'display-log.jsonl');
      fs.mkdirSync(this.gitDir, { recursive: true });
      fs.writeFileSync(filePath, '', 'utf8');
    } catch { /* non-fatal */ }
  }

  /** Load all display log entries (for restore on resume). */
  loadDisplayLog() {
    try {
      const filePath = path.join(this.gitDir, 'display-log.jsonl');
      if (!fs.existsSync(filePath)) return [];
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
      return lines.map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  // ─── Conversation Persistence ──────────────────────────────────────

  /** Save conversation history for an agent.
   *  Only writes if the session dir already exists — i.e. the user has typed at
   *  least one message (appendDialogue creates the dir) or this is a resumed
   *  session (dir was created in a previous run).
   *  Conversation persistence is independent of git — no git init required. */
  saveConversation(agentName, messages) {
    try {
      const koiDir = path.join(this.projectRoot, '.koi');
      if (!fs.existsSync(koiDir)) return;
      fs.mkdirSync(this.gitDir, { recursive: true });
      const filePath = path.join(this.gitDir, `conversation-${agentName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(messages), 'utf8');
    } catch { /* non-fatal */ }
  }

  /** Save shared session knowledge to disk. */
  saveKnowledge(facts) {
    try {
      const koiDir = path.join(this.projectRoot, '.koi');
      if (!fs.existsSync(koiDir)) return;
      fs.mkdirSync(this.gitDir, { recursive: true });
      const filePath = path.join(this.gitDir, 'knowledge.json');
      fs.writeFileSync(filePath, JSON.stringify(facts), 'utf8');
    } catch { /* non-fatal */ }
  }

  /** Load shared session knowledge from disk. */
  loadKnowledge() {
    try {
      const filePath = path.join(this.gitDir, 'knowledge.json');
      if (!fs.existsSync(filePath)) return [];
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return [];
    }
  }

  /** Load conversation history for an agent */
  loadConversation(agentName) {
    try {
      const filePath = path.join(this.gitDir, `conversation-${agentName}.json`);
      if (!fs.existsSync(filePath)) return [];
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return [];
    }
  }

  /** Cosine similarity between two vectors */
  static cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  /** Undo last changeset (revert last commit, restore files to previous state) */
  undo() {
    this._ensureInit();
    try {
      const commitCount = parseInt(this._git('rev-list --count HEAD'), 10);
      if (commitCount <= 1) return { success: false, error: 'No changes to undo' };

      // Get list of files changed in the last commit
      const lastFiles = this._git('diff --name-only HEAD~1 HEAD');
      const files = lastFiles ? lastFiles.split('\n').filter(Boolean) : [];

      // Restore only those specific files to their previous state
      for (const file of files) {
        try {
          this._git(`checkout HEAD~1 -- "${file}"`);
        } catch { /* file might not exist in previous commit */ }
      }

      // Move HEAD back
      this._git('reset --soft HEAD~1');

      return {
        success: true,
        reverted: files,
        message: 'Last changeset reverted'
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

// Singleton — set during koi run
export let sessionTracker = null;

export function initSessionTracker(sessionId, projectRoot) {
  sessionTracker = new SessionTracker(sessionId, projectRoot);
  return sessionTracker;
}
