interface TabIdentity {
  tabId: string;
}

interface LeafTabs<TTab extends TabIdentity> {
  id: string;
  tabs: readonly TTab[];
}

export function collectUniqueSessionTabIds<TTab>(
  tabs: Iterable<TTab>,
  getSessionId: (tab: TTab) => string | null | undefined
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    const sessionId = getSessionId(tab);
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    ids.push(sessionId);
  }
  return ids;
}

/** Preserve leaf/tab traversal order while collecting duplicated session ids. */
export function findDuplicateSessionTabIds<TTab extends TabIdentity>(
  leaves: Iterable<LeafTabs<TTab>>,
  getSessionId: (tab: TTab) => string | null | undefined
): Map<string, Array<{ leafId: string; tabId: string }>> {
  const bySessionId = new Map<
    string,
    Array<{ leafId: string; tabId: string }>
  >();
  for (const leaf of leaves) {
    for (const tab of leaf.tabs) {
      const sessionId = getSessionId(tab);
      if (!sessionId) continue;
      const locations = bySessionId.get(sessionId);
      const location = { leafId: leaf.id, tabId: tab.tabId };
      if (locations) locations.push(location);
      else bySessionId.set(sessionId, [location]);
    }
  }

  const duplicates = new Map<
    string,
    Array<{ leafId: string; tabId: string }>
  >();
  for (const [sessionId, locations] of bySessionId) {
    if (locations.length >= 2) duplicates.set(sessionId, locations);
  }
  return duplicates;
}
