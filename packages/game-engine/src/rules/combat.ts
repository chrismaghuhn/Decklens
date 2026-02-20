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

/**
 * Apply damage through damage prevention shields (CR 615.7).
 * Checks all shields targeting the given permanent or player and decrements
 * their amounts. Returns the actual damage that gets through after prevention.
 *
 * Uses immutable state patterns — returns a new state with updated shields.
 */
export function applyDamageWithShields(
  state: GameState,
  targetId: string, // permanent ID or 'player-0'/'player-1'
  damage: number
): { state: GameState; actualDamage: number } {
  if (!state.damageShields?.length || damage <= 0) return { state, actualDamage: damage };

  let remaining = damage;
  const updatedShields = [...state.damageShields];

  for (let i = updatedShields.length - 1; i >= 0; i--) {
    const shield = updatedShields[i];
    if (shield.targetId !== targetId) continue;

    if (shield.amount >= remaining) {
      // Shield absorbs all remaining damage
      updatedShields[i] = { ...shield, amount: shield.amount - remaining };
      remaining = 0;
      break;
    } else {
      // Shield is fully consumed, some damage remains
      remaining -= shield.amount;
      updatedShields.splice(i, 1);
    }
  }

  // Remove fully depleted shields (amount === 0)
  const activeShields = updatedShields.filter(s => s.amount > 0);
  return {
    state: { ...state, damageShields: activeShields.length > 0 ? activeShields : undefined },
    actualDamage: remaining,
  };
}

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
): { state: GameState; commanderDamageDealt: { commanderId: string; damage: number; defenderId: number | string }[] } {
  if (!state.combat || state.combat.attackers.length === 0) {
    return { state, commanderDamageDealt: [] };
  }

  const activePlayer = state.activePlayer;
  const defendingPlayer: number = activePlayer === 0 ? 1 : 0;

  const players = [...state.players];
  const attackerBattlefield = [...players[activePlayer].battlefield];
  const defenderBattlefield = [...players[defendingPlayer].battlefield];
  let defenderLife = players[defendingPlayer].life;
  const logs: string[] = [];
  const commanderDamageDealt: { commanderId: string; damage: number; defenderId: number | string }[] = [];

  // Track damage shields throughout combat resolution (mutable copy)
  let currentShields = state.damageShields ? [...state.damageShields.map(s => ({ ...s }))] : [];

  /** Consume shields for a target, returning the actual damage after prevention */
  function consumeShields(targetId: string, damage: number): number {
    if (currentShields.length === 0 || damage <= 0) return damage;
    let remaining = damage;
    for (let i = currentShields.length - 1; i >= 0; i--) {
      const shield = currentShields[i];
      if (shield.targetId !== targetId) continue;
      if (shield.amount >= remaining) {
        shield.amount -= remaining;
        const prevented = remaining;
        remaining = 0;
        if (prevented > 0) logs.push(`Damage shield prevents ${prevented} damage (${shield.source || 'shield'}).`);
        break;
      } else {
        remaining -= shield.amount;
        const prevented = shield.amount;
        shield.amount = 0;
        currentShields.splice(i, 1);
        if (prevented > 0) logs.push(`Damage shield prevents ${prevented} damage (${shield.source || 'shield'}).`);
      }
    }
    // Remove depleted shields
    currentShields = currentShields.filter(s => s.amount > 0);
    return remaining;
  }

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
      // Unblocked — damage goes to defending player or planeswalker
      if (typeof attacker.defenderId === 'string') {
        // ─── Planeswalker combat damage ───
        // Find the planeswalker permanent on any player's battlefield
        let pwFound = false;
        for (let pi = 0; pi < 2; pi++) {
          const bfKey = pi === activePlayer ? 'attackerBattlefield' : 'defenderBattlefield';
          const bf = pi === activePlayer ? attackerBattlefield : defenderBattlefield;
          const pwIdx = bf.findIndex(p => p.id === attacker.defenderId);
          if (pwIdx !== -1) {
            const pw = bf[pwIdx];
            // Apply damage prevention shields to planeswalker
            const pwActualDamage = consumeShields(pw.id, power);
            if (pwActualDamage > 0) {
              const newLoyalty = Math.max(0, (pw.currentLoyalty ?? 0) - pwActualDamage);
              bf[pwIdx] = { ...pw, currentLoyalty: newLoyalty };
              logs.push(`${attackerPerm.name} deals ${pwActualDamage} damage to ${pw.name} (loyalty: ${newLoyalty}).`);
            }
            pwFound = true;

            // Lifelink still applies when damaging planeswalkers (based on actual damage dealt)
            if (hasKeyword(attackerPerm, 'lifelink') && pwActualDamage > 0) {
              players[activePlayer] = {
                ...players[activePlayer],
                life: players[activePlayer].life + pwActualDamage,
              };
            }
            break;
          }
        }
        // If planeswalker not found (already removed), skip damage
        if (!pwFound) continue;
      } else {
        // ─── Player combat damage (original path) ───
        // Apply damage prevention shields to defending player
        const playerActualDamage = consumeShields(`player-${defendingPlayer}`, power);

        // Infect (CR 702.89): damage to players is dealt as poison counters instead of life loss
        if (hasKeyword(attackerPerm, 'infect')) {
          if (playerActualDamage > 0) {
            players[defendingPlayer] = {
              ...players[defendingPlayer],
              poisonCounters: players[defendingPlayer].poisonCounters + playerActualDamage,
            };
            logs.push(`${attackerPerm.name} deals ${playerActualDamage} poison to ${players[defendingPlayer].name}.`);
          }
        } else {
          if (playerActualDamage > 0) {
            defenderLife -= playerActualDamage;
            logs.push(`${attackerPerm.name} deals ${playerActualDamage} damage to ${players[defendingPlayer].name}.`);
          }
        }

        // Track commander damage (only for actual damage dealt, not prevented)
        if (playerActualDamage > 0 && isCommanderPermanent(attackerPerm, players[activePlayer])) {
          commanderDamageDealt.push({
            commanderId: attackerPerm.id,
            damage: playerActualDamage,
            defenderId: defendingPlayer,
          });
        }

        // Lifelink (works with infect too — CR 702.89c, based on actual damage dealt)
        if (hasKeyword(attackerPerm, 'lifelink') && playerActualDamage > 0) {
          players[activePlayer] = {
            ...players[activePlayer],
            life: players[activePlayer].life + playerActualDamage,
          };
        }
      }
    } else {
      // Blocked — assign damage to/from blockers

      // CR 510.1: If multiple blockers and no explicit damage assignment,
      // check if we need to prompt for manual assignment
      const needsManualAssignment = blockers.length > 1 &&
        blockers.some(b => b.damageAssignment === undefined);

      if (needsManualAssignment) {
        // Set pending damage assignment — UI must resolve this before continuing
        // For now, auto-assign using default DAO (first blocker gets lethal first)
        // The pendingDamageAssignment state flag is set by Game.resolveCombat()
        // if the UI needs to prompt the player. Here we use auto-assignment.
      }

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
            // Protection: attacker has protection from blocker (color/type) → prevent damage (DEBT: D)
            if (hasProtectionFromPermanent(attackerPerm, blockerPerm)) {
              logs.push(`${attackerPerm.name} has protection — ${blockerPower} damage from ${blockerPerm.name} prevented.`);
            } else {
              // Apply damage prevention shields to the attacker
              const blockerActualDmg = consumeShields(attackerPerm.id, blockerPower);
              if (blockerActualDmg > 0) {
                const idx = attackerBattlefield.findIndex((p) => p.id === attackerPerm.id);
                if (idx !== -1) {
                  // Infect/Wither (CR 702.89/702.79): damage to creatures as -1/-1 counters
                  if (hasKeyword(blockerPerm, 'infect') || hasKeyword(blockerPerm, 'wither')) {
                    const prevCounters = attackerBattlefield[idx].counters || {};
                    attackerBattlefield[idx] = {
                      ...attackerBattlefield[idx],
                      counters: { ...prevCounters, '-1/-1': (prevCounters['-1/-1'] || 0) + blockerActualDmg },
                      ...(hasKeyword(blockerPerm, 'deathtouch') ? { deathtouched: true } : {}),
                    } as any;
                    logs.push(`${blockerPerm.name} puts ${blockerActualDmg} -1/-1 counters on ${attackerPerm.name}.`);
                  } else {
                    attackerBattlefield[idx] = {
                      ...attackerBattlefield[idx],
                      damage: attackerBattlefield[idx].damage + blockerActualDmg,
                      // Deathtouch: any damage from a deathtouch source marks creature
                      ...(hasKeyword(blockerPerm, 'deathtouch') ? { deathtouched: true } : {}),
                    } as any;
                    logs.push(`${blockerPerm.name} deals ${blockerActualDmg} damage to ${attackerPerm.name}.`);
                  }
                }
              }

              // Lifelink on blocker (based on actual damage dealt)
              if (hasKeyword(blockerPerm, 'lifelink') && blockerActualDmg > 0) {
                players[defendingPlayer] = {
                  ...players[defendingPlayer],
                  life: players[defendingPlayer].life + blockerActualDmg,
                };
              }
            }
          }
        }

        // Attacker deals damage to blocker
        if (remainingPower > 0) {
          // Protection: blocker has protection from attacker (color/type) → prevent damage (DEBT: D)
          if (hasProtectionFromPermanent(blockerPerm, attackerPerm)) {
            logs.push(`${blockerPerm.name} has protection — damage from ${attackerPerm.name} prevented.`);
            // Even though damage is prevented, the attacker still "used" its damage assignment
            // For trample purposes we still reduce remaining power
            const deathtouchLethal = hasKeyword(attackerPerm, 'deathtouch')
              ? 1
              : Math.min(remainingPower, blockerPerm.currentToughness - blockerPerm.damage);
            const damageToBlocker = block.damageAssignment ?? deathtouchLethal;
            remainingPower -= Math.min(remainingPower, Math.max(0, damageToBlocker));
          } else {
            // CR 510.1c: Deathtouch makes 1 damage = lethal for assignment purposes
            const deathtouchLethal = hasKeyword(attackerPerm, 'deathtouch')
              ? 1
              : Math.min(remainingPower, blockerPerm.currentToughness - blockerPerm.damage);
            const damageToBlocker = block.damageAssignment ?? deathtouchLethal;
            const assignedDamage = Math.min(remainingPower, Math.max(0, damageToBlocker));

            // Apply damage prevention shields to the blocker
            const blockerShieldedDmg = consumeShields(blockerPerm.id, assignedDamage);

            const bIdx = defenderBattlefield.findIndex((p) => p.id === blockerPerm.id);
            if (bIdx !== -1 && blockerShieldedDmg > 0) {
              // Infect/Wither (CR 702.89/702.79): damage to creatures as -1/-1 counters
              if (hasKeyword(attackerPerm, 'infect') || hasKeyword(attackerPerm, 'wither')) {
                const prevCounters = defenderBattlefield[bIdx].counters || {};
                defenderBattlefield[bIdx] = {
                  ...defenderBattlefield[bIdx],
                  counters: { ...prevCounters, '-1/-1': (prevCounters['-1/-1'] || 0) + blockerShieldedDmg },
                  ...(hasKeyword(attackerPerm, 'deathtouch') ? { deathtouched: true } : {}),
                } as any;
                logs.push(`${attackerPerm.name} puts ${blockerShieldedDmg} -1/-1 counters on ${blockerPerm.name}.`);
              } else {
                defenderBattlefield[bIdx] = {
                  ...defenderBattlefield[bIdx],
                  damage: defenderBattlefield[bIdx].damage + blockerShieldedDmg,
                  // Deathtouch: any damage from a deathtouch source marks creature
                  ...(hasKeyword(attackerPerm, 'deathtouch') ? { deathtouched: true } : {}),
                } as any;
                logs.push(`${attackerPerm.name} deals ${blockerShieldedDmg} damage to ${blockerPerm.name}.`);
              }
            }

            remainingPower -= assignedDamage;

            // Lifelink (based on actual damage dealt, not prevented)
            if (hasKeyword(attackerPerm, 'lifelink') && blockerShieldedDmg > 0) {
              players[activePlayer] = {
                ...players[activePlayer],
                life: players[activePlayer].life + blockerShieldedDmg,
              };
            }
          }
        }
      }

      // Trample: remaining damage goes to the entity being attacked
      if (remainingPower > 0 && hasKeyword(attackerPerm, 'trample')) {
        if (typeof attacker.defenderId === 'string') {
          // Trample excess goes to the planeswalker (CR 702.19c)
          for (let pi = 0; pi < 2; pi++) {
            const bf = pi === activePlayer ? attackerBattlefield : defenderBattlefield;
            const pwIdx = bf.findIndex(p => p.id === attacker.defenderId);
            if (pwIdx !== -1) {
              const pw = bf[pwIdx];
              // Apply damage prevention shields to planeswalker
              const tramplePwDmg = consumeShields(pw.id, remainingPower);
              if (tramplePwDmg > 0) {
                const newLoyalty = Math.max(0, (pw.currentLoyalty ?? 0) - tramplePwDmg);
                bf[pwIdx] = { ...pw, currentLoyalty: newLoyalty };
                logs.push(`${attackerPerm.name} tramples ${tramplePwDmg} damage to ${pw.name} (loyalty: ${newLoyalty}).`);
              }
              // Lifelink on trample to planeswalker
              if (hasKeyword(attackerPerm, 'lifelink') && tramplePwDmg > 0) {
                players[activePlayer] = {
                  ...players[activePlayer],
                  life: players[activePlayer].life + tramplePwDmg,
                };
              }
              break;
            }
          }
        } else {
          // Trample excess goes to defending player — apply shields
          const tramplePlayerDmg = consumeShields(`player-${defendingPlayer}`, remainingPower);

          // Infect + Trample: excess damage as poison counters (CR 702.89)
          if (hasKeyword(attackerPerm, 'infect')) {
            if (tramplePlayerDmg > 0) {
              players[defendingPlayer] = {
                ...players[defendingPlayer],
                poisonCounters: players[defendingPlayer].poisonCounters + tramplePlayerDmg,
              };
              logs.push(`${attackerPerm.name} tramples ${tramplePlayerDmg} poison to ${players[defendingPlayer].name}.`);
            }
          } else {
            if (tramplePlayerDmg > 0) {
              defenderLife -= tramplePlayerDmg;
              logs.push(`${attackerPerm.name} tramples ${tramplePlayerDmg} damage to ${players[defendingPlayer].name}.`);
            }
          }

          if (tramplePlayerDmg > 0 && isCommanderPermanent(attackerPerm, players[activePlayer])) {
            commanderDamageDealt.push({
              commanderId: attackerPerm.id,
              damage: tramplePlayerDmg,
              defenderId: defendingPlayer,
            });
          }

          // Lifelink on trample (based on actual damage)
          if (hasKeyword(attackerPerm, 'lifelink') && tramplePlayerDmg > 0) {
            players[activePlayer] = {
              ...players[activePlayer],
              life: players[activePlayer].life + tramplePlayerDmg,
            };
          }
        }
      }
    }
  }

  // Apply updated battlefields and life
  // CRITICAL: Merge defenderLife (combat damage) with any lifelink gains
  // that were already applied to players[defendingPlayer].life during blocker damage.
  // defenderLife started at the original life total, so the delta from combat damage is:
  //   defenderLife - originalDefenderLife
  // We apply that delta on top of whatever life the defending player has now
  // (which may have been increased by blocker lifelink).
  const originalDefenderLife = state.players[defendingPlayer].life;
  const combatDamageDelta = defenderLife - originalDefenderLife;

  players[activePlayer] = {
    ...players[activePlayer],
    battlefield: attackerBattlefield,
  };
  players[defendingPlayer] = {
    ...players[defendingPlayer],
    battlefield: defenderBattlefield,
    life: players[defendingPlayer].life + combatDamageDelta,
  };

  // Monarch: combat damage to the monarch steals the crown (CR 721.3)
  let monarchStolen = false;
  if (state.monarch === defendingPlayer) {
    // Check if any attacker dealt combat damage to the defending player
    const anyDamageToDefender = combatDamageDelta < 0;
    if (anyDamageToDefender) {
      monarchStolen = true;
      logs.push(`${players[activePlayer].name} deals combat damage to the monarch and becomes the new monarch!`);
    }
  }

  const finalLogEntries = logs.map((message) => ({
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase as GameState['phase'],
    step: state.step as GameState['step'],
    player: null | null,
    message,
  }));

  return {
    state: {
      ...state,
      players,
      log: [...state.log, ...finalLogEntries],
      ...(monarchStolen ? { monarch: activePlayer } : {}),
      // Write back updated damage shields after combat resolution
      damageShields: currentShields.length > 0 ? currentShields : undefined,
    },
    commanderDamageDealt,
  };
}

/** Clean up combat state at end of combat */
export function endCombat(state: GameState): GameState {
  const players = [...state.players];

  for (let i = 0; i < 2; i++) {
    players[i] = {
      ...players[i],
      battlefield: players[i].battlefield.map((p) => {
        const cleaned = { ...p, attacking: false, blocking: null };
        // Clear deathtouched flag after combat
        delete (cleaned as any).deathtouched;
        return cleaned;
      }),
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
  const defendingPlayer: number = activePlayer === 0 ? 1 : 0;

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

/** Check if a permanent is a commander for the given player
 *  CRITICAL FIX: Properly identify commanders by checking:
 *  1. If commandZone has cards, check if permanent matches one
 *  2. If commandZone is empty (commander cast), check if permanent is legendary and owned by player
 *  3. Also check commanderDamage map for the card ID
 */
function isCommanderPermanent(perm: Permanent, player: PlayerState): boolean {
  // If commandZone has cards, the commander hasn't been cast yet
  if (player.commandZone.length > 0) {
    // Check if this permanent matches a card in command zone (by name or ID)
    return player.commandZone.some(cmd => 
      cmd.id === perm.id || cmd.name === perm.name
    );
  }
  
  // Command zone is empty - commander was cast and is on the battlefield
  // In EDH, if the command zone is empty, the legendary creature owned by the player IS the commander
  const isLegendary = perm.typeLine.toLowerCase().includes('legendary');
  const isCreature = perm.typeLine.toLowerCase().includes('creature');
  const isOwner = perm.owner === player.id;

  return isLegendary && isCreature && isOwner;
}

/**
 * Check if a permanent has a keyword ability.
 * Checks parsed abilities[] array, temporary keywords, and the keywords line
 * of oracle text (first line only, to avoid false positives from ability text
 * like "destroy target creature with flying").
 */
export function hasKeyword(perm: Permanent, keyword: string): boolean {
  const lowerKw = keyword.toLowerCase();
  // Check keyword counters (Ikoria+, CR 122.1b)
  // e.g., flying counter, deathtouch counter, first strike counter
  if (perm.counters && perm.counters[lowerKw] && perm.counters[lowerKw] > 0) {
    return true;
  }
  // Check parsed static abilities first (fast path)
  if (perm.abilities?.some(a => a.type === 'static' && a.text.toLowerCase().includes(lowerKw))) {
    return true;
  }
  // Check temporary keywords (granted "until end of turn")
  if (perm.temporaryKeywords?.some(tk => tk.keyword.toLowerCase() === lowerKw)) {
    return true;
  }
  // Fallback: check the FIRST LINE of oracle text only.
  // MTG keywords appear on the first line (or as standalone lines).
  // Checking the full oracle text causes false positives where keywords
  // appear in ability descriptions (e.g., "target creature gains flying").
  const oracle = (perm.oracleText || '').toLowerCase();
  if (!oracle) return false;
  const lines = oracle.split('\n');
  // Check each line: a keyword line is typically a comma-separated list
  // of keywords (e.g., "flying, first strike, trample") or a single keyword.
  // We match keywords that appear as standalone words at the start of a line
  // or in a comma-separated keyword list, NOT within longer sentences.
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // If line is a keyword list (no colon for activated abilities, no period for rules text)
    // Keyword lines: "Flying", "Flying, trample", "First strike", "Deathtouch, lifelink"
    // Non-keyword lines contain colons, periods, or start with conditional words
    const isKeywordLine = !trimmed.includes(':') && !trimmed.includes('.') &&
      !trimmed.startsWith('when') && !trimmed.startsWith('if') &&
      !trimmed.startsWith('at ') && !trimmed.startsWith('as ') &&
      !trimmed.startsWith('target') && !trimmed.startsWith('each') &&
      !trimmed.startsWith('whenever') && !trimmed.startsWith('destroy') &&
      !trimmed.startsWith('exile') && !trimmed.startsWith('return') &&
      !trimmed.startsWith('put') && !trimmed.startsWith('create') &&
      !trimmed.startsWith('search') && !trimmed.startsWith('sacrifice') &&
      !trimmed.startsWith('draw') && !trimmed.startsWith('discard') &&
      !trimmed.startsWith('counter') && !trimmed.startsWith('choose');
    if (isKeywordLine) {
      // Split by comma and check each keyword
      const keywords = trimmed.split(',').map(k => k.trim());
      if (keywords.some(k => k === lowerKw)) return true;
    }
  }
  return false;
}

/**
 * Get the colors that a permanent has protection from.
 * Returns an array of color codes (W, U, B, R, G) or special values.
 *
 * Checks for:
 * - "protection from white/blue/black/red/green"
 * - "protection from all colors"
 * - "protection from all colors" / "protection from each color"
 * - "protection from multicolored"
 * - "protection from colorless"
 * - "protection from everything"
 */
export function getProtectionColors(perm: Permanent): string[] {
  const oracleText = (perm.oracleText || '').toLowerCase();
  const colors: string[] = [];

  // "Protection from everything" covers all colors plus colorless
  if (oracleText.includes('protection from everything')) {
    return ['W', 'U', 'B', 'R', 'G', 'C', 'everything'];
  }

  if (oracleText.includes('protection from all colors') ||
      oracleText.includes('protection from each color')) {
    return ['W', 'U', 'B', 'R', 'G'];
  }

  const colorMap: Record<string, string> = {
    white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G',
  };

  for (const [colorName, colorCode] of Object.entries(colorMap)) {
    if (oracleText.includes(`protection from ${colorName}`)) {
      colors.push(colorCode);
    }
  }

  // "Protection from colorless" — blocks colorless sources (CR 702.16)
  if (oracleText.includes('protection from colorless')) {
    colors.push('C');
  }

  // "Protection from multicolored" — tracked as a special marker
  if (oracleText.includes('protection from multicolored')) {
    colors.push('multicolored');
  }

  return colors;
}

/**
 * Get the card/permanent types that a permanent has protection from.
 * Returns an array of lowercase type strings (singular form).
 *
 * Checks for patterns like:
 * - "protection from creatures"
 * - "protection from artifacts"
 * - "protection from enchantments"
 * - "protection from instants"
 * - "protection from sorceries"
 * - "protection from planeswalkers"
 */
export function getProtectionTypes(perm: Permanent): string[] {
  const oracleText = (perm.oracleText || '').toLowerCase();
  const types: string[] = [];

  // "Protection from everything" blocks all types
  if (oracleText.includes('protection from everything')) {
    return ['everything'];
  }

  // Match "protection from [type]" patterns for card types
  const typePatterns: string[] = [
    'creatures', 'artifacts', 'enchantments',
    'instants', 'sorceries', 'planeswalkers',
  ];

  for (const typeName of typePatterns) {
    if (oracleText.includes(`protection from ${typeName}`)) {
      // Store as singular form for matching against type lines
      types.push(typeName.replace(/s$/, ''));
    }
  }

  return types;
}

/**
 * Check if a permanent has protection from a source (card or permanent).
 * Protection prevents DEBT: Damage, Enchanting/Equipping, Blocking, Targeting.
 *
 * This checks if the SOURCE's colors match any of the protected permanent's protections.
 * A colorless source is blocked only by "protection from colorless" or "protection from everything".
 */
export function hasProtectionFrom(protectedPerm: Permanent, sourceColors: string[]): boolean {
  const protColors = getProtectionColors(protectedPerm);
  if (protColors.length === 0) return false;

  // "Protection from everything" blocks all sources
  if (protColors.includes('everything')) return true;

  // Colorless source: blocked by "protection from colorless" (C marker) only
  if (sourceColors.length === 0) {
    return protColors.includes('C');
  }

  // "Protection from multicolored": blocks sources with 2+ colors
  if (protColors.includes('multicolored') && sourceColors.length > 1) {
    return true;
  }

  // Source is protected against if ANY of its colors match a protection color
  return sourceColors.some(c => protColors.includes(c));
}

/**
 * Check if a permanent has protection from another permanent, considering both
 * color-based protection AND type-based protection (CR 702.16).
 *
 * This is a more comprehensive check than hasProtectionFrom() which only checks colors.
 * Use this for DEBT checks involving permanents on the battlefield.
 *
 * @param protectedPerm - The permanent with protection abilities
 * @param sourcePerm - The source permanent (attacker, equipment, aura, etc.)
 * @returns true if the protected permanent has protection from the source
 */
export function hasProtectionFromPermanent(protectedPerm: Permanent, sourcePerm: Permanent): boolean {
  // Check color-based protection first
  if (hasProtectionFrom(protectedPerm, sourcePerm.colors || [])) {
    return true;
  }

  // Check type-based protection (e.g., "protection from creatures", "protection from artifacts")
  const protTypes = getProtectionTypes(protectedPerm);
  if (protTypes.length === 0) return false;

  // "Protection from everything" already handled by hasProtectionFrom above
  if (protTypes.includes('everything')) return true;

  const sourceTypeLine = (sourcePerm.typeLine || '').toLowerCase();
  for (const protType of protTypes) {
    if (sourceTypeLine.includes(protType)) {
      return true;
    }
  }

  return false;
}

/**
 * Get all creatures that can legally attack.
 * Checks: is creature, untapped, no summoning sickness (unless haste), no defender.
 */
export function getEligibleAttackers(state: GameState): Permanent[] {
  const player = state.players[state.activePlayer];
  return player.battlefield.filter(
    (p) =>
      p.currentPower !== undefined &&
      !p.tapped &&
      !p.phasedOut &&
      (!p.summoningSick || hasKeyword(p, 'haste')) &&
      !hasKeyword(p, 'defender')
  );
}

/**
 * Get all creatures that can legally block a specific attacker (or any attacker).
 * Checks: is creature, untapped, flying/reach restrictions.
 */
export function getEligibleBlockers(state: GameState, attackerPerm?: Permanent): Permanent[] {
  const defendingPlayer: number = state.activePlayer === 0 ? 1 : 0;
  const player = state.players[defendingPlayer];
  const defenderBattlefield = player.battlefield;
  return defenderBattlefield.filter((p) => {
    if (p.currentPower === undefined || p.tapped) return false;

    // Phased-out permanents are treated as though they don't exist (CR 702.26)
    if (p.phasedOut) return false;

    // "can't block" temporary keyword
    if (hasKeyword(p, "can't block")) return false;

    // If checking against a specific attacker, apply evasion rules
    if (attackerPerm) {
      return canBlock(p, attackerPerm, defenderBattlefield);
    }

    return true;
  });
}

/**
 * Check if a blocker can legally block a specific attacker.
 * Enforces: flying/reach, protection, menace (partially),
 * fear, intimidate, skulk, and landwalk evasion keywords.
 *
 * @param defenderBattlefield — Optional: the defending player's battlefield,
 *   needed for landwalk checks. If omitted, landwalk is not enforced.
 */
export function canBlock(blocker: Permanent, attacker: Permanent, defenderBattlefield?: Permanent[]): boolean {
  if (blocker.tapped) return false;
  if (blocker.currentPower === undefined) return false;

  // "can't block" temporary keyword (e.g., from Falter, Goblin Shortcutter effects)
  if (hasKeyword(blocker, "can't block")) return false;

  // Defender keyword can block (that's its purpose), but "can't block" overrides it
  // No extra check needed — defender CAN block by default

  // Flying: only flyable/reach creatures can block
  if (hasKeyword(attacker, 'flying') && !hasKeyword(blocker, 'flying') && !hasKeyword(blocker, 'reach')) {
    return false;
  }

  // Menace-like unblockable: "can't be blocked" on attacker
  if (hasKeyword(attacker, "can't be blocked")) return false;

  // Protection from [color/type]: can't be blocked by source with matching protection (DEBT: B)
  if (hasProtectionFromPermanent(attacker, blocker)) {
    return false;
  }

  // Fear: can only be blocked by artifact creatures or black creatures (CR 702.36)
  if (hasKeyword(attacker, 'fear')) {
    const isArtifact = blocker.typeLine.toLowerCase().includes('artifact');
    const isBlack = blocker.colors?.includes('B');
    if (!isArtifact && !isBlack) return false;
  }

  // Intimidate: can only be blocked by artifact creatures or creatures sharing a color (CR 702.13)
  if (hasKeyword(attacker, 'intimidate')) {
    const isArtifact = blocker.typeLine.toLowerCase().includes('artifact');
    const sharesColor = attacker.colors?.some(c => blocker.colors?.includes(c));
    if (!isArtifact && !sharesColor) return false;
  }

  // Skulk: can't be blocked by creatures with greater power (CR 702.120)
  if (hasKeyword(attacker, 'skulk')) {
    if ((blocker.currentPower ?? 0) > (attacker.currentPower ?? 0)) return false;
  }

  // Landwalk: unblockable if defending player controls that basic land type (CR 702.14)
  if (defenderBattlefield) {
    const landwalkTypes: { keyword: string; landType: string }[] = [
      { keyword: 'forestwalk', landType: 'forest' },
      { keyword: 'islandwalk', landType: 'island' },
      { keyword: 'mountainwalk', landType: 'mountain' },
      { keyword: 'swampwalk', landType: 'swamp' },
      { keyword: 'plainswalk', landType: 'plains' },
    ];
    for (const { keyword, landType } of landwalkTypes) {
      if (hasKeyword(attacker, keyword)) {
        const defenderHasLand = defenderBattlefield.some(
          (p) => p.typeLine.toLowerCase().includes(landType)
        );
        if (defenderHasLand) return false;
      }
    }
  }

  // Power-based blocking restriction: "can't be blocked by creatures with power N or less"
  const powerRestrict = attacker.oracleText?.match(/can't\s+be\s+blocked\s+by\s+creatures\s+with\s+power\s+(\d+)\s+or\s+less/i);
  if (powerRestrict) {
    const threshold = parseInt(powerRestrict[1], 10);
    if ((blocker.currentPower ?? 0) <= threshold) return false;
  }

  // Generalized N-or-more blockers: "can't be blocked except by N or more creatures"
  // This is checked at the validation level (like menace), not here per-blocker
  // But we note it for reference: handled in validateDeclareBlockers()

  return true;
}

/**
 * Check if combat requires manual damage assignment for multi-blocker scenarios (CR 510.1).
 * Returns a pendingDamageAssignment object if manual assignment is needed, null otherwise.
 *
 * Called before resolveCombatDamage() — if this returns non-null, the UI should prompt
 * the attacking player to distribute damage before resolving.
 */
export function checkMultiBlockerAssignment(
  state: GameState,
  firstStrikeOnly: boolean = false
): GameState['pendingDamageAssignment'] {
  if (!state.combat || state.combat.attackers.length === 0) return null;

  const activePlayer = state.activePlayer;

  for (const attacker of state.combat.attackers) {
    const attackerPerm = state.players[activePlayer].battlefield.find(
      (p) => p.id === attacker.permanentId
    );
    if (!attackerPerm || attackerPerm.currentPower === undefined) continue;

    const hasFirst = hasKeyword(attackerPerm, 'first strike') || hasKeyword(attackerPerm, 'double strike');
    const hasNormal = !hasKeyword(attackerPerm, 'first strike') || hasKeyword(attackerPerm, 'double strike');
    if (firstStrikeOnly && !hasFirst) continue;
    if (!firstStrikeOnly && !hasNormal) continue;

    const power = Math.max(0, attackerPerm.currentPower);
    if (power === 0) continue;

    const blockers = state.combat.blockers.filter((b) => b.blockingId === attacker.permanentId);
    if (blockers.length <= 1) continue;

    // Multiple blockers — check if all have explicit damage assignments
    const allAssigned = blockers.every((b) => b.damageAssignment !== undefined);
    if (allAssigned) continue;

    // Need manual assignment
    return {
      player: activePlayer,
      attackerId: attacker.permanentId,
      totalDamage: power,
      hasDeathtouch: hasKeyword(attackerPerm, 'deathtouch'),
      blockerIds: blockers.map((b) => b.permanentId),
      assignments: {},
    };
  }

  return null;
}

/**
 * Validate a damage assignment against CR 510.1 rules.
 * Each blocker must receive at least lethal damage (considering existing damage)
 * before the next blocker in DAO can receive any damage.
 * Deathtouch: 1 damage = lethal (CR 702.2b).
 *
 * Returns null if valid, or an error message string if invalid.
 */
export function validateDamageAssignment(
  state: GameState,
  assignments: Record<string, number>,
  trampleDamage: number = 0
): string | null {
  const pending = state.pendingDamageAssignment;
  if (!pending) return 'No pending damage assignment';

  const defendingPlayer: number = state.activePlayer === 0 ? 1 : 0;
  const defenderBf = state.players[defendingPlayer].battlefield;

  // Total damage assigned must equal attacker's power
  const totalAssigned = Object.values(assignments).reduce((a, b) => a + b, 0) + trampleDamage;
  if (totalAssigned !== pending.totalDamage) {
    return `Total damage (${totalAssigned}) must equal attacker power (${pending.totalDamage})`;
  }

  // Validate DAO ordering: each blocker in order must receive lethal before next gets any
  for (let i = 0; i < pending.blockerIds.length; i++) {
    const blockerId = pending.blockerIds[i];
    const assigned = assignments[blockerId] || 0;
    const blockerPerm = defenderBf.find((p) => p.id === blockerId);
    if (!blockerPerm) continue;

    const existingDamage = blockerPerm.damage || 0;
    const toughness = blockerPerm.currentToughness ?? 0;
    const lethalThreshold = pending.hasDeathtouch
      ? 1  // CR 702.2b: deathtouch makes 1 damage lethal
      : Math.max(0, toughness - existingDamage);

    // Check if next blocker received damage before this one got lethal
    if (assigned < lethalThreshold) {
      // It's OK for the last blocker (or if there's trample) to get less than lethal
      // if no later blocker received any damage
      const laterBlockersGotDamage = pending.blockerIds.slice(i + 1).some(
        (id) => (assignments[id] || 0) > 0
      );
      if (laterBlockersGotDamage) {
        return `${blockerPerm.name} must receive lethal damage (${lethalThreshold}) before assigning to later blockers`;
      }
    }
  }

  return null;
}

/**
 * Apply a validated damage assignment to combat state.
 * Sets damageAssignment on each BlockingCreature, then clears pendingDamageAssignment.
 */
export function applyDamageAssignment(
  state: GameState,
  assignments: Record<string, number>,
  trampleDamage: number = 0
): GameState {
  if (!state.combat || !state.pendingDamageAssignment) return state;

  const updatedBlockers = state.combat.blockers.map((b) => {
    if (b.blockingId === state.pendingDamageAssignment!.attackerId && assignments[b.permanentId] !== undefined) {
      return { ...b, damageAssignment: assignments[b.permanentId] };
    }
    return b;
  });

  return {
    ...state,
    combat: {
      ...state.combat,
      blockers: updatedBlockers,
    },
    pendingDamageAssignment: null,
  };
}

/**
 * Annihilator N (CR 702.85): When a creature with annihilator N attacks,
 * defending player sacrifices N permanents.
 * Parses the annihilator value from oracle text and removes permanents
 * from the defending player's battlefield.
 */
export function processAnnihilator(
  state: GameState,
  attackerPerm: Permanent,
  defendingPlayer: number
): GameState {
  const oracle = (attackerPerm.oracleText || '').toLowerCase();
  const match = oracle.match(/annihilator\s+(\d+)/i);
  if (!match) return state;

  const n = parseInt(match[1], 10);
  if (n <= 0) return state;

  const players = [...state.players];
  const defender = players[defendingPlayer];
  const bf = [...defender.battlefield];

  // Sacrifice N permanents from end of battlefield array (simplest default)
  const sacrificed: Permanent[] = [];
  const toSacrifice = Math.min(n, bf.length);

  for (let i = 0; i < toSacrifice; i++) {
    const perm = bf.pop()!;
    sacrificed.push(perm);
  }

  // Move sacrificed permanents to graveyard as cards
  const sacrificedCards = sacrificed.map(p => ({
    id: p.id,
    oracleId: p.oracleId,
    name: p.name,
    manaCost: p.manaCost,
    cmc: p.cmc,
    typeLine: p.typeLine,
    oracleText: p.oracleText,
    power: p.power,
    toughness: p.toughness,
    loyalty: p.loyalty,
    colors: p.colors,
    colorIdentity: p.colorIdentity,
    rarity: p.rarity,
    tags: p.tags,
    imageUrl: p.imageUrl,
    owner: p.owner,
  }));

  players[defendingPlayer] = {
    ...defender,
    battlefield: bf,
    graveyard: [...defender.graveyard, ...sacrificedCards],
  };

  const sacNames = sacrificed.map(p => p.name).join(', ');
  return {
    ...state,
    players,
    log: [...state.log, {
      timestamp: Date.now(),
      turn: state.turn,
      phase: state.phase,
      step: state.step,
      player: defendingPlayer,
      message: `Annihilator ${n} — ${state.players[defendingPlayer].name} sacrifices ${toSacrifice} permanent(s): ${sacNames}.`,
    }],
  };
}

/**
 * Get IDs of creatures that MUST attack this combat (goaded creatures, CR 701.38).
 * In 1v1, goaded creatures must attack the other player if able.
 */
export function getMustAttackCreatures(state: GameState): string[] {
  const player = state.players[state.activePlayer];
  return player.battlefield
    .filter(p =>
      p.goaded &&
      p.currentPower !== undefined &&
      !p.tapped &&
      !p.phasedOut &&
      (!p.summoningSick || hasKeyword(p, 'haste')) &&
      !hasKeyword(p, 'defender')
    )
    .map(p => p.id);
}
