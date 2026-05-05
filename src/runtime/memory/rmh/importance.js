import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank.js";
import betweennessCentrality from "graphology-metrics/centrality/betweenness.js";
import louvain from "graphology-communities-louvain";
function buildGraphologyGraph(linkGraph) {
  const graph = new Graph({ type: "directed", multi: false });
  const allNodes = /* @__PURE__ */ new Set();
  for (const key of linkGraph.outgoing.keys()) allNodes.add(key);
  for (const key of linkGraph.incoming.keys()) allNodes.add(key);
  for (const targets of linkGraph.outgoing.values()) {
    for (const t of targets) allNodes.add(t);
  }
  for (const node of allNodes) {
    if (!graph.hasNode(node)) graph.addNode(node);
  }
  for (const [source, targets] of linkGraph.outgoing) {
    for (const target of targets) {
      if (!graph.hasEdge(source, target)) {
        graph.addEdge(source, target);
      }
    }
  }
  return graph;
}
function computePageRank(graph, alpha = 0.85) {
  const scores = pagerank(graph, { alpha, getEdgeWeight: null });
  const result = /* @__PURE__ */ new Map();
  graph.forEachNode((node) => {
    result.set(node, scores[node] ?? 0);
  });
  return result;
}
function detectCommunities(graph) {
  const undirected = new Graph({ type: "undirected", multi: false });
  graph.forEachNode((node) => {
    if (!undirected.hasNode(node)) undirected.addNode(node);
  });
  graph.forEachEdge((_edge, _attrs, source, target) => {
    if (!undirected.hasNode(source)) undirected.addNode(source);
    if (!undirected.hasNode(target)) undirected.addNode(target);
    if (source !== target && !undirected.hasEdge(source, target)) {
      undirected.addEdge(source, target);
    }
  });
  const communities = louvain(undirected);
  const result = /* @__PURE__ */ new Map();
  for (const [node, community] of Object.entries(communities)) {
    result.set(node, community);
  }
  return result;
}
function findBridgeNotes(graph, noteIndex) {
  const bridges = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const disc = /* @__PURE__ */ new Map();
  const low = /* @__PURE__ */ new Map();
  const parent = /* @__PURE__ */ new Map();
  let timer = 0;
  function dfs(u) {
    visited.add(u);
    disc.set(u, timer);
    low.set(u, timer);
    timer++;
    let children = 0;
    const neighbors = /* @__PURE__ */ new Set();
    graph.forEachOutNeighbor(u, (n) => neighbors.add(n));
    graph.forEachInNeighbor(u, (n) => neighbors.add(n));
    for (const v of neighbors) {
      if (!visited.has(v)) {
        children++;
        parent.set(v, u);
        dfs(v);
        low.set(u, Math.min(low.get(u), low.get(v)));
        if (parent.get(u) === null && children > 1) {
          bridges.add(u);
        }
        if (parent.get(u) !== null && low.get(v) >= disc.get(u)) {
          bridges.add(u);
        }
      } else if (v !== parent.get(u)) {
        low.set(u, Math.min(low.get(u), disc.get(v)));
      }
    }
  }
  graph.forEachNode((node) => {
    if (!visited.has(node)) {
      parent.set(node, null);
      dfs(node);
    }
  });
  const inDegrees = [];
  graph.forEachNode((node) => {
    inDegrees.push(graph.inDegree(node));
  });
  inDegrees.sort((a, b) => a - b);
  const median = inDegrees.length > 0 ? inDegrees[Math.floor(inDegrees.length / 2)] : 0;
  const hubThreshold = median * 2;
  graph.forEachNode((node) => {
    if (graph.inDegree(node) > hubThreshold && hubThreshold > 0) {
      bridges.add(node);
    }
  });
  graph.forEachNode((node) => {
    if (node.endsWith(" map") || node === "index") {
      bridges.add(node);
    }
  });
  if (noteIndex) {
    for (const [title, fm] of noteIndex.frontmatter) {
      const project = Array.isArray(fm.project) ? fm.project : [];
      if (project.length >= 2 && graph.hasNode(title) && graph.inDegree(title) >= 3) {
        bridges.add(title);
      }
    }
  }
  return bridges;
}
function computeBetweenness(graph) {
  const scores = betweennessCentrality(graph);
  const result = /* @__PURE__ */ new Map();
  graph.forEachNode((node) => {
    result.set(node, scores[node] ?? 0);
  });
  return result;
}
function computeGraphMetrics(linkGraph, noteIndex) {
  const graph = buildGraphologyGraph(linkGraph);
  const pr = computePageRank(graph);
  const communities = detectCommunities(graph);
  const bridges = findBridgeNotes(graph, noteIndex);
  const betweenness = computeBetweenness(graph);
  const communityStats = /* @__PURE__ */ new Map();
  for (const [node, communityId] of communities) {
    if (!communityStats.has(communityId)) {
      communityStats.set(communityId, { size: 0, members: [] });
    }
    const stat = communityStats.get(communityId);
    stat.size++;
    stat.members.push(node);
  }
  return { pagerank: pr, communities, bridges, betweenness, communityStats };
}
function personalizedPageRank(graph, seeds, alpha = 0.85, iterations = 20) {
  const N = graph.order;
  if (N === 0) return /* @__PURE__ */ new Map();
  const personalization = /* @__PURE__ */ new Map();
  const validSeeds = seeds.filter((s) => graph.hasNode(s));
  if (validSeeds.length === 0) {
    graph.forEachNode((node) => personalization.set(node, 1 / N));
  } else {
    graph.forEachNode((node) => personalization.set(node, 0));
    for (const seed of validSeeds) {
      personalization.set(seed, 1 / validSeeds.length);
    }
  }
  let scores = new Map(personalization);
  for (let iter = 0; iter < iterations; iter++) {
    const newScores = /* @__PURE__ */ new Map();
    graph.forEachNode((node) => newScores.set(node, 0));
    graph.forEachNode((node) => {
      const outDeg = graph.outDegree(node);
      if (outDeg === 0) return;
      const share = (scores.get(node) ?? 0) / outDeg;
      graph.forEachOutNeighbor(node, (neighbor) => {
        newScores.set(neighbor, (newScores.get(neighbor) ?? 0) + share);
      });
    });
    graph.forEachNode((node) => {
      const dampedScore = alpha * (newScores.get(node) ?? 0);
      const restart = (1 - alpha) * (personalization.get(node) ?? 0);
      newScores.set(node, dampedScore + restart);
    });
    scores = newScores;
  }
  return scores;
}
export {
  buildGraphologyGraph,
  computeBetweenness,
  computeGraphMetrics,
  computePageRank,
  detectCommunities,
  findBridgeNotes,
  personalizedPageRank
};
