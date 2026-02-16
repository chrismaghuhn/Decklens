import { fetchRealtimeMeta, type RealtimeMetaSnapshot } from '../shared/api.js';

let metaCache: RealtimeMetaSnapshot | null = null;
let metaFetched = false;

export async function loadMetaData(): Promise<void> {
  if (metaFetched) return;
  metaFetched = true;
  try {
    metaCache = await fetchRealtimeMeta();
  } catch {
    // Graceful degradation — no badges if API fails
    metaCache = null;
  }
}

export function getMetaBadge(cardName: string, edhrecRank?: number): { label: string; cssClass: string } | null {
  if (!metaCache) return null;

  const key = cardName.trim().toLowerCase();
  const trending = metaCache.trendingCards.find(
    (t) => t.name.trim().toLowerCase() === key,
  );

  if (trending) {
    if (trending.delta > 5) return { label: 'Hot', cssClass: 'meta-badge-hot' };
    if (trending.delta > 0) return { label: 'Trending', cssClass: 'meta-badge-trending' };
  }

  if (edhrecRank !== undefined && edhrecRank > 0 && edhrecRank <= 200) {
    return { label: 'Staple', cssClass: 'meta-badge-staple' };
  }

  return null;
}

export function isMetaLoaded(): boolean {
  return metaFetched;
}

/** Get current meta freshness state for UI display. */
export function getMetaFreshness(): { ageMinutes: number; state: 'fresh' | 'aging' | 'stale'; label: string } | null {
  if (!metaCache) return null;
  const age = metaCache.freshness.ageMinutes;
  const label = age <= 0 ? 'just now' : `${age}m ago`;
  return { ageMinutes: age, state: metaCache.freshness.state, label };
}

/** Get current meta confidence for recommendation weighting. */
export function getMetaConfidence(): { score: number; band: 'high' | 'medium' | 'low' } | null {
  if (!metaCache) return null;
  return { score: metaCache.confidence.score, band: metaCache.confidence.band };
}

/** Get current meta quality/degradation status. */
export function getMetaQuality(): { degraded: boolean; fallbackMode: string; label: string; reasons: string[] } | null {
  if (!metaCache) return null;
  return {
    degraded: metaCache.quality.degraded,
    fallbackMode: metaCache.quality.fallbackMode,
    label: metaCache.quality.label,
    reasons: [...metaCache.quality.reasons],
  };
}
