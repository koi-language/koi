import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "yaml";
// koi-fork: inline DEFAULT_LLM_CONFIG (Koi uses its own llm-provider, the
// llm.* fields here only exist to keep the config schema parsing happy
// and are otherwise ignored by Koi's runtime).
const DEFAULT_LLM_CONFIG = {
  provider: null,
  model: null,
  api_key_env: null,
  api_key_cmd: null,
  base_url: null
};
const DEFAULT_PROMOTE_CONFIG = {
  auto: true,
  require_llm: false,
  min_confidence: 0.6,
  project_keywords: {},
  project_map_routing: {},
  default_area: "index"
};
const DEFAULT_GRAPH_CONFIG = {
  pagerank_alpha: 0.85,
  bridge_vitality_floor: 0.5,
  hub_degree_multiplier: 2
};
const DEFAULT_ENGINE_CONFIG = {
  embedding_model: "Xenova/all-MiniLM-L6-v2",
  embedding_dims: 384,
  piecewise_bins: 8,
  community_dims: 16,
  db_path: ".ori/embeddings.db"
};
const DEFAULT_RETRIEVAL_CONFIG = {
  default_limit: 10,
  candidate_multiplier: 5,
  rrf_k: 60,
  signal_weights: {
    composite: 0.36,
    keyword: 0.18,
    graph: 0.26,
    warmth: 0.2
  },
  exploration_budget: 0.1
};
const DEFAULT_BM25_CONFIG = {
  k1: 1.2,
  b: 0.75,
  title_boost: 3,
  description_boost: 2
};
const DEFAULT_IPS_CONFIG = {
  enabled: true,
  epsilon: 0.01,
  log_path: "ops/access.jsonl"
};
const DEFAULT_ACTIVATION_CONFIG = {
  enabled: true,
  damping: 0.6,
  max_hops: 2,
  min_boost: 0.01
};
const DEFAULT_WARMTH_CONFIG = {
  enabled: true,
  surprise_threshold: 0.15,
  activation_threshold: 0.35,
  ppr_alpha: 0.15,
  ppr_iterations: 20,
  graph_weight: 0.3,
  max_results: 20,
  shadow_compare_enabled: true
};
const DEFAULT_EXPLORE_CONFIG = {
  enabled: true,
  default_limit: 15,
  max_limit: 30,
  ppr_alpha: 0.45,
  // HippoRAG (NeurIPS 2024, arxiv 2405.14831)
  ppr_iterations: 30,
  seed_count: 10,
  score_decay_threshold: 0.15,
  // drop notes scoring < 15% of max PPR score
  max_depth: 2,
  warmth_seed_blend: 0.3,
  q_seed_blend: 0.15,
  max_warmth_only_seeds: 5,
  snippet_preview_length: 150,
  snippet_max_links: 8,
  cooc_blend_beta: 0.3,
  recursive_enabled: true,
  max_recursion_depth: 2,
  max_total_notes: 30,
  convergence_threshold: 0.15,
  sub_question_max: 3,
  ppr_iteration_decay: 0.67
};
const DEFAULT_CONFIG = {
  vault: { version: "0.1" },
  templates: {
    default: "templates/note.md",
    by_type: {}
  },
  vitality: {
    decay: {},
    base: 1
  },
  llm: { ...DEFAULT_LLM_CONFIG },
  promote: { ...DEFAULT_PROMOTE_CONFIG },
  graph: { ...DEFAULT_GRAPH_CONFIG },
  engine: { ...DEFAULT_ENGINE_CONFIG },
  retrieval: { ...DEFAULT_RETRIEVAL_CONFIG },
  bm25: { ...DEFAULT_BM25_CONFIG },
  ips: { ...DEFAULT_IPS_CONFIG },
  activation: { ...DEFAULT_ACTIVATION_CONFIG },
  warmth: { ...DEFAULT_WARMTH_CONFIG },
  explore: { ...DEFAULT_EXPLORE_CONFIG }
};
function applyConfigDefaults(raw) {
  const rawPromote = raw.promote;
  const rawLlm = raw.llm;
  const rawGraph = raw.graph;
  const rawEngine = raw.engine;
  const rawRetrieval = raw.retrieval;
  const rawBM25 = raw.bm25;
  const rawIPS = raw.ips;
  const rawActivation = raw.activation;
  const rawWarmth = raw.warmth;
  const rawExplore = raw.explore;
  return {
    vault: {
      version: raw.vault?.version ?? DEFAULT_CONFIG.vault.version
    },
    templates: {
      default: raw.templates?.default ?? DEFAULT_CONFIG.templates.default,
      by_type: raw.templates?.by_type ?? {}
    },
    vitality: {
      decay: raw.vitality?.decay ?? {},
      base: raw.vitality?.base ?? DEFAULT_CONFIG.vitality.base,
      model: raw.vitality?.model ?? "actr",
      actr_decay: raw.vitality?.actr_decay ?? 0.5,
      metabolic_rates: raw.vitality?.metabolic_rates ?? {
        self: 0.1,
        notes: 1,
        ops: 3
      },
      structural_boost_per_link: raw.vitality?.structural_boost_per_link ?? 0.1,
      structural_boost_cap: raw.vitality?.structural_boost_cap ?? 10,
      revival_decay_rate: raw.vitality?.revival_decay_rate ?? 0.2,
      revival_window_days: raw.vitality?.revival_window_days ?? 14,
      access_saturation_k: raw.vitality?.access_saturation_k ?? 10,
      zone_thresholds: {
        active_floor: raw.vitality?.zone_thresholds ? raw.vitality.zone_thresholds?.active_floor ?? 0.6 : 0.6,
        stale_floor: raw.vitality?.zone_thresholds ? raw.vitality.zone_thresholds?.stale_floor ?? 0.3 : 0.3,
        fading_floor: raw.vitality?.zone_thresholds ? raw.vitality.zone_thresholds?.fading_floor ?? 0.1 : 0.1
      }
    },
    llm: {
      provider: rawLlm?.provider ?? DEFAULT_LLM_CONFIG.provider,
      model: rawLlm?.model ?? DEFAULT_LLM_CONFIG.model,
      api_key_env: rawLlm?.api_key_env ?? DEFAULT_LLM_CONFIG.api_key_env,
      api_key_cmd: rawLlm?.api_key_cmd ?? DEFAULT_LLM_CONFIG.api_key_cmd,
      base_url: rawLlm?.base_url ?? DEFAULT_LLM_CONFIG.base_url
    },
    promote: {
      auto: rawPromote?.auto ?? DEFAULT_PROMOTE_CONFIG.auto,
      require_llm: rawPromote?.require_llm ?? DEFAULT_PROMOTE_CONFIG.require_llm,
      min_confidence: rawPromote?.min_confidence ?? DEFAULT_PROMOTE_CONFIG.min_confidence,
      project_keywords: rawPromote?.project_keywords ?? DEFAULT_PROMOTE_CONFIG.project_keywords,
      project_map_routing: rawPromote?.project_map_routing ?? DEFAULT_PROMOTE_CONFIG.project_map_routing,
      default_area: rawPromote?.default_area ?? DEFAULT_PROMOTE_CONFIG.default_area
    },
    graph: {
      pagerank_alpha: rawGraph?.pagerank_alpha ?? DEFAULT_GRAPH_CONFIG.pagerank_alpha,
      bridge_vitality_floor: rawGraph?.bridge_vitality_floor ?? DEFAULT_GRAPH_CONFIG.bridge_vitality_floor,
      hub_degree_multiplier: rawGraph?.hub_degree_multiplier ?? DEFAULT_GRAPH_CONFIG.hub_degree_multiplier
    },
    engine: {
      embedding_model: rawEngine?.embedding_model ?? DEFAULT_ENGINE_CONFIG.embedding_model,
      embedding_dims: rawEngine?.embedding_dims ?? DEFAULT_ENGINE_CONFIG.embedding_dims,
      piecewise_bins: rawEngine?.piecewise_bins ?? DEFAULT_ENGINE_CONFIG.piecewise_bins,
      community_dims: rawEngine?.community_dims ?? DEFAULT_ENGINE_CONFIG.community_dims,
      db_path: rawEngine?.db_path ?? DEFAULT_ENGINE_CONFIG.db_path
    },
    retrieval: {
      default_limit: rawRetrieval?.default_limit ?? DEFAULT_RETRIEVAL_CONFIG.default_limit,
      candidate_multiplier: rawRetrieval?.candidate_multiplier ?? DEFAULT_RETRIEVAL_CONFIG.candidate_multiplier,
      rrf_k: rawRetrieval?.rrf_k ?? DEFAULT_RETRIEVAL_CONFIG.rrf_k,
      signal_weights: {
        composite: rawRetrieval?.signal_weights?.composite ?? DEFAULT_RETRIEVAL_CONFIG.signal_weights.composite,
        keyword: rawRetrieval?.signal_weights?.keyword ?? DEFAULT_RETRIEVAL_CONFIG.signal_weights.keyword,
        graph: rawRetrieval?.signal_weights?.graph ?? DEFAULT_RETRIEVAL_CONFIG.signal_weights.graph,
        warmth: rawRetrieval?.signal_weights?.warmth ?? DEFAULT_RETRIEVAL_CONFIG.signal_weights.warmth
      },
      exploration_budget: rawRetrieval?.exploration_budget ?? DEFAULT_RETRIEVAL_CONFIG.exploration_budget
    },
    bm25: {
      k1: rawBM25?.k1 ?? DEFAULT_BM25_CONFIG.k1,
      b: rawBM25?.b ?? DEFAULT_BM25_CONFIG.b,
      title_boost: rawBM25?.title_boost ?? DEFAULT_BM25_CONFIG.title_boost,
      description_boost: rawBM25?.description_boost ?? DEFAULT_BM25_CONFIG.description_boost
    },
    ips: {
      enabled: rawIPS?.enabled ?? DEFAULT_IPS_CONFIG.enabled,
      epsilon: rawIPS?.epsilon ?? DEFAULT_IPS_CONFIG.epsilon,
      log_path: rawIPS?.log_path ?? DEFAULT_IPS_CONFIG.log_path
    },
    activation: {
      enabled: rawActivation?.enabled ?? DEFAULT_ACTIVATION_CONFIG.enabled,
      damping: rawActivation?.damping ?? DEFAULT_ACTIVATION_CONFIG.damping,
      max_hops: rawActivation?.max_hops ?? DEFAULT_ACTIVATION_CONFIG.max_hops,
      min_boost: rawActivation?.min_boost ?? DEFAULT_ACTIVATION_CONFIG.min_boost
    },
    warmth: {
      enabled: rawWarmth?.enabled ?? DEFAULT_WARMTH_CONFIG.enabled,
      surprise_threshold: rawWarmth?.surprise_threshold ?? DEFAULT_WARMTH_CONFIG.surprise_threshold,
      activation_threshold: rawWarmth?.activation_threshold ?? DEFAULT_WARMTH_CONFIG.activation_threshold,
      ppr_alpha: rawWarmth?.ppr_alpha ?? DEFAULT_WARMTH_CONFIG.ppr_alpha,
      ppr_iterations: rawWarmth?.ppr_iterations ?? DEFAULT_WARMTH_CONFIG.ppr_iterations,
      graph_weight: rawWarmth?.graph_weight ?? DEFAULT_WARMTH_CONFIG.graph_weight,
      max_results: rawWarmth?.max_results ?? DEFAULT_WARMTH_CONFIG.max_results,
      shadow_compare_enabled: rawWarmth?.shadow_compare_enabled ?? DEFAULT_WARMTH_CONFIG.shadow_compare_enabled
    },
    explore: {
      enabled: rawExplore?.enabled ?? DEFAULT_EXPLORE_CONFIG.enabled,
      default_limit: rawExplore?.default_limit ?? DEFAULT_EXPLORE_CONFIG.default_limit,
      max_limit: rawExplore?.max_limit ?? DEFAULT_EXPLORE_CONFIG.max_limit,
      ppr_alpha: rawExplore?.ppr_alpha ?? DEFAULT_EXPLORE_CONFIG.ppr_alpha,
      ppr_iterations: rawExplore?.ppr_iterations ?? DEFAULT_EXPLORE_CONFIG.ppr_iterations,
      seed_count: rawExplore?.seed_count ?? DEFAULT_EXPLORE_CONFIG.seed_count,
      score_decay_threshold: rawExplore?.score_decay_threshold ?? DEFAULT_EXPLORE_CONFIG.score_decay_threshold,
      max_depth: rawExplore?.max_depth ?? DEFAULT_EXPLORE_CONFIG.max_depth,
      warmth_seed_blend: rawExplore?.warmth_seed_blend ?? DEFAULT_EXPLORE_CONFIG.warmth_seed_blend,
      q_seed_blend: rawExplore?.q_seed_blend ?? DEFAULT_EXPLORE_CONFIG.q_seed_blend,
      max_warmth_only_seeds: rawExplore?.max_warmth_only_seeds ?? DEFAULT_EXPLORE_CONFIG.max_warmth_only_seeds,
      snippet_preview_length: rawExplore?.snippet_preview_length ?? DEFAULT_EXPLORE_CONFIG.snippet_preview_length,
      snippet_max_links: rawExplore?.snippet_max_links ?? DEFAULT_EXPLORE_CONFIG.snippet_max_links,
      cooc_blend_beta: rawExplore?.cooc_blend_beta ?? DEFAULT_EXPLORE_CONFIG.cooc_blend_beta,
      recursive_enabled: rawExplore?.recursive_enabled ?? DEFAULT_EXPLORE_CONFIG.recursive_enabled,
      max_recursion_depth: rawExplore?.max_recursion_depth ?? DEFAULT_EXPLORE_CONFIG.max_recursion_depth,
      max_total_notes: rawExplore?.max_total_notes ?? DEFAULT_EXPLORE_CONFIG.max_total_notes,
      convergence_threshold: rawExplore?.convergence_threshold ?? DEFAULT_EXPLORE_CONFIG.convergence_threshold,
      sub_question_max: rawExplore?.sub_question_max ?? DEFAULT_EXPLORE_CONFIG.sub_question_max,
      ppr_iteration_decay: rawExplore?.ppr_iteration_decay ?? DEFAULT_EXPLORE_CONFIG.ppr_iteration_decay
    }
  };
}
function validateConfig(config) {
  const errors = [];
  if (!config.vault.version) {
    errors.push("vault.version is required");
  }
  if (!config.templates.default) {
    errors.push("templates.default is required");
  }
  if (typeof config.vitality.base !== "number") {
    errors.push("vitality.base must be a number");
  }
  return errors;
}
async function loadConfig(filePath) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return applyConfigDefaults({});
    }
    throw err;
  }
  const raw = yaml.parse(content);
  const config = applyConfigDefaults(raw ?? {});
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid config: ${errors.join(", ")}`);
  }
  return config;
}
function resolveTemplatePath(config, vaultRoot, type) {
  const rel = type && config.templates.by_type[type] || config.templates.default;
  return path.resolve(vaultRoot, rel);
}
export {
  applyConfigDefaults,
  loadConfig,
  resolveTemplatePath,
  validateConfig
};
