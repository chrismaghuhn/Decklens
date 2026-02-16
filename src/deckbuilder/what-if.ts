import type { DeckbuilderDeck, DeckbuilderCardEntry } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import { computeFingerprint } from './deck-fingerprint.js';
import { calculateBracket } from './bracket-calc.js';

export interface WhatIfMetrics {
  avgCmcBefore: number;
  avgCmcAfter: number;
  avgCmcDelta: number;
  bracketBefore: number;
  bracketAfter: number;
  priceDeltaEur: number;
  landCountBefore: number;
  landCountAfter: number;
  cardCountDelta: number;
  fingerprintDeltas: Array<{ label: string; before: number; after: number; delta: number }>;
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cloneDeck(deck: DeckbuilderDeck): DeckbuilderDeck {
  return {
    ...deck,
    boards: {
      commander: deck.boards.commander.map((e) => ({ ...e, tags: [...e.tags] })),
      mainboard: deck.boards.mainboard.map((e) => ({ ...e, tags: [...e.tags] })),
      sideboard: deck.boards.sideboard.map((e) => ({ ...e, tags: [...e.tags] })),
      maybeboard: deck.boards.maybeboard.map((e) => ({ ...e, tags: [...e.tags] })),
    },
  };
}

function computeAvgCmc(
  entries: DeckbuilderCardEntry[],
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): number {
  let totalCmc = 0;
  let count = 0;
  for (const entry of entries) {
    const card = cardByName[normalizeKey(entry.name)];
    if (!card) continue;
    const typeLine = (card.type_line || '').toLowerCase();
    if (!typeLine.includes('land')) {
      totalCmc += (card.cmc || 0) * entry.qty;
      count += entry.qty;
    }
  }
  return count > 0 ? totalCmc / count : 0;
}

function countLands(
  entries: DeckbuilderCardEntry[],
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): number {
  let count = 0;
  for (const entry of entries) {
    const card = cardByName[normalizeKey(entry.name)];
    if (card && (card.type_line || '').toLowerCase().includes('land')) {
      count += entry.qty;
    }
  }
  return count;
}

function getCardPriceEur(cardByName: Record<string, DeckbuilderSearchCard | undefined>, name: string): number {
  const card = cardByName[normalizeKey(name)];
  if (!card?.prices) return 0;
  const eur = card.prices.eur;
  return eur ? parseFloat(eur) || 0 : 0;
}

export function simulateSwap(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  cutName: string | null,
  addName: string,
): WhatIfMetrics {
  const before = deck;
  const after = cloneDeck(deck);

  // Apply the swap to the clone
  if (cutName) {
    const idx = after.boards.mainboard.findIndex(
      (e) => normalizeKey(e.name) === normalizeKey(cutName),
    );
    if (idx >= 0) {
      if (after.boards.mainboard[idx].qty > 1) {
        after.boards.mainboard[idx].qty--;
      } else {
        after.boards.mainboard.splice(idx, 1);
      }
    }
  }

  // Add the new card
  const existingIdx = after.boards.mainboard.findIndex(
    (e) => normalizeKey(e.name) === normalizeKey(addName),
  );
  if (existingIdx >= 0) {
    after.boards.mainboard[existingIdx].qty++;
  } else {
    after.boards.mainboard.push({
      name: addName,
      qty: 1,
      set: null,
      collectorNumber: null,
      tags: [],
    });
  }

  // Compute metrics
  const allBefore = [...before.boards.mainboard, ...before.boards.commander];
  const allAfter = [...after.boards.mainboard, ...after.boards.commander];

  const avgCmcBefore = computeAvgCmc(allBefore, cardByName);
  const avgCmcAfter = computeAvgCmc(allAfter, cardByName);

  const bracketBefore = calculateBracket(before, cardByName).bracket;
  const bracketAfter = calculateBracket(after, cardByName).bracket;

  const cutPrice = cutName ? getCardPriceEur(cardByName, cutName) : 0;
  const addPrice = getCardPriceEur(cardByName, addName);
  const priceDeltaEur = addPrice - cutPrice;

  const landCountBefore = countLands(allBefore, cardByName);
  const landCountAfter = countLands(allAfter, cardByName);

  const totalBefore = allBefore.reduce((s, e) => s + e.qty, 0);
  const totalAfter = allAfter.reduce((s, e) => s + e.qty, 0);

  // Fingerprint comparison
  const fpBefore = computeFingerprint(before, cardByName);
  const fpAfter = computeFingerprint(after, cardByName);
  const fingerprintDeltas = fpBefore.map((axis, i) => ({
    label: axis.label,
    before: axis.value,
    after: fpAfter[i]?.value ?? axis.value,
    delta: (fpAfter[i]?.value ?? axis.value) - axis.value,
  }));

  return {
    avgCmcBefore,
    avgCmcAfter,
    avgCmcDelta: avgCmcAfter - avgCmcBefore,
    bracketBefore,
    bracketAfter,
    priceDeltaEur,
    landCountBefore,
    landCountAfter,
    cardCountDelta: totalAfter - totalBefore,
    fingerprintDeltas,
  };
}

export function renderWhatIfPreview(container: HTMLElement, metrics: WhatIfMetrics): void {
  container.textContent = '';

  const rows: Array<{ label: string; value: string; color: string }> = [];

  // CMC delta
  const cmcSign = metrics.avgCmcDelta > 0 ? '+' : '';
  const cmcColor = metrics.avgCmcDelta < -0.05 ? '#34d399' : metrics.avgCmcDelta > 0.05 ? '#f59e0b' : 'var(--text-dim)';
  rows.push({
    label: 'Avg CMC',
    value: `${metrics.avgCmcBefore.toFixed(2)} → ${metrics.avgCmcAfter.toFixed(2)} (${cmcSign}${metrics.avgCmcDelta.toFixed(2)})`,
    color: cmcColor,
  });

  // Bracket delta
  if (metrics.bracketBefore !== metrics.bracketAfter) {
    const bracketColor = metrics.bracketAfter > metrics.bracketBefore ? '#ef4444' : '#34d399';
    rows.push({
      label: 'Bracket',
      value: `${metrics.bracketBefore} → ${metrics.bracketAfter}`,
      color: bracketColor,
    });
  }

  // Price delta
  if (Math.abs(metrics.priceDeltaEur) >= 0.01) {
    const priceSign = metrics.priceDeltaEur > 0 ? '+' : '';
    const priceColor = metrics.priceDeltaEur > 0 ? '#f59e0b' : '#34d399';
    rows.push({
      label: 'Price',
      value: `${priceSign}€${metrics.priceDeltaEur.toFixed(2)}`,
      color: priceColor,
    });
  }

  // Fingerprint changes (only show significant deltas)
  const sigDeltas = metrics.fingerprintDeltas.filter((d) => Math.abs(d.delta) >= 3);
  for (const d of sigDeltas) {
    const sign = d.delta > 0 ? '+' : '';
    const color = d.delta > 0 ? '#34d399' : '#f59e0b';
    rows.push({
      label: d.label,
      value: `${d.before} → ${d.after} (${sign}${d.delta})`,
      color,
    });
  }

  if (rows.length === 0) {
    const noChange = document.createElement('div');
    noChange.className = 'muted';
    noChange.style.fontSize = '0.72rem';
    noChange.textContent = 'No significant metric changes';
    container.appendChild(noChange);
    return;
  }

  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'whatif-row';

    const lbl = document.createElement('span');
    lbl.className = 'whatif-label';
    lbl.textContent = row.label;

    const val = document.createElement('span');
    val.className = 'whatif-value';
    val.style.color = row.color;
    val.textContent = row.value;

    el.append(lbl, val);
    container.appendChild(el);
  }
}
