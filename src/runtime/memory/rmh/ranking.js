function rankByImportance(notes, pagerankScores, limit) {
  const scored = notes.map((title) => ({
    title,
    score: pagerankScores.get(title) ?? 0,
    signals: { graph: pagerankScores.get(title) ?? 0 }
  }));
  scored.sort((a, b) => b.score - a.score);
  return limit ? scored.slice(0, limit) : scored;
}
function rankByFading(notes, vitalityScores, threshold = 0.3) {
  const fading = [];
  for (const title of notes) {
    const vitality = vitalityScores.get(title) ?? 0;
    if (vitality < threshold) {
      fading.push({
        title,
        score: vitality,
        signals: { composite: vitality }
      });
    }
  }
  fading.sort((a, b) => a.score - b.score);
  return fading;
}
function rankByVitality(notes, vitalityScores, limit) {
  const scored = notes.map((title) => ({
    title,
    score: vitalityScores.get(title) ?? 0,
    signals: { composite: vitalityScores.get(title) ?? 0 }
  }));
  scored.sort((a, b) => b.score - a.score);
  return limit ? scored.slice(0, limit) : scored;
}
export {
  rankByFading,
  rankByImportance,
  rankByVitality
};
