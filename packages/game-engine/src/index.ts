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

// === Game ===
export { Game } from './engine/game.ts';
