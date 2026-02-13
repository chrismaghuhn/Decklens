import type { GameState } from '../types/game-state.ts';
import type { GameAction } from '../types/action.ts';
import { isLand, isInstant, hasFlash } from '../types/card.ts';
import { canPayCost, parseManaCost, autoTapLandsForCost } from '../rules/mana.ts';
import { canPlayerAct } from '../rules/priority.ts';

/**
 * Validate whether a game action is legal in the current state.
 * Returns an error message if illegal, or null if legal.
 */
export function validateAction(
  state: GameState,
  action: GameAction
): string | null {
  if (state.gameOver) return 'Game is over.';

  // Concede is always valid
  if (action.type === 'concede') return null;

  // Mulligan is only valid during mulligan phase
  if (action.type === 'mulligan') {
    if (!state.mulliganPhase) return 'Not in mulligan phase.';
    return null;
  }

  // Pass is always valid when you have priority (even during untap/cleanup)
  if (action.type === 'pass') {
    if (state.priorityPlayer !== action.player) return 'Not your priority.';
    return null;
  }

  // Priority check (blocks non-pass actions during untap/cleanup)
  if (!canPlayerAct(state, action.player)) {
    return 'Not your priority.';
  }

  switch (action.type) {
    case 'play-land':
      return validatePlayLand(state, action);
    case 'cast-spell':
      return validateCastSpell(state, action);
    case 'activate-ability':
      return validateActivateAbility(state, action);
    case 'declare-attackers':
      return validateDeclareAttackers(state, action);
    case 'declare-blockers':
      return validateDeclareBlockers(state, action);
    default:
      return 'Unknown action type.';
  }
}

/** Check if an action is legal (boolean shorthand) */
export function isLegalAction(state: GameState, action: GameAction): boolean {
  return validateAction(state, action) === null;
}

/**
 * Get all legal action types for the current priority player.
 */
export function getLegalActionTypes(state: GameState): GameAction['type'][] {
  const player = state.priorityPlayer;
  const types: GameAction['type'][] = [];

  if (state.gameOver) return [];
  
  // During mulligan phase, only mulligan is legal (plus concede)
  if (state.mulliganPhase) {
    types.push('mulligan', 'concede');
    return types;
  }

  // In untap/cleanup, only pass and concede are legal (no other actions)
  if (!canPlayerAct(state, player)) {
    types.push('pass', 'concede');
    return types;
  }

  types.push('pass', 'concede');

  if (canPlayLand(state, player)) types.push('play-land');
  if (canCastAnySpell(state, player)) types.push('cast-spell');
  if (canActivateAnyAbility(state, player)) types.push('activate-ability');

  if (
    state.step === 'declare-attackers' &&
    state.activePlayer === player &&
    hasUntappedCreatures(state, player)
  ) {
    types.push('declare-attackers');
  }

  if (
    state.step === 'declare-blockers' &&
    state.activePlayer !== player &&
    state.combat &&
    state.combat.attackers.length > 0
  ) {
    types.push('declare-blockers');
  }

  return types;
}

// --- Validators ---

function validatePlayLand(
  state: GameState,
  action: Extract<GameAction, { type: 'play-land' }>
): string | null {
  const player = state.players[action.player];

  if (state.step !== 'main') return 'Can only play lands during main phase.';
  if (state.activePlayer !== action.player) return 'Only active player can play lands.';
  if (player.landsPlayedThisTurn >= player.maxLandPlays) return 'Already played maximum lands this turn.';
  if (state.stack.length > 0) return 'Cannot play lands while stack is not empty.';

  const card = player.hand.find((c) => c.id === action.cardId);
  if (!card) return 'Card not in hand.';
  if (!isLand(card)) return 'Card is not a land.';

  return null;
}

function validateCastSpell(
  state: GameState,
  action: Extract<GameAction, { type: 'cast-spell' }>
): string | null {
  const player = state.players[action.player];
  const card = player.hand.find((c) => c.id === action.cardId);
  if (!card) return 'Card not in hand.';
  if (isLand(card)) return 'Lands are played, not cast.';

  // Non-main phase: only instants and flash
  if (state.step !== 'main') {
    if (!isInstant(card) && !hasFlash(card)) {
      return 'Can only cast instants or flash spells outside main phase.';
    }
  }

  // Sorcery-speed: only during main phase with empty stack, active player
  if (!isInstant(card) && !hasFlash(card)) {
    if (state.activePlayer !== action.player) return 'Can only cast sorcery-speed spells on your turn.';
    if (state.stack.length > 0) return 'Cannot cast sorcery-speed spells while stack is not empty.';
  }

  const cost = parseManaCost(card.manaCost);
  
  // Check if we can pay with existing pool OR by auto-tapping lands
  if (!canPayCost(player.manaPool, cost, player.life)) {
    // Try auto-tapping
    const tapResult = autoTapLandsForCost(player, cost);
    if (!tapResult) {
      return 'Not enough mana to cast this spell.';
    }
  }

  return null;
}

function validateActivateAbility(
  state: GameState,
  action: Extract<GameAction, { type: 'activate-ability' }>
): string | null {
  const player = state.players[action.player];
  const source = player.battlefield.find((p) => p.id === action.sourceId);
  if (!source) return 'Permanent not on battlefield.';

  const ability = source.abilities[action.abilityIndex];
  if (!ability) return 'Ability not found on permanent.';

  if (!ability.instantSpeed) {
    if (state.step !== 'main') return 'Can only activate this ability during main phase.';
    if (state.stack.length > 0) return 'Cannot activate sorcery-speed ability while stack is not empty.';
  }

  return null;
}

function validateDeclareAttackers(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-attackers' }>
): string | null {
  if (state.step !== 'declare-attackers') return 'Not the declare attackers step.';
  if (state.activePlayer !== action.player) return 'Only active player can declare attackers.';

  const player = state.players[action.player];

  for (const attackerId of action.attackers) {
    const creature = player.battlefield.find((p) => p.id === attackerId);
    if (!creature) return `Creature ${attackerId} not on battlefield.`;
    if (creature.currentPower === undefined) return `${creature.name} is not a creature.`;
    if (creature.tapped) return `${creature.name} is tapped.`;
    if (creature.summoningSick) return `${creature.name} has summoning sickness.`;
  }

  return null;
}

function validateDeclareBlockers(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-blockers' }>
): string | null {
  if (state.step !== 'declare-blockers') return 'Not the declare blockers step.';
  if (state.activePlayer === action.player) return 'Active player cannot declare blockers.';
  if (!state.combat) return 'No combat in progress.';

  const player = state.players[action.player];

  for (const block of action.blocks) {
    const blocker = player.battlefield.find((p) => p.id === block.blocker);
    if (!blocker) return `Blocker ${block.blocker} not on battlefield.`;
    if (blocker.tapped) return `${blocker.name} is tapped and cannot block.`;

    const attackerExists = state.combat.attackers.some((a) => a.permanentId === block.attacker);
    if (!attackerExists) return `Attacker ${block.attacker} not found.`;
  }

  return null;
}

// --- Helpers ---

function canPlayLand(state: GameState, player: 0 | 1): boolean {
  if (state.step !== 'main' || state.activePlayer !== player || state.stack.length > 0) return false;
  const ps = state.players[player];
  return ps.landsPlayedThisTurn < ps.maxLandPlays && ps.hand.some((c) => isLand(c));
}

function canCastAnySpell(state: GameState, player: 0 | 1): boolean {
  const ps = state.players[player];
  for (const card of ps.hand) {
    if (isLand(card)) continue;
    if (state.step !== 'main' && !isInstant(card) && !hasFlash(card)) continue;
    if (!isInstant(card) && !hasFlash(card)) {
      if (state.activePlayer !== player || state.stack.length > 0) continue;
    }
    const cost = parseManaCost(card.manaCost);
    if (canPayCost(ps.manaPool, cost, ps.life)) return true;
    if (autoTapLandsForCost(ps, cost) !== null) return true;
  }
  return false;
}

function canActivateAnyAbility(state: GameState, player: 0 | 1): boolean {
  const ps = state.players[player];
  for (const perm of ps.battlefield) {
    for (const ability of perm.abilities) {
      if (!ability.instantSpeed && state.step !== 'main') continue;
      if (!ability.instantSpeed && state.stack.length > 0) continue;
      return true;
    }
  }
  return false;
}

function hasUntappedCreatures(state: GameState, player: 0 | 1): boolean {
  return state.players[player].battlefield.some(
    (p) => p.currentPower !== undefined && !p.tapped && !p.summoningSick
  );
}
