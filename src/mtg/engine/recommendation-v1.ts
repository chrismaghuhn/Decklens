import { analyzeDeckDNA } from './analyzers.js';
import type { Deck, DeckEntry } from '../../shared/types.js';
import { CardDiscoveryEngine, type DiscoveryResult } from './card-discovery.js';
import type { DeckProfile as DiscoveryDeckProfile, DiscoveryRole, DiscoveryArchetype } from './discovery-query-builder.js';

export type MetaMode = 'casual' | 'balanced' | 'competitive' | 'budget';

export interface RecommendationCardMetrics {
  name: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  color_identity?: string[];
  prices?: {
    eur?: string | null;
    usd?: string | null;
  };
}

export interface RecommendationEngineInput {
  deck: Deck;
  collectionByName?: Record<string, number>;
  metaMode?: MetaMode;
  maxRecommendations?: number;
  cardMetricsByName?: Record<string, RecommendationCardMetrics>;
  useDynamicDiscovery?: boolean;
  discoveryConfig?: {
    maxCardsPerQuery?: number;
    maxTotalCards?: number;
    maxQueries?: number;
    minConfidence?: number;
  };
}

type RecommendationRole = 'ramp' | 'draw' | 'removal' | 'interaction' | 'mana_fix' | 'finisher' | 'protection';
type RecommendationCategory = 'synergy' | 'curve_fix' | 'mana_fix' | 'consistency';

export type RecSource = 'discovery' | 'archetype' | 'anti_meta' | 'learned' | 'staple';

interface AddCandidate {
  id: string;
  name: string;
  roles: RecommendationRole[];
  colorIdentity: string[];
  archetypes: Array<'aggro' | 'control' | 'combo' | 'midrange' | 'ramp' | 'tempo'>;
  tags: string[];
  cmc: number;
  manaFix: boolean;
  reason: string;
  source?: RecSource;
}

interface CutCandidate {
  name: string;
  score: number;
  cmc: number;
  roles: RecommendationRole[];
  reasons: string[];
}

interface DeckProfile {
  commanderNames: string[];
  commanderKeywords: Set<string>;
  dominantArchetype: 'aggro' | 'control' | 'combo' | 'midrange' | 'ramp' | 'tempo';
  avgCmc: number;
  roleCounts: Record<RecommendationRole, number>;
  deckColors: Set<string>;
  colorDemand: Record<string, number>;
  colorSources: Record<string, number>;
  colorDeficits: Array<{ color: string; demand: number; source: number; ratio: number }>;
  cutCandidates: CutCandidate[];
  dataCoverage: number;
  uniqueCardCount: number;
  totalCardCount: number;
}

export interface RecommendationHeuristicBreakdown {
  synergy: number;
  curveFix: number;
  manaFix: number;
  deadCardReduction: number;
  collectionFit: number;
}

export interface RecommendationPairAction {
  name: string;
  role: RecommendationRole[];
  cmc: number;
  estimatedPriceEur: number | null;
  ownedCount: number;
}

export interface RecommendationPairCut {
  name: string;
  cmc: number;
  reasons: string[];
}

export interface RecommendationV1Item {
  rank: number;
  id: string;
  category: RecommendationCategory;
  score: number;
  confidence: number;
  source: RecSource;
  add: RecommendationPairAction;
  cut: RecommendationPairCut | null;
  reasons: string[];
  heuristics: RecommendationHeuristicBreakdown;
}

export interface RecommendationEngineV1Response {
  version: 'dd201-v1' | 'dd201-v1-dynamic';
  generatedAt: string;
  metaMode: MetaMode;
  stats: {
    deckCards: number;
    uniqueCards: number;
    averageCmc: number;
    roleCounts: Record<RecommendationRole, number>;
    colorDemand: Record<string, number>;
    colorSources: Record<string, number>;
    colorDeficits: Array<{ color: string; demand: number; source: number; ratio: number }>;
    dominantArchetype: string;
    commanderNames: string[];
  };
  heuristics: {
    weights: RecommendationHeuristicBreakdown;
    minCutAddPairsTarget: number;
  };
  recommendations: RecommendationV1Item[];
  summary: {
    topN: number;
    pairedCount: number;
    minimumPairsTarget: number;
    hasMinimumPairs: boolean;
    isDataSufficientForMinimumPairs: boolean;
  };
}

const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;

const CORE_STAPLES = new Set([
  'sol ring',
  'arcane signet',
  'swords to plowshares',
  'path to exile',
  'rhystic study',
  'cyclonic rift',
  "nature's lore",
  'farseek',
  'beast within',
]);

const ROLE_TARGETS: Record<RecommendationRole, number> = {
  ramp: 10,
  draw: 10,
  removal: 9,
  interaction: 8,
  mana_fix: 8,
  finisher: 3,
  protection: 4,
};

const META_WEIGHTS: Record<MetaMode, RecommendationHeuristicBreakdown> = {
  casual: {
    synergy: 0.38,
    curveFix: 0.18,
    manaFix: 0.16,
    deadCardReduction: 0.18,
    collectionFit: 0.10,
  },
  balanced: {
    synergy: 0.32,
    curveFix: 0.22,
    manaFix: 0.20,
    deadCardReduction: 0.20,
    collectionFit: 0.06,
  },
  competitive: {
    synergy: 0.24,
    curveFix: 0.28,
    manaFix: 0.24,
    deadCardReduction: 0.20,
    collectionFit: 0.04,
  },
  budget: {
    synergy: 0.25,
    curveFix: 0.20,
    manaFix: 0.18,
    deadCardReduction: 0.17,
    collectionFit: 0.20,
  },
};

const ADD_LIBRARY: AddCandidate[] = [
  {
    id: 'sol-ring',
    name: 'Sol Ring',
    roles: ['ramp', 'mana_fix'],
    colorIdentity: [],
    archetypes: ['aggro', 'control', 'combo', 'midrange', 'ramp', 'tempo'],
    tags: ['fast_mana', 'artifact'],
    cmc: 1,
    manaFix: true,
    reason: 'Fast mana improves early turn tempo and keeps curve efficient.',
  },
  {
    id: 'arcane-signet',
    name: 'Arcane Signet',
    roles: ['ramp', 'mana_fix'],
    colorIdentity: [],
    archetypes: ['aggro', 'control', 'combo', 'midrange', 'ramp', 'tempo'],
    tags: ['artifact', 'mana_fix'],
    cmc: 2,
    manaFix: true,
    reason: 'Reliable color fixing and low-cost acceleration.',
  },
  {
    id: 'fellwar-stone',
    name: 'Fellwar Stone',
    roles: ['ramp', 'mana_fix'],
    colorIdentity: [],
    archetypes: ['aggro', 'control', 'combo', 'midrange', 'ramp', 'tempo'],
    tags: ['artifact', 'mana_fix'],
    cmc: 2,
    manaFix: true,
    reason: 'Improves fixing while keeping mana curve low.',
  },
  {
    id: 'natures-lore',
    name: "Nature's Lore",
    roles: ['ramp', 'mana_fix'],
    colorIdentity: ['G'],
    archetypes: ['midrange', 'ramp', 'combo'],
    tags: ['land_ramp'],
    cmc: 2,
    manaFix: true,
    reason: 'Efficient two-mana land ramp with fixing upside.',
  },
  {
    id: 'farseek',
    name: 'Farseek',
    roles: ['ramp', 'mana_fix'],
    colorIdentity: ['G'],
    archetypes: ['midrange', 'ramp', 'control'],
    tags: ['land_ramp'],
    cmc: 2,
    manaFix: true,
    reason: 'Smoothes mana base by finding non-basic typed lands.',
  },
  {
    id: 'three-visits',
    name: 'Three Visits',
    roles: ['ramp', 'mana_fix'],
    colorIdentity: ['G'],
    archetypes: ['midrange', 'ramp', 'combo'],
    tags: ['land_ramp'],
    cmc: 2,
    manaFix: true,
    reason: 'Low-curve land ramp that improves consistency.',
  },
  {
    id: 'mystic-remora',
    name: 'Mystic Remora',
    roles: ['draw'],
    colorIdentity: ['U'],
    archetypes: ['control', 'combo', 'tempo'],
    tags: ['spell_velocity', 'instant_sorcery'],
    cmc: 1,
    manaFix: false,
    reason: 'Early card flow and resource pressure in spell-heavy games.',
  },
  {
    id: 'rhystic-study',
    name: 'Rhystic Study',
    roles: ['draw'],
    colorIdentity: ['U'],
    archetypes: ['control', 'combo', 'midrange'],
    tags: ['card_advantage'],
    cmc: 3,
    manaFix: false,
    reason: 'Reliable card advantage engine for long games.',
  },
  {
    id: 'esper-sentinel',
    name: 'Esper Sentinel',
    roles: ['draw', 'protection'],
    colorIdentity: ['W'],
    archetypes: ['tempo', 'control', 'aggro'],
    tags: ['artifact', 'tax'],
    cmc: 1,
    manaFix: false,
    reason: 'Low-cost value engine that taxes interaction.',
  },
  {
    id: 'phyrexian-arena',
    name: 'Phyrexian Arena',
    roles: ['draw'],
    colorIdentity: ['B'],
    archetypes: ['control', 'midrange'],
    tags: ['card_advantage'],
    cmc: 3,
    manaFix: false,
    reason: 'Steady card advantage for attrition plans.',
  },
  {
    id: 'swords-to-plowshares',
    name: 'Swords to Plowshares',
    roles: ['removal', 'interaction'],
    colorIdentity: ['W'],
    archetypes: ['control', 'tempo', 'combo'],
    tags: ['efficient_removal'],
    cmc: 1,
    manaFix: false,
    reason: 'One-mana exile removal significantly improves interaction quality.',
  },
  {
    id: 'path-to-exile',
    name: 'Path to Exile',
    roles: ['removal', 'interaction'],
    colorIdentity: ['W'],
    archetypes: ['control', 'tempo', 'combo'],
    tags: ['efficient_removal'],
    cmc: 1,
    manaFix: false,
    reason: 'Cheap instant-speed interaction raises deck consistency.',
  },
  {
    id: 'beast-within',
    name: 'Beast Within',
    roles: ['removal', 'interaction'],
    colorIdentity: ['G'],
    archetypes: ['midrange', 'ramp', 'control'],
    tags: ['flexible_removal'],
    cmc: 3,
    manaFix: false,
    reason: 'Universal permanent answer covers interaction gaps.',
  },
  {
    id: 'chaos-warp',
    name: 'Chaos Warp',
    roles: ['removal', 'interaction'],
    colorIdentity: ['R'],
    archetypes: ['aggro', 'midrange', 'control'],
    tags: ['flexible_removal'],
    cmc: 3,
    manaFix: false,
    reason: 'Flexible removal improves red decks against problem permanents.',
  },
  {
    id: 'counterspell',
    name: 'Counterspell',
    roles: ['interaction', 'protection'],
    colorIdentity: ['U'],
    archetypes: ['control', 'combo', 'tempo'],
    tags: ['stack_interaction', 'instant_sorcery'],
    cmc: 2,
    manaFix: false,
    reason: 'Stack interaction protects your key turns.',
  },
  {
    id: 'swan-song',
    name: 'Swan Song',
    roles: ['interaction', 'protection'],
    colorIdentity: ['U'],
    archetypes: ['combo', 'control', 'tempo'],
    tags: ['stack_interaction'],
    cmc: 1,
    manaFix: false,
    reason: 'Ultra-efficient protection against key noncreature spells.',
  },
  {
    id: 'cyclonic-rift',
    name: 'Cyclonic Rift',
    roles: ['interaction', 'finisher'],
    colorIdentity: ['U'],
    archetypes: ['control', 'tempo', 'combo'],
    tags: ['board_swing'],
    cmc: 2,
    manaFix: false,
    reason: 'High-impact tempo swing that often closes games.',
  },
  {
    id: 'toxic-deluge',
    name: 'Toxic Deluge',
    roles: ['removal'],
    colorIdentity: ['B'],
    archetypes: ['control', 'combo', 'midrange'],
    tags: ['board_wipe'],
    cmc: 3,
    manaFix: false,
    reason: 'Efficient board reset stabilizes against aggressive tables.',
  },
  {
    id: 'farewell',
    name: 'Farewell',
    roles: ['removal', 'finisher'],
    colorIdentity: ['W'],
    archetypes: ['control', 'midrange'],
    tags: ['board_wipe'],
    cmc: 6,
    manaFix: false,
    reason: 'Versatile reset tool with graveyard and artifact coverage.',
  },
  {
    id: 'heroic-intervention',
    name: 'Heroic Intervention',
    roles: ['protection', 'interaction'],
    colorIdentity: ['G'],
    archetypes: ['midrange', 'ramp', 'combo'],
    tags: ['protection'],
    cmc: 2,
    manaFix: false,
    reason: 'Protects board investment and prevents blowout turns.',
  },
  {
    id: 'teferis-protection',
    name: "Teferi's Protection",
    roles: ['protection', 'interaction'],
    colorIdentity: ['W'],
    archetypes: ['control', 'combo', 'midrange'],
    tags: ['protection'],
    cmc: 3,
    manaFix: false,
    reason: 'High-leverage protection for combo and board-centric plans.',
  },
  {
    id: 'skullclamp',
    name: 'Skullclamp',
    roles: ['draw'],
    colorIdentity: [],
    archetypes: ['aggro', 'midrange', 'combo'],
    tags: ['token', 'card_advantage'],
    cmc: 1,
    manaFix: false,
    reason: 'Converts low-impact creatures or tokens into card advantage.',
  },
];

const ROLE_SCORE_CACHE = new WeakMap<RecommendationCardMetrics, RecommendationRole[]>();
const PRICE_EUR_CACHE = new WeakMap<RecommendationCardMetrics, number | null>();

function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num));
}

function normalizeCardName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function toLower(value: string | undefined): string {
  return (value || '').toLowerCase();
}

function parsePriceEur(card: RecommendationCardMetrics | undefined): number | null {
  if (!card) return null;
  if (PRICE_EUR_CACHE.has(card)) {
    return PRICE_EUR_CACHE.get(card) ?? null;
  }

  const raw = card?.prices?.eur;
  if (!raw) {
    PRICE_EUR_CACHE.set(card, null);
    return null;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    PRICE_EUR_CACHE.set(card, null);
    return null;
  }

  PRICE_EUR_CACHE.set(card, parsed);
  return parsed;
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function colorSetToRecord(colors: Set<string>, initial = 0): Record<string, number> {
  const record: Record<string, number> = {};
  for (const color of COLORS) {
    record[color] = colors.has(color) ? initial : 0;
  }
  return record;
}

function roleScoreFromCard(card: RecommendationCardMetrics | undefined): RecommendationRole[] {
  if (!card) return [];

  const cached = ROLE_SCORE_CACHE.get(card);
  if (cached) return cached;

  const roles: RecommendationRole[] = [];
  const text = toLower(card.oracle_text);
  const type = toLower(card.type_line);

  if (containsAny(text, ['add {', 'search your library for a land', 'treasure token'])) {
    roles.push('ramp');
  }
  if (containsAny(text, ['add one mana of any color', 'mana of any color', 'fixing'])) {
    roles.push('mana_fix');
  }
  if (containsAny(text, ['draw ', 'draw a card', 'draw two cards', 'whenever you draw'])) {
    roles.push('draw');
  }
  if (containsAny(text, ['destroy target', 'exile target', 'sacrifice each', 'destroy all'])) {
    roles.push('removal');
  }
  if (containsAny(text, ['counter target', 'prevent', 'can\'t cast', 'hexproof'])) {
    roles.push('interaction');
  }
  if (containsAny(text, ['indestructible', 'phase out', 'hexproof until'])) {
    roles.push('protection');
  }
  if (containsAny(text, ['you win the game', 'extra turn', 'combat phase'])) {
    roles.push('finisher');
  }

  if (type.includes('land') && containsAny(text, ['add {w}', 'add {u}', 'add {b}', 'add {r}', 'add {g}'])) {
    if (!roles.includes('mana_fix')) roles.push('mana_fix');
  }

  const dedupedRoles = [...new Set(roles)];
  ROLE_SCORE_CACHE.set(card, dedupedRoles);
  return dedupedRoles;
}

function extractCommanderKeywords(cards: RecommendationCardMetrics[]): Set<string> {
  const joined = cards.map((card) => toLower(card.oracle_text)).join(' ');
  const keys = new Set<string>();

  const checks: Array<[string, string[]]> = [
    ['artifact', ['artifact']],
    ['token', ['token', 'create']],
    ['graveyard', ['graveyard', 'from your graveyard']],
    ['sacrifice', ['sacrifice']],
    ['instant_sorcery', ['instant or sorcery', 'instant', 'sorcery']],
    ['counters', ['+1/+1 counter', 'counter on']],
    ['lifegain', ['gain life']],
    ['combat', ['combat damage', 'attacks']],
    ['draw', ['draw a card', 'draw']],
  ];

  for (const [keyword, terms] of checks) {
    if (terms.some((term) => joined.includes(term))) {
      keys.add(keyword);
    }
  }

  return keys;
}

function manaPipsFromCost(cost: string | undefined): Record<string, number> {
  const result: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  if (!cost) return result;

  const matches = cost.match(/\{([^}]+)\}/g) || [];
  for (const match of matches) {
    const symbol = match.replace(/[{}]/g, '').toUpperCase();
    for (const color of COLORS) {
      if (symbol === color || symbol.includes(`/${color}`) || symbol.includes(`${color}/`)) {
        result[color] += 1;
      }
    }
  }

  return result;
}

function colorsFromText(text: string): Set<string> {
  const set = new Set<string>();
  const matches = text.match(/\{([WUBRG])\}/gi) || [];
  for (const token of matches) {
    const color = token.replace(/[{}]/g, '').toUpperCase();
    if (COLORS.includes(color as (typeof COLORS)[number])) {
      set.add(color);
    }
  }
  return set;
}

function basicLandColor(name: string): string | null {
  const n = normalizeCardName(name);
  if (n === 'plains') return 'W';
  if (n === 'island') return 'U';
  if (n === 'swamp') return 'B';
  if (n === 'mountain') return 'R';
  if (n === 'forest') return 'G';
  return null;
}

function buildCardLookup(inputLookup: Record<string, RecommendationCardMetrics> | undefined): Map<string, RecommendationCardMetrics> {
  const map = new Map<string, RecommendationCardMetrics>();
  for (const [name, card] of Object.entries(inputLookup || {})) {
    map.set(normalizeCardName(name), card);
    map.set(normalizeCardName(card.name), card);
  }
  return map;
}

function getCardMetrics(name: string, lookup: Map<string, RecommendationCardMetrics>): RecommendationCardMetrics | undefined {
  return lookup.get(normalizeCardName(name));
}

function buildDeckProfile(deck: Deck, cardLookup: Map<string, RecommendationCardMetrics>): DeckProfile {
  const mainEntries = deck.main || [];
  const commanderEntries = deck.commander || [];
  const deckEntries = [...(deck.main || []), ...(deck.sideboard || []), ...(deck.commander || [])];

  let resolvedCards = 0;
  let totalCards = 0;
  let totalCmc = 0;

  const roleCounts: Record<RecommendationRole, number> = {
    ramp: 0,
    draw: 0,
    removal: 0,
    interaction: 0,
    mana_fix: 0,
    finisher: 0,
    protection: 0,
  };

  const commanderCards = commanderEntries
    .map((entry) => getCardMetrics(entry.name, cardLookup))
    .filter((card): card is RecommendationCardMetrics => Boolean(card));
  const commanderNames = commanderEntries.map((entry) => entry.name);
  const commanderKeywords = extractCommanderKeywords(commanderCards);

  const deckColors = new Set<string>();
  for (const entry of deckEntries) {
    const card = getCardMetrics(entry.name, cardLookup);
    const identity = card?.color_identity || [];
    for (const color of identity) {
      const upper = color.toUpperCase();
      if (COLORS.includes(upper as (typeof COLORS)[number])) {
        deckColors.add(upper);
      }
    }
  }

  const colorDemand = colorSetToRecord(deckColors, 0);
  const colorSources = colorSetToRecord(deckColors, 0);

  const uniqueCards = new Set<string>();

  for (const entry of deckEntries) {
    totalCards += entry.qty;
    uniqueCards.add(normalizeCardName(entry.name));
    const card = getCardMetrics(entry.name, cardLookup);
    if (!card) continue;

    resolvedCards += 1;
    totalCmc += (card.cmc || 0) * entry.qty;

    const roles = roleScoreFromCard(card);
    for (const role of roles) {
      roleCounts[role] += entry.qty;
    }
  }

  for (const entry of mainEntries) {
    const card = getCardMetrics(entry.name, cardLookup);
    const type = toLower(card?.type_line);
    const text = toLower(card?.oracle_text);
    const pips = manaPipsFromCost(card?.mana_cost);

    if (!type.includes('land')) {
      for (const color of COLORS) {
        colorDemand[color] += (pips[color] || 0) * entry.qty;
      }
    }

    const sourceColors = new Set<string>();
    for (const color of colorsFromText(text)) sourceColors.add(color);
    const basicColor = basicLandColor(entry.name);
    if (basicColor) sourceColors.add(basicColor);

    const anyColor = text.includes('any color') || text.includes('one mana of any color');
    if (anyColor) {
      for (const color of deckColors) {
        colorSources[color] += entry.qty;
      }
    }

    for (const color of sourceColors) {
      if (deckColors.size === 0 || deckColors.has(color)) {
        colorSources[color] += entry.qty;
      }
    }
  }

  const dna = analyzeDeckDNA(mainEntries, (cardName) => {
    const card = getCardMetrics(cardName, cardLookup);
    if (!card) return undefined;
    return {
      name: card.name,
      cmc: card.cmc,
      type_line: card.type_line,
      oracle_text: card.oracle_text,
    };
  });

  const colorDeficits = COLORS
    .filter((color) => deckColors.has(color))
    .map((color) => {
      const demand = colorDemand[color] || 0;
      const source = colorSources[color] || 0;
      const ratio = source <= 0 ? demand : demand / source;
      return { color, demand, source, ratio };
    })
    .filter((entry) => entry.demand > 0)
    .sort((a, b) => b.ratio - a.ratio)
    .filter((entry) => entry.ratio > 1.45 || entry.source < 6);

  const dataCoverage = deckEntries.length === 0
    ? 0
    : resolvedCards / deckEntries.length;

  const cutCandidates = buildCutCandidates(mainEntries, cardLookup, roleCounts, commanderKeywords, dna.dominant);

  return {
    commanderNames,
    commanderKeywords,
    dominantArchetype: dna.dominant,
    avgCmc: totalCards > 0 ? totalCmc / totalCards : 0,
    roleCounts,
    deckColors,
    colorDemand,
    colorSources,
    colorDeficits,
    cutCandidates,
    dataCoverage,
    uniqueCardCount: uniqueCards.size,
    totalCardCount: totalCards,
  };
}

function buildCutCandidates(
  mainEntries: DeckEntry[],
  cardLookup: Map<string, RecommendationCardMetrics>,
  roleCounts: Record<RecommendationRole, number>,
  commanderKeywords: Set<string>,
  dominantArchetype: string,
): CutCandidate[] {
  const cuts: CutCandidate[] = [];

  for (const entry of mainEntries) {
    const card = getCardMetrics(entry.name, cardLookup);
    const type = toLower(card?.type_line);
    const text = toLower(card?.oracle_text);
    const name = normalizeCardName(entry.name);
    const roles = roleScoreFromCard(card);
    const cmc = card?.cmc || 0;

    if (type.includes('land')) continue;
    if (CORE_STAPLES.has(name)) continue;

    let score = cmc * 1.4;
    const reasons: string[] = [];

    if (entry.qty > 1) {
      score += 0.5 * (entry.qty - 1);
      reasons.push(`High redundancy (${entry.qty} copies)`);
    }

    if (cmc >= 5 && (text.length < 28 || type.includes('creature') && !containsAny(text, ['draw', 'search', 'destroy', 'exile', 'counter']))) {
      score += 3.8;
      reasons.push('High mana cost with low immediate impact');
    }

    if (containsAny(text, ['destroy target artifact or enchantment', 'gain 3 life', 'target creature gets +1/+1 until'])) {
      score += 2.2;
      reasons.push('Situational or narrow effect');
    }

    if (roles.length === 0 && cmc >= 3) {
      score += 2.5;
      reasons.push('Low contribution to core game plan');
    }

    if (commanderKeywords.has('token') && type.includes('token')) {
      score -= 1.8;
    }

    if (dominantArchetype === 'control' && containsAny(text, ['target creature gets', 'attacks each combat'])) {
      score += 1.5;
      reasons.push('Weak fit for control archetype');
    }

    if (roles.includes('ramp') && roleCounts.ramp < ROLE_TARGETS.ramp) {
      score -= 2.5;
    }
    if (roles.includes('draw') && roleCounts.draw < ROLE_TARGETS.draw) {
      score -= 2.0;
    }
    if ((roles.includes('removal') || roles.includes('interaction'))
      && (roleCounts.removal + roleCounts.interaction) < (ROLE_TARGETS.removal + ROLE_TARGETS.interaction)) {
      score -= 1.6;
    }

    const finalScore = clamp(score, 0, 20);
    if (finalScore < 3.2) continue;

    cuts.push({
      name: entry.name,
      score: finalScore,
      cmc,
      roles,
      reasons: reasons.length > 0 ? reasons : ['Lower impact than alternative options'],
    });
  }

  if (cuts.length < 6) {
    const existing = new Set(cuts.map((cut) => normalizeCardName(cut.name)));
    const fallback: CutCandidate[] = [];

    for (const entry of mainEntries) {
      const key = normalizeCardName(entry.name);
      if (existing.has(key)) continue;
      if (CORE_STAPLES.has(key)) continue;

      const card = getCardMetrics(entry.name, cardLookup);
      const type = toLower(card?.type_line);
      if (type.includes('land')) continue;

      const cmc = card?.cmc || 0;
      const roles = roleScoreFromCard(card);
      const baseline = clamp(2.4 + cmc * 0.65 + Math.max(0, entry.qty - 1) * 0.45, 2, 12);

      fallback.push({
        name: entry.name,
        score: baseline,
        cmc,
        roles,
        reasons: ['Baseline consistency upgrade candidate'],
      });
    }

    fallback.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });

    for (const candidate of fallback) {
      if (cuts.length >= 8) break;
      cuts.push(candidate);
    }
  }

  cuts.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return cuts;
}

function roleNeed(role: RecommendationRole, roleCounts: Record<RecommendationRole, number>): number {
  const target = ROLE_TARGETS[role];
  return Math.max(0, target - roleCounts[role]);
}

function overlaps(setA: Set<string>, values: string[]): boolean {
  return values.some((value) => setA.has(value));
}

function scoreAddCandidate(
  candidate: AddCandidate,
  profile: DeckProfile,
  metaMode: MetaMode,
  cardLookup: Map<string, RecommendationCardMetrics>,
  collectionByName: Record<string, number>,
): {
  total: number;
  category: RecommendationCategory;
  confidence: number;
  components: RecommendationHeuristicBreakdown;
  reasons: string[];
  priceEur: number | null;
  ownedCount: number;
} {
  const card = getCardMetrics(candidate.name, cardLookup);
  const cmc = card?.cmc ?? candidate.cmc;
  const candidateRoles = card ? roleScoreFromCard(card) : candidate.roles;
  const effectiveRoles = candidateRoles.length > 0 ? candidateRoles : candidate.roles;

  let synergy = 10;
  const reasons: string[] = [];

  if (candidate.archetypes.includes(profile.dominantArchetype as AddCandidate['archetypes'][number])) {
    synergy += 28;
    reasons.push(`Matches ${profile.dominantArchetype} archetype`);
  }

  if (overlaps(profile.commanderKeywords, candidate.tags)) {
    synergy += 24;
    reasons.push('Synergizes with commander text patterns');
  }

  for (const role of effectiveRoles) {
    const need = roleNeed(role, profile.roleCounts);
    if (need > 0) {
      synergy += clamp(need * 4.5, 0, 22);
      reasons.push(`Addresses ${role} deficit`);
    }
  }

  const curveFixBase = profile.avgCmc >= 3.6
    ? (cmc <= 2 ? 85 : cmc <= 3 ? 58 : 28)
    : profile.avgCmc >= 3.1
      ? (cmc <= 3 ? 62 : 34)
      : (cmc <= 2 ? 40 : 22);

  let curveFix = curveFixBase;
  if (effectiveRoles.includes('ramp') && profile.avgCmc >= 3.3) {
    curveFix += 14;
  }
  if (effectiveRoles.includes('draw') && cmc <= 3) {
    curveFix += 8;
  }

  let manaFix = profile.colorDeficits.length > 0 ? 16 : 8;
  if (candidate.manaFix || effectiveRoles.includes('mana_fix')) {
    manaFix += profile.colorDeficits.length > 0 ? 44 : 20;
  }
  if (profile.colorDeficits.length > 0) {
    const deficitColors = new Set(profile.colorDeficits.map((d) => d.color));
    const colorOverlap = candidate.colorIdentity.some((color) => deficitColors.has(color));
    if (colorOverlap || candidate.colorIdentity.length === 0) {
      manaFix += 18;
    }
  }

  const topCut = profile.cutCandidates[0];
  let deadCardReduction = topCut ? clamp(topCut.score * 6, 18, 82) : 22;
  if (cmc <= 2) deadCardReduction += 6;
  if (effectiveRoles.includes('interaction')) deadCardReduction += 8;

  const ownedCount = collectionByName[normalizeCardName(candidate.name)] || 0;
  const collectionFit = ownedCount > 0 ? 100 : 28;
  if (ownedCount > 0) {
    reasons.push(`Already owned (${ownedCount})`);
  }

  const components: RecommendationHeuristicBreakdown = {
    synergy: clamp(synergy, 0, 100),
    curveFix: clamp(curveFix, 0, 100),
    manaFix: clamp(manaFix, 0, 100),
    deadCardReduction: clamp(deadCardReduction, 0, 100),
    collectionFit: clamp(collectionFit, 0, 100),
  };

  const weights = META_WEIGHTS[metaMode];
  let total = components.synergy * weights.synergy
    + components.curveFix * weights.curveFix
    + components.manaFix * weights.manaFix
    + components.deadCardReduction * weights.deadCardReduction
    + components.collectionFit * weights.collectionFit;

  const priceEur = parsePriceEur(card);
  if (metaMode === 'budget' && priceEur !== null && priceEur > 10) {
    total -= clamp((priceEur - 10) * 1.2, 0, 15);
    reasons.push('Budget mode penalty due to higher price');
  }

  const confidence = clamp(0.55 + profile.dataCoverage * 0.35 + (card ? 0.08 : 0), 0.45, 0.98);

  const categoryScores: Array<{ category: RecommendationCategory; score: number }> = [
    { category: 'synergy', score: components.synergy },
    { category: 'curve_fix', score: components.curveFix },
    { category: 'mana_fix', score: components.manaFix },
    { category: 'consistency', score: components.deadCardReduction },
  ];
  categoryScores.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
  const category = categoryScores[0].category;

  if (reasons.length === 0) {
    reasons.push('Improves overall deck consistency');
  }

  return {
    total: clamp(total, 0, 100),
    category,
    confidence,
    components,
    reasons,
    priceEur,
    ownedCount,
  };
}

function candidatePlayable(candidate: AddCandidate, deckColors: Set<string>): boolean {
  if (candidate.colorIdentity.length === 0) return true;
  if (deckColors.size === 0) return true;
  return candidate.colorIdentity.every((color) => deckColors.has(color));
}

function pickCutForCandidate(
  candidateRoles: RecommendationRole[],
  cutCandidates: CutCandidate[],
  usedCuts: Set<string>,
): CutCandidate | null {
  let best: CutCandidate | null = null;
  let bestScore = -Infinity;

  for (const cut of cutCandidates) {
    const key = normalizeCardName(cut.name);
    if (usedCuts.has(key)) continue;

    let compatibility = cut.score;
    if (cut.roles.some((role) => candidateRoles.includes(role))) {
      compatibility -= 1.6;
    }
    if (cut.cmc <= 2 && (candidateRoles.includes('ramp') || candidateRoles.includes('draw'))) {
      compatibility -= 1.2;
    }

    if (compatibility > bestScore) {
      bestScore = compatibility;
      best = cut;
    }
  }

  if (best) {
    usedCuts.add(normalizeCardName(best.name));
  }
  return best;
}

function normalizeCollectionMap(collection: Record<string, number> | undefined): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [name, qty] of Object.entries(collection || {})) {
    const key = normalizeCardName(name);
    if (!key) continue;
    const cleanQty = Number.isFinite(qty) ? Math.max(0, Math.trunc(qty)) : 0;
    if (cleanQty <= 0) continue;
    normalized[key] = (normalized[key] || 0) + cleanQty;
  }
  return normalized;
}

function normalizeMetaMode(metaMode: string | undefined): MetaMode {
  const normalized = (metaMode || 'balanced').toLowerCase();
  if (normalized === 'casual' || normalized === 'competitive' || normalized === 'budget' || normalized === 'balanced') {
    return normalized;
  }
  return 'balanced';
}

export function generateRecommendationEngineV1(input: RecommendationEngineInput): RecommendationEngineV1Response {
  const maxRecommendations = clamp(input.maxRecommendations || 5, 1, 5);
  const metaMode = normalizeMetaMode(input.metaMode);
  const cardLookup = buildCardLookup(input.cardMetricsByName);
  const collectionByName = normalizeCollectionMap(input.collectionByName);
  const deck = input.deck;

  const profile = buildDeckProfile(deck, cardLookup);

  const deckNames = new Set(deck.main.map((entry) => normalizeCardName(entry.name)));
  const rankedAdds = ADD_LIBRARY
    .filter((candidate) => !deckNames.has(normalizeCardName(candidate.name)))
    .filter((candidate) => candidatePlayable(candidate, profile.deckColors))
    .map((candidate) => {
      const scored = scoreAddCandidate(candidate, profile, metaMode, cardLookup, collectionByName);
      return {
        candidate,
        scored,
      };
    })
    .sort((a, b) => {
      if (b.scored.total !== a.scored.total) return b.scored.total - a.scored.total;
      return a.candidate.name.localeCompare(b.candidate.name);
    })
    .slice(0, Math.max(maxRecommendations + 2, 7));

  const usedCuts = new Set<string>();
  const recommendations: RecommendationV1Item[] = [];

  for (const ranked of rankedAdds) {
    if (recommendations.length >= maxRecommendations) break;
    const cut = pickCutForCandidate(ranked.candidate.roles, profile.cutCandidates, usedCuts);

    // Determine recommendation source
    const candidateSource: RecSource = ranked.candidate.source
      ?? (CORE_STAPLES.has(normalizeCardName(ranked.candidate.name)) ? 'staple' : 'archetype');

    recommendations.push({
      rank: recommendations.length + 1,
      id: ranked.candidate.id,
      category: ranked.scored.category,
      score: Number(ranked.scored.total.toFixed(2)),
      confidence: Number(ranked.scored.confidence.toFixed(3)),
      source: candidateSource,
      add: {
        name: ranked.candidate.name,
        role: ranked.candidate.roles,
        cmc: ranked.candidate.cmc,
        estimatedPriceEur: ranked.scored.priceEur,
        ownedCount: ranked.scored.ownedCount,
      },
      cut: cut
        ? {
            name: cut.name,
            cmc: Number(cut.cmc.toFixed(2)),
            reasons: cut.reasons,
          }
        : null,
      reasons: ranked.scored.reasons,
      heuristics: {
        synergy: Number(ranked.scored.components.synergy.toFixed(2)),
        curveFix: Number(ranked.scored.components.curveFix.toFixed(2)),
        manaFix: Number(ranked.scored.components.manaFix.toFixed(2)),
        deadCardReduction: Number(ranked.scored.components.deadCardReduction.toFixed(2)),
        collectionFit: Number(ranked.scored.components.collectionFit.toFixed(2)),
      },
    });
  }

  const minimumPairsTarget = 3;
  const potentialPairs = Math.min(maxRecommendations, profile.cutCandidates.length, recommendations.length);
  const isDataSufficientForMinimumPairs = potentialPairs >= minimumPairsTarget;

  if (isDataSufficientForMinimumPairs) {
    const additionalCuts = profile.cutCandidates.filter(
      (cut) => !usedCuts.has(normalizeCardName(cut.name)),
    );

    let pairedCountNow = recommendations.filter((rec) => rec.cut !== null).length;
    for (const recommendation of recommendations) {
      if (pairedCountNow >= minimumPairsTarget) break;
      if (recommendation.cut) continue;

      const fallbackCut = additionalCuts.shift();
      if (!fallbackCut) break;
      recommendation.cut = {
        name: fallbackCut.name,
        cmc: Number(fallbackCut.cmc.toFixed(2)),
        reasons: fallbackCut.reasons,
      };
      usedCuts.add(normalizeCardName(fallbackCut.name));
      pairedCountNow += 1;
    }
  }

  recommendations.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.add.name.localeCompare(b.add.name);
  });
  recommendations.forEach((item, index) => {
    item.rank = index + 1;
  });

  const pairedCount = recommendations.filter((item) => item.cut !== null).length;

  return {
    version: 'dd201-v1',
    generatedAt: new Date().toISOString(),
    metaMode,
    stats: {
      deckCards: profile.totalCardCount,
      uniqueCards: profile.uniqueCardCount,
      averageCmc: Number(profile.avgCmc.toFixed(3)),
      roleCounts: profile.roleCounts,
      colorDemand: profile.colorDemand,
      colorSources: profile.colorSources,
      colorDeficits: profile.colorDeficits,
      dominantArchetype: profile.dominantArchetype,
      commanderNames: profile.commanderNames,
    },
    heuristics: {
      weights: META_WEIGHTS[metaMode],
      minCutAddPairsTarget: minimumPairsTarget,
    },
    recommendations,
    summary: {
      topN: recommendations.length,
      pairedCount,
      minimumPairsTarget,
      hasMinimumPairs: pairedCount >= minimumPairsTarget || !isDataSufficientForMinimumPairs,
      isDataSufficientForMinimumPairs,
    },
  };
}

export function recommendationCandidateNames(): string[] {
  return ADD_LIBRARY.map((item) => item.name);
}

// ==================== DYNAMIC DISCOVERY INTEGRATION ====================

export interface DynamicRecommendationResult extends RecommendationEngineV1Response {
  discoveryStats?: {
    totalFound: number;
    fromCache: number;
    fromScryfall: number;
    queriesExecuted: number;
    durationMs: number;
    errors: string[];
  };
}

/**
 * Generate recommendations with dynamic card discovery
 * This extends the static ADD_LIBRARY with real-time Scryfall searches
 */
export async function generateRecommendationEngineV1Dynamic(
  input: RecommendationEngineInput
): Promise<DynamicRecommendationResult> {
  const maxRecommendations = clamp(input.maxRecommendations || 5, 1, 5);
  const metaMode = normalizeMetaMode(input.metaMode);
  const cardLookup = buildCardLookup(input.cardMetricsByName);
  const collectionByName = normalizeCollectionMap(input.collectionByName);
  const deck = input.deck;

  const profile = buildDeckProfile(deck, cardLookup);
  const deckNames = new Set(deck.main.map((entry) => normalizeCardName(entry.name)));

  // Initialize discovery engine
  const discoveryEngine = new CardDiscoveryEngine({
    maxCardsPerQuery: input.discoveryConfig?.maxCardsPerQuery ?? 15,
    maxTotalCards: input.discoveryConfig?.maxTotalCards ?? 100,
    maxQueries: input.discoveryConfig?.maxQueries ?? 5,
    minConfidence: input.discoveryConfig?.minConfidence ?? 0.3,
    excludeCards: deckNames,
    collectionByName,
    useCache: true,
  });

  // Build discovery profile
  const discoveryProfile: DiscoveryDeckProfile = {
    colors: profile.deckColors,
    avgCmc: profile.avgCmc,
    roleCounts: profile.roleCounts as Record<DiscoveryRole, number>,
    dominantArchetype: profile.dominantArchetype as DiscoveryArchetype,
    commanderKeywords: profile.commanderKeywords,
    format: 'commander',
  };

  // Run dynamic discovery
  const discoveryResult = await discoveryEngine.discover(discoveryProfile);

  // Convert discovered cards to AddCandidates
  const dynamicCandidates: AddCandidate[] = discoveryResult.cards.map(card => ({
    id: card.id,
    name: card.name,
    roles: card.roles as RecommendationRole[],
    colorIdentity: card.colorIdentity,
    archetypes: card.archetypes as Array<'aggro' | 'control' | 'combo' | 'midrange' | 'ramp' | 'tempo'>,
    tags: card.tags,
    cmc: card.cmc,
    manaFix: card.manaFix,
    reason: card.reason,
    source: 'discovery' as RecSource,
  }));

  // Merge with static ADD_LIBRARY (for fallback)
  const allCandidates = [...ADD_LIBRARY, ...dynamicCandidates];

  // Score all candidates
  const rankedAdds = allCandidates
    .filter((candidate) => !deckNames.has(normalizeCardName(candidate.name)))
    .filter((candidate) => candidatePlayable(candidate, profile.deckColors))
    .map((candidate) => {
      const scored = scoreAddCandidate(candidate, profile, metaMode, cardLookup, collectionByName);
      return {
        candidate,
        scored,
      };
    })
    .sort((a, b) => {
      if (b.scored.total !== a.scored.total) return b.scored.total - a.scored.total;
      return a.candidate.name.localeCompare(b.candidate.name);
    })
    .slice(0, Math.max(maxRecommendations + 2, 7));

  // Build recommendations
  const usedCuts = new Set<string>();
  const recommendations: RecommendationV1Item[] = [];

  for (const ranked of rankedAdds) {
    if (recommendations.length >= maxRecommendations) break;
    const cut = pickCutForCandidate(ranked.candidate.roles, profile.cutCandidates, usedCuts);

    // Determine recommendation source
    const dynSource: RecSource = ranked.candidate.source
      ?? (CORE_STAPLES.has(normalizeCardName(ranked.candidate.name)) ? 'staple' : 'archetype');

    recommendations.push({
      rank: recommendations.length + 1,
      id: ranked.candidate.id,
      category: ranked.scored.category,
      score: Number(ranked.scored.total.toFixed(2)),
      confidence: Number(ranked.scored.confidence.toFixed(3)),
      source: dynSource,
      add: {
        name: ranked.candidate.name,
        role: ranked.candidate.roles,
        cmc: ranked.candidate.cmc,
        estimatedPriceEur: ranked.scored.priceEur,
        ownedCount: ranked.scored.ownedCount,
      },
      cut: cut
        ? {
            name: cut.name,
            cmc: Number(cut.cmc.toFixed(2)),
            reasons: cut.reasons,
          }
        : null,
      reasons: ranked.scored.reasons,
      heuristics: {
        synergy: Number(ranked.scored.components.synergy.toFixed(2)),
        curveFix: Number(ranked.scored.components.curveFix.toFixed(2)),
        manaFix: Number(ranked.scored.components.manaFix.toFixed(2)),
        deadCardReduction: Number(ranked.scored.components.deadCardReduction.toFixed(2)),
        collectionFit: Number(ranked.scored.components.collectionFit.toFixed(2)),
      },
    });
  }

  // Ensure minimum pairs
  const minimumPairsTarget = 3;
  const potentialPairs = Math.min(maxRecommendations, profile.cutCandidates.length, recommendations.length);
  const isDataSufficientForMinimumPairs = potentialPairs >= minimumPairsTarget;

  if (isDataSufficientForMinimumPairs) {
    const additionalCuts = profile.cutCandidates.filter(
      (cut) => !usedCuts.has(normalizeCardName(cut.name)),
    );

    let pairedCountNow = recommendations.filter((rec) => rec.cut !== null).length;
    for (const recommendation of recommendations) {
      if (pairedCountNow >= minimumPairsTarget) break;
      if (recommendation.cut) continue;

      const fallbackCut = additionalCuts.shift();
      if (!fallbackCut) break;
      recommendation.cut = {
        name: fallbackCut.name,
        cmc: Number(fallbackCut.cmc.toFixed(2)),
        reasons: fallbackCut.reasons,
      };
      usedCuts.add(normalizeCardName(fallbackCut.name));
      pairedCountNow += 1;
    }
  }

  recommendations.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.add.name.localeCompare(b.add.name);
  });
  recommendations.forEach((item, index) => {
    item.rank = index + 1;
  });

  const pairedCount = recommendations.filter((item) => item.cut !== null).length;

  return {
    version: 'dd201-v1-dynamic',
    generatedAt: new Date().toISOString(),
    metaMode,
    stats: {
      deckCards: profile.totalCardCount,
      uniqueCards: profile.uniqueCardCount,
      averageCmc: Number(profile.avgCmc.toFixed(3)),
      roleCounts: profile.roleCounts,
      colorDemand: profile.colorDemand,
      colorSources: profile.colorSources,
      colorDeficits: profile.colorDeficits,
      dominantArchetype: profile.dominantArchetype,
      commanderNames: profile.commanderNames,
    },
    heuristics: {
      weights: META_WEIGHTS[metaMode],
      minCutAddPairsTarget: minimumPairsTarget,
    },
    recommendations,
    summary: {
      topN: recommendations.length,
      pairedCount,
      minimumPairsTarget,
      hasMinimumPairs: pairedCount >= minimumPairsTarget || !isDataSufficientForMinimumPairs,
      isDataSufficientForMinimumPairs,
    },
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
