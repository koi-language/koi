const VALID_TYPES = /* @__PURE__ */ new Set([
  "idea",
  "decision",
  "learning",
  "insight",
  "blocker",
  "opportunity"
]);
const PATTERN_RULES = [
  {
    type: "decision",
    patterns: [
      /\bchose\s+\w+\s+over\b/,
      /\bdecided\s+to\b/,
      /\bswitched\s+from\b/,
      /\bwill\s+use\b/,
      /\bapproved\b/,
      /\bgo\s+with\b/,
      /\bgoing\s+with\b/,
      /\bdecision\b/,
      /\btrade-?off\b/,
      /\balternatives?\b/,
      /\brationale\b/,
      /\bpicked\b/,
      /\bopt(ed)?\s+for\b/,
      /\bswitch(ed|ing)?\s+to\b/
    ]
  },
  {
    type: "blocker",
    patterns: [
      /\bblocked?\b/,
      /\bblocker\b/,
      /\bstuck\b/,
      /\bcan'?t\s+proceed\b/,
      /\bcannot\s+proceed\b/,
      /\bwaiting\s+on\b/,
      /\bdepends\s+on\b/,
      /\bthe\s+problem\s+is\b/,
      /\bprevents?\b/,
      /\bno\s+way\s+to\b/
    ]
  },
  {
    type: "opportunity",
    patterns: [
      /\bopportunity\b/,
      /\bpotential\b/,
      /\bmight\s+enable\b/,
      /\bopens\s+up\b/,
      /\bworth\s+exploring\b/,
      /\bgap\b/,
      /\bnobody\s+has\b/,
      /\bmarket\s+for\b/
    ]
  },
  {
    type: "learning",
    patterns: [
      /\blearned\b/,
      /\bdiscovered\s+that\b/,
      /\bfound\s+that\b/,
      /\bturns\s+out\b/,
      /\brealized\b/,
      /\bTIL\b/i,
      /\bkey\s+takeaway\b/,
      /\bproves\b/,
      /\bit\s+works?\s+because\b/,
      /\bthe\s+key\s+(is|was)\b/,
      /\bafter\s+testing\b/,
      /\bmistake\s+(was|is)\b/
    ]
  },
  {
    type: "idea",
    patterns: [
      /\bwhat\s+if\b/,
      /\bcould\s+we\b/,
      /\bproposal\b/,
      /\bhypothesis\b/,
      /\bexperiment\b/,
      /\bidea\b/,
      /\bmaybe\s+(we\s+)?should\b/,
      /\bwonder\s+if\b/,
      /\bworth\s+(trying|testing|considering)\b/
    ]
  }
];
function classifyNoteType(title, body, frontmatterType) {
  if (frontmatterType && VALID_TYPES.has(frontmatterType)) {
    return {
      type: frontmatterType,
      confidence: "high",
      reason: "explicit type in frontmatter"
    };
  }
  const text = `${title}
${body}`.toLowerCase();
  for (const rule of PATTERN_RULES) {
    const matchCount = rule.patterns.filter((p) => p.test(text)).length;
    if (matchCount >= 2) {
      return {
        type: rule.type,
        confidence: "high",
        reason: `${matchCount} pattern matches for ${rule.type}`
      };
    }
    if (matchCount === 1) {
      return {
        type: rule.type,
        confidence: "medium",
        reason: `1 pattern match for ${rule.type}`
      };
    }
  }
  return {
    type: "insight",
    confidence: "low",
    reason: "no strong pattern match, defaulting to insight"
  };
}
function detectProjects(title, body, config) {
  if (!config.keywords || Object.keys(config.keywords).length === 0) {
    return [];
  }
  const text = `${title}
${body}`.toLowerCase();
  const matched = [];
  for (const [project, keywords] of Object.entries(config.keywords)) {
    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) {
        matched.push(project);
        break;
      }
    }
  }
  return matched.sort();
}
export {
  classifyNoteType,
  detectProjects
};
