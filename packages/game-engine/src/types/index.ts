// Card types
export type { Color, CardTag, Card } from './card.ts';
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
} from './card.ts';

// Mana types
export type {
  ManaPool,
  ManaCost,
  PhyrexianCost,
  HybridCost,
  ManaPayment,
} from './mana.ts';

// Zone types
export type { Zone } from './zones.ts';
export { ALL_ZONES, PUBLIC_ZONES, HIDDEN_ZONES } from './zones.ts';

// Permanent types
export type { Ability, Permanent, TemporaryPtMod, TemporaryControlChange, TemporaryKeyword } from './permanent.ts';
export { cardToPermanent } from './permanent.ts';

// Player types
export type { PlayerState } from './player.ts';
export { STARTING_LIFE, emptyManaPool, createPlayerState } from './player.ts';

// Action types
export type {
  Target,
  StackObject,
  GameAction,
  CombatState,
  AttackingCreature,
  BlockingCreature,
} from './action.ts';

// Game state types
export type { Phase, Step, GameLogEntry, GameState } from './game-state.ts';
export { PHASE_STEPS, PHASES } from './game-state.ts';
