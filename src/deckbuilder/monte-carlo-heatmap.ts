// ============================================================
// Monte-Carlo Heatmap — Card draw probability simulation
// ============================================================
// Simulate 10,000 hands to generate a heatmap of card draw
// probabilities by turn. Uses the deck's card distribution.
// ============================================================

import { h } from '../shared/dom.js';
import type { DeckbuilderCardEntry } from './types.js';

// ==================== Types ====================

export interface SimulationConfig {
  iterations: number;       // default 10000
  startingHandSize: number; // default 7
  maxTurns: number;         // default 10
}

export interface SimulationResult {
  cardName: string;
  qty: number;
  /** Probability of drawing at least 1 copy by turn N (0-1) */
  probabilityByTurn: number[];
  /** Average number of copies drawn by turn N */
  avgCopiesByTurn: number[];
}

export interface HeatmapData {
  results: SimulationResult[];
  config: SimulationConfig;
  totalCards: number;
}

// ==================== Simulation ====================

/**
 * Run Monte-Carlo simulation on a deck.
 */
export function runMonteCarlo(
  cards: DeckbuilderCardEntry[],
  config: Partial<SimulationConfig> = {}
): HeatmapData {
  const cfg: SimulationConfig = {
    iterations: config.iterations ?? 10000,
    startingHandSize: config.startingHandSize ?? 7,
    maxTurns: config.maxTurns ?? 10,
  };

  // Build the deck as an array of indices (for fast shuffling)
  const deckSize = cards.reduce((sum, c) => sum + c.qty, 0);
  const deck: number[] = [];
  const cardNames: string[] = [];
  const cardQtys: number[] = [];

  for (let i = 0; i < cards.length; i++) {
    cardNames.push(cards[i].name);
    cardQtys.push(cards[i].qty);
    for (let q = 0; q < cards[i].qty; q++) {
      deck.push(i);
    }
  }

  // Per-card tracking
  const totalDrawsByTurn: number[][] = cards.map(() =>
    new Array(cfg.maxTurns + 1).fill(0)
  );
  const atLeastOneByTurn: number[][] = cards.map(() =>
    new Array(cfg.maxTurns + 1).fill(0)
  );

  // Run simulations
  for (let iter = 0; iter < cfg.iterations; iter++) {
    // Shuffle deck (Fisher-Yates)
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Track draws per card
    const cardDrawCounts = new Array(cards.length).fill(0);

    // Draw opening hand + each turn
    const totalDraws = Math.min(
      cfg.startingHandSize + cfg.maxTurns,
      shuffled.length
    );

    for (let drawIdx = 0; drawIdx < totalDraws; drawIdx++) {
      const cardIdx = shuffled[drawIdx];
      cardDrawCounts[cardIdx]++;

      // Determine which turn this draw belongs to
      let turn: number;
      if (drawIdx < cfg.startingHandSize) {
        turn = 0; // opening hand
      } else {
        turn = drawIdx - cfg.startingHandSize + 1;
      }

      if (turn <= cfg.maxTurns) {
        // Record cumulative draws for all subsequent turns
        for (let t = turn; t <= cfg.maxTurns; t++) {
          totalDrawsByTurn[cardIdx][t]++;
        }
      }
    }

    // Record "at least one" for each turn
    for (let cardIdx = 0; cardIdx < cards.length; cardIdx++) {
      let drawn = 0;
      for (let drawIdx = 0; drawIdx < totalDraws; drawIdx++) {
        if (shuffled[drawIdx] === cardIdx) drawn++;
        const turn = drawIdx < cfg.startingHandSize ? 0 : drawIdx - cfg.startingHandSize + 1;
        if (turn <= cfg.maxTurns && drawn > 0) {
          atLeastOneByTurn[cardIdx][turn]++;
        }
      }
    }
  }

  // Compute results
  const results: SimulationResult[] = cards.map((card, i) => ({
    cardName: card.name,
    qty: card.qty,
    probabilityByTurn: atLeastOneByTurn[i].map(count => count / cfg.iterations),
    avgCopiesByTurn: totalDrawsByTurn[i].map(count => count / cfg.iterations),
  }));

  // Sort by opening hand probability (descending)
  results.sort((a, b) => b.probabilityByTurn[0] - a.probabilityByTurn[0]);

  return { results, config: cfg, totalCards: deckSize };
}

// ==================== Heatmap Rendering ====================

/**
 * Render the heatmap as a table element.
 */
export function renderHeatmap(data: HeatmapData, maxCards = 30): HTMLElement {
  const table = document.createElement('table');
  table.className = 'monte-carlo-heatmap';

  // Header row: Turn 0 (hand), Turn 1, Turn 2, ...
  const headerRow = document.createElement('tr');
  headerRow.appendChild(h('th', { className: 'mc-heatmap__card-col' }, 'Card'));
  headerRow.appendChild(h('th', { className: 'mc-heatmap__qty-col' }, 'Qty'));
  headerRow.appendChild(h('th', {}, 'Hand'));
  for (let t = 1; t <= data.config.maxTurns; t++) {
    headerRow.appendChild(h('th', {}, `T${t}`));
  }
  table.appendChild(headerRow);

  // Data rows (limited to maxCards for performance)
  const displayResults = data.results.slice(0, maxCards);

  for (const result of displayResults) {
    const row = document.createElement('tr');

    row.appendChild(h('td', { className: 'mc-heatmap__card-name' },
      result.cardName.length > 25
        ? result.cardName.slice(0, 23) + '...'
        : result.cardName
    ));
    row.appendChild(h('td', { className: 'mc-heatmap__qty' }, String(result.qty)));

    for (let t = 0; t <= data.config.maxTurns; t++) {
      const prob = result.probabilityByTurn[t];
      const cell = h('td', {
        className: 'mc-heatmap__cell',
        style: `background-color: ${getHeatColor(prob)}`,
        title: `${(prob * 100).toFixed(1)}% chance by turn ${t}`,
      }, `${Math.round(prob * 100)}`);
      row.appendChild(cell);
    }

    table.appendChild(row);
  }

  // Wrapper with legend
  const wrapper = h('div', { className: 'monte-carlo-wrapper' },
    h('div', { className: 'mc-heatmap__info' },
      `${data.config.iterations.toLocaleString()} simulations | ${data.totalCards} cards in deck`
    ),
    table,
    data.results.length > maxCards
      ? h('div', { className: 'mc-heatmap__more' },
          `Showing top ${maxCards} of ${data.results.length} cards`
        )
      : null,
    renderLegend(),
  );

  return wrapper;
}

function getHeatColor(probability: number): string {
  // Green (high prob) → Yellow → Red (low prob)
  if (probability >= 0.8) return 'rgba(52, 211, 153, 0.6)';  // green
  if (probability >= 0.6) return 'rgba(251, 191, 36, 0.5)';   // yellow
  if (probability >= 0.4) return 'rgba(251, 146, 60, 0.4)';   // orange
  if (probability >= 0.2) return 'rgba(248, 113, 113, 0.3)';  // red
  if (probability >= 0.1) return 'rgba(248, 113, 113, 0.15)'; // light red
  return 'transparent';
}

function renderLegend(): HTMLElement {
  return h('div', { className: 'mc-heatmap__legend' },
    h('span', {}, 'Probability: '),
    h('span', { style: 'background-color: rgba(52, 211, 153, 0.6); padding: 2px 8px;' }, '80%+'),
    h('span', { style: 'background-color: rgba(251, 191, 36, 0.5); padding: 2px 8px;' }, '60%+'),
    h('span', { style: 'background-color: rgba(251, 146, 60, 0.4); padding: 2px 8px;' }, '40%+'),
    h('span', { style: 'background-color: rgba(248, 113, 113, 0.3); padding: 2px 8px;' }, '20%+'),
  );
}

// ==================== Hypergeometric Comparison ====================

/**
 * Exact hypergeometric probability for comparison.
 * P(X >= 1) = 1 - C(N-K, n) / C(N, n)
 */
export function hypergeometric(
  deckSize: number,
  copies: number,
  drawn: number
): number {
  // P(at least 1 copy in drawn cards)
  // = 1 - C(deckSize - copies, drawn) / C(deckSize, drawn)
  let p = 1;
  for (let i = 0; i < drawn; i++) {
    p *= (deckSize - copies - i) / (deckSize - i);
  }
  return 1 - p;
}
