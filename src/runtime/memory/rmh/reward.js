import { getExposureCount } from "./qvalue.js";
const EXPOSURE_BETA = 0.5;
class SessionRewardAccumulator {
  retrievals = [];
  addedContent = [];
  updatedNoteIds = [];
  createdNoteIds = [];
  sessionId;
  constructor(sessionId) {
    this.sessionId = sessionId;
  }
  logRetrieval(noteId, rank, queryText, queryType) {
    this.retrievals.push({ noteId, rank, queryText, queryType });
  }
  logAdd(noteId, content) {
    this.createdNoteIds.push(noteId);
    this.addedContent.push(content);
  }
  logUpdate(noteId) {
    this.updatedNoteIds.push(noteId);
  }
  computeRewards(db) {
    const outcome = this.buildOutcome();
    const credits = /* @__PURE__ */ new Map();
    const seen = /* @__PURE__ */ new Map();
    for (const r of this.retrievals) {
      const ranks = seen.get(r.noteId) ?? [];
      ranks.push(r.rank);
      seen.set(r.noteId, ranks);
    }
    for (const [noteId, ranks] of seen) {
      const bestRank = Math.min(...ranks);
      let reward;
      if (outcome.forwardCitations.includes(noteId)) {
        reward = 1;
      } else if (outcome.updatedNotes.includes(noteId)) {
        reward = 0.5;
      } else if (outcome.createdNotes.length > 0) {
        reward = 0.6 * (1 / Math.log2(bestRank + 2));
      } else if (ranks.length > 1) {
        reward = 0.4 * (1 / ranks.length);
      } else if (outcome.forwardCitations.length > 0 || outcome.updatedNotes.length > 0) {
        reward = 0.1 / Math.log2(bestRank + 2);
      } else {
        reward = bestRank <= 2 ? -0.15 / Math.pow(bestRank + 1, 1) : 0;
      }
      const exposure = getExposureCount(db, noteId);
      if (exposure > 1) {
        reward = reward / Math.pow(exposure, EXPOSURE_BETA);
      }
      credits.set(noteId, Math.max(-1, Math.min(1, reward)));
    }
    return credits;
  }
  buildOutcome() {
    const retrievedIds = new Set(this.retrievals.map((r) => r.noteId));
    const forwardCitations = [];
    for (const content of this.addedContent) {
      const links = content.match(/\[\[([^\]]+)\]\]/g) ?? [];
      for (const link of links) {
        const title = link.slice(2, -2);
        if (retrievedIds.has(title)) {
          forwardCitations.push(title);
        }
      }
    }
    return {
      forwardCitations: [...new Set(forwardCitations)],
      updatedNotes: [...new Set(this.updatedNoteIds)],
      createdNotes: [...new Set(this.createdNoteIds)],
      reRecalledNotes: []
    };
  }
  hasData() {
    return this.retrievals.length > 0;
  }
}
export {
  SessionRewardAccumulator
};
