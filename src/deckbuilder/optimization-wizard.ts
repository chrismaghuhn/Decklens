/**
 * Optimization Wizard — Guided "Top 3 Moves" Flow
 *
 * Full-screen overlay triggered after deck import or via the Optimize CTA button.
 * Flow: Import (done) → Analyze → Top 3 Moves → Apply → Export
 *
 * Reuses the V1 recommendation engine for move generation and
 * simulateSwap() for diff preview on each move.
 */

import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import type { Deck } from '../shared/types.js';
import {
  generateRecommendationEngineV1,
  type RecommendationEngineInput,
  type RecommendationV1Item,
  type RecommendationCardMetrics,
} from '../mtg/engine/recommendation-v1.js';
import { simulateSwap, type WhatIfMetrics } from './what-if.js';
import {
  trackWizardOpen,
  trackWizardStep,
  trackWizardComplete,
  trackRecInteraction,
  trackFunnelStep,
  type WizardSource,
} from './activation-funnel.js';

// ───── Public Interface ─────

export interface WizardCallbacks {
  getDeck(): DeckbuilderDeck | null;
  getCardByName(): Record<string, DeckbuilderSearchCard | undefined>;
  applySwap(cutName: string | null, addName: string): void;
  applySwapWithMeta?(rec: RecommendationV1Item): void;
  onComplete(): void;
}

// ───── State ─────

type WizardStep = 'analyze' | 'moves' | 'apply' | 'export';
const STEPS: WizardStep[] = ['analyze', 'moves', 'apply', 'export'];
const STEP_LABELS: Record<WizardStep, string> = {
  analyze: 'Analyze',
  moves: 'Top 3 Moves',
  apply: 'Apply',
  export: 'Export',
};

interface WizardState {
  step: WizardStep;
  moves: RecommendationV1Item[];
  applied: Set<string>;
  callbacks: WizardCallbacks;
  deckStats: { cards: number; avgCmc: number; archetype: string } | null;
}

let wizardState: WizardState | null = null;
let overlayEl: HTMLElement | null = null;

// ───── Category chips ─────

const CATEGORY_LABELS: Record<string, string> = {
  synergy: 'Synergy Boost',
  curve_fix: 'Curve Fix',
  mana_fix: 'Mana Fix',
  consistency: 'Consistency',
};

const CATEGORY_CLASSES: Record<string, string> = {
  synergy: 'wizard-chip-synergy',
  curve_fix: 'wizard-chip-curve',
  mana_fix: 'wizard-chip-mana',
  consistency: 'wizard-chip-consistency',
};

// ───── Helpers ─────

function applyMoveViaCallbacks(callbacks: WizardCallbacks, move: RecommendationV1Item): void {
  if (callbacks.applySwapWithMeta) {
    callbacks.applySwapWithMeta(move);
  } else {
    callbacks.applySwap(move.cut?.name || null, move.add.name);
  }
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

function buildCardMetrics(
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): Record<string, RecommendationCardMetrics> {
  const metrics: Record<string, RecommendationCardMetrics> = {};
  for (const [key, card] of Object.entries(cardByName)) {
    if (!card) continue;
    metrics[key] = {
      name: card.name,
      mana_cost: card.mana_cost,
      cmc: card.cmc,
      type_line: card.type_line,
      oracle_text: card.oracle_text,
      color_identity: card.color_identity,
      prices: card.prices,
    };
  }
  return metrics;
}

function generateMoves(deck: DeckbuilderDeck, cardByName: Record<string, DeckbuilderSearchCard | undefined>): RecommendationV1Item[] {
  const input: RecommendationEngineInput = {
    deck: deckToShared(deck),
    cardMetricsByName: buildCardMetrics(cardByName),
    metaMode: 'balanced',
    maxRecommendations: 3,
  };
  try {
    const result = generateRecommendationEngineV1(input);
    return result.recommendations.slice(0, 3);
  } catch {
    return [];
  }
}

function computeDeckStats(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): { cards: number; avgCmc: number; archetype: string } {
  const entries = [...deck.boards.mainboard, ...deck.boards.commander];
  const cards = entries.reduce((s, e) => s + e.qty, 0);
  let totalCmc = 0;
  let nonlandCount = 0;
  for (const entry of entries) {
    const card = cardByName[normalizeKey(entry.name)];
    if (!card) continue;
    const type = (card.type_line || '').toLowerCase();
    if (!type.includes('land')) {
      totalCmc += (card.cmc || 0) * entry.qty;
      nonlandCount += entry.qty;
    }
  }
  const avgCmc = nonlandCount > 0 ? totalCmc / nonlandCount : 0;

  // Simple archetype heuristic
  let archetype = 'Midrange';
  if (avgCmc < 2.5) archetype = 'Aggro';
  else if (avgCmc > 3.5) archetype = 'Control';

  return { cards, avgCmc, archetype };
}

// ───── DOM Construction ─────

function createOverlay(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = 'optimizationWizardOverlay';
  overlay.className = 'optimization-wizard-overlay';

  overlay.innerHTML = `
    <div class="optimization-wizard">
      <div class="wizard-header">
        <h2 class="wizard-title">Deck Optimization</h2>
        <button class="wizard-close" aria-label="Close">&times;</button>
      </div>
      <div class="wizard-progress"></div>
      <div class="wizard-content"></div>
      <div class="wizard-actions"></div>
    </div>
  `;

  // Close button
  overlay.querySelector('.wizard-close')!.addEventListener('click', () => {
    closeOptimizationWizard();
  });

  // Click outside to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeOptimizationWizard();
  });

  return overlay;
}

function renderProgressBar(container: HTMLElement, currentStep: WizardStep): void {
  container.textContent = '';
  const currentIdx = STEPS.indexOf(currentStep);

  // Import is always "done" (step 0 before the wizard steps)
  const importStep = document.createElement('div');
  importStep.className = 'wizard-step wizard-step-done';
  importStep.innerHTML = `<span class="wizard-step-dot">&#10003;</span><span class="wizard-step-label">Import</span>`;
  container.appendChild(importStep);

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const el = document.createElement('div');
    let cls = 'wizard-step';
    if (i < currentIdx) cls += ' wizard-step-done';
    else if (i === currentIdx) cls += ' wizard-step-active';
    el.className = cls;

    const dot = document.createElement('span');
    dot.className = 'wizard-step-dot';
    dot.textContent = i < currentIdx ? '\u2713' : String(i + 2);

    const label = document.createElement('span');
    label.className = 'wizard-step-label';
    label.textContent = STEP_LABELS[step];

    el.append(dot, label);
    container.appendChild(el);

    // Connector line between steps (except after last)
    if (i < STEPS.length - 1) {
      const line = document.createElement('div');
      line.className = 'wizard-step-line' + (i < currentIdx ? ' wizard-step-line-done' : '');
      container.appendChild(line);
    }
  }
}

function renderStep(): void {
  if (!wizardState || !overlayEl) return;

  const wizard = overlayEl.querySelector('.optimization-wizard')!;
  const progressContainer = wizard.querySelector('.wizard-progress')!;
  const contentContainer = wizard.querySelector('.wizard-content')! as HTMLElement;
  const actionsContainer = wizard.querySelector('.wizard-actions')! as HTMLElement;

  renderProgressBar(progressContainer as HTMLElement, wizardState.step);
  contentContainer.textContent = '';
  actionsContainer.textContent = '';

  const stepIdx = STEPS.indexOf(wizardState.step);
  trackWizardStep(wizardState.step === 'moves' ? 'top_3_moves' : wizardState.step, stepIdx + 1);

  switch (wizardState.step) {
    case 'analyze':
      renderAnalyzeStep(contentContainer, actionsContainer);
      break;
    case 'moves':
      renderMovesStep(contentContainer, actionsContainer);
      break;
    case 'apply':
      renderApplyStep(contentContainer, actionsContainer);
      break;
    case 'export':
      renderExportStep(contentContainer, actionsContainer);
      break;
  }
}

function renderAnalyzeStep(content: HTMLElement, actions: HTMLElement): void {
  if (!wizardState) return;

  const deck = wizardState.callbacks.getDeck();
  const cardByName = wizardState.callbacks.getCardByName();
  if (!deck) return;

  const stats = computeDeckStats(deck, cardByName);
  wizardState.deckStats = stats;

  // Generate moves in the analyze step so they're ready
  wizardState.moves = generateMoves(deck, cardByName);

  trackFunnelStep('analyze', { cards: stats.cards, avgCmc: stats.avgCmc });

  const grid = document.createElement('div');
  grid.className = 'wizard-stats-grid';

  const statItems = [
    { label: 'Total Cards', value: String(stats.cards), icon: '\uD83C\uDCCF' },
    { label: 'Avg CMC', value: stats.avgCmc.toFixed(2), icon: '\uD83D\uDCA7' },
    { label: 'Archetype', value: stats.archetype, icon: '\uD83C\uDFAF' },
    { label: 'Optimizations Found', value: String(wizardState.moves.length), icon: '\u26A1' },
  ];

  for (const item of statItems) {
    const statEl = document.createElement('div');
    statEl.className = 'wizard-stat';
    statEl.innerHTML = `
      <span class="wizard-stat-icon">${item.icon}</span>
      <span class="wizard-stat-value">${item.value}</span>
      <span class="wizard-stat-label">${item.label}</span>
    `;
    grid.appendChild(statEl);
  }

  content.appendChild(grid);

  if (wizardState.moves.length === 0) {
    const noMoves = document.createElement('div');
    noMoves.className = 'wizard-no-moves';
    noMoves.textContent = 'Your deck looks well-optimized! No further moves suggested.';
    content.appendChild(noMoves);
  }

  // Action: Continue to Top 3 Moves
  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn primary wizard-btn-primary';
  nextBtn.textContent = wizardState.moves.length > 0 ? `View ${wizardState.moves.length} Moves` : 'Close';
  nextBtn.addEventListener('click', () => {
    if (wizardState && wizardState.moves.length > 0) {
      wizardState.step = 'moves';
      renderStep();
    } else {
      closeOptimizationWizard();
    }
  });
  actions.appendChild(nextBtn);

  const skipBtn = document.createElement('button');
  skipBtn.className = 'btn wizard-btn-ghost';
  skipBtn.textContent = 'Skip';
  skipBtn.addEventListener('click', () => closeOptimizationWizard());
  actions.appendChild(skipBtn);
}

function renderMovesStep(content: HTMLElement, actions: HTMLElement): void {
  if (!wizardState) return;

  trackFunnelStep('view_recs', { moveCount: wizardState.moves.length });

  const deck = wizardState.callbacks.getDeck();
  const cardByName = wizardState.callbacks.getCardByName();

  for (const move of wizardState.moves) {
    const isApplied = wizardState.applied.has(move.id);
    const card = document.createElement('div');
    card.className = `wizard-move-card${isApplied ? ' wizard-move-applied' : ''}`;

    // Chip
    const chipLabel = CATEGORY_LABELS[move.category] || move.category;
    const chipClass = CATEGORY_CLASSES[move.category] || 'wizard-chip-default';

    // Cut → Add
    const cutText = move.cut ? move.cut.name : '(add only)';
    const cutClass = move.cut ? 'wizard-move-cut' : 'wizard-move-cut muted';

    card.innerHTML = `
      <div class="wizard-move-header">
        <span class="wizard-move-chip ${chipClass}">${chipLabel}</span>
        <span class="wizard-move-confidence">${(move.confidence * 100).toFixed(0)}% confidence</span>
      </div>
      <div class="wizard-move-swap">
        <span class="${cutClass}">${cutText}</span>
        <span class="wizard-move-arrow">\u2192</span>
        <span class="wizard-move-add">${move.add.name}</span>
      </div>
      <div class="wizard-move-reason">${move.reasons[0] || ''}</div>
    `;

    // Diff preview (computed lazily)
    if (deck && cardByName) {
      try {
        const metrics = simulateSwap(deck, cardByName, move.cut?.name || null, move.add.name);
        const diffEl = renderCompactDiff(metrics);
        card.appendChild(diffEl);
      } catch { /* non-critical */ }
    }

    // Apply button
    const applyBtn = document.createElement('button');
    applyBtn.className = isApplied ? 'btn wizard-move-btn wizard-move-btn-applied' : 'btn primary wizard-move-btn';
    applyBtn.textContent = isApplied ? 'Applied \u2713' : 'Apply';
    applyBtn.disabled = isApplied;
    applyBtn.addEventListener('click', () => {
      if (!wizardState || wizardState.applied.has(move.id)) return;
      wizardState.applied.add(move.id);
      applyMoveViaCallbacks(wizardState.callbacks, move);
      trackRecInteraction('apply', move.id, 'wizard', { cutName: move.cut?.name, addName: move.add.name });
      renderStep(); // Re-render to show applied state
    });

    card.appendChild(applyBtn);
    content.appendChild(card);
  }

  // Actions
  const unapplied = wizardState.moves.filter((m) => !wizardState!.applied.has(m.id));

  if (unapplied.length > 0) {
    const applyAllBtn = document.createElement('button');
    applyAllBtn.className = 'btn primary wizard-btn-primary';
    applyAllBtn.textContent = `Apply All ${unapplied.length} Moves`;
    applyAllBtn.addEventListener('click', () => {
      if (!wizardState) return;
      for (const move of unapplied) {
        wizardState.applied.add(move.id);
        applyMoveViaCallbacks(wizardState.callbacks, move);
        trackRecInteraction('apply', move.id, 'wizard');
      }
      wizardState.step = 'apply';
      renderStep();
    });
    actions.appendChild(applyAllBtn);
  }

  if (wizardState.applied.size > 0) {
    const continueBtn = document.createElement('button');
    continueBtn.className = 'btn wizard-btn-primary';
    continueBtn.textContent = 'Continue';
    continueBtn.addEventListener('click', () => {
      if (!wizardState) return;
      wizardState.step = 'apply';
      renderStep();
    });
    actions.appendChild(continueBtn);
  }

  const skipBtn = document.createElement('button');
  skipBtn.className = 'btn wizard-btn-ghost';
  skipBtn.textContent = 'Skip';
  skipBtn.addEventListener('click', () => {
    if (!wizardState) return;
    wizardState.step = 'export';
    renderStep();
  });
  actions.appendChild(skipBtn);
}

function renderApplyStep(content: HTMLElement, actions: HTMLElement): void {
  if (!wizardState) return;

  const appliedCount = wizardState.applied.size;
  const totalCount = wizardState.moves.length;

  const summary = document.createElement('div');
  summary.className = 'wizard-apply-summary';

  if (appliedCount > 0) {
    summary.innerHTML = `
      <div class="wizard-apply-icon">\u2705</div>
      <h3 class="wizard-apply-title">${appliedCount} of ${totalCount} Moves Applied!</h3>
      <p class="wizard-apply-desc">Your deck has been updated. You can export it now or continue editing.</p>
    `;
  } else {
    summary.innerHTML = `
      <div class="wizard-apply-icon">\uD83D\uDCC4</div>
      <h3 class="wizard-apply-title">No Moves Applied</h3>
      <p class="wizard-apply-desc">You can export your deck as-is or go back to review the suggestions.</p>
    `;
  }

  content.appendChild(summary);

  // List applied moves
  if (appliedCount > 0) {
    const list = document.createElement('div');
    list.className = 'wizard-applied-list';
    for (const move of wizardState.moves) {
      if (!wizardState.applied.has(move.id)) continue;
      const row = document.createElement('div');
      row.className = 'wizard-applied-row';
      const cut = move.cut ? move.cut.name : '';
      row.textContent = cut ? `${cut} \u2192 ${move.add.name}` : `+ ${move.add.name}`;
      list.appendChild(row);
    }
    content.appendChild(list);
  }

  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn primary wizard-btn-primary';
  nextBtn.textContent = 'Export Deck';
  nextBtn.addEventListener('click', () => {
    if (!wizardState) return;
    wizardState.step = 'export';
    renderStep();
  });
  actions.appendChild(nextBtn);

  if (appliedCount === 0) {
    const backBtn = document.createElement('button');
    backBtn.className = 'btn wizard-btn-ghost';
    backBtn.textContent = 'Back to Moves';
    backBtn.addEventListener('click', () => {
      if (!wizardState) return;
      wizardState.step = 'moves';
      renderStep();
    });
    actions.appendChild(backBtn);
  }
}

function renderExportStep(content: HTMLElement, actions: HTMLElement): void {
  if (!wizardState) return;

  trackFunnelStep('export');
  trackWizardComplete(wizardState.applied.size, wizardState.moves.length);

  const exportInfo = document.createElement('div');
  exportInfo.className = 'wizard-export-info';
  exportInfo.innerHTML = `
    <div class="wizard-apply-icon">\uD83D\uDCE6</div>
    <h3 class="wizard-apply-title">Ready to Export</h3>
    <p class="wizard-apply-desc">Close this wizard and head to the <strong>Export</strong> tab to download your optimized deck in any format.</p>
  `;
  content.appendChild(exportInfo);

  // Quick action: switch to export tab
  const goExportBtn = document.createElement('button');
  goExportBtn.className = 'btn primary wizard-btn-primary';
  goExportBtn.textContent = 'Go to Export Tab';
  goExportBtn.addEventListener('click', () => {
    closeOptimizationWizard();
    // Switch to export tab
    const exportTabBtn = document.querySelector<HTMLButtonElement>('[data-tab="export"]');
    if (exportTabBtn) exportTabBtn.click();
  });
  actions.appendChild(goExportBtn);

  const doneBtn = document.createElement('button');
  doneBtn.className = 'btn wizard-btn-ghost';
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', () => closeOptimizationWizard());
  actions.appendChild(doneBtn);
}

// ───── Compact diff renderer ─────

function renderCompactDiff(metrics: WhatIfMetrics): HTMLElement {
  const container = document.createElement('div');
  container.className = 'wizard-move-diff';

  const items: Array<{ label: string; value: string; positive: boolean }> = [];

  // CMC change
  if (Math.abs(metrics.avgCmcDelta) >= 0.01) {
    const sign = metrics.avgCmcDelta > 0 ? '+' : '';
    items.push({
      label: 'CMC',
      value: `${sign}${metrics.avgCmcDelta.toFixed(2)}`,
      positive: metrics.avgCmcDelta < 0,
    });
  }

  // Bracket change
  if (metrics.bracketBefore !== metrics.bracketAfter) {
    items.push({
      label: 'Bracket',
      value: `${metrics.bracketBefore} \u2192 ${metrics.bracketAfter}`,
      positive: metrics.bracketAfter < metrics.bracketBefore,
    });
  }

  // Price change
  if (Math.abs(metrics.priceDeltaEur) >= 0.01) {
    const sign = metrics.priceDeltaEur > 0 ? '+' : '';
    items.push({
      label: 'Price',
      value: `${sign}\u20AC${metrics.priceDeltaEur.toFixed(2)}`,
      positive: metrics.priceDeltaEur < 0,
    });
  }

  // Significant fingerprint deltas
  for (const d of metrics.fingerprintDeltas.filter((fd) => Math.abs(fd.delta) >= 3)) {
    const sign = d.delta > 0 ? '+' : '';
    items.push({
      label: d.label,
      value: `${sign}${d.delta}`,
      positive: d.delta > 0,
    });
  }

  if (items.length === 0) return container;

  for (const item of items) {
    const el = document.createElement('span');
    el.className = `wizard-diff-item ${item.positive ? 'wizard-diff-positive' : 'wizard-diff-negative'}`;
    el.textContent = `${item.label}: ${item.value}`;
    container.appendChild(el);
  }

  return container;
}

// ───── Public API ─────

export function openOptimizationWizard(
  callbacks: WizardCallbacks,
  source: WizardSource = 'optimize_button',
): void {
  // Close existing wizard if open
  if (overlayEl) closeOptimizationWizard();

  const deck = callbacks.getDeck();
  if (!deck) return;

  trackWizardOpen(source, deck.boards.mainboard.reduce((s, e) => s + e.qty, 0));
  trackFunnelStep('import');

  wizardState = {
    step: 'analyze',
    moves: [],
    applied: new Set(),
    callbacks,
    deckStats: null,
  };

  overlayEl = createOverlay();
  document.body.appendChild(overlayEl);

  // Trigger entrance animation
  requestAnimationFrame(() => {
    if (overlayEl) overlayEl.classList.add('wizard-visible');
  });

  renderStep();

  // Escape to close
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeOptimizationWizard();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

export function closeOptimizationWizard(): void {
  if (overlayEl) {
    overlayEl.classList.remove('wizard-visible');
    // Wait for fade-out animation
    setTimeout(() => {
      if (overlayEl && overlayEl.parentNode) {
        overlayEl.parentNode.removeChild(overlayEl);
      }
      overlayEl = null;
    }, 200);
  }
  if (wizardState) {
    wizardState.callbacks.onComplete();
    wizardState = null;
  }
}
