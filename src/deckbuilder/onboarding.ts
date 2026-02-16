/**
 * First-Time User Onboarding
 * Spotlight tour that highlights key UI areas for new users.
 */

import { h } from '../shared/dom.js';
import { storageGet, storageSet } from '../shared/storage.js';

const ONBOARDING_KEY = 'decklens_deckbuilder_onboarding';

// ==================== Types ====================

interface OnboardingStep {
  targetSelector: string;
  title: string;
  text: string;
  position: 'top' | 'bottom' | 'left' | 'right';
}

// ==================== Steps ====================

const STEPS: OnboardingStep[] = [
  {
    targetSelector: '#searchInput',
    title: 'Search for Cards',
    text: 'Type a card name to search Scryfall and add cards to your deck. Press / to focus from anywhere.',
    position: 'bottom',
  },
  {
    targetSelector: '.board-nav',
    title: 'Board Navigation',
    text: 'Switch between Commander, Mainboard, Sideboard, and Maybeboard. Use keys 1\u20134 as shortcuts.',
    position: 'bottom',
  },
  {
    targetSelector: '#viewModeBar',
    title: 'View Modes & Sorting',
    text: 'View your deck as Grid, List, or sorted Piles. Use the sort dropdown and filter to find cards quickly.',
    position: 'bottom',
  },
  {
    targetSelector: '[data-tab="analytics"]',
    title: 'Analytics & Insights',
    text: 'Explore mana curve, color distribution, deck health score with actionable tips, and AI-powered card recommendations.',
    position: 'left',
  },
];

// ==================== State ====================

let currentStep = 0;
let overlayEl: HTMLElement | null = null;

// ==================== Public API ====================

export function shouldShowOnboarding(): boolean {
  return !storageGet<boolean>(ONBOARDING_KEY, false);
}

export function startOnboarding(): void {
  currentStep = 0;
  showStep();
}

// ==================== Internals ====================

function showStep(): void {
  if (overlayEl) overlayEl.remove();
  if (currentStep >= STEPS.length) {
    completeOnboarding();
    return;
  }

  const step = STEPS[currentStep];
  const target = document.querySelector(step.targetSelector) as HTMLElement | null;
  if (!target) {
    currentStep++;
    showStep();
    return;
  }

  const rect = target.getBoundingClientRect();

  // Build the tooltip
  const tooltip = h('div', {
    className: `onboarding-tooltip onboarding-tooltip--${step.position}`,
    onClick: (e: Event) => e.stopPropagation(),
  },
    h('div', { className: 'onboarding-tooltip__title' }, step.title),
    h('p', { className: 'onboarding-tooltip__text' }, step.text),
    h('div', { className: 'onboarding-tooltip__actions' },
      h('button', {
        className: 'btn',
        onClick: () => completeOnboarding(),
      }, 'Skip Tour'),
      h('span', { className: 'onboarding-tooltip__progress' },
        `${currentStep + 1} / ${STEPS.length}`,
      ),
      h('button', {
        className: 'btn primary',
        onClick: () => { currentStep++; showStep(); },
      }, currentStep < STEPS.length - 1 ? 'Next' : 'Done'),
    ),
  );

  // Build the spotlight cutout
  const spotlight = h('div', {
    className: 'onboarding-spotlight',
    style: `top:${rect.top - 6}px;left:${rect.left - 6}px;width:${rect.width + 12}px;height:${rect.height + 12}px;`,
  });

  // Build the overlay
  overlayEl = h('div', {
    className: 'onboarding-overlay',
    onClick: () => completeOnboarding(),
  }, spotlight);

  document.body.appendChild(overlayEl);

  // Position the tooltip relative to the target
  document.body.appendChild(tooltip);
  positionTooltip(tooltip, rect, step.position);

  // Store tooltip reference for cleanup
  overlayEl.dataset.tooltipId = 'yes';
  (overlayEl as HTMLElement & { _tooltip?: HTMLElement })._tooltip = tooltip;

  // Focus the Next/Done button for keyboard users
  const nextBtn = tooltip.querySelector('.btn.primary') as HTMLButtonElement | null;
  if (nextBtn) nextBtn.focus();

  // Escape to skip
  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', escHandler);
      completeOnboarding();
    }
  };
  document.addEventListener('keydown', escHandler);
}

function positionTooltip(tooltip: HTMLElement, rect: DOMRect, position: string): void {
  tooltip.style.position = 'fixed';
  tooltip.style.zIndex = '13001';

  switch (position) {
    case 'bottom':
      tooltip.style.top = `${rect.bottom + 16}px`;
      tooltip.style.left = `${Math.max(8, rect.left)}px`;
      break;
    case 'top':
      tooltip.style.bottom = `${window.innerHeight - rect.top + 16}px`;
      tooltip.style.left = `${Math.max(8, rect.left)}px`;
      break;
    case 'left':
      tooltip.style.top = `${rect.top}px`;
      tooltip.style.right = `${window.innerWidth - rect.left + 16}px`;
      break;
    case 'right':
      tooltip.style.top = `${rect.top}px`;
      tooltip.style.left = `${rect.right + 16}px`;
      break;
  }

  // Clamp to viewport
  requestAnimationFrame(() => {
    const tooltipRect = tooltip.getBoundingClientRect();
    if (tooltipRect.right > window.innerWidth - 8) {
      tooltip.style.left = `${window.innerWidth - tooltipRect.width - 8}px`;
      tooltip.style.right = '';
    }
    if (tooltipRect.bottom > window.innerHeight - 8) {
      tooltip.style.top = `${window.innerHeight - tooltipRect.height - 8}px`;
      tooltip.style.bottom = '';
    }
  });
}

function completeOnboarding(): void {
  if (overlayEl) {
    // Clean up tooltip
    const tooltip = (overlayEl as HTMLElement & { _tooltip?: HTMLElement })._tooltip;
    if (tooltip) tooltip.remove();
    overlayEl.remove();
    overlayEl = null;
  }
  // Also clean up any orphaned tooltips
  document.querySelectorAll('.onboarding-tooltip').forEach((el) => el.remove());
  storageSet(ONBOARDING_KEY, true);
}
