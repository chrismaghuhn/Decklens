import type { DeckEntry } from '../../shared/types.js';

export type DNAArchetype = 'aggro' | 'control' | 'combo' | 'midrange' | 'ramp' | 'tempo';

export interface AnalyzerCardView {
  name: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
}

export type AnalyzerCardResolver = (cardName: string) => AnalyzerCardView | undefined;

export interface DNAAnalysisResult {
  normalized: Record<DNAArchetype, number>;
  raw: Record<DNAArchetype, number>;
  dominant: DNAArchetype;
}

export interface SaltAnalysisResult {
  score: number;
  label: string;
  saltyCards: string[];
}

const DNA_ORDER: DNAArchetype[] = ['aggro', 'control', 'combo', 'midrange', 'ramp', 'tempo'];

const SALT_PATTERNS = [
  { pattern: 'extra turn', salt: 3, label: 'Extra turns' },
  { pattern: 'land destruction', salt: 4, label: 'Land destruction' },
  { pattern: 'destroy all land', salt: 5, label: 'Mass land destruction' },
  { pattern: 'counter target', salt: 1, label: 'Counterspells' },
  { pattern: "can't be countered", salt: 2, label: 'Uncounterable' },
  { pattern: 'you win the game', salt: 3, label: 'Alt wincon' },
  { pattern: 'opponent loses the game', salt: 3, label: 'Alt wincon' },
  { pattern: 'stax', salt: 4, label: 'Stax effects' },
  { pattern: 'each opponent sacrifices', salt: 2, label: 'Forced sacrifice' },
  { pattern: "can't untap", salt: 3, label: 'Tap lock' },
  { pattern: "can't cast", salt: 4, label: 'Cast prevention' },
] as const;

function toLower(value: string | undefined): string {
  return (value || '').toLowerCase();
}

function toDNALabel(score: number): string {
  if (score < 2.5) return 'Friendly';
  if (score < 5) return 'Mild';
  if (score < 7.5) return 'Spicy';
  if (score < 9) return 'Salty';
  return 'Toxic';
}

export function analyzeDeckDNA(entries: DeckEntry[], resolveCard: AnalyzerCardResolver): DNAAnalysisResult {
  const scores: Record<DNAArchetype, number> = {
    aggro: 0,
    control: 0,
    combo: 0,
    midrange: 0,
    ramp: 0,
    tempo: 0,
  };

  for (const entry of entries) {
    const card = resolveCard(entry.name);
    if (!card) continue;

    const cmc = card.cmc || 0;
    const type = toLower(card.type_line);
    const text = toLower(card.oracle_text);

    if (type.includes('creature') && cmc <= 2) scores.aggro += entry.qty * 2;
    if (text.includes('haste')) scores.aggro += entry.qty;
    if (text.includes('deals') && text.includes('damage')) scores.aggro += entry.qty;

    if (text.includes('counter target')) scores.control += entry.qty * 2;
    if (text.includes('destroy target') || text.includes('exile target')) scores.control += entry.qty;
    if (cmc >= 5 && !type.includes('creature')) scores.control += entry.qty;

    if (text.includes('search your library')) scores.combo += entry.qty * 2;
    if (text.includes('draw') && text.includes('card')) scores.combo += entry.qty;
    if (text.includes('untap')) scores.combo += entry.qty;

    if (type.includes('creature') && cmc >= 3 && cmc <= 5) scores.midrange += entry.qty;
    if (text.includes('when') && text.includes('enters')) scores.midrange += entry.qty;

    if (text.includes('add') && (text.includes('mana') || text.includes('{g}') || text.includes('{c}'))) scores.ramp += entry.qty * 2;
    if (type.includes('land') && text.includes('add')) scores.ramp += entry.qty;

    if (text.includes('return') && text.includes('to') && text.includes('hand')) scores.tempo += entry.qty;
    if (cmc <= 2 && (text.includes('counter') || text.includes('destroy'))) scores.tempo += entry.qty;
  }

  const maxScore = Math.max(...Object.values(scores), 1);
  const normalized: Record<DNAArchetype, number> = {
    aggro: Math.round((scores.aggro / maxScore) * 100),
    control: Math.round((scores.control / maxScore) * 100),
    combo: Math.round((scores.combo / maxScore) * 100),
    midrange: Math.round((scores.midrange / maxScore) * 100),
    ramp: Math.round((scores.ramp / maxScore) * 100),
    tempo: Math.round((scores.tempo / maxScore) * 100),
  };

  const dominant = DNA_ORDER.reduce((best, archetype) =>
    normalized[archetype] > normalized[best] ? archetype : best
  , 'aggro' as DNAArchetype);

  return { normalized, raw: scores, dominant };
}

export function calculateSaltAnalysis(entries: DeckEntry[], resolveCard: AnalyzerCardResolver): SaltAnalysisResult {
  let salt = 0;
  const saltyCards: string[] = [];

  for (const entry of entries) {
    const card = resolveCard(entry.name);
    if (!card) continue;

    const text = toLower(card.oracle_text);

    for (const rule of SALT_PATTERNS) {
      if (text.includes(rule.pattern)) {
        salt += rule.salt * entry.qty;
        saltyCards.push(`${card.name} (${rule.label})`);
      }
    }
  }

  const score = Math.min(10, salt / 5);

  return {
    score,
    label: toDNALabel(score),
    saltyCards: [...new Set(saltyCards)],
  };
}

export function detectDeckSynergies(entries: DeckEntry[], resolveCard: AnalyzerCardResolver, maxResults = 10): string[] {
  const cards = entries
    .map((entry) => ({
      name: entry.name,
      type: toLower(resolveCard(entry.name)?.type_line),
      text: toLower(resolveCard(entry.name)?.oracle_text),
    }))
    .filter((card) => card.type || card.text);

  const creatureCards = cards.filter((card) => card.type.includes('creature'));
  const etbTriggers = cards.filter((card) => card.text.includes('when') && card.text.includes('creature') && card.text.includes('enters'));
  const counterCards = cards.filter((card) => card.text.includes('+1/+1 counter'));

  const synergies: string[] = [];

  for (const trigger of etbTriggers) {
    for (const creature of creatureCards) {
      if (trigger.name === creature.name) continue;
      synergies.push(`${trigger.name} triggers when ${creature.name} enters`);
    }
  }

  for (let i = 0; i < counterCards.length; i++) {
    for (let j = i + 1; j < counterCards.length; j++) {
      synergies.push(`${counterCards[i].name} + ${counterCards[j].name} (counter synergy)`);
    }
  }

  return [...new Set(synergies)].slice(0, maxResults);
}
