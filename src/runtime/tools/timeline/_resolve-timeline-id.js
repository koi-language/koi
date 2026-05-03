/**
 * Shared helper: resolve a timeline ID from a tool's params with a
 * sensible default-from-active-doc fallback.
 *
 * Why this exists: the LLM reaches for `id`, `timelineId`, AND no field
 * at all (relying on the active doc) at roughly equal frequencies.
 * Without this fallback, the FIRST timeline tool call after a turn
 * regularly 404s with "Timeline undefined not found", the agent
 * recovers via a re-read or retry, and the second call succeeds —
 * wasted round-trip on the common case where the user is asking
 * something about THE timeline they're looking at.
 *
 * Returns the resolved string id, or null when nothing is available.
 * Caller is responsible for surfacing a user-facing error in the null
 * case.
 */
export async function resolveTimelineId(params) {
  const fromParams = params?.id || params?.timelineId;
  if (typeof fromParams === 'string' && fromParams.length > 0) return fromParams;

  try {
    const { openDocumentsStore } = await import('../../state/open-documents-store.js');
    const active = openDocumentsStore.getSnapshotActive?.()
      || openDocumentsStore.getActive?.();
    if (!active || active.type !== 'timeline') return null;
    if (typeof active.id === 'string' && active.id.startsWith('tl-')) return active.id;
    if (typeof active.timelineId === 'string') return active.timelineId;
    if (typeof active.path === 'string') {
      const m = active.path.match(/[/\\](tl-[^/\\]+?)\.json$/);
      if (m) return m[1];
    }
  } catch {
    /* store unavailable — fall through to null */
  }
  return null;
}
