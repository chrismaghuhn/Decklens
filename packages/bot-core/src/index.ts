// === Bot Interface ===
export { HeuristicBot } from './bot.ts';

// === Decision Tree ===
export type { Decision } from './decision-tree.ts';
export { makeDecision } from './decision-tree.ts';

// === Evaluators ===
export type { BoardScore } from './evaluators/board-evaluator.ts';
export {
  evaluatePermanent,
  evaluatePlayerBoard,
  evaluateBoardPosition,
  hasBoardDominance,
  getOpponentTotalPower,
} from './evaluators/board-evaluator.ts';

export type { HandAssessment } from './evaluators/hand-evaluator.ts';
export {
  scoreCardInHand,
  countLands,
  getCastableSpells,
  getLandsInHand,
  getSpellsInHand,
  assessHand,
  chooseMulliganBottoms,
} from './evaluators/hand-evaluator.ts';

export type { ThreatLevel, Threat } from './evaluators/threat-evaluator.ts';
export {
  evaluatePermanentThreat,
  evaluateStackThreat,
  identifyThreats,
  hasMustAnswerThreat,
  getTopThreat,
} from './evaluators/threat-evaluator.ts';

export type { ComboPattern, ComboState } from './evaluators/combo-evaluator.ts';
export {
  KNOWN_COMBOS,
  evaluateCombos,
  hasWinningCombo,
  getBestComboTarget,
  scoreComboRelevance,
} from './evaluators/combo-evaluator.ts';

// === Policies ===
export {
  shouldKeepHand,
  chooseMulliganAction,
  explainMulliganDecision,
} from './policies/mulligan-policy.ts';

export type { PlayCandidate } from './policies/play-policy.ts';
export {
  chooseLandDrop,
  getCastCandidates,
  choosePlayAction,
  shouldHoldMana,
} from './policies/play-policy.ts';

export {
  chooseAttackers,
  chooseBlockers,
  shouldAttack,
} from './policies/combat-policy.ts';

export {
  shouldCounterTopSpell,
  shouldRespondWithRemoval,
  chooseStackAction,
} from './policies/stack-policy.ts';
