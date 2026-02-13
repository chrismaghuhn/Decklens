import type { DeckbuilderDeck, DeckbuilderCardEntry, AnalyzerCardView } from './types';
import { analyzeDeckDNA, calculateSaltAnalysis } from './analyzers';

export interface PowerFactor { label: string; value: number; detail: string; }

function normalizeNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

// We need a way to look up card details. In the new app, this will likely be a map or a fetch function.
// For now, let's assume we pass a card resolver map.
export type CardResolverMap = Record<string, AnalyzerCardView | undefined>;

export function estimatePowerLevel(deck: DeckbuilderDeck, resolvedCardByName: CardResolverMap): {
  power: number; bracket: number; dominant: string; salt: number; saltLabel: string;
  factors: PowerFactor[]; avgCmc: number; tutorCount: number;
} {
  const entries = deck.boards.mainboard.map((e) => ({ name: e.name, qty: e.qty }));
  
  const resolver = (name: string): AnalyzerCardView | undefined => {
    return resolvedCardByName[normalizeNameKey(name)];
  };

  const dna = analyzeDeckDNA(entries, resolver);
  const salt = calculateSaltAnalysis(entries, resolver);

  const factors: PowerFactor[] = [];
  let power = 4;
  factors.push({ label: 'Base', value: 4, detail: 'Starting power level' });

  // Avg CMC excluding lands
  let cmcSum = 0;
  let nonlandQty = 0;
  for (const e of entries) {
    const card = resolvedCardByName[normalizeNameKey(e.name)];
    if (card && !(card.type_line || '').toLowerCase().includes('land')) {
      cmcSum += (card.cmc || 0) * e.qty;
      nonlandQty += e.qty;
    }
  }
  const avgCmc = nonlandQty > 0 ? cmcSum / nonlandQty : 3;

  if (avgCmc < 2.5) {
    power += 1.5;
    factors.push({ label: 'Low CMC', value: 1.5, detail: `Avg CMC ${avgCmc.toFixed(1)} is very aggressive` });
  } else if (avgCmc < 3.0) {
    power += 0.5;
    factors.push({ label: 'Low CMC', value: 0.5, detail: `Avg CMC ${avgCmc.toFixed(1)} is below average` });
  } else if (avgCmc > 4.0) {
    power -= 1;
    factors.push({ label: 'High CMC', value: -1, detail: `Avg CMC ${avgCmc.toFixed(1)} is slow` });
  }

  if (dna.normalized.combo > 0.3) {
    power += 1;
    factors.push({ label: 'Combo density', value: 1, detail: `Combo score ${Math.round(dna.normalized.combo * 100)}% \u2014 tutors, draw, untap effects` });
  }
  if (dna.normalized.control > 0.3) {
    power += 0.5;
    factors.push({ label: 'Control density', value: 0.5, detail: `Control score ${Math.round(dna.normalized.control * 100)}% \u2014 removal, counters` });
  }
  if (salt.score > 5) {
    power += 1;
    factors.push({ label: 'Salt', value: 1, detail: `Salt score ${salt.score.toFixed(1)}/10 raises power` });
  }
  if (salt.score > 8) {
    power += 0.5;
    factors.push({ label: 'High salt', value: 0.5, detail: `Salt ${salt.score.toFixed(1)}/10 is very controversial` });
  }

  // Tutor/fast mana detection
  const oracleTexts = entries.flatMap((e) => {
    const card = resolvedCardByName[normalizeNameKey(e.name)];
    return card?.oracle_text ? [card.oracle_text.toLowerCase()] : [];
  });
  const tutorCount = oracleTexts.filter((t) => t.includes('search your library')).length;
  if (tutorCount >= 5) {
    power += 1;
    factors.push({ label: 'Tutors', value: 1, detail: `${tutorCount} tutors found (search your library)` });
  } else if (tutorCount >= 3) {
    power += 0.5;
    factors.push({ label: 'Tutors', value: 0.5, detail: `${tutorCount} tutors found` });
  }

  power = Math.max(1, Math.min(10, Math.round(power * 10) / 10));

  let bracket: number;
  if (power <= 3) bracket = 1;
  else if (power <= 5) bracket = 2;
  else if (power <= 7) bracket = 3;
  else bracket = 4;

  return { power, bracket, dominant: dna.dominant, salt: salt.score, saltLabel: salt.label, factors, avgCmc, tutorCount };
}
