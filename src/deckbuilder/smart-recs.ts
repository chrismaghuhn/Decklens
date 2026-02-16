import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import type { Deck } from '../shared/types.js';
import {
  generateRecommendationEngineV1,
  type RecommendationEngineInput,
  type RecommendationEngineV1Response,
  type RecommendationV1Item,
  type RecommendationCardMetrics,
  type MetaMode,
} from '../mtg/engine/recommendation-v1.js';
import { generateRecsViaWorker } from './rec-worker-client.js';
import { isOwned, getOwnedQty } from './collection.js';
import { simulateSwap, renderWhatIfPreview } from './what-if.js';
import { getTeamOwnership } from './collab-collection.js';
import { isCollabActive } from './collab-ui.js';
import { getMaxCardPrice } from './collab-constraints.js';
import { renderTrustRow, renderDiffToggle, renderMetaFreshnessIndicator, renderFallbackLabel, renderDistrustButton } from './recommendation-trust.js';
import { getMetaFreshness, getMetaQuality } from './meta-badges.js';
import { trackRecInteraction } from './activation-funnel.js';
import { trackAnalyticsEvent } from '../shared/analytics.js';
import type { RecommendationLogicTag } from '../mtg/recommendation-impact.js';

// ───── Category → LogicTag Mapper ─────

const CATEGORY_TO_LOGIC_TAG: Record<string, RecommendationLogicTag> = {
  synergy: 'synergy',
  curve_fix: 'curve-fix',
  mana_fix: 'mana-fix',
  consistency: 'card-advantage',
};

export function categoryToLogicTags(category: string): RecommendationLogicTag[] {
  const tag = CATEGORY_TO_LOGIC_TAG[category];
  return tag ? [tag] : ['synergy'];
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function deckToShared(deck: DeckbuilderDeck): Deck {
  return {
    main: deck.boards.mainboard.map((e) => ({ name: e.name, qty: e.qty })),
    sideboard: deck.boards.sideboard.map((e) => ({ name: e.name, qty: e.qty })),
    commander: deck.boards.commander.map((e) => ({ name: e.name, qty: e.qty })),
  };
}

function heuristicColor(value: number): string {
  if (value >= 0.6) return '#34d399';
  if (value >= 0.3) return '#e8c84a';
  return 'rgba(255,255,255,0.1)';
}

const CATEGORY_CHIP_LABELS: Record<string, string> = {
  synergy: 'Synergy Boost',
  curve_fix: 'Curve Fix',
  mana_fix: 'Mana Fix',
  consistency: 'Consistency',
};

function createCategoryChip(category: string): HTMLElement {
  const chip = document.createElement('span');
  chip.className = `rec-chip rec-chip-${category}`;
  chip.textContent = CATEGORY_CHIP_LABELS[category] || category;
  return chip;
}

export interface SmartRecsCallbacks {
  onApplySwap(cutName: string | null, addName: string): void;
  onApplySwapWithMeta?(rec: RecommendationV1Item): void;
}

export function renderSmartRecs(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  metaMode: MetaMode,
  callbacks: SmartRecsCallbacks,
): void {
  container.textContent = '';

  if (deck.boards.mainboard.length < 10) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'Add more cards to your mainboard to generate recommendations.';
    container.appendChild(empty);
    return;
  }

  // Build card metrics from resolved data
  const cardMetrics: Record<string, RecommendationCardMetrics> = {};
  for (const [key, card] of Object.entries(cardByName)) {
    if (!card) continue;
    cardMetrics[key] = {
      name: card.name,
      mana_cost: card.mana_cost,
      cmc: card.cmc,
      type_line: card.type_line,
      oracle_text: card.oracle_text,
      color_identity: card.color_identity,
      prices: card.prices,
    };
  }

  // Build collection map (merge local + team collection if collab active)
  const collectionByName: Record<string, number> = {};
  for (const entry of [...deck.boards.mainboard, ...deck.boards.sideboard, ...deck.boards.commander]) {
    const ownedQty = getOwnedQty(entry.name);
    if (ownedQty > 0) {
      collectionByName[normalizeKey(entry.name)] = ownedQty;
    }
    // Merge team collection data when in collab
    if (isCollabActive()) {
      const teamData = getTeamOwnership(entry.name);
      if (teamData && teamData.total > 0) {
        const key = normalizeKey(entry.name);
        collectionByName[key] = Math.max(collectionByName[key] || 0, teamData.total);
      }
    }
  }

  const input: RecommendationEngineInput = {
    deck: deckToShared(deck),
    cardMetricsByName: cardMetrics,
    collectionByName,
    metaMode,
    maxRecommendations: 5,
  };

  // E1: Try Web Worker first, fall back to main thread
  const workerPromise = generateRecsViaWorker(input);
  if (workerPromise) {
    // Show loading state
    const loading = document.createElement('div');
    loading.className = 'muted';
    loading.textContent = 'Generating recommendations\u2026';
    container.appendChild(loading);

    workerPromise.then((result) => {
      container.removeChild(loading);
      renderRecommendationResults(container, result, deck, cardByName, cardMetrics, callbacks);
    }).catch(() => {
      // Fall back to main thread
      container.removeChild(loading);
      try {
        const result = generateRecommendationEngineV1(input);
        renderRecommendationResults(container, result, deck, cardByName, cardMetrics, callbacks);
      } catch {
        const err = document.createElement('div');
        err.className = 'muted';
        err.textContent = 'Could not generate recommendations for this deck.';
        container.appendChild(err);
      }
    });
    return;
  }

  // Main thread fallback (worker unavailable)
  let result: RecommendationEngineV1Response;
  try {
    result = generateRecommendationEngineV1(input);
  } catch {
    const err = document.createElement('div');
    err.className = 'muted';
    err.textContent = 'Could not generate recommendations for this deck.';
    container.appendChild(err);
    return;
  }
  renderRecommendationResults(container, result, deck, cardByName, cardMetrics, callbacks);
}

function renderRecommendationResults(
  container: HTMLElement,
  result: RecommendationEngineV1Response,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  cardMetrics: Record<string, RecommendationCardMetrics>,
  callbacks: SmartRecsCallbacks,
): void {
  // Filter by team constraints (max card price)
  if (isCollabActive()) {
    const maxPrice = getMaxCardPrice();
    if (maxPrice !== null && result.recommendations) {
      result.recommendations = result.recommendations.filter((rec) => {
        const card = cardMetrics[normalizeKey(rec.add.name)];
        if (!card?.prices) return true;
        const price = parseFloat(card.prices.eur || card.prices.usd || '0');
        return price <= maxPrice;
      });
    }
  }

  // Stats row
  if (result.stats) {
    const statsRow = document.createElement('div');
    statsRow.className = 'rec-stats';

    const stats = [
      { label: 'Archetype', value: result.stats.dominantArchetype },
      { label: 'Avg CMC', value: result.stats.averageCmc.toFixed(1) },
      { label: 'Cards', value: String(result.stats.deckCards) },
    ];

    // Add color deficits
    for (const def of result.stats.colorDeficits) {
      if (def.ratio < 0.8) {
        stats.push({ label: def.color, value: `${def.source}/${def.demand} sources` });
      }
    }

    for (const stat of stats) {
      const el = document.createElement('span');
      el.className = 'rec-stat';
      el.innerHTML = `${stat.label}: <strong>${stat.value}</strong>`;
      statsRow.appendChild(el);
    }
    container.appendChild(statsRow);
  }

  // Meta freshness indicator
  const freshness = getMetaFreshness();
  if (freshness) {
    container.appendChild(renderMetaFreshnessIndicator(freshness));
  }

  // Fallback behavior label (when meta data is degraded)
  const metaQuality = getMetaQuality();
  if (metaQuality) {
    const fallbackEl = renderFallbackLabel(metaQuality);
    if (fallbackEl) container.appendChild(fallbackEl);
  }

  if (result.recommendations.length === 0) {
    const none = document.createElement('div');
    none.className = 'muted';
    none.textContent = 'No swap recommendations found.';
    container.appendChild(none);
    return;
  }

  for (const rec of result.recommendations) {
    container.appendChild(createRecItem(rec, deck, cardByName, callbacks));
  }
}

function createRecItem(
  rec: RecommendationV1Item,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  callbacks: SmartRecsCallbacks,
): HTMLElement {
  const item = document.createElement('div');
  item.className = 'rec-item';

  // Cut side
  const cutEl = document.createElement('div');
  cutEl.className = 'rec-cut';
  if (rec.cut) {
    const cutName = document.createElement('div');
    cutName.className = 'rec-card-name';
    cutName.textContent = rec.cut.name;
    cutEl.appendChild(cutName);
    if (rec.cut.reasons.length > 0) {
      const cutReasons = document.createElement('div');
      cutReasons.className = 'rec-reasons';
      cutReasons.textContent = rec.cut.reasons[0];
      cutEl.appendChild(cutReasons);
    }
  } else {
    const nocut = document.createElement('div');
    nocut.className = 'muted';
    nocut.style.fontSize = '0.72rem';
    nocut.textContent = '(add only)';
    cutEl.appendChild(nocut);
  }

  // Arrow
  const arrow = document.createElement('div');
  arrow.className = 'rec-arrow';
  arrow.textContent = '→';

  // Add side
  const addEl = document.createElement('div');
  addEl.className = 'rec-add';

  // Category explanation chip
  addEl.appendChild(createCategoryChip(rec.category));

  const addName = document.createElement('div');
  addName.className = 'rec-card-name';
  addName.textContent = rec.add.name;
  addEl.appendChild(addName);

  const addMeta = document.createElement('div');
  addMeta.className = 'rec-reasons';
  const parts: string[] = [];
  if (rec.add.role.length > 0) parts.push(rec.add.role.join(', '));
  if (rec.add.estimatedPriceEur !== null) parts.push(`€${rec.add.estimatedPriceEur.toFixed(2)}`);
  addMeta.textContent = parts.join(' · ');
  addEl.appendChild(addMeta);

  if (rec.reasons.length > 0) {
    const reasonsEl = document.createElement('div');
    reasonsEl.className = 'rec-reasons';
    reasonsEl.textContent = rec.reasons[0];
    addEl.appendChild(reasonsEl);
  }

  // Heuristic bars with hover tooltips
  const bars = document.createElement('div');
  bars.className = 'rec-heuristics';
  const hKeys = ['synergy', 'curveFix', 'manaFix', 'deadCardReduction', 'collectionFit'] as const;
  const hLabels: Record<string, string> = {
    synergy: 'Synergy with your existing cards',
    curveFix: 'Improves your mana curve balance',
    manaFix: 'Fixes color source deficiencies',
    deadCardReduction: 'Replaces a weak/dead card',
    collectionFit: 'You already own this card',
  };
  for (const hKey of hKeys) {
    const barWrap = document.createElement('div');
    barWrap.className = 'rec-heuristic-wrap';

    const bar = document.createElement('div');
    bar.className = 'rec-heuristic-bar';
    bar.style.background = heuristicColor(rec.heuristics[hKey]);

    const tip = document.createElement('div');
    tip.className = 'rec-heuristic-tip';
    tip.textContent = `${hLabels[hKey]}: ${(rec.heuristics[hKey] * 100).toFixed(0)}%`;

    barWrap.append(bar, tip);
    bars.appendChild(barWrap);
  }

  // Trust badges (confidence + source)
  const trustRow = renderTrustRow(rec.confidence, rec.source);

  // Distrust feedback button
  const distrustBtn = renderDistrustButton(() => {
    trackRecInteraction('distrust', rec.id, 'strategy_tab', {
      addName: rec.add.name,
      cutName: rec.cut?.name ?? null,
      confidence: rec.confidence,
      source: rec.source,
    });
    trackAnalyticsEvent('recommendation_distrusted', {
      recId: rec.id,
      addName: rec.add.name,
      cutName: rec.cut?.name ?? null,
      confidence: rec.confidence,
      source: rec.source,
      metaFreshness: getMetaFreshness()?.state ?? 'unknown',
      metaDegraded: getMetaQuality()?.degraded ?? null,
    });
  });

  // Diff preview toggle
  const diffToggle = renderDiffToggle(deck, cardByName, rec.cut?.name || null, rec.add.name);

  // Apply button
  const applyBtn = document.createElement('button');
  applyBtn.className = 'rec-apply';
  applyBtn.textContent = rec.cut ? 'Swap' : 'Add';
  applyBtn.addEventListener('click', () => {
    if (callbacks.onApplySwapWithMeta) {
      callbacks.onApplySwapWithMeta(rec);
    } else {
      callbacks.onApplySwap(rec.cut?.name || null, rec.add.name);
    }
  });

  // What-If preview tooltip
  const whatIfBox = document.createElement('div');
  whatIfBox.className = 'whatif-preview';

  let whatIfTimer: ReturnType<typeof setTimeout> | null = null;
  let whatIfComputed = false;

  item.addEventListener('mouseenter', () => {
    if (whatIfComputed) {
      whatIfBox.style.display = '';
      return;
    }
    whatIfTimer = setTimeout(() => {
      try {
        const metrics = simulateSwap(deck, cardByName, rec.cut?.name || null, rec.add.name);
        renderWhatIfPreview(whatIfBox, metrics);
        whatIfComputed = true;
        whatIfBox.style.display = '';
      } catch { /* non-critical */ }
    }, 200);
  });

  item.addEventListener('mouseleave', () => {
    if (whatIfTimer) { clearTimeout(whatIfTimer); whatIfTimer = null; }
    whatIfBox.style.display = 'none';
  });

  whatIfBox.style.display = 'none';

  item.append(cutEl, arrow, addEl, applyBtn);
  item.appendChild(bars);
  item.appendChild(trustRow);
  item.appendChild(distrustBtn);
  item.appendChild(diffToggle);
  item.appendChild(whatIfBox);
  return item;
}
