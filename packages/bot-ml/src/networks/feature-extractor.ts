import type { GameState, Card, Permanent, PlayerState } from '@mtg/game-engine';
import { totalMana, isLand, isCreature, isInstant, isArtifact, isEnchantment } from '@mtg/game-engine';

/**
 * Feature Extractor — Converts GameState into a fixed-size numeric vector.
 *
 * v1: 200-dimensional Float32Array (backward compatible)
 * v2: 256-dimensional Float32Array (first 200 identical to v1, +56 new features)
 *
 * OPTIMIZED: Single-pass over battlefield and hand arrays instead of 30+ .filter() calls.
 */

// Feature vector dimensions
export const FEATURE_DIM = 200;
export const FEATURE_DIM_V2 = 256;
export const FEATURE_DIM_V3 = 320;
export const FEATURE_DIM_V4 = 384;

// Card Feature Dimensions
export const CARD_FEATURE_DIM = 16;

// Pre-computed lookup maps for O(1) phase/step encoding
const PHASE_MAP: Record<string, number> = {
  'beginning': 0, 'precombat-main': 0.25, 'combat': 0.5,
  'postcombat-main': 0.75, 'ending': 1,
};

const STEP_MAP: Record<string, number> = {
  'untap': 0, 'upkeep': 1/11, 'draw': 2/11, 'main': 3/11,
  'begin-combat': 4/11, 'declare-attackers': 5/11, 'declare-blockers': 6/11,
  'first-strike-damage': 7/11, 'combat-damage': 8/11, 'end-combat': 9/11,
  'end': 10/11, 'cleanup': 1,
};

/** Stats accumulated in a single pass over a battlefield array */
interface BattlefieldStats {
  creatures: number;
  nonCreatures: number;
  lands: number;
  artifacts: number;
  enchantments: number;
  tapped: number;
  untapped: number;
  summoningSick: number;
  totalPower: number;
  totalToughness: number;
  maxPower: number;
  hasPlaneswalker: boolean;
  totalLoyalty: number;
  totalCMC: number;
  nonLandCount: number;
  tagRamp: number;
  tagEngine: number;
  tagDraw: number;
  tagComboPiece: number;
  hasFlying: boolean;
  hasTrample: boolean;
  hasLifelink: boolean;
  hasDoubleStrike: boolean;
  hasHexproof: boolean;
  hasIndestructible: boolean;
  // v2: additional stats for combat threat & board quality
  flyingPower: number;
  tramplePower: number;
  evasivePower: number;       // flying + trample + unblockable
  attackablePower: number;    // untapped, not sick creatures
  attackableCount: number;
  withAbilities: number;      // permanents with activated abilities
  totalPowerToughProduct: number; // sum of power*toughness per creature
  colorDiversity: number;     // distinct colors among permanents
  // v4: extended keywords (counts)
  vigilanceCount: number;
  hasteCount: number;
  menaceCount: number;
  deathtouchCount: number;
  shroudCount: number;
  wardCount: number;
  firstStrikeCount: number;
  reachCount: number;
  unblockableCount: number;
  // v4: synergy metrics
  etbCreatureCount: number;   // creatures with ETB triggers
  sacrificeOutletCount: number; // permanents with sacrifice abilities
  tokenGeneratorCount: number; // permanents that create tokens
  enchantmentCount: number;   // separate from generic enchantments var
  dualLandsCount: number;     // fixing lands
  untappedLandCount: number;  // tempo metric
}

/** Stats accumulated in a single pass over a hand array */
interface HandStats {
  lands: number;
  creatures: number;
  instants: number;
  sorceries: number;
  totalCMC: number;
  minCMC: number;
  maxCMC: number;
  spellCount: number;
  tagRamp: number;
  tagDraw: number;
  tagRemoval: number;
  tagCounter: number;
  tagWipe: number;
  tagTutor: number;
  tagComboPiece: number;
  tagEngine: number;
  tagFinisher: number;
  tagProtection: number;
  tagTokenGen: number;
  tagRecursion: number;
  tagReanimation: number;
  cmcCurve: number[];  // 7 buckets: 0,1,2,3,4,5,6+
}

/** Single-pass battlefield analysis */
function analyzeBattlefield(perms: Permanent[]): BattlefieldStats {
  const stats: BattlefieldStats = {
    creatures: 0, nonCreatures: 0, lands: 0, artifacts: 0, enchantments: 0,
    tapped: 0, untapped: 0, summoningSick: 0,
    totalPower: 0, totalToughness: 0, maxPower: 0,
    hasPlaneswalker: false, totalLoyalty: 0,
    totalCMC: 0, nonLandCount: 0,
    tagRamp: 0, tagEngine: 0, tagDraw: 0, tagComboPiece: 0,
    hasFlying: false, hasTrample: false, hasLifelink: false,
    hasDoubleStrike: false, hasHexproof: false, hasIndestructible: false,
    // v2
    flyingPower: 0, tramplePower: 0, evasivePower: 0,
    attackablePower: 0, attackableCount: 0, withAbilities: 0,
    totalPowerToughProduct: 0, colorDiversity: 0,
    // v4
    vigilanceCount: 0, hasteCount: 0, menaceCount: 0, deathtouchCount: 0,
    shroudCount: 0, wardCount: 0, firstStrikeCount: 0, reachCount: 0, unblockableCount: 0,
    etbCreatureCount: 0, sacrificeOutletCount: 0, tokenGeneratorCount: 0,
    enchantmentCount: 0, dualLandsCount: 0, untappedLandCount: 0,
  };

  const colorsFound = new Set<string>();

  for (let i = 0; i < perms.length; i++) {
    const p = perms[i];
    const tl = p.typeLine.toLowerCase();
    const isCreatureP = p.currentPower !== undefined;

    // v2: Track color diversity
    if (p.colors) for (let c = 0; c < p.colors.length; c++) colorsFound.add(p.colors[c]);

    if (isCreatureP) {
      stats.creatures++;
      const pow = p.currentPower ?? 0;
      const tough = p.currentToughness ?? 0;
      stats.totalPower += pow;
      stats.totalToughness += tough;
      if (pow > stats.maxPower) stats.maxPower = pow;

      // v2: power*toughness quality metric
      stats.totalPowerToughProduct += pow * tough;

      // v2: Attackable creatures (not sick, not tapped)
      if (!p.summoningSick && !p.tapped) {
        stats.attackablePower += pow;
        stats.attackableCount++;
      }

      // Keyword check (only for creatures, single oracleText scan)
      const oracle = (p.oracleText || '').toLowerCase();
      const hasFlying = oracle.includes('flying');
      const hasTrample = oracle.includes('trample');
      if (hasFlying && !stats.hasFlying) stats.hasFlying = true;
      if (hasTrample && !stats.hasTrample) stats.hasTrample = true;
      if (!stats.hasLifelink && oracle.includes('lifelink')) stats.hasLifelink = true;
      if (!stats.hasDoubleStrike && oracle.includes('double strike')) stats.hasDoubleStrike = true;
      if (!stats.hasHexproof && oracle.includes('hexproof')) stats.hasHexproof = true;
      if (!stats.hasIndestructible && oracle.includes('indestructible')) stats.hasIndestructible = true;

      // v2: Evasive power tracking
      if (hasFlying) stats.flyingPower += pow;
      if (hasTrample) stats.tramplePower += pow;
      if (hasFlying || hasTrample || oracle.includes('unblockable') || oracle.includes("can't be blocked")) {
        stats.evasivePower += pow;
      }

      // v4: Extended keywords (count occurrences)
      if (oracle.includes('vigilance')) stats.vigilanceCount++;
      if (oracle.includes('haste')) stats.hasteCount++;
      if (oracle.includes('menace')) stats.menaceCount++;
      if (oracle.includes('deathtouch')) stats.deathtouchCount++;
      if (oracle.includes('shroud')) stats.shroudCount++;
      if (oracle.includes('ward')) stats.wardCount++;
      if (oracle.includes('first strike') && !oracle.includes('double strike')) stats.firstStrikeCount++;
      if (oracle.includes('reach')) stats.reachCount++;
      if (oracle.includes('unblockable') || oracle.includes("can't be blocked")) stats.unblockableCount++;

      // v4: ETB synergies
      if (oracle.includes('enters the battlefield') || oracle.includes('when') && oracle.includes('enters')) {
        stats.etbCreatureCount++;
      }
    } else {
      stats.nonCreatures++;
    }

    if (tl.includes('land')) {
      stats.lands++;
      // v4: Track untapped lands and dual lands
      if (!p.tapped) stats.untappedLandCount++;
      const oracleL = (p.oracleText || '').toLowerCase();
      if (oracleL.includes('add') && (oracleL.match(/add.*{.*}/g) || []).length >= 2) {
        stats.dualLandsCount++; // Rough heuristic for multicolor lands
      }
    } else {
      stats.nonLandCount++;
      stats.totalCMC += p.cmc;
    }
    if (tl.includes('artifact')) stats.artifacts++;
    if (tl.includes('enchantment')) {
      stats.enchantments++;
      stats.enchantmentCount++;
    }

    // v4: Synergy detection (all permanents)
    const oracleP = (p.oracleText || '').toLowerCase();
    if (oracleP.includes('sacrifice')) stats.sacrificeOutletCount++;
    if (oracleP.includes('create') && oracleP.includes('token')) stats.tokenGeneratorCount++;

    if (p.currentLoyalty !== undefined) {
      stats.hasPlaneswalker = true;
      stats.totalLoyalty += p.currentLoyalty;
    }

    if (p.tapped) stats.tapped++;
    else stats.untapped++;

    if (p.summoningSick) stats.summoningSick++;

    // v2: Permanents with abilities
    if (p.abilities && p.abilities.length > 0) stats.withAbilities++;

    // Tags (single check per tag)
    const tags = p.tags;
    for (let t = 0; t < tags.length; t++) {
      switch (tags[t]) {
        case 'ramp': stats.tagRamp++; break;
        case 'engine': stats.tagEngine++; break;
        case 'draw': stats.tagDraw++; break;
        case 'combo-piece': stats.tagComboPiece++; break;
      }
    }
  }

  stats.colorDiversity = colorsFound.size;

  return stats;
}

/** Single-pass hand analysis */
function analyzeHand(hand: Card[]): HandStats {
  const stats: HandStats = {
    lands: 0, creatures: 0, instants: 0, sorceries: 0,
    totalCMC: 0, minCMC: Infinity, maxCMC: 0, spellCount: 0,
    tagRamp: 0, tagDraw: 0, tagRemoval: 0, tagCounter: 0,
    tagWipe: 0, tagTutor: 0, tagComboPiece: 0, tagEngine: 0,
    tagFinisher: 0, tagProtection: 0, tagTokenGen: 0,
    tagRecursion: 0, tagReanimation: 0,
    cmcCurve: [0, 0, 0, 0, 0, 0, 0],
  };

  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    const tl = c.typeLine.toLowerCase();

    if (tl.includes('land')) {
      stats.lands++;
      continue;  // lands aren't spells, skip CMC etc.
    }

    // It's a spell
    stats.spellCount++;
    stats.totalCMC += c.cmc;
    if (c.cmc < stats.minCMC) stats.minCMC = c.cmc;
    if (c.cmc > stats.maxCMC) stats.maxCMC = c.cmc;

    // CMC curve bucket
    stats.cmcCurve[Math.min(c.cmc, 6)]++;

    if (tl.includes('creature')) stats.creatures++;
    if (tl.includes('instant')) stats.instants++;
    if (tl.includes('sorcery')) stats.sorceries++;

    // Tags
    const tags = c.tags;
    for (let t = 0; t < tags.length; t++) {
      switch (tags[t]) {
        case 'ramp': stats.tagRamp++; break;
        case 'draw': stats.tagDraw++; break;
        case 'removal': stats.tagRemoval++; break;
        case 'counter': stats.tagCounter++; break;
        case 'wipe': stats.tagWipe++; break;
        case 'tutor': stats.tagTutor++; break;
        case 'combo-piece': stats.tagComboPiece++; break;
        case 'engine': stats.tagEngine++; break;
        case 'finisher': stats.tagFinisher++; break;
        case 'protection': stats.tagProtection++; break;
        case 'token-generator': stats.tagTokenGen++; break;
        case 'recursion': stats.tagRecursion++; break;
        case 'reanimation': stats.tagReanimation++; break;
      }
    }
  }

  // Fix Infinity for empty hands
  if (stats.minCMC === Infinity) stats.minCMC = 0;

  return stats;
}

// Inline normalize — avoids function call overhead in hot path
const norm = (value: number, min: number, max: number): number =>
  max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));

/**
 * Extract a feature vector from the game state for a given player.
 * OPTIMIZED: Single pass over battlefield and hand arrays.
 */
export function extractFeatures(state: GameState, player: 0 | 1): Float32Array {
  const features = new Float32Array(FEATURE_DIM);
  const opponent = (1 - player) as 0 | 1;
  const me = state.players[player];
  const opp = state.players[opponent];
  let idx = 0;

  // Single-pass analysis
  const myBoard = analyzeBattlefield(me.battlefield);
  const oppBoard = analyzeBattlefield(opp.battlefield);
  const myHand = analyzeHand(me.hand);

  // === Player Resources [0-19] ===
  features[idx++] = norm(me.life, 0, 40);
  features[idx++] = norm(totalMana(me.manaPool), 0, 20);
  features[idx++] = norm(me.hand.length, 0, 15);
  features[idx++] = norm(me.library.length, 0, 99);
  features[idx++] = norm(me.graveyard.length, 0, 50);
  features[idx++] = norm(me.exile.length, 0, 30);
  features[idx++] = norm(me.battlefield.length, 0, 30);
  features[idx++] = me.landPlayedThisTurn ? 1 : 0;
  features[idx++] = norm(me.landsPlayedThisTurn, 0, 3);
  features[idx++] = norm(me.poisonCounters, 0, 10);
  features[idx++] = norm(me.commanderTax, 0, 10);
  features[idx++] = norm(me.manaPool.W, 0, 10);
  features[idx++] = norm(me.manaPool.U, 0, 10);
  features[idx++] = norm(me.manaPool.B, 0, 10);
  features[idx++] = norm(me.manaPool.R, 0, 10);
  features[idx++] = norm(me.manaPool.G, 0, 10);
  features[idx++] = norm(me.manaPool.C, 0, 10);
  features[idx++] = norm(myBoard.creatures, 0, 15);
  features[idx++] = norm(myBoard.nonCreatures, 0, 15);
  features[idx++] = norm(myBoard.lands, 0, 15);

  // === Battlefield Summary [20-59] ===
  features[idx++] = norm(myBoard.totalPower, 0, 50);
  features[idx++] = norm(myBoard.totalToughness, 0, 50);
  features[idx++] = norm(myBoard.maxPower, 0, 15);
  const avgCMC = myBoard.nonLandCount > 0 ? myBoard.totalCMC / myBoard.nonLandCount : 0;
  features[idx++] = norm(avgCMC, 0, 8);
  features[idx++] = myBoard.hasFlying ? 1 : 0;
  features[idx++] = myBoard.hasTrample ? 1 : 0;
  features[idx++] = myBoard.hasLifelink ? 1 : 0;
  features[idx++] = myBoard.hasDoubleStrike ? 1 : 0;
  features[idx++] = myBoard.hasHexproof ? 1 : 0;
  features[idx++] = myBoard.hasIndestructible ? 1 : 0;
  features[idx++] = norm(myBoard.tapped, 0, 15);
  features[idx++] = norm(myBoard.untapped, 0, 15);
  features[idx++] = norm(myBoard.tagRamp, 0, 5);
  features[idx++] = norm(myBoard.tagEngine, 0, 5);
  features[idx++] = norm(myBoard.tagDraw, 0, 5);
  features[idx++] = norm(myBoard.artifacts, 0, 10);
  features[idx++] = norm(myBoard.enchantments, 0, 10);
  features[idx++] = myBoard.hasPlaneswalker ? 1 : 0;
  features[idx++] = norm(myBoard.totalLoyalty, 0, 20);
  features[idx++] = norm(myBoard.summoningSick, 0, 10);
  // Pad remaining battlefield slots
  while (idx < 60) features[idx++] = 0;

  // === Hand Composition [60-99] ===
  features[idx++] = norm(myHand.lands, 0, 7);
  features[idx++] = norm(myHand.creatures, 0, 7);
  features[idx++] = norm(myHand.instants, 0, 7);
  features[idx++] = norm(myHand.sorceries, 0, 7);
  const avgHandCMC = myHand.spellCount > 0 ? myHand.totalCMC / myHand.spellCount : 0;
  features[idx++] = norm(avgHandCMC, 0, 8);
  features[idx++] = norm(myHand.minCMC, 0, 8);
  features[idx++] = norm(myHand.maxCMC, 0, 10);
  // Tags in hand
  features[idx++] = norm(myHand.tagRamp, 0, 5);
  features[idx++] = norm(myHand.tagDraw, 0, 5);
  features[idx++] = norm(myHand.tagRemoval, 0, 5);
  features[idx++] = norm(myHand.tagCounter, 0, 5);
  features[idx++] = norm(myHand.tagWipe, 0, 3);
  features[idx++] = norm(myHand.tagTutor, 0, 3);
  features[idx++] = norm(myHand.tagComboPiece, 0, 3);
  features[idx++] = norm(myHand.tagEngine, 0, 3);
  features[idx++] = norm(myHand.tagFinisher, 0, 3);
  features[idx++] = norm(myHand.tagProtection, 0, 3);
  features[idx++] = norm(myHand.tagTokenGen, 0, 3);
  features[idx++] = norm(myHand.tagRecursion, 0, 3);
  features[idx++] = norm(myHand.tagReanimation, 0, 3);
  // CMC curve in hand (buckets 0,1,2,3,4,5,6+)
  for (let i = 0; i < 7; i++) features[idx++] = norm(myHand.cmcCurve[i], 0, 4);
  // Pad
  while (idx < 100) features[idx++] = 0;

  // === Game Context [100-119] ===
  features[idx++] = norm(state.turn, 0, 30);
  features[idx++] = PHASE_MAP[state.phase] ?? 0;
  features[idx++] = STEP_MAP[state.step] ?? 0;
  features[idx++] = state.activePlayer === player ? 1 : 0;
  features[idx++] = state.priorityPlayer === player ? 1 : 0;
  features[idx++] = norm(state.stack.length, 0, 10);
  features[idx++] = state.combat ? 1 : 0;
  features[idx++] = state.mulliganPhase ? 1 : 0;
  features[idx++] = norm(state.mulliganCount?.[player] ?? 0, 0, 5);
  features[idx++] = state.gameOver ? 1 : 0;
  // Stack composition
  let myStackItems = 0;
  let oppStackItems = 0;
  for (let i = 0; i < state.stack.length; i++) {
    if (state.stack[i].controller === player) myStackItems++;
    else oppStackItems++;
  }
  features[idx++] = norm(myStackItems, 0, 5);
  features[idx++] = norm(oppStackItems, 0, 5);
  // Game phase indicators
  features[idx++] = state.turn <= 3 ? 1 : 0;
  features[idx++] = state.turn >= 4 && state.turn <= 8 ? 1 : 0;
  features[idx++] = state.turn >= 9 ? 1 : 0;
  // Pad
  while (idx < 120) features[idx++] = 0;

  // === Opponent Info [120-159] ===
  features[idx++] = norm(opp.life, 0, 40);
  features[idx++] = norm(opp.hand.length, 0, 15);
  features[idx++] = norm(opp.battlefield.length, 0, 30);
  features[idx++] = norm(opp.graveyard.length, 0, 50);
  features[idx++] = norm(oppBoard.creatures, 0, 15);
  features[idx++] = norm(oppBoard.totalPower, 0, 50);
  features[idx++] = norm(oppBoard.totalToughness, 0, 50);
  features[idx++] = norm(oppBoard.maxPower, 0, 15);
  features[idx++] = oppBoard.hasFlying ? 1 : 0;
  features[idx++] = norm(oppBoard.tapped, 0, 15);
  features[idx++] = norm(oppBoard.untapped, 0, 15);
  features[idx++] = norm(oppBoard.lands, 0, 15);
  features[idx++] = norm(opp.poisonCounters, 0, 10);
  features[idx++] = norm(opp.commanderTax, 0, 10);
  features[idx++] = opp.commandZone.length > 0 ? 1 : 0;
  features[idx++] = norm(oppBoard.artifacts, 0, 10);
  features[idx++] = norm(oppBoard.enchantments, 0, 10);
  features[idx++] = oppBoard.hasPlaneswalker ? 1 : 0;
  features[idx++] = norm(oppBoard.totalLoyalty, 0, 20);
  const oppAvgCMC = oppBoard.nonLandCount > 0 ? oppBoard.totalCMC / oppBoard.nonLandCount : 0;
  features[idx++] = norm(oppAvgCMC, 0, 8);
  // Pad
  while (idx < 160) features[idx++] = 0;

  // === Advantage Signals [160-179] ===
  features[idx++] = norm(me.life - opp.life, -40, 40);
  features[idx++] = norm(me.hand.length - opp.hand.length, -7, 7);
  features[idx++] = norm(myBoard.totalPower - oppBoard.totalPower, -30, 30);
  features[idx++] = norm(me.battlefield.length - opp.battlefield.length, -20, 20);
  features[idx++] = norm(myBoard.lands - oppBoard.lands, -10, 10);
  // Threat level signals
  features[idx++] = oppBoard.totalPower >= me.life ? 1 : 0;
  features[idx++] = myBoard.totalPower >= opp.life ? 1 : 0;
  features[idx++] = opp.life <= 10 ? 1 : 0;
  features[idx++] = me.life <= 10 ? 1 : 0;
  features[idx++] = me.library.length <= 5 ? 1 : 0;
  // Pad
  while (idx < 180) features[idx++] = 0;

  // === Commander State [180-199] ===
  features[idx++] = me.commandZone.length > 0 ? 1 : 0;
  features[idx++] = norm(me.commanderTax, 0, 10);
  const cmdDmgReceived = Object.values(me.commanderDamage);
  const maxCmdDmg = cmdDmgReceived.length > 0 ? Math.max(...cmdDmgReceived) : 0;
  features[idx++] = norm(maxCmdDmg, 0, 21);
  features[idx++] = maxCmdDmg >= 15 ? 1 : 0;
  const cmdDmgDealt = Object.values(opp.commanderDamage);
  const maxCmdDmgDealt = cmdDmgDealt.length > 0 ? Math.max(...cmdDmgDealt) : 0;
  features[idx++] = norm(maxCmdDmgDealt, 0, 21);
  features[idx++] = maxCmdDmgDealt >= 15 ? 1 : 0;
  // Pad
  while (idx < 200) features[idx++] = 0;

  return features;
}

// =================================================================
// v2 Feature Extractor — 256 features (200 v1 + 56 new)
// =================================================================

/** Graveyard stats (single pass) */
interface GraveyardStats {
  creatures: number;
  spells: number;
  lands: number;
  totalCMC: number;
  removals: number;
  highCMCCreatures: number; // CMC >= 5 (reanimate targets)
  recursionTargets: number; // cards tagged recursion/reanimation
}

function analyzeGraveyard(gy: Card[]): GraveyardStats {
  const stats: GraveyardStats = {
    creatures: 0, spells: 0, lands: 0, totalCMC: 0,
    removals: 0, highCMCCreatures: 0, recursionTargets: 0,
  };
  for (let i = 0; i < gy.length; i++) {
    const c = gy[i];
    const tl = c.typeLine.toLowerCase();
    if (tl.includes('land')) { stats.lands++; continue; }
    stats.totalCMC += c.cmc;
    if (tl.includes('creature')) {
      stats.creatures++;
      if (c.cmc >= 5) stats.highCMCCreatures++;
    } else {
      stats.spells++;
    }
    const tags = c.tags;
    for (let t = 0; t < tags.length; t++) {
      if (tags[t] === 'removal') stats.removals++;
      if (tags[t] === 'recursion' || tags[t] === 'reanimation') stats.recursionTargets++;
    }
  }
  return stats;
}

/**
 * Extract v2 feature vector (256 dims). First 200 identical to v1.
 * New features [200-255]: Graveyard, Combat Threat, Momentum, Tags, Board Quality.
 */
export function extractFeaturesV2(state: GameState, player: 0 | 1): Float32Array {
  const features = new Float32Array(FEATURE_DIM_V2);
  const opponent = (1 - player) as 0 | 1;
  const me = state.players[player];
  const opp = state.players[opponent];

  // Copy first 200 features from v1
  const v1 = extractFeatures(state, player);
  features.set(v1);

  // Single-pass analysis (re-do for v2 extra fields — these are cheap)
  const myBoard = analyzeBattlefield(me.battlefield);
  const oppBoard = analyzeBattlefield(opp.battlefield);
  const myGY = analyzeGraveyard(me.graveyard);
  const oppGY = analyzeGraveyard(opp.graveyard);

  let idx = 200;

  // === [200-209] Graveyard Intel ===
  features[idx++] = norm(myGY.creatures, 0, 15);
  features[idx++] = norm(myGY.spells, 0, 15);
  features[idx++] = norm(myGY.totalCMC, 0, 60);
  features[idx++] = norm(myGY.highCMCCreatures, 0, 5);  // reanimate targets
  features[idx++] = norm(myGY.removals, 0, 5);
  features[idx++] = norm(oppGY.creatures, 0, 15);
  features[idx++] = norm(opp.graveyard.length, 0, 50);
  features[idx++] = norm(myGY.recursionTargets, 0, 5);
  features[idx++] = norm(myGY.lands, 0, 10);
  features[idx++] = norm(oppGY.spells, 0, 15);

  // === [210-219] Combat Threat Assessment ===
  features[idx++] = norm(myBoard.attackablePower, 0, 40);
  features[idx++] = norm(oppBoard.attackablePower, 0, 40);
  // Turns to lethal (my attack power vs opp life, 0 if no power)
  const myTTL = myBoard.attackablePower > 0 ? opp.life / myBoard.attackablePower : 99;
  const oppTTL = oppBoard.attackablePower > 0 ? me.life / oppBoard.attackablePower : 99;
  features[idx++] = norm(myTTL, 0, 20);   // lower = closer to lethal (good for us)
  features[idx++] = norm(oppTTL, 0, 20);   // lower = closer to lethal (bad for us)
  features[idx++] = norm(myBoard.evasivePower, 0, 30);
  features[idx++] = norm(oppBoard.evasivePower, 0, 30);
  // Combat trade ratio: can we attack profitably?
  const tradeRatio = oppBoard.totalToughness > 0
    ? myBoard.totalPower / oppBoard.totalToughness : myBoard.totalPower > 0 ? 2 : 0;
  features[idx++] = norm(tradeRatio, 0, 3);
  // Untapped non-creature mana (open mana for tricks)
  const openMana = myBoard.untapped - myBoard.attackableCount;
  features[idx++] = norm(Math.max(0, openMana), 0, 10);
  features[idx++] = norm(myBoard.flyingPower, 0, 20);
  features[idx++] = norm(oppBoard.flyingPower, 0, 20);

  // === [220-229] Resource Momentum ===
  // Mana efficiency: how much mana COULD we use this turn?
  const availableMana = myBoard.lands; // rough proxy
  const spellsAffordable = countAffordableSpells(me, availableMana);
  features[idx++] = norm(spellsAffordable, 0, 7);
  // Lands in hand as ratio
  const landsInHandRatio = me.hand.length > 0
    ? me.hand.filter(c => c.typeLine.toLowerCase().includes('land')).length / me.hand.length : 0;
  features[idx++] = landsInHandRatio;
  // Excess lands: lands on board minus highest CMC spell in hand
  const maxHandCMC = me.hand.reduce((max, c) => c.cmc > max ? c.cmc : max, 0);
  const excessLands = Math.max(0, myBoard.lands - Math.max(maxHandCMC, 3));
  features[idx++] = norm(excessLands, 0, 10);
  // Land count total as game progress indicator
  features[idx++] = norm(myBoard.lands, 0, 15);
  features[idx++] = norm(oppBoard.lands, 0, 15);
  // Color diversity (mana)
  features[idx++] = norm(myBoard.colorDiversity, 0, 5);
  // Cards in hand vs expected (~7 minus turn, rough proxy)
  const expectedCards = Math.max(1, 7 - Math.floor(state.turn / 3));
  const handAdvantage = me.hand.length - expectedCards;
  features[idx++] = norm(handAdvantage, -5, 5);
  // Board value difference (total CMC deployed)
  features[idx++] = norm(myBoard.totalCMC - oppBoard.totalCMC, -30, 30);
  // Has spells to play? (binary signal)
  features[idx++] = spellsAffordable > 0 ? 1 : 0;
  // Library remaining ratio
  features[idx++] = me.library.length > 0 ? 1 : 0;

  // === [230-239] Board Permanent Tags (from battlefield) ===
  features[idx++] = norm(myBoard.tagRamp, 0, 5);
  features[idx++] = norm(myBoard.tagEngine, 0, 5);
  features[idx++] = norm(myBoard.tagDraw, 0, 5);
  features[idx++] = norm(myBoard.tagComboPiece, 0, 3);
  features[idx++] = norm(myBoard.withAbilities, 0, 10);
  features[idx++] = norm(oppBoard.tagRamp, 0, 5);
  features[idx++] = norm(oppBoard.tagEngine, 0, 5);
  features[idx++] = norm(oppBoard.tagDraw, 0, 5);
  features[idx++] = norm(oppBoard.tagComboPiece, 0, 3);
  features[idx++] = norm(oppBoard.withAbilities, 0, 10);

  // === [240-249] Board Quality Signals ===
  // Average creature quality: power*toughness / CMC
  const avgCreatureQ = myBoard.creatures > 0
    ? myBoard.totalPowerToughProduct / myBoard.creatures : 0;
  const oppAvgCreatureQ = oppBoard.creatures > 0
    ? oppBoard.totalPowerToughProduct / oppBoard.creatures : 0;
  features[idx++] = norm(avgCreatureQ, 0, 20);
  features[idx++] = norm(oppAvgCreatureQ, 0, 20);
  // Permanent diversity (types / 5)
  const typeDiversity = (
    (myBoard.creatures > 0 ? 1 : 0) +
    (myBoard.artifacts > 0 ? 1 : 0) +
    (myBoard.enchantments > 0 ? 1 : 0) +
    (myBoard.hasPlaneswalker ? 1 : 0) +
    (myBoard.lands > 0 ? 1 : 0)
  ) / 5;
  features[idx++] = typeDiversity;
  // Board presence: permanents * avg quality
  const boardPresence = myBoard.nonLandCount > 0
    ? myBoard.nonLandCount * (myBoard.totalCMC / myBoard.nonLandCount) : 0;
  const oppBoardPresence = oppBoard.nonLandCount > 0
    ? oppBoard.nonLandCount * (oppBoard.totalCMC / oppBoard.nonLandCount) : 0;
  features[idx++] = norm(boardPresence, 0, 50);
  features[idx++] = norm(oppBoardPresence, 0, 50);
  // Tempo advantage
  features[idx++] = norm(boardPresence - oppBoardPresence, -30, 30);
  // Threat density (creatures / non-land permanents)
  const threatDensity = myBoard.nonLandCount > 0
    ? myBoard.creatures / myBoard.nonLandCount : 0;
  features[idx++] = threatDensity;
  // Evasion ratio (evasive / total power)
  const evasionRatio = myBoard.totalPower > 0
    ? myBoard.evasivePower / myBoard.totalPower : 0;
  features[idx++] = evasionRatio;
  // Combat readiness (attackable / creatures)
  const combatReady = myBoard.creatures > 0
    ? myBoard.attackableCount / myBoard.creatures : 0;
  features[idx++] = combatReady;
  // Summoning sick ratio
  const sickRatio = myBoard.creatures > 0
    ? myBoard.summoningSick / myBoard.creatures : 0;
  features[idx++] = sickRatio;

  // === [250-255] Reserved (padding for future) ===
  while (idx < 256) features[idx++] = 0;

  return features;
}

/** Count spells in hand that could be cast with given available mana */
function countAffordableSpells(me: PlayerState, availableMana: number): number {
  let count = 0;
  for (let i = 0; i < me.hand.length; i++) {
    const c = me.hand[i];
    if (c.typeLine.toLowerCase().includes('land')) continue;
    if (c.cmc <= availableMana) count++;
  }
  return count;
}

// =================================================================
// v3 Feature Extractor — 320 features (256 v2 + 64 new)
// =================================================================

/**
 * Extract features for a single card (16 dim float vector).
 * Used for the Card Selection Head.
 */
export function extractCardFeatures(
  card: Card,
  state: GameState,
  player: 0 | 1
): Float32Array {
  const feats = new Float32Array(CARD_FEATURE_DIM);
  let idx = 0;

  const tl = card.typeLine.toLowerCase();
  const tags = card.tags || [];

  // [0] CMC (normalized /8)
  feats[idx++] = norm(card.cmc, 0, 8);

  // [1] Power (/10)
  const power = parseInt(card.power || '0', 10);
  feats[idx++] = norm(power, 0, 10);

  // [2] Toughness (/10)
  const toughness = parseInt(card.toughness || '0', 10);
  feats[idx++] = norm(toughness, 0, 10);

  // [3-6] Type Encoding (one-hot-ish)
  feats[idx++] = tl.includes('creature') ? 1 : 0;
  feats[idx++] = (tl.includes('instant') || (card.oracleText || '').toLowerCase().includes('flash')) ? 1 : 0;
  feats[idx++] = tl.includes('sorcery') ? 1 : 0;
  feats[idx++] = (tl.includes('enchantment') || tl.includes('artifact')) ? 1 : 0;

  // [7-12] Tag Encoding
  feats[idx++] = tags.includes('ramp') ? 1 : 0;
  feats[idx++] = tags.includes('removal') ? 1 : 0;
  feats[idx++] = tags.includes('draw') ? 1 : 0;
  feats[idx++] = tags.includes('combo-piece') ? 1 : 0;
  feats[idx++] = tags.includes('finisher') ? 1 : 0;
  feats[idx++] = tags.includes('protection') ? 1 : 0;

  // [13] Affordability
  const me = state.players[player];
  // Simple check: do we have enough mana total? (Not color-precise here for speed)
  const totalManaAvail = totalMana(me.manaPool); // Note: This might need improvements for untapped lands
  // Better approximation: available mana from lands + pool
  const untappedLands = me.battlefield.filter(c => c.typeLine.toLowerCase().includes('land') && !c.tapped).length;
  const poolTotal = totalMana(me.manaPool);
  feats[idx++] = (untappedLands + poolTotal >= card.cmc) ? 1 : 0;

  // [14] Heuristic Priority Score (normalized)
  // We don't have full heuristic context here easily without circular deps or code duplication.
  // We'll use a simplified heuristic based on turn and type.
  let priority = 0;
  if (tl.includes('land')) priority = 0.1;
  else if (tags.includes('ramp') && state.turn <= 4) priority = 0.9;
  else if (tags.includes('removal')) priority = 0.8;
  else if (tags.includes('draw') && me.hand.length < 3) priority = 0.7;
  else priority = 0.5;
  feats[idx++] = priority;

  // [15] Is Commander?
  // We don't strictly track "is commander" on card object in all states, 
  // but if it's in command zone or we can infer it. 
  // For now, approximate or leave 0 if not available.
  feats[idx++] = 0; 

  return feats;
}

/**
 * Extract v3 feature vector (320 dims).
 * [0-255]: Identical to v2
 * [256-271]: Top castable spell stats (compressed hand signal)
 * [272-287]: Top battlefield creature stats
 * [288-303]: Opponent top threats
 * [304-319]: Reserved/Padding
 */
export function extractFeaturesV3(state: GameState, player: 0 | 1): Float32Array {
  const features = new Float32Array(FEATURE_DIM_V3);
  
  // Copy v2 features
  const v2 = extractFeaturesV2(state, player);
  features.set(v2);

  let idx = 256;
  const me = state.players[player];
  const opp = state.players[(1 - player) as 0 | 1];

  // --- [256-271] Top Castable Spell Stats ---
  // Find best spell in hand (highest CMC that is castable)
  const hand = me.hand.filter(c => !c.typeLine.toLowerCase().includes('land'));
  const castable = hand.filter(c => c.cmc <= (me.battlefield.filter(l => l.typeLine.toLowerCase().includes('land') && !l.tapped).length + totalMana(me.manaPool)));
  
  if (castable.length > 0) {
    // Sort by CMC desc
    castable.sort((a, b) => b.cmc - a.cmc);
    const best = castable[0];
    const cardFeats = extractCardFeatures(best, state, player);
    features.set(cardFeats, idx);
  }
  idx += 16;

  // --- [272-287] Top Battlefield Creature Stats ---
  // Best creature we have on board
  const myCreatures = me.battlefield.filter(c => c.currentPower !== undefined);
  if (myCreatures.length > 0) {
    // Sort by Power + Toughness
    myCreatures.sort((a, b) => ((b.currentPower||0)+(b.currentToughness||0)) - ((a.currentPower||0)+(a.currentToughness||0)));
    // We need to convert Permanent to Card-like structure for extractor
    // simplified for now using the same extractor
    const best = myCreatures[0] as unknown as Card; // Permanent extends Card mostly
    const cardFeats = extractCardFeatures(best, state, player);
    features.set(cardFeats, idx);
  }
  idx += 16;

  // --- [288-303] Opponent Top Threat ---
  const oppCreatures = opp.battlefield.filter(c => c.currentPower !== undefined);
  if (oppCreatures.length > 0) {
     oppCreatures.sort((a, b) => ((b.currentPower||0)+(b.currentToughness||0)) - ((a.currentPower||0)+(a.currentToughness||0)));
     const best = oppCreatures[0] as unknown as Card;
     const cardFeats = extractCardFeatures(best, state, player);
     features.set(cardFeats, idx);
  }
  idx += 16;
  
  // [304-319] Reserved
  while (idx < 320) features[idx++] = 0;

  return features;
}

// =================================================================
// v4 Feature Extractor — 384 features (320 v3 + 64 new)
// =================================================================

/**
 * Extract v4 feature vector (384 dims).
 * [0-319]: Identical to v3
 * [320-335]: Extended Keywords (16 dims) - counts + densities
 * [336-350]: Synergy Metrics (15 dims) - offensive, ETB, tribal
 * [351-360]: Mana Color Alignment (10 dims)
 * [361-368]: Graveyard Recursion Value (8 dims)
 * [369-383]: Combo Assembly Tracking (15 dims) + 1 reserved
 */
export function extractFeaturesV4(state: GameState, player: 0 | 1): Float32Array {
  const features = new Float32Array(FEATURE_DIM_V4);

  // Copy v3 features
  const v3 = extractFeaturesV3(state, player);
  features.set(v3);

  let idx = 320;
  const me = state.players[player];
  const opp = state.players[(1 - player) as 0 | 1];

  // Re-analyze battlefield for v4 stats
  const myBoard = analyzeBattlefield(me.battlefield);
  const oppBoard = analyzeBattlefield(opp.battlefield);
  const myHand = analyzeHand(me.hand);
  const myGY = analyzeGraveyard(me.graveyard);
  const oppGY = analyzeGraveyard(opp.graveyard);

  // --- [320-335] Extended Keywords (16 dims) ---
  // Counts
  features[idx++] = norm(myBoard.vigilanceCount, 0, 10);
  features[idx++] = norm(myBoard.hasteCount, 0, 10);
  features[idx++] = norm(myBoard.menaceCount, 0, 10);
  features[idx++] = norm(myBoard.deathtouchCount, 0, 10);
  features[idx++] = norm(myBoard.shroudCount, 0, 5);
  features[idx++] = norm(myBoard.wardCount, 0, 5);
  features[idx++] = norm(myBoard.firstStrikeCount, 0, 10);
  features[idx++] = norm(myBoard.reachCount, 0, 10);
  features[idx++] = norm(myBoard.unblockableCount, 0, 5);
  // Densities (keyword creatures / total creatures)
  const keywordDensity = myBoard.creatures > 0
    ? (myBoard.vigilanceCount + myBoard.hasteCount + myBoard.menaceCount +
       myBoard.deathtouchCount + myBoard.firstStrikeCount + myBoard.reachCount + myBoard.unblockableCount) / myBoard.creatures
    : 0;
  features[idx++] = norm(keywordDensity, 0, 3);
  // Evasion density (already tracked in v2, but re-expose)
  const evasionDensity = myBoard.creatures > 0 ? myBoard.evasivePower / (myBoard.totalPower || 1) : 0;
  features[idx++] = evasionDensity;
  // Protection density (hexproof + shroud + ward)
  const protectionCount = (myBoard.hasHexproof ? 1 : 0) + myBoard.shroudCount + myBoard.wardCount;
  features[idx++] = norm(protectionCount, 0, 5);
  // Reserved
  while (idx < 336) features[idx++] = 0;

  // --- [336-350] Synergy Metrics (15 dims) ---
  // Offensive Synergies [5 dims]
  const evasionCreatureCount = myBoard.unblockableCount + (myBoard.hasFlying ? myBoard.creatures : 0); // rough
  features[idx++] = norm(evasionCreatureCount, 0, 10);
  const evasionDens = myBoard.creatures > 0 ? evasionCreatureCount / myBoard.creatures : 0;
  features[idx++] = evasionDens;
  // Pump spells in hand (cards with "gets +", "target creature")
  const pumpSpellsInHand = me.hand.filter(c => {
    const oracle = (c.oracleText || '').toLowerCase();
    return oracle.includes('gets +') || (oracle.includes('target creature') && oracle.includes('+'));
  }).length;
  features[idx++] = norm(pumpSpellsInHand, 0, 5);
  // Combat trick potential: instant-speed spells * creatures
  const combatTrickPotential = myHand.instants * myBoard.creatures;
  features[idx++] = norm(combatTrickPotential, 0, 30);
  // Double strike combo
  const doubleStrikeCombo = (myBoard.hasDoubleStrike ? 1 : 0) * (pumpSpellsInHand > 0 ? 1 : 0);
  features[idx++] = doubleStrikeCombo;

  // ETB & Recursion Synergies [5 dims]
  features[idx++] = norm(myBoard.etbCreatureCount, 0, 10);
  features[idx++] = norm(myBoard.sacrificeOutletCount, 0, 5);
  const etbSacrificeCombo = myBoard.etbCreatureCount * myBoard.sacrificeOutletCount;
  features[idx++] = norm(etbSacrificeCombo, 0, 20);
  const recursionSpellsInHand = myHand.tagRecursion + myHand.tagReanimation;
  features[idx++] = norm(recursionSpellsInHand, 0, 5);
  // Recursion target value: top 3 CMC creatures in GY
  const gyCreatures = me.graveyard.filter(c => c.typeLine.toLowerCase().includes('creature'));
  gyCreatures.sort((a, b) => b.cmc - a.cmc);
  const recursionTargetValue = gyCreatures.slice(0, 3).reduce((sum, c) => sum + c.cmc, 0);
  features[idx++] = norm(recursionTargetValue, 0, 20);

  // Tribal & Type Synergies [5 dims]
  // Creature type diversity
  const creatureTypes = new Set<string>();
  me.battlefield.forEach(p => {
    if (p.currentPower !== undefined) {
      // Extract creature types from typeline (rough heuristic)
      const types = p.typeLine.split('—')[1]?.trim().split(' ') || [];
      types.forEach(t => creatureTypes.add(t.toLowerCase()));
    }
  });
  const creatureTypeDiversity = creatureTypes.size;
  features[idx++] = norm(creatureTypeDiversity, 0, 10);
  // Enchantment density
  const enchantmentDensity = me.battlefield.length > 0 ? myBoard.enchantmentCount / me.battlefield.length : 0;
  features[idx++] = enchantmentDensity;
  // Artifact density
  const artifactDensity = me.battlefield.length > 0 ? myBoard.artifacts / me.battlefield.length : 0;
  features[idx++] = artifactDensity;
  // Planeswalker count
  const pwCount = me.battlefield.filter(p => p.currentLoyalty !== undefined).length;
  features[idx++] = norm(pwCount, 0, 3);
  features[idx++] = norm(myBoard.tokenGeneratorCount, 0, 5);

  // --- [351-360] Mana Color Alignment (10 dims) ---
  // Color playability: mana available / spells requiring that color
  const colorRequirements = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const colorAvailable = {
    W: me.manaPool.W,
    U: me.manaPool.U,
    B: me.manaPool.B,
    R: me.manaPool.R,
    G: me.manaPool.G
  };
  me.hand.forEach(c => {
    if (c.manaCost) {
      const cost = c.manaCost.toLowerCase();
      if (cost.includes('{w}')) colorRequirements.W++;
      if (cost.includes('{u}')) colorRequirements.U++;
      if (cost.includes('{b}')) colorRequirements.B++;
      if (cost.includes('{r}')) colorRequirements.R++;
      if (cost.includes('{g}')) colorRequirements.G++;
    }
  });

  const colorPlayability: Record<string, number> = {
    W: colorRequirements.W > 0 ? colorAvailable.W / colorRequirements.W : 1,
    U: colorRequirements.U > 0 ? colorAvailable.U / colorRequirements.U : 1,
    B: colorRequirements.B > 0 ? colorAvailable.B / colorRequirements.B : 1,
    R: colorRequirements.R > 0 ? colorAvailable.R / colorRequirements.R : 1,
    G: colorRequirements.G > 0 ? colorAvailable.G / colorRequirements.G : 1,
  };

  // Color-specific playability scores [5 dims]
  features[idx++] = norm(colorPlayability.W, 0, 2);
  features[idx++] = norm(colorPlayability.U, 0, 2);
  features[idx++] = norm(colorPlayability.B, 0, 2);
  features[idx++] = norm(colorPlayability.R, 0, 2);
  features[idx++] = norm(colorPlayability.G, 0, 2);

  // Mana Base Quality [5 dims]
  const colorCongruenceScore = Object.values(colorPlayability).reduce((sum, v) => sum + v, 0) / 5;
  features[idx++] = norm(colorCongruenceScore, 0, 2);
  const colorValues = Object.values(colorPlayability);
  const avgColor = colorValues.reduce((a, b) => a + b, 0) / 5;
  const colorVariance = colorValues.reduce((sum, v) => sum + Math.pow(v - avgColor, 2), 0) / 5;
  features[idx++] = norm(colorVariance, 0, 2);
  // Untapped mana ratio
  const untappedManaRatio = myBoard.lands > 0 ? myBoard.untappedLandCount / myBoard.lands : 0;
  features[idx++] = untappedManaRatio;
  // Fixing lands count
  features[idx++] = norm(myBoard.dualLandsCount, 0, 10);
  // Mana efficiency: affordable spells / total spells
  const totalSpells = me.hand.filter(c => !c.typeLine.toLowerCase().includes('land')).length;
  const affordableSpells = countAffordableSpells(me, myBoard.untappedLandCount + totalMana(me.manaPool));
  const manaEfficiency = totalSpells > 0 ? affordableSpells / totalSpells : 0;
  features[idx++] = manaEfficiency;

  // --- [361-368] Graveyard Recursion Value (8 dims) ---
  // Own Graveyard [4 dims]
  const castableCreaturesInGY = gyCreatures.filter(c => c.cmc <= (myBoard.untappedLandCount + totalMana(me.manaPool))).length;
  features[idx++] = norm(castableCreaturesInGY, 0, 5);
  const highValueInGY = myGY.removals + me.graveyard.filter(c => c.tags.includes('ramp') || c.tags.includes('draw')).length;
  features[idx++] = norm(highValueInGY, 0, 10);
  const avgGYCreatureCMC = gyCreatures.length > 0 ? gyCreatures.reduce((sum, c) => sum + c.cmc, 0) / gyCreatures.length : 0;
  features[idx++] = norm(avgGYCreatureCMC, 0, 8);
  const gyComboReadiness = recursionSpellsInHand * (myGY.highCMCCreatures + highValueInGY);
  features[idx++] = norm(gyComboReadiness, 0, 20);

  // Opponent Graveyard [4 dims]
  const oppRecursionCount = opp.hand.filter(c => c.tags.includes('recursion') || c.tags.includes('reanimation')).length;
  const oppReanimationThreat = oppGY.highCMCCreatures * oppRecursionCount;
  features[idx++] = norm(oppReanimationThreat, 0, 10);
  features[idx++] = norm(oppGY.removals, 0, 10);
  const oppGYCardAdvantage = opp.graveyard.length - me.graveyard.length;
  features[idx++] = norm(oppGYCardAdvantage, -20, 20);
  const gyHateNeed = oppReanimationThreat > 3 ? 1.0 : 0.0;
  features[idx++] = gyHateNeed;

  // --- [369-383] Combo Detection (15 dims) ---
  // Combo Piece Tracking [8 dims]
  const comboPiecesOnBoard = myBoard.tagComboPiece;
  const comboPiecesInHand = myHand.tagComboPiece;
  features[idx++] = norm(comboPiecesOnBoard, 0, 5);
  features[idx++] = norm(comboPiecesInHand, 0, 5);
  // Combo completion ratio (heuristic: if we have 2+ pieces, assume combo)
  const comboPiecesTotal = comboPiecesOnBoard + comboPiecesInHand;
  const comboCompletionRatio = comboPiecesTotal >= 2 ? 0.8 : comboPiecesTotal >= 1 ? 0.4 : 0;
  features[idx++] = comboCompletionRatio;
  // Can execute combo (heuristic: 2+ pieces + mana)
  const canExecuteCombo = comboPiecesTotal >= 2 && myBoard.untappedLandCount >= 3 ? 1.0 : 0.0;
  features[idx++] = canExecuteCombo;
  // Combo mana ready
  const comboManaCost = 6; // heuristic average combo cost
  const comboManaReady = (myBoard.untappedLandCount + totalMana(me.manaPool)) >= comboManaCost ? 1.0 : 0.0;
  features[idx++] = comboManaReady;
  // Turns to combo (rough estimate)
  const turnsToCombo = comboPiecesTotal >= 2 ? Math.max(0, comboManaCost - myBoard.untappedLandCount) : 99;
  features[idx++] = norm(turnsToCombo, 0, 10);
  // Combo protection (counterspells in hand)
  const comboProtection = canExecuteCombo > 0 ? myHand.tagCounter : 0;
  features[idx++] = norm(comboProtection, 0, 3);
  // Combo vulnerability (opponent has removal/interaction)
  const oppInteraction = opp.hand.length; // rough proxy for opponent interaction
  const comboVulnerability = canExecuteCombo > 0 ? norm(oppInteraction, 0, 10) : 0;
  features[idx++] = comboVulnerability;

  // Reserved [7 dims]
  while (idx < 384) features[idx++] = 0;

  return features;
}
