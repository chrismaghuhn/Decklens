/**
 * Activation Funnel Tracking
 *
 * Structured wrapper around analytics events for the activation flow:
 * Import -> Analyze -> View Recs -> Apply Rec -> Export
 *
 * Tracks wizard lifecycle, funnel step progression, and recommendation interactions.
 */

import { trackAnalyticsEvent } from '../shared/analytics.js';

// ───── Types ─────

export type FunnelStep = 'import' | 'analyze' | 'view_recs' | 'apply_rec' | 'export';
export type WizardSource = 'import_auto' | 'optimize_button' | 'onboarding';
export type RecInteraction = 'view' | 'apply' | 'dismiss' | 'preview_diff' | 'distrust';

// ───── Session state ─────

let sessionFunnelSteps: FunnelStep[] = [];
let wizardSessionId: string | null = null;

function generateWizardSessionId(): string {
  return `wiz_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Reset funnel tracking for a new session (e.g. new deck load). */
export function resetFunnel(): void {
  sessionFunnelSteps = [];
  wizardSessionId = null;
}

// ───── Funnel Step Tracking ─────

/**
 * Track progression through the activation funnel.
 * Steps are deduplicated per session — calling the same step twice is a no-op.
 */
export function trackFunnelStep(step: FunnelStep, properties?: Record<string, unknown>): void {
  if (sessionFunnelSteps.includes(step)) return;
  sessionFunnelSteps.push(step);

  trackAnalyticsEvent('funnel_step', {
    step,
    stepIndex: sessionFunnelSteps.length,
    stepsCompleted: [...sessionFunnelSteps],
    ...properties,
  });
}

/** Get current funnel progress for display/debugging. */
export function getFunnelProgress(): { steps: FunnelStep[]; count: number } {
  return { steps: [...sessionFunnelSteps], count: sessionFunnelSteps.length };
}

// ───── Wizard Lifecycle ─────

/**
 * Track wizard open event.
 * Creates a new wizard session ID for correlating subsequent events.
 */
export function trackWizardOpen(source: WizardSource, deckCardCount?: number): void {
  wizardSessionId = generateWizardSessionId();

  trackAnalyticsEvent('wizard_opened', {
    source,
    wizardSessionId,
    deckCardCount: deckCardCount ?? 0,
  });
}

/**
 * Track wizard step navigation (within the wizard's own progress bar).
 */
export function trackWizardStep(
  stepName: 'import' | 'analyze' | 'top_3_moves' | 'apply' | 'export',
  stepIndex: number,
): void {
  trackAnalyticsEvent('wizard_step_reached', {
    stepName,
    stepIndex,
    wizardSessionId: wizardSessionId ?? 'unknown',
  });
}

/**
 * Track wizard completion (user reached end or applied moves).
 */
export function trackWizardComplete(movesApplied: number, totalMoves: number): void {
  trackAnalyticsEvent('wizard_completed', {
    movesApplied,
    totalMoves,
    applyRate: totalMoves > 0 ? movesApplied / totalMoves : 0,
    wizardSessionId: wizardSessionId ?? 'unknown',
    funnelStepsReached: sessionFunnelSteps.length,
  });

  // Also mark the apply step in the funnel if moves were applied
  if (movesApplied > 0) {
    trackFunnelStep('apply_rec', { source: 'wizard', count: movesApplied });
  }
}

// ───── Recommendation Interactions ─────

/**
 * Track interaction with a specific recommendation.
 * Works both in the wizard and in the Strategy tab's Smart Recs panel.
 */
export function trackRecInteraction(
  action: RecInteraction,
  recId: string,
  source: 'wizard' | 'strategy_tab' | 'edhrec',
  properties?: Record<string, unknown>,
): void {
  trackAnalyticsEvent('rec_interaction', {
    action,
    recId,
    source,
    wizardSessionId: wizardSessionId ?? null,
    ...properties,
  });
}

// ───── Convenience: track a recommendation apply from any source ─────

/**
 * Track a recommendation being applied (swap executed).
 * Automatically records the funnel step and rec interaction.
 */
export function trackRecApplied(
  recId: string,
  cutName: string | null,
  addName: string,
  source: 'wizard' | 'strategy_tab' | 'edhrec',
): void {
  trackRecInteraction('apply', recId, source, { cutName, addName });
  trackFunnelStep('apply_rec', { source, cutName, addName });
}
