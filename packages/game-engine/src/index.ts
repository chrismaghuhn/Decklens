// === Types ===
export type {
  Color,
  CardTag,
  Card,
  ManaPool,
  ManaCost,
  PhyrexianCost,
  HybridCost,
  ManaPayment,
  Zone,
  Ability,
  Permanent,
  PlayerState,
  Target,
  StackObject,
  GameAction,
  CombatState,
  AttackingCreature,
  BlockingCreature,
  Phase,
  Step,
  GameLogEntry,
  GameState,
} from './types/index.ts';

// === Type Constants & Helpers ===
export {
  isLand,
  isCreature,
  isArtifact,
  isEnchantment,
  isPlaneswalker,
  isInstant,
  isSorcery,
  isLegendary,
  hasFlash,
  ALL_ZONES,
  PUBLIC_ZONES,
  HIDDEN_ZONES,
  cardToPermanent,
  STARTING_LIFE,
  emptyManaPool,
  createPlayerState,
  PHASE_STEPS,
  PHASES,
} from './types/index.ts';

// === Mana Rules ===
export {
  emptyPool,
  totalMana,
  addMana,
  emptyManaCost,
  parseManaCost,
  calculateCMC,
  canPayCost,
  payCost,
  autoPayCost,
  autoTapLandsForCost,
} from './rules/mana.ts';

// === Turn Manager ===
export {
  getNextStep,
  getNextPhase,
  advanceStep,
  advancePhase,
  startNewTurn,
  grantExtraTurn,
  grantExtraCombat,
  getCurrentStepActions,
  createInitialGameState,
} from './engine/turn-manager.ts';

// === Zone Manager ===
export {
  getCardsInZone,
  findCard,
  moveCard,
  drawCard,
  drawCards,
  shuffleLibrary,
  millCards,
  drawOpeningHand,
} from './engine/zone-manager.ts';

// === Undo Manager ===
export { UndoManager } from './engine/undo-manager.ts';
export type { GameSnapshot } from './engine/undo-manager.ts';

// === Factory Functions ===
export {
  generateCardId,
  resetIdCounter,
  createCard,
  createSimpleCard,
  performLondonMulligan,
  startMulligan,
  keepHand,
  setupNewGame,
} from './engine/factory.ts';

// === Priority System ===
export {
  getCurrentPriorityPlayer,
  passPriority,
  retainPriorityAfterAction,
  giveActivePlayerPriority,
  canPlayerAct,
} from './rules/priority.ts';

// === Stack ===
export {
  addSpellToStack,
  addAbilityToStack,
  resolveTopOfStack,
  checkSpellFizzle,
  getStackSize,
  isStackEmpty,
  peekStack,
  resetStackIdCounter,
} from './rules/stack.ts';

// === Action Execution ===
export { executeAction } from './engine/actions.ts';

// === Validation ===
export {
  validateAction,
  isLegalAction,
  getLegalActionTypes,
} from './engine/validation.ts';

// === Combat ===
export {
  initializeCombat,
  resolveCombatDamage,
  endCombat,
  hasFirstStrikeCombatants,
  getEligibleAttackers,
  getEligibleBlockers,
  hasKeyword,
  canBlock,
  getProtectionColors,
  hasProtectionFrom,
  checkMultiBlockerAssignment,
  validateDamageAssignment,
  applyDamageAssignment,
} from './rules/combat.ts';

// === State-Based Actions ===
export {
  checkStateBasedActions,
  checkCommanderDamageLoss,
  checkEmptyLibraryLoss,
} from './rules/state-based.ts';
export type { SBAResult } from './rules/state-based.ts';

// === Commander Rules ===
export {
  getCommanderCost,
  trackCommanderDamage,
  handleCommanderDeath,
  handleCommanderExile,
  takeCommanderFromCommandZone,
  validateColorIdentity,
  cardFitsColorIdentity,
  processCommanderZoneReplacements,
} from './rules/commander.ts';

// === Ability Parser ===
export {
  parseAbilities,
  getManaProduction,
  hasManaAbility,
  resetAbilityIdCounter,
  parseLoyaltyCost,
} from './rules/abilities.ts';

// === Effect Resolver ===
export {
  resolveEffect,
  canAutoResolve,
  EFFECT_PATTERNS,
} from './rules/effects.ts';
export type { EffectResult } from './rules/effects.ts';

// === Triggered Abilities ===
export {
  checkTriggers,
  checkETBTriggers,
  checkDeathTriggers,
  checkUpkeepTriggers,
  checkCastTriggers,
  checkAttackTriggers,
  checkLeavesBattlefieldTriggers,
  checkDamageTriggers,
  checkDrawTriggers,
  checkEndStepTriggers,
  checkLifegainTriggers,
  checkSacrificeTriggers,
  resetTriggerIdCounter,
} from './rules/triggers.ts';
export type { TriggerEvent } from './rules/triggers.ts';

// === Equipment & Auras ===
export {
  isEquipment,
  isAura,
  getEquipCost,
  getEquipmentBonuses,
  getEquipmentKeywords,
  getAuraBonuses,
  getAuraKeywords,
  attachEquipment,
  handleAttachmentCleanup,
  recalculateCreatureStats,
} from './rules/equipment.ts';

// === Continuous Effects (Lords, Anthems, Static Abilities) ===
export {
  applyContinuousEffects,
  getStaticBonuses,
  getGrantedKeywords,
  hasKeywordWithContinuous,
  matchesTypeFilter,
} from './rules/continuous.ts';
export type { StaticBonus } from './rules/continuous.ts';

// === Replacement Effects (CR 614) ===
export {
  checkReplacementEffects,
  applyDeathReplacement,
  applyDrawReplacement,
  applyDamageReplacement,
  applyLifeGainReplacement,
  applyGraveyardReplacement,
  REPLACEMENT_EFFECTS,
} from './rules/replacement-effects.ts';
export type {
  ReplacementEventType,
  ReplacementEvent,
  ReplacementResult,
  ReplacementEffectDef,
} from './rules/replacement-effects.ts';

// === Cost Parser (Activated Abilities) ===
export { parseCost, canPayAbilityCost, payAbilityCost } from './rules/cost-parser.ts';
export type { AbilityCost } from './rules/cost-parser.ts';

// === Game ===
export { Game } from './engine/game.ts';
