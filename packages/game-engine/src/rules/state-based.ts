import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { Permanent } from '../types/permanent.ts';
import type { Card } from '../types/card.ts';
import { isLegendary, isCreature, isPlaneswalker } from '../types/card.ts';

/**
 * State-Based Actions (SBAs) for EDH.
 *
 * SBAs are checked every time a player would receive priority.
 * They loop until no more SBAs apply.
 *
 * Key SBAs:
 * - Creature with damage >= toughness → graveyard (destroy)
 * - Creature with 0 or less toughness → graveyard
 * - Planeswalker with 0 or less loyalty → graveyard
 * - Player with 0 or less life loses
 * - Player with 10+ poison counters loses
 * - Player with 21+ commander damage from one source loses
 * - Player who tried to draw from empty library loses
 * - Legend rule (if player controls 2+ legendary permanents with same name, keep one)
 * - Token in non-battlefield zone → cease to exist (remove)
 */

export interface SBAResult {
  state: GameState;
  /** Whether any state-based actions were applied */
  changed: boolean;
}

/**
 * Check and apply all state-based actions.
 * Loops until no more SBAs apply.
 */
export function checkStateBasedActions(state: GameState): GameState {
  let current = state;
  let changed = true;

  while (changed) {
    changed = false;

    const r1 = checkPlayerLoss(current);
    if (r1.changed) { current = r1.state; changed = true; }
    if (current.gameOver) return current;

    const r2 = checkCreatureDeath(current);
    if (r2.changed) { current = r2.state; changed = true; }

    const r3 = checkZeroToughness(current);
    if (r3.changed) { current = r3.state; changed = true; }

    const r4 = checkPlaneswalkerLoyalty(current);
    if (r4.changed) { current = r4.state; changed = true; }

    const r5 = checkLegendRule(current);
    if (r5.changed) { current = r5.state; changed = true; }

    const r6 = checkPoisonCounters(current);
    if (r6.changed) { current = r6.state; changed = true; }
    if (current.gameOver) return current;
  }

  return current;
}

/** Player with 0 or less life loses */
function checkPlayerLoss(state: GameState): SBAResult {
  if (state.gameOver) return { state, changed: false };

  for (let i = 0; i < 2; i++) {
    const player = state.players[i as 0 | 1];
    if (player.life <= 0) {
      const winner: 0 | 1 = i === 0 ? 1 : 0;
      return {
        state: {
          ...state,
          winner,
          gameOver: true,
          log: [
            ...state.log,
            {
              timestamp: Date.now(),
              turn: state.turn,
              phase: state.phase,
              step: state.step,
              player: i as 0 | 1,
              message: `${player.name} has ${player.life} life and loses the game.`,
            },
          ],
        },
        changed: true,
      };
    }
  }

  return { state, changed: false };
}

/** Creatures with damage >= toughness are destroyed */
function checkCreatureDeath(state: GameState): SBAResult {
  let changed = false;
  const players = [...state.players] as [PlayerState, PlayerState];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i as 0 | 1];
    const dying: Permanent[] = [];
    const surviving: Permanent[] = [];

    for (const perm of player.battlefield) {
      if (
        perm.currentToughness !== undefined &&
        perm.damage >= perm.currentToughness &&
        perm.currentToughness > 0
      ) {
        dying.push(perm);
        logs.push(`${perm.name} is destroyed (lethal damage).`);
      } else {
        surviving.push(perm);
      }
    }

    if (dying.length > 0) {
      changed = true;
      const dyingCards: Card[] = dying.map(permanentToCard);
      players[i as 0 | 1] = {
        ...player,
        battlefield: surviving,
        graveyard: [...player.graveyard, ...dyingCards],
      };
    }
  }

  if (!changed) return { state, changed: false };

  const logEntries = logs.map((message) => ({
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase,
    step: state.step,
    player: null as 0 | 1 | null,
    message,
  }));

  return {
    state: { ...state, players, log: [...state.log, ...logEntries] },
    changed: true,
  };
}

/** Creatures with 0 or less toughness go to graveyard */
function checkZeroToughness(state: GameState): SBAResult {
  let changed = false;
  const players = [...state.players] as [PlayerState, PlayerState];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i as 0 | 1];
    const dying: Permanent[] = [];
    const surviving: Permanent[] = [];

    for (const perm of player.battlefield) {
      if (perm.currentToughness !== undefined && perm.currentToughness <= 0) {
        dying.push(perm);
        logs.push(`${perm.name} has 0 toughness and is put into the graveyard.`);
      } else {
        surviving.push(perm);
      }
    }

    if (dying.length > 0) {
      changed = true;
      const dyingCards: Card[] = dying.map(permanentToCard);
      players[i as 0 | 1] = {
        ...player,
        battlefield: surviving,
        graveyard: [...player.graveyard, ...dyingCards],
      };
    }
  }

  if (!changed) return { state, changed: false };

  const logEntries = logs.map((message) => ({
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase,
    step: state.step,
    player: null as 0 | 1 | null,
    message,
  }));

  return {
    state: { ...state, players, log: [...state.log, ...logEntries] },
    changed: true,
  };
}

/** Planeswalkers with 0 or less loyalty go to graveyard */
function checkPlaneswalkerLoyalty(state: GameState): SBAResult {
  let changed = false;
  const players = [...state.players] as [PlayerState, PlayerState];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i as 0 | 1];
    const dying: Permanent[] = [];
    const surviving: Permanent[] = [];

    for (const perm of player.battlefield) {
      if (perm.currentLoyalty !== undefined && perm.currentLoyalty <= 0) {
        dying.push(perm);
        logs.push(`${perm.name} has 0 loyalty and is put into the graveyard.`);
      } else {
        surviving.push(perm);
      }
    }

    if (dying.length > 0) {
      changed = true;
      const dyingCards: Card[] = dying.map(permanentToCard);
      players[i as 0 | 1] = {
        ...player,
        battlefield: surviving,
        graveyard: [...player.graveyard, ...dyingCards],
      };
    }
  }

  if (!changed) return { state, changed: false };

  const logEntries = logs.map((message) => ({
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase,
    step: state.step,
    player: null as 0 | 1 | null,
    message,
  }));

  return {
    state: { ...state, players, log: [...state.log, ...logEntries] },
    changed: true,
  };
}

/**
 * Legend rule: if a player controls two or more legendary permanents
 * with the same name, they keep the newest one and the rest go to graveyard.
 */
function checkLegendRule(state: GameState): SBAResult {
  let changed = false;
  const players = [...state.players] as [PlayerState, PlayerState];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i as 0 | 1];
    const legendaryByName = new Map<string, Permanent[]>();

    for (const perm of player.battlefield) {
      if (isLegendary(perm)) {
        const existing = legendaryByName.get(perm.name) || [];
        existing.push(perm);
        legendaryByName.set(perm.name, existing);
      }
    }

    const toRemove = new Set<string>();
    for (const [name, perms] of legendaryByName) {
      if (perms.length > 1) {
        // Keep the most recently entered (highest enteredBattlefieldTurn, or last in array)
        const sorted = [...perms].sort(
          (a, b) => b.enteredBattlefieldTurn - a.enteredBattlefieldTurn
        );
        for (let j = 1; j < sorted.length; j++) {
          toRemove.add(sorted[j].id);
          logs.push(`${name} is put into the graveyard (legend rule).`);
        }
      }
    }

    if (toRemove.size > 0) {
      changed = true;
      const dying = player.battlefield.filter((p) => toRemove.has(p.id));
      const surviving = player.battlefield.filter((p) => !toRemove.has(p.id));
      const dyingCards: Card[] = dying.map(permanentToCard);
      players[i as 0 | 1] = {
        ...player,
        battlefield: surviving,
        graveyard: [...player.graveyard, ...dyingCards],
      };
    }
  }

  if (!changed) return { state, changed: false };

  const logEntries = logs.map((message) => ({
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase,
    step: state.step,
    player: null as 0 | 1 | null,
    message,
  }));

  return {
    state: { ...state, players, log: [...state.log, ...logEntries] },
    changed: true,
  };
}

/** Player with 10+ poison counters loses */
function checkPoisonCounters(state: GameState): SBAResult {
  if (state.gameOver) return { state, changed: false };

  for (let i = 0; i < 2; i++) {
    const player = state.players[i as 0 | 1];
    if (player.poisonCounters >= 10) {
      const winner: 0 | 1 = i === 0 ? 1 : 0;
      return {
        state: {
          ...state,
          winner,
          gameOver: true,
          log: [
            ...state.log,
            {
              timestamp: Date.now(),
              turn: state.turn,
              phase: state.phase,
              step: state.step,
              player: i as 0 | 1,
              message: `${player.name} has ${player.poisonCounters} poison counters and loses the game.`,
            },
          ],
        },
        changed: true,
      };
    }
  }

  return { state, changed: false };
}

/**
 * Check commander damage loss condition.
 * Called separately since commander damage tracking happens during combat resolution.
 * Player with 21+ commander damage from a single commander loses.
 */
export function checkCommanderDamageLoss(state: GameState): SBAResult {
  if (state.gameOver) return { state, changed: false };

  for (let i = 0; i < 2; i++) {
    const player = state.players[i as 0 | 1];
    for (const [cmdId, damage] of Object.entries(player.commanderDamage)) {
      if (damage >= 21) {
        const winner: 0 | 1 = i === 0 ? 1 : 0;
        return {
          state: {
            ...state,
            winner,
            gameOver: true,
            log: [
              ...state.log,
              {
                timestamp: Date.now(),
                turn: state.turn,
                phase: state.phase,
                step: state.step,
                player: i as 0 | 1,
                message: `${player.name} has taken 21+ commander damage and loses the game.`,
              },
            ],
          },
          changed: true,
        };
      }
    }
  }

  return { state, changed: false };
}

/**
 * Check if a player attempted to draw from an empty library.
 * Called after draw attempts.
 */
export function checkEmptyLibraryLoss(state: GameState, player: 0 | 1): SBAResult {
  if (state.gameOver) return { state, changed: false };

  const ps = state.players[player];
  if (ps.library.length === 0 && ps.hasDrawnThisGame) {
    const winner: 0 | 1 = player === 0 ? 1 : 0;
    return {
      state: {
        ...state,
        winner,
        gameOver: true,
        log: [
          ...state.log,
          {
            timestamp: Date.now(),
            turn: state.turn,
            phase: state.phase,
            step: state.step,
            player,
            message: `${ps.name} tried to draw from an empty library and loses the game.`,
          },
        ],
      },
      changed: true,
    };
  }

  return { state, changed: false };
}

/** Strip permanent-only fields to get a Card back (for graveyard/exile) */
function permanentToCard(perm: Permanent): Card {
  return {
    id: perm.id,
    oracleId: perm.oracleId,
    name: perm.name,
    manaCost: perm.manaCost,
    cmc: perm.cmc,
    typeLine: perm.typeLine,
    oracleText: perm.oracleText,
    power: perm.power,
    toughness: perm.toughness,
    loyalty: perm.loyalty,
    colors: perm.colors,
    colorIdentity: perm.colorIdentity,
    rarity: perm.rarity,
    tags: perm.tags,
    imageUrl: perm.imageUrl,
    owner: perm.owner,
  };
}
