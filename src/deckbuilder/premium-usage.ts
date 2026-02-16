/**
 * Premium Usage Tracking
 *
 * Tracks usage of premium-candidate features and shows soft, non-intrusive
 * upgrade prompts via the toast system after a usage threshold is reached.
 *
 * All features remain 100% free — this module only collects funnel data:
 *   feature_used → upgrade_prompt_shown → upgrade_prompt_clicked
 *
 * Guards:
 *   - Max 1 prompt per session per feature (in-memory Set)
 *   - Max 3 lifetime impressions per feature (localStorage counter)
 */

import { showToast } from './toast.js';
import { trackAnalyticsEvent } from '../shared/analytics.js';

// ───── Feature Registry ─────

const PREMIUM_FEATURES = {
  optimization_wizard: { label: 'Optimization Wizard', threshold: 3 },
  budget_optimizer: { label: 'Budget Optimizer', threshold: 3 },
  matchup_panel: { label: 'Matchup Guide', threshold: 3 },
  rec_history: { label: 'Recommendation History', threshold: 5 },
  deck_comparison: { label: 'Deck Comparison', threshold: 3 },
  print_proxy: { label: 'Print Proxies', threshold: 3 },
  goldfish_playtest: { label: 'Goldfish Playtest', threshold: 3 },
} as const;

export type PremiumFeatureId = keyof typeof PREMIUM_FEATURES;

const MAX_LIFETIME_IMPRESSIONS = 3;

// ───── Storage Helpers ─────

function storageKey(id: PremiumFeatureId, suffix: 'count' | 'impressions'): string {
  return `dl_premium_${id}_${suffix}`;
}

function readInt(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeInt(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Ignore storage write failures.
  }
}

// ───── Session Guard ─────

const sessionPrompted = new Set<string>();

// ───── Core Tracking ─────

/**
 * Track usage of a premium-candidate feature.
 *
 * - Increments the localStorage usage counter
 * - Fires a `feature_used` analytics event
 * - When the usage threshold is reached, shows a soft upgrade toast
 *   (subject to session + lifetime impression caps)
 */
export function trackPremiumFeatureUse(id: PremiumFeatureId): void {
  const feature = PREMIUM_FEATURES[id];
  if (!feature) return;

  // Increment usage count
  const countKey = storageKey(id, 'count');
  const count = readInt(countKey) + 1;
  writeInt(countKey, count);

  // Fire top-of-funnel analytics
  trackAnalyticsEvent('feature_used', {
    feature: id,
    featureLabel: feature.label,
    tier: 'premium_candidate',
    usageCount: count,
  });

  // Check whether to show upgrade prompt
  if (count < feature.threshold) return;
  // Only prompt on exact threshold hit, or every N subsequent uses
  if (count !== feature.threshold && (count - feature.threshold) % feature.threshold !== 0) return;

  // Session guard — max 1 prompt per feature per session
  if (sessionPrompted.has(id)) return;

  // Lifetime guard — max N impressions ever
  const impKey = storageKey(id, 'impressions');
  const impressions = readInt(impKey);
  if (impressions >= MAX_LIFETIME_IMPRESSIONS) return;

  // Show the prompt
  sessionPrompted.add(id);
  writeInt(impKey, impressions + 1);

  trackAnalyticsEvent('upgrade_prompt_shown', {
    feature: id,
    featureLabel: feature.label,
    usageCount: count,
    impressionNumber: impressions + 1,
  });

  showToast({
    message: `You\u2019ve used ${feature.label} ${count} times \u2014 love it? A Pro plan is on the way.`,
    type: 'info',
    duration: 6000,
    action: {
      label: 'Learn More',
      onClick: () => {
        trackAnalyticsEvent('upgrade_prompt_clicked', {
          feature: id,
          featureLabel: feature.label,
          usageCount: count,
        });
        // Placeholder — no /pricing page yet. Opens anchor or is a no-op.
        if (typeof window !== 'undefined') {
          window.location.hash = 'pricing';
        }
      },
    },
  });
}

// ───── Debug / Analytics Helper ─────

/**
 * Return current usage counts for all premium features.
 * Useful for analytics dashboards or debug panels.
 */
export function getPremiumUsageStats(): Record<PremiumFeatureId, number> {
  const stats = {} as Record<PremiumFeatureId, number>;
  for (const id of Object.keys(PREMIUM_FEATURES) as PremiumFeatureId[]) {
    stats[id] = readInt(storageKey(id, 'count'));
  }
  return stats;
}
