/**
 * Draw Probability Calculator
 * Uses hypergeometric distribution to calculate odds of drawing
 * specific card categories in opening hands and by turn N.
 */

import { h, replaceChildren } from '../shared/dom.js';
import type { DeckbuilderCardEntry } from './types.js';

// ==================== Math ====================

/** Binomial coefficient C(n, k) */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  if (k > n - k) k = n - k;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = result * (n - i) / (i + 1);
  }
  return result;
}

/**
 * Hypergeometric probability: P(X = x)
 * N = population (deck size), K = successes in population, n = draws, x = successes drawn
 */
function hypergeometricExact(N: number, K: number, n: number, x: number): number {
  return (choose(K, x) * choose(N - K, n - x)) / choose(N, n);
}

/**
 * P(X >= atLeast) — probability of drawing at least `atLeast` successes
 */
export function hypergeometricAtLeast(deckSize: number, copies: number, draws: number, atLeast: number = 1): number {
  if (copies <= 0 || draws <= 0 || deckSize <= 0) return 0;
  if (copies >= deckSize) return 1;
  if (draws > deckSize) draws = deckSize;
  if (atLeast > Math.min(copies, draws)) return 0;

  let pLessThan = 0;
  for (let i = 0; i < atLeast; i++) {
    pLessThan += hypergeometricExact(deckSize, copies, draws, i);
  }
  return Math.max(0, Math.min(1, 1 - pLessThan));
}

// ==================== Sparkline ====================

function renderProbSparkline(deckSize: number, copies: number, maxTurn: number = 10): HTMLElement {
  const HAND = 7;
  const W = 200;
  const H = 40;
  const padL = 0;
  const padR = 0;
  const padT = 4;
  const padB = 12;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const points: Array<{ t: number; p: number }> = [];
  for (let t = 0; t <= maxTurn; t++) {
    const draws = Math.min(HAND + t, deckSize);
    const p = hypergeometricAtLeast(deckSize, copies, draws);
    points.push({ t, p });
  }

  // Build SVG polyline
  const polyPoints = points
    .map((pt) => {
      const x = padL + (pt.t / maxTurn) * plotW;
      const y = padT + (1 - pt.p) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'prob-sparkline');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));

  // Filled area under curve
  const firstX = padL;
  const lastX = padL + plotW;
  const baseY = padT + plotH;
  const areaPath = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  areaPath.setAttribute('points', `${firstX},${baseY} ${polyPoints} ${lastX},${baseY}`);
  areaPath.setAttribute('fill', 'rgba(201,168,76,0.12)');
  svg.appendChild(areaPath);

  // Line
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', polyPoints);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#c9a84c');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(line);

  // Turn labels
  for (const t of [0, 5, maxTurn]) {
    const x = padL + (t / maxTurn) * plotW;
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(H - 1));
    label.setAttribute('font-size', '7');
    label.setAttribute('fill', '#888');
    label.setAttribute('text-anchor', t === 0 ? 'start' : t === maxTurn ? 'end' : 'middle');
    label.textContent = `T${t}`;
    svg.appendChild(label);
  }

  // Probability dots at start/end
  for (const pt of [points[0], points[points.length - 1]]) {
    const cx = padL + (pt.t / maxTurn) * plotW;
    const cy = padT + (1 - pt.p) * plotH;
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', '2.5');
    dot.setAttribute('fill', '#c9a84c');
    svg.appendChild(dot);
  }

  return svg;
}

// ==================== Joint Probability ====================

/**
 * P(at least 1 from A AND at least 1 from B) using inclusion-exclusion.
 * P(A∩B) = 1 - P(¬A) - P(¬B) + P(¬A ∩ ¬B)
 * P(¬A ∩ ¬B) = C(N-Ka-Kb, n) / C(N, n) when Ka+Kb <= N and they don't overlap.
 * For overlapping categories we cap the denominator.
 */
function jointProbability(
  deckSize: number,
  copiesA: number,
  copiesB: number,
  draws: number,
): number {
  if (deckSize <= 0 || draws <= 0) return 0;
  const pNotA = hypergeometricExact(deckSize, copiesA, Math.min(draws, deckSize), 0);
  const pNotB = hypergeometricExact(deckSize, copiesB, Math.min(draws, deckSize), 0);

  // P(neither A nor B) — assumes categories don't overlap
  const nonAB = Math.max(0, deckSize - copiesA - copiesB);
  const pNeither = choose(nonAB, Math.min(draws, nonAB)) / choose(deckSize, Math.min(draws, deckSize));

  return Math.max(0, Math.min(1, 1 - pNotA - pNotB + pNeither));
}

// ==================== Render ====================

interface ProbabilityPreset {
  label: string;
  count: number;
  color: string;
}

function probColor(p: number): string {
  if (p >= 0.7) return '#34d399';
  if (p >= 0.4) return '#e8c84a';
  return '#ef4444';
}

function renderProbBar(label: string, probability: number, color?: string): HTMLElement {
  const pct = Math.round(probability * 100);
  const fillColor = color || probColor(probability);

  return h('div', { className: 'prob-row' },
    h('span', { className: 'prob-label' }, label),
    h('div', { className: 'prob-bar' },
      h('div', {
        className: 'prob-bar-fill',
        style: `width:${pct}%;background:${fillColor};`,
      }),
    ),
    h('span', { className: 'prob-pct' }, `${pct}%`),
  );
}

/**
 * Render draw probability panel into container.
 * @param container Target element
 * @param tags Tag distribution from computeAnalyticsData() (e.g. { Land: 37, Ramp: 10, ... })
 * @param deckSize Total cards in deck
 */
export function renderDrawProbability(
  container: HTMLElement,
  tags: Record<string, number>,
  deckSize: number,
  deckEntries?: DeckbuilderCardEntry[],
): void {
  if (deckSize === 0) {
    replaceChildren(container, h('span', { className: 'muted', style: 'font-size:0.78rem;' }, 'Add cards to see draw probabilities.'));
    return;
  }

  const OPENING_HAND = 7;

  // Build auto-presets from tag data
  const presets: ProbabilityPreset[] = [];

  // Land count
  const landCount = tags['Land'] || 0;
  if (landCount > 0) presets.push({ label: '≥1 Land', count: landCount, color: '#a3e635' });

  // Ramp
  const rampCount = tags['Ramp'] || 0;
  if (rampCount > 0) presets.push({ label: '≥1 Ramp', count: rampCount, color: '#34d399' });

  // Draw
  const drawCount = tags['Draw'] || 0;
  if (drawCount > 0) presets.push({ label: '≥1 Card Draw', count: drawCount, color: '#60a5fa' });

  // Removal
  const removalCount = (tags['Removal'] || 0) + (tags['Board Wipe'] || 0);
  if (removalCount > 0) presets.push({ label: '≥1 Removal', count: removalCount, color: '#f87171' });

  // Counter
  const counterCount = tags['Counter'] || 0;
  if (counterCount > 0) presets.push({ label: '≥1 Counter', count: counterCount, color: '#818cf8' });

  // Protection
  const protCount = tags['Protection'] || 0;
  if (protCount > 0) presets.push({ label: '≥1 Protection', count: protCount, color: '#fbbf24' });

  // Preset bars
  const presetBars = presets.map((p) => {
    const prob = hypergeometricAtLeast(deckSize, p.count, OPENING_HAND);
    return renderProbBar(`${p.label} (${p.count} in deck)`, prob, p.color);
  });

  // 2-land and 3-land probabilities
  if (landCount > 0) {
    const prob2 = hypergeometricAtLeast(deckSize, landCount, OPENING_HAND, 2);
    const prob3 = hypergeometricAtLeast(deckSize, landCount, OPENING_HAND, 3);
    presetBars.push(renderProbBar(`≥2 Lands (${landCount} in deck)`, prob2, '#a3e635'));
    presetBars.push(renderProbBar(`≥3 Lands (${landCount} in deck)`, prob3, '#a3e635'));
  }

  // Custom calculator
  const customCopiesInput = h('input', {
    type: 'number',
    min: '1',
    max: String(deckSize),
    value: '4',
    className: 'prob-input',
    id: 'probCustomCopies',
  }) as HTMLInputElement;

  const customTurnInput = h('input', {
    type: 'number',
    min: '0',
    max: '15',
    value: '3',
    className: 'prob-input',
    id: 'probCustomTurn',
  }) as HTMLInputElement;

  const customResult = h('div', { id: 'probCustomResult', className: 'prob-custom-result' });
  const sparklineContainer = h('div', { className: 'prob-sparkline-wrap' });

  function updateCustom(): void {
    const copies = Math.max(1, Math.min(deckSize, parseInt(customCopiesInput.value) || 1));
    const turn = Math.max(0, Math.min(15, parseInt(customTurnInput.value) || 0));
    const draws = OPENING_HAND + turn; // opening hand + draw steps
    const prob = hypergeometricAtLeast(deckSize, copies, draws);
    replaceChildren(customResult, renderProbBar(`By turn ${turn}`, prob));
    // Update sparkline
    replaceChildren(sparklineContainer, renderProbSparkline(deckSize, copies, 10));
  }

  customCopiesInput.addEventListener('input', updateCustom);
  customTurnInput.addEventListener('input', updateCustom);

  // ── Joint probability section ──
  const tagKeys = Object.keys(tags).filter((k) => tags[k] > 0);
  const jointResult = h('div', { className: 'prob-custom-result' });

  const jointSelectA = h('select', { className: 'prob-input prob-joint-select' }) as HTMLSelectElement;
  const jointSelectB = h('select', { className: 'prob-input prob-joint-select' }) as HTMLSelectElement;

  for (const sel of [jointSelectA, jointSelectB]) {
    const defaultOpt = h('option', { value: '' }, '— select —') as HTMLOptionElement;
    sel.appendChild(defaultOpt);
    for (const key of tagKeys) {
      const opt = h('option', { value: key }, `${key} (${tags[key]})`) as HTMLOptionElement;
      sel.appendChild(opt);
    }
  }
  // Default selections
  if (tagKeys.includes('Land')) jointSelectA.value = 'Land';
  if (tagKeys.includes('Ramp')) jointSelectB.value = 'Ramp';
  else if (tagKeys.includes('Draw')) jointSelectB.value = 'Draw';

  function updateJoint(): void {
    const keyA = jointSelectA.value;
    const keyB = jointSelectB.value;
    if (!keyA || !keyB || keyA === keyB) {
      replaceChildren(jointResult,
        h('span', { className: 'muted', style: 'font-size:0.72rem;' }, 'Select two different categories.'),
      );
      return;
    }
    const copiesA = tags[keyA] || 0;
    const copiesB = tags[keyB] || 0;
    const prob = jointProbability(deckSize, copiesA, copiesB, OPENING_HAND);
    replaceChildren(jointResult,
      renderProbBar(`≥1 ${keyA} AND ≥1 ${keyB}`, prob),
    );
  }

  jointSelectA.addEventListener('change', updateJoint);
  jointSelectB.addEventListener('change', updateJoint);

  // Build joint section conditionally (need at least 2 tags)
  const jointSection = tagKeys.length >= 2
    ? h('div', { className: 'prob-section', style: 'margin-top:14px;' },
        h('h5', { className: 'prob-section-title' }, 'Joint Probability'),
        h('div', { className: 'prob-custom-row' },
          h('label', { className: 'prob-custom-label' }, 'Category A:'),
          jointSelectA,
        ),
        h('div', { className: 'prob-custom-row' },
          h('label', { className: 'prob-custom-label' }, 'Category B:'),
          jointSelectB,
        ),
        jointResult,
      )
    : null;

  const sections: HTMLElement[] = [
    h('div', { className: 'prob-section' },
      h('h5', { className: 'prob-section-title' }, 'Opening Hand (7 cards)'),
      ...presetBars,
    ),
    h('div', { className: 'prob-section', style: 'margin-top:14px;' },
      h('h5', { className: 'prob-section-title' }, 'Custom Query'),
      h('div', { className: 'prob-custom-row' },
        h('label', { className: 'prob-custom-label' }, 'Copies in deck:'),
        customCopiesInput,
      ),
      h('div', { className: 'prob-custom-row' },
        h('label', { className: 'prob-custom-label' }, 'By turn:'),
        customTurnInput,
      ),
      customResult,
      sparklineContainer,
    ),
  ];

  if (jointSection) sections.push(jointSection);

  // ── Card-specific probability ──
  if (deckEntries && deckEntries.length > 0) {
    const cardInput = h('input', {
      type: 'text',
      placeholder: 'Type a card name...',
      className: 'prob-input',
      style: 'width:180px;',
    }) as HTMLInputElement;
    const cardTurnInput = h('input', {
      type: 'number',
      min: '0', max: '15', value: '3',
      className: 'prob-input',
    }) as HTMLInputElement;
    const cardResult = h('div', { className: 'prob-custom-result' });
    const cardSparkline = h('div', { className: 'prob-sparkline-wrap' });

    function updateCardProb(): void {
      const query = cardInput.value.trim().toLowerCase();
      if (!query || !deckEntries) {
        replaceChildren(cardResult);
        replaceChildren(cardSparkline);
        return;
      }
      const match = deckEntries.find((e) => e.name.toLowerCase().includes(query));
      if (!match) {
        replaceChildren(cardResult, h('span', { className: 'muted', style: 'font-size:0.72rem;' }, 'No match found.'));
        replaceChildren(cardSparkline);
        return;
      }
      const turn = Math.max(0, Math.min(15, parseInt(cardTurnInput.value) || 0));
      const draws = OPENING_HAND + turn;
      const prob = hypergeometricAtLeast(deckSize, match.qty, draws);
      replaceChildren(cardResult, renderProbBar(`${match.name} (${match.qty}×) by T${turn}`, prob));
      replaceChildren(cardSparkline, renderProbSparkline(deckSize, match.qty, 10));
    }

    cardInput.addEventListener('input', updateCardProb);
    cardTurnInput.addEventListener('input', updateCardProb);

    sections.push(
      h('div', { className: 'prob-section', style: 'margin-top:14px;' },
        h('h5', { className: 'prob-section-title' }, 'Specific Card'),
        h('div', { className: 'prob-custom-row' },
          h('label', { className: 'prob-custom-label' }, 'Card name:'),
          cardInput,
        ),
        h('div', { className: 'prob-custom-row' },
          h('label', { className: 'prob-custom-label' }, 'By turn:'),
          cardTurnInput,
        ),
        cardResult,
        cardSparkline,
      ),
    );
  }

  replaceChildren(container, ...sections);

  // Initial render of custom + joint
  updateCustom();
  if (tagKeys.length >= 2) updateJoint();
}
