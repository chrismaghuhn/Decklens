import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { Permanent } from '../types/permanent.ts';
import type { Card } from '../types/card.ts';
import { isLegendary, isCreature, isPlaneswalker } from '../types/card.ts';
import { hasKeyword } from './combat.ts';
import { checkDeathTriggers } from './triggers.ts';
import { handleAttachmentCleanup } from './equipment.ts';
import { applyDeathReplacement } from './replacement-effects.ts';

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

    const r6b = checkCounterCancellation(current);
    if (r6b.changed) { current = r6b.state; changed = true; }

    const r7 = checkTokensInWrongZone(current);
    if (r7.changed) { current = r7.state; changed = true; }

    // Attachment cleanup: unattached auras die, equipment becomes unattached
    const preAttachBf0 = current.players[0].battlefield.length;
    const preAttachBf1 = current.players[1].battlefield.length;
    current = handleAttachmentCleanup(current);
    if (current.players[0].battlefield.length !== preAttachBf0 ||
        current.players[1].battlefield.length !== preAttachBf1) {
      changed = true;
    }
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

/**
 * Creatures with damage >= toughness are destroyed (SBA 704.5g).
 * Also handles:
 * - Deathtouch: any amount of damage from a source with deathtouch is lethal (704.5h).
 *   We track this via the `deathtouched` flag on the permanent.
 * - Indestructible: creatures with indestructible are NOT destroyed by lethal damage.
 *   They still receive the damage but stay on the battlefield.
 */
function checkCreatureDeath(state: GameState): SBAResult {
  let changed = false;
  const players = [...state.players] as [PlayerState, PlayerState];
  const logs: string[] = [];
  const allDying: { playerIdx: 0 | 1; dying: Permanent[] }[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i as 0 | 1];
    const dying: Permanent[] = [];
    const surviving: Permanent[] = [];

    for (const perm of player.battlefield) {
      if (perm.currentToughness === undefined || perm.currentToughness <= 0) {
        // Not a creature or zero toughness — handled by checkZeroToughness
        surviving.push(perm);
        continue;
      }

      const hasLethalDamage = perm.damage >= perm.currentToughness;
      const hasDeathtouch = !!(perm as any).deathtouched; // marked by combat damage from deathtouch source

      if (hasLethalDamage || hasDeathtouch) {
        // Indestructible prevents destruction from damage
        if (hasKeyword(perm, 'indestructible')) {
          surviving.push(perm);
          // Still log that it survived
          if (hasLethalDamage) {
            logs.push(`${perm.name} has lethal damage but is indestructible.`);
          }
        } else {
          dying.push(perm);
          if (hasDeathtouch && !hasLethalDamage) {
            logs.push(`${perm.name} is destroyed (deathtouch).`);
          } else {
            logs.push(`${perm.name} is destroyed (lethal damage).`);
          }
        }
      } else {
        surviving.push(perm);
      }
    }

    if (dying.length > 0) {
      changed = true;
      allDying.push({ playerIdx: i as 0 | 1, dying });

      // CR 400.3: Dying permanents go to owner's graveyard, not controller's
      // Remove from controller's battlefield
      players[i as 0 | 1] = {
        ...player,
        battlefield: surviving,
      };

      // Distribute dying cards — check replacement effects (CR 614) for each
      // e.g., "If a creature would die, exile it instead" (Rest in Peace, Leyline of the Void)
      for (const perm of dying) {
        const ownerIdx: 0 | 1 = perm.owner ?? (i as 0 | 1);
        const card = permanentToCard(perm);

        // Check death replacement effects
        const tempState: GameState = { ...state, players };
        const replacement = applyDeathReplacement(tempState, perm);
        const destZone = replacement.zone;

        if (replacement.description) {
          logs.push(replacement.description);
        }

        if (destZone === 'exile') {
          players[ownerIdx] = {
            ...players[ownerIdx],
            exile: [...players[ownerIdx].exile, card],
          };
        } else if (destZone === 'library') {
          players[ownerIdx] = {
            ...players[ownerIdx],
            library: [...players[ownerIdx].library, card],
          };
        } else {
          // Default: graveyard
          players[ownerIdx] = {
            ...players[ownerIdx],
            graveyard: [...players[ownerIdx].graveyard, card],
          };
        }
      }
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

  let newState: GameState = { ...state, players, log: [...state.log, ...logEntries] };

  // Check death triggers for all dying creatures
  for (const { playerIdx, dying } of allDying) {
    newState = checkDeathTriggers(newState, dying, playerIdx);
  }

  return {
    state: newState,
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
      // CR 400.3: Remove from controller's battlefield
      players[i as 0 | 1] = {
        ...player,
        battlefield: surviving,
      };
      // Distribute dying cards — check replacement effects (CR 614)
      for (const perm of dying) {
        const ownerIdx: 0 | 1 = perm.owner ?? (i as 0 | 1);
        const card = permanentToCard(perm);

        const tempState: GameState = { ...state, players };
        const replacement = applyDeathReplacement(tempState, perm);
        const destZone = replacement.zone;

        if (replacement.description) {
          logs.push(replacement.description);
        }

        if (destZone === 'exile') {
          players[ownerIdx] = {
            ...players[ownerIdx],
            exile: [...players[ownerIdx].exile, card],
          };
        } else if (destZone === 'library') {
          players[ownerIdx] = {
            ...players[ownerIdx],
            library: [...players[ownerIdx].library, card],
          };
        } else {
          players[ownerIdx] = {
            ...players[ownerIdx],
            graveyard: [...players[ownerIdx].graveyard, card],
          };
        }
      }
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
      // CR 400.3: Remove from controller's battlefield
      players[i as 0 | 1] = {
        ...player,
        battlefield: surviving,
      };
      // Distribute dying planeswalkers — check replacement effects (CR 614)
      for (const perm of dying) {
        const ownerIdx: 0 | 1 = perm.owner ?? (i as 0 | 1);
        const card = permanentToCard(perm);

        const tempState: GameState = { ...state, players };
        const replacement = applyDeathReplacement(tempState, perm);
        const destZone = replacement.zone;

        if (replacement.description) {
          logs.push(replacement.description);
        }

        if (destZone === 'exile') {
          players[ownerIdx] = { ...players[ownerIdx], exile: [...players[ownerIdx].exile, card] };
        } else if (destZone === 'library') {
          players[ownerIdx] = { ...players[ownerIdx], library: [...players[ownerIdx].library, card] };
        } else {
          players[ownerIdx] = { ...players[ownerIdx], graveyard: [...players[ownerIdx].graveyard, card] };
        }
      }
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
  // If there's already a pending legend choice, skip — wait for player input
  if (state.pendingLegendChoice) return { state, changed: false };

  for (let i = 0; i < 2; i++) {
    const player = state.players[i as 0 | 1];
    const legendaryByName = new Map<string, Permanent[]>();

    for (const perm of player.battlefield) {
      if (isLegendary(perm)) {
        const existing = legendaryByName.get(perm.name) || [];
        existing.push(perm);
        legendaryByName.set(perm.name, existing);
      }
    }

    for (const [name, perms] of legendaryByName) {
      if (perms.length > 1) {
        // Set pending legend choice — player must decide which to keep
        return {
          state: {
            ...state,
            pendingLegendChoice: {
              player: i as 0 | 1,
              legendName: name,
              permanentIds: perms.map(p => p.id),
            },
            log: [...state.log, {
              timestamp: Date.now(),
              turn: state.turn,
              phase: state.phase,
              step: state.step,
              player: i as 0 | 1,
              message: `${name}: Legend rule — choose which copy to keep.`,
            }],
          },
          changed: true,
        };
      }
    }
  }

  return { state, changed: false };
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

/**
 * +1/+1 and -1/-1 counters cancel out in pairs (SBA 704.5q).
 * If a permanent has both types, remove the minimum of both counts.
 */
function checkCounterCancellation(state: GameState): SBAResult {
  let changed = false;
  const players = [...state.players] as [PlayerState, PlayerState];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i as 0 | 1];
    let playerChanged = false;
    const updatedBattlefield: Permanent[] = [];

    for (const perm of player.battlefield) {
      const plusCounters = perm.counters['+1/+1'] ?? 0;
      const minusCounters = perm.counters['-1/-1'] ?? 0;

      if (plusCounters > 0 && minusCounters > 0) {
        const cancelAmount = Math.min(plusCounters, minusCounters);
        const newCounters = { ...perm.counters };
        newCounters['+1/+1'] = plusCounters - cancelAmount;
        newCounters['-1/-1'] = minusCounters - cancelAmount;
        if (newCounters['+1/+1'] <= 0) delete newCounters['+1/+1'];
        if (newCounters['-1/-1'] <= 0) delete newCounters['-1/-1'];

        updatedBattlefield.push({ ...perm, counters: newCounters });
        playerChanged = true;
        logs.push(`${perm.name}: ${cancelAmount} +1/+1 and -1/-1 counter(s) cancel out.`);
      } else {
        updatedBattlefield.push(perm);
      }
    }

    if (playerChanged) {
      changed = true;
      players[i as 0 | 1] = {
        ...player,
        battlefield: updatedBattlefield,
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
 * Tokens in non-battlefield zones cease to exist (SBA 704.5d).
 * When a token leaves the battlefield (graveyard, exile, hand, library),
 * it briefly exists there (for triggers) then ceases to exist as an SBA.
 * We identify tokens by oracleId starting with "token_".
 */
function checkTokensInWrongZone(state: GameState): SBAResult {
  let changed = false;
  const players = [...state.players] as [PlayerState, PlayerState];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i as 0 | 1];
    let playerChanged = false;

    // Check graveyard for tokens
    const filteredGraveyard = player.graveyard.filter((c) => {
      if (c.oracleId.startsWith('token_')) {
        logs.push(`${c.name} token ceases to exist (left the battlefield).`);
        return false;
      }
      return true;
    });
    if (filteredGraveyard.length !== player.graveyard.length) playerChanged = true;

    // Check exile for tokens
    const filteredExile = player.exile.filter((c) => {
      if (c.oracleId.startsWith('token_')) {
        logs.push(`${c.name} token ceases to exist (exiled).`);
        return false;
      }
      return true;
    });
    if (filteredExile.length !== player.exile.length) playerChanged = true;

    // Check hand for tokens (rare, but can happen with bounce)
    const filteredHand = player.hand.filter((c) => {
      if (c.oracleId.startsWith('token_')) {
        logs.push(`${c.name} token ceases to exist (returned to hand).`);
        return false;
      }
      return true;
    });
    if (filteredHand.length !== player.hand.length) playerChanged = true;

    // Check library for tokens (very rare)
    const filteredLibrary = player.library.filter((c) => {
      if (c.oracleId.startsWith('token_')) {
        return false;
      }
      return true;
    });
    if (filteredLibrary.length !== player.library.length) playerChanged = true;

    if (playerChanged) {
      changed = true;
      players[i as 0 | 1] = {
        ...player,
        graveyard: filteredGraveyard,
        exile: filteredExile,
        hand: filteredHand,
        library: filteredLibrary,
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
