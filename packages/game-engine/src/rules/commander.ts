import type { GameState } from '../types/game-state.ts';
import type { Card, Color } from '../types/card.ts';
import type { ManaCost } from '../types/mana.ts';
import { parseManaCost } from './mana.ts';

/**
 * Commander-specific rules for EDH.
 *
 * Handles:
 * - Commander tax (costs {2} more each time cast from command zone)
 * - Commander damage tracking
 * - Commander zone replacement (commander → graveyard/exile can go to command zone instead)
 * - Color identity validation
 * - Casting commander from command zone
 */

/**
 * Get the effective mana cost for casting a commander from the command zone.
 * Base cost + {2} for each time previously cast.
 */
export function getCommanderCost(commander: Card, tax: number): ManaCost {
  const baseCost = parseManaCost(commander.manaCost);
  return {
    ...baseCost,
    generic: baseCost.generic + (tax * 2),
  };
}

/**
 * Track commander damage dealt to a player.
 * In EDH, 21+ combat damage from a single commander = loss.
 */
export function trackCommanderDamage(
  state: GameState,
  commanderId: string,
  damage: number,
  defenderId: number
): GameState {
  if (damage <= 0) return state;

  const player = state.players[defenderId];
  const currentDamage = player.commanderDamage[commanderId] || 0;

  const players = [...state.players];
  players[defenderId] = {
    ...player,
    commanderDamage: {
      ...player.commanderDamage,
      [commanderId]: currentDamage + damage,
    },
  };

  return { ...state, players };
}

/**
 * Handle commander zone replacement.
 * When a commander would go to graveyard or exile, its owner may choose
 * to put it in the command zone instead. In our engine, we always choose
 * command zone (the bot/UI can override this if needed).
 *
 * Also increments commander tax.
 */
export function handleCommanderDeath(
  state: GameState,
  commanderName: string,
  owner: number
): GameState {
  const player = state.players[owner];

  // Find the commander in graveyard (it was just sent there by SBA)
  const graveyardIdx = player.graveyard.findIndex(
    (c) => c.name === commanderName && c.typeLine.toLowerCase().includes('legendary')
  );

  if (graveyardIdx === -1) return state; // Not in graveyard, nothing to do

  const commander = player.graveyard[graveyardIdx];

  const players = [...state.players];
  players[owner] = {
    ...player,
    graveyard: [
      ...player.graveyard.slice(0, graveyardIdx),
      ...player.graveyard.slice(graveyardIdx + 1),
    ],
    commandZone: [...player.commandZone, commander],
    commanderTax: player.commanderTax,
  };

  return {
    ...state,
    players,
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player: owner,
        message: `${commander.name} returns to the command zone. Commander tax is ${player.commanderTax * 2}.`,
        cardName: commander.name,
      },
    ],
  };
}

/**
 * Handle commander going to exile — move to command zone instead.
 */
export function handleCommanderExile(
  state: GameState,
  commanderName: string,
  owner: number
): GameState {
  const player = state.players[owner];

  const exileIdx = player.exile.findIndex(
    (c) => c.name === commanderName && c.typeLine.toLowerCase().includes('legendary')
  );

  if (exileIdx === -1) return state;

  const commander = player.exile[exileIdx];

  const players = [...state.players];
  players[owner] = {
    ...player,
    exile: [
      ...player.exile.slice(0, exileIdx),
      ...player.exile.slice(exileIdx + 1),
    ],
    commandZone: [...player.commandZone, commander],
    commanderTax: player.commanderTax,
  };

  return {
    ...state,
    players,
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player: owner,
        message: `${commander.name} returns to the command zone from exile. Commander tax is ${player.commanderTax * 2}.`,
        cardName: commander.name,
      },
    ],
  };
}

/**
 * Cast commander from command zone.
 * Moves commander from command zone to hand temporarily
 * (will be moved to stack by cast-spell action).
 */
export function takeCommanderFromCommandZone(
  state: GameState,
  player: number
): { state: GameState; commander: Card | null } {
  const ps = state.players[player];
  if (ps.commandZone.length === 0) return { state, commander: null };

  const commander = ps.commandZone[0];

  const players = [...state.players];
  players[player] = {
    ...ps,
    commandZone: ps.commandZone.slice(1),
    hand: [...ps.hand, commander],
  };

  return {
    state: { ...state, players },
    commander,
  };
}

/**
 * Check if all cards in a deck match the commander's color identity.
 * Used for deck validation, not runtime.
 */
export function validateColorIdentity(
  deck: Card[],
  commander: Card
): { valid: boolean; violations: Card[] } {
  const commanderIdentity = new Set(commander.colorIdentity);
  const violations: Card[] = [];

  for (const card of deck) {
    for (const color of card.colorIdentity) {
      if (!commanderIdentity.has(color)) {
        violations.push(card);
        break;
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Check if a card's color identity fits within a commander's color identity.
 */
export function cardFitsColorIdentity(
  card: Card,
  commanderIdentity: Color[]
): boolean {
  const identitySet = new Set(commanderIdentity);
  return card.colorIdentity.every((c) => identitySet.has(c));
}

/**
 * After state-based actions have moved permanents to graveyard or exile,
 * check if any of them are commanders and prompt the owner to choose
 * whether to move them to the command zone (2020 rule change).
 *
 * Sets pendingCommanderChoice instead of auto-moving.
 */
export function processCommanderZoneReplacements(state: GameState): GameState {
  // If there's already a pending choice, don't check again
  if (state.pendingCommanderChoice) return state;

  let current = state;

  for (let i = 0; i < current.players.length; i++) {
    const player = current.players[i];

    // Check graveyard for commander
    for (const card of player.graveyard) {
      if (isLikelyCommander(card, player)) {
        return {
          ...current,
          pendingCommanderChoice: {
            player: i,
            commanderName: card.name,
            currentZone: 'graveyard',
          },
          log: [...current.log, {
            timestamp: Date.now(),
            turn: current.turn,
            phase: current.phase,
            step: current.step,
            player: i,
            message: `${card.name} went to graveyard. Move to command zone?`,
            cardName: card.name,
          }],
        };
      }
    }

    // Check exile for commander
    for (const card of player.exile) {
      if (isLikelyCommander(card, player)) {
        return {
          ...current,
          pendingCommanderChoice: {
            player: i,
            commanderName: card.name,
            currentZone: 'exile',
          },
          log: [...current.log, {
            timestamp: Date.now(),
            turn: current.turn,
            phase: current.phase,
            step: current.step,
            player: i,
            message: `${card.name} was exiled. Move to command zone?`,
            cardName: card.name,
          }],
        };
      }
    }
  }

  return current;
}

/**
 * Heuristic to determine if a card is a player's commander.
 * Uses the tracked commanderNames first (set at game creation), then
 * falls back to checking if the card matches any card in the command zone by name.
 */
function isLikelyCommander(card: Card, player: PlayerState): boolean {
  // Check tracked commander names first
  if (player.commanderNames && player.commanderNames.length > 0) {
    return player.commanderNames.includes(card.name);
  }
  // Fallback: check if the card matches any card that was in the command zone by name
  return player.commandZone.some((c) => c.name === card.name);
}
