/**
 * Goldfish Coach Widget — Renders live hints from the Coach Engine.
 *
 * Displays combo progress, sequencing tips, and mulligan advice
 * during goldfish playtesting in a clean, actionable format.
 */

import { h } from '../shared/dom.js';
import type { DeckCoach, CoachHint } from './goldfish-coach.js';
import { lineIcon } from './line-icons.js';

/**
 * Render the coach widget into the target container.
 * Called whenever the coach state changes (hints updated).
 */
export function renderCoachWidget(container: HTMLElement, coach: DeckCoach | null): void {
  container.textContent = '';

  if (!coach || !coach.enabled) {
    container.appendChild(h('div', { className: 'coach-widget-disabled' },
      h('p', {}, 'Coach is disabled.'),
      h('p', { className: 'coach-hint' }, 'Enable it in the playtest settings.'),
    ));
    return;
  }

  const hints = coach.activeHints;

  if (hints.length === 0) {
    container.appendChild(h('div', { className: 'coach-widget-empty' },
 h('p', {}, ' No hints right now.'),
      h('p', { className: 'coach-hint' }, 'Keep playing, I\'ll chime in when I spot something!'),
    ));
    return;
  }

  // Header with mode indicator
  const header = h('div', { className: 'coach-widget-header' },
    lineIcon('coach', 'coach-icon'),
    h('span', { className: 'coach-title' }, 'Coach'),
    h('span', { className: 'coach-mode-badge' }, coach.level === 'beginner' ? 'Beginner' : 'Advanced'),
  );

  // Render each hint
  const hintElements = hints.map((hint) => renderHintCard(hint));

  const body = h('div', { className: 'coach-widget-body' }, ...hintElements);

  container.appendChild(header);
  container.appendChild(body);
}

function renderHintCard(hint: CoachHint): HTMLElement {
  const card = h('div', {
    className: `coach-hint-card coach-hint-card--${hint.category}`,
    'data-priority': hint.priority,
  });

  // Icon + Short Text
  const headerRow = h('div', { className: 'coach-hint-header' },
    h('span', { className: 'coach-hint-icon' }, hint.icon),
    h('span', { className: 'coach-hint-short' }, hint.shortText),
  );

  // Expanded Text (collapsible)
  const expandBtn = h('button', {
    className: 'coach-hint-expand-btn',
    type: 'button',
    onClick: () => {
      detailsRow.classList.toggle('coach-hint-details--visible');
      expandBtn.textContent = detailsRow.classList.contains('coach-hint-details--visible') ? '▲' : '▼';
    },
  }, '▼');

  const detailsRow = h('div', { className: 'coach-hint-details' },
    h('p', {}, hint.expandedText),
  );

  // Highlight cards if any
  if (hint.highlightCards && hint.highlightCards.length > 0) {
    const cardsList = h('div', { className: 'coach-hint-cards' },
      ...hint.highlightCards.map((name) => h('span', { className: 'coach-card-badge' }, name)),
    );
    detailsRow.appendChild(cardsList);
  }

  card.appendChild(headerRow);
  card.appendChild(expandBtn);
  card.appendChild(detailsRow);

  return card;
}
