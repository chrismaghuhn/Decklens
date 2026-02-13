/**
 * Reward Configuration — All reward constants and tuning parameters.
 *
 * 11 reward categories covering game outcomes, resource management,
 * board development, interaction, combat, combos, strategy,
 * commander, graveyard, mulligan, and misplays.
 */

// === 1. Game Outcome (Terminal) ===
export const OUTCOME_REWARDS = {
  baseWin: 100,
  fastWinBonus: 50,            // Turn <= 7
  comebackWinBonus: 30,        // Won from <10 life
  commanderDamageWin: 20,
  infiniteComboWin: 15,
  baseLoss: -100,
  earlyScoopPenalty: -30,      // Conceded before turn 5
} as const;

// === 2. Resource Management (Per Turn) ===
export const RESOURCE_REWARDS = {
  perfectManaUsage: 5,         // Used all mana
  goodManaUsage: 3,            // 90%+ mana used
  wasted3Mana: -2,
  wasted5Mana: -5,
  drewExtraCard: 3,
  tutored: 4,
  discarded: -2,
  milledImportantCard: -3,
  goodHandSize: 1,             // 5-7 cards at end step
  hellbent: -4,                // 0 cards
  overdraw: -2,                // 8+ cards
} as const;

// === 3. Board Development (Per Turn) ===
export const BOARD_REWARDS = {
  playedRamp: 4,
  fixedMana: 2,
  missedLandDrop: -3,          // Turns 1-4 only
  playedCreature: 2,
  playedEngine: 5,
  playedPayoff: 4,
  boardWiped: -10,             // Lost 3+ permanents
  rebuiltAfterWipe: 8,
  triggeredSynergy: 3,
  activatedAbility: 2,
  multiSpellTurn: 3,           // 2+ spells cast
  setupPlay: 2,                // Ramp/Engine/Tutor
} as const;

// === 4. Interaction & Answers (Per Action) ===
export const INTERACTION_REWARDS = {
  removedKeyThreat: 8,
  removedCreature: 4,
  removedArtifactEnchantment: 4,
  profitableBoardWipe: 12,
  unprofitableBoardWipe: -6,
  counteredWinCon: 10,
  counteredKeySpell: 6,
  counteredMediumSpell: 4,
  counteredWeakSpell: -2,
  protectedKeyPermanent: 5,
  protectedFromWipe: 8,
} as const;

// === 5. Combat & Damage (Per Combat) ===
export const COMBAT_REWARDS = {
  dealtCombatDamage: 0.5,      // Per damage, capped at +10
  reducedOppTo10Life: 8,
  lethalAttack: 15,
  badAttack: -4,
  favorableBlock: 3,
  profitableBlock: 3,
  tradeBlock: 1,
  chumBlock: -1,
  blockedLethal: 8,
  tradedInBlock: 1,            // Legacy alias
  badBlock: -3,                // Legacy alias
  gainedLife5Plus: 2,
  lostLife5Plus: -1,
  droppedBelow20: -2,
  droppedBelow10: -5,
  droppedTo5OrLess: -8,
} as const;

// === 6. Combo & Win Conditions (Per Turn) ===
export const COMBO_REWARDS = {
  assembled1of3: 4,
  assembled2of3: 10,
  assembledFullCombo: 25,
  lostComboPiece: -8,
  protectedComboPiece: 6,
  commanderOutOnCurve: 6,      // Turn 3-5
  commanderEquipped: 5,
  altWinConOnBoard: 12,
  infiniteManaReady: 20,
  infiniteDrawReady: 20,
} as const;

// === 7. Strategic Positioning (Per Turn) ===
export const STRATEGIC_REWARDS = {
  notBiggestThreat: 2,
  answeredBiggestThreat: 6,
  becameArchenemy: -4,
  drewBomb: 5,
  playedBombOnCurve: 8,
  topdeckedAnswer: 6,
  deadCardInHand: -1,
  curvedOutT1to4: 6,
  tempoPlay: 5,
  tempoLoss: -5,
} as const;

// === 8. Commander-Specific (Per Action) ===
export const COMMANDER_REWARDS = {
  castCommanderFirst: 6,
  castCommanderSecond: 3,
  castCommanderThirdPlus: 1,
  commanderTaxOver6: -3,
  commanderDealtDamage: 1,     // Per damage
  commanderDealt10Plus: 8,
  commanderKilled: -4,
  commanderDied3Plus: -8,
  protectedCommander: 4,
  commanderStuckT6Plus: -2,    // Per turn stuck
} as const;

// === 9. Graveyard & Exile (Per Action) ===
export const GRAVEYARD_REWARDS = {
  filledGraveyardForStrategy: 3,
  reanimatedCreature: 6,
  recursionSpell: 4,
  graveyardExiled: -6,
  exiledOppKeyCard: 5,
  ownCardExiled: -2,
  castFromExile: 3,
} as const;

// === 10. Mulligan (Game Start) ===
export const MULLIGAN_REWARDS = {
  keptGoodHand: 5,
  keptRiskyHand: -3,
  mulliganTo6: -2,
  mulliganTo5OrLess: -5,
} as const;

// === 11. Mistakes & Misplays ===
export const MISPLAY_PENALTIES = {
  playedIntoOpenMana: -5,
  overextendedIntoWipe: -8,
  wrongTutorTarget: -4,
  missedLethal: -15,
  unnecessaryRisk: -3,
} as const;

/** Global reward scaling config */
export interface RewardConfig {
  /** Penalties are scaled by this factor (< 1 means softer penalties) */
  penaltyScale: number;
  /** Max reward per single step (clamped) */
  maxStepReward: number;
  /** Min reward per single step (clamped) */
  minStepReward: number;
  /** Final scale factor for neural network input */
  scaleFactor: number;
}

/** Default reward configuration */
export const DEFAULT_REWARD_CONFIG: RewardConfig = {
  penaltyScale: 0.65,
  maxStepReward: 30,
  minStepReward: -20,
  scaleFactor: 0.1,
};
