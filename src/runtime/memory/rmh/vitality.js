function daysBetween(a, b) {
  const ms = Math.abs(b.getTime() - a.getTime());
  return ms / (1e3 * 60 * 60 * 24);
}
function computeVitality(params, lastAccessed, now) {
  if (params.decayDays <= 0) {
    return params.base;
  }
  const t = daysBetween(lastAccessed, now);
  const v = params.base * Math.exp(-t / params.decayDays);
  return Math.max(0, Math.min(params.base, v));
}
function computeVitalityACTR(accessCount, lifetimeDays, d = 0.5) {
  if (accessCount <= 0) return 0.5;
  if (lifetimeDays <= 0) return 1;
  const dClamped = Math.max(0.01, Math.min(d, 0.99));
  const B = Math.log(accessCount / (1 - dClamped)) - dClamped * Math.log(lifetimeDays);
  return 1 / (1 + Math.exp(-B));
}
function computeStructuralBoost(inDegree) {
  return 1 + 0.1 * Math.min(inDegree, 10);
}
function computeRevivalBoost(daysSinceNewConnection) {
  if (daysSinceNewConnection === void 0 || daysSinceNewConnection < 0) return 0;
  if (daysSinceNewConnection >= 14) return 0;
  return Math.exp(-0.2 * daysSinceNewConnection);
}
function computeAccessSaturation(accessCount, k = 10) {
  if (accessCount <= 0) return 0;
  return 1 - Math.exp(-accessCount / k);
}
function computeVitalityFull(params) {
  const {
    accessCount,
    created,
    noteTitle,
    inDegree,
    bridges,
    metabolicRate = 1,
    daysSinceNewConnection,
    actrDecay = 0.5,
    accessSaturationK = 10,
    bridgeFloor = 0.5
  } = params;
  const createdDate = new Date(created);
  const now = /* @__PURE__ */ new Date();
  const lifetimeDays = daysBetween(createdDate, now);
  const effectiveDecay = actrDecay * metabolicRate;
  let vitality = computeVitalityACTR(accessCount, lifetimeDays, effectiveDecay);
  const structuralBoost = computeStructuralBoost(inDegree);
  vitality = vitality * structuralBoost;
  const saturation = computeAccessSaturation(accessCount, accessSaturationK);
  vitality = vitality * (0.5 + 0.5 * saturation);
  const revival = computeRevivalBoost(daysSinceNewConnection);
  vitality = vitality + revival * 0.2;
  vitality = vitality + (params.activationBoost ?? 0);
  if (bridges.has(noteTitle)) {
    vitality = Math.max(vitality, bridgeFloor);
  }
  return Math.max(0, Math.min(1, vitality));
}
const DEFAULT_ZONE_THRESHOLDS = {
  active: 0.6,
  stale: 0.3,
  fading: 0.1
};
function classifyZone(vitality, currentStatus, thresholds = DEFAULT_ZONE_THRESHOLDS) {
  if (currentStatus === "archived") return "archived";
  if (vitality >= thresholds.active) return "active";
  if (vitality >= thresholds.stale) return "stale";
  if (vitality >= thresholds.fading) return "fading";
  return "archived";
}
export {
  DEFAULT_ZONE_THRESHOLDS,
  classifyZone,
  computeAccessSaturation,
  computeRevivalBoost,
  computeStructuralBoost,
  computeVitality,
  computeVitalityACTR,
  computeVitalityFull,
  daysBetween
};
