import type { Deck, DeckEntry } from '../../shared/types.js';
import type { PriceQuote } from '../../shared/price-adapter.js';
import {
  buildRecommendations,
  type RecommendationCardSnapshot,
} from '../recommendation-impact.js';

export type MatchupArchetype = 'aggro' | 'control' | 'combo';
export type MatchupMetaMode = 'local' | 'fnm' | 'commander-pod';
type MatchupRole = 'ramp' | 'draw' | 'removal' | 'interaction' | 'protection' | 'finisher';

interface CardProfile {
  normalizedName: string;
  cmc: number;
  type: string;
  text: string;
  roles: Set<MatchupRole>;
  isInstant: boolean;
  isSorcery: boolean;
  isLand: boolean;
  isSweeper: boolean;
  isNarrowRemoval: boolean;
}

interface ScoredCandidate {
  entry: DeckEntry;
  profile: CardProfile;
  score: number;
}

interface CorePlanPhase {
  early: string[];
  mid: string[];
  late: string[];
}

export interface MatchupMove {
  card: string;
  qty: number;
  reason: string;
}

export interface MatchupFallbackPlan {
  mulligan: string[];
  priorities: string[];
  interactionWindows: string[];
}

export interface MatchupSideboardPlan {
  available: boolean;
  in: MatchupMove[];
  out: MatchupMove[];
  fallback?: MatchupFallbackPlan;
}

export interface MatchupPlan {
  matchup: MatchupArchetype;
  title: string;
  relevanceScore: number;
  threats: string[];
  wincons: string[];
  corePlan: CorePlanPhase;
  sequencingPriorities: string[];
  interactionPriorities: string[];
  sideboard: MatchupSideboardPlan;
  preBoardPlan: string[];
  postBoardPlan: string[];
}

export interface MatchupGuide {
  schemaVersion: 'matchup-guide.v1';
  metaMode: MatchupMetaMode;
  generatedAt: string;
  minMatchupsSatisfied: boolean;
  fallbackReasons: string[];
  cardDataCoverage: number;
  weights: {
    modeWeight: number;
    roleGap: number;
    curvePressure: number;
    dataQuality: number;
  };
  hasSideboard: boolean;
  plans: MatchupPlan[];
  inOutRulebook: string[];
  recommendationRoleBias: Record<MatchupRole, number>;
}

export interface BuildMatchupGuideInput {
  deck: Deck;
  resolveCard: (cardName: string) => RecommendationCardSnapshot | null | undefined;
  maxSideboardMovesPerMatchup?: number;
  metaMode?: MatchupMetaMode;
  minPlans?: number;
}

const MATCHUPS: MatchupArchetype[] = ['aggro', 'control', 'combo'];
const ROLES: MatchupRole[] = ['ramp', 'draw', 'removal', 'interaction', 'protection', 'finisher'];

const MATCHUP_TITLE: Record<MatchupArchetype, string> = {
  aggro: 'vs Aggro',
  control: 'vs Control',
  combo: 'vs Combo',
};

const RELEVANCE_WEIGHTS = {
  modeWeight: 0.5,
  roleGap: 0.25,
  curvePressure: 0.15,
  dataQuality: 0.1,
} as const;

const META_MODE_PRIORITY: Record<MatchupMetaMode, Record<MatchupArchetype, number>> = {
  local: {
    aggro: 0.88,
    control: 0.62,
    combo: 0.72,
  },
  fnm: {
    aggro: 0.7,
    control: 0.85,
    combo: 0.82,
  },
  'commander-pod': {
    aggro: 0.45,
    control: 0.74,
    combo: 0.93,
  },
};

const MATCHUP_ROLE_PRIORITY: Record<MatchupArchetype, Record<MatchupRole, number>> = {
  aggro: {
    ramp: 0.5,
    draw: 0.7,
    removal: 3.2,
    interaction: 2.6,
    protection: 1.3,
    finisher: 0.6,
  },
  control: {
    ramp: 1,
    draw: 2,
    removal: 1.2,
    interaction: 2.2,
    protection: 2.4,
    finisher: 1.8,
  },
  combo: {
    ramp: 0.6,
    draw: 1.2,
    removal: 1.4,
    interaction: 3.3,
    protection: 1.9,
    finisher: 0.7,
  },
};

const MATCHUP_THREATS: Record<MatchupArchetype, string[]> = {
  aggro: [
    'Low-curve pressure with haste and combat-trick turns.',
    'Snowball creatures that punish tap-out sequencing.',
    'Reach damage from hand that shortens stabilization windows.',
  ],
  control: [
    'Counterspell and sweeper shells that trade up on mana.',
    'Card-advantage engines that take over long games.',
    'One resilient finisher protected by open mana.',
  ],
  combo: [
    'Tutor and cantrip chains assembling deterministic kill turns.',
    'Protection layers forcing stack fights on narrow windows.',
    'Fast mana starts that compress your interaction timeline.',
  ],
};

const MATCHUP_WINCONS: Record<MatchupArchetype, string[]> = {
  aggro: [
    'Convert early board lead into lethal before turn 6.',
    'Finish from medium life totals with burn plus combat.',
  ],
  control: [
    'Reset board, then win behind one protected threat.',
    'Out-resource the opponent until only high-impact topdecks matter.',
  ],
  combo: [
    'Resolve enabler plus payoff in one protected turn cycle.',
    'Force through deterministic loop with backup interaction.',
  ],
};

const MATCHUP_CORE_PLAN: Record<MatchupMetaMode, Record<MatchupArchetype, CorePlanPhase>> = {
  local: {
    aggro: {
      early: [
        'Keep one- and two-mana interaction in opening hands.',
        'Trade life only when crack-back is controlled.',
      ],
      mid: [
        'Stabilize board before investing into slow engines.',
        'Convert to race mode only after removing haste pressure.',
      ],
      late: [
        'Close quickly once parity is reached to avoid topdeck burn.',
      ],
    },
    control: {
      early: [
        'Deploy staggered threats to avoid sweep overcommitment.',
        'Pressure with medium-value spells first to map answers.',
      ],
      mid: [
        'Use end-step windows to resolve key spells.',
        'Preserve one must-answer threat for post-sweeper turns.',
      ],
      late: [
        'Switch to draw-go posture only when ahead on board and cards.',
      ],
    },
    combo: {
      early: [
        'Mulligan for fast interaction plus stable mana.',
        'Pressure setup pieces before payoff windows open.',
      ],
      mid: [
        'Represent instant-speed answers each likely kill turn.',
        'Spend disruption on tutors and enablers, not bait cantrips.',
      ],
      late: [
        'Keep one hard stop for the final all-in combo turn.',
      ],
    },
  },
  fnm: {
    aggro: {
      early: [
        'Prioritize cheap interaction and untapped mana sequencing.',
        'Do not keep hands that miss board impact by turn 2.',
      ],
      mid: [
        'Trade cards for tempo until combat math stabilizes.',
        'Use sweepers only when they reset meaningful pressure.',
      ],
      late: [
        'Turn corner aggressively once opponent resources are exhausted.',
      ],
    },
    control: {
      early: [
        'Force early answers with medium threats, keep premium threats in reserve.',
        'Play around open blue mana by splitting commitments across turns.',
      ],
      mid: [
        'Fight for draw engines and walkers before secondary value.',
        'Protect key threat only on decisive turns.',
      ],
      late: [
        'Lock in advantage by passing with protection mana up.',
      ],
    },
    combo: {
      early: [
        'Respect turn-3/4 combo windows in mulligan decisions.',
        'Sequence pressure while preserving stack interaction.',
      ],
      mid: [
        'Track tutor chains and break the shortest kill line.',
        'Use medium interaction to bait protection before hard stops.',
      ],
      late: [
        'Preserve one interaction piece for combo reload attempts.',
      ],
    },
  },
  'commander-pod': {
    aggro: {
      early: [
        'Interact with the player presenting fastest combat burst.',
        'Develop mana without becoming the easiest crack-back target.',
      ],
      mid: [
        'Preserve table tempo parity and avoid overextending into wipes.',
        'Prioritize blockers and broad answers over narrow value lines.',
      ],
      late: [
        'Close through the safest lane once shields drop across table.',
      ],
    },
    control: {
      early: [
        'Stagger engines across turns to avoid one-for-many wipes.',
        'Probe counter windows with lower-priority spells first.',
      ],
      mid: [
        'Push key permanents when control mana is constrained by table pressure.',
        'Keep one recursive or sticky threat for long grind turns.',
      ],
      late: [
        'Align with table pressure before committing final win attempt.',
      ],
    },
    combo: {
      early: [
        'Map shortest deterministic kill line at the table immediately.',
        'Preserve interaction for high-probability combo players first.',
      ],
      mid: [
        'Force combo attempts into visible open mana windows.',
        'Coordinate disruption timing around tutor and payoff steps.',
      ],
      late: [
        'Hold one premium answer for back-to-back combo attempts.',
      ],
    },
  },
};

const MATCHUP_SEQUENCING_PRIORITIES: Record<MatchupMetaMode, Record<MatchupArchetype, string[]>> = {
  local: {
    aggro: ['Lead untapped mana first.', 'Deploy blockers before greedy engines.', 'Avoid dead tap-out turns.'],
    control: ['Sequence threats least to most irreplaceable.', 'Act on end step where possible.', 'Force counters before your key spell.'],
    combo: ['Hold mana for stack fights.', 'Pressure first, then pass with answers.', 'Do not tap out near kill turns.'],
  },
  fnm: {
    aggro: ['Preserve cheap removal for haste/lord turns.', 'Delay sweepers until value threshold.', 'Pivot to pressure after stabilize.'],
    control: ['Sandbag backup threats post-wipe.', 'Split commits across turns.', 'Time protection for decisive stacks.'],
    combo: ['Track mana breakpoints each turn.', 'Bait protection with medium interaction.', 'Shorten their setup with proactive clock.'],
  },
  'commander-pod': {
    aggro: ['Interact on highest damage seat first.', 'Keep parity over isolated value.', 'Do not become default crack-back target.'],
    control: ['Stagger threats across players.', 'Keep shields partly up while drawing.', 'Push when control seat is resource-taxed.'],
    combo: ['Represent stack interaction every cycle.', 'Sequence pressure before shields-down turns.', 'Reserve one flexible emergency answer.'],
  },
};

const MATCHUP_INTERACTION_PRIORITIES: Record<MatchupMetaMode, Record<MatchupArchetype, string[]>> = {
  local: {
    aggro: ['Kill haste/lord pieces before damage spikes.', 'Use sweepers for real resets.', 'Keep one cheap answer for alpha turns.'],
    control: ['Fight over sweepers and draw engines first.', 'Do not waste hard counters on fluff.', 'Save flexible answers for finishers.'],
    combo: ['Disrupt tutor/enabler windows first.', 'Hold instant interaction for payoff turns.', 'Break protection layer before own threat.'],
  },
  fnm: {
    aggro: ['Answer snowball creatures immediately.', 'Respect post-board burn reach.', 'Avoid premium removal on replaceable bodies.'],
    control: ['Counter card engines and resets first.', 'Protect key threat only when it matters.', 'Preserve one hard answer for late stack fights.'],
    combo: ['Counter rituals and tutors enabling same-turn kills.', 'Use disruption proactively when windows narrow.', 'Prioritize stack interaction over spot removal.'],
  },
  'commander-pod': {
    aggro: ['Spend interaction where table damage is highest.', 'Keep one reset for multi-opponent swings.', 'Trade efficiently to preserve politics leverage.'],
    control: ['Prioritize repeated value engines.', 'Keep answer for instant-speed board reset turns.', 'Use stack interaction to protect tempo-positive plays.'],
    combo: ['Track and answer shortest deterministic line.', 'Force combo player through open mana.', 'Reserve premium answers for payoff+protection stacks.'],
  },
};

const NO_SIDEBOARD_POST_BOARD_PLAN: Record<MatchupArchetype, string[]> = {
  aggro: [
    'No sideboard available: tighten mulligans for early board impact.',
    'Treat life total as a resource only after stabilization.',
    'Sequence interaction around combat breakpoints and haste windows.',
  ],
  control: [
    'No sideboard available: adjust role via sequencing and threat pacing.',
    'Delay non-essential spells to force end-step exchanges.',
    'Preserve at least one protection line for pivotal turns.',
  ],
  combo: [
    'No sideboard available: mulligan for stack interaction and mana.',
    'Spend disruption on shortest opponent combo line.',
    'Track and respect mana breakpoints each turn cycle.',
  ],
};

const FALLBACK_PLAN: Record<MatchupArchetype, MatchupFallbackPlan> = {
  aggro: {
    mulligan: [
      'Keep hands that affect board by turn 2 and have stable mana.',
      'Ship slow value hands without early board presence.',
    ],
    priorities: [
      'Prioritize cheap removal and blockers over draw engines.',
      'Trade life for tempo only when crack-back is controlled.',
    ],
    interactionWindows: [
      'Use removal on haste/lord effects before damage spikes.',
      'Hold sweepers until they reset at least two threats.',
    ],
  },
  control: {
    mulligan: [
      'Keep hands with layered threats and one support spell.',
      'Avoid all-in hands losing to one sweeper/counter exchange.',
    ],
    priorities: [
      'Apply staggered pressure instead of flooding the board.',
      'Use draw spells to hit land drops and must-answer threats.',
    ],
    interactionWindows: [
      'Fight on end step whenever possible.',
      'Protect key threats only on decisive turns.',
    ],
  },
  combo: {
    mulligan: [
      'Keep hands with interaction plus pressure, even at lower value.',
      'Ship expensive hands that miss turns 2-4.',
    ],
    priorities: [
      'Identify opponent kill turn and reserve interaction.',
      'Prioritize disruption over incremental board value.',
    ],
    interactionWindows: [
      'Interrupt tutor and enabler steps before payoff resolves.',
      'Force combo player into open-mana exchanges.',
    ],
  },
};

const PROTECTED_STAPLES = new Set([
  'sol ring',
  'arcane signet',
  'rhystic study',
  'cyclonic rift',
  'swords to plowshares',
  'path to exile',
]);

const SIDEBOARD_RULEBOOK: string[] = [
  'Role-first scoring: sideboard cards are ranked by matchup role priority (removal/interaction/protection/etc.).',
  'Recommendation alignment: top recommendation roles increase keep priority and break score ties.',
  'Tempo-aware cuts: high CMC, narrow, and low-impact cards get cut first per matchup pressure profile.',
  'Quantity parity: total cards in always equals total cards out for each matchup plan.',
  'No-sideboard fallback: switch to mulligan discipline, priority sequencing, and interaction window planning.',
];

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function cardHas(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function totalQty(entries: DeckEntry[]): number {
  return entries.reduce((sum, entry) => sum + Math.max(0, entry.qty), 0);
}

function totalMoveQty(moves: MatchupMove[]): number {
  return moves.reduce((sum, move) => sum + move.qty, 0);
}

function createMissingPriceQuote(cardName: string): PriceQuote {
  return {
    cardName,
    amount: null,
    currency: null,
    source: 'matchup-guide',
    asOf: null,
    stale: false,
    status: 'missing_price',
  };
}

function classifyCardProfile(
  entry: DeckEntry,
  resolveCard: (cardName: string) => RecommendationCardSnapshot | null | undefined,
): CardProfile {
  const card = resolveCard(entry.name) || null;
  const cmc = card?.cmc ?? 3;
  const type = (card?.type_line || '').toLowerCase();
  const text = (card?.oracle_text || '').toLowerCase();
  const roles = new Set<MatchupRole>();

  if (cardHas(text, ['add {', 'search your library for a land', 'mana of any color'])) roles.add('ramp');
  if (cardHas(text, ['draw ', 'draw a card', 'draw two cards', 'whenever you draw'])) roles.add('draw');
  if (cardHas(text, ['destroy target', 'exile target', 'damage to any target', 'target creature gets -', 'sacrifice target'])) roles.add('removal');
  if (cardHas(text, ['counter target', "can't cast", 'discard a card', 'exile target spell']) || type.includes('instant')) roles.add('interaction');
  if (cardHas(text, ['hexproof', 'indestructible', 'protection from', 'phase out', "can't be countered"])) roles.add('protection');
  if (cardHas(text, ['you win the game', 'opponent loses the game']) || (cmc >= 5 && (type.includes('creature') || type.includes('planeswalker')))) {
    roles.add('finisher');
  }

  const isSweeper = cardHas(text, [
    'destroy all creatures',
    'each creature',
    'all creatures get',
    'each nonland permanent',
    'exile all creatures',
    'return all creatures',
  ]);
  const isNarrowRemoval = cardHas(text, ['destroy target creature', 'exile target creature'])
    && !cardHas(text, ['target permanent', 'any target']);

  return {
    normalizedName: normalizeName(card?.name || entry.name),
    cmc,
    type,
    text,
    roles,
    isInstant: type.includes('instant'),
    isSorcery: type.includes('sorcery'),
    isLand: type.includes('land'),
    isSweeper,
    isNarrowRemoval,
  };
}

function createRoleBiasRecord(): Record<MatchupRole, number> {
  return {
    ramp: 0,
    draw: 0,
    removal: 0,
    interaction: 0,
    protection: 0,
    finisher: 0,
  };
}

function buildRecommendationRoleBias(
  deck: Deck,
  resolveCard: (cardName: string) => RecommendationCardSnapshot | null | undefined,
): Record<MatchupRole, number> {
  const roleBias = createRoleBiasRecord();
  if (deck.main.length === 0) return roleBias;

  const recommendations = buildRecommendations({
    deckMain: deck.main.map((entry) => ({ name: entry.name, qty: entry.qty })),
    getCard: (cardName) => resolveCard(cardName) || null,
    getPrice: (cardName) => createMissingPriceQuote(cardName),
    maxRecommendations: 8,
  });

  if (recommendations.length === 0) return roleBias;

  for (let idx = 0; idx < recommendations.length; idx++) {
    const recommendation = recommendations[idx];
    const rankWeight = (recommendations.length - idx) / recommendations.length;
    for (const role of recommendation.roles) {
      roleBias[role] += rankWeight;
    }
  }

  const maxSignal = Math.max(...ROLES.map((role) => roleBias[role]), 0);
  if (maxSignal <= 0) return roleBias;

  for (const role of ROLES) {
    roleBias[role] = roleBias[role] / maxSignal;
  }
  return roleBias;
}

function estimateCardDataCoverage(deck: Deck, resolveCard: (cardName: string) => RecommendationCardSnapshot | null | undefined): number {
  const allEntries = [...deck.main, ...deck.sideboard, ...deck.commander];
  const total = allEntries.reduce((sum, entry) => sum + Math.max(0, entry.qty), 0);
  if (total <= 0) return 0;
  let resolved = 0;
  for (const entry of allEntries) {
    if (resolveCard(entry.name)) {
      resolved += Math.max(0, entry.qty);
    }
  }
  return clamp(resolved / total, 0, 1);
}

function buildMainDeckRoleDensity(
  deck: Deck,
  resolveCard: (cardName: string) => RecommendationCardSnapshot | null | undefined,
): Record<MatchupRole, number> {
  const counts = createRoleBiasRecord();
  for (const entry of deck.main) {
    const profile = classifyCardProfile(entry, resolveCard);
    for (const role of profile.roles) {
      counts[role] += Math.max(0, entry.qty);
    }
  }
  const maxCount = Math.max(...ROLES.map((role) => counts[role]), 0);
  if (maxCount <= 0) return counts;
  for (const role of ROLES) {
    counts[role] = clamp(counts[role] / maxCount, 0, 1);
  }
  return counts;
}

function averageMainDeckCmc(
  deck: Deck,
  resolveCard: (cardName: string) => RecommendationCardSnapshot | null | undefined,
): number {
  let totalCmc = 0;
  let totalCards = 0;
  for (const entry of deck.main) {
    const profile = classifyCardProfile(entry, resolveCard);
    const qty = Math.max(0, entry.qty);
    if (qty <= 0 || profile.isLand) continue;
    totalCards += qty;
    totalCmc += profile.cmc * qty;
  }
  if (totalCards <= 0) return 0;
  return totalCmc / totalCards;
}

function matchupRoleGap(
  matchup: MatchupArchetype,
  roleBias: Record<MatchupRole, number>,
  roleDensity: Record<MatchupRole, number>,
): number {
  const priorities = MATCHUP_ROLE_PRIORITY[matchup];
  const maxPriority = Math.max(...ROLES.map((role) => priorities[role]), 1);
  let gap = 0;

  for (const role of ROLES) {
    const need = priorities[role] / maxPriority;
    const available = clamp((roleBias[role] * 0.6) + (roleDensity[role] * 0.4), 0, 1);
    gap += Math.max(0, need - available);
  }

  return clamp(gap / ROLES.length, 0, 1);
}

function matchupCurvePressure(matchup: MatchupArchetype, avgCmc: number): number {
  if (matchup === 'aggro') {
    return clamp((avgCmc - 2.8) / 2, 0, 1);
  }
  if (matchup === 'control') {
    return clamp((3.1 - avgCmc) / 2, 0, 1);
  }
  return clamp((avgCmc - 3.0) / 1.8, 0, 1);
}

function matchupRelevanceScore(
  matchup: MatchupArchetype,
  mode: MatchupMetaMode,
  roleGap: number,
  avgCmc: number,
  dataCoverage: number,
): number {
  const modeWeight = META_MODE_PRIORITY[mode][matchup];
  const curvePressure = matchupCurvePressure(matchup, avgCmc);
  const dataQuality = 1 - dataCoverage;
  const score =
    (modeWeight * RELEVANCE_WEIGHTS.modeWeight)
    + (roleGap * RELEVANCE_WEIGHTS.roleGap)
    + (curvePressure * RELEVANCE_WEIGHTS.curvePressure)
    + (dataQuality * RELEVANCE_WEIGHTS.dataQuality);
  return Math.round(clamp(score, 0, 1) * 100);
}

function buildCorePlan(matchup: MatchupArchetype, mode: MatchupMetaMode, lowCoverage: boolean): CorePlanPhase {
  const plan = MATCHUP_CORE_PLAN[mode][matchup];
  if (!lowCoverage) {
    return {
      early: [...plan.early],
      mid: [...plan.mid],
      late: [...plan.late],
    };
  }

  return {
    early: [...plan.early, 'Card data coverage is partial; bias toward flexible keeps.'],
    mid: [...plan.mid, 'Favor mana-efficient lines when unknown card text is present.'],
    late: [...plan.late, 'Preserve one broad answer for unknown top-end threats.'],
  };
}

function buildPreBoardPlan(matchup: MatchupArchetype, mode: MatchupMetaMode): string[] {
  const phase = MATCHUP_CORE_PLAN[mode][matchup];
  return [...phase.early, ...phase.mid].slice(0, 3);
}

function buildPostBoardPlan(matchup: MatchupArchetype, mode: MatchupMetaMode, hasSideboardPlan: boolean): string[] {
  if (!hasSideboardPlan) {
    return NO_SIDEBOARD_POST_BOARD_PLAN[matchup].slice(0, 3);
  }
  const phase = MATCHUP_CORE_PLAN[mode][matchup];
  return [...phase.mid, ...phase.late].slice(0, 3);
}

function primaryRole(matchup: MatchupArchetype, profile: CardProfile): MatchupRole | null {
  let bestRole: MatchupRole | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const role of profile.roles) {
    const score = MATCHUP_ROLE_PRIORITY[matchup][role];
    if (score > bestScore) {
      bestScore = score;
      bestRole = role;
    }
  }
  return bestRole;
}

function scoreSideboardCard(
  matchup: MatchupArchetype,
  profile: CardProfile,
  roleBias: Record<MatchupRole, number>,
): number {
  let score = 0;
  for (const role of profile.roles) {
    score += MATCHUP_ROLE_PRIORITY[matchup][role];
    score += roleBias[role] * 0.65;
  }

  if (profile.isInstant) score += 0.35;
  if (profile.cmc <= 2) score += 0.5;
  if (profile.cmc >= 5) score -= 0.35;

  if (matchup === 'aggro') {
    if (profile.isSweeper) score += 1.5;
    if (profile.roles.has('removal') && profile.cmc <= 2) score += 0.9;
    if (profile.roles.has('finisher')) score -= 0.9;
  }

  if (matchup === 'control') {
    if (profile.roles.has('protection')) score += 0.95;
    if (profile.roles.has('draw')) score += 0.45;
    if (profile.isNarrowRemoval) score -= 0.65;
  }

  if (matchup === 'combo') {
    if (profile.roles.has('interaction') && profile.isInstant) score += 1.3;
    if (profile.isSweeper) score -= 0.9;
    if (profile.cmc >= 5) score -= 0.7;
  }

  return score;
}

function scoreMainDeckCut(
  matchup: MatchupArchetype,
  entry: DeckEntry,
  profile: CardProfile,
  roleBias: Record<MatchupRole, number>,
): number {
  if (profile.isLand) return -999;

  let score = profile.cmc * 0.4;
  if (profile.isSorcery) score += 0.5;
  if (entry.qty > 2) score += 0.35;

  for (const role of profile.roles) {
    score -= MATCHUP_ROLE_PRIORITY[matchup][role] * 0.8;
    score -= roleBias[role] * 0.9;
  }

  if (PROTECTED_STAPLES.has(profile.normalizedName)) score -= 5;

  if (matchup === 'aggro') {
    if (profile.cmc >= 5) score += 1.8;
    if (profile.roles.has('draw') && profile.cmc >= 4) score += 0.65;
    if (profile.roles.has('finisher')) score += 0.7;
  }

  if (matchup === 'control') {
    if (profile.isNarrowRemoval) score += 1.2;
    if (profile.roles.has('removal') && !profile.isInstant) score += 0.4;
  }

  if (matchup === 'combo') {
    if (profile.isSweeper) score += 1.4;
    if (profile.cmc >= 5) score += 1.3;
    if (profile.roles.has('interaction') && profile.isInstant) score -= 1.2;
  }

  return score;
}

function buildInReason(matchup: MatchupArchetype, profile: CardProfile): string {
  const role = primaryRole(matchup, profile);

  if (matchup === 'aggro') {
    if (profile.isSweeper) return 'Board reset stabilisiert gegen breite Angriffe und nimmt Tempo vom Gegner.';
    if (role === 'removal') return 'Effiziente Antwort auf fruehe Threats und Combat-Pushes.';
    if (role === 'interaction') return 'Interaktion stoppt key-spells bevor der Schaden snowballed.';
  }

  if (matchup === 'control') {
    if (role === 'protection') return 'Schuetzt zentrale Threats gegen Counter- und Removal-Fenster.';
    if (role === 'draw') return 'Erhoeht Ressourcen in laengeren, grindigen Spielen.';
    if (role === 'finisher') return 'Robuster Wincon-Upgrade fuer Topdeck-lastige Spiele.';
  }

  if (matchup === 'combo') {
    if (role === 'interaction') return 'Stack-Interaktion trifft Tutor/Enabler/Payoff im kritischen Fenster.';
    if (role === 'removal') return 'Entfernt Combo-Pieces auf dem Board vor dem entscheidenden Turn.';
    if (role === 'protection') return 'Sichert die eigene Clock waehrend du Mana fuer Interaction offen haeltst.';
  }

  return 'Passt besser in den Plan fuer dieses Matchup und verbessert die Interaktionsdichte.';
}

function buildOutReason(matchup: MatchupArchetype, profile: CardProfile): string {
  if ((matchup === 'aggro' || matchup === 'combo') && profile.cmc >= 5) {
    return 'Hohe Mana-Kurve ist in diesem Matchup zu langsam und erhoeht Tempoverlust.';
  }
  if (matchup === 'control' && profile.isNarrowRemoval) {
    return 'Narrow Creature-Removal hat gegen control-lastige Listen oft zu wenige Ziele.';
  }
  if (matchup === 'combo' && profile.isSweeper) {
    return 'Sorcery-Speed Sweeper interagiert zu spaet gegen stack-basierte Kill-Turns.';
  }
  if (profile.roles.has('finisher') && (matchup === 'aggro' || matchup === 'combo')) {
    return 'Top-end Slot ist weniger relevant als fruehe Interaktion in diesem Pairing.';
  }
  return 'Geringerer Impact im konkreten Matchup im Vergleich zu den Sideboard-Optionen.';
}

function pickMoves(
  candidates: ScoredCandidate[],
  targetQty: number,
  reasonBuilder: (profile: CardProfile) => string,
  minScore: number,
): MatchupMove[] {
  if (targetQty <= 0) return [];

  const moves: MatchupMove[] = [];
  let remaining = targetQty;

  for (const candidate of candidates) {
    if (remaining <= 0) break;
    if (candidate.score < minScore) break;

    const qty = Math.min(Math.max(0, candidate.entry.qty), remaining);
    if (qty <= 0) continue;

    moves.push({
      card: candidate.entry.name,
      qty,
      reason: reasonBuilder(candidate.profile),
    });
    remaining -= qty;
  }

  return moves;
}

function trimMovesToQty(moves: MatchupMove[], targetQty: number): MatchupMove[] {
  if (targetQty <= 0) return [];
  const trimmed: MatchupMove[] = [];
  let remaining = targetQty;

  for (const move of moves) {
    if (remaining <= 0) break;
    const qty = Math.min(move.qty, remaining);
    if (qty <= 0) continue;
    trimmed.push({ ...move, qty });
    remaining -= qty;
  }

  return trimmed;
}

function createNoSideboardPlan(matchup: MatchupArchetype): MatchupSideboardPlan {
  return {
    available: false,
    in: [],
    out: [],
    fallback: FALLBACK_PLAN[matchup],
  };
}

function buildSideboardPlan(
  matchup: MatchupArchetype,
  input: BuildMatchupGuideInput,
  roleBias: Record<MatchupRole, number>,
  maxMovesPerMatchup: number,
): MatchupSideboardPlan {
  const totalSideboardQty = totalQty(input.deck.sideboard);
  if (totalSideboardQty <= 0) {
    return createNoSideboardPlan(matchup);
  }

  const targetQty = clamp(Math.ceil(totalSideboardQty / 4), 2, maxMovesPerMatchup);

  const sideboardCandidates = input.deck.sideboard
    .map((entry) => {
      const profile = classifyCardProfile(entry, input.resolveCard);
      const score = scoreSideboardCard(matchup, profile, roleBias);
      return { entry, profile, score };
    })
    .sort((a, b) => b.score - a.score);

  let inMoves = pickMoves(sideboardCandidates, targetQty, (profile) => buildInReason(matchup, profile), 0.35);
  if (totalMoveQty(inMoves) === 0) {
    inMoves = pickMoves(sideboardCandidates, Math.min(targetQty, 2), (profile) => buildInReason(matchup, profile), Number.NEGATIVE_INFINITY);
  }

  const mainCandidates = input.deck.main
    .map((entry) => {
      const profile = classifyCardProfile(entry, input.resolveCard);
      const score = scoreMainDeckCut(matchup, entry, profile, roleBias);
      return { entry, profile, score };
    })
    .sort((a, b) => b.score - a.score);

  let outMoves = pickMoves(mainCandidates, totalMoveQty(inMoves), (profile) => buildOutReason(matchup, profile), -20);
  if (totalMoveQty(outMoves) === 0) {
    outMoves = pickMoves(mainCandidates, totalMoveQty(inMoves), (profile) => buildOutReason(matchup, profile), -998);
  }

  const inQty = totalMoveQty(inMoves);
  const outQty = totalMoveQty(outMoves);
  if (outQty <= 0 || inQty <= 0) {
    return {
      available: true,
      in: [],
      out: [],
    };
  }

  if (outQty < inQty) {
    inMoves = trimMovesToQty(inMoves, outQty);
  }

  return {
    available: true,
    in: inMoves,
    out: outMoves,
  };
}

function normalizeMetaMode(mode: MatchupMetaMode | undefined): MatchupMetaMode {
  if (mode === 'local' || mode === 'commander-pod') return mode;
  return 'fnm';
}

export function buildMatchupGuide(input: BuildMatchupGuideInput): MatchupGuide {
  const mode = normalizeMetaMode(input.metaMode);
  const minPlans = clamp(input.minPlans ?? 3, 1, MATCHUPS.length);
  const maxMovesPerMatchup = clamp(input.maxSideboardMovesPerMatchup ?? 6, 2, 10);
  const hasSideboard = totalQty(input.deck.sideboard) > 0;

  const roleBias = buildRecommendationRoleBias(input.deck, input.resolveCard);
  const roleDensity = buildMainDeckRoleDensity(input.deck, input.resolveCard);
  const avgCmc = averageMainDeckCmc(input.deck, input.resolveCard);
  const cardDataCoverage = estimateCardDataCoverage(input.deck, input.resolveCard);
  const lowCoverage = cardDataCoverage < 0.55;

  const plans = MATCHUPS
    .map((matchup) => {
      const sideboard = buildSideboardPlan(matchup, input, roleBias, maxMovesPerMatchup);
      const roleGap = matchupRoleGap(matchup, roleBias, roleDensity);
      const relevanceScore = matchupRelevanceScore(matchup, mode, roleGap, avgCmc, cardDataCoverage);
      return {
        matchup,
        title: MATCHUP_TITLE[matchup],
        relevanceScore,
        threats: [...MATCHUP_THREATS[matchup]],
        wincons: [...MATCHUP_WINCONS[matchup]],
        corePlan: buildCorePlan(matchup, mode, lowCoverage),
        sequencingPriorities: [...MATCHUP_SEQUENCING_PRIORITIES[mode][matchup]],
        interactionPriorities: [...MATCHUP_INTERACTION_PRIORITIES[mode][matchup]],
        sideboard,
        preBoardPlan: buildPreBoardPlan(matchup, mode),
        postBoardPlan: buildPostBoardPlan(matchup, mode, sideboard.available),
      } satisfies MatchupPlan;
    })
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, minPlans);

  const fallbackReasons: string[] = [];
  if (!hasSideboard) fallbackReasons.push('missing_sideboard');
  if (cardDataCoverage < 0.55) fallbackReasons.push('low_card_data_coverage');
  if (plans.length < minPlans) fallbackReasons.push('insufficient_matchup_pool');

  return {
    schemaVersion: 'matchup-guide.v1',
    metaMode: mode,
    generatedAt: new Date().toISOString(),
    minMatchupsSatisfied: plans.length >= minPlans,
    fallbackReasons,
    cardDataCoverage,
    weights: {
      modeWeight: RELEVANCE_WEIGHTS.modeWeight,
      roleGap: RELEVANCE_WEIGHTS.roleGap,
      curvePressure: RELEVANCE_WEIGHTS.curvePressure,
      dataQuality: RELEVANCE_WEIGHTS.dataQuality,
    },
    hasSideboard,
    plans,
    inOutRulebook: SIDEBOARD_RULEBOOK,
    recommendationRoleBias: roleBias,
  };
}
