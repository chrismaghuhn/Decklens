import type { PriceQuote } from '../shared/price-adapter.js';
import type { MetaMode } from './meta-mode.js';
import { CardDiscoveryEngine, type DiscoveredCard } from './engine/card-discovery.js';
import type { DeckProfile as DiscoveryDeckProfile, DiscoveryRole } from './engine/discovery-query-builder.js';
import type { Deck, DeckEntry } from '../shared/types.js';
import { getUserFeedbackSystem } from './engine/user-feedback.js';
import { getMLRecommendationEngine } from './engine/ml-recommendation.js';
import type { ArchetypeId } from './engine/archetype-catalog.js';

type RecommendationRole = 'ramp' | 'draw' | 'removal' | 'interaction' | 'protection' | 'finisher';

export type RecommendationLogicTag =
  | 'synergy'
  | 'curve-fix'
  | 'mana-fix'
  | 'meta-answer'
  | 'card-advantage'
  | 'protection'
  | 'board-control';

interface RecommendationTemplate {
  id: string;
  cardName: string;
  reason: string;
  colorIdentity: string[];
  roles: RecommendationRole[];
  baseImpact: number;
}

export interface RecommendationDeckEntry {
  name: string;
  qty: number;
}

export interface RecommendationCardSnapshot {
  name: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity?: string[];
}

export interface RecommendationItem {
  id: string;
  cardName: string;
  reason: string;
  logicTags: RecommendationLogicTag[];
  roles: RecommendationRole[];
  confidence: number;
  confidenceBreakdown: {
    signalStrength: number;
    dataCoverage: number;
    heuristicConsensus: number;
  };
  unitPrice: PriceQuote;
  suggestedCutName: string | null;
  suggestedCutPrice: PriceQuote | null;
  deltaPrice: number | null;
  powerImpactScore: number;
  powerImpactLabel: 'low' | 'medium' | 'high';
}

export interface RecommendationSummary {
  itemCount: number;
  averageConfidence: number;
  totalKnownUnitPrice: number;
  totalKnownCutValue: number;
  totalKnownDelta: number;
  missingPriceCount: number;
  nonEurPriceCount: number;
  unknownDeltaCount: number;
  stalePriceCount: number;
  totalPowerImpact: number;
}

export interface BuildRecommendationsInput {
  deckMain: RecommendationDeckEntry[];
  getCard: (cardName: string) => RecommendationCardSnapshot | null;
  getPrice: (cardName: string) => PriceQuote;
  metaMode?: MetaMode;
  maxRecommendations?: number;
}

export interface RecommendationCollectionViewInput {
  recommendations: RecommendationItem[];
  getOwnedCount: (cardName: string) => number;
  includeMissingCards?: boolean;
  strongBuildSize?: number;
  strongBuildLabel?: string;
}

export interface RecommendationGapHint {
  missingCount: number;
  buildLabel: string;
}

export interface RecommendationCollectionView {
  visibleItems: RecommendationItem[];
  ownedItems: RecommendationItem[];
  missingItems: RecommendationItem[];
  strongBuildItems: RecommendationItem[];
  gap: RecommendationGapHint | null;
  includeMissingCards: boolean;
}

interface DeckNeeds {
  colors: Set<string>;
  avgCmc: number;
  ramp: number;
  draw: number;
  removal: number;
  interaction: number;
  cardCoverage: number;
}

const META_MODE_ROLE_MULTIPLIERS: Record<MetaMode, Record<RecommendationRole, number>> = {
  local: {
    ramp: 1,
    draw: 1,
    removal: 1,
    interaction: 1,
    protection: 1,
    finisher: 1,
  },
  fnm: {
    ramp: 0.92,
    draw: 0.95,
    removal: 1.3,
    interaction: 1.35,
    protection: 1.12,
    finisher: 0.92,
  },
  'commander-pod': {
    ramp: 1.35,
    draw: 1.22,
    removal: 0.95,
    interaction: 0.96,
    protection: 1.08,
    finisher: 1.14,
  },
};

const RECOMMENDATION_LIBRARY: RecommendationTemplate[] = [
  {
    id: 'sol-ring',
    cardName: 'Sol Ring',
    reason: 'Fast mana to accelerate early turns.',
    colorIdentity: [],
    roles: ['ramp'],
    baseImpact: 26,
  },
  {
    id: 'arcane-signet',
    cardName: 'Arcane Signet',
    reason: 'Reliable color fixing in Commander decks.',
    colorIdentity: [],
    roles: ['ramp'],
    baseImpact: 21,
  },
  {
    id: 'natures-lore',
    cardName: "Nature's Lore",
    reason: 'Two-mana ramp that fixes colors.',
    colorIdentity: ['G'],
    roles: ['ramp'],
    baseImpact: 20,
  },
  {
    id: 'farseek',
    cardName: 'Farseek',
    reason: 'Improves color consistency and curve.',
    colorIdentity: ['G'],
    roles: ['ramp'],
    baseImpact: 18,
  },
  {
    id: 'rhystic-study',
    cardName: 'Rhystic Study',
    reason: 'Sustained card advantage over long games.',
    colorIdentity: ['U'],
    roles: ['draw'],
    baseImpact: 24,
  },
  {
    id: 'esper-sentinel',
    cardName: 'Esper Sentinel',
    reason: 'Low-cost card flow in interactive tables.',
    colorIdentity: ['W'],
    roles: ['draw'],
    baseImpact: 20,
  },
  {
    id: 'phyrexian-arena',
    cardName: 'Phyrexian Arena',
    reason: 'Consistent draw engine for grindy games.',
    colorIdentity: ['B'],
    roles: ['draw'],
    baseImpact: 18,
  },
  {
    id: 'swords-to-plowshares',
    cardName: 'Swords to Plowshares',
    reason: 'Premium one-mana creature interaction.',
    colorIdentity: ['W'],
    roles: ['removal', 'interaction'],
    baseImpact: 21,
  },
  {
    id: 'path-to-exile',
    cardName: 'Path to Exile',
    reason: 'Efficient exile removal for key threats.',
    colorIdentity: ['W'],
    roles: ['removal', 'interaction'],
    baseImpact: 19,
  },
  {
    id: 'beast-within',
    cardName: 'Beast Within',
    reason: 'Flexible answer to any permanent.',
    colorIdentity: ['G'],
    roles: ['removal', 'interaction'],
    baseImpact: 18,
  },
  {
    id: 'chaos-warp',
    cardName: 'Chaos Warp',
    reason: 'Red answer to problematic permanents.',
    colorIdentity: ['R'],
    roles: ['removal', 'interaction'],
    baseImpact: 17,
  },
  {
    id: 'counterspell',
    cardName: 'Counterspell',
    reason: 'Hard interaction to protect your game plan.',
    colorIdentity: ['U'],
    roles: ['interaction'],
    baseImpact: 18,
  },
  {
    id: 'swan-song',
    cardName: 'Swan Song',
    reason: 'Cheap stack interaction for combo/control turns.',
    colorIdentity: ['U'],
    roles: ['interaction', 'protection'],
    baseImpact: 17,
  },
  {
    id: 'cyclonic-rift',
    cardName: 'Cyclonic Rift',
    reason: 'Strong tempo swing and late-game reset button.',
    colorIdentity: ['U'],
    roles: ['interaction', 'finisher'],
    baseImpact: 23,
  },
  {
    id: 'toxic-deluge',
    cardName: 'Toxic Deluge',
    reason: 'Efficient board wipe to stabilize quickly.',
    colorIdentity: ['B'],
    roles: ['removal'],
    baseImpact: 22,
  },
  {
    id: 'farewell',
    cardName: 'Farewell',
    reason: 'High-impact reset against wide board states.',
    colorIdentity: ['W'],
    roles: ['removal'],
    baseImpact: 20,
  },
];

const STAPLE_PROTECT = new Set([
  'sol ring',
  'arcane signet',
  'rhystic study',
  'cyclonic rift',
  'swords to plowshares',
  'path to exile',
]);

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function cardHas(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function analyzeDeckNeeds(deckMain: RecommendationDeckEntry[], getCard: (cardName: string) => RecommendationCardSnapshot | null): DeckNeeds {
  const colors = new Set<string>();
  let totalCmc = 0;
  let totalCards = 0;
  let resolvedCards = 0;
  let ramp = 0;
  let draw = 0;
  let removal = 0;
  let interaction = 0;

  for (const entry of deckMain) {
    const qty = Math.max(1, entry.qty);
    const card = getCard(entry.name);
    const text = (card?.oracle_text || '').toLowerCase();
    const type = (card?.type_line || '').toLowerCase();
    const cardColors = card?.color_identity || card?.colors || [];
    for (const color of cardColors) colors.add(color);

    totalCards += qty;
    if (card) resolvedCards += qty;
    totalCmc += (card?.cmc || 0) * qty;

    if (cardHas(text, ['add {', 'search your library for a land', 'mana of any color'])) ramp += qty;
    if (cardHas(text, ['draw ', 'draw a card', 'draw two cards', 'whenever you draw'])) draw += qty;
    if (cardHas(text, ['destroy target', 'exile target', 'sacrifice', 'board wipe']) || type.includes('board wipe')) removal += qty;
    if (cardHas(text, ['counter target', 'counterspell', 'can\'t be countered', 'protection from']) || type.includes('instant')) interaction += qty;
  }

  return {
    colors,
    avgCmc: totalCards > 0 ? totalCmc / totalCards : 0,
    ramp,
    draw,
    removal,
    interaction,
    cardCoverage: totalCards > 0 ? resolvedCards / totalCards : 0,
  };
}

function colorMatches(template: RecommendationTemplate, deckColors: Set<string>): boolean {
  if (template.colorIdentity.length === 0) return true;
  if (deckColors.size === 0) return false;
  return template.colorIdentity.every((color) => deckColors.has(color));
}

function roleNeedScore(role: RecommendationRole, needs: DeckNeeds): number {
  if (role === 'ramp') return Math.max(0, 10 - needs.ramp) * 1.5;
  if (role === 'draw') return Math.max(0, 10 - needs.draw) * 1.25;
  if (role === 'removal') return Math.max(0, 8 - needs.removal) * 1.5;
  if (role === 'interaction') return Math.max(0, 7 - needs.interaction) * 1.25;
  if (role === 'protection') return Math.max(0, 5 - needs.interaction) * 1.1;
  return 2;
}

function normalizeMetaMode(metaMode: MetaMode | undefined): MetaMode {
  if (metaMode === 'fnm' || metaMode === 'commander-pod') return metaMode;
  return 'local';
}

function scoreRecommendation(template: RecommendationTemplate, needs: DeckNeeds, metaMode: MetaMode): number {
  let score = template.baseImpact;
  const roleMultipliers = META_MODE_ROLE_MULTIPLIERS[metaMode];
  for (const role of template.roles) {
    score += roleNeedScore(role, needs) * roleMultipliers[role];
  }

  if (template.roles.includes('ramp') && needs.avgCmc >= 3.4) {
    score += 4;
  }

  if (template.roles.includes('interaction') && needs.colors.size >= 3) {
    score += 2;
  }

  if (metaMode === 'fnm') {
    if (template.roles.includes('interaction')) score += 1.8;
    if (template.roles.includes('removal')) score += 1.2;
    if (template.roles.includes('ramp')) score -= 0.6;
  }

  if (metaMode === 'commander-pod') {
    if (template.roles.includes('ramp')) score += 1.9;
    if (template.roles.includes('draw')) score += 1.3;
    if (template.roles.includes('finisher') && needs.avgCmc >= 3.3) score += 0.7;
  }

  return Math.round(Math.max(1, Math.min(45, score)));
}

function impactLabel(score: number): 'low' | 'medium' | 'high' {
  if (score >= 26) return 'high';
  if (score >= 16) return 'medium';
  return 'low';
}

const ROLE_NEED_MAX: Record<RecommendationRole, number> = {
  ramp: 15,
  draw: 12.5,
  removal: 12,
  interaction: 8.75,
  protection: 5.5,
  finisher: 2,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundConfidence(value: number): number {
  return Math.round(clamp01(value) * 100) / 100;
}

function roleNeedNormalized(role: RecommendationRole, needs: DeckNeeds): number {
  return clamp01(roleNeedScore(role, needs) / ROLE_NEED_MAX[role]);
}

function summarizeNeedGap(template: RecommendationTemplate, needs: DeckNeeds): string {
  const roleSignals = template.roles
    .map((role) => ({ role, signal: roleNeedNormalized(role, needs) }))
    .sort((a, b) => b.signal - a.signal);
  const primaryRole = roleSignals[0]?.role || template.roles[0] || 'finisher';

  if (primaryRole === 'ramp') {
    return `Your current list is light on mana acceleration (${needs.ramp} ramp cards found).`;
  }
  if (primaryRole === 'draw') {
    return `Your list can use more reliable card flow (${needs.draw} draw sources found).`;
  }
  if (primaryRole === 'removal') {
    return `Your deck needs a few more clean answers to opposing threats (${needs.removal} removal effects found).`;
  }
  if (primaryRole === 'interaction') {
    return `Your interaction count is a bit low (${needs.interaction} instant-speed answers found).`;
  }
  if (primaryRole === 'protection') {
    return 'Your game plan benefits from extra protection for key permanents and turns.';
  }
  return 'This slot improves overall deck consistency and closing power.';
}

function buildLogicTags(template: RecommendationTemplate, needs: DeckNeeds): RecommendationLogicTag[] {
  const tags = new Set<RecommendationLogicTag>();
  tags.add('synergy');

  if (template.roles.includes('ramp')) {
    tags.add('curve-fix');
    if (needs.colors.size >= 3 || cardHas(template.reason.toLowerCase(), ['fix', 'color'])) {
      tags.add('mana-fix');
    }
  }

  if (template.roles.includes('draw')) {
    tags.add('card-advantage');
  }

  if (template.roles.includes('interaction') || template.roles.includes('removal')) {
    tags.add('meta-answer');
  }

  if (template.roles.includes('protection')) {
    tags.add('protection');
  }

  if (template.cardName === 'Cyclonic Rift' || template.cardName === 'Toxic Deluge' || template.cardName === 'Farewell') {
    tags.add('board-control');
  }

  return [...tags];
}

function buildReasonText(template: RecommendationTemplate, needs: DeckNeeds, tags: RecommendationLogicTag[]): string {
  const lead = summarizeNeedGap(template, needs);
  const support = template.reason;
  const manaFixTail = tags.includes('mana-fix')
    ? 'It also improves color consistency when your deck needs multiple colors early.'
    : '';
  const coverageTail = needs.cardCoverage < 0.55
    ? 'Card data coverage is partial, so treat this as a directional suggestion.'
    : '';

  return [lead, support, manaFixTail, coverageTail]
    .filter((part) => part.trim().length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function priceCoverageScore(price: PriceQuote): number {
  if (price.amount !== null && price.currency === 'EUR') {
    return price.stale ? 0.9 : 1;
  }
  if (price.amount !== null && price.currency !== null) {
    return price.stale ? 0.78 : 0.85;
  }
  if (price.status === 'missing_card') return 0.5;
  if (price.status === 'missing_price') return 0.6;
  return 0.65;
}

function computeConfidence(
  template: RecommendationTemplate,
  score: number,
  needs: DeckNeeds,
  unitPrice: PriceQuote,
  cutPrice: PriceQuote | null,
): { confidence: number; signalStrength: number; dataCoverage: number; heuristicConsensus: number } {
  const roleSignal = template.roles.length > 0
    ? template.roles.reduce((sum, role) => sum + roleNeedNormalized(role, needs), 0) / template.roles.length
    : 0;
  const impactSignal = clamp01(score / 45);
  const signalStrength = clamp01((roleSignal * 0.6) + (impactSignal * 0.4));

  const unitCoverage = priceCoverageScore(unitPrice);
  const cutCoverage = cutPrice ? priceCoverageScore(cutPrice) : 0.8;
  const dataCoverage = clamp01((needs.cardCoverage * 0.65) + (unitCoverage * 0.25) + (cutCoverage * 0.1));

  let checks = 0;
  let passes = 0;
  const runCheck = (condition: boolean): void => {
    checks += 1;
    if (condition) passes += 1;
  };

  runCheck(roleSignal >= 0.2);
  runCheck(template.roles.some((role) => roleNeedScore(role, needs) >= 2));
  runCheck(needs.cardCoverage >= 0.45);
  if (template.roles.includes('ramp')) runCheck(needs.avgCmc >= 3.2 || needs.ramp <= 7);
  if (template.roles.includes('draw')) runCheck(needs.draw <= 9);
  if (template.roles.includes('removal')) runCheck(needs.removal <= 7);
  if (template.roles.includes('interaction')) runCheck(needs.interaction <= 6 || needs.colors.size >= 2);
  if (template.roles.includes('protection')) runCheck(needs.interaction <= 5);

  const heuristicConsensus = checks > 0 ? passes / checks : 0.5;
  const confidence = roundConfidence((signalStrength * 0.5) + (dataCoverage * 0.3) + (heuristicConsensus * 0.2));

  return {
    confidence,
    signalStrength: roundConfidence(signalStrength),
    dataCoverage: roundConfidence(dataCoverage),
    heuristicConsensus: roundConfidence(heuristicConsensus),
  };
}

function ensureExplainability(
  reason: string,
  tags: RecommendationLogicTag[],
  confidencePayload: { confidence: number; signalStrength: number; dataCoverage: number; heuristicConsensus: number },
): {
  reason: string;
  tags: RecommendationLogicTag[];
  confidence: number;
  breakdown: { signalStrength: number; dataCoverage: number; heuristicConsensus: number };
} {
  const safeReason = reason.trim() || 'This recommendation improves your deck consistency for the current profile.';
  const safeTags = [...new Set(tags.filter(Boolean))];
  if (safeTags.length === 0) safeTags.push('synergy');

  const safeBreakdown = {
    signalStrength: roundConfidence(confidencePayload.signalStrength),
    dataCoverage: roundConfidence(confidencePayload.dataCoverage),
    heuristicConsensus: roundConfidence(confidencePayload.heuristicConsensus),
  };
  const safeConfidence = roundConfidence(confidencePayload.confidence);

  return {
    reason: safeReason,
    tags: safeTags,
    confidence: safeConfidence,
    breakdown: safeBreakdown,
  };
}

interface CutCandidate {
  name: string;
  score: number;
}

function cutScore(entry: RecommendationDeckEntry, card: RecommendationCardSnapshot | null): number {
  const name = normalizeName(entry.name);
  const text = (card?.oracle_text || '').toLowerCase();
  const type = (card?.type_line || '').toLowerCase();
  const cmc = card?.cmc ?? 3;

  if (type.includes('land')) return -999;

  let score = cmc * 1.3;
  if (type.includes('sorcery')) score += 2;
  if (!text || text.length < 20) score += 2.2;
  if (entry.qty > 2) score += 0.8;

  if (cardHas(text, ['draw ', 'search your library', 'counter target', 'destroy target', 'exile target', 'add {'])) {
    score -= 3;
  }
  if (STAPLE_PROTECT.has(name)) score -= 6;

  return score;
}

function buildCutCandidates(deckMain: RecommendationDeckEntry[], getCard: (cardName: string) => RecommendationCardSnapshot | null): CutCandidate[] {
  const cutCandidates = deckMain
    .map((entry) => ({ name: entry.name, score: cutScore(entry, getCard(entry.name)) }))
    .filter((candidate) => candidate.score > -100)
    .sort((a, b) => b.score - a.score);

  return cutCandidates;
}

function pickNextCut(cutCandidates: CutCandidate[], used: Set<string>, avoidName: string): string | null {
  const avoid = normalizeName(avoidName);
  for (const candidate of cutCandidates) {
    const key = normalizeName(candidate.name);
    if (key === avoid) continue;
    if (used.has(key)) continue;
    used.add(key);
    return candidate.name;
  }
  return null;
}

export function getRecommendationCatalogCardNames(): string[] {
  return RECOMMENDATION_LIBRARY.map((item) => item.cardName);
}

export function buildRecommendations(input: BuildRecommendationsInput): RecommendationItem[] {
  const metaMode = normalizeMetaMode(input.metaMode);
  const maxRecommendations = input.maxRecommendations ?? 8;
  const deckNames = new Set(input.deckMain.map((entry) => normalizeName(entry.name)));
  const needs = analyzeDeckNeeds(input.deckMain, input.getCard);
  const cutCandidates = buildCutCandidates(input.deckMain, input.getCard);
  const usedCuts = new Set<string>();

  const ranked = RECOMMENDATION_LIBRARY
    .filter((template) => !deckNames.has(normalizeName(template.cardName)))
    .filter((template) => colorMatches(template, needs.colors))
    .map((template) => ({ template, score: scoreRecommendation(template, needs, metaMode) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRecommendations);

  return ranked.map(({ template, score }) => {
    const cutName = pickNextCut(cutCandidates, usedCuts, template.cardName);
    const unitPrice = input.getPrice(template.cardName);
    const cutPrice = cutName ? input.getPrice(cutName) : null;
    const unitAmount = unitPrice.currency === 'EUR' ? unitPrice.amount : null;
    const cutAmount = cutPrice?.currency === 'EUR' ? (cutPrice.amount ?? null) : null;

    let deltaPrice: number | null = null;
    if (unitAmount !== null && cutAmount !== null) {
      deltaPrice = unitAmount - cutAmount;
    } else if (unitAmount !== null && cutPrice === null) {
      deltaPrice = unitAmount;
    }

    const logicTags = buildLogicTags(template, needs);
    const explainabilityReason = buildReasonText(template, needs, logicTags);
    const confidencePayload = computeConfidence(template, score, needs, unitPrice, cutPrice);
    const explainability = ensureExplainability(explainabilityReason, logicTags, confidencePayload);

    return {
      id: template.id,
      cardName: template.cardName,
      reason: explainability.reason,
      logicTags: explainability.tags,
      roles: template.roles,
      confidence: explainability.confidence,
      confidenceBreakdown: explainability.breakdown,
      unitPrice,
      suggestedCutName: cutName,
      suggestedCutPrice: cutPrice,
      deltaPrice,
      powerImpactScore: score,
      powerImpactLabel: impactLabel(score),
    };
  });
}

function sanitizeOwnedCount(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.trunc(raw));
}

export function buildRecommendationCollectionView(input: RecommendationCollectionViewInput): RecommendationCollectionView {
  const includeMissingCards = input.includeMissingCards === true;
  const strongBuildSize = typeof input.strongBuildSize === 'number' && Number.isFinite(input.strongBuildSize)
    ? Math.max(1, Math.trunc(input.strongBuildSize))
    : 5;
  const defaultLabel = `Top ${strongBuildSize}`;
  const buildLabel = (input.strongBuildLabel || defaultLabel).trim() || defaultLabel;

  const ownedItems: RecommendationItem[] = [];
  const missingItems: RecommendationItem[] = [];
  let missingStrongCount = 0;

  for (let index = 0; index < input.recommendations.length; index += 1) {
    const item = input.recommendations[index];
    const ownedCount = sanitizeOwnedCount(input.getOwnedCount(item.cardName));
    if (ownedCount > 0) {
      ownedItems.push(item);
    } else {
      missingItems.push(item);
      if (index < strongBuildSize) {
        missingStrongCount += 1;
      }
    }
  }

  return {
    visibleItems: includeMissingCards ? [...input.recommendations] : ownedItems,
    ownedItems,
    missingItems,
    strongBuildItems: input.recommendations.slice(0, strongBuildSize),
    gap: missingStrongCount > 0
      ? {
          missingCount: missingStrongCount,
          buildLabel,
        }
      : null,
    includeMissingCards,
  };
}

export function formatRecommendationGapHint(gap: RecommendationGapHint | null): string | null {
  if (!gap || gap.missingCount <= 0) return null;
  return `Fehlen noch ${gap.missingCount} Karten für Build ${gap.buildLabel}`;
}

function normalizeSelection(appliedIds?: Iterable<string>): Set<string> | null {
  if (!appliedIds) return null;
  return new Set(Array.from(appliedIds));
}

export function summarizeRecommendations(items: RecommendationItem[], appliedIds?: Iterable<string>): RecommendationSummary {
  const selection = normalizeSelection(appliedIds);

  let itemCount = 0;
  let totalKnownUnitPrice = 0;
  let totalKnownCutValue = 0;
  let totalKnownDelta = 0;
  let missingPriceCount = 0;
  let nonEurPriceCount = 0;
  let unknownDeltaCount = 0;
  let stalePriceCount = 0;
  let totalPowerImpact = 0;
  let totalConfidence = 0;

  for (const item of items) {
    if (selection && !selection.has(item.id)) continue;
    itemCount += 1;
    totalPowerImpact += item.powerImpactScore;
    totalConfidence += item.confidence;

    if (item.unitPrice.amount !== null && item.unitPrice.currency === 'EUR') {
      totalKnownUnitPrice += item.unitPrice.amount;
    } else if (item.unitPrice.amount !== null && item.unitPrice.currency !== 'EUR') {
      nonEurPriceCount += 1;
    } else {
      missingPriceCount += 1;
    }

    if (item.unitPrice.stale) stalePriceCount += 1;

    const cutAmount = item.suggestedCutPrice?.amount ?? null;
    if (cutAmount !== null) {
      totalKnownCutValue += cutAmount;
    }

    if (item.deltaPrice !== null) {
      totalKnownDelta += item.deltaPrice;
    } else {
      unknownDeltaCount += 1;
    }
  }

  return {
    itemCount,
    averageConfidence: itemCount > 0 ? totalConfidence / itemCount : 0,
    totalKnownUnitPrice,
    totalKnownCutValue,
    totalKnownDelta,
    missingPriceCount,
    nonEurPriceCount,
    unknownDeltaCount,
    stalePriceCount,
    totalPowerImpact,
  };
}

// ==================== DYNAMIC DISCOVERY INTEGRATION ====================

export interface DynamicBuildRecommendationsInput extends BuildRecommendationsInput {
  useDynamicDiscovery?: boolean;
  useMLPersonalization?: boolean;
  detectedArchetypes?: ArchetypeId[];
  discoveryConfig?: {
    maxCardsPerQuery?: number;
    maxTotalCards?: number;
    maxQueries?: number;
    minConfidence?: number;
  };
}

export interface DynamicDiscoveryStats {
  totalFound: number;
  fromCache: number;
  fromScryfall: number;
  queriesExecuted: number;
  durationMs: number;
  errors: string[];
}

export interface DynamicRecommendationResult {
  items: RecommendationItem[];
  discoveryStats?: DynamicDiscoveryStats;
}

/**
 * Build recommendations with optional dynamic card discovery
 * This extends the static RECOMMENDATION_LIBRARY with real-time Scryfall searches
 */
export async function buildRecommendationsDynamic(
  input: DynamicBuildRecommendationsInput
): Promise<DynamicRecommendationResult> {
  // If dynamic discovery is disabled, use the static method
  if (!input.useDynamicDiscovery) {
    return {
      items: buildRecommendations(input),
    };
  }

  const startTime = performance.now();
  const deckNames = new Set(input.deckMain.map((entry) => normalizeName(entry.name)));
  const needs = analyzeDeckNeeds(input.deckMain, input.getCard);
  const cutCandidates = buildCutCandidates(input.deckMain, input.getCard);
  const usedCuts = new Set<string>();
  const metaMode = normalizeMetaMode(input.metaMode);
  const maxRecommendations = input.maxRecommendations ?? 8;

  // Initialize discovery engine
  const discoveryEngine = new CardDiscoveryEngine({
    maxCardsPerQuery: input.discoveryConfig?.maxCardsPerQuery ?? 15,
    maxTotalCards: input.discoveryConfig?.maxTotalCards ?? 100,
    maxQueries: input.discoveryConfig?.maxQueries ?? 5,
    minConfidence: input.discoveryConfig?.minConfidence ?? 0.3,
    excludeCards: deckNames,
    useCache: true,
  });

  // Build discovery profile from deck needs
  const discoveryProfile: DiscoveryDeckProfile = {
    colors: needs.colors,
    avgCmc: needs.avgCmc,
    roleCounts: {
      ramp: needs.ramp,
      draw: needs.draw,
      removal: needs.removal,
      interaction: needs.interaction,
      protection: 0,
      finisher: 0,
      mana_fix: 0,
      tutor: 0,
      board_wipe: 0,
      graveyard_hate: 0,
      artifact_hate: 0,
      combo_piece: 0,
    },
    dominantArchetype: 'combo', // TODO: detect from deck
    commanderKeywords: new Set(),
    format: 'commander',
  };

  // Run dynamic discovery
  const discoveryResult = await discoveryEngine.discover(discoveryProfile);

  // Convert discovered cards to templates
  const discoveredTemplates: RecommendationTemplate[] = discoveryResult.cards.map((card) => ({
    id: card.id,
    cardName: card.name,
    reason: card.reason,
    colorIdentity: card.colorIdentity,
    roles: card.roles as RecommendationRole[],
    baseImpact: Math.round(card.confidence * 30),
  }));

  // Merge with static library
  const allTemplates = [...RECOMMENDATION_LIBRARY, ...discoveredTemplates];

  // Score and rank all templates
  const ranked = allTemplates
    .filter((template) => !deckNames.has(normalizeName(template.cardName)))
    .filter((template) => colorMatches(template, needs.colors))
    .map((template) => ({ template, score: scoreRecommendation(template, needs, metaMode) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRecommendations);

  // Build final recommendations
  let items = ranked.map(({ template, score }) => {
    const cutName = pickNextCut(cutCandidates, usedCuts, template.cardName);
    const unitPrice = input.getPrice(template.cardName);
    const cutPrice = cutName ? input.getPrice(cutName) : null;
    const unitAmount = unitPrice.currency === 'EUR' ? unitPrice.amount : null;
    const cutAmount = cutPrice?.currency === 'EUR' ? (cutPrice.amount ?? null) : null;

    let deltaPrice: number | null = null;
    if (unitAmount !== null && cutAmount !== null) {
      deltaPrice = unitAmount - cutAmount;
    } else if (unitAmount !== null && cutPrice === null) {
      deltaPrice = unitAmount;
    }

    const logicTags = buildLogicTags(template, needs);
    const explainabilityReason = buildReasonText(template, needs, logicTags);
    const confidencePayload = computeConfidence(template, score, needs, unitPrice, cutPrice);
    const explainability = ensureExplainability(explainabilityReason, logicTags, confidencePayload);

    return {
      id: template.id,
      cardName: template.cardName,
      reason: explainability.reason,
      logicTags: explainability.tags,
      roles: template.roles,
      confidence: explainability.confidence,
      confidenceBreakdown: explainability.breakdown,
      unitPrice,
      suggestedCutName: cutName,
      suggestedCutPrice: cutPrice,
      deltaPrice,
      powerImpactScore: score,
      powerImpactLabel: impactLabel(score),
    };
  });

  // Apply ML personalization if enabled
  if (input.useMLPersonalization !== false) {
    try {
      const feedback = getUserFeedbackSystem();
      const ml = getMLRecommendationEngine();
      const userPrefs = feedback.getAllPreferences();
      const archetypes = input.detectedArchetypes || [];

      // Score with ML and re-rank
      const scored = items.map(item => ({
        item,
        score: ml.scoreRecommendation(item, userPrefs, archetypes),
      }));

      // Sort by ML score
      scored.sort((a, b) => b.score.finalScore - a.score.finalScore);

      // Update items with personalized reason
      items = scored.map(({ item, score }) => ({
        ...item,
        reason: score.reason || item.reason,
      }));
    } catch (error) {
      console.warn('[ML] Failed to personalize recommendations:', error);
    }
  }

  return {
    items,
    discoveryStats: {
      totalFound: discoveryResult.totalFound,
      fromCache: discoveryResult.fromCache,
      fromScryfall: discoveryResult.fromScryfall,
      queriesExecuted: discoveryResult.queriesExecuted,
      durationMs: discoveryResult.durationMs,
      errors: discoveryResult.errors,
    },
  };
}