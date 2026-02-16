/**
 * Recommendation Trust Layer
 *
 * Renders confidence badges, source attribution badges, and
 * compact diff preview panels for recommendation items.
 *
 * Used by smart-recs.ts and optimization-wizard.ts to build trust
 * signals on each recommendation.
 */

import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import type { RecSource } from '../mtg/engine/recommendation-v1.js';
import { simulateSwap, type WhatIfMetrics } from './what-if.js';

// ───── Types ─────

export type ConfidenceBand = 'high' | 'medium' | 'low';

// ───── Confidence ─────

export function getConfidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.7) return 'high';
  if (confidence >= 0.4) return 'medium';
  return 'low';
}

const CONFIDENCE_CONFIG: Record<ConfidenceBand, { label: string; cls: string; tooltip: string }> = {
  high: {
    label: 'High confidence',
    cls: 'confidence-badge-high',
    tooltip: 'Strong data support — this recommendation is well-validated by deck analysis.',
  },
  medium: {
    label: 'Medium confidence',
    cls: 'confidence-badge-medium',
    tooltip: 'Moderate data support — this is a solid suggestion but may depend on your playstyle.',
  },
  low: {
    label: 'Low confidence',
    cls: 'confidence-badge-low',
    tooltip: 'Limited data — this suggestion is based on heuristics and may need testing.',
  },
};

/**
 * Render a confidence badge with visual bar and tooltip.
 */
export function renderConfidenceBadge(confidence: number): HTMLElement {
  const band = getConfidenceBand(confidence);
  const config = CONFIDENCE_CONFIG[band];

  const container = document.createElement('div');
  container.className = `confidence-badge ${config.cls}`;
  container.title = config.tooltip;

  // Label
  const label = document.createElement('span');
  label.className = 'confidence-badge-label';
  label.textContent = config.label;

  // Bar
  const barWrap = document.createElement('span');
  barWrap.className = 'confidence-bar-wrap';

  const bar = document.createElement('span');
  bar.className = 'confidence-bar-fill';
  bar.style.width = `${Math.round(confidence * 100)}%`;

  barWrap.appendChild(bar);
  container.append(label, barWrap);
  return container;
}

// ───── Source Attribution ─────

const SOURCE_CONFIG: Record<RecSource, { icon: string; label: string; tooltip: string }> = {
  discovery: {
    icon: '\uD83D\uDD0D',
    label: 'Discovered',
    tooltip: 'Found via dynamic card search — a fresh pick based on your deck profile.',
  },
  archetype: {
    icon: '\uD83C\uDFAF',
    label: 'Archetype Match',
    tooltip: 'Matches your deck\'s archetype profile and strategic role needs.',
  },
  anti_meta: {
    icon: '\uD83D\uDEE1\uFE0F',
    label: 'Meta Counter',
    tooltip: 'Counters popular strategies in the current metagame.',
  },
  learned: {
    icon: '\uD83D\uDCDA',
    label: 'Learned',
    tooltip: 'Recommended based on your past feedback and preferences.',
  },
  staple: {
    icon: '\u2B50',
    label: 'Staple',
    tooltip: 'A widely-played format staple with proven track record.',
  },
};

/**
 * Render a source attribution badge.
 */
export function renderSourceBadge(source: RecSource): HTMLElement {
  const config = SOURCE_CONFIG[source] || SOURCE_CONFIG.archetype;

  const badge = document.createElement('span');
  badge.className = `source-badge source-badge-${source}`;
  badge.title = config.tooltip;

  badge.textContent = `${config.icon} ${config.label}`;
  return badge;
}

// ───── Diff Preview Panel ─────

/**
 * Render a compact inline diff preview showing metric changes for a swap.
 */
export function renderDiffPreview(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  cutName: string | null,
  addName: string,
): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'diff-preview-panel';

  let metrics: WhatIfMetrics;
  try {
    metrics = simulateSwap(deck, cardByName, cutName, addName);
  } catch {
    const err = document.createElement('div');
    err.className = 'muted';
    err.style.fontSize = '0.72rem';
    err.textContent = 'Could not compute preview.';
    panel.appendChild(err);
    return panel;
  }

  const rows: Array<{ label: string; before: string; after: string; delta: string; positive: boolean }> = [];

  // CMC
  if (Math.abs(metrics.avgCmcDelta) >= 0.01) {
    const sign = metrics.avgCmcDelta > 0 ? '+' : '';
    rows.push({
      label: 'Avg CMC',
      before: metrics.avgCmcBefore.toFixed(2),
      after: metrics.avgCmcAfter.toFixed(2),
      delta: `${sign}${metrics.avgCmcDelta.toFixed(2)}`,
      positive: metrics.avgCmcDelta < 0,
    });
  }

  // Land count
  if (metrics.landCountBefore !== metrics.landCountAfter) {
    const landDelta = metrics.landCountAfter - metrics.landCountBefore;
    const sign = landDelta > 0 ? '+' : '';
    rows.push({
      label: 'Lands',
      before: String(metrics.landCountBefore),
      after: String(metrics.landCountAfter),
      delta: `${sign}${landDelta}`,
      positive: landDelta > 0,
    });
  }

  // Bracket
  if (metrics.bracketBefore !== metrics.bracketAfter) {
    rows.push({
      label: 'Bracket',
      before: String(metrics.bracketBefore),
      after: String(metrics.bracketAfter),
      delta: `${metrics.bracketBefore} \u2192 ${metrics.bracketAfter}`,
      positive: metrics.bracketAfter < metrics.bracketBefore,
    });
  }

  // Price
  if (Math.abs(metrics.priceDeltaEur) >= 0.01) {
    const sign = metrics.priceDeltaEur > 0 ? '+' : '';
    rows.push({
      label: 'Price',
      before: '',
      after: '',
      delta: `${sign}\u20AC${metrics.priceDeltaEur.toFixed(2)}`,
      positive: metrics.priceDeltaEur < 0,
    });
  }

  // Fingerprint deltas (significant only)
  for (const d of metrics.fingerprintDeltas.filter((fd) => Math.abs(fd.delta) >= 3)) {
    const sign = d.delta > 0 ? '+' : '';
    rows.push({
      label: d.label,
      before: String(d.before),
      after: String(d.after),
      delta: `${sign}${d.delta}`,
      positive: d.delta > 0,
    });
  }

  if (rows.length === 0) {
    const noChange = document.createElement('div');
    noChange.className = 'muted';
    noChange.style.fontSize = '0.72rem';
    noChange.textContent = 'No significant metric changes';
    panel.appendChild(noChange);
    return panel;
  }

  // Header
  const header = document.createElement('div');
  header.className = 'diff-preview-header';
  header.textContent = 'What changes:';
  panel.appendChild(header);

  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'diff-preview-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'diff-preview-label';
    labelEl.textContent = row.label;

    const deltaEl = document.createElement('span');
    deltaEl.className = row.positive ? 'diff-delta-positive' : 'diff-delta-negative';
    deltaEl.textContent = row.delta;

    rowEl.append(labelEl, deltaEl);
    panel.appendChild(rowEl);
  }

  return panel;
}

// ───── Meta Freshness Indicator ─────

export function renderMetaFreshnessIndicator(
  freshness: { ageMinutes: number; state: 'fresh' | 'aging' | 'stale'; label: string },
): HTMLElement {
  const el = document.createElement('div');
  el.className = `meta-freshness meta-freshness-${freshness.state}`;

  const dot = document.createElement('span');
  dot.className = 'meta-freshness-dot';

  const text = document.createElement('span');
  text.className = 'meta-freshness-text';
  text.textContent = `Meta: ${freshness.state} \u00B7 ${freshness.label}`;

  el.append(dot, text);

  if (freshness.state === 'stale') {
    const warn = document.createElement('span');
    warn.className = 'meta-freshness-warn';
    warn.textContent = ' \u26A0';
    el.appendChild(warn);
  }

  return el;
}

// ───── Fallback Behavior Label ─────

const FALLBACK_DESCRIPTIONS: Record<string, string> = {
  live: 'Recommendations use current meta signals.',
  'partial-fallback': 'Some meta signals unavailable. Recommendations based on partial data.',
  'snapshot-fallback': 'Recommendations based on general archetype patterns (limited meta signals).',
};

export function renderFallbackLabel(
  quality: { degraded: boolean; fallbackMode: string; label: string; reasons: string[] },
): HTMLElement | null {
  if (!quality.degraded) return null;

  const el = document.createElement('div');
  el.className = 'meta-fallback-label';

  const icon = document.createElement('span');
  icon.className = 'meta-fallback-icon';
  icon.textContent = '\u26A0';

  const text = document.createElement('span');
  text.textContent = FALLBACK_DESCRIPTIONS[quality.fallbackMode]
    || `Limited data: ${quality.label}`;

  el.append(icon, text);
  return el;
}

// ───── Distrust Feedback Button ─────

export function renderDistrustButton(
  onDistrust: () => void,
): HTMLElement {
  const btn = document.createElement('button');
  btn.className = 'rec-distrust-btn';
  btn.type = 'button';
  btn.title = 'This recommendation does not seem right';
  btn.textContent = '\uD83D\uDC4E';

  let fired = false;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (fired) return;
    fired = true;
    btn.classList.add('rec-distrust-fired');
    btn.textContent = 'Thanks';
    onDistrust();
  });

  return btn;
}

// ───── Trust Row Container ─────

/**
 * Build a complete trust info row with confidence badge + source badge.
 * Used by smart-recs.ts createRecItem().
 */
export function renderTrustRow(confidence: number, source: RecSource): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rec-trust-row';
  row.appendChild(renderConfidenceBadge(confidence));
  row.appendChild(renderSourceBadge(source));
  return row;
}

/**
 * Build a "Preview changes" toggle button that shows/hides a diff preview panel.
 */
export function renderDiffToggle(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  cutName: string | null,
  addName: string,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'diff-toggle-container';

  const btn = document.createElement('button');
  btn.className = 'btn-ghost diff-toggle-btn';
  btn.textContent = 'Preview changes';
  btn.type = 'button';

  let panel: HTMLElement | null = null;
  let open = false;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    open = !open;

    if (open && !panel) {
      panel = renderDiffPreview(deck, cardByName, cutName, addName);
      container.appendChild(panel);
    }

    if (panel) {
      panel.style.display = open ? '' : 'none';
    }

    btn.textContent = open ? 'Hide preview' : 'Preview changes';
  });

  container.appendChild(btn);
  return container;
}
