import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { Permanent } from '../types/permanent.ts';
import type { CombatState, AttackingCreature, BlockingCreature } from '../types/action.ts';

/**
 * Combat System for 2-player EDH.
 *
 * Combat steps:
 * 1. Begin Combat — priority pass
 * 2. Declare Attackers — active player declares, tap attackers
 * 3. Declare Blockers — defending player assigns blockers
 * 4. First Strike Damage — creatures with first/double strike deal damage
 * 5. Combat Damage — remaining creatures deal damage
 * 6. End Combat — cleanup, remove from combat
 */

/** Initialize combat state when entering combat phase */
export function initializeCombat(state: GameState): GameState {
  return {
    ...state,
    combat: {
      attackers: [],
      blockers: [],
      currentStep: 'begin',
    },
  };
}

/**
 * Resolve combat damage step.
 * Creatures deal damage equal to their power.
 * Unblocked attackers deal damage to defending player.
 * Blocked attackers deal damage to blockers and vice versa.
 *
 * Returns: { state, commanderDamageDealt } for commander tracking.
 */
export function resolveCombatDamage(
  state: GameState,
  firstStrikeOnly: boolean = false
): { state: GameState; commanderDamageDealt: { commanderId: string; damage: number; defenderId: 0 | 1 }[] } {
  if (!state.combat || state.combat.attackers.length === 0) {
    return { state, commanderDamageDealt: [] };
  }

  const activePlayer = state.activePlayer;
  const defendingPlayer: 0 | 1 = activePlayer === 0 ? 1 : 0;

  const players = [...state.players] as [PlayerState, PlayerState];
  const attackerBattlefield = [...players[activePlayer].battlefield];
  const defenderBattlefield = [...players[defendingPlayer].battlefield];
  let defenderLife = players[defendingPlayer].life;
  const logs: string[] = [];
  const commanderDamageDealt: { commanderId: string; damage: number; defenderId: 0 | 1 }[] = [];

  for (const attacker of state.combat.attackers) {
    const attackerPerm = attackerBattlefield.find((p) => p.id === attacker.permanentId);
    if (!attackerPerm || attackerPerm.currentPower === undefined) continue;

    const hasFirstStrike = hasKeyword(attackerPerm, 'first strike') || hasKeyword(attackerPerm, 'double strike');
    const hasNormalStrike = !hasKeyword(attackerPerm, 'first strike') || hasKeyword(attackerPerm, 'double strike');

    // Skip if this damage step doesn't apply
    if (firstStrikeOnly && !hasFirstStrike) continue;
    if (!firstStrikeOnly && !hasNormalStrike) continue;

    const power = Math.max(0, attackerPerm.currentPower);
    if (power === 0) continue;

    // Find blockers for this attacker
    const blockers = state.combat.blockers.filter((b) => b.blockingId === attacker.permanentId);

    if (blockers.length === 0) {
      // Unblocked — damage goes to defending player
      defenderLife -= power;
      logs.push(`${attackerPerm.name} deals ${power} damage to ${players[defendingPlayer].name}.`);

      // Track commander damage
      if (isCommanderPermanent(attackerPerm, players[activePlayer])) {
        commanderDamageDealt.push({
          commanderId: attackerPerm.id,
          damage: power,
          defenderId: defendingPlayer,
        });
      }

      // Lifelink
      if (hasKeyword(attackerPerm, 'lifelink')) {
        players[activePlayer] = {
          ...players[activePlayer],
          life: players[activePlayer].life + power,
        };
      }
    } else {
      // Blocked — assign damage to/from blockers
      let remainingPower = power;

      for (const block of blockers) {
        const blockerPerm = defenderBattlefield.find((p) => p.id === block.permanentId);
        if (!blockerPerm || blockerPerm.currentToughness === undefined) continue;

        const blockerHasFirstStrike = hasKeyword(blockerPerm, 'first strike') || hasKeyword(blockerPerm, 'double strike');
        const blockerHasNormalStrike = !hasKeyword(blockerPerm, 'first strike') || hasKeyword(blockerPerm, 'double strike');

        // Blocker deals damage to attacker
        if ((firstStrikeOnly && blockerHasFirstStrike) || (!firstStrikeOnly && blockerHasNormalStrike)) {
          const blockerPower = Math.max(0, blockerPerm.currentPower ?? 0);
          if (blockerPower > 0) {
            const idx = attackerBattlefield.findIndex((p) => p.id === attackerPerm.id);
            if (idx !== -1) {
              attackerBattlefield[idx] = {
                ...attackerBattlefield[idx],
                damage: attackerBattlefield[idx].damage + blockerPower,
              };
              logs.push(`${blockerPerm.name} deals ${blockerPower} damage to ${attackerPerm.name}.`);
            }

            // Lifelink on blocker
            if (hasKeyword(blockerPerm, 'lifelink')) {
              players[defendingPlayer] = {
                ...players[defendingPlayer],
                life: players[defendingPlayer].life + blockerPower,
              };
            }
          }
        }

        // Attacker deals damage to blocker
        if (remainingPower > 0) {
          const damageToBlocker = block.damageAssignment ?? Math.min(remainingPower, blockerPerm.currentToughness - blockerPerm.damage);
          const actualDamage = Math.min(remainingPower, Math.max(0, damageToBlocker));

          const bIdx = defenderBattlefield.findIndex((p) => p.id === blockerPerm.id);
          if (bIdx !== -1) {
            defenderBattlefield[bIdx] = {
              ...defenderBattlefield[bIdx],
              damage: defenderBattlefield[bIdx].damage + actualDamage,
            };
            logs.push(`${attackerPerm.name} deals ${actualDamage} damage to ${blockerPerm.name}.`);
          }

          remainingPower -= actualDamage;

          // Lifelink
          if (hasKeyword(attackerPerm, 'lifelink') && actualDamage > 0) {
            players[activePlayer] = {
              ...players[activePlayer],
              life: players[activePlayer].life + actualDamage,
            };
          }
        }
      }

      // Trample: remaining damage goes to defending player
      if (remainingPower > 0 && hasKeyword(attackerPerm, 'trample')) {
        defenderLife -= remainingPower;
        logs.push(`${attackerPerm.name} tramples ${remainingPower} damage to ${players[defendingPlayer].name}.`);

        if (isCommanderPermanent(attackerPerm, players[activePlayer])) {
          commanderDamageDealt.push({
            commanderId: attackerPerm.id,
            damage: remainingPower,
            defenderId: defendingPlayer,
          });
        }

        if (hasKeyword(attackerPerm, 'lifelink')) {
          players[activePlayer] = {
            ...players[activePlayer],
            life: players[activePlayer].life + remainingPower,
          };
        }
      }
    }
  }

  // Apply updated battlefields and life
  players[activePlayer] = {
    ...players[activePlayer],
    battlefield: attackerBattlefield,
  };
  players[defendingPlayer] = {
    ...players[defendingPlayer],
    battlefield: defenderBattlefield,
    life: defenderLife,
  };

  const logEntries = logs.map((message) => ({
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase as GameState['phase'],
    step: state.step as GameState['step'],
    player: null as 0 | 1 | null,
    message,
  }));

  return {
    state: {
      ...state,
      players,
      log: [...state.log, ...logEntries],
    },
    commanderDamageDealt,
  };
}

/** Clean up combat state at end of combat */
export function endCombat(state: GameState): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];

  for (let i = 0; i < 2; i++) {
    players[i as 0 | 1] = {
      ...players[i as 0 | 1],
      battlefield: players[i as 0 | 1].battlefield.map((p) => ({
        ...p,
        attacking: false,
        blocking: null,
      })),
    };
  }

  return {
    ...state,
    players,
    combat: null,
  };
}

/** Check if any attackers have first/double strike (determines if first-strike step matters) */
export function hasFirstStrikeCombatants(state: GameState): boolean {
  if (!state.combat) return false;

  const activePlayer = state.activePlayer;
  const defendingPlayer: 0 | 1 = activePlayer === 0 ? 1 : 0;

  for (const attacker of state.combat.attackers) {
    const perm = state.players[activePlayer].battlefield.find((p) => p.id === attacker.permanentId);
    if (perm && (hasKeyword(perm, 'first strike') || hasKeyword(perm, 'double strike'))) {
      return true;
    }
  }

  for (const blocker of state.combat.blockers) {
    const perm = state.players[defendingPlayer].battlefield.find((p) => p.id === blocker.permanentId);
    if (perm && (hasKeyword(perm, 'first strike') || hasKeyword(perm, 'double strike'))) {
      return true;
    }
  }

  return false;
}

/** Check if a permanent is a commander for the given player */
function isCommanderPermanent(perm: Permanent, player: PlayerState): boolean {
  // Commander is identified by matching the name of the card in command zone
  // Since commander can be on battlefield, we check if this permanent's name matches
  // any card that started in the command zone
  return player.commandZone.length === 0 &&
    perm.typeLine.toLowerCase().includes('legendary') &&
    perm.owner === player.id;
}

/** Check if a permanent has a keyword ability (simplified — checks oracle text) */
function hasKeyword(perm: Permanent, keyword: string): boolean {
  return perm.oracleText.toLowerCase().includes(keyword.toLowerCase());
}

/** Get all creatures that can legally attack */
export function getEligibleAttackers(state: GameState): Permanent[] {
  const player = state.players[state.activePlayer];
  return player.battlefield.filter(
    (p) =>
      p.currentPower !== undefined &&
      !p.tapped &&
      !p.summoningSick
  );
}

/** Get all creatures that can legally block */
export function getEligibleBlockers(state: GameState): Permanent[] {
  const defendingPlayer: 0 | 1 = state.activePlayer === 0 ? 1 : 0;
  const player = state.players[defendingPlayer];
  return player.battlefield.filter(
    (p) =>
      p.currentPower !== undefined &&
      !p.tapped
  );
}
