const INTENT_PATTERNS = [
  {
    intent: "episodic",
    patterns: [
      /\bwhen\s+did\b/i,
      /\blast\s+time\b/i,
      /\bwhat\s+happened\b/i,
      /\brecently\b/i,
      /\bhistory\s+of\b/i,
      /\btimeline\b/i,
      /\bwhen\s+was\b/i,
      /\bremember\s+when\b/i
    ]
  },
  {
    intent: "procedural",
    patterns: [
      /\bhow\s+to\b/i,
      /\bsteps?\s+(for|to)\b/i,
      /\bprocess\b/i,
      /\bprocedure\b/i,
      /\binstructions?\b/i,
      /\bworkflow\b/i,
      /\bhow\s+do\b/i,
      /\bhow\s+can\b/i,
      /\bhow\s+should\b/i,
      /\bguide\b/i
    ]
  },
  {
    intent: "decision",
    patterns: [
      /\bwhy\s+did\s+we\b/i,
      /\bwhat\s+did\s+we\s+decide\b/i,
      /\bdecision\b/i,
      /\bdecide[ds]?\b/i,
      /\bchose\b/i,
      /\bchoose\b/i,
      /\balternatives?\b/i,
      /\btrade-?off\b/i,
      /\brationale\b/i,
      /\bshould\s+we\b/i,
      /\bpros?\s+and\s+cons?\b/i
    ]
  }
  // semantic is the default — no specific patterns needed
];
const SPACE_WEIGHTS = {
  episodic: { text: 0.4, temporal: 0.25, vitality: 0.15, importance: 0.05, type: 0.05, community: 0.1 },
  procedural: { text: 0.3, temporal: 0.05, vitality: 0.1, importance: 0.3, type: 0.1, community: 0.15 },
  semantic: { text: 0.65, temporal: 0.05, vitality: 0.1, importance: 0.1, type: 0.05, community: 0.05 },
  decision: { text: 0.3, temporal: 0.15, vitality: 0.1, importance: 0.1, type: 0.3, community: 0.05 }
};
const SPLIT_WEIGHTS = {
  semantic: { title: 0.5, description: 0.3, body: 0.2 },
  episodic: { title: 0.2, description: 0.2, body: 0.6 },
  decision: { title: 0.4, description: 0.4, body: 0.2 },
  procedural: { title: 0.3, description: 0.3, body: 0.4 }
};
function extractEntities(query, noteIndex) {
  const queryLower = query.toLowerCase();
  const entities = [];
  for (const title of noteIndex) {
    const titleLower = title.toLowerCase();
    if (queryLower.includes(titleLower) && titleLower.length >= 3) {
      entities.push(title);
    }
  }
  return entities.sort((a, b) => b.length - a.length);
}
function classifyIntent(query, noteIndex = []) {
  let bestIntent = "semantic";
  let bestScore = 0;
  for (const { intent, patterns } of INTENT_PATTERNS) {
    const matchCount = patterns.filter((p) => p.test(query)).length;
    if (matchCount > bestScore) {
      bestScore = matchCount;
      bestIntent = intent;
    }
  }
  const confidence = bestScore >= 2 ? 1 : bestScore === 1 ? 0.7 : 0.5;
  const entities = extractEntities(query, noteIndex);
  return {
    intent: bestIntent,
    confidence,
    query,
    entities,
    spaceWeights: SPACE_WEIGHTS[bestIntent],
    splitWeights: SPLIT_WEIGHTS[bestIntent]
  };
}
function getSpaceWeights(intent) {
  return SPACE_WEIGHTS[intent];
}
function getSplitWeights(intent) {
  return SPLIT_WEIGHTS[intent];
}
export {
  classifyIntent,
  getSpaceWeights,
  getSplitWeights
};
