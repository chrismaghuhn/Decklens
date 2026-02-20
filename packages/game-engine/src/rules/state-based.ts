import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { Permanent } from '../types/permanent.ts';
import { cardToPermanent } from '../types/permanent.ts';
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

    // CR 704.5b: Player who attempted to draw from empty library loses
    const r6a0 = checkEmptyLibraryLoss(current, 0);
    if (r6a0.changed) { current = r6a0.state; changed = true; }
    if (current.gameOver) return current;
    const r6a1 = checkEmptyLibraryLoss(current, 1);
    if (r6a1.changed) { current = r6a1.state; changed = true; }
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

    // CR 714.4: Saga with lore counters >= max chapter → sacrifice
    const r8 = checkSagaSacrifice(current);
    if (r8.changed) { current = r8.state; changed = true; }

    // CR 704.5j: Planeswalker uniqueness rule (same subtype under one controller → legend-rule style)
    const r9 = checkPlaneswalkerUniqueness(current);
    if (r9.changed) { current = r9.state; changed = true; }

    // CR 702.73: Evoke sacrifice — creature with sacrificeOnETB is sacrificed immediately
    const r10 = checkEvokeSacrifice(current);
    if (r10.changed) { current = r10.state; changed = true; }

    // Equipment attached to non-creature → unattach (not destroy)
    const r11 = checkEquipmentOnNonCreature(current);
    if (r11.changed) { current = r11.state; changed = true; }
  }

  return current;
}

/** Player with 0 or less life loses */
function checkPlayerLoss(state: GameState): SBAResult {
  if (state.gameOver) return { state, changed: false };

  for (let i = 0; i < 2; i++) {
    const player = state.players[i];
    if (player.life <= 0) {
      const winner: number = i === 0 ? 1 : 0;
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
              player: i,
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
  const players = [...state.players];
  const logs: string[] = [];
  const allDying: { playerIdx: number; dying: Permanent[] }[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i];
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
      allDying.push({ playerIdx: i, dying });

      // CR 400.3: Dying permanents go to owner's graveyard, not controller's
      // Remove from controller's battlefield
      players[i] = {
        ...player,
        battlefield: surviving,
      };

      // Distribute dying cards — check replacement effects (CR 614) for each
      // e.g., "If a creature would die, exile it instead" (Rest in Peace, Leyline of the Void)
      // Also check Undying (CR 702.92) and Persist (CR 702.78)
      for (const perm of dying) {
        const ownerIdx: number = perm.owner ?? i;

        // Undying (CR 702.92): creature with undying and no +1/+1 counters
        // returns to battlefield with a +1/+1 counter instead of dying
        if (hasKeyword(perm, 'undying') && (perm.counters['+1/+1'] ?? 0) === 0) {
          const card = permanentToCard(perm);
          const returned = cardToPermanent(card, i, state.turn);
          returned.counters = { ...returned.counters, '+1/+1': 1 };
          if (returned.currentPower !== undefined) returned.currentPower += 1;
          if (returned.currentToughness !== undefined) returned.currentToughness += 1;
          returned.summoningSick = true;
          players[i] = {
            ...players[i],
            battlefield: [...players[i].battlefield, returned],
          };
          logs.push(`${perm.name} returns to the battlefield with a +1/+1 counter (undying).`);
          continue;
        }

        // Persist (CR 702.78): creature with persist and no -1/-1 counters
        // returns to battlefield with a -1/-1 counter instead of dying
        if (hasKeyword(perm, 'persist') && (perm.counters['-1/-1'] ?? 0) === 0) {
          const card = permanentToCard(perm);
          const returned = cardToPermanent(card, i, state.turn);
          returned.counters = { ...returned.counters, '-1/-1': 1 };
          if (returned.currentPower !== undefined) returned.currentPower -= 1;
          if (returned.currentToughness !== undefined) returned.currentToughness -= 1;
          returned.summoningSick = true;
          players[i] = {
            ...players[i],
            battlefield: [...players[i].battlefield, returned],
          };
          logs.push(`${perm.name} returns to the battlefield with a -1/-1 counter (persist).`);
          continue;
        }

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
    player: null | null,
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
  const players = [...state.players];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i];
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
      players[i] = {
        ...player,
        battlefield: surviving,
      };
      // Distribute dying cards — check replacement effects (CR 614)
      // Also check Undying (CR 702.92) and Persist (CR 702.78)
      for (const perm of dying) {
        const ownerIdx: number = perm.owner ?? i;

        // Undying (CR 702.92): creature with undying and no +1/+1 counters
        // returns to battlefield with a +1/+1 counter instead of dying
        if (hasKeyword(perm, 'undying') && (perm.counters['+1/+1'] ?? 0) === 0) {
          const card = permanentToCard(perm);
          const returned = cardToPermanent(card, i, state.turn);
          returned.counters = { ...returned.counters, '+1/+1': 1 };
          if (returned.currentPower !== undefined) returned.currentPower += 1;
          if (returned.currentToughness !== undefined) returned.currentToughness += 1;
          returned.summoningSick = true;
          players[i] = {
            ...players[i],
            battlefield: [...players[i].battlefield, returned],
          };
          logs.push(`${perm.name} returns to the battlefield with a +1/+1 counter (undying).`);
          continue;
        }

        // Persist (CR 702.78): creature with persist and no -1/-1 counters
        // returns to battlefield with a -1/-1 counter instead of dying
        if (hasKeyword(perm, 'persist') && (perm.counters['-1/-1'] ?? 0) === 0) {
          const card = permanentToCard(perm);
          const returned = cardToPermanent(card, i, state.turn);
          returned.counters = { ...returned.counters, '-1/-1': 1 };
          if (returned.currentPower !== undefined) returned.currentPower -= 1;
          if (returned.currentToughness !== undefined) returned.currentToughness -= 1;
          returned.summoningSick = true;
          players[i] = {
            ...players[i],
            battlefield: [...players[i].battlefield, returned],
          };
          logs.push(`${perm.name} returns to the battlefield with a -1/-1 counter (persist).`);
          continue;
        }

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
    player: null | null,
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
  const players = [...state.players];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i];
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
      players[i] = {
        ...player,
        battlefield: surviving,
      };
      // Distribute dying planeswalkers — check replacement effects (CR 614)
      for (const perm of dying) {
        const ownerIdx: number = perm.owner ?? i;
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
    player: null | null,
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
    const player = state.players[i];
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
              player: i,
              legendName: name,
              permanentIds: perms.map(p => p.id),
            },
            log: [...state.log, {
              timestamp: Date.now(),
              turn: state.turn,
              phase: state.phase,
              step: state.step,
              player: i,
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
    const player = state.players[i];
    if (player.poisonCounters >= 10) {
      const winner: number = i === 0 ? 1 : 0;
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
              player: i,
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
    const player = state.players[i];
    for (const [cmdId, damage] of Object.entries(player.commanderDamage)) {
      if (damage >= 21) {
        const winner: number = i === 0 ? 1 : 0;
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
                player: i,
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
export function checkEmptyLibraryLoss(state: GameState, player: number): SBAResult {
  if (state.gameOver) return { state, changed: false };

  const ps = state.players[player];
  if (ps.library.length === 0 && ps.hasDrawnThisGame) {
    const winner: number = player === 0 ? 1 : 0;
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
  const players = [...state.players];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i];
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
      players[i] = {
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
    player: null | null,
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
  const players = [...state.players];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i];
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
      players[i] = {
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
    player: null | null,
    message,
  }));

  return {
    state: { ...state, players, log: [...state.log, ...logEntries] },
    changed: true,
  };
}

/**
 * CR 714.4: Saga sacrifice — if a Saga has lore counters >= its max chapter, sacrifice it.
 * Max chapter = count of roman numeral chapter markers (I, II, III, IV, V, etc.) in oracle text.
 */
function checkSagaSacrifice(state: GameState): SBAResult {
  let changed = false;
  const players = [...state.players];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i];
    const surviving: Permanent[] = [];
    const dying: Permanent[] = [];

    for (const perm of player.battlefield) {
      if (!perm.typeLine.toLowerCase().includes('saga')) {
        surviving.push(perm);
        continue;
      }
      const lore = perm.counters['lore'] || 0;
      const maxChapter = countSagaChapters(perm.oracleText || '');
      if (maxChapter > 0 && lore >= maxChapter) {
        dying.push(perm);
        logs.push(`${perm.name} is sacrificed (final chapter reached).`);
      } else {
        surviving.push(perm);
      }
    }

    if (dying.length > 0) {
      changed = true;
      const deadCards = dying.map(p => permanentToCard(p));
      players[i] = {
        ...player,
        battlefield: surviving,
        graveyard: [...player.graveyard, ...deadCards],
      };
    }
  }

  if (!changed) return { state, changed: false };

  const logEntries = logs.map((message) => ({
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase,
    step: state.step,
    player: null | null,
    message,
  }));

  return {
    state: { ...state, players, log: [...state.log, ...logEntries] },
    changed: true,
  };
}

/** Count the number of chapter markers in a Saga's oracle text (I, II, III, IV, V, VI) */
function countSagaChapters(oracleText: string): number {
  // Match chapter markers: "I —", "II —", "III —", "IV —" etc.
  const chapters = oracleText.match(/^(I{1,3}|IV|V|VI{0,3})\s*[—–\-]/gm);
  return chapters ? chapters.length : 0;
}

/**
 * CR 704.5j: Planeswalker uniqueness rule.
 * If a player controls two or more planeswalkers with the same planeswalker subtype,
 * they choose one to keep and the rest go to graveyard (same as legend rule).
 * Note: Since WAR (2019), this is effectively identical to the legend rule for PW names.
 * We check by name (modern rules) since subtypes aren't explicitly tracked.
 */
function checkPlaneswalkerUniqueness(state: GameState): SBAResult {
  // If there's already a pending legend choice, skip — wait for player input
  if (state.pendingLegendChoice) return { state, changed: false };

  for (let i = 0; i < 2; i++) {
    const player = state.players[i];
    const pwByName = new Map<string, Permanent[]>();

    for (const perm of player.battlefield) {
      if (isPlaneswalker(perm)) {
        const existing = pwByName.get(perm.name) || [];
        existing.push(perm);
        pwByName.set(perm.name, existing);
      }
    }

    for (const [name, perms] of pwByName) {
      if (perms.length > 1) {
        // If the planeswalker is also legendary, the legend rule already handles it.
        // Only trigger PW uniqueness for non-legendary duplicates (rare but possible).
        if (isLegendary(perms[0])) continue;

        return {
          state: {
            ...state,
            pendingLegendChoice: {
              player: i,
              legendName: name,
              permanentIds: perms.map(p => p.id),
            },
            log: [...state.log, {
              timestamp: Date.now(),
              turn: state.turn,
              phase: state.phase,
              step: state.step,
              player: i,
              message: `${name}: Planeswalker uniqueness rule — choose which copy to keep.`,
            }],
          },
          changed: true,
        };
      }
    }
  }

  return { state, changed: false };
}

/**
 * CR 702.73: Evoke sacrifice.
 * When a creature with sacrificeOnETB is on the battlefield, sacrifice it.
 * This SBA handles the sacrifice after ETB triggers have been queued.
 */
function checkEvokeSacrifice(state: GameState): SBAResult {
  let changed = false;
  const players = [...state.players];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i];
    const dying: Permanent[] = [];
    const surviving: Permanent[] = [];

    for (const perm of player.battlefield) {
      if (perm.sacrificeOnETB) {
        dying.push(perm);
        logs.push(`${perm.name} is sacrificed (evoke).`);
      } else {
        surviving.push(perm);
      }
    }

    if (dying.length > 0) {
      changed = true;
      players[i] = {
        ...player,
        battlefield: surviving,
      };

      // Move to owner's graveyard (check replacement effects)
      for (const perm of dying) {
        const ownerIdx: number = perm.owner ?? i;
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

  const logEntries = logs.map(message => ({
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase,
    step: state.step,
    player: null | null,
    message,
  }));

  let newState: GameState = { ...state, players, log: [...state.log, ...logEntries] };

  // Check death triggers for evoked creatures
  for (let i = 0; i < 2; i++) {
    const dyingPerms = state.players[i].battlefield.filter(p => p.sacrificeOnETB);
    if (dyingPerms.length > 0) {
      newState = checkDeathTriggers(newState, dyingPerms, i);
    }
  }

  return { state: newState, changed: true };
}

/**
 * Equipment attached to a non-creature permanent → unattach (not destroy).
 * This can happen if an animated artifact stops being a creature while
 * equipment is attached to it.
 */
function checkEquipmentOnNonCreature(state: GameState): SBAResult {
  let changed = false;
  const players = [...state.players];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i];
    let playerChanged = false;
    const updatedBf: Permanent[] = [];

    for (const perm of player.battlefield) {
      if (perm.attachedTo && perm.typeLine.toLowerCase().includes('equipment')) {
        // Find the attached-to permanent
        let attachedCreature: Permanent | undefined;
        for (let j = 0; j < 2; j++) {
          attachedCreature = players[j].battlefield.find(p => p.id === perm.attachedTo);
          if (attachedCreature) break;
        }

        if (attachedCreature && !isCreature(attachedCreature)) {
          // Unattach equipment
          updatedBf.push({ ...perm, attachedTo: undefined });
          // Also remove from the creature's attachments list
          for (let j = 0; j < 2; j++) {
            players[j] = {
              ...players[j],
              battlefield: players[j].battlefield.map(p =>
                p.id === attachedCreature!.id
                  ? { ...p, attachments: p.attachments.filter(a => a !== perm.id) }
                  : p
              ),
            };
          }
          playerChanged = true;
          logs.push(`${perm.name} falls off ${attachedCreature.name} (no longer a creature).`);
        } else {
          updatedBf.push(perm);
        }
      } else {
        updatedBf.push(perm);
      }
    }

    if (playerChanged) {
      changed = true;
      players[i] = { ...player, battlefield: updatedBf };
    }
  }

  if (!changed) return { state, changed: false };

  const logEntries = logs.map(message => ({
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase,
    step: state.step,
    player: null | null,
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
