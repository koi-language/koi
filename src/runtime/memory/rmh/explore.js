import { promises as fs } from "node:fs";
import path from "node:path";
import { classifyIntent } from "./intent.js";
import { buildGraphologyGraph, personalizedPageRank } from "./importance.js";
import { parseFrontmatter } from "./frontmatter.js";
// koi-fork: NullProvider sentinel + isNullLlm duck-type via bridge (Koi has its own llm-provider)
import { isNullLlm } from "./_koi-bridge.js";
function computeExploreSeedWeight(retrievalScore, warmthScore, qValue, config) {
  const base = retrievalScore;
  const warmthBoost = warmthScore !== null ? config.warmth_seed_blend * warmthScore : 0;
  const qBoost = config.q_seed_blend * (qValue - 0.5);
  return Math.max(0.01, base + warmthBoost + qBoost);
}
function explorePPR(seeds, linkGraph, config) {
  const graph = buildGraphologyGraph(linkGraph);
  const validSeeds = [];
  for (const [title] of seeds) {
    if (graph.hasNode(title)) validSeeds.push(title);
  }
  if (validSeeds.length === 0) return /* @__PURE__ */ new Map();
  const rawPPR = personalizedPageRank(
    graph,
    validSeeds,
    config.ppr_alpha,
    config.ppr_iterations
  );
  return rawPPR;
}
function applyScoreDecayFilter(scores, threshold) {
  let maxScore = 0;
  for (const s of scores.values()) {
    if (s > maxScore) maxScore = s;
  }
  if (maxScore <= 0) return /* @__PURE__ */ new Map();
  const cutoff = maxScore * threshold;
  const filtered = /* @__PURE__ */ new Map();
  for (const [title, score] of scores) {
    if (score >= cutoff) filtered.set(title, score);
  }
  return filtered;
}
async function extractSnippet(notesDir, title, linkGraph, config) {
  const filePath = path.join(notesDir, `${title}.md`);
  let content;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(content);
  const description = typeof data?.description === "string" ? data.description.substring(0, 200) : "";
  const type = typeof data?.type === "string" ? data.type : null;
  const cleanBody = body.trim();
  const preview = cleanBody.substring(0, config.snippet_preview_length).trim();
  const outgoing = linkGraph.outgoing.get(title);
  const links = outgoing ? [...outgoing].slice(0, config.snippet_max_links) : [];
  return { description, preview, type, links };
}
function discoverPaths(seeds, pprDiscovered, linkGraph, maxPaths = 5) {
  const paths = [];
  const seedSet = new Set(seeds);
  for (const target of pprDiscovered) {
    if (seedSet.has(target)) continue;
    if (paths.length >= maxPaths) break;
    for (const seed of seeds) {
      const found = bfsPath(seed, target, linkGraph, 4);
      if (found && found.length > 2) {
        paths.push({
          from: seed,
          to: target,
          via: found.slice(1, -1)
        });
        break;
      }
    }
  }
  return paths;
}
function bfsPath(from, to, linkGraph, maxDepth) {
  if (from === to) return [from];
  const visited = /* @__PURE__ */ new Set([from]);
  const queue = [{ node: from, path: [from] }];
  while (queue.length > 0) {
    const { node, path: currentPath } = queue.shift();
    if (currentPath.length > maxDepth) continue;
    const neighbors = linkGraph.outgoing.get(node);
    if (!neighbors) continue;
    for (const neighbor of neighbors) {
      if (neighbor === to) return [...currentPath, neighbor];
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ node: neighbor, path: [...currentPath, neighbor] });
      }
    }
  }
  return null;
}
function mergeExploreResults(seedResults, pprScores, warmthSignals, limit) {
  const merged = /* @__PURE__ */ new Map();
  let maxPPR = 0;
  for (const s of pprScores.values()) {
    if (s > maxPPR) maxPPR = s;
  }
  const normPPR = maxPPR > 0 ? (s) => s / maxPPR : (_s) => 0;
  for (const seed of seedResults) {
    const ppr = pprScores.get(seed.title) ?? 0;
    const warmth = warmthSignals.get(seed.title) ?? null;
    const pprNorm = normPPR(ppr);
    const score = 0.4 * seed.score + 0.4 * pprNorm + (warmth !== null ? 0.2 * warmth : 0);
    merged.set(seed.title, {
      title: seed.title,
      score,
      pprScore: pprNorm,
      seedScore: seed.score,
      warmthScore: warmth,
      source: warmth !== null ? "multi" : "seed"
    });
  }
  for (const [title, rawScore] of pprScores) {
    if (merged.has(title)) continue;
    const warmth = warmthSignals.get(title) ?? null;
    const pprNorm = normPPR(rawScore);
    const score = 0.4 * pprNorm + (warmth !== null ? 0.2 * warmth : 0);
    merged.set(title, {
      title,
      score,
      pprScore: pprNorm,
      seedScore: null,
      warmthScore: warmth,
      source: warmth !== null ? "multi" : "ppr"
    });
  }
  for (const [title, wScore] of warmthSignals) {
    if (merged.has(title)) continue;
    merged.set(title, {
      title,
      score: 0.2 * wScore,
      pprScore: 0,
      seedScore: null,
      warmthScore: wScore,
      source: "warmth"
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
function computeDepthSignal(pprScores, graphMetrics, flatResultTitles) {
  let maxPPRScore = 0;
  for (const s of pprScores.values()) {
    if (s > maxPPRScore) maxPPRScore = s;
  }
  const top5 = [...pprScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
  const communities = new Set(top5.map((t) => graphMetrics.communities.get(t) ?? -1));
  const communitySpread = communities.size;
  const flatSet = new Set(flatResultTitles);
  const pprNotInFlat = [...pprScores.keys()].filter((t) => !flatSet.has(t));
  const newNoteRatio = pprScores.size > 0 ? pprNotInFlat.length / pprScores.size : 0;
  let depth = 2;
  if (maxPPRScore > 0.3 && communitySpread <= 1) depth = 1;
  else if (communitySpread >= 3 || maxPPRScore < 0.15) depth = 3;
  return { maxPPRScore, communitySpread, newNoteRatio, depth };
}
async function explore(params) {
  const {
    linkGraph,
    notesDir,
    warmthSignals,
    flatResults,
    config,
    qValueLookup,
    graphMetrics
  } = params;
  const limit = Math.min(config.default_limit, config.max_limit);
  const seeds = /* @__PURE__ */ new Map();
  for (const seed of flatResults.slice(0, config.seed_count)) {
    const warmth = warmthSignals.get(seed.title) ?? null;
    const q = qValueLookup(seed.title);
    const weight = computeExploreSeedWeight(seed.score, warmth, q, config);
    seeds.set(seed.title, weight);
  }
  let warmthOnlyCount = 0;
  for (const [title, wScore] of warmthSignals) {
    if (seeds.has(title)) continue;
    if (warmthOnlyCount >= config.max_warmth_only_seeds) break;
    seeds.set(title, config.warmth_seed_blend * wScore * 0.5);
    warmthOnlyCount++;
  }
  const initialPPR = explorePPR(seeds, linkGraph, config);
  const flatTitles = flatResults.map((r) => r.title);
  let depthSignal = { maxPPRScore: 0, communitySpread: 1, newNoteRatio: 0, depth: 2 };
  if (graphMetrics) {
    depthSignal = computeDepthSignal(initialPPR, graphMetrics, flatTitles);
  }
  let finalPPR = initialPPR;
  if (depthSignal.depth > 2) {
    const deepConfig = { ...config };
    deepConfig.ppr_iterations = Math.round(config.ppr_iterations * 1.67);
    finalPPR = explorePPR(seeds, linkGraph, deepConfig);
  } else if (depthSignal.depth < 2) {
    const shallowConfig = { ...config };
    shallowConfig.ppr_iterations = Math.round(config.ppr_iterations * 0.5);
    finalPPR = explorePPR(seeds, linkGraph, shallowConfig);
  }
  const filteredPPR = applyScoreDecayFilter(finalPPR, config.score_decay_threshold);
  const flatSet = new Set(flatTitles);
  let maxPPR = 0;
  for (const s of filteredPPR.values()) {
    if (s > maxPPR) maxPPR = s;
  }
  const normPPR = maxPPR > 0 ? (s) => s / maxPPR : () => 0;
  const allCandidates = flatResults.map((r) => {
    const pprNorm = normPPR(filteredPPR.get(r.title) ?? 0);
    const score = r.score + 0.2 * r.score * pprNorm;
    return {
      title: r.title,
      score,
      pprScore: pprNorm,
      seedScore: r.score,
      warmthScore: warmthSignals.get(r.title) ?? null,
      source: pprNorm > 0 ? "multi" : "seed"
    };
  });
  const flatScores = flatResults.map((r) => r.score).sort((a, b) => b - a);
  const medianFlatScore = flatScores.length > 0 ? flatScores[Math.floor(flatScores.length / 2)] : 0;
  for (const [title, rawScore] of filteredPPR) {
    if (flatSet.has(title)) continue;
    const pprNorm = normPPR(rawScore);
    const score = medianFlatScore * pprNorm;
    allCandidates.push({
      title,
      score,
      pprScore: pprNorm,
      seedScore: null,
      warmthScore: warmthSignals.get(title) ?? null,
      source: "ppr"
    });
  }
  allCandidates.sort((a, b) => b.score - a.score);
  const finalResults = allCandidates.slice(0, limit);
  for (const note of finalResults) {
    note.snippet = await extractSnippet(notesDir, note.title, linkGraph, config) ?? void 0;
  }
  const seedTitles = flatResults.slice(0, 5).map((s) => s.title);
  const discoveredTitles = finalResults.filter((n) => n.source === "ppr" || n.source === "multi").map((n) => n.title);
  const paths = discoverPaths(seedTitles, discoveredTitles, linkGraph, 5);
  return {
    results: finalResults,
    paths,
    totalCandidatesScored: filteredPPR.size
  };
}
const SUB_QUESTION_PROMPT = `You are analyzing retrieved notes from a knowledge graph to identify unanswered aspects of a question.

Given the original question and the notes found so far, generate 1-3 specific sub-questions that would help answer the original question but are NOT answered by the current notes.

Rules:
- Each sub-question should target a specific gap in the current knowledge
- If the current notes fully answer the question, return an empty array
- Sub-questions should be concrete and searchable, not vague
- Do not repeat previously asked sub-questions
- Maximum 3 sub-questions

Respond with JSON only: {"sub_questions": ["question1", "question2"]}
If fully answered: {"sub_questions": []}`;
function buildSnippetContext(results, maxNotes = 10) {
  return results.slice(0, maxNotes).map((n) => {
    const desc = n.snippet?.description ?? "";
    const preview = n.snippet?.preview ?? "";
    const links = n.snippet?.links?.slice(0, 3).join(", ") ?? "";
    return `- ${n.title}: ${desc} ${preview}${links ? ` [links: ${links}]` : ""}`;
  }).join("\n");
}
async function generateSubQuestions(llm, originalQuery, snippetContext, previousSubQueries, maxSubQuestions = 3) {
  const prevStr = previousSubQueries.length > 0 ? `
Previously asked (do not repeat): ${previousSubQueries.join("; ")}` : "";
  const messages = [
    { role: "system", content: SUB_QUESTION_PROMPT },
    {
      role: "user",
      content: `Original question: ${originalQuery}

Notes found so far:
${snippetContext}${prevStr}`
    }
  ];
  const response = await llm.chat(messages, { maxTokens: 256, temperature: 0 });
  if (!response) return [];
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.sub_questions)) return [];
    return parsed.sub_questions.filter((q) => typeof q === "string" && q.length > 5).slice(0, maxSubQuestions);
  } catch {
    return [];
  }
}
async function exploreRecursive(params) {
  const {
    config,
    linkGraph,
    notesDir,
    warmthSignals,
    seedResults,
    qValueLookup,
    llmProvider,
    allTitles,
    reseed
  } = params;
  const visited = /* @__PURE__ */ new Set();
  const allResults = [];
  const subQueries = [];
  const perPassResults = [];
  const pass0 = await explore({
    query: params.query,
    classified: params.classified,
    linkGraph,
    notesDir,
    warmthSignals,
    flatResults: seedResults,
    config,
    qValueLookup
  });
  for (const note of pass0.results) {
    visited.add(note.title);
    allResults.push(note);
  }
  perPassResults.push({
    query: params.query,
    depth: 0,
    notesFound: pass0.results.length,
    newNotesAdded: pass0.results.length
  });
  if (isNullLlm(llmProvider)) { // koi-fork: was `instanceof NullProvider`
    return {
      ...pass0,
      recursionDepth: 0,
      subQueries: [],
      converged: false,
      perPassResults
    };
  }
  let depth = 0;
  let converged = false;
  while (depth < config.max_recursion_depth) {
    depth++;
    const depthConfig = { ...config };
    depthConfig.ppr_iterations = Math.round(
      config.ppr_iterations * Math.pow(config.ppr_iteration_decay, depth)
    );
    const snippetContext = buildSnippetContext(allResults, 10);
    const newSubQuestions = await generateSubQuestions(
      llmProvider,
      params.query,
      snippetContext,
      subQueries,
      config.sub_question_max
    );
    if (newSubQuestions.length === 0) {
      converged = true;
      break;
    }
    let newNotesThisPass = 0;
    for (const subQ of newSubQuestions) {
      const subSeeds = await reseed(subQ);
      const subClassified = classifyIntent(subQ, allTitles);
      const subResult = await explore({
        query: subQ,
        classified: subClassified,
        linkGraph,
        notesDir,
        warmthSignals,
        flatResults: subSeeds,
        config: depthConfig,
        qValueLookup
      });
      for (const note of subResult.results) {
        if (!visited.has(note.title)) {
          visited.add(note.title);
          allResults.push(note);
          newNotesThisPass++;
        }
      }
      subQueries.push(subQ);
      if (visited.size >= config.max_total_notes) break;
    }
    perPassResults.push({
      query: newSubQuestions.join(" | "),
      depth,
      notesFound: newSubQuestions.length * config.default_limit,
      newNotesAdded: newNotesThisPass
    });
    if (visited.size > 0 && newNotesThisPass / visited.size < config.convergence_threshold) {
      converged = true;
      break;
    }
    if (visited.size >= config.max_total_notes) break;
  }
  const finalResults = allResults.sort((a, b) => b.score - a.score).slice(0, config.default_limit);
  const seedTitles = seedResults.slice(0, 5).map((s) => s.title);
  const discoveredTitles = finalResults.filter((n) => n.source === "ppr" || n.source === "multi").map((n) => n.title);
  const paths = discoverPaths(seedTitles, discoveredTitles, linkGraph, 5);
  return {
    results: finalResults,
    paths,
    totalCandidatesScored: visited.size,
    recursionDepth: depth,
    subQueries,
    converged,
    perPassResults
  };
}
export {
  applyScoreDecayFilter,
  computeDepthSignal,
  computeExploreSeedWeight,
  discoverPaths,
  explore,
  explorePPR,
  exploreRecursive,
  extractSnippet,
  generateSubQuestions,
  mergeExploreResults
};
