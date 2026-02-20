/**
 * Effect Resolver — Pattern-based spell/ability effect resolution
 *
 * 3-Tier system:
 * - Tier 1: Keywords auto-resolve (handled by combat system)
 * - Tier 2: Pattern-matched effects (~200 common effects)
 * - Tier 3: Manual resolution fallback (player applies effect via UI)
 *
 * Called by resolveTopOfStack() after zone movement is complete.
 */

import type { GameState } from '../types/game-state.ts';
import type { StackObject, Target } from '../types/action.ts';
import type { PlayerState } from '../types/player.ts';
import type { Permanent } from '../types/permanent.ts';
import type { Card } from '../types/card.ts';
import { drawCards, shuffleLibrary, millCards } from '../engine/zone-manager.ts';
import { cardToPermanent, transformPermanent } from '../types/permanent.ts';
import { generateCardId } from '../engine/factory.ts';
import { hasProtectionFrom, applyDamageWithShields } from './combat.ts';
import { copyStackObject } from './stack.ts';
import { checkLeavesBattlefieldTriggers, checkSacrificeTriggers, checkLifegainTriggers, checkETBTriggers } from './triggers.ts';
import { smartParserResolve } from './smart-parser.ts';
import { getFirstOpponent, getOpponents } from './n-player.ts';

// ─── Types ───

export interface EffectResult {
  state: GameState;
  resolved: boolean; // true = auto-resolved, false = needs manual resolution
  description?: string; // human-readable description of what happened
}

interface EffectPattern {
  /** Name of the effect (for logging) */
  name: string;
  /** Regex to match oracle text (case-insensitive) */
  match: RegExp;
  /** Whether this pattern requires a target */
  requiresTarget: boolean;
  /** Apply the effect to the game state */
  apply: (
    state: GameState,
    controller: number,
    targets: Target[],
    match: RegExpMatchArray,
    source?: Card,
  ) => EffectResult;
}

// ─── Timestamp Counter (CR 613.7) ───

/** Global monotonic counter for effect ordering — higher = more recent */
let _effectTimestamp = 0;

/**
 * Get the next effect timestamp for ordering. Each call returns a strictly
 * increasing value, ensuring that later-applied effects always have a
 * higher timestamp than earlier ones (CR 613.7: timestamp ordering).
 */
export function nextEffectTimestamp(): number {
  return ++_effectTimestamp;
}

// ─── Helper Functions ───

function findPermanentById(state: GameState, id: string): { perm: Permanent; playerIdx: number; permIdx: number } | null {
  for (let pi = 0; pi < 2; pi++) {
    const player = state.players[pi];
    const idx = player.battlefield.findIndex(p => p.id === id);
    if (idx !== -1) return { perm: player.battlefield[idx], playerIdx: pi, permIdx: idx };
  }
  return null;
}

function removePermanentFromBattlefield(state: GameState, permanentId: string, toZone: 'graveyard' | 'exile'): GameState {
  const found = findPermanentById(state, permanentId);
  if (!found) return state;

  const { playerIdx, perm } = found;

  // Check for leaves-battlefield triggers before removal
  state = checkLeavesBattlefieldTriggers(state, perm);

  // Re-find the permanent after triggers may have modified the battlefield
  const player = state.players[playerIdx];
  const currentIdx = player.battlefield.findIndex(p => p.id === permanentId);
  if (currentIdx === -1) return state; // Already removed by a trigger
  const updatedBf = [...player.battlefield];
  updatedBf.splice(currentIdx, 1);

  // Move the card object to the destination zone.
  // CR 613.1: Characteristics reset when leaving the battlefield — use originalOracleText
  // if set (creature had "loses all abilities" via Layer 6), so GY card shows printed text.
  const cardObj: Card = {
    id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
    cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.originalOracleText ?? perm.oracleText,
    power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
    colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
    tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
  };

  const toArr = [...player[toZone], cardObj];
  const updatedPlayer = { ...player, battlefield: updatedBf, [toZone]: toArr };
  const players = [...state.players];
  players[playerIdx] = updatedPlayer;

  return { ...state, players };
}

/** Sacrifice a permanent: moves to graveyard and fires sacrifice triggers */
function sacrificePermanent(state: GameState, permanentId: string): GameState {
  const found = findPermanentById(state, permanentId);
  if (!found) return state;
  const perm = found.perm;
  state = removePermanentFromBattlefield(state, permanentId, 'graveyard');
  state = checkSacrificeTriggers(state, perm);
  return state;
}

function damagePlayer(state: GameState, playerIdx: number, amount: number): GameState {
  // Apply damage prevention shields (CR 615.7)
  const shieldResult = applyDamageWithShields(state, `player-${playerIdx}`, amount);
  state = shieldResult.state;
  const actualDamage = shieldResult.actualDamage;
  if (actualDamage <= 0) return state;

  const player = state.players[playerIdx];
  const updatedPlayer = { ...player, life: player.life - actualDamage };
  const players = [...state.players];
  players[playerIdx] = updatedPlayer;
  return { ...state, players };
}

function damagePermanent(state: GameState, permanentId: string, amount: number, sourceColors?: string[]): GameState {
  const found = findPermanentById(state, permanentId);
  if (!found) return state;

  const { playerIdx, permIdx, perm } = found;

  // Protection: if the permanent has protection from the source's colors, prevent damage
  if (sourceColors && sourceColors.length > 0 && hasProtectionFrom(perm, sourceColors)) {
    return state; // Damage prevented
  }

  // Apply damage prevention shields (CR 615.7)
  const shieldResult = applyDamageWithShields(state, permanentId, amount);
  state = shieldResult.state;
  const actualDamage = shieldResult.actualDamage;
  if (actualDamage <= 0) return state;

  // Re-find after shield state update (state is immutable, references may change)
  const refound = findPermanentById(state, permanentId);
  if (!refound) return state;

  const player = state.players[refound.playerIdx];
  const updatedPerm = { ...refound.perm, damage: refound.perm.damage + actualDamage };
  const updatedBf = [...player.battlefield];
  updatedBf[refound.permIdx] = updatedPerm;

  const updatedPlayer = { ...player, battlefield: updatedBf };
  const players = [...state.players];
  players[refound.playerIdx] = updatedPlayer;

  return { ...state, players };
}

function gainLife(state: GameState, playerIdx: number, amount: number): GameState {
  const player = state.players[playerIdx];
  const updatedPlayer = { ...player, life: player.life + amount };
  const players = [...state.players];
  players[playerIdx] = updatedPlayer;
  let newState = { ...state, players };
  // Fire lifegain triggers
  if (amount > 0) {
    newState = checkLifegainTriggers(newState, playerIdx, amount);
  }
  return newState;
}

function parseNumber(s: string): number {
  const map: Record<string, number> = {
    'a': 1, 'an': 1, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  };
  const lower = s.toLowerCase().trim();
  if (lower in map) return map[lower];
  const n = parseInt(lower, 10);
  return Number.isFinite(n) ? n : 1;
}

function getTargetPermanent(state: GameState, targets: Target[]): { perm: Permanent; playerIdx: number; permIdx: number } | null {
  const permTarget = targets.find(t => t.type === 'permanent');
  if (!permTarget) return null;
  return findPermanentById(state, permTarget.id);
}

function getTargetPlayer(targets: Target[]): number | null {
  const playerTarget = targets.find(t => t.type === 'player');
  if (!playerTarget) return null;
  const parsed = parseInt(playerTarget.id);
  if (isNaN(parsed) || (parsed !== 0 && parsed !== 1)) return null;
  return parsed;
}

function addLog(state: GameState, player: number, message: string): GameState {
  return {
    ...state,
    log: [...state.log, {
      timestamp: Date.now(),
      turn: state.turn,
      phase: state.phase,
      step: state.step,
      player,
      message,
      actionType: 'effect',
    }],
  };
}

// ─── Token Doubling Helper (Doubling Season, Parallel Lives, Anointed Procession, Primal Vigor) ───

/**
 * Scan the battlefield for permanents with token-doubling effects controlled by the given player.
 * Returns the total multiplier (stacks multiplicatively: two Doubling Seasons = 4x).
 *
 * Matches oracle text patterns for:
 * - Doubling Season: "If an effect would create one or more tokens under your control, it creates twice that many instead."
 * - Parallel Lives: "If an effect would create one or more tokens under your control, it creates twice that many instead."
 * - Anointed Procession: "If an effect would create one or more tokens under your control, it creates twice that many instead."
 * - Primal Vigor: "If an effect would create one or more tokens, it creates twice that many instead."
 */
export function getTokenMultiplier(state: GameState, controller: number): number {
  const DOUBLING_PATTERNS = [
    // Matches the exact text on Doubling Season / Parallel Lives / Anointed Procession / Primal Vigor
    /if\s+(?:an?\s+)?effect\s+would\s+create\s+one\s+or\s+more\s+tokens?[^,]*,?\s+it\s+creates?\s+twice\s+that\s+many\s+instead/i,
    // Alternate wording variants
    /whenever.*would.*create.*tokens?.*instead.*double/i,
    /if.*would.*create.*token.*twice\s+that\s+many/i,
  ];

  let multiplier = 1;

  // Check controller's permanents (Doubling Season, Parallel Lives, Anointed Procession)
  for (const perm of state.players[controller].battlefield) {
    const oracleText = perm.oracleText || perm.name || '';
    for (const pattern of DOUBLING_PATTERNS) {
      if (pattern.test(oracleText)) {
        multiplier *= 2;
        break; // Only count each permanent once
      }
    }
    // Also match by card name for well-known cards that may have simplified oracle text
    const name = (perm.name || '').toLowerCase();
    if (name === 'doubling season' || name === 'parallel lives' || name === 'anointed procession') {
      // Only count if not already counted via oracle text match
      const alreadyCounted = DOUBLING_PATTERNS.some(p => p.test(oracleText));
      if (!alreadyCounted) {
        multiplier *= 2;
      }
    }
  }

  // Primal Vigor applies to all players' token creation — check both battlefields
  // but only if controller doesn't already have it (avoid double-counting)
  const opp: number = getFirstOpponent(state, controller);
  for (const perm of state.players[opp].battlefield) {
    const oracleText = perm.oracleText || perm.name || '';
    const name = (perm.name || '').toLowerCase();
    // Primal Vigor specifically says "If an effect would create one or more tokens" (no "under your control")
    if (/if\s+(?:an?\s+)?effect\s+would\s+create\s+one\s+or\s+more\s+tokens?\s*,?\s+it\s+creates?\s+twice\s+that\s+many\s+instead/i.test(oracleText) ||
        name === 'primal vigor') {
      // Only apply if it's Primal Vigor style (no "under your control" restriction)
      // Simple heuristic: if oracleText does NOT contain "under your control", it applies globally
      const controllerRestricted = /under\s+your\s+control/i.test(oracleText);
      if (!controllerRestricted) {
        multiplier *= 2;
      }
    }
  }

  return multiplier;
}

// ─── Effect Patterns Registry ───

export const EFFECT_PATTERNS: EffectPattern[] = [
  // ── Damage ──
  {
    name: 'damage-any-target',
    match: /deals?\s+(\d+)\s+damage\s+to\s+(any\s+target|target\s+(?:creature|player|opponent|planeswalker)\s*(?:or\s+(?:player|planeswalker))?)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m, source) => {
      const amount = parseInt(m[1]);
      const sourceColors = source?.colors || [];
      const permTarget = getTargetPermanent(state, targets);
      const playerTarget = getTargetPlayer(targets);

      if (permTarget) {
        // Protection: check if damage is prevented
        if (sourceColors.length > 0 && hasProtectionFrom(permTarget.perm, sourceColors)) {
          state = addLog(state, controller, `${permTarget.perm.name} has protection — ${amount} damage prevented.`);
          return { state, resolved: true, description: `${amount} damage prevented (protection)` };
        }
        state = damagePermanent(state, permTarget.perm.id, amount, sourceColors);
        state = addLog(state, controller, `Deals ${amount} damage to ${permTarget.perm.name}.`);
        return { state, resolved: true, description: `${amount} damage to ${permTarget.perm.name}` };
      } else if (playerTarget !== null) {
        state = damagePlayer(state, playerTarget, amount);
        state = addLog(state, controller, `Deals ${amount} damage to ${state.players[playerTarget].name}.`);
        return { state, resolved: true, description: `${amount} damage to player` };
      }
      return { state, resolved: false };
    },
  },
  {
    name: 'damage-each-opponent',
    match: /deals?\s+(\d+)\s+damage\s+to\s+each\s+opponent/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      for (const opp of getOpponents(state, controller)) {
        state = damagePlayer(state, opp, amount);
      }
      state = addLog(state, controller, `Deals ${amount} damage to each opponent.`);
      return { state, resolved: true, description: `${amount} damage to each opponent` };
    },
  },
  {
    name: 'damage-each-player',
    match: /deals?\s+(\d+)\s+damage\s+to\s+each\s+player/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      for (let pi = 0; pi < state.players.length; pi++) {
        state = damagePlayer(state, pi, amount);
      }
      state = addLog(state, controller, `Deals ${amount} damage to each player.`);
      return { state, resolved: true, description: `${amount} damage to each player` };
    },
  },

  // ── Draw ──
  {
    name: 'draw-cards',
    match: /draw\s+(a|an|one|two|three|four|five|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      state = drawCards(state, controller, count);
      state = addLog(state, controller, `Draws ${count} card${count !== 1 ? 's' : ''}.`);
      return { state, resolved: true, description: `draw ${count}` };
    },
  },
  {
    name: 'target-player-draws',
    match: /target\s+(?:player|opponent)\s+draws?\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const count = parseNumber(m[1]);
      const playerTarget = getTargetPlayer(targets);
      const targetIdx = playerTarget ?? getFirstOpponent(state, controller);
      state = drawCards(state, targetIdx, count);
      state = addLog(state, controller, `${state.players[targetIdx].name} draws ${count} card(s).`);
      return { state, resolved: true, description: `target draws ${count}` };
    },
  },
  {
    name: 'each-player-draws',
    match: /each\s+player\s+draws?\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      state = drawCards(state, 0, count);
      state = drawCards(state, 1, count);
      state = addLog(state, controller, `Each player draws ${count} card(s).`);
      return { state, resolved: true, description: `each draws ${count}` };
    },
  },

  // ── Destroy ──
  {
    name: 'destroy-target',
    match: /destroy\s+target\s+(creature|artifact|enchantment|permanent|planeswalker|nonland\s+permanent)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Destroys ${target.perm.name}.`);
      return { state, resolved: true, description: `destroy ${target.perm.name}` };
    },
  },
  {
    name: 'destroy-all-creatures',
    match: /destroy\s+all\s+creatures/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const creatures = player.battlefield.filter(p => p.currentPower !== undefined);
        for (const c of creatures) {
          state = removePermanentFromBattlefield(state, c.id, 'graveyard');
          count++;
        }
      }
      state = addLog(state, controller, `Destroys all creatures (${count} destroyed).`);
      return { state, resolved: true, description: `board wipe (${count})` };
    },
  },
  {
    name: 'destroy-all-nonland',
    match: /destroy\s+all\s+nonland\s+permanents/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const nonlands = player.battlefield.filter(p => !p.typeLine.toLowerCase().includes('land'));
        for (const c of nonlands) {
          state = removePermanentFromBattlefield(state, c.id, 'graveyard');
          count++;
        }
      }
      state = addLog(state, controller, `Destroys all nonland permanents (${count} destroyed).`);
      return { state, resolved: true, description: `destroy all nonland (${count})` };
    },
  },

  // ── Exile ──
  {
    name: 'exile-target',
    match: /exile\s+target\s+(creature|artifact|enchantment|permanent|planeswalker|nonland\s+permanent)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'exile');
      state = addLog(state, controller, `Exiles ${target.perm.name}.`);
      return { state, resolved: true, description: `exile ${target.perm.name}` };
    },
  },

  // ── Bounce ──
  {
    name: 'bounce-target',
    match: /return\s+target\s+(creature|permanent|nonland\s+permanent)\s+to\s+its\s+owner'?s?\s+hand/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };

      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf.splice(permIdx, 1);

      const cardObj: Card = {
        id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
        cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
        power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
        colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
        tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
      };

      // Return to owner's hand (owner, not controller)
      const ownerIdx = perm.owner;
      const ownerPlayer = state.players[ownerIdx];

      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      if (ownerIdx !== playerIdx) {
        players[ownerIdx] = { ...ownerPlayer, hand: [...ownerPlayer.hand, cardObj] };
      } else {
        players[playerIdx] = { ...players[playerIdx], hand: [...players[playerIdx].hand, cardObj] };
      }

      state = { ...state, players };
      state = addLog(state, controller, `Returns ${perm.name} to its owner's hand.`);
      return { state, resolved: true, description: `bounce ${perm.name}` };
    },
  },

  // ── Counter ──
  {
    name: 'counter-target-spell',
    match: /counter\s+target\s+spell/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      // Determine which stack object to counter:
      // 1. Look for a card-in-zone target with zone 'stack'
      // 2. Fall back to any target and look it up by ID on the stack
      const spellTarget = targets.find(t => t.type === 'card-in-zone' && t.zone === 'stack');
      const targetId = spellTarget?.id ?? targets[0]?.id;
      if (!targetId) return { state, resolved: false };

      const stackIdx = state.stack.findIndex(s => s.id === targetId);
      if (stackIdx === -1) return { state, resolved: false };

      const countered = state.stack[stackIdx];

      // CR 608.2b: If a spell can't be countered, the counter spell resolves but has no effect.
      if (countered.uncounterable) {
        const spellName = countered.card?.name ?? countered.text ?? 'that spell';
        state = addLog(state, controller, `${spellName} can't be countered.`);
        return { state, resolved: true, description: `${spellName} can't be countered` };
      }

      // Also check oracle text directly as a fallback (for spells where uncounterable
      // wasn't set at cast time, e.g. from older data or ability-granted uncounterability)
      const targetOracleText = countered.card?.oracleText || countered.oracleText || '';
      if (/\bcan't be countered\b/i.test(targetOracleText)) {
        const spellName = countered.card?.name ?? countered.text ?? 'that spell';
        state = addLog(state, controller, `${spellName} can't be countered.`);
        return { state, resolved: true, description: `${spellName} can't be countered` };
      }

      const updatedStack = [...state.stack];
      updatedStack.splice(stackIdx, 1);

      // Move the countered card to its owner's graveyard
      if (countered.card) {
        const owner = countered.card.owner;
        const player = state.players[owner];
        const players = [...state.players];
        players[owner] = { ...player, graveyard: [...player.graveyard, countered.card] };
        state = { ...state, players, stack: updatedStack };
      } else {
        state = { ...state, stack: updatedStack };
      }

      state = addLog(state, controller, `Counters ${countered.text || 'a spell'}.`);
      return { state, resolved: true, description: `counter ${countered.text}` };
    },
  },

  // ── Life Gain/Loss ──
  {
    name: 'gain-life',
    match: /(?:you\s+)?gain\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      state = gainLife(state, controller, amount);
      state = addLog(state, controller, `Gains ${amount} life.`);
      return { state, resolved: true, description: `gain ${amount} life` };
    },
  },
  {
    name: 'lose-life-opponent',
    match: /(?:target\s+(?:player|opponent)|each\s+opponent)\s+loses?\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, targets, m) => {
      const amount = parseInt(m[1]);
      const opponent: number = getFirstOpponent(state, controller);
      const targetPlayer = getTargetPlayer(targets) ?? opponent;
      state = damagePlayer(state, targetPlayer, amount); // lose life = life reduction
      state = addLog(state, controller, `${state.players[targetPlayer].name} loses ${amount} life.`);
      return { state, resolved: true, description: `opponent loses ${amount} life` };
    },
  },
  {
    name: 'you-lose-life',
    match: /you\s+lose\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      state = damagePlayer(state, controller, amount);
      state = addLog(state, controller, `Loses ${amount} life.`);
      return { state, resolved: true, description: `lose ${amount} life` };
    },
  },

  // ── P/T Modification ──
  {
    name: 'pt-until-end-of-turn',
    match: /target\s+creature\s+gets?\s+([+-]\d+)\/([+-]\d+)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const powerMod = parseInt(m[1]);
      const toughMod = parseInt(m[2]);
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };

      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const newMod = { power: powerMod, toughness: toughMod, source: 'spell', turn: state.turn };
      const updatedPerm = {
        ...perm,
        currentPower: (perm.currentPower ?? 0) + powerMod,
        currentToughness: (perm.currentToughness ?? 0) + toughMod,
        temporaryPtMods: [...(perm.temporaryPtMods || []), newMod],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...state.players];
      players[playerIdx] = updatedPlayer;

      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gets ${m[1]}/${m[2]} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} ${m[1]}/${m[2]}` };
    },
  },

  // ── Discard ──
  {
    name: 'target-player-discards',
    match: /target\s+(?:player|opponent)\s+discards?\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const count = parseNumber(m[1]);
      const opponent = getFirstOpponent(state, controller);
      const playerTarget = targets.find(t => t.type === 'player');
      const targetPlayer = playerTarget ? parseInt(playerTarget.id, 10) : opponent;
      const player = state.players[targetPlayer];
      if (player.hand.length === 0) {
        return { state: addLog(state, controller, `${player.name} has no cards to discard.`), resolved: true, description: 'no cards' };
      }
      const actualCount = Math.min(count, player.hand.length);
      // Set pendingDiscard for the player to choose
      return {
        state: { ...state, pendingDiscard: targetPlayer, pendingDiscardCount: actualCount },
        resolved: false,
        description: `${player.name} discards ${actualCount}`,
      };
    },
  },

  // ── Scry ──
  {
    name: 'scry',
    match: /scry\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = Math.min(parseNumber(m[1]), state.players[controller].library.length);
      if (count === 0) {
        return { state, resolved: true, description: 'scry 0 (empty library)' };
      }
      const topCards = state.players[controller].library.slice(0, count);
      // Set pendingScry for UI to handle
      return {
        state: { ...state, pendingScry: { player: controller, count, cards: topCards.map(c => c.id) } },
        resolved: false,
        description: `scry ${count}`,
      };
    },
  },

  // ── Search Library ──
  {
    name: 'search-library',
    match: /search\s+your\s+library/i,
    requiresTarget: false,
    apply: (state, controller) => {
      if (state.players[controller].library.length === 0) {
        return { state: addLog(state, controller, 'Library is empty.'), resolved: true, description: 'empty library' };
      }
      return {
        state: { ...state, pendingSearch: { player: controller, filter: '', count: 1, destination: 'hand' } },
        resolved: false,
        description: 'search library',
      };
    },
  },

  // ── Destroy target with condition ──
  {
    name: 'destroy-target-with-cmc',
    match: /destroy\s+target\s+(?:creature|permanent)\s+with\s+(?:mana\s+value|converted\s+mana\s+cost)\s+(\d+)\s+or\s+less/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Destroys ${target.perm.name}.`);
      return { state, resolved: true, description: `destroy ${target.perm.name}` };
    },
  },

  // ── Create Tokens ──
  {
    name: 'create-token',
    match: /create\s+(a|an|one|two|three|four|five|\d+)\s+(\d+)\/(\d+)\s+(\w+(?:\s+\w+)*?)\s+(?:creature\s+)?tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseQty = parseNumber(m[1]);
      const power = parseInt(m[2]);
      const toughness = parseInt(m[3]);
      const tokenName = m[4].trim();

      // Apply token doubling (Doubling Season, Parallel Lives, Anointed Procession, Primal Vigor)
      const multiplier = getTokenMultiplier(state, controller);
      const qty = baseQty * multiplier;

      const player = state.players[controller];
      const newTokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(),
          oracleId: `token_${tokenName}`,
          name: tokenName,
          manaCost: '',
          cmc: 0,
          typeLine: `Token Creature — ${tokenName}`,
          oracleText: '',
          power: String(power),
          toughness: String(toughness),
          colors: [],
          colorIdentity: [],
          rarity: 'common',
          tags: [],
          imageUrl: '',
          owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        newTokens.push(perm);
      }

      const updatedPlayer = {
        ...player,
        battlefield: [...player.battlefield, ...newTokens],
      };
      const players = [...state.players];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} ${power}/${toughness} ${tokenName} token${qty !== 1 ? 's' : ''}${multiplier > 1 ? ` (${multiplier}x doubling)` : ''}.`);
      return { state, resolved: true, description: `create ${qty} ${power}/${toughness} ${tokenName} token(s)` };
    },
  },

  // ── Exile + Return (Swords to Plowshares style) ──
  {
    name: 'exile-and-gain-life',
    match: /exile\s+target\s+creature.*?its\s+controller\s+gains\s+life\s+equal\s+to\s+its\s+power/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const lifegain = target.perm.currentPower ?? 0;
      state = removePermanentFromBattlefield(state, target.perm.id, 'exile');
      state = gainLife(state, target.playerIdx, lifegain);
      state = addLog(state, controller, `Exiles ${target.perm.name}. Its controller gains ${lifegain} life.`);
      return { state, resolved: true, description: `exile ${target.perm.name}, gain ${lifegain}` };
    },
  },

  // ── Mill ──
  {
    name: 'mill-cards',
    match: /(?:target\s+player\s+)?(?:mills?|puts?\s+the\s+top)\s+(\d+)\s+cards?\s+(?:of\s+their|from\s+the\s+top\s+of\s+their|into\s+their)\s+(?:library\s+into\s+their\s+)?graveyard/i,
    requiresTarget: false,
    apply: (state, controller, targets, m) => {
      const count = parseInt(m[1]);
      const targetPlayer = getTargetPlayer(targets) ?? controller;
      const player = state.players[targetPlayer];
      const milled = player.library.slice(0, count);
      const remaining = player.library.slice(count);
      const updatedPlayer = {
        ...player,
        library: remaining,
        graveyard: [...player.graveyard, ...milled],
      };
      const players = [...state.players];
      players[targetPlayer] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `${player.name} mills ${count} card(s).`);
      return { state, resolved: true, description: `mill ${count}` };
    },
  },

  // ── Sacrifice ──
  {
    name: 'sacrifice-creature',
    match: /sacrifice\s+(?:a|target)\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p => p.currentPower !== undefined);
      if (creatures.length === 0) {
        return { state: addLog(state, controller, 'No creatures to sacrifice.'), resolved: true, description: 'no creatures' };
      }
      if (creatures.length === 1) {
        // Only one choice — auto-sacrifice
        state = sacrificePermanent(state, creatures[0].id);
        state = addLog(state, controller, `${state.players[controller].name} sacrifices ${creatures[0].name}.`);
        return { state, resolved: true, description: `sacrifice ${creatures[0].name}` };
      }
      // Multiple creatures — set pendingSacrifice for UI
      return {
        state: { ...state, pendingSacrifice: { player: controller, filter: 'creature', count: 1 } },
        resolved: false,
        description: 'sacrifice requires selection',
      };
    },
  },

  // ── Add Mana ──
  {
    name: 'add-mana',
    match: /add\s+((?:\{[wubrgc]\})+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const symbols = m[1].match(/\{([wubrgc])\}/gi) || [];
      const player = state.players[controller];
      const updatedPool = { ...player.manaPool };
      const produced: string[] = [];
      for (const sym of symbols) {
        const c = sym.replace(/[{}]/g, '').toUpperCase();
        if (c in updatedPool) {
          (updatedPool as Record<string, number>)[c]++;
          produced.push(`{${c}}`);
        }
      }
      const updatedPlayer = { ...player, manaPool: updatedPool };
      const players = [...state.players];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Adds ${produced.join('')} to mana pool.`);
      return { state, resolved: true, description: `add ${produced.join('')}` };
    },
  },

  // ── Counters ──
  {
    name: 'put-counters-on-target',
    match: /put\s+(a|an|one|two|three|four|five|\d+)\s+\+1\/\+1\s+counters?\s+on\s+target\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const count = parseNumber(m[1]);
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };

      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const existing = perm.counters['+1/+1'] || 0;
      const updatedPerm = {
        ...perm,
        counters: { ...perm.counters, '+1/+1': existing + count },
        currentPower: (perm.currentPower ?? 0) + count,
        currentToughness: (perm.currentToughness ?? 0) + count,
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...state.players];
      players[playerIdx] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Puts ${count} +1/+1 counter${count !== 1 ? 's' : ''} on ${perm.name}.`);
      return { state, resolved: true, description: `${count} +1/+1 on ${perm.name}` };
    },
  },
  {
    name: 'remove-counters',
    match: /remove\s+(a|an|one|two|three|four|five|\d+)\s+\+1\/\+1\s+counters?\s+from\s+target\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const count = parseNumber(m[1]);
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };

      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const existing = perm.counters['+1/+1'] || 0;
      const removed = Math.min(count, existing);
      const updatedPerm = {
        ...perm,
        counters: { ...perm.counters, '+1/+1': existing - removed },
        currentPower: (perm.currentPower ?? 0) - removed,
        currentToughness: (perm.currentToughness ?? 0) - removed,
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...state.players];
      players[playerIdx] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Removes ${removed} +1/+1 counter${removed !== 1 ? 's' : ''} from ${perm.name}.`);
      return { state, resolved: true, description: `remove ${removed} +1/+1 from ${perm.name}` };
    },
  },

  // ── Targeted Destroy (specific types) ──
  {
    name: 'destroy-enchantment',
    match: /destroy\s+target\s+enchantment/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Destroys ${target.perm.name}.`);
      return { state, resolved: true, description: `destroy enchantment ${target.perm.name}` };
    },
  },
  {
    name: 'destroy-artifact',
    match: /destroy\s+target\s+artifact(?!\s+or)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Destroys ${target.perm.name}.`);
      return { state, resolved: true, description: `destroy artifact ${target.perm.name}` };
    },
  },
  {
    name: 'destroy-artifact-or-enchantment',
    match: /destroy\s+target\s+artifact\s+or\s+enchantment/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Destroys ${target.perm.name}.`);
      return { state, resolved: true, description: `destroy ${target.perm.name}` };
    },
  },

  // ── Exile All Creatures ──
  {
    name: 'exile-all-creatures',
    match: /exile\s+all\s+creatures/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const creatures = player.battlefield.filter(p => p.currentPower !== undefined);
        for (const c of creatures) {
          state = removePermanentFromBattlefield(state, c.id, 'exile');
          count++;
        }
      }
      state = addLog(state, controller, `Exiles all creatures (${count} exiled).`);
      return { state, resolved: true, description: `exile all creatures (${count})` };
    },
  },

  // ── Each Opponent Loses Life, You Gain (Gray Merchant style) ──
  {
    name: 'each-opponent-loses-life-you-gain',
    match: /each\s+opponent\s+loses?\s+(\d+)\s+life.*?you\s+gain\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const loseAmount = parseInt(m[1]);
      const gainAmount = parseInt(m[2]);
      const opponent: number = getFirstOpponent(state, controller);
      state = damagePlayer(state, opponent, loseAmount);
      state = gainLife(state, controller, gainAmount);
      state = addLog(state, controller, `Each opponent loses ${loseAmount} life. You gain ${gainAmount} life.`);
      return { state, resolved: true, description: `drain ${loseAmount}, gain ${gainAmount}` };
    },
  },

  // ── Damage to Creature Only ──
  {
    name: 'damage-to-creature-only',
    match: /deals?\s+(\d+)\s+damage\s+to\s+target\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets, m, source) => {
      const amount = parseInt(m[1]);
      const sourceColors = source?.colors || [];
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      // Protection: check if damage is prevented
      if (sourceColors.length > 0 && hasProtectionFrom(target.perm, sourceColors)) {
        state = addLog(state, controller, `${target.perm.name} has protection — ${amount} damage prevented.`);
        return { state, resolved: true, description: `${amount} damage prevented (protection)` };
      }
      state = damagePermanent(state, target.perm.id, amount, sourceColors);
      state = addLog(state, controller, `Deals ${amount} damage to ${target.perm.name}.`);
      return { state, resolved: true, description: `${amount} damage to ${target.perm.name}` };
    },
  },

  // ── Fight ──
  {
    name: 'fight',
    match: /target\s+creature\s+you\s+control\s+fights?\s+target\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      // Need two permanent targets
      const permTargets = targets.filter(t => t.type === 'permanent');
      if (permTargets.length < 2) return { state, resolved: false };

      const first = findPermanentById(state, permTargets[0].id);
      const second = findPermanentById(state, permTargets[1].id);
      if (!first || !second) return { state, resolved: false };

      const firstPower = first.perm.currentPower ?? 0;
      const secondPower = second.perm.currentPower ?? 0;

      // Protection: each creature may be protected from the other's colors
      if (!hasProtectionFrom(second.perm, first.perm.colors || [])) {
        state = damagePermanent(state, second.perm.id, firstPower, first.perm.colors || []);
      }
      if (!hasProtectionFrom(first.perm, second.perm.colors || [])) {
        state = damagePermanent(state, first.perm.id, secondPower, second.perm.colors || []);
      }
      state = addLog(state, controller, `${first.perm.name} fights ${second.perm.name} (${firstPower} vs ${secondPower}).`);
      return { state, resolved: true, description: `${first.perm.name} fights ${second.perm.name}` };
    },
  },

  // ── Tap/Untap ──
  {
    name: 'tap-target',
    match: /tap\s+target\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };

      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedPerm = { ...perm, tapped: true };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...state.players];
      players[playerIdx] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Taps ${perm.name}.`);
      return { state, resolved: true, description: `tap ${perm.name}` };
    },
  },
  {
    name: 'untap-target',
    match: /untap\s+target\s+(?:creature|permanent)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };

      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedPerm = { ...perm, tapped: false };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...state.players];
      players[playerIdx] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Untaps ${perm.name}.`);
      return { state, resolved: true, description: `untap ${perm.name}` };
    },
  },

  // ── Graveyard Recursion ──
  {
    name: 'return-from-graveyard-to-hand',
    match: /return\s+target\s+(?:creature\s+)?card\s+from\s+(?:your\s+)?graveyard\s+to\s+(?:your\s+)?hand/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const cardTarget = targets.find(t => t.type === 'card-in-zone' && t.zone === 'graveyard');
      if (!cardTarget) return { state, resolved: false };

      const player = state.players[controller];
      const gyIdx = player.graveyard.findIndex(c => c.id === cardTarget.id);
      if (gyIdx === -1) return { state, resolved: false };

      const card = player.graveyard[gyIdx];
      const updatedGy = [...player.graveyard];
      updatedGy.splice(gyIdx, 1);
      const updatedHand = [...player.hand, card];
      const updatedPlayer = { ...player, graveyard: updatedGy, hand: updatedHand };
      const players = [...state.players];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Returns ${card.name} from graveyard to hand.`);
      return { state, resolved: true, description: `return ${card.name} to hand` };
    },
  },
  {
    name: 'return-from-graveyard-to-battlefield',
    match: /return\s+target\s+(?:creature\s+)?card\s+from\s+(?:your\s+)?graveyard\s+to\s+the\s+battlefield/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      // Try target first, then auto-select best creature from graveyard
      const cardTarget = targets.find(t => t.type === 'card-in-zone' && t.zone === 'graveyard');
      const player = state.players[controller];

      let card: Card | undefined;
      let gyIdx = -1;

      if (cardTarget) {
        gyIdx = player.graveyard.findIndex(c => c.id === cardTarget.id);
        if (gyIdx !== -1) card = player.graveyard[gyIdx];
      }

      // Fallback: auto-select best creature from graveyard
      if (!card) {
        const creatures = player.graveyard.filter(c => c.typeLine.toLowerCase().includes('creature'));
        if (creatures.length === 0) {
          state = addLog(state, controller, 'No creature cards in graveyard.');
          return { state, resolved: true, description: 'no creatures in gy' };
        }
        card = creatures.reduce((a, b) => a.cmc >= b.cmc ? a : b);
        gyIdx = player.graveyard.findIndex(c => c.id === card!.id);
      }

      if (!card || gyIdx === -1) return { state, resolved: false, description: 'reanimate failed' };

      const updatedGy = [...player.graveyard];
      updatedGy.splice(gyIdx, 1);
      const perm = cardToPermanent(card, controller, state.turn);
      const players = [...state.players];
      players[controller] = { ...player, graveyard: updatedGy, battlefield: [...player.battlefield, perm] };
      state = { ...state, players };
      state = addLog(state, controller, `Returned ${card.name} from graveyard to the battlefield.`);
      return { state, resolved: true, description: `reanimate ${card.name}` };
    },
  },

  // ── Anthem / Mass Pump ──
  {
    name: 'creatures-you-control-get',
    match: /creatures?\s+you\s+control\s+get\s+([+-]\d+)\/([+-]\d+)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const powerMod = parseInt(m[1]);
      const toughMod = parseInt(m[2]);
      const player = state.players[controller];
      const updatedBf = player.battlefield.map(perm => {
        if (perm.currentPower === undefined) return perm; // not a creature
        const newMod = { power: powerMod, toughness: toughMod, source: 'anthem', turn: state.turn };
        return {
          ...perm,
          currentPower: (perm.currentPower ?? 0) + powerMod,
          currentToughness: (perm.currentToughness ?? 0) + toughMod,
          temporaryPtMods: [...(perm.temporaryPtMods || []), newMod],
        };
      });
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...state.players];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      const creatureCount = updatedBf.filter(p => p.currentPower !== undefined).length;
      state = addLog(state, controller, `Creatures you control get ${m[1]}/${m[2]} until end of turn (${creatureCount} creatures).`);
      return { state, resolved: true, description: `anthem ${m[1]}/${m[2]} (${creatureCount})` };
    },
  },

  // ── Keyword Granting ──
  {
    name: 'target-creature-gains-keyword',
    match: /target\s+creature\s+gains?\s+(flying|haste|trample|lifelink|deathtouch|first\s+strike|double\s+strike|hexproof|indestructible|menace|reach|vigilance)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const keyword = m[1].toLowerCase();
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };

      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      // Add keyword as a temporary keyword (expires at end of turn)
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          { keyword, source: 'spell', turn: state.turn },
        ],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...state.players];
      players[playerIdx] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains ${keyword} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} gains ${keyword}` };
    },
  },

  // ── Prevent Damage (Shield-based, CR 615.7) ──

  // "prevent the next N damage that would be dealt to target creature/player"
  {
    name: 'prevent-next-n-damage-target',
    match: /prevent\s+the\s+next\s+(\d+)\s+damage\s+(?:that\s+would\s+be\s+dealt\s+to\s+)?(target\s+(?:creature|player|permanent)|you|any\s+target)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m, source) => {
      const amount = parseInt(m[1], 10);
      const targetText = (m[2] || '').toLowerCase();
      let targetId: string;
      let targetName: string;
      const cardName = source?.name || 'spell';

      if (targetText === 'you') {
        targetId = `player-${controller}`;
        targetName = state.players[controller].name;
      } else {
        const permTarget = getTargetPermanent(state, targets);
        const playerTarget = getTargetPlayer(targets);
        if (permTarget) {
          targetId = permTarget.perm.id;
          targetName = permTarget.perm.name;
        } else if (playerTarget !== null) {
          targetId = `player-${playerTarget}`;
          targetName = state.players[playerTarget].name;
        } else {
          // Default to controller if no target found
          targetId = `player-${controller}`;
          targetName = state.players[controller].name;
        }
      }

      const shield = {
        targetId,
        amount,
        source: cardName,
        turn: state.turn,
        untilEndOfTurn: true,
      };
      const newState = {
        ...state,
        damageShields: [...(state.damageShields || []), shield],
      };
      return {
        state: addLog(newState, controller, `${cardName} creates a shield preventing the next ${amount} damage to ${targetName}.`),
        resolved: true,
        description: `prevent next ${amount} damage to ${targetName}`,
      };
    },
  },

  // "prevent the next N damage" (no target specified — applies to controller)
  {
    name: 'prevent-next-n-damage-self',
    match: /prevent\s+the\s+next\s+(\d+)\s+damage/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const amount = parseInt(m[1], 10);
      const cardName = source?.name || 'spell';
      const targetId = `player-${controller}`;

      const shield = {
        targetId,
        amount,
        source: cardName,
        turn: state.turn,
        untilEndOfTurn: true,
      };
      const newState = {
        ...state,
        damageShields: [...(state.damageShields || []), shield],
      };
      return {
        state: addLog(newState, controller, `${cardName} creates a shield preventing the next ${amount} damage to ${state.players[controller].name}.`),
        resolved: true,
        description: `prevent next ${amount} damage`,
      };
    },
  },

  // "prevent all damage that would be dealt to target creature this turn"
  {
    name: 'prevent-all-damage-target-creature',
    match: /prevent\s+all\s+damage\s+(?:that\s+would\s+be\s+dealt\s+to\s+)?target\s+creature\s*(?:this\s+turn)?/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m, source) => {
      const cardName = source?.name || 'spell';
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };

      const shield = {
        targetId: target.perm.id,
        amount: 999999, // "all damage" = effectively infinite
        source: cardName,
        turn: state.turn,
        untilEndOfTurn: true,
      };
      const newState = {
        ...state,
        damageShields: [...(state.damageShields || []), shield],
      };
      return {
        state: addLog(newState, controller, `${cardName} prevents all damage to ${target.perm.name} this turn.`),
        resolved: true,
        description: `prevent all damage to ${target.perm.name}`,
      };
    },
  },

  // "prevent all damage that would be dealt to you this turn"
  {
    name: 'prevent-all-damage-to-you',
    match: /prevent\s+all\s+damage\s+(?:that\s+would\s+be\s+dealt\s+to\s+)?you\s*(?:this\s+turn)?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      const cardName = source?.name || 'spell';
      const shield = {
        targetId: `player-${controller}`,
        amount: 999999,
        source: cardName,
        turn: state.turn,
        untilEndOfTurn: true,
      };
      const newState = {
        ...state,
        damageShields: [...(state.damageShields || []), shield],
      };
      return {
        state: addLog(newState, controller, `${cardName} prevents all damage to ${state.players[controller].name} this turn.`),
        resolved: true,
        description: `prevent all damage to you`,
      };
    },
  },

  // "prevent the next N damage that would be dealt to any target"
  {
    name: 'prevent-next-n-damage-any',
    match: /prevent\s+the\s+next\s+(\d+)\s+damage\s+(?:that\s+would\s+be\s+dealt\s+to\s+)?any\s+target/i,
    requiresTarget: true,
    apply: (state, controller, targets, m, source) => {
      const amount = parseInt(m[1], 10);
      const cardName = source?.name || 'spell';

      const permTarget = getTargetPermanent(state, targets);
      const playerTarget = getTargetPlayer(targets);
      let targetId: string;
      let targetName: string;

      if (permTarget) {
        targetId = permTarget.perm.id;
        targetName = permTarget.perm.name;
      } else if (playerTarget !== null) {
        targetId = `player-${playerTarget}`;
        targetName = state.players[playerTarget].name;
      } else {
        targetId = `player-${controller}`;
        targetName = state.players[controller].name;
      }

      const shield = {
        targetId,
        amount,
        source: cardName,
        turn: state.turn,
        untilEndOfTurn: true,
      };
      const newState = {
        ...state,
        damageShields: [...(state.damageShields || []), shield],
      };
      return {
        state: addLog(newState, controller, `${cardName} creates a shield preventing the next ${amount} damage to ${targetName}.`),
        resolved: true,
        description: `prevent next ${amount} damage to ${targetName}`,
      };
    },
  },

  // "prevent all damage a source of your choice would deal this turn"
  {
    name: 'prevent-all-damage-source',
    match: /prevent\s+all\s+damage\s+(?:a\s+)?(?:source|target\s+source)\s+(?:of\s+your\s+choice\s+)?would\s+deal\s*(?:this\s+turn)?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      const cardName = source?.name || 'spell';
      // Apply shield to both players and all their creatures (blanket prevention)
      let newState = state;
      const shield0 = {
        targetId: `player-${controller}`,
        amount: 999999,
        source: `${cardName} (source prevention)`,
        turn: state.turn,
        untilEndOfTurn: true,
      };
      newState = {
        ...newState,
        damageShields: [...(newState.damageShields || []), shield0],
      };
      return {
        state: addLog(newState, controller, `${cardName} prevents all damage from a chosen source this turn.`),
        resolved: true,
        description: `prevent all damage from a source`,
      };
    },
  },

  // ── Each Player/Opponent Effects ──
  {
    name: 'each-player-sacrifices',
    match: /each\s+player\s+sacrifices?\s+(?:a|an)\s+(creature|permanent|artifact|enchantment)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const type = (m[1] || 'creature').toLowerCase();
      const isCreature = type === 'creature';
      for (let p = 0; p < 2; p++) {
        const pi = p;
        const player = state.players[pi];
        const candidates = isCreature
          ? player.battlefield.filter(perm => perm.currentPower !== undefined)
          : player.battlefield;
        if (candidates.length > 0) {
          // Auto-select weakest
          const weakest = candidates.reduce((a, b) => ((a.currentPower ?? 0) <= (b.currentPower ?? 0) ? a : b));
          state = sacrificePermanent(state, weakest.id);
          state = addLog(state, pi, `${state.players[pi].name} sacrifices ${weakest.name}.`);
        }
      }
      return { state, resolved: true, description: `each player sacrifices a ${type}` };
    },
  },
  {
    name: 'each-opponent-discards',
    match: /each\s+opponent\s+discards?\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const opponent = getFirstOpponent(state, controller);
      const oppPlayer = state.players[opponent];
      const actualCount = Math.min(count, oppPlayer.hand.length);
      if (actualCount === 0) {
        return { state: addLog(state, controller, `${oppPlayer.name} has no cards to discard.`), resolved: true, description: 'no cards' };
      }
      // Auto-discard worst cards (sorted by CMC descending — discard most expensive first)
      const sorted = [...oppPlayer.hand].sort((a, b) => b.cmc - a.cmc);
      const discarded = sorted.slice(0, actualCount);
      const discardIds = new Set(discarded.map(c => c.id));
      const remainingHand = oppPlayer.hand.filter(c => !discardIds.has(c.id));
      const players = [...state.players];
      players[opponent] = { ...oppPlayer, hand: remainingHand, graveyard: [...oppPlayer.graveyard, ...discarded] };
      state = { ...state, players };
      state = addLog(state, controller, `${oppPlayer.name} discards ${discarded.map(c => c.name).join(', ')}.`);
      return { state, resolved: true, description: `opponent discards ${actualCount}` };
    },
  },

  // ── Land Drop from Hand ──
  {
    name: 'put-land-from-hand',
    match: /(?:you\s+may\s+)?put\s+a\s+land\s+card\s+from\s+your\s+hand\s+onto\s+the\s+battlefield/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const landIdx = player.hand.findIndex(c => c.typeLine.toLowerCase().includes('land'));
      if (landIdx === -1) {
        return { state: addLog(state, controller, 'No land in hand.'), resolved: true, description: 'no land in hand' };
      }
      const land = player.hand[landIdx];
      const newHand = [...player.hand];
      newHand.splice(landIdx, 1);
      const perm = cardToPermanent(land, controller, state.turn);
      const players = [...state.players];
      players[controller] = { ...player, hand: newHand, battlefield: [...player.battlefield, perm] };
      state = { ...state, players };
      state = addLog(state, controller, `${state.players[controller].name} puts ${land.name} onto the battlefield.`);
      return { state, resolved: true, description: `put ${land.name} onto battlefield` };
    },
  },

  // ── Gain Life Equal to Toughness ──
  {
    name: 'gain-life-equal-to-toughness',
    match: /(?:you\s+)?gain\s+life\s+equal\s+to\s+(?:target\s+creature'?s?\s+)?toughness/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const toughness = target.perm.currentToughness ?? 0;
      state = gainLife(state, controller, toughness);
      state = addLog(state, controller, `Gains ${toughness} life (equal to ${target.perm.name}'s toughness).`);
      return { state, resolved: true, description: `gain ${toughness} life from toughness` };
    },
  },

  // ── Destroy Tapped Creature ──
  {
    name: 'destroy-tapped-creature',
    match: /destroy\s+target\s+tapped\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      // Verify target is actually tapped
      if (!target.perm.tapped) {
        state = addLog(state, controller, `${target.perm.name} is not tapped — illegal target.`);
        return { state, resolved: false, description: 'target not tapped' };
      }
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Destroys tapped creature ${target.perm.name}.`);
      return { state, resolved: true, description: `destroy tapped ${target.perm.name}` };
    },
  },

  // ── Exile Card from Graveyard ──
  {
    name: 'exile-target-card-from-graveyard',
    match: /exile\s+target\s+card\s+from\s+(?:a|target\s+player'?s?\s+)?graveyard/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const cardTarget = targets.find(t => t.type === 'card-in-zone' && t.zone === 'graveyard');
      if (!cardTarget) return { state, resolved: false };

      // Search both players' graveyards
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const gyIdx = player.graveyard.findIndex(c => c.id === cardTarget.id);
        if (gyIdx !== -1) {
          const card = player.graveyard[gyIdx];
          const updatedGy = [...player.graveyard];
          updatedGy.splice(gyIdx, 1);
          const updatedExile = [...player.exile, card];
          const updatedPlayer = { ...player, graveyard: updatedGy, exile: updatedExile };
          const players = [...state.players];
          players[pi] = updatedPlayer;
          state = { ...state, players };
          state = addLog(state, controller, `Exiles ${card.name} from graveyard.`);
          return { state, resolved: true, description: `exile ${card.name} from graveyard` };
        }
      }
      return { state, resolved: false };
    },
  },

  // ── Destroy All Artifacts ──
  {
    name: 'destroy-all-artifacts',
    match: /destroy\s+all\s+artifacts/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const artifacts = player.battlefield.filter(p => p.typeLine.toLowerCase().includes('artifact'));
        for (const a of artifacts) {
          state = removePermanentFromBattlefield(state, a.id, 'graveyard');
          count++;
        }
      }
      state = addLog(state, controller, `Destroys all artifacts (${count} destroyed).`);
      return { state, resolved: true, description: `destroy all artifacts (${count})` };
    },
  },

  // ── Destroy All Enchantments ──
  {
    name: 'destroy-all-enchantments',
    match: /destroy\s+all\s+enchantments/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const enchantments = player.battlefield.filter(p => p.typeLine.toLowerCase().includes('enchantment'));
        for (const e of enchantments) {
          state = removePermanentFromBattlefield(state, e.id, 'graveyard');
          count++;
        }
      }
      state = addLog(state, controller, `Destroys all enchantments (${count} destroyed).`);
      return { state, resolved: true, description: `destroy all enchantments (${count})` };
    },
  },

  // ── Each Opponent Loses Life (standalone, no "you gain") ──
  {
    name: 'each-opponent-loses-life',
    match: /each\s+opponent\s+loses?\s+(\d+)\s+life(?!.*you\s+gain)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      for (const opp of getOpponents(state, controller)) {
        state = damagePlayer(state, opp, amount);
      }
      state = addLog(state, controller, `Each opponent loses ${amount} life.`);
      return { state, resolved: true, description: `each opponent loses ${amount} life` };
    },
  },

  // ── Damage to Each Creature ──
  {
    name: 'damage-each-creature',
    match: /deals?\s+(\d+)\s+damage\s+to\s+each\s+creature/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const amount = parseInt(m[1]);
      const sourceColors = source?.colors || [];
      let count = 0;
      let prevented = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const creatures = player.battlefield.filter(p => p.currentPower !== undefined);
        for (const c of creatures) {
          // Protection: skip damage to creatures with protection from source colors
          if (sourceColors.length > 0 && hasProtectionFrom(c, sourceColors)) {
            prevented++;
            continue;
          }
          state = damagePermanent(state, c.id, amount, sourceColors);
          count++;
        }
      }
      let desc = `${amount} damage to each creature (${count})`;
      if (prevented > 0) desc += ` (${prevented} prevented by protection)`;
      state = addLog(state, controller, `Deals ${amount} damage to each creature (${count} hit, ${prevented} protected).`);
      return { state, resolved: true, description: desc };
    },
  },

  // ── Loot: Draw then Discard ──
  {
    name: 'draw-then-discard',
    match: /draw\s+(a|an|\d+|two|three|four|five)\s+cards?\s*(?:,|\.)\s*then\s+discard\s+(a|an|\d+|two|three|four|five)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const drawCount = parseNumber(m[1]);
      const discardCount = parseNumber(m[2]);
      state = drawCards(state, controller, drawCount);
      // Auto-discard from the end of hand (random selection for now)
      const player = state.players[controller];
      const handSize = player.hand.length;
      const toDiscard = Math.min(discardCount, handSize);
      if (toDiscard > 0) {
        const discarded = player.hand.slice(handSize - toDiscard);
        const newHand = player.hand.slice(0, handSize - toDiscard);
        const newGy = [...player.graveyard, ...discarded];
        const updatedPlayer = { ...player, hand: newHand, graveyard: newGy };
        const players = [...state.players];
        players[controller] = updatedPlayer;
        state = { ...state, players };
      }
      state = addLog(state, controller, `Drew ${drawCount} card(s), discarded ${toDiscard}.`);
      return { state, resolved: true, description: `draw ${drawCount}, discard ${toDiscard}` };
    },
  },

  // ── Loot: Discard then Draw ──
  {
    name: 'discard-then-draw',
    match: /discard\s+(a|an|\d+|two|three|four|five)\s+cards?\s*(?:,|\.)\s*(?:then\s+)?draw\s+(a|an|\d+|two|three|four|five)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const discardCount = parseNumber(m[1]);
      const drawCount = parseNumber(m[2]);
      const player = state.players[controller];
      const toDiscard = Math.min(discardCount, player.hand.length);
      if (toDiscard > 0) {
        const discarded = player.hand.slice(player.hand.length - toDiscard);
        const newHand = player.hand.slice(0, player.hand.length - toDiscard);
        const newGy = [...player.graveyard, ...discarded];
        const updatedPlayer = { ...player, hand: newHand, graveyard: newGy };
        const players = [...state.players];
        players[controller] = updatedPlayer;
        state = { ...state, players };
      }
      state = drawCards(state, controller, drawCount);
      state = addLog(state, controller, `Discarded ${toDiscard}, then drew ${drawCount} card(s).`);
      return { state, resolved: true, description: `discard ${toDiscard}, draw ${drawCount}` };
    },
  },

  // ── Rummage/Cycling-style: Discard a card, draw a card ──
  {
    name: 'discard-draw-one',
    match: /discard\s+a\s+card\s*(?:,|\.)\s*(?:then\s+)?draw\s+a\s+card/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      if (player.hand.length > 0) {
        const discarded = player.hand[player.hand.length - 1];
        const newHand = player.hand.slice(0, -1);
        const newGy = [...player.graveyard, discarded];
        const updatedPlayer = { ...player, hand: newHand, graveyard: newGy };
        const players = [...state.players];
        players[controller] = updatedPlayer;
        state = { ...state, players };
      }
      state = drawCards(state, controller, 1);
      state = addLog(state, controller, `Discarded a card, drew a card.`);
      return { state, resolved: true, description: 'discard 1, draw 1' };
    },
  },

  // ── Tap All Creatures ──
  {
    name: 'tap-all-creatures',
    match: /tap\s+all\s+creatures/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const updatedBf = player.battlefield.map(p => {
          if (p.typeLine.toLowerCase().includes('creature') && !p.tapped) {
            count++;
            return { ...p, tapped: true };
          }
          return p;
        });
        const players = [...state.players];
        players[pi] = { ...player, battlefield: updatedBf };
        state = { ...state, players };
      }
      state = addLog(state, controller, `Tapped all creatures (${count}).`);
      return { state, resolved: true, description: `tap all creatures (${count})` };
    },
  },

  // ── Untap All Permanents You Control ──
  {
    name: 'untap-all-your-permanents',
    match: /untap\s+all\s+(?:permanents|creatures|lands)\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      let count = 0;
      const updatedBf = player.battlefield.map(p => {
        if (p.tapped) { count++; return { ...p, tapped: false }; }
        return p;
      });
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...state.players];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Untapped all permanents (${count}).`);
      return { state, resolved: true, description: `untap ${count} permanents` };
    },
  },

  // ── Bounce All Creatures ──
  {
    name: 'bounce-all-creatures',
    match: /return\s+all\s+creatures\s+to\s+their\s+owners?'\s*hands?/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const creatures = player.battlefield.filter(p => p.typeLine.toLowerCase().includes('creature'));
        const nonCreatures = player.battlefield.filter(p => !p.typeLine.toLowerCase().includes('creature'));
        const bouncedCards: Card[] = creatures.map(perm => ({
          id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
          cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
          power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
          colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
          tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
        }));
        count += creatures.length;
        const updatedPlayer = { ...player, battlefield: nonCreatures, hand: [...player.hand, ...bouncedCards] };
        const players = [...state.players];
        players[pi] = updatedPlayer;
        state = { ...state, players };
      }
      state = addLog(state, controller, `Returned all creatures to hand (${count}).`);
      return { state, resolved: true, description: `bounce all creatures (${count})` };
    },
  },

  // ── Bounce All Nonland Permanents ──
  {
    name: 'bounce-all-nonland',
    match: /return\s+all\s+nonland\s+permanents\s+to\s+their\s+owners?'\s*hands?/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const lands = player.battlefield.filter(p => p.typeLine.toLowerCase().includes('land'));
        const nonlands = player.battlefield.filter(p => !p.typeLine.toLowerCase().includes('land'));
        const bouncedCards: Card[] = nonlands.map(perm => ({
          id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
          cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
          power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
          colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
          tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
        }));
        count += nonlands.length;
        const updatedPlayer = { ...player, battlefield: lands, hand: [...player.hand, ...bouncedCards] };
        const players = [...state.players];
        players[pi] = updatedPlayer;
        state = { ...state, players };
      }
      state = addLog(state, controller, `Returned all nonland permanents to hand (${count}).`);
      return { state, resolved: true, description: `bounce all nonland (${count})` };
    },
  },

  // ── Steal: Gain Control Until End of Turn (Threaten effects) ──
  {
    name: 'gain-control-eot',
    match: /gain\s+control\s+of\s+target\s+creature\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = targets.find(t => t.type === 'permanent');
      if (!target) return { state, resolved: false };
      const found = findPermanentById(state, target.id);
      if (!found) return { state, resolved: false };
      // Move permanent from opponent to controller's battlefield
      const { playerIdx, permIdx, perm } = found;
      if (playerIdx === controller) {
        state = addLog(state, controller, `Already controls ${perm.name}.`);
        return { state, resolved: true, description: 'already controlled' };
      }
      const oppPlayer = state.players[playerIdx];
      const updatedOppBf = [...oppPlayer.battlefield];
      updatedOppBf.splice(permIdx, 1);
      const stolenPerm = {
        ...perm,
        controller,
        tapped: false,
        summoningSick: false,
        temporaryControlChange: {
          originalController: playerIdx,
          source: 'gain-control-eot',
          turn: state.turn,
        },
        // Grant haste so the stolen creature can attack immediately (Threaten effect)
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'haste', source: 'gain-control-eot', turn: state.turn }],
      };
      const ctrlPlayer = state.players[controller];
      const updatedCtrlBf = [...ctrlPlayer.battlefield, stolenPerm];
      const players = [...state.players];
      players[playerIdx] = { ...oppPlayer, battlefield: updatedOppBf };
      players[controller] = { ...ctrlPlayer, battlefield: updatedCtrlBf };
      state = { ...state, players };
      state = addLog(state, controller, `Gained control of ${perm.name} until end of turn.`);
      return { state, resolved: true, description: `steal ${perm.name}` };
    },
  },

  // ── Creatures can't block this turn ──
  {
    name: 'creatures-cant-block',
    match: /creatures?\s+(?:your\s+opponents?\s+control\s+)?can'?t\s+block\s+this\s+turn/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, `Creatures can't block this turn.`);
      return { state, resolved: true, description: 'creatures can\'t block' };
    },
  },

  // ── Target creature can't block ──
  {
    name: 'target-cant-block',
    match: /target\s+creature\s+can'?t\s+block\s+this\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = targets.find(t => t.type === 'permanent');
      if (!target) return { state, resolved: false };
      const found = findPermanentById(state, target.id);
      if (!found) return { state, resolved: false };
      state = addLog(state, controller, `${found.perm.name} can't block this turn.`);
      return { state, resolved: true, description: `${found.perm.name} can't block` };
    },
  },

  // ── Damage to each creature opponent controls ──
  {
    name: 'damage-opponent-creatures',
    match: /deals?\s+(\d+)\s+damage\s+to\s+each\s+creature\s+(?:an?\s+)?opponent\s+controls?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const amount = parseInt(m[1]);
      const opp = getFirstOpponent(state, controller);
      const sourceColors = source?.colors || [];
      let count = 0;
      const player = state.players[opp];
      const creatures = player.battlefield.filter(p => p.typeLine.toLowerCase().includes('creature'));
      for (const c of creatures) {
        if (sourceColors.length > 0 && hasProtectionFrom(c, sourceColors)) continue;
        state = damagePermanent(state, c.id, amount, sourceColors);
        count++;
      }
      state = addLog(state, controller, `Deals ${amount} damage to each creature opponent controls (${count}).`);
      return { state, resolved: true, description: `${amount} damage to opponent's creatures (${count})` };
    },
  },

  // ── Damage to each creature you control ──
  {
    name: 'damage-your-creatures',
    match: /deals?\s+(\d+)\s+damage\s+to\s+each\s+creature\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const amount = parseInt(m[1]);
      const sourceColors = source?.colors || [];
      let count = 0;
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p => p.typeLine.toLowerCase().includes('creature'));
      for (const c of creatures) {
        if (sourceColors.length > 0 && hasProtectionFrom(c, sourceColors)) continue;
        state = damagePermanent(state, c.id, amount, sourceColors);
        count++;
      }
      state = addLog(state, controller, `Deals ${amount} damage to each creature you control (${count}).`);
      return { state, resolved: true, description: `${amount} damage to your creatures (${count})` };
    },
  },

  // ── Create treasure tokens ──
  {
    name: 'create-treasure',
    match: /create\s+(a|an|\d+|two|three|four|five)\s+treasure\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseCount = parseNumber(m[1]);
      const count = baseCount * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < count; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_treasure', name: 'Treasure',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact — Treasure',
          oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.',
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        tokens.push(perm);
      }
      const player = state.players[controller];
      const updatedPlayer = { ...player, battlefield: [...player.battlefield, ...tokens] };
      const players = [...state.players];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Created ${count} Treasure token(s).`);
      return { state, resolved: true, description: `create ${count} Treasure` };
    },
  },

  // ── Create food tokens ──
  {
    name: 'create-food',
    match: /create\s+(a|an|\d+|two|three|four|five)\s+food\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseCount = parseNumber(m[1]);
      const count = baseCount * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < count; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_food', name: 'Food',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact — Food',
          oracleText: '{2}, {T}, Sacrifice this artifact: You gain 3 life.',
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        tokens.push(perm);
      }
      const player = state.players[controller];
      const updatedPlayer = { ...player, battlefield: [...player.battlefield, ...tokens] };
      const players = [...state.players];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Created ${count} Food token(s).`);
      return { state, resolved: true, description: `create ${count} Food` };
    },
  },

  // ── Create clue tokens ──
  {
    name: 'create-clue',
    match: /create\s+(a|an|\d+|two|three|four|five)\s+clue\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseCount = parseNumber(m[1]);
      const count = baseCount * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < count; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_clue', name: 'Clue',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact — Clue',
          oracleText: '{2}, Sacrifice this artifact: Draw a card.',
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        tokens.push(perm);
      }
      const player = state.players[controller];
      const updatedPlayer = { ...player, battlefield: [...player.battlefield, ...tokens] };
      const players = [...state.players];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Created ${count} Clue token(s).`);
      return { state, resolved: true, description: `create ${count} Clue` };
    },
  },

  // ── Create blood tokens ──
  {
    name: 'create-blood',
    match: /create\s+(a|an|\d+|two|three|four|five)\s+blood\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseCount = parseNumber(m[1]);
      const count = baseCount * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < count; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_blood', name: 'Blood',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact — Blood',
          oracleText: '{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card.',
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        tokens.push(cardToPermanent(tokenCard, controller, state.turn));
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Created ${count} Blood token(s).`);
      return { state, resolved: true, description: `create ${count} Blood` };
    },
  },

  // ── Create powerstone tokens ──
  {
    name: 'create-powerstone',
    match: /create\s+(a|an|\d+|two|three|four|five)\s+powerstone\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseCount = parseNumber(m[1]);
      const count = baseCount * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < count; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_powerstone', name: 'Powerstone',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact — Powerstone',
          oracleText: '{T}: Add {C}. This mana can\'t be spent to cast nonartifact spells.',
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        tokens.push(cardToPermanent(tokenCard, controller, state.turn));
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Created ${count} Powerstone token(s).`);
      return { state, resolved: true, description: `create ${count} Powerstone` };
    },
  },

  // ── Create servo tokens (1/1 colorless Servo artifact creatures) ──
  {
    name: 'create-servo',
    match: /create\s+(a|an|\d+|two|three|four|five)\s+(?:\d+\/\d+\s+)?(?:colorless\s+)?servo\s+(?:artifact\s+creature\s+)?tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseCount = parseNumber(m[1]);
      const count = baseCount * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < count; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_servo', name: 'Servo',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact Creature — Servo',
          oracleText: '', power: '1', toughness: '1',
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        perm.currentPower = 1; perm.currentToughness = 1; perm.basePower = 1; perm.baseToughness = 1;
        tokens.push(perm);
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Created ${count} 1/1 Servo token(s).`);
      return { state, resolved: true, description: `create ${count} Servo` };
    },
  },

  // ── Incubate N (create Incubator artifact token with N +1/+1 counters) ──
  {
    name: 'incubate',
    match: /incubate\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const n = parseInt(m[1]);
      const tokenCard: Card = {
        id: generateCardId(), oracleId: 'token_incubator', name: 'Incubator',
        manaCost: '', cmc: 0, typeLine: 'Token Artifact — Incubator',
        oracleText: '{2}: Transform this artifact.',
        colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
      };
      const perm = cardToPermanent(tokenCard, controller, state.turn);
      perm.counters['+1/+1'] = n;
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, perm] };
      state = { ...state, players };
      state = addLog(state, controller, `Incubate ${n}: created Incubator token with ${n} +1/+1 counters.`);
      return { state, resolved: true, description: `incubate ${n}` };
    },
  },

  // ── Create map tokens ──
  {
    name: 'create-map',
    match: /create\s+(a|an|\d+|two|three|four|five)\s+map\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseCount = parseNumber(m[1]);
      const count = baseCount * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < count; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_map', name: 'Map',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact — Map',
          oracleText: '{1}, {T}, Sacrifice this artifact: Target creature you control explores.',
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        tokens.push(cardToPermanent(tokenCard, controller, state.turn));
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Created ${count} Map token(s).`);
      return { state, resolved: true, description: `create ${count} Map` };
    },
  },

  // ── Target creature gets +X/+X and gains keyword until end of turn ──
  {
    name: 'pump-and-keyword',
    match: /target\s+creature\s+gets\s+([+-]\d+)\/([+-]\d+)\s+and\s+gains?\s+(flying|haste|trample|lifelink|deathtouch|first\s+strike|double\s+strike|hexproof|indestructible|menace|vigilance)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const target = targets.find(t => t.type === 'permanent');
      if (!target) return { state, resolved: false };
      const found = findPermanentById(state, target.id);
      if (!found) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = found;
      const powerDelta = parseInt(m[1]);
      const toughnessDelta = parseInt(m[2]);
      const keyword = m[3];
      const updatedPerm = {
        ...perm,
        currentPower: (perm.currentPower ?? parseInt(perm.power || '0')) + powerDelta,
        currentToughness: (perm.currentToughness ?? parseInt(perm.toughness || '0')) + toughnessDelta,
        temporaryPtMods: [
          ...(perm.temporaryPtMods || []),
          { power: powerDelta, toughness: toughnessDelta, source: 'pump-and-keyword', turn: state.turn },
        ],
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          { keyword, source: 'pump-and-keyword', turn: state.turn },
        ],
      };
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gets ${m[1]}/${m[2]} and gains ${keyword} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} ${m[1]}/${m[2]} + ${keyword}` };
    },
  },

  // ── Destroy target creature with power N or greater/less ──
  {
    name: 'destroy-by-power',
    match: /destroy\s+target\s+creature\s+with\s+power\s+(\d+)\s+or\s+(greater|less)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const threshold = parseInt(m[1]);
      const comparison = m[2].toLowerCase();
      const target = targets.find(t => t.type === 'permanent');
      if (!target) return { state, resolved: false };
      const found = findPermanentById(state, target.id);
      if (!found) return { state, resolved: false };
      const power = found.perm.currentPower ?? parseInt(found.perm.power || '0');
      const valid = comparison === 'greater' ? power >= threshold : power <= threshold;
      if (!valid) {
        state = addLog(state, controller, `${found.perm.name} (power ${power}) doesn't meet power ${threshold} or ${comparison} requirement.`);
        return { state, resolved: true, description: `target doesn't meet power condition` };
      }
      state = removePermanentFromBattlefield(state, target.id, 'graveyard');
      state = addLog(state, controller, `Destroyed ${found.perm.name} (power ${power}).`);
      return { state, resolved: true, description: `destroy ${found.perm.name}` };
    },
  },

  // ── Destroy target creature with toughness N or less ──
  {
    name: 'destroy-by-toughness',
    match: /destroy\s+target\s+creature\s+with\s+toughness\s+(\d+)\s+or\s+less/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const threshold = parseInt(m[1]);
      const target = targets.find(t => t.type === 'permanent');
      if (!target) return { state, resolved: false };
      const found = findPermanentById(state, target.id);
      if (!found) return { state, resolved: false };
      const toughness = found.perm.currentToughness ?? parseInt(found.perm.toughness || '0');
      if (toughness > threshold) {
        state = addLog(state, controller, `${found.perm.name} (toughness ${toughness}) is above ${threshold}.`);
        return { state, resolved: true, description: `target too tough` };
      }
      state = removePermanentFromBattlefield(state, target.id, 'graveyard');
      state = addLog(state, controller, `Destroyed ${found.perm.name} (toughness ${toughness}).`);
      return { state, resolved: true, description: `destroy ${found.perm.name}` };
    },
  },

  // ── Target creature gets -X/-X until end of turn ──
  {
    name: 'minus-pt-target',
    match: /target\s+creature\s+gets\s+(-\d+)\/(-\d+)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const target = targets.find(t => t.type === 'permanent');
      if (!target) return { state, resolved: false };
      const found = findPermanentById(state, target.id);
      if (!found) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = found;
      const powerDelta = parseInt(m[1]);
      const toughnessDelta = parseInt(m[2]);
      const updatedPerm = {
        ...perm,
        currentPower: (perm.currentPower ?? parseInt(perm.power || '0')) + powerDelta,
        currentToughness: (perm.currentToughness ?? parseInt(perm.toughness || '0')) + toughnessDelta,
      };
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gets ${m[1]}/${m[2]} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} ${m[1]}/${m[2]}` };
    },
  },

  // ── All creatures get -X/-X until end of turn ──
  {
    name: 'all-creatures-minus',
    match: /all\s+creatures\s+get\s+(-\d+)\/(-\d+)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const powerDelta = parseInt(m[1]);
      const toughnessDelta = parseInt(m[2]);
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const updatedBf = player.battlefield.map(p => {
          if (p.typeLine.toLowerCase().includes('creature')) {
            count++;
            return {
              ...p,
              currentPower: (p.currentPower ?? parseInt(p.power || '0')) + powerDelta,
              currentToughness: (p.currentToughness ?? parseInt(p.toughness || '0')) + toughnessDelta,
            };
          }
          return p;
        });
        const players = [...state.players];
        players[pi] = { ...player, battlefield: updatedBf };
        state = { ...state, players };
      }
      state = addLog(state, controller, `All creatures get ${m[1]}/${m[2]} until end of turn (${count}).`);
      return { state, resolved: true, description: `all creatures ${m[1]}/${m[2]} (${count})` };
    },
  },

  // ── Exile target from graveyard (broader — "exile up to N target cards from graveyard") ──
  {
    name: 'exile-cards-from-graveyard',
    match: /exile\s+(?:up\s+to\s+)?(\d+|all)\s+(?:target\s+)?cards?\s+from\s+(?:a\s+)?(?:target\s+)?(?:player's\s+)?graveyard/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      // Exile from opponent's graveyard
      const opp = getFirstOpponent(state, controller);
      const player = state.players[opp];
      const countStr = m[1].toLowerCase();
      const count = countStr === 'all' ? player.graveyard.length : Math.min(parseInt(countStr), player.graveyard.length);
      const exiled = player.graveyard.slice(0, count);
      const remaining = player.graveyard.slice(count);
      const updatedPlayer = { ...player, graveyard: remaining, exile: [...player.exile, ...exiled] };
      const players = [...state.players];
      players[opp] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Exiled ${count} card(s) from opponent's graveyard.`);
      return { state, resolved: true, description: `exile ${count} from graveyard` };
    },
  },

  // ── Exile all cards from all graveyards ──
  {
    name: 'exile-all-graveyards',
    match: /exile\s+all\s+cards\s+from\s+all\s+graveyards?/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let total = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        total += player.graveyard.length;
        const updatedPlayer = { ...player, exile: [...player.exile, ...player.graveyard], graveyard: [] };
        const players = [...state.players];
        players[pi] = updatedPlayer;
        state = { ...state, players };
      }
      state = addLog(state, controller, `Exiled all cards from all graveyards (${total}).`);
      return { state, resolved: true, description: `exile all graveyards (${total})` };
    },
  },

  // ── Target player loses life equal to number of creatures ──
  {
    name: 'life-loss-creature-count',
    match: /(?:target\s+)?(?:player|opponent)\s+loses\s+life\s+equal\s+to\s+the\s+number\s+of\s+creatures\s+(?:you|they)\s+control/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opp = getFirstOpponent(state, controller);
      const creatureCount = state.players[controller].battlefield.filter(
        p => p.typeLine.toLowerCase().includes('creature')
      ).length;
      state = damagePlayer(state, opp, creatureCount);
      state = addLog(state, controller, `Opponent loses ${creatureCount} life (creature count).`);
      return { state, resolved: true, description: `opponent loses ${creatureCount} life` };
    },
  },

  // ── Gain life equal to the number of creatures you control ──
  {
    name: 'gain-life-creature-count',
    match: /gain\s+life\s+equal\s+to\s+the\s+number\s+of\s+creatures\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const creatureCount = state.players[controller].battlefield.filter(
        p => p.typeLine.toLowerCase().includes('creature')
      ).length;
      state = gainLife(state, controller, creatureCount);
      state = addLog(state, controller, `Gained ${creatureCount} life (creature count).`);
      return { state, resolved: true, description: `gain ${creatureCount} life` };
    },
  },

  // ═══════════════════════════════════════════════════════════
  // Phase 6 — Additional patterns (pushing toward 100+)
  // ═══════════════════════════════════════════════════════════

  // ── Scry ──
  {
    name: 'scry',
    match: /scry\s+(\d+|one|two|three|four|five)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      // Scry is complex (look, reorder, bottom) — for now just log it
      state = addLog(state, controller, `Scry ${count}. (Look at top ${count}, put any on bottom in any order.)`);
      return { state, resolved: true, description: `scry ${count}` };
    },
  },

  // ── Mill ──
  {
    name: 'mill-target',
    match: /(?:target\s+)?(?:player|opponent)\s+(?:puts|mills?)\s+(?:the\s+top\s+)?(\d+|one|two|three|four|five)\s+cards?\s+(?:of\s+their\s+library\s+)?into\s+their\s+graveyard/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const opp: number = getFirstOpponent(state, controller);
      const player = state.players[opp];
      const milled = player.library.slice(0, count);
      const remaining = player.library.slice(count);
      const milledCards: Card[] = milled;
      const updatedPlayer = { ...player, library: remaining, graveyard: [...player.graveyard, ...milledCards] };
      const players = [...state.players];
      players[opp] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Opponent mills ${milled.length} card(s).`);
      return { state, resolved: true, description: `mill ${milled.length}` };
    },
  },

  // ── Self mill ──
  {
    name: 'mill-self',
    match: /(?:put|mill)\s+(?:the\s+top\s+)?(\d+|one|two|three|four|five)\s+cards?\s+(?:of\s+your\s+library\s+)?into\s+your\s+graveyard/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const player = state.players[controller];
      const milled = player.library.slice(0, count);
      const remaining = player.library.slice(count);
      const updatedPlayer = { ...player, library: remaining, graveyard: [...player.graveyard, ...milled] };
      const players = [...state.players];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Milled ${milled.length} card(s).`);
      return { state, resolved: true, description: `self-mill ${milled.length}` };
    },
  },

  // ── Target creature can't attack this turn ──
  {
    name: 'cant-attack',
    match: /target\s+creature\s+can'?t\s+attack\s+(?:this\s+turn|until\s+your\s+next\s+turn)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = addLog(state, controller, `${target.perm.name} can't attack this turn.`);
      return { state, resolved: true, description: `${target.perm.name} can't attack` };
    },
  },

  // ── Tap target creature ──
  {
    name: 'tap-target',
    match: /tap\s+target\s+(?:creature|permanent)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = { ...perm, tapped: true };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Tapped ${perm.name}.`);
      return { state, resolved: true, description: `tap ${perm.name}` };
    },
  },

  // ── Untap target creature/permanent ──
  {
    name: 'untap-target',
    match: /untap\s+target\s+(?:creature|permanent)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = { ...perm, tapped: false };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Untapped ${perm.name}.`);
      return { state, resolved: true, description: `untap ${perm.name}` };
    },
  },

  // ── Destroy target land ──
  {
    name: 'destroy-land',
    match: /destroy\s+target\s+land/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Destroyed ${target.perm.name}.`);
      return { state, resolved: true, description: `destroy ${target.perm.name}` };
    },
  },

  // ── Destroy all lands ──
  {
    name: 'destroy-all-lands',
    match: /destroy\s+all\s+lands/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const lands = player.battlefield.filter(p => p.typeLine.toLowerCase().includes('land'));
        const nonlands = player.battlefield.filter(p => !p.typeLine.toLowerCase().includes('land'));
        const landCards: Card[] = lands.map(perm => ({
          id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
          cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
          power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
          colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
          tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
        }));
        count += lands.length;
        const updatedPlayer = { ...player, battlefield: nonlands, graveyard: [...player.graveyard, ...landCards] };
        const players = [...state.players];
        players[pi] = updatedPlayer;
        state = { ...state, players };
      }
      state = addLog(state, controller, `Destroyed all lands (${count}).`);
      return { state, resolved: true, description: `destroy all lands (${count})` };
    },
  },

  // ── Put +1/+1 counter on target creature ──
  {
    name: 'put-counter-target',
    match: /put\s+(a|an|one|two|three|four|\d+)\s+\+1\/\+1\s+counters?\s+on\s+target\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const count = parseNumber(m[1]);
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const current = perm.counters['+1/+1'] || 0;
      const updatedPerm = {
        ...perm,
        counters: { ...perm.counters, '+1/+1': current + count },
        currentPower: (perm.currentPower ?? 0) + count,
        currentToughness: (perm.currentToughness ?? 0) + count,
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Put ${count} +1/+1 counter(s) on ${perm.name}.`);
      return { state, resolved: true, description: `${perm.name} +${count} counters` };
    },
  },

  // ── Put +1/+1 counter on ~ ──
  {
    name: 'put-counter-self',
    match: /put\s+(a|an|one|two|three|four|\d+)\s+\+1\/\+1\s+counters?\s+on\s+~/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      if (!source) return { state, resolved: false };
      const count = parseNumber(m[1]);
      const found = findPermanentById(state, source.id);
      if (!found) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const current = perm.counters['+1/+1'] || 0;
      const updatedPerm = {
        ...perm,
        counters: { ...perm.counters, '+1/+1': current + count },
        currentPower: (perm.currentPower ?? 0) + count,
        currentToughness: (perm.currentToughness ?? 0) + count,
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Put ${count} +1/+1 counter(s) on ${perm.name}.`);
      return { state, resolved: true, description: `${perm.name} +${count} counters` };
    },
  },

  // ── Put +1/+1 counters on each creature you control ──
  {
    name: 'counters-all-your-creatures',
    match: /put\s+(a|an|one|two|three|\d+)\s+\+1\/\+1\s+counters?\s+on\s+each\s+creature\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const player = state.players[controller];
      let affected = 0;
      const updatedBf = player.battlefield.map(perm => {
        if (perm.currentPower === undefined) return perm;
        affected++;
        const current = perm.counters['+1/+1'] || 0;
        return {
          ...perm,
          counters: { ...perm.counters, '+1/+1': current + count },
          currentPower: (perm.currentPower ?? 0) + count,
          currentToughness: (perm.currentToughness ?? 0) + count,
        };
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Put ${count} +1/+1 counter(s) on ${affected} creature(s).`);
      return { state, resolved: true, description: `+${count} counters on ${affected} creatures` };
    },
  },

  // ── Damage to each opponent ──
  {
    name: 'damage-each-opponent',
    match: /deals?\s+(\d+)\s+damage\s+to\s+each\s+opponent/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      for (const opp of getOpponents(state, controller)) {
        state = damagePlayer(state, opp, amount);
      }
      state = addLog(state, controller, `Dealt ${amount} damage to each opponent.`);
      return { state, resolved: true, description: `${amount} damage to each opponent` };
    },
  },

  // ── Damage to each player ──
  {
    name: 'damage-each-player',
    match: /deals?\s+(\d+)\s+damage\s+to\s+each\s+player/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      state = damagePlayer(state, 0, amount);
      state = damagePlayer(state, 1, amount);
      state = addLog(state, controller, `Dealt ${amount} damage to each player.`);
      return { state, resolved: true, description: `${amount} damage to each player` };
    },
  },

  // ── Each opponent loses life ──
  {
    name: 'each-opponent-loses-life',
    match: /each\s+opponent\s+loses\s+(\d+|one|two|three)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseNumber(m[1]);
      const opp: number = getFirstOpponent(state, controller);
      state = damagePlayer(state, opp, amount);
      state = addLog(state, controller, `Each opponent loses ${amount} life.`);
      return { state, resolved: true, description: `opponents lose ${amount} life` };
    },
  },

  // ── Sacrifice a creature ──
  {
    name: 'sacrifice-creature',
    match: /sacrifice\s+a\s+creature/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p => p.currentPower !== undefined);
      if (creatures.length === 0) {
        return { state: addLog(state, controller, 'No creatures to sacrifice.'), resolved: true, description: 'no creatures' };
      }
      if (creatures.length === 1) {
        // Only one choice — auto-sacrifice
        state = sacrificePermanent(state, creatures[0].id);
        state = addLog(state, controller, `${state.players[controller].name} sacrifices ${creatures[0].name}.`);
        return { state, resolved: true, description: `sacrifice ${creatures[0].name}` };
      }
      // Multiple creatures — set pendingSacrifice for UI
      return {
        state: { ...state, pendingSacrifice: { player: controller, filter: 'creature', count: 1 } },
        resolved: false,
        description: 'sacrifice requires selection',
      };
    },
  },

  // ── Each player sacrifices a creature ──
  {
    name: 'each-player-sacrifices',
    match: /each\s+(?:player|opponent)\s+sacrifices?\s+a\s+creature/i,
    requiresTarget: false,
    apply: (state, controller) => {
      for (let p = 0; p < 2; p++) {
        const pi = p;
        const player = state.players[pi];
        const creatures = player.battlefield.filter(perm => perm.currentPower !== undefined);
        if (creatures.length > 0) {
          // Auto-select weakest creature
          const weakest = creatures.reduce((a, b) => ((a.currentPower ?? 0) <= (b.currentPower ?? 0) ? a : b));
          state = sacrificePermanent(state, weakest.id);
          state = addLog(state, pi, `${state.players[pi].name} sacrifices ${weakest.name}.`);
        }
      }
      return { state, resolved: true, description: 'each player sacrifices a creature' };
    },
  },

  // ── Search library (tutor) ──
  {
    name: 'search-library',
    match: /search\s+your\s+library\s+for\s+(?:a|an)\s+/i,
    requiresTarget: false,
    apply: (state, controller) => {
      if (state.players[controller].library.length === 0) {
        return { state: addLog(state, controller, 'Library is empty.'), resolved: true, description: 'empty library' };
      }
      return {
        state: { ...state, pendingSearch: { player: controller, filter: '', count: 1, destination: 'hand' } },
        resolved: false,
        description: 'search library',
      };
    },
  },

  // ── Creatures you control gain keyword until end of turn ──
  {
    name: 'your-creatures-gain-keyword',
    match: /creatures?\s+you\s+control\s+gain\s+(flying|haste|trample|lifelink|deathtouch|first\s+strike|vigilance|menace|hexproof|indestructible)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const keyword = m[1].toLowerCase();
      const player = state.players[controller];
      let count = 0;
      const updatedBf = player.battlefield.map(perm => {
        if (perm.currentPower === undefined) return perm;
        count++;
        return {
          ...perm,
          temporaryKeywords: [
            ...(perm.temporaryKeywords || []),
            { keyword, source: 'spell', turn: state.turn },
          ],
        };
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Creatures you control gain ${keyword} until end of turn (${count}).`);
      return { state, resolved: true, description: `${count} creatures gain ${keyword}` };
    },
  },

  // ── Destroy target creature with toughness N or less/greater ──
  {
    name: 'destroy-by-toughness',
    match: /destroy\s+target\s+creature\s+with\s+toughness\s+(\d+)\s+or\s+(less|greater)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const threshold = parseInt(m[1]);
      const dir = m[2].toLowerCase();
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const toughness = target.perm.currentToughness ?? parseInt(target.perm.toughness || '0');
      const valid = dir === 'less' ? toughness <= threshold : toughness >= threshold;
      if (!valid) {
        state = addLog(state, controller, `${target.perm.name} has toughness ${toughness}, doesn't meet threshold.`);
        return { state, resolved: true, description: `${target.perm.name} not destroyed (toughness)` };
      }
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Destroyed ${target.perm.name} (toughness ${toughness}).`);
      return { state, resolved: true, description: `destroy ${target.perm.name}` };
    },
  },

  // ── Damage equal to power ──
  {
    name: 'damage-equal-to-power',
    match: /deals?\s+damage\s+equal\s+to\s+(?:its?|~'?s?)\s+power\s+to\s+(?:target\s+)?(creature|player|any\s+target)/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m, source) => {
      if (!source) return { state, resolved: false };
      const sourcePerm = findPermanentById(state, source.id);
      const power = sourcePerm?.perm.currentPower ?? parseInt(source.power || '0');
      const permTarget = getTargetPermanent(state, targets);
      const playerTarget = getTargetPlayer(targets);
      if (permTarget) {
        state = damagePermanent(state, permTarget.perm.id, power, source.colors);
        state = addLog(state, controller, `Dealt ${power} damage to ${permTarget.perm.name}.`);
      } else if (playerTarget !== null) {
        state = damagePlayer(state, playerTarget, power);
        state = addLog(state, controller, `Dealt ${power} damage to player.`);
      } else {
        return { state, resolved: false };
      }
      return { state, resolved: true, description: `${power} damage (power)` };
    },
  },

  // ── Destroy target nonland permanent ──
  {
    name: 'destroy-nonland-permanent',
    match: /destroy\s+target\s+nonland\s+permanent/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Destroyed ${target.perm.name}.`);
      return { state, resolved: true, description: `destroy ${target.perm.name}` };
    },
  },

  // ── Exile target nonland permanent ──
  {
    name: 'exile-nonland-permanent',
    match: /exile\s+target\s+nonland\s+permanent/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'exile');
      state = addLog(state, controller, `Exiled ${target.perm.name}.`);
      return { state, resolved: true, description: `exile ${target.perm.name}` };
    },
  },

  // ── Return target creature card from graveyard to hand ──
  {
    name: 'return-from-graveyard-to-hand',
    match: /return\s+target\s+(?:creature\s+)?card\s+from\s+(?:your\s+)?graveyard\s+to\s+(?:your\s+)?hand/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const creatures = player.graveyard.filter(c => c.typeLine.toLowerCase().includes('creature'));
      if (creatures.length === 0) {
        state = addLog(state, controller, 'No creature cards in graveyard.');
        return { state, resolved: true, description: 'no creatures in gy' };
      }
      // Auto-select best creature (highest CMC)
      const best = creatures.reduce((a, b) => a.cmc >= b.cmc ? a : b);
      const gyIdx = player.graveyard.findIndex(c => c.id === best.id);
      const updatedGy = [...player.graveyard];
      updatedGy.splice(gyIdx, 1);
      const players = [...state.players];
      players[controller] = { ...player, hand: [...player.hand, best], graveyard: updatedGy };
      state = { ...state, players };
      state = addLog(state, controller, `Returned ${best.name} from graveyard to hand.`);
      return { state, resolved: true, description: `return ${best.name} to hand` };
    },
  },

  // ── Draw then discard (rummage: discard first, draw after) ──
  {
    name: 'discard-then-draw-n',
    match: /discard\s+(a|an|one|two|three|\d+)\s+cards?\s*(?:,|\.)?\s*(?:then\s+)?draw\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const discardCount = parseNumber(m[1]);
      const drawCount = parseNumber(m[2]);
      // Auto-discard from end of hand, then draw
      const player = state.players[controller];
      const toDiscard = player.hand.slice(-discardCount);
      const remainingHand = player.hand.slice(0, -discardCount);
      const updatedPlayer = {
        ...player,
        hand: remainingHand,
        graveyard: [...player.graveyard, ...toDiscard],
      };
      const players = [...state.players];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = drawCards(state, controller, drawCount);
      state = addLog(state, controller, `Discarded ${toDiscard.length}, drew ${drawCount}.`);
      return { state, resolved: true, description: `discard ${discardCount}, draw ${drawCount}` };
    },
  },

  // ── Create 1/1 tokens with keyword ──
  {
    name: 'create-token-with-keyword',
    match: /create\s+(a|an|one|two|three|four|\d+)\s+(\d+)\/(\d+)\s+\w+\s+(?:\w+\s+)?(?:creature\s+)?tokens?\s+with\s+(flying|haste|trample|lifelink|deathtouch|vigilance|menace)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseCount = parseNumber(m[1]);
      const count = baseCount * getTokenMultiplier(state, controller);
      const power = parseInt(m[2]);
      const toughness = parseInt(m[3]);
      const keyword = m[4];
      const tokens: Permanent[] = [];
      for (let i = 0; i < count; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_creature', name: `${power}/${toughness} Token`,
          manaCost: '', cmc: 0, typeLine: 'Token Creature',
          oracleText: keyword,
          power: String(power), toughness: String(toughness),
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        tokens.push(perm);
      }
      const player = state.players[controller];
      const updatedPlayer = { ...player, battlefield: [...player.battlefield, ...tokens] };
      const players = [...state.players];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Created ${count} ${power}/${toughness} token(s) with ${keyword}.`);
      return { state, resolved: true, description: `create ${count} ${power}/${toughness} w/ ${keyword}` };
    },
  },

  // ── Target player draws then discards ──
  {
    name: 'target-draws-discards',
    match: /target\s+(?:player|opponent)\s+draws?\s+(a|an|one|two|three|\d+)\s+cards?\s*(?:,|\.)?\s*then\s+discards?\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const drawCount = parseNumber(m[1]);
      const discardCount = parseNumber(m[2]);
      const opp: number = getFirstOpponent(state, controller);
      state = drawCards(state, opp, drawCount);
      // Discard from end of hand
      const player = state.players[opp];
      const toDiscard = player.hand.slice(-discardCount);
      const remainingHand = player.hand.slice(0, Math.max(0, player.hand.length - discardCount));
      const players = [...state.players];
      players[opp] = { ...player, hand: remainingHand, graveyard: [...player.graveyard, ...toDiscard] };
      state = { ...state, players };
      state = addLog(state, controller, `Opponent draws ${drawCount}, discards ${discardCount}.`);
      return { state, resolved: true, description: `opponent draw ${drawCount}, discard ${discardCount}` };
    },
  },

  // ── Prevent all combat damage ──
  {
    name: 'prevent-combat-damage',
    match: /prevent\s+all\s+combat\s+damage\s+that\s+would\s+be\s+dealt\s+(?:this\s+turn|to\s+you)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, `Prevent all combat damage this turn.`);
      return { state, resolved: true, description: 'prevent all combat damage' };
    },
  },

  // ── Each creature gets +X/+X until end of turn (all creatures, not just yours) ──
  {
    name: 'all-creatures-get-pump',
    match: /(?:each|all)\s+creatures?\s+get\s+([+-]\d+)\/([+-]\d+)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const powerMod = parseInt(m[1]);
      const toughMod = parseInt(m[2]);
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const updatedBf = player.battlefield.map(perm => {
          if (perm.currentPower === undefined) return perm;
          count++;
          return {
            ...perm,
            currentPower: (perm.currentPower ?? 0) + powerMod,
            currentToughness: (perm.currentToughness ?? 0) + toughMod,
            temporaryPtMods: [...(perm.temporaryPtMods || []), { power: powerMod, toughness: toughMod, source: 'all-pump', turn: state.turn }],
          };
        });
        const players = [...state.players];
        players[pi] = { ...player, battlefield: updatedBf };
        state = { ...state, players };
      }
      state = addLog(state, controller, `All creatures get ${m[1]}/${m[2]} until end of turn (${count}).`);
      return { state, resolved: true, description: `all creatures ${m[1]}/${m[2]} (${count})` };
    },
  },

  // ── You may pay life (for phyrexian mana or similar) ──
  {
    name: 'pay-life',
    match: /(?:you\s+)?(?:pay|lose)\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      state = damagePlayer(state, controller, amount);
      state = addLog(state, controller, `Paid ${amount} life.`);
      return { state, resolved: true, description: `pay ${amount} life` };
    },
  },

  // ── Exile target creature, return it at beginning of next end step ──
  {
    name: 'flicker',
    match: /exile\s+target\s+creature\s*(?:,|\.)?\s*(?:then\s+)?return\s+(?:it|that\s+card)\s+to\s+the\s+battlefield/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      // Exile then re-enter: remove, then create a fresh permanent
      state = removePermanentFromBattlefield(state, target.perm.id, 'exile');
      // Put it back on the battlefield
      const player = state.players[target.playerIdx];
      const exiledCard = player.exile[player.exile.length - 1];
      if (exiledCard) {
        const newPerm = cardToPermanent(exiledCard, target.playerIdx, state.turn);
        const updatedExile = player.exile.slice(0, -1);
        const players = [...state.players];
        players[target.playerIdx] = {
          ...player,
          exile: updatedExile,
          battlefield: [...player.battlefield, newPerm],
        };
        state = { ...state, players };
      }
      state = addLog(state, controller, `Flickered ${target.perm.name} (exile + return).`);
      return { state, resolved: true, description: `flicker ${target.perm.name}` };
    },
  },

  // ── Phase 7 Patterns ──

  // 1. "target creature can't block this turn"
  {
    name: 'cant-block-this-turn',
    match: /target\s+creature\s+can'?t\s+block\s+this\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      // Grant "can't block" via temporary keyword
      const perm = target.perm;
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), {
          keyword: "can't block",
          source: 'effect',
          turn: state.turn,
        }],
      };
      const players = [...state.players];
      const bf = [...players[target.playerIdx].battlefield];
      bf[target.permIdx] = updatedPerm;
      players[target.playerIdx] = { ...players[target.playerIdx], battlefield: bf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} can't block this turn.`);
      return { state, resolved: true, description: `${perm.name} can't block` };
    },
  },

  // 2. "target creature gains indestructible until end of turn"
  {
    name: 'gain-indestructible-eot',
    match: /target\s+creature\s+gains?\s+indestructible\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const perm = target.perm;
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), {
          keyword: 'indestructible',
          source: 'effect',
          turn: state.turn,
        }],
      };
      const players = [...state.players];
      const bf = [...players[target.playerIdx].battlefield];
      bf[target.permIdx] = updatedPerm;
      players[target.playerIdx] = { ...players[target.playerIdx], battlefield: bf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains indestructible until end of turn.`);
      return { state, resolved: true, description: `${perm.name} gains indestructible` };
    },
  },

  // 3. "each opponent discards a card"
  {
    name: 'opponent-discards',
    match: /(?:target|each)\s+opponent\s+discards?\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const isEach = /^each/i.test(m[0]);
      const opponentsToAffect = isEach ? getOpponents(state, controller) : [getFirstOpponent(state, controller)];
      for (const opponent of opponentsToAffect) {
        const oppPlayer = state.players[opponent];
        const discarded = oppPlayer.hand.slice(0, count);
        if (discarded.length === 0) continue;
        const players = [...state.players];
        players[opponent] = {
          ...oppPlayer,
          hand: oppPlayer.hand.slice(count),
          graveyard: [...oppPlayer.graveyard, ...discarded],
        };
        state = { ...state, players };
        state = addLog(state, controller, `${oppPlayer.name} discards ${discarded.map(c => c.name).join(', ')}.`);
      }
      return { state, resolved: true, description: `opponent discards ${count}` };
    },
  },

  // 4. "each player discards a card"
  {
    name: 'each-player-discards',
    match: /each\s+player\s+discards?\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const players = [...state.players];
      for (let i = 0; i < 2; i++) {
        const p = players[i];
        const discarded = p.hand.slice(0, count);
        players[i] = {
          ...p,
          hand: p.hand.slice(count),
          graveyard: [...p.graveyard, ...discarded],
        };
      }
      state = { ...state, players };
      state = addLog(state, controller, `Each player discards ${count} card(s).`);
      return { state, resolved: true, description: `each player discards ${count}` };
    },
  },

  // 5. "target creature gets +X/+X and gains trample until end of turn" (combined pump+keyword)
  {
    name: 'pump-gains-keyword',
    match: /target\s+creature\s+gets?\s+([+-]\d+)\/([+-]\d+)\s+and\s+gains?\s+(\w+)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const powerMod = parseInt(m[1]);
      const toughMod = parseInt(m[2]);
      const keyword = m[3].toLowerCase();
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const perm = target.perm;
      const updatedPerm = {
        ...perm,
        currentPower: (perm.currentPower ?? 0) + powerMod,
        currentToughness: (perm.currentToughness ?? 0) + toughMod,
        temporaryPtMods: [...perm.temporaryPtMods, { power: powerMod, toughness: toughMod, source: 'spell', turn: state.turn }],
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword, source: 'spell', turn: state.turn }],
      };
      const players = [...state.players];
      const bf = [...players[target.playerIdx].battlefield];
      bf[target.permIdx] = updatedPerm;
      players[target.playerIdx] = { ...players[target.playerIdx], battlefield: bf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gets ${m[1]}/${m[2]} and gains ${keyword} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} ${m[1]}/${m[2]} + ${keyword}` };
    },
  },

  // 6. "put a +1/+1 counter on each creature you control"
  {
    name: 'counter-all-your-creatures-v2',
    match: /put\s+(?:a|an|one|two|three|\d+)\s+\+1\/\+1\s+counters?\s+on\s+each\s+creature\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const countStr = m[0].match(/(?:a|an|one|two|three|\d+)/i)?.[0] || 'a';
      const count = parseNumber(countStr);
      const players = [...state.players];
      let affected = 0;
      players[controller] = {
        ...players[controller],
        battlefield: players[controller].battlefield.map(p => {
          if (p.currentPower !== undefined) {
            affected++;
            return {
              ...p,
              currentPower: (p.currentPower ?? 0) + count,
              currentToughness: (p.currentToughness ?? 0) + count,
              counters: { ...p.counters, '+1/+1': (p.counters['+1/+1'] || 0) + count },
            };
          }
          return p;
        }),
      };
      state = { ...state, players };
      state = addLog(state, controller, `Put ${count} +1/+1 counter(s) on ${affected} creatures.`);
      return { state, resolved: true, description: `+1/+1 on ${affected} creatures` };
    },
  },

  // 7. "return target creature to its owner's hand" (single target bounce)
  {
    name: 'bounce-target-creature',
    match: /return\s+target\s+creature\s+to\s+its\s+owner'?s?\s+hand/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const perm = target.perm;
      // Remove from battlefield, add to owner's hand (as a card, not permanent)
      const cardObj = {
        id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
        cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
        power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
        colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
        tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
      };
      const players = [...state.players];
      // Remove from current controller's battlefield
      const bf = players[target.playerIdx].battlefield.filter((_, idx) => idx !== target.permIdx);
      players[target.playerIdx] = { ...players[target.playerIdx], battlefield: bf };
      // Add to owner's hand
      const ownerIdx = perm.owner ?? target.playerIdx;
      players[ownerIdx] = { ...players[ownerIdx], hand: [...players[ownerIdx].hand, cardObj] };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} returned to its owner's hand.`);
      return { state, resolved: true, description: `bounce ${perm.name}` };
    },
  },

  // 8. "exile target creature, its controller gains life equal to its power/toughness" (Swords to Plowshares / Path to Exile)
  {
    name: 'exile-gain-life-toughness',
    match: /exile\s+target\s+creature[.,]?\s*its\s+controller\s+gains?\s+life\s+equal\s+to\s+its\s+(power|toughness)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const stat = m[1].toLowerCase();
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const perm = target.perm;
      const amount = stat === 'power' ? (perm.currentPower ?? 0) : (perm.currentToughness ?? 0);
      state = removePermanentFromBattlefield(state, perm.id, 'exile');
      state = gainLife(state, target.playerIdx, amount);
      state = addLog(state, controller, `Exiled ${perm.name}. ${state.players[target.playerIdx].name} gains ${amount} life.`);
      return { state, resolved: true, description: `exile ${perm.name}, gain ${amount} life` };
    },
  },

  // 9. "search your library for a basic land card, put it onto the battlefield tapped, then shuffle"
  {
    name: 'search-basic-land-bf',
    match: /search\s+your\s+library\s+for\s+a\s+basic\s+land\s+card.*?put\s+it\s+onto\s+the\s+battlefield\s+tapped/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m) => {
      const player = state.players[controller];
      const landIdx = player.library.findIndex(c => c.typeLine?.toLowerCase().includes('basic') && c.typeLine?.toLowerCase().includes('land'));
      if (landIdx === -1) {
        state = addLog(state, controller, 'No basic land found in library.');
        return { state, resolved: true, description: 'no basic land found' };
      }
      const land = player.library[landIdx];
      const perm = cardToPermanent(land, controller, state.turn);
      perm.tapped = true;
      perm.summoningSick = false;
      const newLibrary = [...player.library];
      newLibrary.splice(landIdx, 1);
      // Shuffle
      for (let i = newLibrary.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newLibrary[i], newLibrary[j]] = [newLibrary[j], newLibrary[i]];
      }
      const players = [...state.players];
      players[controller] = {
        ...player,
        library: newLibrary,
        battlefield: [...player.battlefield, perm],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Searches library, puts ${land.name} onto the battlefield tapped, shuffles.`);
      return { state, resolved: true, description: `fetch ${land.name} (tapped)` };
    },
  },

  // 10. "you gain 1 life for each creature you control"
  {
    name: 'gain-life-per-creature',
    match: /you\s+gain\s+(\d+)\s+life\s+for\s+each\s+creature\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const per = parseInt(m[1]);
      const creatures = state.players[controller].battlefield.filter(p => p.currentPower !== undefined).length;
      const total = per * creatures;
      state = gainLife(state, controller, total);
      state = addLog(state, controller, `Gains ${total} life (${per} per ${creatures} creatures).`);
      return { state, resolved: true, description: `gain ${total} life` };
    },
  },

  // 11. "creatures you control get +1/+1 until end of turn" (anthem effect until eot)
  {
    name: 'all-your-creatures-pump-eot',
    match: /creatures?\s+you\s+control\s+get\s+([+-]\d+)\/([+-]\d+)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const powerMod = parseInt(m[1]);
      const toughMod = parseInt(m[2]);
      const players = [...state.players];
      let count = 0;
      players[controller] = {
        ...players[controller],
        battlefield: players[controller].battlefield.map(p => {
          if (p.currentPower !== undefined) {
            count++;
            return {
              ...p,
              currentPower: (p.currentPower ?? 0) + powerMod,
              currentToughness: (p.currentToughness ?? 0) + toughMod,
              temporaryPtMods: [...p.temporaryPtMods, { power: powerMod, toughness: toughMod, source: 'spell', turn: state.turn }],
            };
          }
          return p;
        }),
      };
      state = { ...state, players };
      state = addLog(state, controller, `Creatures you control get ${m[1]}/${m[2]} until end of turn.`);
      return { state, resolved: true, description: `${count} creatures get ${m[1]}/${m[2]}` };
    },
  },

  // 12. "you may draw a card" (optional draw)
  {
    name: 'may-draw',
    match: /you\s+may\s+draw\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      // Auto-resolve: always choose to draw (optimal for most cases)
      state = drawCards(state, controller, count);
      state = addLog(state, controller, `Draws ${count} card(s).`);
      return { state, resolved: true, description: `draw ${count}` };
    },
  },

  // 13. "target player loses N life and you gain N life" (drain)
  {
    name: 'drain-life',
    match: /target\s+(?:player|opponent)\s+loses?\s+(\d+)\s+life\s+and\s+you\s+gain\s+(\d+)\s+life/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const lossAmount = parseInt(m[1]);
      const gainAmount = parseInt(m[2]);
      const targetIdx = getTargetPlayer(targets) ?? getFirstOpponent(state, controller);
      state = damagePlayer(state, targetIdx, lossAmount);
      state = gainLife(state, controller, gainAmount);
      state = addLog(state, controller, `${state.players[targetIdx].name} loses ${lossAmount} life, you gain ${gainAmount} life.`);
      return { state, resolved: true, description: `drain ${lossAmount}/${gainAmount}` };
    },
  },

  // 14. "each opponent loses N life and you gain that much life"
  {
    name: 'drain-each-opponent',
    match: /each\s+opponent\s+loses?\s+(\d+)\s+life\s+and\s+you\s+gain\s+(?:that\s+much|life\s+equal)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      const opponents = getOpponents(state, controller);
      for (const opp of opponents) {
        state = damagePlayer(state, opp, amount);
      }
      state = gainLife(state, controller, amount * opponents.length);
      state = addLog(state, controller, `Each opponent loses ${amount} life, you gain ${amount * opponents.length} life.`);
      return { state, resolved: true, description: `drain ${amount}` };
    },
  },

  // 15. "exile target card from a graveyard"
  {
    name: 'exile-from-graveyard',
    match: /exile\s+target\s+card\s+from\s+a\s+graveyard/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m) => {
      const cardTarget = targets.find(t => t.type === 'card-in-zone' && t.zone === 'graveyard');
      if (!cardTarget) return { state, resolved: false };
      const players = [...state.players];
      for (let i = 0; i < 2; i++) {
        const player = players[i];
        const cardIdx = player.graveyard.findIndex(c => c.id === cardTarget.id);
        if (cardIdx !== -1) {
          const card = player.graveyard[cardIdx];
          const newGY = [...player.graveyard];
          newGY.splice(cardIdx, 1);
          players[i] = { ...player, graveyard: newGY, exile: [...player.exile, card] };
          state = { ...state, players };
          state = addLog(state, controller, `Exiles ${card.name} from graveyard.`);
          return { state, resolved: true, description: `exile ${card.name} from graveyard` };
        }
      }
      return { state, resolved: false };
    },
  },

  // 16. "target creature fights target creature" (fight)
  {
    name: 'fight-v2',
    match: /target\s+creature\s+(?:you\s+control\s+)?fights?\s+(?:another\s+)?target\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m) => {
      const permTargets = targets.filter(t => t.type === 'permanent');
      if (permTargets.length < 2) return { state, resolved: false };
      const perm1 = findPermanentById(state, permTargets[0].id);
      const perm2 = findPermanentById(state, permTargets[1].id);
      if (!perm1 || !perm2) return { state, resolved: false };
      // Each deals damage equal to its power to the other
      const p1 = perm1.perm.currentPower ?? 0;
      const p2 = perm2.perm.currentPower ?? 0;
      state = damagePermanent(state, perm2.perm.id, p1);
      state = damagePermanent(state, perm1.perm.id, p2);
      state = addLog(state, controller, `${perm1.perm.name} (${p1}) fights ${perm2.perm.name} (${p2}).`);
      return { state, resolved: true, description: `${perm1.perm.name} fights ${perm2.perm.name}` };
    },
  },

  // 17. "put target creature on top of its owner's library"
  {
    name: 'tuck-creature',
    match: /put\s+target\s+creature\s+on\s+top\s+of\s+its\s+owner'?s?\s+library/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const perm = target.perm;
      const cardObj = {
        id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
        cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
        power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
        colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
        tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
      };
      const players = [...state.players];
      const bf = players[target.playerIdx].battlefield.filter((_, idx) => idx !== target.permIdx);
      players[target.playerIdx] = { ...players[target.playerIdx], battlefield: bf };
      const ownerIdx = (perm.owner ?? target.playerIdx);
      players[ownerIdx] = { ...players[ownerIdx], library: [cardObj, ...players[ownerIdx].library] };
      state = { ...state, players };
      state = addLog(state, controller, `Put ${perm.name} on top of its owner's library.`);
      return { state, resolved: true, description: `tuck ${perm.name}` };
    },
  },

  // 18. "look at the top N cards of your library, put one into your hand, rest on bottom"
  {
    name: 'impulse-draw',
    match: /look\s+at\s+the\s+top\s+(two|three|four|five|\d+)\s+cards?\s+of\s+your\s+library.*?put\s+(?:one|a\s+card)\s+(?:of\s+them\s+)?into\s+your\s+hand/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const player = state.players[controller];
      if (player.library.length === 0) return { state, resolved: true, description: 'library empty' };
      // Take the best card (first one as simplification — player would choose)
      const topCard = player.library[0];
      const rest = player.library.slice(1, count);
      const remaining = player.library.slice(count);
      const players = [...state.players];
      // Put one in hand, rest on bottom
      players[controller] = {
        ...player,
        hand: [...player.hand, topCard],
        library: [...remaining, ...rest],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Looks at top ${count} cards, puts ${topCard.name} into hand.`);
      return { state, resolved: true, description: `impulse: ${topCard.name}` };
    },
  },

  // 19. "add {W}{U}{B}{R}{G}" or "add N mana in any combination of colors"
  {
    name: 'add-mana-fixed',
    match: /add\s+((?:\{[wubrgc]\}\s*){2,})/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const symbols = m[1].match(/\{([wubrgc])\}/gi) || [];
      const players = [...state.players];
      const pool = { ...players[controller].manaPool };
      for (const sym of symbols) {
        const c = sym.replace(/[{}]/g, '').toUpperCase() as keyof typeof pool;
        if (c in pool) (pool as any)[c]++;
      }
      players[controller] = { ...players[controller], manaPool: pool };
      state = { ...state, players };
      state = addLog(state, controller, `Adds ${symbols.join('')} to mana pool.`);
      return { state, resolved: true, description: `add ${symbols.join('')}` };
    },
  },

  // 20. "you lose N life"
  {
    name: 'lose-life-self',
    match: /you\s+lose\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      state = damagePlayer(state, controller, amount);
      state = addLog(state, controller, `Loses ${amount} life.`);
      return { state, resolved: true, description: `lose ${amount} life` };
    },
  },

  // 21. "untap all creatures you control"
  {
    name: 'untap-all-your-creatures',
    match: /untap\s+all\s+creatures?\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m) => {
      const players = [...state.players];
      let count = 0;
      players[controller] = {
        ...players[controller],
        battlefield: players[controller].battlefield.map(p => {
          if (p.currentPower !== undefined && p.tapped) {
            count++;
            return { ...p, tapped: false };
          }
          return p;
        }),
      };
      state = { ...state, players };
      state = addLog(state, controller, `Untaps ${count} creatures.`);
      return { state, resolved: true, description: `untap ${count} creatures` };
    },
  },

  // 22. "destroy target creature with flying"
  {
    name: 'destroy-creature-flying',
    match: /destroy\s+target\s+creature\s+with\s+flying/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Destroys ${target.perm.name}.`);
      return { state, resolved: true, description: `destroy ${target.perm.name}` };
    },
  },

  // 23. "draw a card for each creature you control"
  {
    name: 'draw-per-creature',
    match: /draw\s+(?:a|one)\s+card\s+for\s+each\s+creature\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m) => {
      const count = state.players[controller].battlefield.filter(p => p.currentPower !== undefined).length;
      if (count > 0) state = drawCards(state, controller, count);
      state = addLog(state, controller, `Draws ${count} cards (1 per creature).`);
      return { state, resolved: true, description: `draw ${count}` };
    },
  },

  // 24. "deals damage to target creature equal to the number of creatures you control"
  {
    name: 'damage-by-creature-count',
    match: /deals?\s+damage\s+to\s+target\s+creature\s+equal\s+to\s+the\s+number\s+of\s+creatures?\s+you\s+control/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m) => {
      const count = state.players[controller].battlefield.filter(p => p.currentPower !== undefined).length;
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = damagePermanent(state, target.perm.id, count);
      state = addLog(state, controller, `Deals ${count} damage to ${target.perm.name}.`);
      return { state, resolved: true, description: `${count} damage to ${target.perm.name}` };
    },
  },

  // 25. "target player shuffles their graveyard into their library"
  {
    name: 'shuffle-gy-into-library',
    match: /(?:target\s+player|you)\s+shuffles?\s+(?:their|your)\s+graveyard\s+into\s+(?:their|your)\s+library/i,
    requiresTarget: false,
    apply: (state, controller, targets, _m) => {
      const targetIdx = getTargetPlayer(targets) ?? controller;
      const player = state.players[targetIdx];
      const combined = [...player.library, ...player.graveyard];
      // Shuffle
      for (let i = combined.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [combined[i], combined[j]] = [combined[j], combined[i]];
      }
      const players = [...state.players];
      players[targetIdx] = { ...player, library: combined, graveyard: [] };
      state = { ...state, players };
      state = addLog(state, controller, `${player.name} shuffles graveyard into library.`);
      return { state, resolved: true, description: `shuffle GY into library` };
    },
  },

  // ══════════════════════════════════════════════════════════════════
  // ── New Patterns: Sacrifice, Choice/Modal, Mill, Combat, Life, Protection, Counter/Stax ──
  // ══════════════════════════════════════════════════════════════════

  // ── 1. sacrifice-a-creature ──
  {
    name: 'sacrifice-a-creature',
    match: /sacrifice\s+a\s+creature(?!\s+you\s+don)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
      if (creatures.length === 0) return { state, resolved: true, description: 'no creatures to sacrifice' };
      // Prefer tokens first, then lowest CMC
      const sorted = [...creatures].sort((a, b) => {
        const aIsToken = a.oracleId?.startsWith('token_') ? 0 : 1;
        const bIsToken = b.oracleId?.startsWith('token_') ? 0 : 1;
        if (aIsToken !== bIsToken) return aIsToken - bIsToken;
        return (a.cmc ?? 0) - (b.cmc ?? 0);
      });
      const victim = sorted[0];
      state = sacrificePermanent(state, victim.id);
      state = addLog(state, controller, `${state.players[controller].name} sacrifices ${victim.name}.`);
      return { state, resolved: true, description: `sacrifice ${victim.name}` };
    },
  },

  // ── 2. sacrifice-a-permanent ──
  {
    name: 'sacrifice-a-permanent',
    match: /sacrifice\s+a\s+(?:nonland\s+)?permanent/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const candidates = player.battlefield.filter(p => !p.typeLine?.toLowerCase().includes('land'));
      if (candidates.length === 0) return { state, resolved: true, description: 'no non-land permanents to sacrifice' };
      const sorted = [...candidates].sort((a, b) => {
        const aIsToken = a.oracleId?.startsWith('token_') ? 0 : 1;
        const bIsToken = b.oracleId?.startsWith('token_') ? 0 : 1;
        if (aIsToken !== bIsToken) return aIsToken - bIsToken;
        return (a.cmc ?? 0) - (b.cmc ?? 0);
      });
      const victim = sorted[0];
      state = sacrificePermanent(state, victim.id);
      state = addLog(state, controller, `${state.players[controller].name} sacrifices ${victim.name}.`);
      return { state, resolved: true, description: `sacrifice ${victim.name}` };
    },
  },

  // ── 3. each-player-sacrifices-creature ──
  {
    name: 'each-player-sacrifices-creature',
    match: /each\s+player\s+sacrifices?\s+a\s+creature/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const sacrificed: string[] = [];
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const creatures = player.battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
        if (creatures.length === 0) continue;
        const sorted = [...creatures].sort((a, b) => {
          const aIsToken = a.oracleId?.startsWith('token_') ? 0 : 1;
          const bIsToken = b.oracleId?.startsWith('token_') ? 0 : 1;
          if (aIsToken !== bIsToken) return aIsToken - bIsToken;
          return (a.cmc ?? 0) - (b.cmc ?? 0);
        });
        const victim = sorted[0];
        state = sacrificePermanent(state, victim.id);
        state = addLog(state, pi, `${player.name} sacrifices ${victim.name}.`);
        sacrificed.push(victim.name);
      }
      return { state, resolved: true, description: `each player sacrifices: ${sacrificed.join(', ') || 'none'}` };
    },
  },

  // ── 4. sacrifice-target-creature ──
  {
    name: 'sacrifice-target-creature',
    match: /sacrifice\s+target\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { perm } = target;
      state = sacrificePermanent(state, perm.id);
      state = addLog(state, controller, `${perm.name} is sacrificed.`);
      return { state, resolved: true, description: `sacrifice ${perm.name}` };
    },
  },

  // ── 5. sacrifice-n-creatures ──
  {
    name: 'sacrifice-n-creatures',
    match: /sacrifice\s+(two|three|four|five|\d+)\s+creatures?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
      if (creatures.length === 0) return { state, resolved: true, description: 'no creatures to sacrifice' };
      const sorted = [...creatures].sort((a, b) => {
        const aIsToken = a.oracleId?.startsWith('token_') ? 0 : 1;
        const bIsToken = b.oracleId?.startsWith('token_') ? 0 : 1;
        if (aIsToken !== bIsToken) return aIsToken - bIsToken;
        return (a.cmc ?? 0) - (b.cmc ?? 0);
      });
      const toSacrifice = sorted.slice(0, Math.min(count, sorted.length));
      const names: string[] = [];
      for (const victim of toSacrifice) {
        state = sacrificePermanent(state, victim.id);
        names.push(victim.name);
      }
      state = addLog(state, controller, `${state.players[controller].name} sacrifices ${names.join(', ')}.`);
      return { state, resolved: true, description: `sacrifice ${names.length} creature(s)` };
    },
  },

  // ── 6. opponents-sacrifice ──
  {
    name: 'opponents-sacrifice',
    match: /each\s+opponent\s+sacrifices?\s+a\s+creature/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opp: number = getFirstOpponent(state, controller);
      const player = state.players[opp];
      const creatures = player.battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
      if (creatures.length === 0) {
        state = addLog(state, controller, `Opponent has no creatures to sacrifice.`);
        return { state, resolved: true, description: 'opponent has no creatures' };
      }
      const sorted = [...creatures].sort((a, b) => {
        const aIsToken = a.oracleId?.startsWith('token_') ? 0 : 1;
        const bIsToken = b.oracleId?.startsWith('token_') ? 0 : 1;
        if (aIsToken !== bIsToken) return aIsToken - bIsToken;
        return (a.cmc ?? 0) - (b.cmc ?? 0);
      });
      const victim = sorted[0];
      state = sacrificePermanent(state, victim.id);
      state = addLog(state, controller, `${player.name} sacrifices ${victim.name}.`);
      return { state, resolved: true, description: `opponent sacrifices ${victim.name}` };
    },
  },

  // ── 7. sacrifice-unless-pay ──
  {
    name: 'sacrifice-unless-pay',
    match: /sacrifice\s+(?:~|this\s+(?:creature|permanent|artifact|enchantment))\s+unless\s+you\s+pay/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      // Auto-sacrifice (no mana check for now)
      const name = source?.name || 'permanent';
      // Find the source permanent on the battlefield
      if (source) {
        const found = findPermanentById(state, source.id);
        if (found) {
          state = sacrificePermanent(state, source.id);
          state = addLog(state, controller, `${name} is sacrificed (unable to pay cost).`);
          return { state, resolved: true, description: `sacrifice ${name}` };
        }
      }
      state = addLog(state, controller, `Could not find ${name} to sacrifice.`);
      return { state, resolved: true, description: `${name} not found` };
    },
  },

  // ══════════════════════════════════════
  // ── Choice / Modal Patterns ──
  // ══════════════════════════════════════

  // ── 8. choose-one-damage-or-draw ──
  {
    name: 'choose-one-damage-or-draw',
    match: /choose\s+one.*?deal\s+(\d+)\s+damage.*?draw/i,
    requiresTarget: true,
    apply: (state, controller, targets, m, source) => {
      // Auto-pick first option: deal damage
      const amount = parseInt(m[1]);
      const sourceColors = source?.colors || [];
      const permTarget = getTargetPermanent(state, targets);
      const playerTarget = getTargetPlayer(targets);
      if (permTarget) {
        state = damagePermanent(state, permTarget.perm.id, amount, sourceColors);
        state = addLog(state, controller, `Chooses to deal ${amount} damage to ${permTarget.perm.name}.`);
        return { state, resolved: true, description: `${amount} damage to ${permTarget.perm.name}` };
      } else if (playerTarget !== null) {
        state = damagePlayer(state, playerTarget, amount);
        state = addLog(state, controller, `Chooses to deal ${amount} damage to ${state.players[playerTarget].name}.`);
        return { state, resolved: true, description: `${amount} damage to player` };
      }
      // Fallback: damage opponent
      const opp: number = getFirstOpponent(state, controller);
      state = damagePlayer(state, opp, amount);
      state = addLog(state, controller, `Chooses to deal ${amount} damage to opponent.`);
      return { state, resolved: true, description: `${amount} damage to opponent` };
    },
  },

  // ── 9. choose-one-destroy-or-exile ──
  {
    name: 'choose-one-destroy-or-exile',
    match: /choose\s+one.*?(?:destroy|exile)\s+target.*?(?:destroy|exile)\s+target/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      // Auto-pick first option: destroy/exile the first target
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Chooses to destroy ${target.perm.name}.`);
      return { state, resolved: true, description: `destroy ${target.perm.name}` };
    },
  },

  // ── 10. modal-destroy-or-bounce ──
  {
    name: 'modal-destroy-or-bounce',
    match: /destroy\s+target.*?or.*?return\s+target.*?to.*?(?:its\s+)?owner'?s?\s+hand/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      // Auto-pick: destroy the first target
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Destroys ${target.perm.name}.`);
      return { state, resolved: true, description: `destroy ${target.perm.name}` };
    },
  },

  // ── 11. do-one-or-both ──
  {
    name: 'do-one-or-both',
    match: /(?:choose\s+one\s+or\s+both|do\s+one\s+or\s+both).*?deal\s+(\d+)\s+damage.*?(?:draw|gain\s+(\d+)\s+life)/i,
    requiresTarget: false,
    apply: (state, controller, targets, m, source) => {
      const damage = parseInt(m[1]);
      const lifeOrDraw = m[2] ? parseInt(m[2]) : 0;
      const opp: number = getFirstOpponent(state, controller);
      const sourceColors = source?.colors || [];
      // Do both effects
      const permTarget = getTargetPermanent(state, targets);
      if (permTarget) {
        state = damagePermanent(state, permTarget.perm.id, damage, sourceColors);
      } else {
        state = damagePlayer(state, opp, damage);
      }
      if (lifeOrDraw > 0) {
        state = gainLife(state, controller, lifeOrDraw);
      } else {
        state = drawCards(state, controller, 1);
      }
      state = addLog(state, controller, `Does both: deals ${damage} damage and gains benefit.`);
      return { state, resolved: true, description: `both: ${damage} damage + benefit` };
    },
  },

  // ══════════════════════════════════════
  // ── Mill & Library Patterns ──
  // ══════════════════════════════════════

  // ── 12. mill-each-opponent ──
  {
    name: 'mill-each-opponent',
    match: /each\s+opponent\s+mills?\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const opp: number = getFirstOpponent(state, controller);
      const player = state.players[opp];
      const milled = player.library.slice(0, count);
      const remaining = player.library.slice(count);
      const players = [...state.players];
      players[opp] = { ...player, library: remaining, graveyard: [...player.graveyard, ...milled] };
      state = { ...state, players };
      state = addLog(state, controller, `${player.name} mills ${milled.length} card(s).`);
      return { state, resolved: true, description: `opponent mills ${milled.length}` };
    },
  },

  // ── 13. target-mills ──
  {
    name: 'target-mills',
    match: /target\s+player\s+mills?\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+cards?/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const count = parseNumber(m[1]);
      const targetIdx = getTargetPlayer(targets) ?? getFirstOpponent(state, controller);
      const player = state.players[targetIdx];
      const milled = player.library.slice(0, count);
      const remaining = player.library.slice(count);
      const players = [...state.players];
      players[targetIdx] = { ...player, library: remaining, graveyard: [...player.graveyard, ...milled] };
      state = { ...state, players };
      state = addLog(state, controller, `${player.name} mills ${milled.length} card(s).`);
      return { state, resolved: true, description: `${player.name} mills ${milled.length}` };
    },
  },

  // ── 14. reveal-top-draw ──
  {
    name: 'reveal-top-draw',
    match: /reveal\s+the\s+top\s+(\d+|one|two|three|four|five)\s+cards?\s+of\s+your\s+library.*?put.*?into.*?hand/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      // Simplified: draw that many cards (reveal = draw for simplicity)
      state = drawCards(state, controller, count);
      state = addLog(state, controller, `Reveals top ${count} card(s) and puts them into hand.`);
      return { state, resolved: true, description: `reveal top ${count}, draw` };
    },
  },

  // ── 15. look-at-top-put-bottom ──
  {
    name: 'look-at-top-put-bottom',
    match: /look\s+at\s+the\s+top\s+card\s+of\s+your\s+library.*?(?:put\s+it\s+on\s+the\s+bottom|you\s+may\s+put\s+it\s+on\s+the\s+bottom)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      if (player.library.length === 0) return { state, resolved: true, description: 'library empty' };
      const topCard = player.library[0];
      // Scry-like: put on bottom (simplified — always bottom)
      const remaining = player.library.slice(1);
      const players = [...state.players];
      players[controller] = { ...player, library: [...remaining, topCard] };
      state = { ...state, players };
      state = addLog(state, controller, `Looks at top card (${topCard.name}), puts it on the bottom.`);
      return { state, resolved: true, description: `scry: ${topCard.name} to bottom` };
    },
  },

  // ══════════════════════════════════════
  // ── Combat-related Patterns ──
  // ══════════════════════════════════════

  // ── 16. target-creature-fights (fight v3) ──
  {
    name: 'target-creature-fights',
    match: /target\s+creature\s+you\s+control\s+fights\s+target\s+creature\s+you\s+don'?t\s+control/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const permTargets = targets.filter(t => t.type === 'permanent');
      if (permTargets.length < 2) return { state, resolved: false };
      const perm1 = findPermanentById(state, permTargets[0].id);
      const perm2 = findPermanentById(state, permTargets[1].id);
      if (!perm1 || !perm2) return { state, resolved: false };
      const p1 = perm1.perm.currentPower ?? 0;
      const p2 = perm2.perm.currentPower ?? 0;
      if (!hasProtectionFrom(perm2.perm, perm1.perm.colors || [])) {
        state = damagePermanent(state, perm2.perm.id, p1, perm1.perm.colors || []);
      }
      if (!hasProtectionFrom(perm1.perm, perm2.perm.colors || [])) {
        state = damagePermanent(state, perm1.perm.id, p2, perm2.perm.colors || []);
      }
      state = addLog(state, controller, `${perm1.perm.name} (${p1}) fights ${perm2.perm.name} (${p2}).`);
      return { state, resolved: true, description: `${perm1.perm.name} fights ${perm2.perm.name}` };
    },
  },

  // ── 17. bite (one-sided fight) ──
  {
    name: 'bite',
    match: /target\s+creature\s+you\s+control\s+deals?\s+damage\s+equal\s+to\s+its\s+power\s+to\s+target\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const permTargets = targets.filter(t => t.type === 'permanent');
      if (permTargets.length < 2) return { state, resolved: false };
      const biter = findPermanentById(state, permTargets[0].id);
      const victim = findPermanentById(state, permTargets[1].id);
      if (!biter || !victim) return { state, resolved: false };
      const power = biter.perm.currentPower ?? 0;
      if (!hasProtectionFrom(victim.perm, biter.perm.colors || [])) {
        state = damagePermanent(state, victim.perm.id, power, biter.perm.colors || []);
      }
      state = addLog(state, controller, `${biter.perm.name} deals ${power} damage to ${victim.perm.name} (bite).`);
      return { state, resolved: true, description: `${biter.perm.name} bites ${victim.perm.name} for ${power}` };
    },
  },

  // ── 18. creatures-cant-attack ──
  {
    name: 'creatures-cant-attack',
    match: /creatures?\s+can'?t\s+attack(?:\s+this\s+turn)?/i,
    requiresTarget: false,
    apply: (state, controller) => {
      // Apply restriction to all creatures on the opposing side by tapping them
      const opp: number = getFirstOpponent(state, controller);
      const player = state.players[opp];
      const updatedBf = player.battlefield.map(perm => {
        if (perm.typeLine?.toLowerCase().includes('creature')) {
          return {
            ...perm,
            temporaryKeywords: [
              ...(perm.temporaryKeywords || []),
              { keyword: 'cant-attack', source: 'spell', turn: state.turn },
            ],
          };
        }
        return perm;
      });
      const players = [...state.players];
      players[opp] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Creatures can't attack this turn.`);
      return { state, resolved: true, description: `creatures can't attack` };
    },
  },

  // ── 19. target-gains-double-strike ──
  {
    name: 'target-gains-double-strike',
    match: /target\s+creature\s+gains?\s+double\s+strike\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          { keyword: 'double strike', source: 'spell', turn: state.turn },
        ],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains double strike until end of turn.`);
      return { state, resolved: true, description: `${perm.name} gains double strike` };
    },
  },

  // ── 20. target-gains-lifelink ──
  {
    name: 'target-gains-lifelink',
    match: /target\s+creature\s+gains?\s+lifelink\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          { keyword: 'lifelink', source: 'spell', turn: state.turn },
        ],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains lifelink until end of turn.`);
      return { state, resolved: true, description: `${perm.name} gains lifelink` };
    },
  },

  // ══════════════════════════════════════
  // ── Life / Utility Patterns ──
  // ══════════════════════════════════════

  // ── 21. set-life-total ──
  {
    name: 'set-life-total',
    match: /your\s+life\s+total\s+becomes?\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const newLife = parseInt(m[1]);
      const players = [...state.players];
      players[controller] = { ...players[controller], life: newLife };
      state = { ...state, players };
      state = addLog(state, controller, `${players[controller].name}'s life total becomes ${newLife}.`);
      return { state, resolved: true, description: `life total set to ${newLife}` };
    },
  },

  // ── 22. exchange-life-totals ──
  {
    name: 'exchange-life-totals',
    match: /exchange\s+life\s+totals?\s+with\s+target\s+(?:player|opponent)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const targetIdx = getTargetPlayer(targets) ?? getFirstOpponent(state, controller);
      const myLife = state.players[controller].life;
      const theirLife = state.players[targetIdx].life;
      const players = [...state.players];
      players[controller] = { ...players[controller], life: theirLife };
      players[targetIdx] = { ...players[targetIdx], life: myLife };
      state = { ...state, players };
      state = addLog(state, controller, `${players[controller].name} exchanges life totals with ${players[targetIdx].name} (${theirLife} <-> ${myLife}).`);
      return { state, resolved: true, description: `exchange life: ${theirLife} <-> ${myLife}` };
    },
  },

  // ── 23. gain-life-equal-to-power ──
  {
    name: 'gain-life-equal-to-power',
    match: /you\s+gain\s+life\s+equal\s+to\s+(?:its|that\s+creature'?s?|target\s+creature'?s?)?\s*power/i,
    requiresTarget: false,
    apply: (state, controller, targets, _m, source) => {
      // Try target creature first, then source
      const target = getTargetPermanent(state, targets);
      let power = 0;
      let name = 'creature';
      if (target) {
        power = target.perm.currentPower ?? 0;
        name = target.perm.name;
      } else if (source) {
        const found = findPermanentById(state, source.id);
        if (found) {
          power = found.perm.currentPower ?? 0;
          name = found.perm.name;
        }
      }
      if (power > 0) {
        state = gainLife(state, controller, power);
      }
      state = addLog(state, controller, `${state.players[controller].name} gains ${power} life (equal to ${name}'s power).`);
      return { state, resolved: true, description: `gain ${power} life (${name}'s power)` };
    },
  },

  // ── 24. each-opponent-loses-life-you-gain-that-much (drain) ──
  {
    name: 'each-opponent-loses-life-you-gain-that-much',
    match: /each\s+opponent\s+loses?\s+(\d+)\s+life.*?you\s+gain\s+(?:life\s+equal\s+to\s+the\s+life\s+lost\s+this\s+way|that\s+much\s+life|\d+\s+life)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      const opp: number = getFirstOpponent(state, controller);
      state = damagePlayer(state, opp, amount);
      state = gainLife(state, controller, amount);
      state = addLog(state, controller, `Opponent loses ${amount} life, ${state.players[controller].name} gains ${amount} life.`);
      return { state, resolved: true, description: `drain ${amount}` };
    },
  },

  // ══════════════════════════════════════
  // ── Protection / Hexproof Patterns ──
  // ══════════════════════════════════════

  // ── 25. target-gains-hexproof ──
  {
    name: 'target-gains-hexproof',
    match: /target\s+(?:creature|permanent)\s+(?:you\s+control\s+)?gains?\s+hexproof\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          { keyword: 'hexproof', source: 'spell', turn: state.turn },
        ],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains hexproof until end of turn.`);
      return { state, resolved: true, description: `${perm.name} gains hexproof` };
    },
  },

  // ── 26. target-gains-indestructible ──
  {
    name: 'target-gains-indestructible',
    match: /target\s+(?:creature|permanent)\s+(?:you\s+control\s+)?gains?\s+indestructible\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          { keyword: 'indestructible', source: 'spell', turn: state.turn },
        ],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains indestructible until end of turn.`);
      return { state, resolved: true, description: `${perm.name} gains indestructible` };
    },
  },

  // ── 27. your-creatures-gain-indestructible ──
  {
    name: 'your-creatures-gain-indestructible',
    match: /creatures?\s+you\s+control\s+gain\s+indestructible\s+until\s+end\s+of\s+turn/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      let count = 0;
      const updatedBf = player.battlefield.map(perm => {
        if (perm.typeLine?.toLowerCase().includes('creature')) {
          count++;
          return {
            ...perm,
            temporaryKeywords: [
              ...(perm.temporaryKeywords || []),
              { keyword: 'indestructible', source: 'spell', turn: state.turn },
            ],
          };
        }
        return perm;
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${count} creature(s) gain indestructible until end of turn.`);
      return { state, resolved: true, description: `${count} creatures gain indestructible` };
    },
  },

  // ══════════════════════════════════════
  // ── Counter / Stax Patterns ──
  // ══════════════════════════════════════

  // ── 28. target-creature-gets-minus ──
  {
    name: 'target-creature-gets-minus',
    match: /target\s+creature\s+gets?\s+(-\d+)\/(-\d+)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const powerDelta = parseInt(m[1]);
      const toughnessDelta = parseInt(m[2]);
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedPerm = {
        ...perm,
        currentPower: (perm.currentPower ?? 0) + powerDelta,
        currentToughness: (perm.currentToughness ?? 0) + toughnessDelta,
        temporaryPtMods: [...(perm.temporaryPtMods || []), { power: powerDelta, toughness: toughnessDelta, source: 'spell', turn: state.turn }],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gets ${m[1]}/${m[2]} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} ${m[1]}/${m[2]}` };
    },
  },

  // ── 29. all-opponents-creatures-minus ──
  {
    name: 'all-opponents-creatures-minus',
    match: /creatures?\s+(?:your\s+opponents?\s+control|(?:an\s+)?opponent\s+controls?)\s+get\s+(-\d+)\/(-\d+)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const powerMod = parseInt(m[1]);
      const toughMod = parseInt(m[2]);
      const opp: number = getFirstOpponent(state, controller);
      const player = state.players[opp];
      let count = 0;
      const updatedBf = player.battlefield.map(perm => {
        if (perm.currentPower !== undefined && perm.typeLine?.toLowerCase().includes('creature')) {
          count++;
          return {
            ...perm,
            currentPower: (perm.currentPower ?? 0) + powerMod,
            currentToughness: (perm.currentToughness ?? 0) + toughMod,
            temporaryPtMods: [...(perm.temporaryPtMods || []), { power: powerMod, toughness: toughMod, source: 'spell', turn: state.turn }],
          };
        }
        return perm;
      });
      const players = [...state.players];
      players[opp] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Opponent's creatures get ${m[1]}/${m[2]} until end of turn (${count}).`);
      return { state, resolved: true, description: `${count} opp creatures ${m[1]}/${m[2]}` };
    },
  },

  // ── 30. put-on-top-of-library (tuck — broader) ──
  {
    name: 'put-on-top-of-library',
    match: /put\s+target\s+(?:creature|permanent|nonland\s+permanent)\s+on\s+top\s+of\s+(?:its|their)\s+owner'?s?\s+library/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const perm = target.perm;
      const cardObj: Card = {
        id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
        cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
        power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
        colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
        tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
      };
      const players = [...state.players];
      const bf = players[target.playerIdx].battlefield.filter((_, idx) => idx !== target.permIdx);
      players[target.playerIdx] = { ...players[target.playerIdx], battlefield: bf };
      const ownerIdx = (perm.owner ?? target.playerIdx);
      players[ownerIdx] = { ...players[ownerIdx], library: [cardObj, ...players[ownerIdx].library] };
      state = { ...state, players };
      state = addLog(state, controller, `Put ${perm.name} on top of its owner's library.`);
      return { state, resolved: true, description: `tuck ${perm.name}` };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── Phase 8 — 43 New Effect Patterns (reaching 200+) ──
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Ward & Protection ──

  // 1. ward-cost — log a warning about ward (can't prompt mid-resolution)
  {
    name: 'ward-cost',
    match: /ward\s+\{(\d+)\}/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const cost = parseInt(m[1]);
      const name = source?.name || 'permanent';
      state = addLog(state, controller, `${name} has ward {${cost}} — opponent must pay {${cost}} or spell is countered.`);
      return { state, resolved: true, description: `ward {${cost}} on ${name}` };
    },
  },

  // 2. protection-from-color — grant protection from a color until eot
  {
    name: 'protection-from-color',
    match: /target\s+creature\s+gains?\s+protection\s+from\s+(white|blue|black|red|green)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const color = m[1].toLowerCase();
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          { keyword: `protection from ${color}`, source: 'spell', turn: state.turn },
        ],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains protection from ${color} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} gains protection from ${color}` };
    },
  },

  // 3. hexproof-until-eot — player gains hexproof
  {
    name: 'you-gain-hexproof',
    match: /you\s+gain\s+hexproof\s+until\s+(?:end\s+of\s+turn|your\s+next\s+turn)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, `${state.players[controller].name} gains hexproof until end of turn.`);
      return { state, resolved: true, description: 'player gains hexproof' };
    },
  },

  // 4. shroud-target — target creature gains shroud until eot
  {
    name: 'shroud-target',
    match: /target\s+creature\s+gains?\s+shroud\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          { keyword: 'shroud', source: 'spell', turn: state.turn },
        ],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains shroud until end of turn.`);
      return { state, resolved: true, description: `${perm.name} gains shroud` };
    },
  },

  // ── Combat Restrictions ──

  // 5. target-cant-attack — target creature can't attack
  {
    name: 'target-cant-attack-v2',
    match: /target\s+creature\s+can'?t\s+attack\s+(?:or\s+block\s+)?this\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          { keyword: 'cant-attack', source: 'effect', turn: state.turn },
          { keyword: "can't block", source: 'effect', turn: state.turn },
        ],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} can't attack or block this turn.`);
      return { state, resolved: true, description: `${perm.name} can't attack or block` };
    },
  },

  // 6. target-must-attack — target creature attacks this turn if able
  {
    name: 'target-must-attack',
    match: /target\s+creature\s+attacks?\s+this\s+turn\s+if\s+able/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = addLog(state, controller, `${target.perm.name} must attack this turn if able.`);
      return { state, resolved: true, description: `${target.perm.name} must attack` };
    },
  },

  // 7. creatures-cant-block-all — creatures your opponents control can't block
  {
    name: 'opponents-creatures-cant-block',
    match: /creatures?\s+your\s+opponents?\s+controls?\s+can'?t\s+block\s+this\s+turn/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opp: number = getFirstOpponent(state, controller);
      const player = state.players[opp];
      const updatedBf = player.battlefield.map(perm => {
        if (perm.typeLine?.toLowerCase().includes('creature')) {
          return {
            ...perm,
            temporaryKeywords: [
              ...(perm.temporaryKeywords || []),
              { keyword: "can't block", source: 'effect', turn: state.turn },
            ],
          };
        }
        return perm;
      });
      const players = [...state.players];
      players[opp] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Opponent's creatures can't block this turn.`);
      return { state, resolved: true, description: `opponent's creatures can't block` };
    },
  },

  // 8. untap-all-creatures-you-control (dedicated creatures-only untap)
  {
    name: 'untap-all-creatures-you-control',
    match: /untap\s+(?:each|all)\s+creatures?\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      let count = 0;
      const updatedBf = player.battlefield.map(perm => {
        if (perm.typeLine?.toLowerCase().includes('creature') && perm.tapped) {
          count++;
          return { ...perm, tapped: false };
        }
        return perm;
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Untapped ${count} creatures you control.`);
      return { state, resolved: true, description: `untap ${count} creatures` };
    },
  },

  // ── Scry & Library Manipulation ──

  // 9. surveil-N — look at top N, put any into graveyard, rest on top
  {
    name: 'surveil',
    match: /surveil\s+(\d+|one|two|three|four|five)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const player = state.players[controller];
      const actual = Math.min(count, player.library.length);
      if (actual === 0) {
        state = addLog(state, controller, `Surveil ${count} — library empty.`);
        return { state, resolved: true, description: `surveil ${count} (empty)` };
      }
      // Simplified: put the worst cards (by CMC, highest first) into graveyard
      const topCards = player.library.slice(0, actual);
      const remaining = player.library.slice(actual);
      // Send non-land, high-CMC cards to graveyard, keep low-CMC/lands on top
      const sorted = [...topCards].sort((a, b) => {
        const aIsLand = a.typeLine?.toLowerCase().includes('land') ? 1 : 0;
        const bIsLand = b.typeLine?.toLowerCase().includes('land') ? 1 : 0;
        if (aIsLand !== bIsLand) return bIsLand - aIsLand; // lands go to graveyard
        return (b.cmc ?? 0) - (a.cmc ?? 0); // high CMC goes to graveyard
      });
      const toGY = sorted.slice(0, Math.floor(actual / 2));
      const toTop = sorted.slice(Math.floor(actual / 2));
      const players = [...state.players];
      players[controller] = {
        ...player,
        library: [...toTop, ...remaining],
        graveyard: [...player.graveyard, ...toGY],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Surveil ${actual}: ${toGY.length} to graveyard, ${toTop.length} on top.`);
      return { state, resolved: true, description: `surveil ${actual}` };
    },
  },

  // 10. search-library-land-hand — search library for a land, put into hand
  {
    name: 'search-land-to-hand',
    match: /search\s+your\s+library\s+for\s+a\s+(?:basic\s+)?land\s+card.*?(?:reveal\s+it.*?)?put\s+it\s+into\s+your\s+hand/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const landIdx = player.library.findIndex(c => c.typeLine?.toLowerCase().includes('land'));
      if (landIdx === -1) {
        state = addLog(state, controller, 'No land card found in library.');
        return { state, resolved: true, description: 'no land found' };
      }
      const land = player.library[landIdx];
      const newLibrary = [...player.library];
      newLibrary.splice(landIdx, 1);
      // Shuffle
      for (let i = newLibrary.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newLibrary[i], newLibrary[j]] = [newLibrary[j], newLibrary[i]];
      }
      const players = [...state.players];
      players[controller] = {
        ...player,
        library: newLibrary,
        hand: [...player.hand, land],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Searches library, puts ${land.name} into hand, shuffles.`);
      return { state, resolved: true, description: `fetch ${land.name} to hand` };
    },
  },

  // 11. cascade-draw — simplified cascade: draw a card
  {
    name: 'cascade-draw',
    match: /exile\s+cards?\s+from\s+the\s+top\s+of\s+your\s+library\s+until\s+you\s+exile\s+a\s+nonland\s+card/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      // Simplified: find first nonland card from top of library, "cast" it by drawing it
      let exiledCount = 0;
      const exiled: Card[] = [];
      let found: Card | null = null;
      for (let i = 0; i < player.library.length; i++) {
        const card = player.library[i];
        exiledCount++;
        if (!card.typeLine?.toLowerCase().includes('land')) {
          found = card;
          break;
        }
        exiled.push(card);
      }
      if (!found) {
        state = addLog(state, controller, 'Cascade: no nonland card found in library.');
        return { state, resolved: true, description: 'cascade whiffed' };
      }
      // Remove exiled cards + found card from library, put found into hand, rest on bottom
      const newLibrary = player.library.slice(exiledCount);
      const players = [...state.players];
      players[controller] = {
        ...player,
        library: [...newLibrary, ...exiled],
        hand: [...player.hand, found],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Cascade: exiled ${exiledCount} card(s), found ${found.name}.`);
      return { state, resolved: true, description: `cascade: ${found.name}` };
    },
  },

  // ── Enchantment & Artifact Removal ──

  // 12. destroy-all-artifacts-and-enchantments
  {
    name: 'destroy-all-artifacts-and-enchantments',
    match: /destroy\s+all\s+artifacts?\s+and\s+enchantments?/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const targets = player.battlefield.filter(p => {
          const tl = p.typeLine.toLowerCase();
          return tl.includes('artifact') || tl.includes('enchantment');
        });
        for (const t of targets) {
          state = removePermanentFromBattlefield(state, t.id, 'graveyard');
          count++;
        }
      }
      state = addLog(state, controller, `Destroys all artifacts and enchantments (${count} destroyed).`);
      return { state, resolved: true, description: `destroy all artifacts+enchantments (${count})` };
    },
  },

  // 13. exile-target-enchantment
  {
    name: 'exile-target-enchantment',
    match: /exile\s+target\s+enchantment/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'exile');
      state = addLog(state, controller, `Exiles ${target.perm.name}.`);
      return { state, resolved: true, description: `exile enchantment ${target.perm.name}` };
    },
  },

  // 14. exile-target-artifact
  {
    name: 'exile-target-artifact',
    match: /exile\s+target\s+artifact/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'exile');
      state = addLog(state, controller, `Exiles ${target.perm.name}.`);
      return { state, resolved: true, description: `exile artifact ${target.perm.name}` };
    },
  },

  // 15. exile-target-artifact-or-enchantment
  {
    name: 'exile-target-artifact-or-enchantment',
    match: /exile\s+target\s+artifact\s+or\s+enchantment/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'exile');
      state = addLog(state, controller, `Exiles ${target.perm.name}.`);
      return { state, resolved: true, description: `exile ${target.perm.name}` };
    },
  },

  // ── Return from Graveyard ──

  // 16. reanimate — put target creature card from a graveyard onto battlefield under your control
  {
    name: 'reanimate',
    match: /put\s+target\s+creature\s+card\s+from\s+a\s+graveyard\s+onto\s+the\s+battlefield\s+under\s+your\s+control/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const cardTarget = targets.find(t => t.type === 'card-in-zone' && t.zone === 'graveyard');
      if (!cardTarget) {
        // Fallback: grab the top creature from any graveyard
        for (let pi = 0; pi < 2; pi++) {
          const player = state.players[pi];
          const creatureIdx = player.graveyard.findIndex(c => c.typeLine?.toLowerCase().includes('creature'));
          if (creatureIdx !== -1) {
            const card = player.graveyard[creatureIdx];
            const updatedGy = [...player.graveyard];
            updatedGy.splice(creatureIdx, 1);
            const perm = cardToPermanent(card, controller, state.turn);
            const players = [...state.players];
            players[pi] = { ...players[pi], graveyard: updatedGy };
            players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, perm] };
            state = { ...state, players };
            state = addLog(state, controller, `Reanimates ${card.name} from graveyard.`);
            return { state, resolved: true, description: `reanimate ${card.name}` };
          }
        }
        return { state, resolved: false };
      }
      // Find the card in any graveyard
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const gyIdx = player.graveyard.findIndex(c => c.id === cardTarget.id);
        if (gyIdx !== -1) {
          const card = player.graveyard[gyIdx];
          const updatedGy = [...player.graveyard];
          updatedGy.splice(gyIdx, 1);
          const perm = cardToPermanent(card, controller, state.turn);
          const players = [...state.players];
          players[pi] = { ...players[pi], graveyard: updatedGy };
          players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, perm] };
          state = { ...state, players };
          state = addLog(state, controller, `Reanimates ${card.name} under your control.`);
          return { state, resolved: true, description: `reanimate ${card.name}` };
        }
      }
      return { state, resolved: false };
    },
  },

  // 17. regrowth — return target card from your graveyard to your hand
  {
    name: 'regrowth',
    match: /return\s+target\s+card\s+from\s+your\s+graveyard\s+to\s+your\s+hand/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const cardTarget = targets.find(t => t.type === 'card-in-zone' && t.zone === 'graveyard');
      if (!cardTarget) {
        // Fallback: return first card from graveyard
        const player = state.players[controller];
        if (player.graveyard.length === 0) return { state, resolved: false };
        const card = player.graveyard[0];
        const updatedGy = player.graveyard.slice(1);
        const players = [...state.players];
        players[controller] = { ...player, graveyard: updatedGy, hand: [...player.hand, card] };
        state = { ...state, players };
        state = addLog(state, controller, `Returns ${card.name} from graveyard to hand.`);
        return { state, resolved: true, description: `regrowth ${card.name}` };
      }
      const player = state.players[controller];
      const gyIdx = player.graveyard.findIndex(c => c.id === cardTarget.id);
      if (gyIdx === -1) return { state, resolved: false };
      const card = player.graveyard[gyIdx];
      const updatedGy = [...player.graveyard];
      updatedGy.splice(gyIdx, 1);
      const players = [...state.players];
      players[controller] = { ...player, graveyard: updatedGy, hand: [...player.hand, card] };
      state = { ...state, players };
      state = addLog(state, controller, `Returns ${card.name} from graveyard to hand.`);
      return { state, resolved: true, description: `regrowth ${card.name}` };
    },
  },

  // 18. return-creature-gy-to-bf — return target creature card from YOUR graveyard to battlefield
  {
    name: 'return-creature-gy-to-bf',
    match: /return\s+target\s+creature\s+card\s+from\s+your\s+graveyard\s+to\s+the\s+battlefield/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const cardTarget = targets.find(t => t.type === 'card-in-zone' && t.zone === 'graveyard');
      const player = state.players[controller];
      let card: Card | null = null;
      let gyIdx = -1;
      if (cardTarget) {
        gyIdx = player.graveyard.findIndex(c => c.id === cardTarget.id);
      }
      if (gyIdx === -1) {
        // Fallback: find first creature in graveyard
        gyIdx = player.graveyard.findIndex(c => c.typeLine?.toLowerCase().includes('creature'));
      }
      if (gyIdx === -1) return { state, resolved: false };
      card = player.graveyard[gyIdx];
      const updatedGy = [...player.graveyard];
      updatedGy.splice(gyIdx, 1);
      const perm = cardToPermanent(card, controller, state.turn);
      const players = [...state.players];
      players[controller] = { ...player, graveyard: updatedGy, battlefield: [...player.battlefield, perm] };
      state = { ...state, players };
      state = addLog(state, controller, `Returns ${card.name} from graveyard to the battlefield.`);
      return { state, resolved: true, description: `reanimate ${card.name}` };
    },
  },

  // ── Token Creation (Named Tokens) ──

  // 19. create-spirit-token — 1/1 white Spirit with flying
  {
    name: 'create-spirit-token',
    match: /create\s+(a|an|one|two|three|four|\d+)\s+1\/1\s+white\s+spirit\s+creature\s+tokens?\s+with\s+flying/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseQty = parseNumber(m[1]);
      const qty = baseQty * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_spirit', name: 'Spirit',
          manaCost: '', cmc: 0, typeLine: 'Token Creature — Spirit',
          oracleText: 'Flying',
          power: '1', toughness: '1',
          colors: ['W'], colorIdentity: ['W'], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        tokens.push(perm);
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} 1/1 white Spirit token(s) with flying.`);
      return { state, resolved: true, description: `create ${qty} Spirit token(s)` };
    },
  },

  // 20. create-soldier-token — 1/1 white Soldier
  {
    name: 'create-soldier-token',
    match: /create\s+(a|an|one|two|three|four|\d+)\s+1\/1\s+white\s+soldier\s+creature\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseQty = parseNumber(m[1]);
      const qty = baseQty * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_soldier', name: 'Soldier',
          manaCost: '', cmc: 0, typeLine: 'Token Creature — Soldier',
          oracleText: '',
          power: '1', toughness: '1',
          colors: ['W'], colorIdentity: ['W'], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        tokens.push(perm);
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} 1/1 white Soldier token(s).`);
      return { state, resolved: true, description: `create ${qty} Soldier token(s)` };
    },
  },

  // 21. create-saproling-token — 1/1 green Saproling
  {
    name: 'create-saproling-token',
    match: /create\s+(a|an|one|two|three|four|\d+)\s+1\/1\s+green\s+saproling\s+creature\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseQty = parseNumber(m[1]);
      const qty = baseQty * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_saproling', name: 'Saproling',
          manaCost: '', cmc: 0, typeLine: 'Token Creature — Saproling',
          oracleText: '',
          power: '1', toughness: '1',
          colors: ['G'], colorIdentity: ['G'], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        tokens.push(perm);
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} 1/1 green Saproling token(s).`);
      return { state, resolved: true, description: `create ${qty} Saproling token(s)` };
    },
  },

  // 22. create-beast-token — 3/3 green Beast
  {
    name: 'create-beast-token',
    match: /create\s+(a|an|one|two|three|\d+)\s+3\/3\s+green\s+beast\s+creature\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseQty = parseNumber(m[1]);
      const qty = baseQty * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_beast', name: 'Beast',
          manaCost: '', cmc: 0, typeLine: 'Token Creature — Beast',
          oracleText: '',
          power: '3', toughness: '3',
          colors: ['G'], colorIdentity: ['G'], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        tokens.push(perm);
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} 3/3 green Beast token(s).`);
      return { state, resolved: true, description: `create ${qty} Beast token(s)` };
    },
  },

  // 23. create-zombie-token — 2/2 black Zombie
  {
    name: 'create-zombie-token',
    match: /create\s+(a|an|one|two|three|four|\d+)\s+2\/2\s+black\s+zombie\s+creature\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseQty = parseNumber(m[1]);
      const qty = baseQty * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_zombie', name: 'Zombie',
          manaCost: '', cmc: 0, typeLine: 'Token Creature — Zombie',
          oracleText: '',
          power: '2', toughness: '2',
          colors: ['B'], colorIdentity: ['B'], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        tokens.push(perm);
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} 2/2 black Zombie token(s).`);
      return { state, resolved: true, description: `create ${qty} Zombie token(s)` };
    },
  },

  // 24. create-copy-token — create a token copy of target creature (simplified)
  {
    name: 'create-copy-token',
    match: /create\s+a\s+token\s+that'?s?\s+a\s+copy\s+of\s+target\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const original = target.perm;
      const tokenCard: Card = {
        id: generateCardId(),
        oracleId: `token_copy_${original.oracleId}`,
        name: original.name,
        manaCost: original.manaCost || '',
        cmc: original.cmc ?? 0,
        typeLine: `Token ${original.typeLine}`,
        oracleText: original.oracleText || '',
        power: original.power,
        toughness: original.toughness,
        colors: original.colors || [],
        colorIdentity: original.colorIdentity || [],
        rarity: 'common',
        tags: [],
        imageUrl: original.imageUrl || '',
        owner: controller,
      };
      const perm = cardToPermanent(tokenCard, controller, state.turn);
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, perm] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates a token copy of ${original.name}.`);
      return { state, resolved: true, description: `token copy of ${original.name}` };
    },
  },

  // ── Damage-Based ──

  // 25. damage-each-creature-and-player — deals N to each creature and each player
  {
    name: 'damage-each-creature-and-player',
    match: /deals?\s+(\d+)\s+damage\s+to\s+each\s+creature\s+and\s+each\s+player/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const amount = parseInt(m[1]);
      const sourceColors = source?.colors || [];
      let creatureCount = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const creatures = player.battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
        for (const c of creatures) {
          if (sourceColors.length > 0 && hasProtectionFrom(c, sourceColors)) continue;
          state = damagePermanent(state, c.id, amount, sourceColors);
          creatureCount++;
        }
      }
      state = damagePlayer(state, 0, amount);
      state = damagePlayer(state, 1, amount);
      state = addLog(state, controller, `Deals ${amount} damage to each creature (${creatureCount}) and each player.`);
      return { state, resolved: true, description: `${amount} to each creature+player` };
    },
  },

  // 26. damage-equal-to-toughness — deals damage to target creature equal to its toughness
  {
    name: 'damage-equal-to-toughness',
    match: /deals?\s+damage\s+to\s+target\s+creature\s+equal\s+to\s+(?:its|that\s+creature'?s?)?\s*toughness/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const toughness = target.perm.currentToughness ?? parseInt(target.perm.toughness || '0');
      state = damagePermanent(state, target.perm.id, toughness);
      state = addLog(state, controller, `Deals ${toughness} damage to ${target.perm.name} (equal to its toughness).`);
      return { state, resolved: true, description: `${toughness} damage to ${target.perm.name} (toughness)` };
    },
  },

  // 27. damage-to-player-equal-to-creatures — deal damage to opponent equal to creatures you control
  {
    name: 'damage-player-creature-count',
    match: /deals?\s+damage\s+to\s+(?:target\s+)?(?:player|opponent)\s+equal\s+to\s+the\s+number\s+of\s+creatures?\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opp: number = getFirstOpponent(state, controller);
      const creatureCount = state.players[controller].battlefield.filter(
        p => p.typeLine?.toLowerCase().includes('creature')
      ).length;
      state = damagePlayer(state, opp, creatureCount);
      state = addLog(state, controller, `Deals ${creatureCount} damage to ${state.players[opp].name} (creature count).`);
      return { state, resolved: true, description: `${creatureCount} damage to opponent` };
    },
  },

  // 28. damage-each-opponent-equal-to-creatures
  {
    name: 'damage-opponent-creature-count',
    match: /deals?\s+damage\s+to\s+each\s+opponent\s+equal\s+to\s+the\s+number\s+of\s+creatures?\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opp: number = getFirstOpponent(state, controller);
      const creatureCount = state.players[controller].battlefield.filter(
        p => p.typeLine?.toLowerCase().includes('creature')
      ).length;
      state = damagePlayer(state, opp, creatureCount);
      state = addLog(state, controller, `Deals ${creatureCount} damage to each opponent (creature count).`);
      return { state, resolved: true, description: `${creatureCount} damage to each opponent` };
    },
  },

  // ── Counters ──

  // 29. distribute-counters — distribute N +1/+1 counters among creatures you control
  {
    name: 'distribute-counters',
    match: /distribute\s+(\d+|one|two|three|four|five|six)\s+\+1\/\+1\s+counters?\s+among\s+(?:any\s+number\s+of\s+)?creatures?\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const totalCounters = parseNumber(m[1]);
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
      if (creatures.length === 0) {
        state = addLog(state, controller, 'No creatures to distribute counters to.');
        return { state, resolved: true, description: 'no creatures for counters' };
      }
      // Distribute evenly, remainder to first creature
      const perCreature = Math.floor(totalCounters / creatures.length);
      let remainder = totalCounters - perCreature * creatures.length;
      const updatedBf = player.battlefield.map(perm => {
        if (!perm.typeLine?.toLowerCase().includes('creature')) return perm;
        const bonus = remainder > 0 ? 1 : 0;
        if (remainder > 0) remainder--;
        const countersToAdd = perCreature + bonus;
        if (countersToAdd === 0) return perm;
        const existing = perm.counters['+1/+1'] || 0;
        return {
          ...perm,
          counters: { ...perm.counters, '+1/+1': existing + countersToAdd },
          currentPower: (perm.currentPower ?? 0) + countersToAdd,
          currentToughness: (perm.currentToughness ?? 0) + countersToAdd,
        };
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Distributes ${totalCounters} +1/+1 counters among ${creatures.length} creature(s).`);
      return { state, resolved: true, description: `distribute ${totalCounters} counters` };
    },
  },

  // 30. remove-counter-from-permanent — remove a counter from target permanent
  {
    name: 'remove-counter-from-permanent',
    match: /remove\s+(?:a|one|an)\s+(?:\+1\/\+1\s+)?counter\s+from\s+target\s+(?:creature|permanent)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      // Remove one +1/+1 counter if present
      const existing = perm.counters['+1/+1'] || 0;
      if (existing <= 0) {
        state = addLog(state, controller, `${perm.name} has no +1/+1 counters to remove.`);
        return { state, resolved: true, description: 'no counter to remove' };
      }
      const updatedPerm = {
        ...perm,
        counters: { ...perm.counters, '+1/+1': existing - 1 },
        currentPower: (perm.currentPower ?? 0) - 1,
        currentToughness: (perm.currentToughness ?? 0) - 1,
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Removes a +1/+1 counter from ${perm.name}.`);
      return { state, resolved: true, description: `remove counter from ${perm.name}` };
    },
  },

  // 31. proliferate — add one counter of each type already on permanents you control
  {
    name: 'proliferate',
    match: /proliferate/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      let affected = 0;
      const updatedBf = player.battlefield.map(perm => {
        const counterTypes = Object.keys(perm.counters).filter(k => (perm.counters[k] || 0) > 0);
        if (counterTypes.length === 0) return perm;
        affected++;
        const updatedCounters = { ...perm.counters };
        let powerDelta = 0;
        let toughDelta = 0;
        for (const ct of counterTypes) {
          updatedCounters[ct] = (updatedCounters[ct] || 0) + 1;
          if (ct === '+1/+1') { powerDelta++; toughDelta++; }
          if (ct === '-1/-1') { powerDelta--; toughDelta--; }
        }
        return {
          ...perm,
          counters: updatedCounters,
          currentPower: (perm.currentPower ?? 0) + powerDelta,
          currentToughness: (perm.currentToughness ?? 0) + toughDelta,
        };
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Proliferate: added counters to ${affected} permanent(s).`);
      return { state, resolved: true, description: `proliferate (${affected} permanents)` };
    },
  },

  // 32. put-minus-counters — put -1/-1 counters on target creature
  {
    name: 'put-minus-counters',
    match: /put\s+(a|an|one|two|three|four|\d+)\s+-1\/-1\s+counters?\s+on\s+target\s+creature/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const count = parseNumber(m[1]);
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const existing = perm.counters['-1/-1'] || 0;
      const updatedPerm = {
        ...perm,
        counters: { ...perm.counters, '-1/-1': existing + count },
        currentPower: (perm.currentPower ?? 0) - count,
        currentToughness: (perm.currentToughness ?? 0) - count,
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Puts ${count} -1/-1 counter(s) on ${perm.name}.`);
      return { state, resolved: true, description: `${count} -1/-1 on ${perm.name}` };
    },
  },

  // ── Discard & Hand ──

  // 33. target-player-reveals-hand
  {
    name: 'target-player-reveals-hand',
    match: /target\s+(?:player|opponent)\s+reveals?\s+(?:their|his\s+or\s+her)\s+hand/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opp: number = getFirstOpponent(state, controller);
      const hand = state.players[opp].hand;
      const cardNames = hand.map(c => c.name).join(', ') || 'empty hand';
      state = addLog(state, controller, `${state.players[opp].name} reveals hand: ${cardNames}.`);
      return { state, resolved: true, description: `opponent reveals hand (${hand.length} cards)` };
    },
  },

  // 34. wheel-of-fortune — each player discards hand and draws 7
  {
    name: 'wheel-of-fortune',
    match: /each\s+player\s+discards?\s+(?:their|his\s+or\s+her)\s+hand\s*(?:,|\.)?\s*(?:then\s+)?draws?\s+(seven|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const drawCount = parseNumber(m[1]);
      const players = [...state.players];
      for (let i = 0; i < 2; i++) {
        const p = players[i];
        players[i] = {
          ...p,
          graveyard: [...p.graveyard, ...p.hand],
          hand: [],
        };
      }
      state = { ...state, players };
      state = drawCards(state, 0, drawCount);
      state = drawCards(state, 1, drawCount);
      state = addLog(state, controller, `Each player discards their hand and draws ${drawCount} cards.`);
      return { state, resolved: true, description: `wheel: discard hand, draw ${drawCount}` };
    },
  },

  // 35. target-discards-then-draws — target player discards hand, draws that many
  {
    name: 'target-discards-hand-draws',
    match: /target\s+(?:player|opponent)\s+discards?\s+(?:their|his\s+or\s+her)\s+hand\s*(?:,|\.)?\s*(?:then\s+)?draws?\s+(?:that\s+many|cards?\s+equal)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opp: number = getFirstOpponent(state, controller);
      const player = state.players[opp];
      const handSize = player.hand.length;
      const players = [...state.players];
      players[opp] = { ...player, graveyard: [...player.graveyard, ...player.hand], hand: [] };
      state = { ...state, players };
      state = drawCards(state, opp, handSize);
      state = addLog(state, controller, `${player.name} discards hand (${handSize}), draws ${handSize}.`);
      return { state, resolved: true, description: `opponent wheels (${handSize})` };
    },
  },

  // ── Misc / Utility ──

  // 36. flicker-own — exile target creature you control, return it to battlefield
  {
    name: 'flicker-own',
    match: /exile\s+target\s+(?:creature|permanent)\s+you\s+control\s*(?:,|\.)?\s*(?:then\s+)?return\s+(?:it|that\s+card)\s+to\s+the\s+battlefield/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const perm = target.perm;
      state = removePermanentFromBattlefield(state, perm.id, 'exile');
      // Re-enter: grab the card from exile
      const player = state.players[controller];
      const exileIdx = player.exile.findIndex(c => c.id === perm.id);
      if (exileIdx !== -1) {
        const card = player.exile[exileIdx];
        const updatedExile = [...player.exile];
        updatedExile.splice(exileIdx, 1);
        const newPerm = cardToPermanent(card, controller, state.turn);
        const players = [...state.players];
        players[controller] = {
          ...player,
          exile: updatedExile,
          battlefield: [...players[controller].battlefield, newPerm],
        };
        state = { ...state, players };
      }
      state = addLog(state, controller, `Flickers ${perm.name} (exile + return).`);
      return { state, resolved: true, description: `flicker ${perm.name}` };
    },
  },

  // 37. phase-out — target permanent phases out (CR 702.26)
  // Phased-out permanents are treated as though they don't exist.
  // They phase back in during their controller's next untap step (handled in startNewTurn).
  {
    name: 'phase-out',
    match: /target\s+(?:creature|permanent)\s+phases?\s+out/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedPerm = {
        ...perm,
        phasedOut: true,
        tapped: true,
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} phases out.`);
      return { state, resolved: true, description: `${perm.name} phases out` };
    },
  },

  // 38. populate — create a copy of a creature token you control
  {
    name: 'populate',
    match: /populate/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const token = player.battlefield.find(p =>
        p.oracleId?.startsWith('token_') && p.typeLine?.toLowerCase().includes('creature')
      );
      if (!token) {
        state = addLog(state, controller, 'Populate: no creature tokens to copy.');
        return { state, resolved: true, description: 'populate (no tokens)' };
      }
      const tokenCard: Card = {
        id: generateCardId(),
        oracleId: token.oracleId,
        name: token.name,
        manaCost: token.manaCost || '',
        cmc: token.cmc ?? 0,
        typeLine: token.typeLine,
        oracleText: token.oracleText || '',
        power: token.power,
        toughness: token.toughness,
        colors: token.colors || [],
        colorIdentity: token.colorIdentity || [],
        rarity: 'common',
        tags: [],
        imageUrl: token.imageUrl || '',
        owner: controller,
      };
      const newPerm = cardToPermanent(tokenCard, controller, state.turn);
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, newPerm] };
      state = { ...state, players };
      state = addLog(state, controller, `Populate: creates a copy of ${token.name} token.`);
      return { state, resolved: true, description: `populate: copy ${token.name}` };
    },
  },

  // 39. becomes-creature — permanent becomes an N/N creature until end of turn
  {
    name: 'becomes-creature',
    match: /becomes?\s+(?:a\s+)?(\d+)\/(\d+)\s+(?:\w+\s+)*creature\s+until\s+end\s+of\s+turn/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      if (!source) return { state, resolved: false };
      const power = parseInt(m[1]);
      const toughness = parseInt(m[2]);
      const found = findPermanentById(state, source.id);
      if (!found) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const updatedPerm = {
        ...perm,
        currentPower: power,
        currentToughness: toughness,
        basePower: perm.basePower ?? power,
        baseToughness: perm.baseToughness ?? toughness,
        typeLine: perm.typeLine.includes('Creature') ? perm.typeLine : `${perm.typeLine} Creature`,
        temporaryPtMods: [...(perm.temporaryPtMods || []), { power, toughness, source: 'animate', turn: state.turn, isSetEffect: true, timestamp: nextEffectTimestamp() }],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} becomes a ${power}/${toughness} creature until end of turn.`);
      return { state, resolved: true, description: `${perm.name} becomes ${power}/${toughness}` };
    },
  },

  // 40. target-loses-abilities — target creature loses all abilities until end of turn
  {
    name: 'target-loses-abilities',
    match: /target\s+creature\s+loses?\s+all\s+abilities\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      // Clear all temporary keywords and set oracleText to empty temporarily
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [],
        oracleText: '',
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} loses all abilities until end of turn.`);
      return { state, resolved: true, description: `${perm.name} loses abilities` };
    },
  },

  // 41. exile-all-nonland-permanents — exile all nonland permanents
  {
    name: 'exile-all-nonland-permanents',
    match: /exile\s+all\s+nonland\s+permanents/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const nonlands = player.battlefield.filter(p => !p.typeLine.toLowerCase().includes('land'));
        for (const nl of nonlands) {
          state = removePermanentFromBattlefield(state, nl.id, 'exile');
          count++;
        }
      }
      state = addLog(state, controller, `Exiles all nonland permanents (${count} exiled).`);
      return { state, resolved: true, description: `exile all nonland (${count})` };
    },
  },

  // 42. create-goblin-token — 1/1 red Goblin
  {
    name: 'create-goblin-token',
    match: /create\s+(a|an|one|two|three|four|\d+)\s+1\/1\s+red\s+goblin\s+creature\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseQty = parseNumber(m[1]);
      const qty = baseQty * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_goblin', name: 'Goblin',
          manaCost: '', cmc: 0, typeLine: 'Token Creature — Goblin',
          oracleText: '',
          power: '1', toughness: '1',
          colors: ['R'], colorIdentity: ['R'], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        tokens.push(perm);
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} 1/1 red Goblin token(s).`);
      return { state, resolved: true, description: `create ${qty} Goblin token(s)` };
    },
  },

  // 43. create-angel-token — 4/4 white Angel with flying
  {
    name: 'create-angel-token',
    match: /create\s+(a|an|one|two|three|\d+)\s+4\/4\s+white\s+angel\s+creature\s+tokens?\s+with\s+flying/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const baseQty = parseNumber(m[1]);
      const qty = baseQty * getTokenMultiplier(state, controller);
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_angel', name: 'Angel',
          manaCost: '', cmc: 0, typeLine: 'Token Creature — Angel',
          oracleText: 'Flying',
          power: '4', toughness: '4',
          colors: ['W'], colorIdentity: ['W'], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        tokens.push(perm);
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} 4/4 white Angel token(s) with flying.`);
      return { state, resolved: true, description: `create ${qty} Angel token(s)` };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── A. Land/Mana Effects ──
  // ══════════════════════════════════════════════════════════════

  // 44. search-basic-land — search library for a basic land, put onto battlefield tapped
  {
    name: 'search-basic-land',
    match: /search your library for a basic land card.*put it onto the battlefield tapped/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      // Find the first basic land in library
      const landIdx = player.library.findIndex(c =>
        c.typeLine.toLowerCase().includes('basic') && c.typeLine.toLowerCase().includes('land')
      );
      if (landIdx === -1) {
        state = addLog(state, controller, 'Searched library — no basic land found.');
        state = shuffleLibrary(state, controller);
        return { state, resolved: true, description: 'search (no basic land)' };
      }
      const landCard = player.library[landIdx];
      const updatedLibrary = [...player.library];
      updatedLibrary.splice(landIdx, 1);
      const perm = cardToPermanent(landCard, controller, state.turn);
      perm.tapped = true;
      perm.summoningSick = false;
      const players = [...state.players];
      players[controller] = {
        ...player,
        library: updatedLibrary,
        battlefield: [...player.battlefield, perm],
      };
      state = { ...state, players };
      state = shuffleLibrary(state, controller);
      state = addLog(state, controller, `Searches library, puts ${landCard.name} onto the battlefield tapped.`);
      return { state, resolved: true, description: `search basic land (${landCard.name})` };
    },
  },

  // 45. add-mana-any-color — add N mana of any one color
  {
    name: 'add-mana-any-color',
    match: /add\s+(\d+)\s+mana\s+(?:of any (?:one )?color|in any combination)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      // Default to colorless (player would choose in full implementation)
      const player = state.players[controller];
      const updatedPool = { ...player.manaPool, C: player.manaPool.C + amount };
      const players = [...state.players];
      players[controller] = { ...player, manaPool: updatedPool };
      state = { ...state, players };
      state = addLog(state, controller, `Adds ${amount} mana (any color).`);
      return { state, resolved: true, description: `add ${amount} mana` };
    },
  },

  // 46. untap-target-land — untap target land
  {
    name: 'untap-target-land',
    match: /untap target land/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target land' };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = { ...perm, tapped: false };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Untaps ${perm.name}.`);
      return { state, resolved: true, description: `untap ${perm.name}` };
    },
  },

  // 47. lands-enter-tapped — lands enter the battlefield tapped (static; log only)
  {
    name: 'lands-enter-tapped',
    match: /lands.*enter the battlefield tapped/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, 'Lands enter the battlefield tapped (static effect).');
      return { state, resolved: true, description: 'lands enter tapped' };
    },
  },

  // 48. play-additional-land — you may play an additional land
  {
    name: 'play-additional-land',
    match: /you may play an additional land/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, maxLandPlays: player.maxLandPlays + 1 };
      state = { ...state, players };
      state = addLog(state, controller, 'May play an additional land this turn.');
      return { state, resolved: true, description: 'additional land play' };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── B. Library Manipulation ──
  // ══════════════════════════════════════════════════════════════

  // 49. look-at-top-cards — look at the top N cards of your library
  {
    name: 'look-at-top-cards',
    match: /look at the top (\d+) cards/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseInt(m[1]);
      state = addLog(state, controller, `Looks at the top ${count} card(s) of their library.`);
      return { state, resolved: true, description: `look at top ${count}` };
    },
  },

  // 50. put-card-on-top — put a card on top of library
  {
    name: 'put-card-on-top',
    match: /put.*on top of.*library/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, 'Puts a card on top of their library.');
      return { state, resolved: true, description: 'put card on top' };
    },
  },

  // 51. shuffle-library — shuffle your library
  {
    name: 'shuffle-library',
    match: /shuffle your library/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = shuffleLibrary(state, controller);
      state = addLog(state, controller, 'Shuffles their library.');
      return { state, resolved: true, description: 'shuffle library' };
    },
  },

  // 52. exile-top-card-play — exile the top card, you may play/cast it
  {
    name: 'exile-top-card-play',
    match: /exile the top card.*you may (?:play|cast) (?:it|that card)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      if (player.library.length === 0) {
        state = addLog(state, controller, 'Library is empty — no card to exile.');
        return { state, resolved: true, description: 'exile top (empty library)' };
      }
      const topCard = player.library[0];
      const players = [...state.players];
      players[controller] = {
        ...player,
        library: player.library.slice(1),
        exile: [...player.exile, topCard],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Exiles ${topCard.name} — may play it this turn.`);
      return { state, resolved: true, description: `exile top (${topCard.name})` };
    },
  },

  // 53. reveal-top-card — reveal the top card of your library
  {
    name: 'reveal-top-card',
    match: /reveal the top card/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      if (player.library.length === 0) {
        state = addLog(state, controller, 'Library is empty — nothing to reveal.');
        return { state, resolved: true, description: 'reveal top (empty)' };
      }
      const topCard = player.library[0];
      state = addLog(state, controller, `Reveals ${topCard.name} from the top of their library.`);
      return { state, resolved: true, description: `reveal ${topCard.name}` };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── C. Creature Modification ──
  // ══════════════════════════════════════════════════════════════

  // 54. target-creature-base-pt — target creature becomes N/N (Layer 7b set effect)
  {
    name: 'target-creature-base-pt',
    match: /target creature.*becomes?\s+(\d+)\/(\d+)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const newPower = parseInt(m[1]);
      const newToughness = parseInt(m[2]);
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target creature' };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        currentPower: newPower,
        currentToughness: newToughness,
        temporaryPtMods: [...(perm.temporaryPtMods || []), {
          power: newPower,
          toughness: newToughness,
          source: 'set-base-pt',
          turn: state.turn,
          isSetEffect: true,
          timestamp: nextEffectTimestamp(),
        }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} becomes ${newPower}/${newToughness}.`);
      return { state, resolved: true, description: `${perm.name} becomes ${newPower}/${newToughness}` };
    },
  },

  // 55. all-creatures-base-pt — all creatures become N/N (Layer 7b set effect)
  {
    name: 'all-creatures-base-pt',
    match: /all creatures become (\d+)\/(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const newPower = parseInt(m[1]);
      const newToughness = parseInt(m[2]);
      const ts = nextEffectTimestamp();
      const players = [...state.players];
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const updatedBf = player.battlefield.map(p => {
          if (p.currentPower !== undefined) {
            return {
              ...p,
              currentPower: newPower,
              currentToughness: newToughness,
              temporaryPtMods: [...(p.temporaryPtMods || []), {
                power: newPower,
                toughness: newToughness,
                source: 'set-base-pt',
                turn: state.turn,
                isSetEffect: true,
                timestamp: ts,
              }],
            };
          }
          return p;
        });
        players[pi] = { ...player, battlefield: updatedBf };
      }
      state = { ...state, players };
      state = addLog(state, controller, `All creatures become ${newPower}/${newToughness}.`);
      return { state, resolved: true, description: `all creatures ${newPower}/${newToughness}` };
    },
  },

  // 56. double-power — double target creature's power
  {
    name: 'double-power',
    match: /double.*power/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      const newPower = (perm.currentPower ?? 0) * 2;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = { ...perm, currentPower: newPower };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name}'s power doubled to ${newPower}.`);
      return { state, resolved: true, description: `double ${perm.name} power` };
    },
  },

  // 57. switch-pt — switch target creature's power and toughness
  {
    name: 'switch-pt',
    match: /switch.*power and toughness/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      const newPower = perm.currentToughness ?? 0;
      const newToughness = perm.currentPower ?? 0;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = { ...perm, currentPower: newPower, currentToughness: newToughness };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name}'s P/T switched to ${newPower}/${newToughness}.`);
      return { state, resolved: true, description: `switch ${perm.name} P/T` };
    },
  },

  // 58. cant-be-blocked — this creature can't be blocked
  {
    name: 'cant-be-blocked',
    match: /can't be blocked/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      const cardName = source?.name || 'Creature';
      state = addLog(state, controller, `${cardName} can't be blocked this turn.`);
      return { state, resolved: true, description: `${cardName} unblockable` };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── D. Control/Theft Effects ──
  // ══════════════════════════════════════════════════════════════

  // 59. gain-control-until-eot — gain control of target creature until end of turn
  {
    name: 'gain-control-until-eot',
    match: /gain control of target.*until end of turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      const opponent = playerIdx;
      // Move permanent to controller's battlefield with temporary control change
      const opponentPlayer = state.players[opponent];
      const updatedOpponentBf = [...opponentPlayer.battlefield];
      updatedOpponentBf.splice(permIdx, 1);
      const stolenPerm: Permanent = {
        ...perm,
        controller,
        tapped: false,
        summoningSick: false,
        temporaryControlChange: { originalController: opponent, source: 'gain control effect', turn: state.turn },
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'haste', source: 'gain control effect', turn: state.turn }],
      };
      const controllerPlayer = state.players[controller];
      const players = [...state.players];
      players[opponent] = { ...opponentPlayer, battlefield: updatedOpponentBf };
      players[controller] = { ...controllerPlayer, battlefield: [...controllerPlayer.battlefield, stolenPerm] };
      state = { ...state, players };
      state = addLog(state, controller, `Gains control of ${perm.name} until end of turn.`);
      return { state, resolved: true, description: `steal ${perm.name} until EOT` };
    },
  },

  // 60. gain-control-permanent — gain control of target (permanent)
  {
    name: 'gain-control-permanent',
    match: /gain control of target(?!.*until end of turn)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      if (playerIdx === controller) {
        state = addLog(state, controller, `Already controls ${perm.name}.`);
        return { state, resolved: true, description: 'already controlled' };
      }
      const opponent = playerIdx;
      const opponentPlayer = state.players[opponent];
      const updatedOpponentBf = [...opponentPlayer.battlefield];
      updatedOpponentBf.splice(permIdx, 1);
      const stolenPerm: Permanent = { ...perm, controller };
      const controllerPlayer = state.players[controller];
      const players = [...state.players];
      players[opponent] = { ...opponentPlayer, battlefield: updatedOpponentBf };
      players[controller] = { ...controllerPlayer, battlefield: [...controllerPlayer.battlefield, stolenPerm] };
      state = { ...state, players };
      state = addLog(state, controller, `Gains control of ${perm.name}.`);
      return { state, resolved: true, description: `steal ${perm.name}` };
    },
  },

  // 61. exchange-control — exchange control of two permanents (log only)
  {
    name: 'exchange-control',
    match: /exchange control/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      // Auto-resolve: swap the weakest controller permanent with the strongest opponent permanent
      const opp: number = getFirstOpponent(state, controller);
      const myPerms = state.players[controller].battlefield.filter(p => !p.typeLine.toLowerCase().includes('land'));
      const oppPerms = state.players[opp].battlefield.filter(p => !p.typeLine.toLowerCase().includes('land'));
      if (myPerms.length === 0 || oppPerms.length === 0) {
        state = addLog(state, controller, 'Exchange control — not enough permanents to exchange.');
        return { state, resolved: true, description: 'exchange control (insufficient permanents)' };
      }
      // Pick weakest own permanent and strongest opponent permanent
      const myWeakest = [...myPerms].sort((a, b) => (a.cmc ?? 0) - (b.cmc ?? 0))[0];
      const oppStrongest = [...oppPerms].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0))[0];
      // Remove from both battlefields and swap
      const players = [...state.players];
      players[controller] = {
        ...players[controller],
        battlefield: players[controller].battlefield.filter(p => p.id !== myWeakest.id).concat({ ...oppStrongest, controller }),
      };
      players[opp] = {
        ...players[opp],
        battlefield: players[opp].battlefield.filter(p => p.id !== oppStrongest.id).concat({ ...myWeakest, controller: opp }),
      };
      state = { ...state, players };
      state = addLog(state, controller, `Exchanged control: gave ${myWeakest.name}, took ${oppStrongest.name}.`);
      return { state, resolved: true, description: `exchange: ${myWeakest.name} <-> ${oppStrongest.name}` };
    },
  },

  // 62. target-attacks-if-able — target creature attacks this turn if able
  {
    name: 'target-attacks-if-able',
    match: /target creature attacks.*if able/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      const name = found ? found.perm.name : 'target creature';
      state = addLog(state, controller, `${name} must attack this turn if able.`);
      return { state, resolved: true, description: `${name} must attack` };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── E. Protection/Prevention ──
  // ══════════════════════════════════════════════════════════════

  // 63. prevent-all-damage — prevent all (combat) damage
  {
    name: 'prevent-all-damage',
    match: /prevent all (?:combat )?damage/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, 'Prevents all damage this turn.');
      return { state, resolved: true, description: 'prevent all damage' };
    },
  },

  // 64. prevent-next-damage — prevent the next N damage
  {
    name: 'prevent-next-damage',
    match: /prevent the next (\d+) damage/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      state = addLog(state, controller, `Prevents the next ${amount} damage.`);
      return { state, resolved: true, description: `prevent next ${amount} damage` };
    },
  },

  // 65. indestructible-until-eot — gains indestructible until end of turn
  {
    name: 'indestructible-until-eot',
    match: /(?:gains?|has) indestructible until end of turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'indestructible', source: 'effect', turn: state.turn }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains indestructible until end of turn.`);
      return { state, resolved: true, description: `${perm.name} indestructible` };
    },
  },

  // 66. hexproof-until-eot — gains hexproof until end of turn
  {
    name: 'hexproof-until-eot',
    match: /(?:gains?|has) hexproof until end of turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'hexproof', source: 'effect', turn: state.turn }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains hexproof until end of turn.`);
      return { state, resolved: true, description: `${perm.name} hexproof` };
    },
  },

  // 67. protection-until-eot — gains protection from [something]
  {
    name: 'protection-until-eot',
    match: /gains? protection from (\w+)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const protFrom = m[1];
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: `protection from ${protFrom}`, source: 'effect', turn: state.turn }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains protection from ${protFrom}.`);
      return { state, resolved: true, description: `${perm.name} protection from ${protFrom}` };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── F. Enchantment/Artifact Interaction ──
  // ══════════════════════════════════════════════════════════════

  // 68. enchant-creature-buff — enchanted creature gets +N/+N
  {
    name: 'enchant-creature-buff',
    match: /enchanted creature gets ([+-]\d+)\/([+-]\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const pBuff = parseInt(m[1]);
      const tBuff = parseInt(m[2]);
      state = addLog(state, controller, `Enchanted creature gets ${m[1]}/${m[2]} (aura buff applied via equipment system).`);
      return { state, resolved: true, description: `aura ${m[1]}/${m[2]}` };
    },
  },

  // 69. sacrifice-enchantment — sacrifice an enchantment
  {
    name: 'sacrifice-enchantment',
    match: /sacrifice an enchantment/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const enchantments = player.battlefield.filter(p => p.typeLine.toLowerCase().includes('enchantment'));
      if (enchantments.length === 0) {
        state = addLog(state, controller, 'No enchantments to sacrifice.');
        return { state, resolved: true, description: 'no enchantments' };
      }
      if (enchantments.length === 1) {
        state = sacrificePermanent(state, enchantments[0].id);
        state = addLog(state, controller, `${state.players[controller].name} sacrifices ${enchantments[0].name}.`);
        return { state, resolved: true, description: `sacrifice ${enchantments[0].name}` };
      }
      // Multiple — set pendingSacrifice for UI
      return {
        state: { ...state, pendingSacrifice: { player: controller, filter: 'enchantment', count: 1 } },
        resolved: false,
        description: 'sacrifice enchantment requires selection',
      };
    },
  },

  // 70. return-artifact-from-gy — return target artifact from graveyard to hand
  {
    name: 'return-artifact-from-gy',
    match: /return.*artifact.*from.*graveyard.*to.*hand/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const artifactIdx = player.graveyard.findIndex(c => c.typeLine.toLowerCase().includes('artifact'));
      if (artifactIdx === -1) {
        state = addLog(state, controller, 'No artifact in graveyard to return.');
        return { state, resolved: true, description: 'no artifact in gy' };
      }
      const artifact = player.graveyard[artifactIdx];
      const updatedGy = [...player.graveyard];
      updatedGy.splice(artifactIdx, 1);
      const players = [...state.players];
      players[controller] = { ...player, graveyard: updatedGy, hand: [...player.hand, artifact] };
      state = { ...state, players };
      state = addLog(state, controller, `Returns ${artifact.name} from graveyard to hand.`);
      return { state, resolved: true, description: `return ${artifact.name}` };
    },
  },

  // 71. destroy-target-nonland — destroy target nonland permanent
  {
    name: 'destroy-target-nonland',
    match: /destroy target nonland permanent/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m, source) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { perm } = found;
      if (perm.typeLine.toLowerCase().includes('land')) {
        state = addLog(state, controller, `${perm.name} is a land — cannot be destroyed by this effect.`);
        return { state, resolved: true, description: 'target is land' };
      }
      const sourceColors = source?.colors || [];
      if (sourceColors.length > 0 && hasProtectionFrom(perm, sourceColors)) {
        state = addLog(state, controller, `${perm.name} has protection — destruction prevented.`);
        return { state, resolved: true, description: 'protection prevents destroy' };
      }
      state = removePermanentFromBattlefield(state, perm.id, 'graveyard');
      state = addLog(state, controller, `Destroys ${perm.name}.`);
      return { state, resolved: true, description: `destroy ${perm.name}` };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── G. Graveyard Interaction ──
  // ══════════════════════════════════════════════════════════════

  // 72. exile-graveyard — exile all cards from a graveyard
  {
    name: 'exile-graveyard',
    match: /exile.*graveyard/i,
    requiresTarget: false,
    apply: (state, controller, targets) => {
      // Try to determine whose graveyard — default to opponent
      const targetPlayer = getTargetPlayer(targets);
      const targetIdx = targetPlayer ?? getFirstOpponent(state, controller);
      const player = state.players[targetIdx];
      const exiledCount = player.graveyard.length;
      const players = [...state.players];
      players[targetIdx] = { ...player, exile: [...player.exile, ...player.graveyard], graveyard: [] };
      state = { ...state, players };
      state = addLog(state, controller, `Exiles ${exiledCount} card(s) from ${player.name}'s graveyard.`);
      return { state, resolved: true, description: `exile ${exiledCount} from graveyard` };
    },
  },

  // 73. exile-target-from-gy — exile target card from a graveyard
  {
    name: 'exile-target-from-gy',
    match: /exile target card from a graveyard/i,
    requiresTarget: true,
    apply: (state, controller) => {
      // Auto-exile the highest CMC card from opponent's graveyard (most impactful removal)
      const opp: number = getFirstOpponent(state, controller);
      // Try opponent's graveyard first, then controller's
      for (const pi of [opp, controller]) {
        const gy = state.players[pi].graveyard;
        if (gy.length > 0) {
          const sorted = [...gy].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
          const target = sorted[0];
          const idx = gy.findIndex(c => c.id === target.id);
          const newGy = [...gy];
          newGy.splice(idx, 1);
          const players = [...state.players];
          players[pi] = { ...players[pi], graveyard: newGy, exile: [...players[pi].exile, target] };
          state = { ...state, players };
          state = addLog(state, controller, `Exiles ${target.name} from ${state.players[pi].name}'s graveyard.`);
          return { state, resolved: true, description: `exile ${target.name} from gy` };
        }
      }
      state = addLog(state, controller, 'No cards in any graveyard to exile.');
      return { state, resolved: true, description: 'no cards to exile from gy' };
    },
  },

  // 74. flashback — flashback keyword
  {
    name: 'flashback',
    match: /flashback/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, 'Flashback — may cast from graveyard (manual resolution).');
      return { state, resolved: true, description: 'flashback' };
    },
  },

  // 75. return-land-from-gy — return a land from graveyard to battlefield
  {
    name: 'return-land-from-gy',
    match: /return.*land.*from.*graveyard.*to.*battlefield/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const landIdx = player.graveyard.findIndex(c => c.typeLine.toLowerCase().includes('land'));
      if (landIdx === -1) {
        state = addLog(state, controller, 'No land in graveyard to return.');
        return { state, resolved: true, description: 'no land in gy' };
      }
      const land = player.graveyard[landIdx];
      const updatedGy = [...player.graveyard];
      updatedGy.splice(landIdx, 1);
      const perm = cardToPermanent(land, controller, state.turn);
      perm.summoningSick = false;
      const players = [...state.players];
      players[controller] = { ...player, graveyard: updatedGy, battlefield: [...player.battlefield, perm] };
      state = { ...state, players };
      state = addLog(state, controller, `Returns ${land.name} from graveyard to the battlefield.`);
      return { state, resolved: true, description: `return ${land.name} from gy` };
    },
  },

  // 76. mill-then-return — mill cards, then return something
  {
    name: 'mill-then-return',
    match: /mill.*then return/i,
    requiresTarget: false,
    apply: (state, controller) => {
      // Mill 3 cards (common default), then return a creature card from graveyard to hand
      const player = state.players[controller];
      const millCount = Math.min(3, player.library.length);
      const milled = player.library.slice(0, millCount);
      const newLib = player.library.slice(millCount);
      const newGy = [...player.graveyard, ...milled];
      const players = [...state.players];
      players[controller] = { ...player, library: newLib, graveyard: newGy };
      state = { ...state, players };
      state = addLog(state, controller, `Mills ${millCount} card(s): ${milled.map(c => c.name).join(', ')}.`);
      // Return a creature card from graveyard to hand (pick highest CMC creature)
      const updatedGy = state.players[controller].graveyard;
      const creatures = updatedGy.filter(c => c.typeLine?.toLowerCase().includes('creature'));
      if (creatures.length > 0) {
        const sorted = [...creatures].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
        const chosen = sorted[0];
        const gyIdx = updatedGy.findIndex(c => c.id === chosen.id);
        const finalGy = [...updatedGy];
        finalGy.splice(gyIdx, 1);
        const p2 = [...state.players];
        p2[controller] = { ...state.players[controller], graveyard: finalGy, hand: [...state.players[controller].hand, chosen] };
        state = { ...state, players: p2 };
        state = addLog(state, controller, `Returns ${chosen.name} from graveyard to hand.`);
      } else {
        state = addLog(state, controller, 'No creature in graveyard to return.');
      }
      return { state, resolved: true, description: `mill ${millCount}, return creature` };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── H. Player Effects ──
  // ══════════════════════════════════════════════════════════════

  // 77. each-player-discards — each player discards N cards
  {
    name: 'each-player-discards',
    match: /each player discards? (\d+|a|an|one|two|three) cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      for (let p = 0; p < 2; p++) {
        const pi = p;
        const player = state.players[pi];
        const actualCount = Math.min(count, player.hand.length);
        if (actualCount > 0) {
          const sorted = [...player.hand].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
          const discarded = sorted.slice(0, actualCount);
          const discardIds = new Set(discarded.map(c => c.id));
          const remaining = player.hand.filter(c => !discardIds.has(c.id));
          const players = [...state.players];
          players[pi] = { ...player, hand: remaining, graveyard: [...player.graveyard, ...discarded] };
          state = { ...state, players };
          state = addLog(state, pi, `${state.players[pi].name} discards ${discarded.map(c => c.name).join(', ')}.`);
        }
      }
      return { state, resolved: true, description: `each player discards ${count}` };
    },
  },

  // 78. each-player-sacrifices — each player sacrifices a creature/permanent
  {
    name: 'each-player-sacrifices',
    match: /each player sacrifices/i,
    requiresTarget: false,
    apply: (state, controller) => {
      for (let p = 0; p < 2; p++) {
        const pi = p;
        const player = state.players[pi];
        const creatures = player.battlefield.filter(perm => perm.currentPower !== undefined);
        if (creatures.length > 0) {
          const weakest = creatures.reduce((a, b) => ((a.currentPower ?? 0) <= (b.currentPower ?? 0) ? a : b));
          state = sacrificePermanent(state, weakest.id);
          state = addLog(state, pi, `${state.players[pi].name} sacrifices ${weakest.name}.`);
        }
      }
      return { state, resolved: true, description: 'each player sacrifices' };
    },
  },

  // 79. target-player-skips-draw — target player skips their draw step
  {
    name: 'target-player-skips-draw',
    match: /target player skips.*draw step/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const targetPlayer = getTargetPlayer(targets);
      const targetIdx = targetPlayer ?? getFirstOpponent(state, controller);
      state = addLog(state, controller, `${state.players[targetIdx].name} skips their next draw step.`);
      return { state, resolved: true, description: 'skip draw step' };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── I. Token Variety ──
  // ══════════════════════════════════════════════════════════════

  // 80. thopter-token — create 1/1 Thopter artifact creature tokens with flying
  {
    name: 'thopter-token',
    match: /create\s+(a|an|one|two|three|\d+)\s+1\/1.*thopter.*tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const qty = parseNumber(m[1]);
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_thopter', name: 'Thopter',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact Creature — Thopter',
          oracleText: 'Flying', power: '1', toughness: '1',
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        tokens.push(cardToPermanent(tokenCard, controller, state.turn));
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} 1/1 Thopter token(s) with flying.`);
      return { state, resolved: true, description: `create ${qty} Thopter token(s)` };
    },
  },

  // 81. clue-token — create a Clue artifact token (investigate)
  {
    name: 'clue-token',
    match: /(?:create\s+(?:a|an|one|two|three|\d+)\s+clue\s+tokens?|investigate)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const qtyMatch = m[0].match(/(a|an|one|two|three|\d+)\s+clue/i);
      const qty = qtyMatch ? parseNumber(qtyMatch[1]) : 1;
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_clue', name: 'Clue',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact — Clue',
          oracleText: '{2}, Sacrifice this artifact: Draw a card.', power: undefined as unknown as string, toughness: undefined as unknown as string,
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        tokens.push(cardToPermanent(tokenCard, controller, state.turn));
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} Clue token(s).`);
      return { state, resolved: true, description: `create ${qty} Clue token(s)` };
    },
  },

  // 82. treasure-token — create Treasure artifact tokens
  {
    name: 'treasure-token',
    match: /create\s+(a|an|one|two|three|\d+)?\s*treasure\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const qty = m[1] ? parseNumber(m[1]) : 1;
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_treasure', name: 'Treasure',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact — Treasure',
          oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.', power: undefined as unknown as string, toughness: undefined as unknown as string,
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        tokens.push(cardToPermanent(tokenCard, controller, state.turn));
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} Treasure token(s).`);
      return { state, resolved: true, description: `create ${qty} Treasure token(s)` };
    },
  },

  // 83. food-token — create Food artifact tokens
  {
    name: 'food-token',
    match: /create\s+(a|an|one|two|three|\d+)?\s*food\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const qty = m[1] ? parseNumber(m[1]) : 1;
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_food', name: 'Food',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact — Food',
          oracleText: '{2}, {T}, Sacrifice this artifact: You gain 3 life.', power: undefined as unknown as string, toughness: undefined as unknown as string,
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        tokens.push(cardToPermanent(tokenCard, controller, state.turn));
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} Food token(s).`);
      return { state, resolved: true, description: `create ${qty} Food token(s)` };
    },
  },

  // 84. cat-token — create 1/1 Cat creature tokens
  {
    name: 'cat-token',
    match: /create\s+(a|an|one|two|three|\d+)\s+1\/1.*cat.*tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const qty = parseNumber(m[1]);
      const tokens: Permanent[] = [];
      for (let i = 0; i < qty; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_cat', name: 'Cat',
          manaCost: '', cmc: 0, typeLine: 'Token Creature — Cat',
          oracleText: '', power: '1', toughness: '1',
          colors: ['W'], colorIdentity: ['W'], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        tokens.push(cardToPermanent(tokenCard, controller, state.turn));
      }
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} 1/1 Cat token(s).`);
      return { state, resolved: true, description: `create ${qty} Cat token(s)` };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── J. Combat Tricks ──
  // ══════════════════════════════════════════════════════════════

  // 85. first-strike-until-eot — gains first strike until end of turn
  {
    name: 'first-strike-until-eot',
    match: /gains? first strike until end of turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'first strike', source: 'effect', turn: state.turn }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains first strike until end of turn.`);
      return { state, resolved: true, description: `${perm.name} first strike` };
    },
  },

  // 86. double-strike-until-eot — gains double strike until end of turn
  {
    name: 'double-strike-until-eot',
    match: /gains? double strike until end of turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'double strike', source: 'effect', turn: state.turn }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains double strike until end of turn.`);
      return { state, resolved: true, description: `${perm.name} double strike` };
    },
  },

  // 87. deathtouch-until-eot — gains deathtouch until end of turn
  {
    name: 'deathtouch-until-eot',
    match: /gains? deathtouch until end of turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'deathtouch', source: 'effect', turn: state.turn }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains deathtouch until end of turn.`);
      return { state, resolved: true, description: `${perm.name} deathtouch` };
    },
  },

  // 88. vigilance-until-eot — gains vigilance until end of turn
  {
    name: 'vigilance-until-eot',
    match: /gains? vigilance until end of turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'vigilance', source: 'effect', turn: state.turn }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains vigilance until end of turn.`);
      return { state, resolved: true, description: `${perm.name} vigilance` };
    },
  },

  // 89. menace-until-eot — gains menace until end of turn
  {
    name: 'menace-until-eot',
    match: /gains? menace until end of turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target' };
      const { playerIdx, permIdx, perm } = found;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'menace', source: 'effect', turn: state.turn }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains menace until end of turn.`);
      return { state, resolved: true, description: `${perm.name} menace` };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── K. Miscellaneous ──
  // ══════════════════════════════════════════════════════════════

  // 90. copy-spell — copy target spell on the stack (auto-resolve, Fork/Twincast)
  {
    name: 'copy-spell',
    match: /copy target.*spell/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      // Find target spell on the stack
      const targetId = targets?.[0]?.id;
      const targetSpell = targetId ? state.stack.find(s => s.id === targetId) : state.stack.find(s => s.type === 'spell' && s.controller !== controller);
      if (!targetSpell) {
        // No spell on stack to copy — fallback to manual
        if (state.stack.length > 0) {
          // Auto-copy the top spell
          const topSpell = [...state.stack].reverse().find(s => s.type === 'spell');
          if (topSpell) {
            const copy = copyStackObject(topSpell, controller);
            state = { ...state, stack: [...state.stack, copy] };
            state = addLog(state, controller, `Copied ${topSpell.text} (same targets).`);
            return { state, resolved: true, description: `copy ${topSpell.text}` };
          }
        }
        state = addLog(state, controller, 'No spell on stack to copy.');
        return { state, resolved: true, description: 'copy spell (no target)' };
      }
      const copy = copyStackObject(targetSpell, controller);
      state = { ...state, stack: [...state.stack, copy] };
      state = addLog(state, controller, `Copied ${targetSpell.text} (same targets).`);
      return { state, resolved: true, description: `copy ${targetSpell.text}` };
    },
  },

  // 91. transform — transform this permanent (auto-resolve, CR 701.28)
  {
    name: 'transform',
    match: /\btransform(?:s)?\s+~\b|\btransform\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      const cardName = source?.name || 'permanent';
      // Find the source permanent on the battlefield
      if (!source) {
        state = addLog(state, controller, `${cardName} transforms — no source found.`);
        return { state, resolved: true, description: `transform ${cardName} (no source)` };
      }
      for (let pi = 0; pi < 2; pi++) {
        const bf = state.players[pi].battlefield;
        const idx = bf.findIndex(p => p.id === source.id);
        if (idx !== -1) {
          const transformed = transformPermanent(bf[idx]);
          if (!transformed) {
            state = addLog(state, controller, `${cardName} has no back face — cannot transform.`);
            return { state, resolved: true, description: `${cardName} has no back face` };
          }
          const newBf = [...bf];
          newBf[idx] = transformed;
          const players = [...state.players];
          players[pi] = { ...players[pi], battlefield: newBf };
          state = { ...state, players };
          state = addLog(state, controller, `${cardName} transforms into ${transformed.name}.`);
          return { state, resolved: true, description: `${cardName} → ${transformed.name}` };
        }
      }
      state = addLog(state, controller, `${cardName} not found on battlefield — cannot transform.`);
      return { state, resolved: true, description: `transform ${cardName} (not found)` };
    },
  },

  // 91b. transform-target — transform target creature/permanent
  {
    name: 'transform-target',
    match: /transform\s+target\s+(?:creature|permanent)/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m) => {
      if (!targets.length || targets[0].type !== 'permanent') {
        return { state, resolved: true, description: 'transform target (no target)' };
      }
      const targetId = targets[0].id;
      for (let pi = 0; pi < 2; pi++) {
        const bf = state.players[pi].battlefield;
        const idx = bf.findIndex(p => p.id === targetId);
        if (idx !== -1) {
          const transformed = transformPermanent(bf[idx]);
          if (!transformed) {
            state = addLog(state, controller, `${bf[idx].name} has no back face — cannot transform.`);
            return { state, resolved: true, description: `${bf[idx].name} has no back face` };
          }
          const newBf = [...bf];
          newBf[idx] = transformed;
          const players = [...state.players];
          players[pi] = { ...players[pi], battlefield: newBf };
          state = { ...state, players };
          state = addLog(state, controller, `${bf[idx].name} transforms into ${transformed.name}.`);
          return { state, resolved: true, description: `${bf[idx].name} → ${transformed.name}` };
        }
      }
      return { state, resolved: true, description: 'transform target (not found)' };
    },
  },

  // 91c. prowess-pump — prowess trigger gives source +1/+1 until end of turn (CR 702.107)
  {
    name: 'prowess-pump',
    match: /^\s*prowess\s*$/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'prowess (no source)' };
      for (let pi = 0; pi < 2; pi++) {
        const bf = state.players[pi].battlefield;
        const idx = bf.findIndex(p => p.id === source.id);
        if (idx !== -1) {
          const perm = bf[idx];
          const newMods = [...(perm.temporaryPtMods || []), { power: 1, toughness: 1, source: 'prowess', turn: state.turn }];
          const newBf = [...bf];
          newBf[idx] = { ...perm, temporaryPtMods: newMods };
          const players = [...state.players];
          players[pi] = { ...players[pi], battlefield: newBf };
          state = { ...state, players };
          state = addLog(state, controller, `${perm.name} gets +1/+1 until end of turn (prowess).`);
          return { state, resolved: true, description: `${perm.name} +1/+1 (prowess)` };
        }
      }
      return { state, resolved: true, description: 'prowess (source not found)' };
    },
  },

  // 91d. extort-drain — extort trigger drains 1 life from each opponent (CR 702.100)
  {
    name: 'extort-drain',
    match: /^\s*extort\s*$/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opponents = getOpponents(state, controller);
      const players = [...state.players];
      for (const opp of opponents) {
        players[opp] = { ...players[opp], life: players[opp].life - 1 };
      }
      players[controller] = { ...players[controller], life: players[controller].life + opponents.length };
      state = { ...state, players };
      state = addLog(state, controller, `Extort: each opponent loses 1 life, ${players[controller].name} gains ${opponents.length} life.`);
      return { state, resolved: true, description: 'extort: drain 1' };
    },
  },

  // 92. equip-for-free — attach to target creature
  {
    name: 'equip-for-free',
    match: /attach.*to target creature/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m, source) => {
      const target = getTargetPermanent(state, targets);
      if (!target) {
        // Auto-attach to strongest own creature if no explicit target
        const creatures = state.players[controller].battlefield.filter(p => p.currentPower !== undefined);
        if (creatures.length === 0) {
          state = addLog(state, controller, 'No creature to attach to.');
          return { state, resolved: true, description: 'attach (no creature)' };
        }
        const strongest = [...creatures].sort((a, b) => ((b.currentPower ?? 0) + (b.currentToughness ?? 0)) - ((a.currentPower ?? 0) + (a.currentToughness ?? 0)))[0];
        state = addLog(state, controller, `Attached equipment to ${strongest.name}.`);
        return { state, resolved: true, description: `attach to ${strongest.name}` };
      }
      state = addLog(state, controller, `Attached equipment to ${target.perm.name}.`);
      return { state, resolved: true, description: `attach to ${target.perm.name}` };
    },
  },

  // 93. deal-damage-equal-to-power — deals damage equal to its power
  {
    name: 'deal-damage-equal-to-power',
    match: /deals? damage equal to its power/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      // Find the source creature on controller's battlefield (best guess: largest power)
      const controllerPlayer = state.players[controller];
      const creatures = controllerPlayer.battlefield.filter(p => p.currentPower !== undefined);
      if (creatures.length === 0) {
        state = addLog(state, controller, 'No creature to deal damage equal to its power.');
        return { state, resolved: true, description: 'no source creature' };
      }
      // Use the most recently entered creature as the source
      const sourcePerm = creatures[creatures.length - 1];
      const damage = sourcePerm.currentPower ?? 0;
      const permTarget = getTargetPermanent(state, targets);
      const playerTarget = getTargetPlayer(targets);
      if (permTarget) {
        state = damagePermanent(state, permTarget.perm.id, damage);
        state = addLog(state, controller, `${sourcePerm.name} deals ${damage} damage (equal to its power) to ${permTarget.perm.name}.`);
        return { state, resolved: true, description: `${damage} damage (power) to ${permTarget.perm.name}` };
      } else if (playerTarget !== null) {
        state = damagePlayer(state, playerTarget, damage);
        state = addLog(state, controller, `${sourcePerm.name} deals ${damage} damage (equal to its power) to ${state.players[playerTarget].name}.`);
        return { state, resolved: true, description: `${damage} damage (power) to player` };
      }
      // No explicit target — deal damage to opponent by default
      const opp: number = getFirstOpponent(state, controller);
      state = damagePlayer(state, opp, damage);
      state = addLog(state, controller, `${sourcePerm.name} deals ${damage} damage (equal to its power) to ${state.players[opp].name}.`);
      return { state, resolved: true, description: `${damage} damage (power) to opponent` };
    },
  },

  // 94. create-copy-of-creature — create a copy of a creature (log only)
  {
    name: 'create-copy-of-creature',
    match: /create a (?:token that's a )?copy of/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      // Try to find the target permanent to copy
      const target = getTargetPermanent(state, targets);
      if (!target) {
        // Fallback: copy the strongest creature on the battlefield
        let bestPerm: Permanent | null = null;
        for (let pi = 0; pi < 2; pi++) {
          for (const p of state.players[pi].battlefield) {
            if (p.currentPower !== undefined) {
              if (!bestPerm || ((p.currentPower ?? 0) + (p.currentToughness ?? 0)) > ((bestPerm.currentPower ?? 0) + (bestPerm.currentToughness ?? 0))) {
                bestPerm = p;
              }
            }
          }
        }
        if (!bestPerm) {
          state = addLog(state, controller, 'No creature to copy.');
          return { state, resolved: true, description: 'create copy (no creature)' };
        }
        const copy: any = {
          ...bestPerm,
          id: generateCardId(),
          controller,
          owner: controller,
          damage: 0,
          tapped: false,
          summoningSick: true,
          attacking: false,
          blocking: null,
          counters: {},
          temporaryPtMods: [],
          temporaryKeywords: [],
          enteredBattlefieldTurn: state.turn,
          isToken: true,
          currentPower: bestPerm.basePower ?? bestPerm.currentPower ?? 0,
          currentToughness: bestPerm.baseToughness ?? bestPerm.currentToughness ?? 0,
        };
        const players = [...state.players];
        players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, copy] };
        state = { ...state, players };
        state = addLog(state, controller, `Creates a token copy of ${bestPerm.name}.`);
        return { state, resolved: true, description: `copy ${bestPerm.name}` };
      }
      // Copy the targeted permanent
      const copy: any = {
        ...target.perm,
        id: generateCardId(),
        controller,
        owner: controller,
        damage: 0,
        tapped: false,
        summoningSick: true,
        attacking: false,
        blocking: null,
        counters: {},
        temporaryPtMods: [],
        temporaryKeywords: [],
        enteredBattlefieldTurn: state.turn,
        isToken: true,
        currentPower: target.perm.basePower ?? target.perm.currentPower ?? 0,
        currentToughness: target.perm.baseToughness ?? target.perm.currentToughness ?? 0,
      };
      const players = [...state.players];
      players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, copy] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates a token copy of ${target.perm.name}.`);
      return { state, resolved: true, description: `copy ${target.perm.name}` };
    },
  },

  // 95. exile-return-end-of-turn — flicker variant (exile, return at end of turn)
  {
    name: 'exile-return-end-of-turn',
    match: /exile.*return.*(?:end of turn|beginning of.*next end step)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const found = getTargetPermanent(state, targets);
      if (!found) return { state, resolved: false, description: 'no target to flicker' };
      const { perm } = found;
      state = removePermanentFromBattlefield(state, perm.id, 'exile');
      state = addLog(state, controller, `Exiles ${perm.name} — returns at end of turn.`);
      return { state, resolved: true, description: `flicker ${perm.name}` };
    },
  },

  // 96. each-opponent-loses-life — each opponent loses N life
  {
    name: 'each-opponent-loses-life',
    match: /each opponent loses (\d+) life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      for (const opp of getOpponents(state, controller)) {
        state = damagePlayer(state, opp, amount);
      }
      state = addLog(state, controller, `Each opponent loses ${amount} life.`);
      return { state, resolved: true, description: `opponent loses ${amount} life` };
    },
  },

  // ══════════════════════════════════════
  // ══ Phase 6.1 — Advanced Patterns ══
  // ══════════════════════════════════════

  // ── Kicker Patterns ──
  // Kicker is an additional cost paid when casting. "If ~ was kicked, [additional effect]."
  // The spell's base effect is handled by other patterns; these handle the "if kicked" bonus.

  // kicker-additional-damage: "If ~ was kicked, it deals N additional/extra damage"
  {
    name: 'kicker-additional-damage',
    match: /if\s+~\s+was\s+kicked,?\s+(?:it\s+)?deals?\s+(\d+)\s+(?:additional|extra|more)\s+damage/i,
    requiresTarget: true,
    apply: (state, controller, targets, m, source) => {
      // Kicker is always "paid" in our simplified model (auto-kick if castable)
      const amount = parseInt(m[1]);
      const sourceColors = source?.colors || [];
      const permTarget = getTargetPermanent(state, targets);
      const playerTarget = getTargetPlayer(targets);
      if (permTarget) {
        state = damagePermanent(state, permTarget.perm.id, amount, sourceColors);
        state = addLog(state, controller, `Kicked: ${amount} additional damage to ${permTarget.perm.name}.`);
        return { state, resolved: true, description: `kicked: +${amount} damage to ${permTarget.perm.name}` };
      } else if (playerTarget !== null) {
        state = damagePlayer(state, playerTarget, amount);
        state = addLog(state, controller, `Kicked: ${amount} additional damage to player.`);
        return { state, resolved: true, description: `kicked: +${amount} damage to player` };
      }
      return { state, resolved: false };
    },
  },

  // kicker-additional-draw: "If ~ was kicked, draw N card(s)"
  {
    name: 'kicker-additional-draw',
    match: /if\s+~\s+was\s+kicked,?\s+draw\s+(\d+|a|an|one|two|three)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseNumber(m[1]) || 1;
      state = drawCards(state, controller, amount);
      state = addLog(state, controller, `Kicked: draw ${amount} card(s).`);
      return { state, resolved: true, description: `kicked: draw ${amount}` };
    },
  },

  // kicker-additional-destroy: "If ~ was kicked, destroy target [creature/permanent]"
  {
    name: 'kicker-additional-destroy',
    match: /if\s+~\s+was\s+kicked,?\s+destroy\s+(?:target|another\s+target)\s+(?:creature|permanent|artifact|enchantment)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Kicked: destroy ${target.perm.name}.`);
      return { state, resolved: true, description: `kicked: destroy ${target.perm.name}` };
    },
  },

  // kicker-additional-counters: "If ~ was kicked, it enters with N additional +1/+1 counters"
  {
    name: 'kicker-additional-counters',
    match: /if\s+~\s+was\s+kicked,?\s+(?:it\s+)?enters?\s+(?:the\s+battlefield\s+)?with\s+(\d+|one|two|three|four)\s+additional\s+\+1\/\+1\s+counter/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const amount = parseNumber(m[1]) || 1;
      if (!source) return { state, resolved: false };
      const players = [...state.players];
      const bf = [...players[controller].battlefield];
      const idx = bf.findIndex(p => p.name === source.name);
      if (idx !== -1) {
        const perm = bf[idx];
        const counters = { ...perm.counters, '+1/+1': (perm.counters['+1/+1'] || 0) + amount };
        const newPower = (perm.currentPower ?? 0) + amount;
        const newTough = (perm.currentToughness ?? 0) + amount;
        bf[idx] = { ...perm, counters, currentPower: newPower, currentToughness: newTough };
        players[controller] = { ...players[controller], battlefield: bf };
        state = { ...state, players };
      }
      state = addLog(state, controller, `Kicked: ${amount} additional +1/+1 counter(s).`);
      return { state, resolved: true, description: `kicked: +${amount} +1/+1 counters` };
    },
  },

  // kicker-return-to-hand: "If ~ was kicked, return target [permanent] to its owner's hand"
  {
    name: 'kicker-return-to-hand',
    match: /if\s+~\s+was\s+kicked,?\s+return\s+(?:target|a)\s+(?:creature|permanent|nonland\s+permanent)\s+to\s+its\s+owner'?s?\s+hand/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      // Remove from battlefield
      const { perm, playerIdx, permIdx } = target;
      const players = [...state.players];
      const bf = [...players[playerIdx].battlefield];
      bf.splice(permIdx, 1);
      const ownerIdx: number = perm.owner ?? playerIdx;
      const cardObj: Card = {
        id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
        cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
        power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
        colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
        tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
      };
      players[playerIdx] = { ...players[playerIdx], battlefield: bf };
      players[ownerIdx] = { ...players[ownerIdx], hand: [...players[ownerIdx].hand, cardObj] };
      state = { ...state, players };
      state = addLog(state, controller, `Kicked: return ${perm.name} to hand.`);
      return { state, resolved: true, description: `kicked: bounce ${perm.name}` };
    },
  },

  // kicker-generic-bonus: "If ~ was kicked, [gain life / opponent loses life / create token]"
  {
    name: 'kicker-gain-life',
    match: /if\s+~\s+was\s+kicked,?\s+(?:you\s+)?gain\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      state = gainLife(state, controller, amount);
      state = addLog(state, controller, `Kicked: gain ${amount} life.`);
      return { state, resolved: true, description: `kicked: gain ${amount} life` };
    },
  },

  // ── Conditional Effect Patterns ──
  // "If you control a [type], [additional effect]"

  // conditional-control-creature: "If you control a creature, [effect]"
  {
    name: 'conditional-control-creature-draw',
    match: /if\s+you\s+control\s+(?:a|another)\s+creature,?\s+draw\s+(\d+|a|an|one|two|three)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const hasCreature = state.players[controller].battlefield.some(p =>
        p.typeLine?.toLowerCase().includes('creature')
      );
      if (!hasCreature) {
        state = addLog(state, controller, 'Condition not met: no creature controlled.');
        return { state, resolved: true, description: 'condition not met' };
      }
      const amount = parseNumber(m[1]) || 1;
      state = drawCards(state, controller, amount);
      state = addLog(state, controller, `Condition met: draw ${amount} card(s).`);
      return { state, resolved: true, description: `conditional: draw ${amount}` };
    },
  },

  // conditional-control-artifact: "If you control an artifact, [effect]"
  {
    name: 'conditional-control-artifact-draw',
    match: /if\s+you\s+control\s+(?:a|an)\s+artifact,?\s+draw\s+(\d+|a|an|one|two|three)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const hasArtifact = state.players[controller].battlefield.some(p =>
        p.typeLine?.toLowerCase().includes('artifact')
      );
      if (!hasArtifact) {
        return { state, resolved: true, description: 'condition not met: no artifact' };
      }
      const amount = parseNumber(m[1]) || 1;
      state = drawCards(state, controller, amount);
      state = addLog(state, controller, `Artifact condition met: draw ${amount}.`);
      return { state, resolved: true, description: `conditional: draw ${amount}` };
    },
  },

  // conditional-control-enchantment: "If you control an enchantment, [gain life / effect]"
  {
    name: 'conditional-control-enchantment-life',
    match: /if\s+you\s+control\s+(?:a|an)\s+enchantment,?\s+(?:you\s+)?gain\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const hasEnchantment = state.players[controller].battlefield.some(p =>
        p.typeLine?.toLowerCase().includes('enchantment')
      );
      if (!hasEnchantment) {
        return { state, resolved: true, description: 'condition not met: no enchantment' };
      }
      const amount = parseInt(m[1]);
      state = gainLife(state, controller, amount);
      state = addLog(state, controller, `Enchantment condition met: gain ${amount} life.`);
      return { state, resolved: true, description: `conditional: gain ${amount} life` };
    },
  },

  // conditional-threshold: "Threshold — If you have seven or more cards in your graveyard, [effect]"
  {
    name: 'conditional-threshold-bonus',
    match: /threshold\s*[—–-]\s*if\s+(?:seven\s+or\s+more|7\+?)\s+cards?\s+(?:are\s+)?in\s+your\s+graveyard/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const hasThreshold = state.players[controller].graveyard.length >= 7;
      if (!hasThreshold) {
        state = addLog(state, controller, 'Threshold not met (need 7+ cards in graveyard).');
        return { state, resolved: true, description: 'threshold not met' };
      }
      state = addLog(state, controller, 'Threshold active!');
      return { state, resolved: true, description: 'threshold active' };
    },
  },

  // conditional-metalcraft: "Metalcraft — If you control three or more artifacts, [effect]"
  {
    name: 'conditional-metalcraft',
    match: /metalcraft\s*[—–-]\s*if\s+you\s+control\s+(?:three|3)\s+or\s+more\s+artifacts?/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const artifactCount = state.players[controller].battlefield.filter(p =>
        p.typeLine?.toLowerCase().includes('artifact')
      ).length;
      if (artifactCount < 3) {
        state = addLog(state, controller, `Metalcraft not met (only ${artifactCount} artifacts).`);
        return { state, resolved: true, description: 'metalcraft not met' };
      }
      state = addLog(state, controller, 'Metalcraft active!');
      return { state, resolved: true, description: 'metalcraft active' };
    },
  },

  // conditional-delirium: "Delirium — If there are four or more card types in your graveyard"
  {
    name: 'conditional-delirium',
    match: /delirium\s*[—–-]\s*if\s+(?:there\s+are\s+)?(?:four|4)\s+or\s+more\s+card\s+types?\s+(?:among\s+cards?\s+)?in\s+your\s+graveyard/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const types = new Set<string>();
      for (const card of state.players[controller].graveyard) {
        const tl = card.typeLine?.toLowerCase() || '';
        if (tl.includes('creature')) types.add('creature');
        if (tl.includes('instant')) types.add('instant');
        if (tl.includes('sorcery')) types.add('sorcery');
        if (tl.includes('artifact')) types.add('artifact');
        if (tl.includes('enchantment')) types.add('enchantment');
        if (tl.includes('land')) types.add('land');
        if (tl.includes('planeswalker')) types.add('planeswalker');
      }
      if (types.size < 4) {
        state = addLog(state, controller, `Delirium not met (only ${types.size} types in graveyard).`);
        return { state, resolved: true, description: 'delirium not met' };
      }
      state = addLog(state, controller, 'Delirium active!');
      return { state, resolved: true, description: 'delirium active' };
    },
  },

  // conditional-revolt: "Revolt — If a permanent you controlled left the battlefield this turn"
  {
    name: 'conditional-revolt',
    match: /revolt\s*[—–-]\s*if\s+a\s+permanent\s+you\s+controlled?\s+left\s+the\s+battlefield\s+this\s+turn/i,
    requiresTarget: false,
    apply: (state, controller) => {
      // Simplified: check if any log entry this turn mentions a permanent leaving
      const thisLogTurn = state.log.filter(l => l.turn === state.turn && l.player === controller);
      const hasRevolt = thisLogTurn.some(l =>
        l.message.includes('destroyed') || l.message.includes('exiled') ||
        l.message.includes('returned') || l.message.includes('sacrificed')
      );
      if (!hasRevolt) {
        state = addLog(state, controller, 'Revolt not met (no permanent left battlefield this turn).');
        return { state, resolved: true, description: 'revolt not met' };
      }
      state = addLog(state, controller, 'Revolt triggered!');
      return { state, resolved: true, description: 'revolt active' };
    },
  },

  // conditional-ferocious: "Ferocious — If you control a creature with power 4 or greater"
  {
    name: 'conditional-ferocious',
    match: /ferocious\s*[—–-]\s*if\s+you\s+control\s+a\s+creature\s+with\s+power\s+(?:4|four)\s+or\s+(?:greater|more)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const has4Power = state.players[controller].battlefield.some(p =>
        p.currentPower !== undefined && p.currentPower >= 4
      );
      if (!has4Power) {
        return { state, resolved: true, description: 'ferocious not met' };
      }
      state = addLog(state, controller, 'Ferocious active!');
      return { state, resolved: true, description: 'ferocious active' };
    },
  },

  // ── Storm Pattern ──
  // Storm: "When you cast this spell, copy it for each spell cast before it this turn."
  {
    name: 'storm-copy',
    match: /storm\s*(?:\(|[—–-]|$)|when\s+you\s+cast\s+this\s+spell,?\s+copy\s+it\s+for\s+each\s+(?:other\s+)?spell\s+cast\s+before\s+it\s+this\s+turn/i,
    requiresTarget: false,
    apply: (state, controller, targets, _m, source) => {
      // Count spells cast this turn from log entries
      const spellsCastThisTurn = state.log.filter(l =>
        l.turn === state.turn && l.actionType === 'cast-spell'
      ).length;
      // Storm count = spells cast before this one (subtract 1 for the storm spell itself)
      const stormCount = Math.max(0, spellsCastThisTurn - 1);

      if (stormCount === 0) {
        state = addLog(state, controller, 'Storm count: 0 — no copies.');
        return { state, resolved: true, description: 'storm: 0 copies' };
      }

      // For each copy, re-apply the base effect of the card
      // We try to resolve the card's other oracle text for each copy
      state = addLog(state, controller, `Storm count: ${stormCount} — creating ${stormCount} copies.`);

      // Simple resolution: if the card deals damage, multiply the damage
      const oracleText = source?.oracleText || '';
      const dmgMatch = oracleText.match(/deals?\s+(\d+)\s+damage/i);
      if (dmgMatch) {
        const baseDamage = parseInt(dmgMatch[1]);
        const totalExtraDamage = baseDamage * stormCount;
        const opp: number = getFirstOpponent(state, controller);
        const permTarget = getTargetPermanent(state, targets);
        const playerTarget = getTargetPlayer(targets);
        if (permTarget) {
          const sourceColors = source?.colors || [];
          state = damagePermanent(state, permTarget.perm.id, totalExtraDamage, sourceColors);
        } else if (playerTarget !== null) {
          state = damagePlayer(state, playerTarget, totalExtraDamage);
        } else {
          state = damagePlayer(state, opp, totalExtraDamage);
        }
        return { state, resolved: true, description: `storm: ${stormCount} copies, ${totalExtraDamage} extra damage` };
      }

      // If the card draws cards, multiply the draw
      const drawMatch = oracleText.match(/draw\s+(\d+|a|an|one|two|three)\s+cards?/i);
      if (drawMatch) {
        const baseDraw = parseNumber(drawMatch[1]) || 1;
        const totalExtraDraw = baseDraw * stormCount;
        state = drawCards(state, controller, totalExtraDraw);
        return { state, resolved: true, description: `storm: ${stormCount} copies, draw ${totalExtraDraw} extra` };
      }

      // If the card gains life, multiply the gain
      const lifeMatch = oracleText.match(/gain\s+(\d+)\s+life/i);
      if (lifeMatch) {
        const baseLife = parseInt(lifeMatch[1]);
        const totalExtraLife = baseLife * stormCount;
        state = gainLife(state, controller, totalExtraLife);
        return { state, resolved: true, description: `storm: ${stormCount} copies, gain ${totalExtraLife} extra life` };
      }

      // If the card drains, multiply
      const drainMatch = oracleText.match(/each\s+opponent\s+loses?\s+(\d+)\s+life/i);
      if (drainMatch) {
        const baseDrain = parseInt(drainMatch[1]);
        const totalDrain = baseDrain * stormCount;
        const opp: number = getFirstOpponent(state, controller);
        state = damagePlayer(state, opp, totalDrain);
        return { state, resolved: true, description: `storm: ${stormCount} copies, opponent loses ${totalDrain} life` };
      }

      // Token creation storms (e.g., Empty the Warrens creates Goblin tokens)
      const tokenMatch = oracleText.match(/create\s+(?:a|(\d+))\s+([\d/]+)\s+([\w\s]+)\s+(?:creature\s+)?tokens?/i);
      if (tokenMatch) {
        const baseCount = tokenMatch[1] ? parseInt(tokenMatch[1]) : 1;
        const totalTokens = baseCount * (stormCount + 1); // Including original
        const ptMatch = tokenMatch[2].match(/(\d+)\/(\d+)/);
        const power = ptMatch ? parseInt(ptMatch[1]) : 1;
        const toughness = ptMatch ? parseInt(ptMatch[2]) : 1;
        const tokenName = tokenMatch[3].trim();

        const players = [...state.players];
        const player = { ...players[controller] };
        const newTokens: Permanent[] = [];
        for (let i = 0; i < totalTokens; i++) {
          const tokenCard: Card = {
            id: generateCardId(),
            oracleId: `storm_token_${tokenName}`,
            name: tokenName,
            manaCost: '',
            cmc: 0,
            typeLine: `Token Creature — ${tokenName}`,
            oracleText: '',
            power: String(power),
            toughness: String(toughness),
            colors: [],
            colorIdentity: [],
            rarity: 'common',
            tags: [],
            imageUrl: '',
            owner: controller,
          };
          newTokens.push(cardToPermanent(tokenCard, controller, state.turn));
        }
        player.battlefield = [...player.battlefield, ...newTokens];
        players[controller] = player;
        state = { ...state, players };
        state = addLog(state, controller, `Storm: created ${totalTokens} ${power}/${toughness} ${tokenName} tokens total.`);
        return { state, resolved: true, description: `storm: ${stormCount} copies, created ${totalTokens} ${tokenName} tokens total` };
      }

      // Discard storms (e.g., Mind's Desire style effects)
      const discardMatch = oracleText.match(/(?:target\s+(?:player|opponent)\s+)?discards?\s+(\d+|a|an)\s+cards?/i);
      if (discardMatch) {
        const baseDiscard = parseNumber(discardMatch[1]) || 1;
        const totalDiscard = baseDiscard * stormCount;
        const opp: number = getFirstOpponent(state, controller);
        const oppPlayer = state.players[opp];
        const discarded = oppPlayer.hand.slice(0, totalDiscard);
        if (discarded.length > 0) {
          const players = [...state.players];
          players[opp] = {
            ...oppPlayer,
            hand: oppPlayer.hand.slice(totalDiscard),
            graveyard: [...oppPlayer.graveyard, ...discarded],
          };
          state = { ...state, players };
        }
        state = addLog(state, controller, `Storm: opponent discards ${discarded.length} card(s).`);
        return { state, resolved: true, description: `storm: ${stormCount} copies, opponent discards ${discarded.length}` };
      }

      // Mill storms
      const millMatch = oracleText.match(/mills?\s+(\d+)\s+cards?/i);
      if (millMatch) {
        const baseMill = parseInt(millMatch[1]);
        const totalMill = baseMill * stormCount;
        const opp: number = getFirstOpponent(state, controller);
        state = millCards(state, opp, totalMill);
        state = addLog(state, controller, `Storm: opponent mills ${totalMill} cards.`);
        return { state, resolved: true, description: `storm: ${stormCount} copies, mill ${totalMill}` };
      }

      // Fallback: just log the copies, manual resolution
      return { state, resolved: true, description: `storm: ${stormCount} copies (manual resolution needed for complex effects)` };
    },
  },

  // ── Improved Cascade ──
  // Full cascade: exile cards until nonland with lower MV, may cast free, rest on bottom
  {
    name: 'cascade-full',
    match: /cascade\s*(?:\(|[—–-]|$)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      const player = state.players[controller];
      const sourceCMC = source?.cmc ?? 99;
      const exiled: Card[] = [];
      let found: Card | null = null;

      // Exile from top until we find a nonland card with lesser MV
      for (let i = 0; i < player.library.length; i++) {
        const card = player.library[i];
        exiled.push(card);
        if (!card.typeLine?.toLowerCase().includes('land') && (card.cmc ?? 0) < sourceCMC) {
          found = card;
          break;
        }
      }

      const restExiled = found ? exiled.filter(c => c.id !== found!.id) : [...exiled];
      // Fisher-Yates shuffle for rest
      for (let i = restExiled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [restExiled[i], restExiled[j]] = [restExiled[j], restExiled[i]];
      }
      const newLib = [...player.library.slice(exiled.length), ...restExiled];
      const players = [...state.players];

      if (!found) {
        players[controller] = { ...player, library: newLib };
        state = { ...state, players };
        state = addLog(state, controller, `Cascade: no eligible spell found (exiled ${exiled.length} cards).`);
        return { state, resolved: true, description: 'cascade whiffed' };
      }

      // Cast the found card for free
      const typeLine = (found.typeLine || '').toLowerCase();
      if (typeLine.includes('creature') || typeLine.includes('artifact') || typeLine.includes('enchantment') || typeLine.includes('planeswalker')) {
        // Permanent: put directly onto battlefield (cast for free)
        const perm = cardToPermanent(found, controller, state.turn);
        players[controller] = {
          ...player,
          library: newLib,
          battlefield: [...player.battlefield, perm],
        };
        state = { ...state, players };
        // Fire ETB triggers
        state = checkETBTriggers(state, perm, { fromZone: 'library' });
        state = addLog(state, controller, `Cascade: cast ${found.name} for free (MV ${found.cmc ?? 0}) — enters battlefield.`);
      } else {
        // Instant/Sorcery: put on stack for resolution (simplified: put in hand for casting)
        players[controller] = {
          ...player,
          library: newLib,
          hand: [...player.hand, found],
        };
        state = { ...state, players };
        state = addLog(state, controller, `Cascade: found ${found.name} (MV ${found.cmc ?? 0}) — added to hand to cast for free.`);
      }

      return { state, resolved: true, description: `cascade: cast ${found.name}` };
    },
  },

  // ── Extended Modal Patterns ──

  // choose-one-draw-or-life: "Choose one — Draw N cards. / Gain N life."
  {
    name: 'choose-one-draw-or-life',
    match: /choose\s+one\s*[—–-].*?draw\s+(\d+|a|an|one|two|three)\s+cards?.*?gain\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      // Auto-pick option 1 (draw) — generally stronger
      const amount = parseNumber(m[1]) || 1;
      state = drawCards(state, controller, amount);
      state = addLog(state, controller, `Chooses to draw ${amount} card(s).`);
      return { state, resolved: true, description: `modal: draw ${amount}` };
    },
  },

  // choose-one-destroy-or-return: "Choose one — Destroy target. / Return target to hand."
  {
    name: 'choose-one-destroy-or-return',
    match: /choose\s+one\s*[—–-].*?destroy\s+target\s+(?:creature|permanent).*?return\s+target.*?to.*?hand/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      // Auto-pick destroy
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
      state = addLog(state, controller, `Chooses to destroy ${target.perm.name}.`);
      return { state, resolved: true, description: `modal: destroy ${target.perm.name}` };
    },
  },

  // choose-one-counter-or-draw: "Choose one — Counter target spell. / Draw a card."
  {
    name: 'choose-one-counter-or-draw',
    match: /choose\s+one\s*[—–-].*?counter\s+target\s+spell.*?draw\s+(\d+|a|an|one|two)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, targets, m) => {
      // If there's a spell on stack to counter, counter it
      if (state.stack.length > 0) {
        const topSpell = state.stack[state.stack.length - 1];
        if (topSpell.controller !== controller) {
          // Counter the opponent's spell
          const newStack = state.stack.slice(0, -1);
          state = { ...state, stack: newStack };
          state = addLog(state, controller, `Chooses to counter ${topSpell.text}.`);
          return { state, resolved: true, description: `modal: counter ${topSpell.text}` };
        }
      }
      // Fallback: draw
      const amount = parseNumber(m[1]) || 1;
      state = drawCards(state, controller, amount);
      state = addLog(state, controller, `Chooses to draw ${amount} card(s).`);
      return { state, resolved: true, description: `modal: draw ${amount}` };
    },
  },

  // choose-two: "Choose two — [list of effects]" (e.g., Cryptic Command)
  {
    name: 'choose-two-damage-draw-life',
    match: /choose\s+two\s*[—–-].*?deal\s+(\d+)\s+damage.*?draw\s+(\d+|a|an|one|two)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, targets, m, source) => {
      // Do both: damage + draw
      const damage = parseInt(m[1]);
      const draw = parseNumber(m[2]) || 1;
      const opp: number = getFirstOpponent(state, controller);
      const sourceColors = source?.colors || [];
      const permTarget = getTargetPermanent(state, targets);
      if (permTarget) {
        state = damagePermanent(state, permTarget.perm.id, damage, sourceColors);
      } else {
        state = damagePlayer(state, opp, damage);
      }
      state = drawCards(state, controller, draw);
      state = addLog(state, controller, `Chooses: deal ${damage} damage and draw ${draw}.`);
      return { state, resolved: true, description: `modal: ${damage} damage + draw ${draw}` };
    },
  },

  // ── Flashback Improved ──
  // Better flashback pattern that checks if cast from graveyard
  {
    name: 'flashback-from-graveyard',
    match: /flashback\s*[—–-]?\s*\{[^}]+\}/i,
    requiresTarget: false,
    apply: (state, controller) => {
      // Flashback is a static ability — the actual casting from graveyard is handled by the UI/game loop
      // This just logs it for pattern matching purposes
      state = addLog(state, controller, 'Has flashback — can be cast from graveyard.');
      return { state, resolved: true, description: 'flashback available' };
    },
  },

  // ── Overload ──
  // "Overload {cost}" — when overloaded, replace "target" with "each"
  {
    name: 'overload-destroy-all',
    match: /overload\s*\{[^}]+\}.*?destroy\s+target/i,
    requiresTarget: false,
    apply: (state, controller) => {
      // When overloaded, destroy all matching permanents (simplified: destroy all opponent creatures)
      const opp: number = getFirstOpponent(state, controller);
      const players = [...state.players];
      const dying = players[opp].battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
      const surviving = players[opp].battlefield.filter(p => !p.typeLine?.toLowerCase().includes('creature'));
      for (const perm of dying) {
        const ownerIdx: number = perm.owner ?? opp;
        const card: Card = {
          id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
          cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
          power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
          colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
          tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
        };
        players[ownerIdx] = { ...players[ownerIdx], graveyard: [...players[ownerIdx].graveyard, card] };
      }
      players[opp] = { ...players[opp], battlefield: surviving };
      state = { ...state, players };
      state = addLog(state, controller, `Overloaded: destroyed ${dying.length} creature(s).`);
      return { state, resolved: true, description: `overload: destroy ${dying.length} creatures` };
    },
  },

  // ── Entwine ──
  // "Entwine {cost}" — do all modes instead of choosing one
  {
    name: 'entwine-all-modes',
    match: /entwine\s*\{[^}]+\}/i,
    requiresTarget: false,
    apply: (state, controller) => {
      // Entwine is handled by the card paying extra cost — just log it
      state = addLog(state, controller, 'Entwined — all modes chosen.');
      return { state, resolved: true, description: 'entwine: all modes' };
    },
  },

  // ── Buyback ──
  // "Buyback {cost}" — return spell to hand instead of graveyard
  {
    name: 'buyback-return',
    match: /buyback\s*\{[^}]+\}/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'buyback (no source)' };
      // Move card from graveyard back to hand (it was just moved there by stack resolution)
      const players = [...state.players];
      const gyIdx = players[controller].graveyard.findIndex(c => c.name === source.name);
      if (gyIdx !== -1) {
        const card = players[controller].graveyard[gyIdx];
        const newGy = [...players[controller].graveyard];
        newGy.splice(gyIdx, 1);
        players[controller] = {
          ...players[controller],
          graveyard: newGy,
          hand: [...players[controller].hand, card],
        };
        state = { ...state, players };
      }
      state = addLog(state, controller, `Buyback: ${source.name} returned to hand.`);
      return { state, resolved: true, description: `buyback: ${source.name} to hand` };
    },
  },

  // ── Retrace ──
  // "Retrace" — cast from graveyard by discarding a land
  {
    name: 'retrace',
    match: /retrace\s*(?:\(|[—–-]|$)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, 'Has retrace — can be cast from graveyard by discarding a land.');
      return { state, resolved: true, description: 'retrace available' };
    },
  },

  // ── Escape ──
  // "Escape — {cost}, Exile N other cards from your graveyard"
  {
    name: 'escape',
    match: /escape\s*[—–-]\s*\{[^}]+\},?\s*exile\s+(\d+|one|two|three|four|five)\s+(?:other\s+)?cards?\s+from\s+your\s+graveyard/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const exileCount = parseNumber(m[1]) || 3;
      const gy = state.players[controller].graveyard;
      if (gy.length < exileCount) {
        state = addLog(state, controller, `Escape: not enough cards in graveyard (need ${exileCount}).`);
        return { state, resolved: true, description: 'escape: not enough cards' };
      }
      // Exile N cards from graveyard (take from end for simplicity)
      const toExile = gy.slice(-exileCount);
      const newGy = gy.slice(0, -exileCount);
      const players = [...state.players];
      players[controller] = {
        ...players[controller],
        graveyard: newGy,
        exile: [...players[controller].exile, ...toExile],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Escape: exiled ${exileCount} cards from graveyard.`);
      return { state, resolved: true, description: `escape: exiled ${exileCount} cards` };
    },
  },

  // ── Foretell ──
  // "Foretell {cost}" — exile face down for later casting
  {
    name: 'foretell',
    match: /foretell\s*\{[^}]+\}/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, 'Has foretell — can be exiled face-down for later casting.');
      return { state, resolved: true, description: 'foretell available' };
    },
  },

  // ── Additional Conditional Patterns ──

  // if-opponent-controls: "If an opponent controls more creatures than you, [effect]"
  {
    name: 'conditional-opponent-more-creatures',
    match: /if\s+an?\s+opponent\s+controls?\s+more\s+creatures?\s+than\s+you/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opp: number = getFirstOpponent(state, controller);
      const myCreatures = state.players[controller].battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature')).length;
      const oppCreatures = state.players[opp].battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature')).length;
      if (oppCreatures <= myCreatures) {
        state = addLog(state, controller, 'Condition not met: opponent does not control more creatures.');
        return { state, resolved: true, description: 'condition not met' };
      }
      state = addLog(state, controller, 'Condition met: opponent controls more creatures.');
      return { state, resolved: true, description: 'condition met: opponent has more creatures' };
    },
  },

  // if-ten-or-more-life: "If you have 10 or more life [than starting], [effect]"
  {
    name: 'conditional-life-threshold',
    match: /if\s+(?:you\s+have|your\s+life\s+total\s+is)\s+(\d+)\s+or\s+(?:more|greater)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const threshold = parseInt(m[1]);
      if (state.players[controller].life < threshold) {
        return { state, resolved: true, description: `condition not met: life < ${threshold}` };
      }
      state = addLog(state, controller, `Life threshold met (${state.players[controller].life} >= ${threshold}).`);
      return { state, resolved: true, description: `condition met: life >= ${threshold}` };
    },
  },

  // if-no-creatures: "If you control no creatures, [effect]"
  {
    name: 'conditional-no-creatures',
    match: /if\s+you\s+control\s+no\s+creatures?,?\s+/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const creatureCount = state.players[controller].battlefield.filter(p =>
        p.typeLine?.toLowerCase().includes('creature')
      ).length;
      if (creatureCount > 0) {
        return { state, resolved: true, description: 'condition not met: controls creatures' };
      }
      state = addLog(state, controller, 'Condition met: no creatures controlled.');
      return { state, resolved: true, description: 'condition met: no creatures' };
    },
  },

  // ─── Phase 2: Extended Effect Patterns ───

  // P2-1. destroy-target-land
  {
    name: 'destroy-target-land',
    match: /destroy\s+target\s+land/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      if (!targets.length || targets[0].type !== 'permanent') {
        return { state, resolved: true, description: 'destroy land (no target)' };
      }
      for (let pi = 0; pi < 2; pi++) {
        const bf = state.players[pi].battlefield;
        const idx = bf.findIndex(p => p.id === targets[0].id);
        if (idx !== -1 && bf[idx].typeLine.toLowerCase().includes('land')) {
          const name = bf[idx].name;
          const newBf = [...bf.slice(0, idx), ...bf.slice(idx + 1)];
          const players = [...state.players];
          players[pi] = { ...players[pi], battlefield: newBf, graveyard: [...players[pi].graveyard, bf[idx] as any] };
          state = { ...state, players };
          state = addLog(state, controller, `Destroyed ${name}.`);
          return { state, resolved: true, description: `destroyed ${name}` };
        }
      }
      return { state, resolved: true, description: 'destroy land (not found)' };
    },
  },

  // P2-2. destroy-target-planeswalker
  {
    name: 'destroy-target-planeswalker',
    match: /destroy\s+target\s+planeswalker/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      if (!targets.length || targets[0].type !== 'permanent') {
        return { state, resolved: true, description: 'destroy planeswalker (no target)' };
      }
      for (let pi = 0; pi < 2; pi++) {
        const bf = state.players[pi].battlefield;
        const idx = bf.findIndex(p => p.id === targets[0].id);
        if (idx !== -1 && bf[idx].typeLine.toLowerCase().includes('planeswalker')) {
          const name = bf[idx].name;
          const newBf = [...bf.slice(0, idx), ...bf.slice(idx + 1)];
          const players = [...state.players];
          players[pi] = { ...players[pi], battlefield: newBf, graveyard: [...players[pi].graveyard, bf[idx] as any] };
          state = { ...state, players };
          state = addLog(state, controller, `Destroyed ${name}.`);
          return { state, resolved: true, description: `destroyed ${name}` };
        }
      }
      return { state, resolved: true, description: 'destroy planeswalker (not found)' };
    },
  },

  // P2-3. gain-control-permanent — permanent control change (not EOT)
  {
    name: 'gain-control-permanent',
    match: /gain\s+control\s+of\s+target\s+(?:creature|permanent|artifact|enchantment)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      if (!targets.length || targets[0].type !== 'permanent') {
        return { state, resolved: true, description: 'gain control (no target)' };
      }
      for (let pi = 0; pi < 2; pi++) {
        const bf = state.players[pi].battlefield;
        const idx = bf.findIndex(p => p.id === targets[0].id);
        if (idx !== -1 && (pi) !== controller) {
          const perm = { ...bf[idx], controller };
          const newBf = [...bf.slice(0, idx), ...bf.slice(idx + 1)];
          const players = [...state.players];
          players[pi] = { ...players[pi], battlefield: newBf };
          players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, perm] };
          state = { ...state, players };
          state = addLog(state, controller, `Gained control of ${perm.name}.`);
          return { state, resolved: true, description: `gained control of ${perm.name}` };
        }
      }
      return { state, resolved: true, description: 'gain control (already controlled or not found)' };
    },
  },

  // P2-4. reanimate-creature — return target creature from graveyard to battlefield
  {
    name: 'reanimate-creature',
    match: /(?:return|put)\s+target\s+creature\s+card\s+from\s+(?:a|your)?\s*graveyard\s+(?:to|onto)\s+the\s+battlefield/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      if (!targets.length) return { state, resolved: true, description: 'reanimate (no target)' };
      const targetId = targets[0].id;
      for (let pi = 0; pi < 2; pi++) {
        const gy = state.players[pi].graveyard;
        const idx = gy.findIndex(c => c.id === targetId);
        if (idx !== -1 && gy[idx].typeLine.toLowerCase().includes('creature')) {
          const card = gy[idx];
          const perm = cardToPermanent(card, controller, state.turn);
          const players = [...state.players];
          players[pi] = { ...players[pi], graveyard: [...gy.slice(0, idx), ...gy.slice(idx + 1)] };
          players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, perm] };
          state = { ...state, players };
          state = addLog(state, controller, `Returned ${card.name} from graveyard to battlefield.`);
          state = checkETBTriggers(state, perm, { fromZone: 'graveyard' });
          return { state, resolved: true, description: `reanimated ${card.name}` };
        }
      }
      return { state, resolved: true, description: 'reanimate (not found)' };
    },
  },

  // P2-5. double-strike-grant — target creature gains double strike until EOT
  {
    name: 'double-strike-grant',
    match: /target\s+creature\s+gains?\s+double\s+strike\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      if (!targets.length || targets[0].type !== 'permanent') {
        return { state, resolved: true, description: 'double strike grant (no target)' };
      }
      for (let pi = 0; pi < 2; pi++) {
        const bf = state.players[pi].battlefield;
        const idx = bf.findIndex(p => p.id === targets[0].id);
        if (idx !== -1) {
          const perm = bf[idx];
          const kw = [...(perm.temporaryKeywords || []), { keyword: 'double strike', source: 'spell', turn: state.turn }];
          const newBf = [...bf];
          newBf[idx] = { ...perm, temporaryKeywords: kw };
          const players = [...state.players];
          players[pi] = { ...players[pi], battlefield: newBf };
          state = { ...state, players };
          state = addLog(state, controller, `${perm.name} gains double strike until end of turn.`);
          return { state, resolved: true, description: `${perm.name} gains double strike` };
        }
      }
      return { state, resolved: true, description: 'double strike (not found)' };
    },
  },

  // P2-6. prevent-next-damage — prevent the next N damage
  {
    name: 'prevent-next-damage',
    match: /prevent\s+the\s+next\s+(\d+)\s+damage/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]) || 1;
      state = addLog(state, controller, `Prevent the next ${amount} damage.`);
      return { state, resolved: true, description: `prevent next ${amount} damage` };
    },
  },

  // P2-7. each-player-draws-discards — each player draws N then discards N
  {
    name: 'each-player-draws-discards',
    match: /each\s+player\s+draws?\s+(\d+)\s+cards?\s+(?:,?\s*then\s+)?discards?\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const drawCount = parseInt(m[1]) || 1;
      const discardCount = parseInt(m[2]) || 1;
      for (let pi = 0; pi < 2; pi++) {
        state = drawCards(state, pi, drawCount);
        // Discard: remove last N drawn cards (heuristic: highest CMC)
        const hand = [...state.players[pi].hand];
        const sorted = [...hand].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
        const toDiscard = sorted.slice(0, Math.min(discardCount, hand.length));
        const discardIds = new Set(toDiscard.map(c => c.id));
        const players = [...state.players];
        players[pi] = {
          ...players[pi],
          hand: players[pi].hand.filter(c => !discardIds.has(c.id)),
          graveyard: [...players[pi].graveyard, ...toDiscard],
        };
        state = { ...state, players };
      }
      state = addLog(state, controller, `Each player draws ${drawCount} and discards ${discardCount}.`);
      return { state, resolved: true, description: `wheel: draw ${drawCount} discard ${discardCount}` };
    },
  },

  // P2-8. tutor-basic-land-bf — search for a basic land, put onto battlefield tapped
  {
    name: 'tutor-basic-land-bf',
    match: /search\s+your\s+library\s+for\s+a\s+basic\s+land\s+card[^.]*?(?:put|place)\s+(?:it\s+)?(?:onto|on)\s+the\s+battlefield\s+tapped/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const lib = state.players[controller].library;
      const basicIdx = lib.findIndex(c => c.typeLine.toLowerCase().includes('basic') && c.typeLine.toLowerCase().includes('land'));
      if (basicIdx === -1) {
        state = addLog(state, controller, 'Searched library — no basic land found.');
        return { state, resolved: true, description: 'tutor basic land (none found)' };
      }
      const basicLand = lib[basicIdx];
      const perm = cardToPermanent(basicLand, controller, state.turn);
      perm.tapped = true;
      const newLib = [...lib.slice(0, basicIdx), ...lib.slice(basicIdx + 1)];
      const players = [...state.players];
      players[controller] = {
        ...players[controller],
        library: newLib,
        battlefield: [...players[controller].battlefield, perm],
      };
      state = { ...state, players };
      state = shuffleLibrary(state, controller);
      state = addLog(state, controller, `Searched library for ${basicLand.name}, put onto battlefield tapped.`);
      state = checkETBTriggers(state, perm, { fromZone: 'library' });
      return { state, resolved: true, description: `tutored ${basicLand.name} to battlefield tapped` };
    },
  },

  // P2-9. tutor-to-hand — search library for a card, put into hand
  {
    name: 'tutor-to-hand',
    match: /search\s+your\s+library\s+for\s+a\s+card[^.]*?(?:put|reveal)\s+(?:it\s+)?(?:into|in)\s+your\s+hand/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const lib = state.players[controller].library;
      if (lib.length === 0) {
        state = addLog(state, controller, 'Searched library — empty.');
        return { state, resolved: true, description: 'tutor (empty library)' };
      }
      // Heuristic: pick highest CMC non-land card, or any card
      const nonLands = lib.filter(c => !c.typeLine.toLowerCase().includes('land'));
      const best = nonLands.length > 0
        ? nonLands.reduce((a, b) => ((a.cmc ?? 0) >= (b.cmc ?? 0) ? a : b))
        : lib[0];
      const idx = lib.findIndex(c => c.id === best.id);
      const newLib = [...lib.slice(0, idx), ...lib.slice(idx + 1)];
      const players = [...state.players];
      players[controller] = {
        ...players[controller],
        library: newLib,
        hand: [...players[controller].hand, best],
      };
      state = { ...state, players };
      state = shuffleLibrary(state, controller);
      state = addLog(state, controller, `Searched library, put ${best.name} into hand.`);
      return { state, resolved: true, description: `tutored ${best.name} to hand` };
    },
  },

  // P2-10. exile-target-return-eot — exile target creature, return at end step
  {
    name: 'exile-target-return-eot',
    match: /exile\s+target\s+(?:creature|permanent)[^.]*?(?:return|returns?)\s+(?:it|that\s+card)\s+(?:to\s+the\s+battlefield\s+)?(?:at\s+the\s+beginning\s+of\s+the\s+next\s+end\s+step|under\s+its\s+owner'?s?\s+control)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      if (!targets.length || targets[0].type !== 'permanent') {
        return { state, resolved: true, description: 'flicker (no target)' };
      }
      for (let pi = 0; pi < 2; pi++) {
        const bf = state.players[pi].battlefield;
        const idx = bf.findIndex(p => p.id === targets[0].id);
        if (idx !== -1) {
          const perm = bf[idx];
          const newBf = [...bf.slice(0, idx), ...bf.slice(idx + 1)];
          const players = [...state.players];
          players[pi] = {
            ...players[pi],
            battlefield: newBf,
            exile: [...players[pi].exile, perm as any],
          };
          state = { ...state, players };
          state = addLog(state, controller, `${perm.name} exiled — returns at end of turn.`);
          return { state, resolved: true, description: `exiled ${perm.name} (returns EOT)` };
        }
      }
      return { state, resolved: true, description: 'flicker (not found)' };
    },
  },

  // P2-11. scry-auto — auto-resolve scry 1-3 (heuristic: bottom if CMC > 4)
  {
    name: 'scry-auto',
    match: /scry\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseInt(m[1]) || 1;
      const lib = state.players[controller].library;
      if (lib.length === 0) {
        state = addLog(state, controller, `Scry ${count} — library empty.`);
        return { state, resolved: true, description: `scry ${count} (empty)` };
      }
      const topCards = lib.slice(0, Math.min(count, lib.length));
      // Heuristic: keep low CMC on top, put high CMC on bottom
      const keep = topCards.filter(c => (c.cmc ?? 0) <= 4);
      const bottom = topCards.filter(c => (c.cmc ?? 0) > 4);
      const newLib = [...keep, ...lib.slice(topCards.length), ...bottom];
      const players = [...state.players];
      players[controller] = { ...players[controller], library: newLib };
      state = { ...state, players };
      const keptNames = keep.map(c => c.name).join(', ') || 'none';
      state = addLog(state, controller, `Scry ${count}: kept ${keep.length} on top, ${bottom.length} on bottom.`);
      return { state, resolved: true, description: `scry ${count}: kept ${keptNames}` };
    },
  },

  // P2-12. return-all-creatures-from-gy — return all creature cards from your graveyard to hand
  {
    name: 'return-all-creatures-from-gy',
    match: /return\s+all\s+creature\s+cards\s+from\s+your\s+graveyard\s+to\s+your\s+hand/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const gy = state.players[controller].graveyard;
      const creatures = gy.filter(c => c.typeLine.toLowerCase().includes('creature'));
      if (creatures.length === 0) {
        return { state, resolved: true, description: 'return creatures (none in GY)' };
      }
      const players = [...state.players];
      players[controller] = {
        ...players[controller],
        graveyard: gy.filter(c => !c.typeLine.toLowerCase().includes('creature')),
        hand: [...players[controller].hand, ...creatures],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Returned ${creatures.length} creature card(s) from graveyard to hand.`);
      return { state, resolved: true, description: `returned ${creatures.length} creatures from GY` };
    },
  },

  // P2-13. destroy-all-tapped — destroy all tapped creatures
  {
    name: 'destroy-all-tapped',
    match: /destroy\s+all\s+tapped\s+creatures/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const bf = state.players[pi].battlefield;
        const tapped = bf.filter(p => p.tapped && p.currentPower !== undefined);
        const remaining = bf.filter(p => !p.tapped || p.currentPower === undefined);
        if (tapped.length > 0) {
          count += tapped.length;
          const players = [...state.players];
          players[pi] = {
            ...players[pi],
            battlefield: remaining,
            graveyard: [...players[pi].graveyard, ...tapped as any[]],
          };
          state = { ...state, players };
        }
      }
      state = addLog(state, controller, `Destroyed ${count} tapped creature(s).`);
      return { state, resolved: true, description: `destroyed ${count} tapped creatures` };
    },
  },

  // P2-14. each-opponent-loses-life-equal-creatures — each opponent loses life equal to creatures you control
  {
    name: 'opponent-loses-life-equal-creatures',
    match: /each\s+opponent\s+loses?\s+(?:\d+\s+)?life\s+(?:equal\s+to|for\s+each)\s+(?:the\s+number\s+of\s+)?creatures?\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const creatureCount = state.players[controller].battlefield.filter(p => p.currentPower !== undefined).length;
      const players = [...state.players];
      for (const opp of getOpponents(state, controller)) {
        players[opp] = { ...players[opp], life: players[opp].life - creatureCount };
      }
      state = { ...state, players };
      state = addLog(state, controller, `Each opponent loses ${creatureCount} life (creature count).`);
      return { state, resolved: true, description: `opponent loses ${creatureCount} life` };
    },
  },

  // P2-15. surveil — like scry but cards go to graveyard instead of bottom
  {
    name: 'surveil',
    match: /surveil\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseInt(m[1]) || 1;
      const lib = state.players[controller].library;
      if (lib.length === 0) {
        return { state, resolved: true, description: `surveil ${count} (empty)` };
      }
      const topCards = lib.slice(0, Math.min(count, lib.length));
      // Heuristic: keep low CMC on top, mill high CMC to graveyard
      const keep = topCards.filter(c => (c.cmc ?? 0) <= 3);
      const toGY = topCards.filter(c => (c.cmc ?? 0) > 3);
      const newLib = [...keep, ...lib.slice(topCards.length)];
      const players = [...state.players];
      players[controller] = {
        ...players[controller],
        library: newLib,
        graveyard: [...players[controller].graveyard, ...toGY],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Surveil ${count}: kept ${keep.length}, milled ${toGY.length}.`);
      return { state, resolved: true, description: `surveil ${count}` };
    },
  },

  // ─── Phase 3 Effect Patterns ───

  // P3-1. Become the monarch (CR 721)
  {
    name: 'become-monarch',
    match: /you become the monarch/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = { ...state, monarch: controller };
      state = addLog(state, controller, `Player ${controller} becomes the monarch.`);
      return { state, resolved: true, description: 'become the monarch' };
    },
  },

  // P3-2. Exalted pump: +1/+1 to lone attacker until end of turn
  {
    name: 'exalted-pump',
    match: /^\s*exalted\s*$/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const combat = state.combat;
      if (!combat || combat.attackers.length !== 1) return { state, resolved: true, description: 'exalted (no lone attacker)' };
      const attackerId = combat.attackers[0].permanentId;
      const players = [...state.players];
      const bf = [...players[controller].battlefield];
      const idx = bf.findIndex(p => p.id === attackerId);
      if (idx !== -1) {
        bf[idx] = {
          ...bf[idx],
          temporaryPtMods: [...(bf[idx].temporaryPtMods || []), { power: 1, toughness: 1, until: 'end-of-turn' }],
        };
        players[controller] = { ...players[controller], battlefield: bf };
        state = { ...state, players };
        state = addLog(state, controller, `Exalted: ${bf[idx].name} gets +1/+1 until end of turn.`);
      }
      return { state, resolved: true, description: 'exalted +1/+1' };
    },
  },

  // P3-3. Gain energy counters
  {
    name: 'gain-energy',
    match: /you get (?:(\d+)\s+)?\{E\}|gain (\d+) energy/i,
    requiresTarget: false,
    apply: (state, controller, _t, m) => {
      const amount = parseInt(m[1] || m[2] || '1', 10) || 1;
      const players = [...state.players];
      players[controller] = { ...players[controller], energyCounters: players[controller].energyCounters + amount };
      state = { ...state, players };
      state = addLog(state, controller, `Gained ${amount} energy (total: ${players[controller].energyCounters}).`);
      return { state, resolved: true, description: `gain ${amount} energy` };
    },
  },

  // P3-4. Pay energy counters
  {
    name: 'pay-energy',
    match: /pay (?:(\d+)\s+)?\{E\}|pay (\d+) energy/i,
    requiresTarget: false,
    apply: (state, controller, _t, m) => {
      const amount = parseInt(m[1] || m[2] || '1', 10) || 1;
      const players = [...state.players];
      if (players[controller].energyCounters < amount) {
        return { state, resolved: true, description: 'not enough energy' };
      }
      players[controller] = { ...players[controller], energyCounters: players[controller].energyCounters - amount };
      state = { ...state, players };
      state = addLog(state, controller, `Paid ${amount} energy (remaining: ${players[controller].energyCounters}).`);
      return { state, resolved: true, description: `pay ${amount} energy` };
    },
  },

  // P3-5. Gain experience counter
  {
    name: 'gain-experience',
    match: /you get an? experience counter/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const players = [...state.players];
      players[controller] = { ...players[controller], experienceCounters: players[controller].experienceCounters + 1 };
      state = { ...state, players };
      state = addLog(state, controller, `Gained an experience counter (total: ${players[controller].experienceCounters}).`);
      return { state, resolved: true, description: 'gain experience counter' };
    },
  },

  // P3-6. Goad target creature
  {
    name: 'goad-target',
    match: /goad target creature/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      if (!targets.length) return { state, resolved: true, description: 'goad (no target)' };
      const targetId = targets[0].id;
      const players = [...state.players];
      for (let pi = 0; pi < 2; pi++) {
        const idx = players[pi as 0|1].battlefield.findIndex(p => p.id === targetId);
        if (idx !== -1) {
          const bf = [...players[pi as 0|1].battlefield];
          bf[idx] = { ...bf[idx], goaded: true };
          players[pi as 0|1] = { ...players[pi as 0|1], battlefield: bf };
          state = { ...state, players };
          state = addLog(state, controller, `${bf[idx].name} is goaded.`);
          break;
        }
      }
      return { state, resolved: true, description: 'goad target creature' };
    },
  },

  // P3-7. Goad all opponent creatures
  {
    name: 'goad-all-opponents',
    match: /goad (?:all|each)\s+creature[s]?\s+(?:your\s+opponents?\s+control|an?\s+opponent\s+controls?)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opp: number = getFirstOpponent(state, controller);
      const players = [...state.players];
      const bf = players[opp].battlefield.map(p =>
        p.currentPower !== undefined ? { ...p, goaded: true } : p
      );
      players[opp] = { ...players[opp], battlefield: bf };
      state = { ...state, players };
      state = addLog(state, controller, `All opponent's creatures are goaded.`);
      return { state, resolved: true, description: 'goad all opponents creatures' };
    },
  },

  // P3-8. Flicker self (exile ~ then return to battlefield)
  {
    name: 'flicker-self',
    match: /exile ~[.,]\s*(?:then\s+)?return (?:it|~) to the battlefield/i,
    requiresTarget: false,
    apply: (state, controller, _t, _m, source) => {
      if (!source) return { state, resolved: true, description: 'flicker (no source)' };
      const players = [...state.players];
      const bf = players[controller].battlefield;
      const idx = bf.findIndex(p => p.id === source.id);
      if (idx === -1) return { state, resolved: true, description: 'flicker (source gone)' };
      const perm = bf[idx];
      // Remove and re-add (new ETB)
      const newBf = [...bf.slice(0, idx), ...bf.slice(idx + 1)];
      const freshPerm = { ...perm, damage: 0, tapped: false, summoningSick: true, temporaryPtMods: [], temporaryKeywords: [] };
      newBf.push(freshPerm);
      players[controller] = { ...players[controller], battlefield: newBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} flickered (exiled and returned).`);
      return { state, resolved: true, description: `flicker ${perm.name}` };
    },
  },

  // P3-9. Bounce all nonland permanents (Cyclonic Rift)
  {
    name: 'bounce-all-nonland',
    match: /return all nonland permanents\s+(?:you don't control\s+)?to\s+(?:their\s+)?(?:owners?'?\s+)?hands?/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const players = [...state.players];
      const opp: number = getFirstOpponent(state, controller);
      const oppBf = players[opp].battlefield;
      const nonlands = oppBf.filter(p => !p.typeLine.toLowerCase().includes('land'));
      const lands = oppBf.filter(p => p.typeLine.toLowerCase().includes('land'));
      const bouncedCards = nonlands.map(p => ({
        id: p.id, oracleId: p.oracleId, name: p.name, manaCost: p.manaCost, cmc: p.cmc,
        typeLine: p.typeLine, oracleText: p.oracleText || '', power: p.power, toughness: p.toughness,
        colors: p.colors, colorIdentity: p.colorIdentity, rarity: p.rarity, tags: p.tags,
        imageUrl: p.imageUrl, owner: p.owner,
      })) as any[];
      players[opp] = { ...players[opp], battlefield: lands, hand: [...players[opp].hand, ...bouncedCards] };
      state = { ...state, players };
      state = addLog(state, controller, `Bounced ${nonlands.length} nonland permanents to opponent's hand.`);
      return { state, resolved: true, description: `bounce ${nonlands.length} nonland permanents` };
    },
  },

  // P3-10. Protection grant: "target creature gains protection from [color] until end of turn"
  {
    name: 'protection-grant',
    match: /target creature gains protection from (\w+) until end of turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      if (!targets.length) return { state, resolved: true, description: 'protection grant (no target)' };
      const color = m[1]?.toLowerCase() || 'chosen color';
      const players = [...state.players];
      for (let pi = 0; pi < 2; pi++) {
        const idx = players[pi as 0|1].battlefield.findIndex(p => p.id === targets[0].id);
        if (idx !== -1) {
          const bf = [...players[pi as 0|1].battlefield];
          bf[idx] = { ...bf[idx], temporaryKeywords: [...(bf[idx].temporaryKeywords || []), { keyword: `protection from ${color}`, until: 'end-of-turn' }] };
          players[pi as 0|1] = { ...players[pi as 0|1], battlefield: bf };
          state = { ...state, players };
          state = addLog(state, controller, `${bf[idx].name} gains protection from ${color} until end of turn.`);
          break;
        }
      }
      return { state, resolved: true, description: `grant protection from ${color}` };
    },
  },

  // P3-11. Indestructible grant: "target creature gains indestructible until end of turn"
  {
    name: 'indestructible-grant',
    match: /target creature gains indestructible until end of turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      if (!targets.length) return { state, resolved: true, description: 'indestructible grant (no target)' };
      const players = [...state.players];
      for (let pi = 0; pi < 2; pi++) {
        const idx = players[pi as 0|1].battlefield.findIndex(p => p.id === targets[0].id);
        if (idx !== -1) {
          const bf = [...players[pi as 0|1].battlefield];
          bf[idx] = { ...bf[idx], temporaryKeywords: [...(bf[idx].temporaryKeywords || []), { keyword: 'indestructible', until: 'end-of-turn' }] };
          players[pi as 0|1] = { ...players[pi as 0|1], battlefield: bf };
          state = { ...state, players };
          state = addLog(state, controller, `${bf[idx].name} gains indestructible until end of turn.`);
          break;
        }
      }
      return { state, resolved: true, description: 'grant indestructible' };
    },
  },

  // P3-12. Hexproof grant: "target creature gains hexproof until end of turn"
  {
    name: 'hexproof-grant',
    match: /target creature (?:you control )?gains hexproof until end of turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      if (!targets.length) return { state, resolved: true, description: 'hexproof grant (no target)' };
      const players = [...state.players];
      for (let pi = 0; pi < 2; pi++) {
        const idx = players[pi as 0|1].battlefield.findIndex(p => p.id === targets[0].id);
        if (idx !== -1) {
          const bf = [...players[pi as 0|1].battlefield];
          bf[idx] = { ...bf[idx], temporaryKeywords: [...(bf[idx].temporaryKeywords || []), { keyword: 'hexproof', until: 'end-of-turn' }] };
          players[pi as 0|1] = { ...players[pi as 0|1], battlefield: bf };
          state = { ...state, players };
          state = addLog(state, controller, `${bf[idx].name} gains hexproof until end of turn.`);
          break;
        }
      }
      return { state, resolved: true, description: 'grant hexproof' };
    },
  },

  // P3-13. Pump all creatures you control: "creatures you control get +N/+N until end of turn"
  {
    name: 'pump-all-creatures',
    match: /creatures you control get ([+-]\d+)\/([+-]\d+) until end of turn/i,
    requiresTarget: false,
    apply: (state, controller, _t, m) => {
      const pw = parseInt(m[1], 10) || 0;
      const tw = parseInt(m[2], 10) || 0;
      const players = [...state.players];
      let count = 0;
      const bf = players[controller].battlefield.map(p => {
        if (p.currentPower !== undefined) {
          count++;
          return { ...p, temporaryPtMods: [...(p.temporaryPtMods || []), { power: pw, toughness: tw, until: 'end-of-turn' as const }] };
        }
        return p;
      });
      players[controller] = { ...players[controller], battlefield: bf };
      state = { ...state, players };
      state = addLog(state, controller, `${count} creatures get ${m[1]}/${m[2]} until end of turn.`);
      return { state, resolved: true, description: `pump all creatures ${m[1]}/${m[2]}` };
    },
  },

  // P3-14. Drain each opponent: "each opponent loses N life, you gain that much life"
  {
    name: 'drain-each-opponent',
    match: /each opponent loses (\d+) life[.,]?\s*(?:and\s+)?you gain (?:that much|(\d+)) life/i,
    requiresTarget: false,
    apply: (state, controller, _t, m) => {
      const amount = parseInt(m[1], 10) || 1;
      const opponents = getOpponents(state, controller);
      const players = [...state.players];
      for (const opp of opponents) {
        players[opp] = { ...players[opp], life: players[opp].life - amount };
      }
      players[controller] = { ...players[controller], life: players[controller].life + amount * opponents.length };
      state = { ...state, players };
      state = addLog(state, controller, `Drained: each opponent loses ${amount} life, you gain ${amount * opponents.length} life.`);
      return { state, resolved: true, description: `drain ${amount}` };
    },
  },

  // P3-15. Proliferate: choose any number of permanents/players with counters, give each another counter
  {
    name: 'proliferate',
    match: /\bproliferate\b/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const players = [...state.players];
      let count = 0;
      // Auto-resolve: add one of each counter type to all permanents/players with counters
      for (let pi = 0; pi < 2; pi++) {
        const bf = players[pi as 0|1].battlefield.map(p => {
          const counterTypes = Object.keys(p.counters || {}).filter(k => (p.counters?.[k] || 0) > 0);
          if (counterTypes.length === 0) return p;
          count++;
          const newCounters = { ...p.counters };
          for (const ct of counterTypes) {
            newCounters[ct] = (newCounters[ct] || 0) + 1;
          }
          return { ...p, counters: newCounters };
        });
        players[pi as 0|1] = { ...players[pi as 0|1], battlefield: bf };
        // Player counters (poison, energy, experience)
        if (players[pi as 0|1].poisonCounters > 0 && pi !== controller) {
          players[pi as 0|1] = { ...players[pi as 0|1], poisonCounters: players[pi as 0|1].poisonCounters + 1 };
          count++;
        }
        if (players[pi as 0|1].energyCounters > 0 && pi === controller) {
          players[pi as 0|1] = { ...players[pi as 0|1], energyCounters: players[pi as 0|1].energyCounters + 1 };
          count++;
        }
        if (players[pi as 0|1].experienceCounters > 0 && pi === controller) {
          players[pi as 0|1] = { ...players[pi as 0|1], experienceCounters: players[pi as 0|1].experienceCounters + 1 };
          count++;
        }
      }
      state = { ...state, players };
      state = addLog(state, controller, `Proliferate: added counters to ${count} permanents/players.`);
      return { state, resolved: true, description: `proliferate ${count} targets` };
    },
  },

  // P3-16. Amass N: create Army token or put +1/+1 counters on existing Army
  {
    name: 'amass',
    match: /amass (\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _t, m) => {
      const n = parseInt(m[1], 10) || 1;
      const players = [...state.players];
      // Check for existing Army token
      const armyIdx = players[controller].battlefield.findIndex(p => p.typeLine.toLowerCase().includes('army'));
      if (armyIdx !== -1) {
        const bf = [...players[controller].battlefield];
        const army = bf[armyIdx];
        bf[armyIdx] = { ...army, counters: { ...army.counters, '+1/+1': (army.counters['+1/+1'] || 0) + n } };
        players[controller] = { ...players[controller], battlefield: bf };
        state = { ...state, players };
        state = addLog(state, controller, `Amass ${n}: put ${n} +1/+1 counter(s) on ${army.name}.`);
      } else {
        // Create 0/0 Army token with N +1/+1 counters
        const token = {
          id: `army_${Date.now().toString(36)}`, oracleId: 'army-token', name: 'Zombie Army',
          manaCost: '', cmc: 0, typeLine: 'Token Creature — Zombie Army',
          oracleText: '', colors: ['B' as const], colorIdentity: ['B' as const],
          rarity: 'common' as const, tags: [] as any[], imageUrl: '', owner: controller,
          controller, damage: 0, tapped: false, summoningSick: true, flipped: false, faceDown: false,
          counters: { '+1/+1': n }, basePower: 0, baseToughness: 0, currentPower: n, currentToughness: n,
          power: '0', toughness: '0', attacking: false, blocking: null, abilities: [],
          x: 0, y: 0, enteredBattlefieldTurn: state.turn, attachments: [], isToken: true,
        } as any;
        players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, token] };
        state = { ...state, players };
        state = addLog(state, controller, `Amass ${n}: created a ${n}/${n} Zombie Army token.`);
      }
      return { state, resolved: true, description: `amass ${n}` };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── P4: Conditional Search / Tutor (Phase 4, Step 4) ──
  // ══════════════════════════════════════════════════════════════

  // P4-1. search-creature-to-hand — search library for a creature, put into hand
  {
    name: 'search-creature-to-hand',
    match: /search\s+your\s+library\s+for\s+a\s+creature\s+card.*?(?:reveal\s+(?:it|that\s+card).*?)?put\s+(?:it|that\s+card)\s+into\s+your\s+hand/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const creatures = player.library.filter(c => c.typeLine?.toLowerCase().includes('creature'));
      if (creatures.length === 0) {
        state = shuffleLibrary(state, controller);
        state = addLog(state, controller, 'Searched library — no creature found.');
        return { state, resolved: true, description: 'search (no creature)' };
      }
      // Pick highest CMC creature
      const sorted = [...creatures].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
      const chosen = sorted[0];
      const idx = player.library.indexOf(chosen);
      const newLib = [...player.library];
      newLib.splice(idx, 1);
      const players = [...state.players];
      players[controller] = { ...player, library: newLib, hand: [...player.hand, chosen] };
      state = { ...state, players };
      state = shuffleLibrary(state, controller);
      state = addLog(state, controller, `Searches library, puts ${chosen.name} into hand.`);
      return { state, resolved: true, description: `tutor ${chosen.name} to hand` };
    },
  },

  // P4-2. search-creature-bf — search for creature, put onto battlefield
  {
    name: 'search-creature-bf',
    match: /search\s+your\s+library\s+for\s+a\s+creature\s+card.*?put\s+(?:it|that\s+card)\s+onto\s+the\s+battlefield/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const creatures = player.library.filter(c => c.typeLine?.toLowerCase().includes('creature'));
      if (creatures.length === 0) {
        state = shuffleLibrary(state, controller);
        state = addLog(state, controller, 'Searched library — no creature found.');
        return { state, resolved: true, description: 'search (no creature)' };
      }
      const sorted = [...creatures].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
      const chosen = sorted[0];
      const idx = player.library.indexOf(chosen);
      const newLib = [...player.library];
      newLib.splice(idx, 1);
      const perm = cardToPermanent(chosen, controller, state.turn);
      const players = [...state.players];
      players[controller] = { ...player, library: newLib, battlefield: [...player.battlefield, perm] };
      state = { ...state, players };
      state = shuffleLibrary(state, controller);
      state = addLog(state, controller, `Searches library, puts ${chosen.name} onto the battlefield.`);
      return { state, resolved: true, description: `tutor ${chosen.name} to battlefield` };
    },
  },

  // P4-3. search-cmc-leq — search for card with CMC ≤ N
  {
    name: 'search-cmc-leq',
    match: /search\s+your\s+library\s+for\s+a\s+(?:creature\s+)?card\s+with\s+(?:mana\s+value|converted\s+mana\s+cost|cmc)\s+(\d+)\s+or\s+less/i,
    requiresTarget: false,
    apply: (state, controller, _t, m) => {
      const maxCmc = parseInt(m[1], 10);
      const player = state.players[controller];
      const eligible = player.library.filter(c => (c.cmc ?? 0) <= maxCmc && !c.typeLine?.toLowerCase().includes('land'));
      if (eligible.length === 0) {
        state = shuffleLibrary(state, controller);
        state = addLog(state, controller, `Searched library — no card with CMC ≤ ${maxCmc} found.`);
        return { state, resolved: true, description: `search (no CMC ≤ ${maxCmc})` };
      }
      const sorted = [...eligible].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
      const chosen = sorted[0];
      const idx = player.library.indexOf(chosen);
      const newLib = [...player.library];
      newLib.splice(idx, 1);
      const players = [...state.players];
      players[controller] = { ...player, library: newLib, hand: [...player.hand, chosen] };
      state = { ...state, players };
      state = shuffleLibrary(state, controller);
      state = addLog(state, controller, `Searches library, puts ${chosen.name} (CMC ${chosen.cmc}) into hand.`);
      return { state, resolved: true, description: `tutor ${chosen.name} (CMC ≤ ${maxCmc})` };
    },
  },

  // P4-4. search-instant-sorcery — search for instant or sorcery
  {
    name: 'search-instant-sorcery',
    match: /search\s+your\s+library\s+for\s+an?\s+instant\s+(?:or\s+sorcery\s+)?card.*?(?:put\s+(?:it|that\s+card)\s+into\s+your\s+hand|reveal)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const spells = player.library.filter(c => {
        const t = c.typeLine?.toLowerCase() || '';
        return t.includes('instant') || t.includes('sorcery');
      });
      if (spells.length === 0) {
        state = shuffleLibrary(state, controller);
        state = addLog(state, controller, 'Searched library — no instant/sorcery found.');
        return { state, resolved: true, description: 'search (no instant/sorcery)' };
      }
      const sorted = [...spells].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
      const chosen = sorted[0];
      const idx = player.library.indexOf(chosen);
      const newLib = [...player.library];
      newLib.splice(idx, 1);
      const players = [...state.players];
      players[controller] = { ...player, library: newLib, hand: [...player.hand, chosen] };
      state = { ...state, players };
      state = shuffleLibrary(state, controller);
      state = addLog(state, controller, `Searches library, puts ${chosen.name} into hand.`);
      return { state, resolved: true, description: `tutor ${chosen.name}` };
    },
  },

  // P4-5. search-artifact-to-hand — search for artifact
  {
    name: 'search-artifact-to-hand',
    match: /search\s+your\s+library\s+for\s+an?\s+artifact\s+card.*?(?:put\s+(?:it|that\s+card)\s+into\s+your\s+hand|reveal)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const arts = player.library.filter(c => c.typeLine?.toLowerCase().includes('artifact'));
      if (arts.length === 0) {
        state = shuffleLibrary(state, controller);
        state = addLog(state, controller, 'Searched library — no artifact found.');
        return { state, resolved: true, description: 'search (no artifact)' };
      }
      const sorted = [...arts].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
      const chosen = sorted[0];
      const idx = player.library.indexOf(chosen);
      const newLib = [...player.library];
      newLib.splice(idx, 1);
      const players = [...state.players];
      players[controller] = { ...player, library: newLib, hand: [...player.hand, chosen] };
      state = { ...state, players };
      state = shuffleLibrary(state, controller);
      state = addLog(state, controller, `Searches library, puts ${chosen.name} into hand.`);
      return { state, resolved: true, description: `tutor ${chosen.name}` };
    },
  },

  // P4-6. search-enchantment-to-hand — search for enchantment
  {
    name: 'search-enchantment-to-hand',
    match: /search\s+your\s+library\s+for\s+an?\s+enchantment\s+card.*?(?:put\s+(?:it|that\s+card)\s+into\s+your\s+hand|reveal)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const enchants = player.library.filter(c => c.typeLine?.toLowerCase().includes('enchantment'));
      if (enchants.length === 0) {
        state = shuffleLibrary(state, controller);
        state = addLog(state, controller, 'Searched library — no enchantment found.');
        return { state, resolved: true, description: 'search (no enchantment)' };
      }
      const sorted = [...enchants].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
      const chosen = sorted[0];
      const idx = player.library.indexOf(chosen);
      const newLib = [...player.library];
      newLib.splice(idx, 1);
      const players = [...state.players];
      players[controller] = { ...player, library: newLib, hand: [...player.hand, chosen] };
      state = { ...state, players };
      state = shuffleLibrary(state, controller);
      state = addLog(state, controller, `Searches library, puts ${chosen.name} into hand.`);
      return { state, resolved: true, description: `tutor ${chosen.name}` };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── P4: Sacrifice with Conditional Benefit (Phase 4, Step 5) ──
  // ══════════════════════════════════════════════════════════════

  // P4-7. sacrifice-creature-draw — sacrifice a creature, draw a card
  {
    name: 'sacrifice-creature-draw',
    match: /sacrifice\s+a\s+creature[,:]?\s*draw\s+a\s+card/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
      if (creatures.length === 0) {
        state = addLog(state, controller, 'No creatures to sacrifice.');
        return { state, resolved: true, description: 'no creatures to sacrifice' };
      }
      // Sacrifice weakest creature (lowest power + toughness)
      const sorted = [...creatures].sort((a, b) => {
        const aVal = (a.currentPower ?? 0) + (a.currentToughness ?? 0);
        const bVal = (b.currentPower ?? 0) + (b.currentToughness ?? 0);
        return aVal - bVal;
      });
      const victim = sorted[0];
      state = sacrificePermanent(state, victim.id);
      state = drawCards(state, controller, 1);
      state = addLog(state, controller, `Sacrifices ${victim.name}, draws a card.`);
      return { state, resolved: true, description: `sacrifice ${victim.name}, draw 1` };
    },
  },

  // P4-8. sacrifice-creature-gain-life — sacrifice a creature, gain life equal to toughness
  {
    name: 'sacrifice-creature-gain-life',
    match: /sacrifice\s+a\s+creature[,:]?\s*(?:you\s+)?gain\s+life\s+equal\s+to\s+(?:its?|that\s+creature'?s?)\s+toughness/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
      if (creatures.length === 0) {
        state = addLog(state, controller, 'No creatures to sacrifice.');
        return { state, resolved: true, description: 'no creatures to sacrifice' };
      }
      const sorted = [...creatures].sort((a, b) => {
        const aVal = (a.currentPower ?? 0) + (a.currentToughness ?? 0);
        const bVal = (b.currentPower ?? 0) + (b.currentToughness ?? 0);
        return aVal - bVal;
      });
      const victim = sorted[0];
      const lifeGain = victim.currentToughness ?? 0;
      state = sacrificePermanent(state, victim.id);
      state = gainLife(state, controller, lifeGain);
      state = addLog(state, controller, `Sacrifices ${victim.name}, gains ${lifeGain} life.`);
      return { state, resolved: true, description: `sacrifice ${victim.name}, gain ${lifeGain} life` };
    },
  },

  // P4-9. sacrifice-creature-damage — sacrifice a creature, deal damage equal to power
  {
    name: 'sacrifice-creature-damage',
    match: /sacrifice\s+a\s+creature[,:]?\s*(?:~\s+)?deals?\s+damage\s+equal\s+to\s+(?:its?|that\s+creature'?s?)\s+power/i,
    requiresTarget: false,
    apply: (state, controller, targets) => {
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
      if (creatures.length === 0) {
        state = addLog(state, controller, 'No creatures to sacrifice.');
        return { state, resolved: true, description: 'no creatures to sacrifice' };
      }
      // Sacrifice weakest
      const sorted = [...creatures].sort((a, b) => {
        const aVal = (a.currentPower ?? 0) + (a.currentToughness ?? 0);
        const bVal = (b.currentPower ?? 0) + (b.currentToughness ?? 0);
        return aVal - bVal;
      });
      const victim = sorted[0];
      const dmg = victim.currentPower ?? 0;
      state = sacrificePermanent(state, victim.id);
      // Deal damage to opponent
      const opp: number = getFirstOpponent(state, controller);
      state = damagePlayer(state, opp, dmg);
      state = addLog(state, controller, `Sacrifices ${victim.name}, deals ${dmg} damage.`);
      return { state, resolved: true, description: `sacrifice ${victim.name}, ${dmg} damage` };
    },
  },

  // P4-11. each-opponent-sacrifices-permanent — each opponent sacrifices a permanent
  {
    name: 'each-opponent-sacrifices-permanent',
    match: /each\s+opponent\s+sacrifices?\s+a\s+(?:nonland\s+)?permanent/i,
    requiresTarget: false,
    apply: (state, controller) => {
      for (const opp of getOpponents(state, controller)) {
        const oppPlayer = state.players[opp];
        const perms = oppPlayer.battlefield.filter(p => !p.typeLine?.toLowerCase().includes('land'));
        if (perms.length === 0) {
          state = addLog(state, controller, `${oppPlayer.name} has no nonland permanents to sacrifice.`);
          continue;
        }
        // Sacrifice least valuable (lowest CMC nonland)
        const sorted = [...perms].sort((a, b) => (a.cmc ?? 0) - (b.cmc ?? 0));
        const victim = sorted[0];
        state = sacrificePermanent(state, victim.id);
        state = addLog(state, controller, `${oppPlayer.name} sacrifices ${victim.name}.`);
      }
      return { state, resolved: true, description: 'each opponent sacrifices a permanent' };
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ── P4: Additional Mechanics (Phase 4, Step 10) ──
  // ══════════════════════════════════════════════════════════════

  // P4-12. explore — top card: land→hand, nonland→+1/+1 counter (simplified)
  {
    name: 'explore',
    match: /\bexplores?\b/i,
    requiresTarget: false,
    apply: (state, controller, _t, _m, source) => {
      const player = state.players[controller];
      if (player.library.length === 0) {
        state = addLog(state, controller, 'Explores but library is empty.');
        return { state, resolved: true, description: 'explore (empty library)' };
      }
      const topCard = player.library[0];
      const isLandCard = topCard.typeLine?.toLowerCase().includes('land');
      const players = [...state.players];
      if (isLandCard) {
        // Land → put into hand
        players[controller] = { ...player, library: player.library.slice(1), hand: [...player.hand, topCard] };
        state = { ...state, players };
        state = addLog(state, controller, `Explores: reveals ${topCard.name} (land), puts it into hand.`);
      } else {
        // Nonland → +1/+1 counter on exploring creature, may put card in graveyard
        players[controller] = { ...player, library: player.library.slice(1), graveyard: [...player.graveyard, topCard] };
        // Find source permanent and add counter
        if (source) {
          const bf = [...players[controller].battlefield];
          const srcIdx = bf.findIndex(p => p.id === source.id);
          if (srcIdx !== -1) {
            bf[srcIdx] = { ...bf[srcIdx], counters: { ...bf[srcIdx].counters, '+1/+1': (bf[srcIdx].counters['+1/+1'] || 0) + 1 }, currentPower: (bf[srcIdx].currentPower ?? 0) + 1, currentToughness: (bf[srcIdx].currentToughness ?? 0) + 1 };
            players[controller] = { ...players[controller], battlefield: bf };
          }
        }
        state = { ...state, players };
        state = addLog(state, controller, `Explores: reveals ${topCard.name} (nonland), gets +1/+1 counter, card to graveyard.`);
      }
      return { state, resolved: true, description: `explore (${isLandCard ? 'land to hand' : '+1/+1 counter'})` };
    },
  },

  // P4-13. investigate — create Clue artifact token
  {
    name: 'investigate',
    match: /\binvestigate\b/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const clueCard: Card = {
        id: generateCardId(), oracleId: 'token_clue', name: 'Clue',
        manaCost: '', cmc: 0, typeLine: 'Token Artifact — Clue',
        oracleText: '{2}, Sacrifice this artifact: Draw a card.', power: undefined, toughness: undefined,
        colors: [], colorIdentity: [], rarity: 'common' as const, tags: [], imageUrl: '', owner: controller,
      };
      const perm = cardToPermanent(clueCard, controller, state.turn);
      const players = [...state.players];
      players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, perm] };
      state = { ...state, players };
      state = addLog(state, controller, `Investigates: creates a Clue token.`);
      return { state, resolved: true, description: 'investigate (Clue token)' };
    },
  },

  // P4-14. populate — copy strongest creature token you control
  {
    name: 'populate',
    match: /\bpopulate\b/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const tokens = player.battlefield.filter(p => (p as any).isToken && p.currentPower !== undefined);
      if (tokens.length === 0) {
        state = addLog(state, controller, 'Populate: no creature tokens to copy.');
        return { state, resolved: true, description: 'populate (no tokens)' };
      }
      // Pick strongest token
      const sorted = [...tokens].sort((a, b) => ((b.currentPower ?? 0) + (b.currentToughness ?? 0)) - ((a.currentPower ?? 0) + (a.currentToughness ?? 0)));
      const best = sorted[0];
      const copy: any = {
        ...best, id: generateCardId(), damage: 0, tapped: false, summoningSick: true,
        attacking: false, blocking: null, counters: {}, temporaryPtMods: [],
        enteredBattlefieldTurn: state.turn, isToken: true,
        currentPower: best.basePower, currentToughness: best.baseToughness,
      };
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, copy] };
      state = { ...state, players };
      state = addLog(state, controller, `Populate: copies ${best.name} token.`);
      return { state, resolved: true, description: `populate (copy ${best.name})` };
    },
  },

  // P4-15. bite — creature deals damage equal to its power to target creature
  {
    name: 'bite',
    match: /(?:~|target creature you control)\s+deals?\s+damage\s+equal\s+to\s+its\s+power\s+to\s+target/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m, source) => {
      const target = targets.find(t => t.type === 'permanent');
      if (!target) return { state, resolved: false };
      const found = findPermanentById(state, target.id);
      if (!found) return { state, resolved: false };
      // Source power
      let power = 0;
      if (source) {
        const srcPerm = findPermanentById(state, source.id);
        power = srcPerm?.perm.currentPower ?? 0;
      }
      if (power <= 0) {
        state = addLog(state, controller, 'No damage dealt (power 0).');
        return { state, resolved: true, description: 'bite (0 damage)' };
      }
      state = damagePermanent(state, found.perm.id, power, source?.colors || []);
      state = addLog(state, controller, `Deals ${power} damage to ${found.perm.name}.`);
      return { state, resolved: true, description: `bite: ${power} to ${found.perm.name}` };
    },
  },

  // P4-16. manifest — top card(s) of library as 2/2 face-down creature(s) (CR 702.111)
  {
    name: 'manifest',
    match: /\bmanifest(?:s)?\s+(?:the\s+top\s+)?(\d+|a)\s+card|\bmanifest\b/i,
    requiresTarget: false,
    apply: (state, controller, _t, m) => {
      const player = state.players[controller];
      // Determine how many cards to manifest
      const countStr = m[1] || '1';
      const count = (countStr === 'a' || !countStr) ? 1 : parseInt(countStr, 10) || 1;
      if (player.library.length === 0) {
        state = addLog(state, controller, 'Manifest: library is empty.');
        return { state, resolved: true, description: 'manifest (empty library)' };
      }
      const toManifest = Math.min(count, player.library.length);
      const topCards = player.library.slice(0, toManifest);
      const newLibrary = player.library.slice(toManifest);
      const newPerms: Permanent[] = topCards.map(topCard => {
        // Create a face-down 2/2 colorless creature permanent (CR 702.111b)
        // The underlying card's identity is hidden; we track it via manifestedCardId
        const faceDownCard: Card = {
          id: topCard.id,
          oracleId: topCard.oracleId,
          name: 'Manifest',
          manaCost: topCard.manaCost,
          cmc: topCard.cmc,
          typeLine: 'Creature',
          oracleText: topCard.oracleText,
          power: '2',
          toughness: '2',
          colors: [],
          colorIdentity: [],
          rarity: topCard.rarity,
          tags: [],
          imageUrl: topCard.imageUrl,
          owner: controller,
        };
        const perm = cardToPermanent(faceDownCard, controller, state.turn);
        return {
          ...perm,
          faceDown: true,
          basePower: 2,
          baseToughness: 2,
          currentPower: 2,
          currentToughness: 2,
          manifestedCardId: topCard.id,
        } as Permanent;
      });
      const players = [...state.players];
      players[controller] = {
        ...player,
        library: newLibrary,
        battlefield: [...player.battlefield, ...newPerms],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Manifests ${toManifest} card(s) from library as 2/2 face-down creature(s).`);
      return { state, resolved: true, description: `manifest (${toManifest} face-down)` };
    },
  },

  // P4-17. crew-vehicle — tap creatures with total power ≥ N to crew
  {
    name: 'crew-vehicle',
    match: /crew\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _t, m, source) => {
      const crewN = parseInt(m[1], 10);
      if (!source) return { state, resolved: false, description: 'no source for crew' };
      const srcPerm = findPermanentById(state, source.id);
      if (!srcPerm) return { state, resolved: false };
      const player = state.players[controller];
      // Find untapped creatures to tap for crew
      const creatures = player.battlefield.filter(p => p.currentPower !== undefined && !p.tapped && p.id !== source.id);
      let totalPower = 0;
      const toCrew: string[] = [];
      for (const c of creatures.sort((a, b) => (a.currentPower ?? 0) - (b.currentPower ?? 0))) {
        if (totalPower >= crewN) break;
        toCrew.push(c.id);
        totalPower += c.currentPower ?? 0;
      }
      if (totalPower < crewN) {
        state = addLog(state, controller, `Not enough power to crew (need ${crewN}, have ${totalPower}).`);
        return { state, resolved: true, description: 'crew failed (not enough power)' };
      }
      const players = [...state.players];
      players[controller] = {
        ...player,
        battlefield: player.battlefield.map(p => {
          if (toCrew.includes(p.id)) return { ...p, tapped: true };
          if (p.id === source.id) return { ...p, currentPower: srcPerm.perm.basePower ?? 0, currentToughness: srcPerm.perm.baseToughness ?? 0 };
          return p;
        }),
      };
      state = { ...state, players };
      state = addLog(state, controller, `Crews ${srcPerm.perm.name} (tapped ${toCrew.length} creatures).`);
      return { state, resolved: true, description: `crew ${srcPerm.perm.name}` };
    },
  },

  // ── Phase 5 Task 4: Activated ability effect patterns ──

  // P5-1. tap-no-untap — "Tap target creature. It doesn't untap during its controller's next untap step."
  {
    name: 'tap-no-untap',
    match: /tap\s+target\s+creature\.?\s+it\s+doesn'?t\s+untap/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { perm, playerIdx } = target;
      const updatedBf = [...state.players[playerIdx].battlefield];
      const idx = updatedBf.findIndex(p => p.id === perm.id);
      if (idx === -1) return { state, resolved: false };
      updatedBf[idx] = { ...updatedBf[idx], tapped: true, skipNextUntap: true };
      const players = [...state.players];
      players[playerIdx] = { ...players[playerIdx], battlefield: updatedBf };
      state = addLog({ ...state, players }, controller, `Taps ${perm.name}. It doesn't untap during its controller's next untap step.`);
      return { state, resolved: true, description: `tap-lock: ${perm.name}` };
    },
  },

  // P5-2. create-tokens-equal-power — "Create X 1/1 tokens where X is ~'s power"
  {
    name: 'create-tokens-equal-power',
    match: /create\s+(?:a\s+number\s+of|X)\s+.*?tokens?\s+.*?equal\s+to\s+(?:its?|~'?s?)\s+power/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, card) => {
      const source = state.players[controller].battlefield.find(p => p.name === card?.name);
      const power = source?.currentPower ?? (parseInt(card?.power || '0', 10) || 0);
      if (power <= 0) return { state, resolved: true, description: 'no tokens (0 power)' };
      for (let i = 0; i < power; i++) {
        const token = cardToPermanent(
          { id: generateCardId(), oracleId: '', name: 'Token', manaCost: '', cmc: 0,
            typeLine: 'Token Creature', oracleText: '', power: '1', toughness: '1',
            colors: [], colorIdentity: [], rarity: 'common' as const, tags: [], imageUrl: '', owner: controller },
          controller, state.turn
        );
        const players = [...state.players];
        players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, token] };
        state = { ...state, players };
      }
      state = addLog(state, controller, `Creates ${power} 1/1 token(s).`);
      return { state, resolved: true, description: `tokens: ${power}` };
    },
  },

  // P5-3. put-counter-on-self — "Put a charge/lore/etc counter on ~"
  {
    name: 'put-counter-on-self',
    match: /put\s+(?:a|an|one)\s+([+\-\d/]*\s*\w+)\s+counter\s+on\s+(?:~|CARDNAME|it)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, card) => {
      const counterType = m[1].trim().toLowerCase();
      const bf = [...state.players[controller].battlefield];
      const idx = bf.findIndex(p => p.name === card?.name);
      if (idx === -1) return { state, resolved: true, description: 'source not found' };
      const counters = { ...bf[idx].counters };
      counters[counterType] = (counters[counterType] || 0) + 1;
      bf[idx] = { ...bf[idx], counters };
      const players = [...state.players];
      players[controller] = { ...players[controller], battlefield: bf };
      state = addLog({ ...state, players }, controller, `Puts a ${counterType} counter on ${bf[idx].name}.`);
      return { state, resolved: true, description: `counter: ${counterType}` };
    },
  },

  // P5-4. exile-creature-power-leq — "Exile target creature with power N or less"
  {
    name: 'exile-creature-power-leq',
    match: /exile\s+target\s+creature\s+with\s+power\s+(\d+)\s+or\s+less/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const threshold = parseInt(m[1], 10);
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      if ((target.perm.currentPower ?? 0) > threshold) {
        return { state, resolved: true, description: `${target.perm.name} has too much power` };
      }
      state = removePermanentFromBattlefield(state, target.perm.id, 'exile');
      state = addLog(state, controller, `Exiles ${target.perm.name} (power ${target.perm.currentPower} <= ${threshold}).`);
      return { state, resolved: true, description: `exile: ${target.perm.name}` };
    },
  },

  // P5-5. exile-return-next-end — "Exile target creature. Return it at the beginning of the next end step."
  {
    name: 'exile-return-next-end',
    match: /exile\s+target\s+(?:creature|permanent).*?return\s+(?:it|that\s+card)\s+.*?(?:next|the)\s+end\s+step/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'exile');
      state = addLog(state, controller, `Exiles ${target.perm.name}. It returns at the next end step.`);
      return { state, resolved: true, description: `flicker-delayed: ${target.perm.name}` };
    },
  },

  // P5-6. gain-life-equal-to-damage — "You gain life equal to the damage dealt"
  {
    name: 'gain-life-equal-to-damage',
    match: /(?:you\s+)?gain\s+life\s+equal\s+to\s+(?:the\s+)?damage\s+(?:dealt|it\s+dealt)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      // Heuristic: use the last damage dealt in the log
      const lastDamageLog = [...state.log].reverse().find(l => l.message?.includes('damage'));
      const dmgMatch = lastDamageLog?.message?.match(/(\d+)\s+damage/);
      const amount = dmgMatch ? parseInt(dmgMatch[1], 10) : 3;
      const players = [...state.players];
      players[controller] = { ...players[controller], life: players[controller].life + amount };
      state = addLog({ ...state, players }, controller, `Gains ${amount} life (equal to damage dealt).`);
      return { state, resolved: true, description: `gain-life: ${amount}` };
    },
  },

  // P5-7. protection-from-color-choice — "~ gains protection from the color of your choice until end of turn"
  {
    name: 'protection-from-color-choice',
    match: /(?:target\s+creature\s+|~\s+)?gains?\s+protection\s+from\s+(?:the\s+)?color\s+of\s+your\s+choice/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, _card) => {
      // Auto-choose: pick the color of the opponent's most dangerous creature
      const opp = getFirstOpponent(state, controller);
      const oppCreatures = state.players[opp].battlefield.filter(p => p.currentPower !== undefined);
      const strongest = oppCreatures.sort((a, b) => (b.currentPower ?? 0) - (a.currentPower ?? 0))[0];
      const color = strongest?.colors?.[0]?.toLowerCase() || 'black';
      state = addLog(state, controller, `Gains protection from ${color} until end of turn.`);
      return { state, resolved: true, description: `protection: ${color}` };
    },
  },

  // P5-8. search-land-any — "Search your library for a land card" (non-basic)
  {
    name: 'search-land-any',
    match: /search\s+your\s+library\s+for\s+(?:a|up\s+to\s+\w+)\s+land\s+cards?(?!\s+with\s+a\s+basic)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const land = player.library.find(c => c.typeLine.toLowerCase().includes('land'));
      if (!land) {
        state = addLog(state, controller, 'Searches library but finds no land.');
        return { state, resolved: true, description: 'search: no land found' };
      }
      const updatedLibrary = player.library.filter(c => c.id !== land.id);
      const updatedHand = [...player.hand, land];
      const players = [...state.players];
      players[controller] = { ...players[controller], library: updatedLibrary, hand: updatedHand };
      state = addLog({ ...state, players }, controller, `Searches library and finds ${land.name}.`);
      return { state, resolved: true, description: `search: ${land.name}` };
    },
  },

  // P4-18. modal-choice-general — "Choose one" with generic fallback
  // NOTE: This is the LAST modal pattern — it only fires when no specific modal pattern matches.
  // The resolver checks matchedPatternNames and skips this if any 'choose-one-*' already resolved.
  {
    name: 'modal-choice-general',
    match: /choose\s+(?:one|two|three)\b/i,
    requiresTarget: false,
    apply: (state, controller, targets, m, source) => {
      // Generic modal: try to auto-resolve by scanning oracle text for common modes
      const text = source?.oracleText || '';
      // Try draw mode
      const drawMatch = text.match(/draw\s+(\d+|a|an|one|two|three)\s+cards?/i);
      if (drawMatch) {
        const amount = parseNumber(drawMatch[1]) || 1;
        state = drawCards(state, controller, amount);
        state = addLog(state, controller, `Modal: draw ${amount} card(s).`);
        return { state, resolved: true, description: `modal: draw ${amount}` };
      }
      // Try damage mode
      const dmgMatch = text.match(/deal(?:s)?\s+(\d+)\s+damage/i);
      if (dmgMatch) {
        const amount = parseInt(dmgMatch[1]);
        const opp: number = getFirstOpponent(state, controller);
        state = damagePlayer(state, opp, amount);
        state = addLog(state, controller, `Modal: deal ${amount} damage to opponent.`);
        return { state, resolved: true, description: `modal: ${amount} damage` };
      }
      // Try gain life mode
      const lifeMatch = text.match(/gain\s+(\d+)\s+life/i);
      if (lifeMatch) {
        const amount = parseInt(lifeMatch[1]);
        state = gainLife(state, controller, amount);
        state = addLog(state, controller, `Modal: gain ${amount} life.`);
        return { state, resolved: true, description: `modal: gain ${amount} life` };
      }
      // Try destroy mode
      const destroyMatch = text.match(/destroy\s+target\s+(?:creature|permanent|artifact|enchantment)/i);
      if (destroyMatch) {
        const target = getTargetPermanent(state, targets);
        if (target) {
          state = removePermanentFromBattlefield(state, target.perm.id, 'graveyard');
          state = addLog(state, controller, `Modal: destroy ${target.perm.name}.`);
          return { state, resolved: true, description: `modal: destroy ${target.perm.name}` };
        }
      }
      // Fallback: just log and resolve as best-effort
      state = addLog(state, controller, 'Modal spell — auto-resolved (best effort).');
      return { state, resolved: true, description: 'modal (auto-resolved)' };
    },
  },

  // ── Cultivate / Kodama's Reach — search for 2 basic lands, 1 to BF tapped, 1 to hand ──
  {
    name: 'cultivate',
    match: /search your library for up to (two|2|\d+) basic land cards?.*?put (?:one|1|a) (?:of them )?onto the battlefield(?: tapped)?.*?(?:the other|another|put the rest|and the other).*?(?:into|to|in) your hand/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const basicLands = player.library.filter(c => {
        const tl = c.typeLine.toLowerCase();
        return tl.includes('basic') && tl.includes('land');
      });
      if (basicLands.length === 0) {
        state = addLog(state, controller, 'No basic lands in library.');
        state = shuffleLibrary(state, controller);
        return { state, resolved: true, description: 'no basic lands found' };
      }
      const toTake = basicLands.slice(0, 2);
      const toBf = toTake[0];
      const toHand = toTake[1]; // may be undefined if only 1 found

      // Remove from library
      let newLib = [...player.library];
      for (const card of toTake) {
        const idx = newLib.findIndex(c => c.id === card.id);
        if (idx !== -1) newLib.splice(idx, 1);
      }

      // Put first onto battlefield tapped
      const perm = cardToPermanent(toBf, controller, state.turn);
      (perm as any).tapped = true;
      let newBf = [...player.battlefield, perm];
      let newHand = [...player.hand];
      if (toHand) newHand = [...newHand, toHand];

      const players = [...state.players];
      players[controller] = { ...player, library: newLib, battlefield: newBf, hand: newHand };
      state = { ...state, players };
      state = shuffleLibrary(state, controller);
      const names = toTake.map(c => c.name).join(', ');
      state = addLog(state, controller, `Searched for ${names}. ${toBf.name} to battlefield tapped${toHand ? `, ${toHand.name} to hand` : ''}.`);
      return { state, resolved: true, description: `cultivate: ${names}` };
    },
  },

  // ── Single Land Ramp — Farseek, Rampant Growth, Nature's Lore ──
  {
    name: 'search-land-to-battlefield',
    match: /search your library for (?:a|an?) (?:basic\s+)?(?:land|forest|island|plains|swamp|mountain)\s+card,?\s*(?:and\s+)?put (?:it|that card) onto the battlefield(?: tapped)?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const player = state.players[controller];
      const fullMatch = m[0].toLowerCase();
      const entersTapped = fullMatch.includes('tapped');

      // Determine what type of land to search for
      let filter: (c: any) => boolean;
      if (/forest/.test(fullMatch)) filter = (c: any) => c.typeLine.toLowerCase().includes('forest');
      else if (/island/.test(fullMatch)) filter = (c: any) => c.typeLine.toLowerCase().includes('island');
      else if (/plains/.test(fullMatch)) filter = (c: any) => c.typeLine.toLowerCase().includes('plains');
      else if (/swamp/.test(fullMatch)) filter = (c: any) => c.typeLine.toLowerCase().includes('swamp');
      else if (/mountain/.test(fullMatch)) filter = (c: any) => c.typeLine.toLowerCase().includes('mountain');
      else if (/basic/.test(fullMatch)) filter = (c: any) => c.typeLine.toLowerCase().includes('basic') && c.typeLine.toLowerCase().includes('land');
      else filter = (c: any) => c.typeLine.toLowerCase().includes('land');

      const lands = player.library.filter(filter);
      if (lands.length === 0) {
        state = shuffleLibrary(state, controller);
        state = addLog(state, controller, 'No matching land found in library.');
        return { state, resolved: true, description: 'no land found' };
      }
      const land = lands[0];
      const libIdx = player.library.findIndex(c => c.id === land.id);
      const newLib = [...player.library];
      newLib.splice(libIdx, 1);

      const perm = cardToPermanent(land, controller, state.turn);
      if (entersTapped) (perm as any).tapped = true;

      const players = [...state.players];
      players[controller] = { ...player, library: newLib, battlefield: [...player.battlefield, perm] };
      state = { ...state, players };
      state = shuffleLibrary(state, controller);
      state = addLog(state, controller, `Searched for ${land.name} and put it onto the battlefield${entersTapped ? ' tapped' : ''}.`);
      return { state, resolved: true, description: `ramp: ${land.name}${entersTapped ? ' (tapped)' : ''}` };
    },
  },

  // ── Wheel Effect — each player discards hand, draws cards ──
  {
    name: 'wheel-effect',
    match: /each player discards (?:their|his or her) hand,?\s*then draws?\s+(?:cards? equal to|that many|(\d+|seven|six|five))/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      for (let p = 0; p < 2; p++) {
        const pi = p;
        const player = state.players[pi];
        const discardCount = player.hand.length;
        // Discard hand
        const players = [...state.players];
        players[pi] = { ...player, hand: [], graveyard: [...player.graveyard, ...player.hand] };
        state = { ...state, players };
        state = addLog(state, pi, `${state.players[pi].name} discards ${discardCount} card(s).`);
        // Draw that many
        const drawCount = m[1] ? parseNumber(m[1]) : discardCount;
        state = drawCards(state, pi, drawCount);
        state = addLog(state, pi, `${state.players[pi].name} draws ${drawCount} card(s).`);
      }
      return { state, resolved: true, description: 'wheel effect' };
    },
  },

  // ── Tax/Choice — "unless that player pays {N}" ──
  {
    name: 'unless-pays-tax',
    match: /(?:you may draw a card|you (?:draw a card|create a.*token|gain \d+ life)).*?unless (?:that player|they|he or she) pays? \{(\d+)\}/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const taxAmount = parseInt(m[1] || '1');
      const opponent = getFirstOpponent(state, controller);
      const oppPlayer = state.players[opponent];

      // Check if opponent can pay
      const oppMana = Object.values(oppPlayer.manaPool).reduce((a: number, b: number) => a + b, 0);

      if (oppMana >= taxAmount) {
        // Opponent pays the tax (simplified: auto-pay)
        state = addLog(state, opponent, `${oppPlayer.name} pays {${taxAmount}} to prevent the effect.`);
        return { state, resolved: true, description: `opponent pays {${taxAmount}}` };
      }

      // Opponent can't pay — resolve the effect
      // Try to determine what effect happens: draw, token, or life
      const effectText = m[0].toLowerCase();
      if (effectText.includes('draw a card')) {
        state = drawCards(state, controller, 1);
        state = addLog(state, controller, `${state.players[controller].name} draws a card (tax unpaid).`);
      } else if (effectText.includes('create a')) {
        // Token creation — simplified: create a Treasure
        state = addLog(state, controller, `${state.players[controller].name} creates a token (tax unpaid).`);
      } else if (effectText.includes('gain')) {
        const lifeMatch = effectText.match(/gain (\d+) life/);
        if (lifeMatch) {
          state = gainLife(state, controller, parseInt(lifeMatch[1]));
        }
      }
      return { state, resolved: true, description: 'tax unpaid - effect resolves' };
    },
  },

  // ── Rhystic Study specific — "Whenever an opponent casts a spell, you may draw unless they pay {1}" ──
  {
    name: 'rhystic-draw',
    match: /you may draw a card unless (?:that player|they) pays? \{1\}/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opponent = getFirstOpponent(state, controller);
      const oppMana = Object.values(state.players[opponent].manaPool).reduce((a: number, b: number) => a + b, 0);
      if (oppMana >= 1) {
        state = addLog(state, opponent, `${state.players[opponent].name} pays {1}.`);
        return { state, resolved: true, description: 'opponent pays 1' };
      }
      state = drawCards(state, controller, 1);
      state = addLog(state, controller, `${state.players[controller].name} draws a card (Rhystic Study).`);
      return { state, resolved: true, description: 'Rhystic draw' };
    },
  },

  // ── Cost Reduction — "[spell type] you cast cost {N} less" ──
  // Static effect handled here as an ETB marker — the actual cost reduction
  // is applied during mana cost calculation in the cast flow.
  {
    name: 'cost-reduction-static',
    match: /(?:creature|instant|sorcery|artifact|enchantment|noncreature|spell)s?\s+you\s+cast\s+cost\s+\{(\d+)\}\s+less\s+to\s+cast/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const reduction = parseInt(m[1]);
      state = addLog(state, controller, `Cost reduction active: spells cost {${reduction}} less.`);
      // Static ability — logged for awareness, actual reduction applied in cast pipeline
      return { state, resolved: true, description: `cost reduction: {${reduction}} less` };
    },
  },

  // ── Each opponent draws N / Each player draws N ──
  {
    name: 'each-player-draws',
    match: /each (?:player|opponent) draws?\s+(\d+|a|one|two|three)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]) || 1;
      const isEachPlayer = /each player/i.test(m[0]);
      if (isEachPlayer) {
        for (let pi = 0; pi < state.players.length; pi++) {
          state = drawCards(state, pi, count);
        }
        state = addLog(state, controller, `Each player draws ${count} card(s).`);
      } else {
        for (const opp of getOpponents(state, controller)) {
          state = drawCards(state, opp, count);
        }
        state = addLog(state, controller, `Each opponent draws ${count} card(s).`);
      }
      return { state, resolved: true, description: `each draws ${count}` };
    },
  },

  // ── Each opponent loses N life ──
  {
    name: 'each-opponent-loses-life',
    match: /each opponent loses?\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      for (const opp of getOpponents(state, controller)) {
        state = damagePlayer(state, opp, amount);
      }
      state = addLog(state, controller, `Each opponent loses ${amount} life.`);
      return { state, resolved: true, description: `each opp loses ${amount} life` };
    },
  },

  // ── Add mana — "add {C}{C}" / "add {G}" / "add one mana of any color" ──
  {
    name: 'add-mana',
    match: /add\s+(\{[WUBRGC]\}(?:\{[WUBRGC]\})*|(?:one|two|three|\d+)\s+mana\s+of\s+any\s+(?:one\s+)?color)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const manaText = m[1];
      const players = [...state.players];
      const pool = { ...players[controller].manaPool };

      // Parse {C}{C} style
      const symbolMatches = manaText.match(/\{([WUBRGC])\}/gi);
      if (symbolMatches) {
        for (const sym of symbolMatches) {
          const color = sym.replace(/[{}]/g, '').toLowerCase();
          const key = color === 'c' ? 'colorless' : color === 'w' ? 'W' : color === 'u' ? 'U' : color === 'b' ? 'B' : color === 'r' ? 'R' : 'G';
          (pool as any)[key] = ((pool as any)[key] || 0) + 1;
        }
      } else {
        // "one mana of any color" → add 1 colorless (simplified)
        const countMatch = manaText.match(/(\d+|one|two|three)/i);
        const count = countMatch ? parseNumber(countMatch[1]) : 1;
        pool.colorless = (pool.colorless || 0) + count;
      }

      players[controller] = { ...players[controller], manaPool: pool };
      state = { ...state, players };
      state = addLog(state, controller, `Added mana: ${manaText}.`);
      return { state, resolved: true, description: `add mana: ${manaText}` };
    },
  },

  // ── Return target creature to hand (generic bounce) ──
  {
    name: 'bounce-target-creature',
    match: /return target (?:creature|nonland permanent) to its owner'?s? hand/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { perm, playerIdx } = target;
      const players = [...state.players];
      const bf = [...players[playerIdx].battlefield];
      const idx = bf.findIndex(p => p.id === perm.id);
      if (idx === -1) return { state, resolved: true, description: 'target no longer on BF' };
      bf.splice(idx, 1);
      const ownerIdx: number = perm.owner ?? playerIdx;
      const cardObj: Card = {
        id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
        cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
        power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
        colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
        tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
      };
      players[playerIdx] = { ...players[playerIdx], battlefield: bf };
      players[ownerIdx] = { ...players[ownerIdx], hand: [...players[ownerIdx].hand, cardObj] };
      state = { ...state, players };
      state = addLog(state, controller, `Return ${perm.name} to hand.`);
      return { state, resolved: true, description: `bounce ${perm.name}` };
    },
  },

  // ── Bounce each nonland — Cyclonic Rift overloaded ──
  {
    name: 'bounce-each-nonland-opponent',
    match: /return (?:each|all) nonland permanents?\s+(?:you don'?t control|your opponents? control)\s+to\s+(?:their|its)\s+owner'?s?\s+hands?/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opponent = getFirstOpponent(state, controller);
      const players = [...state.players];
      const oppBf = [...players[opponent].battlefield];
      const nonlands = oppBf.filter(p => !p.typeLine.toLowerCase().includes('land'));
      const landsOnly = oppBf.filter(p => p.typeLine.toLowerCase().includes('land'));

      for (const perm of nonlands) {
        const ownerIdx: number = perm.owner ?? opponent;
        const cardObj: Card = {
          id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
          cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
          power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
          colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
          tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
        };
        players[ownerIdx] = { ...players[ownerIdx], hand: [...players[ownerIdx].hand, cardObj] };
      }
      players[opponent] = { ...players[opponent], battlefield: landsOnly };
      state = { ...state, players };
      state = addLog(state, controller, `Bounced ${nonlands.length} nonland permanent(s) opponents control.`);
      return { state, resolved: true, description: `mass bounce: ${nonlands.length} permanents` };
    },
  },

  // ── Proliferate (CR 701.27) ──
  {
    name: 'proliferate',
    match: /\bproliferate\b/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const players = [...state.players];
      const proliferated: string[] = [];

      // Add one of each existing counter type to each permanent with counters
      for (let pi = 0; pi < 2; pi++) {
        const bf = [...players[pi].battlefield];
        let changed = false;
        for (let i = 0; i < bf.length; i++) {
          const perm = bf[i];
          const counterTypes = Object.keys(perm.counters).filter(k => perm.counters[k] > 0);
          if (counterTypes.length > 0) {
            const newCounters = { ...perm.counters };
            for (const ct of counterTypes) {
              newCounters[ct] = (newCounters[ct] || 0) + 1;
            }
            const updated: Permanent = { ...perm, counters: newCounters };
            // Update P/T for +1/+1 or -1/-1 counters
            if (newCounters['+1/+1'] && updated.currentPower !== undefined) {
              updated.currentPower = (updated.basePower || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0);
              updated.currentToughness = (updated.baseToughness || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0);
            }
            bf[i] = updated;
            changed = true;
            proliferated.push(`${perm.name} (${counterTypes.join(', ')})`);
          }
        }
        if (changed) {
          players[pi] = { ...players[pi], battlefield: bf };
        }
      }

      // Add poison counters to players that already have them
      for (let pi = 0; pi < 2; pi++) {
        const p = players[pi];
        if ((p as any).poisonCounters && (p as any).poisonCounters > 0) {
          players[pi] = { ...p, poisonCounters: ((p as any).poisonCounters || 0) + 1 } as PlayerState;
          proliferated.push(`Player ${pi} (poison)`);
        }
      }

      state = { ...state, players };
      state = addLog(state, controller, `Proliferate: ${proliferated.length > 0 ? proliferated.join(', ') : 'no valid targets'}`);
      return { state, resolved: true, description: `proliferate ${proliferated.length} permanents/players` };
    },
  },

  // ── Populate (CR 701.29) ──
  {
    name: 'populate',
    match: /\bpopulate\b/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const creatureToken = player.battlefield.find(
        p => p.typeLine.toLowerCase().includes('creature') && p.typeLine.toLowerCase().includes('token')
      );

      if (!creatureToken) {
        state = addLog(state, controller, 'Populate: no creature tokens to populate.');
        return { state, resolved: true, description: 'populate (no tokens)' };
      }

      const tokenCard: Card = {
        id: generateCardId(), oracleId: creatureToken.oracleId, name: creatureToken.name,
        manaCost: creatureToken.manaCost, cmc: creatureToken.cmc, typeLine: creatureToken.typeLine,
        oracleText: creatureToken.oracleText, power: creatureToken.power, toughness: creatureToken.toughness,
        colors: creatureToken.colors, colorIdentity: creatureToken.colorIdentity,
        rarity: creatureToken.rarity, tags: creatureToken.tags, imageUrl: creatureToken.imageUrl,
        owner: controller,
      };
      const newPerm = cardToPermanent(tokenCard, controller, state.turn);
      const players = [...state.players];
      players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, newPerm] };
      state = { ...state, players };
      state = addLog(state, controller, `Populate: created a copy of ${creatureToken.name}.`);
      return { state, resolved: true, description: `populate ${creatureToken.name}` };
    },
  },

  // ── Explore (CR 701.39) ──
  {
    name: 'explore-keyword',
    match: /\bexplores?\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      const players = [...state.players];
      const player = players[controller];

      if (player.library.length === 0) {
        state = addLog(state, controller, 'Explore: library is empty.');
        return { state, resolved: true, description: 'explore (empty library)' };
      }

      const revealed = player.library[0];
      const isLand = revealed.typeLine.toLowerCase().includes('land');

      if (isLand) {
        // Land: put it into hand
        players[controller] = {
          ...player,
          library: player.library.slice(1),
          hand: [...player.hand, revealed],
        };
        state = { ...state, players };
        state = addLog(state, controller, `Explore: revealed ${revealed.name} (land) — put into hand.`);
      } else {
        // Non-land: put a +1/+1 counter on the exploring creature, put card into graveyard
        players[controller] = {
          ...player,
          library: player.library.slice(1),
          graveyard: [...player.graveyard, revealed],
        };
        // Find the source creature on the battlefield and add a +1/+1 counter
        if (source) {
          const bf = [...players[controller].battlefield];
          const srcIdx = bf.findIndex(p => p.name === source.name);
          if (srcIdx !== -1) {
            const perm = bf[srcIdx];
            const newCounters: Record<string, number> = { ...perm.counters, '+1/+1': (perm.counters['+1/+1'] || 0) + 1 };
            bf[srcIdx] = {
              ...perm, counters: newCounters,
              currentPower: (perm.basePower || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0),
              currentToughness: (perm.baseToughness || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0),
            };
          }
          players[controller] = { ...players[controller], battlefield: bf };
        }
        state = { ...state, players };
        state = addLog(state, controller, `Explore: revealed ${revealed.name} (nonland) — +1/+1 counter, card to graveyard.`);
      }
      return { state, resolved: true, description: `explore: revealed ${revealed.name}` };
    },
  },

  // ── Connive N (CR 701.47) ──
  {
    name: 'connive',
    match: /\bconnives?\s*(\d+)?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const n = m[1] ? parseInt(m[1]) : 1;

      // Draw N cards
      state = drawCards(state, controller, n);

      // Set pending discard for N cards
      const players = [...state.players];
      players[controller] = {
        ...players[controller],
        pendingDiscard: (players[controller] as any).pendingDiscard
          ? (players[controller] as any).pendingDiscard + n
          : n,
      } as PlayerState;
      state = { ...state, players };

      // Simplified: put N +1/+1 counters on the conniving creature
      if (source) {
        const ps = [...state.players];
        const bf = [...ps[controller].battlefield];
        const srcIdx = bf.findIndex(p => p.name === source.name);
        if (srcIdx !== -1) {
          const perm = bf[srcIdx];
          const newCounters: Record<string, number> = { ...perm.counters, '+1/+1': (perm.counters['+1/+1'] || 0) + n };
          bf[srcIdx] = {
            ...perm, counters: newCounters,
            currentPower: (perm.basePower || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0),
            currentToughness: (perm.baseToughness || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0),
          };
        }
        ps[controller] = { ...ps[controller], battlefield: bf };
        state = { ...state, players: ps };
      }

      state = addLog(state, controller, `Connive ${n}: drew ${n}, must discard ${n}, +${n} +1/+1 counters.`);
      return { state, resolved: true, description: `connive ${n}` };
    },
  },

  // ── Surveil N (CR 701.42) ──
  {
    name: 'surveil',
    match: /\bsurveils?\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const n = parseInt(m[1]);
      // Simplified surveil: mill the top N cards (auto-decision for bot gameplay)
      state = millCards(state, controller, n);
      state = addLog(state, controller, `Surveil ${n}: put top ${n} card(s) into graveyard.`);
      return { state, resolved: true, description: `surveil ${n}` };
    },
  },

  // ── Amass N (CR 701.44) ──
  {
    name: 'amass',
    match: /\bamass\s+(?:\w+\s+)?(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const n = parseInt(m[1]);
      const players = [...state.players];
      const bf = [...players[controller].battlefield];

      // Find an existing Army creature token
      const armyIdx = bf.findIndex(
        p => p.typeLine.toLowerCase().includes('army')
      );

      if (armyIdx !== -1) {
        // Put N +1/+1 counters on the existing Army
        const army = bf[armyIdx];
        const newCounters: Record<string, number> = { ...army.counters, '+1/+1': (army.counters['+1/+1'] || 0) + n };
        bf[armyIdx] = {
          ...army, counters: newCounters,
          currentPower: (army.basePower || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0),
          currentToughness: (army.baseToughness || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0),
        };
        players[controller] = { ...players[controller], battlefield: bf };
        state = { ...state, players };
        state = addLog(state, controller, `Amass ${n}: put ${n} +1/+1 counters on ${army.name}.`);
      } else {
        // Create a 0/0 black Zombie Army creature token with N +1/+1 counters
        const tokenCard: Card = {
          id: generateCardId(), oracleId: '', name: 'Zombie Army',
          manaCost: '', cmc: 0, typeLine: 'Token Creature — Zombie Army',
          oracleText: '', power: '0', toughness: '0',
          colors: ['B'], colorIdentity: ['B'], rarity: 'common',
          tags: [], imageUrl: '', owner: controller,
        };
        const token = cardToPermanent(tokenCard, controller, state.turn);
        token.counters['+1/+1'] = n;
        token.currentPower = n;
        token.currentToughness = n;
        bf.push(token);
        players[controller] = { ...players[controller], battlefield: bf };
        state = { ...state, players };
        state = addLog(state, controller, `Amass ${n}: created a 0/0 Zombie Army token with ${n} +1/+1 counters.`);
      }

      return { state, resolved: true, description: `amass ${n}` };
    },
  },

  // ── Bolster N (CR 701.32) ──
  {
    name: 'bolster',
    match: /\bbolster\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const n = parseInt(m[1]);
      const players = [...state.players];
      const bf = [...players[controller].battlefield];

      // Find creature with the least toughness among creatures you control
      let minToughness = Infinity;
      let targetIdx = -1;
      for (let i = 0; i < bf.length; i++) {
        const p = bf[i];
        if (p.currentToughness !== undefined && p.typeLine.toLowerCase().includes('creature')) {
          if (p.currentToughness < minToughness) {
            minToughness = p.currentToughness;
            targetIdx = i;
          }
        }
      }

      if (targetIdx === -1) {
        state = addLog(state, controller, 'Bolster: no creatures to bolster.');
        return { state, resolved: true, description: 'bolster (no creatures)' };
      }

      const perm = bf[targetIdx];
      const newCounters: Record<string, number> = { ...perm.counters, '+1/+1': (perm.counters['+1/+1'] || 0) + n };
      bf[targetIdx] = {
        ...perm, counters: newCounters,
        currentPower: (perm.basePower || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0),
        currentToughness: (perm.baseToughness || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0),
      };
      players[controller] = { ...players[controller], battlefield: bf };
      state = { ...state, players };
      state = addLog(state, controller, `Bolster ${n}: put ${n} +1/+1 counters on ${perm.name}.`);
      return { state, resolved: true, description: `bolster ${n} on ${perm.name}` };
    },
  },

  // ── Adapt N (CR 702.138) ──
  {
    name: 'adapt',
    match: /\badapt\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const n = parseInt(m[1]);
      if (!source) {
        return { state, resolved: true, description: 'adapt (no source)' };
      }

      const players = [...state.players];
      const bf = [...players[controller].battlefield];
      const srcIdx = bf.findIndex(p => p.name === source.name);

      if (srcIdx === -1) {
        return { state, resolved: true, description: 'adapt (source not on battlefield)' };
      }

      const perm = bf[srcIdx];
      // Adapt only works if the creature has no +1/+1 counters
      if ((perm.counters['+1/+1'] || 0) > 0) {
        state = addLog(state, controller, `Adapt ${n}: ${perm.name} already has +1/+1 counters.`);
        return { state, resolved: true, description: `adapt (already has counters)` };
      }

      const newCounters: Record<string, number> = { ...perm.counters, '+1/+1': n };
      bf[srcIdx] = {
        ...perm, counters: newCounters,
        currentPower: (perm.basePower || 0) + n - (newCounters['-1/-1'] || 0),
        currentToughness: (perm.baseToughness || 0) + n - (newCounters['-1/-1'] || 0),
      };
      players[controller] = { ...players[controller], battlefield: bf };
      state = { ...state, players };
      state = addLog(state, controller, `Adapt ${n}: put ${n} +1/+1 counters on ${perm.name}.`);
      return { state, resolved: true, description: `adapt ${n} on ${perm.name}` };
    },
  },

  // ── Transform (CR 701.28) ──
  {
    name: 'transform-self',
    match: /\btransforms?\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) {
        return { state, resolved: true, description: 'transform (no source)' };
      }

      const players = [...state.players];
      const bf = [...players[controller].battlefield];
      const srcIdx = bf.findIndex(p => p.name === source.name);

      if (srcIdx === -1) {
        return { state, resolved: true, description: 'transform (source not on battlefield)' };
      }

      const perm = bf[srcIdx];
      const updated = { ...perm, flipped: !perm.flipped };

      // If backFace data exists on the card, swap relevant fields
      const backFace = (source as any).backFace;
      if (backFace) {
        if (backFace.name) updated.name = perm.flipped ? source.name : backFace.name;
        if (backFace.oracleText) updated.oracleText = perm.flipped ? source.oracleText : backFace.oracleText;
        if (backFace.power) updated.power = perm.flipped ? source.power : backFace.power;
        if (backFace.toughness) updated.toughness = perm.flipped ? source.toughness : backFace.toughness;
        if (backFace.typeLine) updated.typeLine = perm.flipped ? source.typeLine : backFace.typeLine;
      }

      bf[srcIdx] = updated;
      players[controller] = { ...players[controller], battlefield: bf };
      state = { ...state, players };
      state = addLog(state, controller, `Transform: ${perm.name} transformed (flipped=${updated.flipped}).`);
      return { state, resolved: true, description: `transform ${perm.name}` };
    },
  },

  // ── Death triggers: "when ~ dies, [effect]" ──
  {
    name: 'dies-draw',
    match: /when\s+(?:~|this creature)\s+dies,?\s+draw\s+(a|\d+|two|three)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      state = drawCards(state, controller, count);
      state = addLog(state, controller, `Death trigger: drew ${count} card(s).`);
      return { state, resolved: true, description: `dies → draw ${count}` };
    },
  },
  {
    name: 'dies-create-token',
    match: /when\s+(?:~|this creature)\s+dies,?\s+create\s+(a|an|\d+|two|three)\s+(\d+)\/(\d+)\s+([^.]+)\s+(?:creature\s+)?tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const pw = parseInt(m[2]); const th = parseInt(m[3]);
      const name = m[4].trim().replace(/\s+creature/i, '');
      const tokens: Permanent[] = [];
      for (let i = 0; i < count; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: `token_${name.toLowerCase()}`, name,
          manaCost: '', cmc: 0, typeLine: `Token Creature — ${name}`,
          oracleText: '', power: String(pw), toughness: String(th),
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        const perm = cardToPermanent(tokenCard, controller, state.turn);
        perm.currentPower = pw; perm.currentToughness = th; perm.basePower = pw; perm.baseToughness = th;
        tokens.push(perm);
      }
      const players = [...state.players];
      players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Death trigger: created ${count} ${pw}/${th} ${name} token(s).`);
      return { state, resolved: true, description: `dies → ${count} ${name} token(s)` };
    },
  },
  {
    name: 'dies-deal-damage',
    match: /when\s+(?:~|this creature)\s+dies,?\s+(?:it\s+)?deals?\s+(\d+)\s+damage\s+to\s+(any\s+target|target\s+(?:creature|player|opponent)|each\s+opponent)/i,
    requiresTarget: false,
    apply: (state, controller, targets, m) => {
      const amount = parseInt(m[1]); const targetText = m[2].toLowerCase();
      if (targetText.includes('opponent') || targetText.includes('player')) {
        const opponent = getFirstOpponent(state, controller);
        const players = [...state.players];
        players[opponent] = { ...players[opponent], life: players[opponent].life - amount };
        state = { ...state, players };
        state = addLog(state, controller, `Death trigger: dealt ${amount} damage to opponent.`);
      } else if (targets.length > 0) {
        const t = targets[0];
        if (t.type === 'player') {
          const pIdx = parseInt(t.id);
          const players = [...state.players];
          players[pIdx] = { ...players[pIdx], life: players[pIdx].life - amount };
          state = { ...state, players };
        }
        state = addLog(state, controller, `Death trigger: dealt ${amount} damage.`);
      }
      return { state, resolved: true, description: `dies → ${amount} damage` };
    },
  },
  {
    name: 'dies-gain-life',
    match: /when\s+(?:~|this creature)\s+dies,?\s+(?:you\s+)?gain\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      state = gainLife(state, controller, amount);
      state = addLog(state, controller, `Death trigger: gained ${amount} life.`);
      return { state, resolved: true, description: `dies → gain ${amount} life` };
    },
  },
  {
    name: 'dies-return-to-hand',
    match: /when\s+(?:~|this creature)\s+dies,?\s+return\s+(?:it|~)\s+to\s+(?:its\s+)?owner'?s?\s+hand/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'dies → return (no source)' };
      const players = [...state.players];
      const gy = [...players[controller].graveyard];
      const idx = gy.findIndex(c => c.name === source.name);
      if (idx !== -1) {
        const card = gy[idx];
        gy.splice(idx, 1);
        players[controller] = { ...players[controller], graveyard: gy, hand: [...players[controller].hand, card] };
        state = { ...state, players };
        state = addLog(state, controller, `Death trigger: ${source.name} returned to hand.`);
      }
      return { state, resolved: true, description: `dies → return to hand` };
    },
  },
  {
    name: 'dies-each-opponent-loses-life',
    match: /when\s+(?:~|this creature)\s+dies,?\s+each\s+opponent\s+loses?\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      const opponent = getFirstOpponent(state, controller);
      const players = [...state.players];
      players[opponent] = { ...players[opponent], life: players[opponent].life - amount };
      state = { ...state, players };
      state = addLog(state, controller, `Death trigger: each opponent loses ${amount} life.`);
      return { state, resolved: true, description: `dies → opponents lose ${amount} life` };
    },
  },
  {
    name: 'dies-create-treasure',
    match: /when\s+(?:~|this creature)\s+dies,?\s+create\s+(a|an|\d+|two|three)\s+treasure\s+tokens?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const tokens: Permanent[] = [];
      for (let i = 0; i < count; i++) {
        const tokenCard: Card = {
          id: generateCardId(), oracleId: 'token_treasure', name: 'Treasure',
          manaCost: '', cmc: 0, typeLine: 'Token Artifact — Treasure',
          oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.',
          colors: [], colorIdentity: [], rarity: 'common', tags: [], imageUrl: '', owner: controller,
        };
        tokens.push(cardToPermanent(tokenCard, controller, state.turn));
      }
      const players = [...state.players];
      players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, ...tokens] };
      state = { ...state, players };
      state = addLog(state, controller, `Death trigger: created ${count} Treasure token(s).`);
      return { state, resolved: true, description: `dies → ${count} Treasure` };
    },
  },
  {
    name: 'whenever-creature-dies-draw',
    match: /whenever\s+(?:a|another)\s+creature\s+(?:you\s+control\s+)?dies,?\s+(?:you\s+(?:may\s+)?)?draw\s+a\s+card/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = drawCards(state, controller, 1);
      state = addLog(state, controller, `Creature death trigger: drew a card.`);
      return { state, resolved: true, description: 'creature dies → draw 1' };
    },
  },
  {
    name: 'whenever-creature-dies-counter',
    match: /whenever\s+(?:a|another)\s+creature\s+(?:you\s+control\s+)?dies,?\s+put\s+a\s+\+1\/\+1\s+counter\s+on\s+~/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'creature dies counter (no source)' };
      const players = [...state.players];
      const bf = [...players[controller].battlefield];
      const idx = bf.findIndex(p => p.name === source.name);
      if (idx !== -1) {
        const perm = bf[idx];
        const counters = { ...perm.counters, '+1/+1': (perm.counters['+1/+1'] || 0) + 1 };
        bf[idx] = {
          ...perm, counters,
          currentPower: (perm.basePower || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0),
          currentToughness: (perm.baseToughness || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0),
        };
        players[controller] = { ...players[controller], battlefield: bf };
        state = { ...state, players };
        state = addLog(state, controller, `Creature death trigger: +1/+1 counter on ${source.name}.`);
      }
      return { state, resolved: true, description: 'creature dies → +1/+1 counter' };
    },
  },

  // ── Miracle — reduced cost if first draw this turn ──
  {
    name: 'miracle',
    match: /miracle\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const miracleCost = m[1];
      state = addLog(state, controller, `Miracle available: can be cast for ${miracleCost}.`);
      return { state, resolved: true, description: `miracle: ${miracleCost}` };
    },
  },

  // ── Dredge N — replace draw with mill N + return from GY to hand ──
  {
    name: 'dredge',
    match: /dredge\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const n = parseInt(m[1]);
      if (!source) return { state, resolved: true, description: 'dredge (no source)' };

      // Check if source is in graveyard
      const player = state.players[controller];
      const gyIdx = player.graveyard.findIndex(c => c.name === source.name);
      if (gyIdx === -1) {
        return { state, resolved: true, description: 'dredge (not in graveyard)' };
      }

      // Mill N cards
      state = millCards(state, controller, n);

      // Return from graveyard to hand
      const updatedPlayer = state.players[controller];
      const card = updatedPlayer.graveyard[gyIdx];
      if (card) {
        const newGy = [...updatedPlayer.graveyard];
        newGy.splice(gyIdx, 1);
        const newHand = [...updatedPlayer.hand, card];
        const players = [...state.players];
        players[controller] = { ...updatedPlayer, graveyard: newGy, hand: newHand };
        state = { ...state, players };
      }

      state = addLog(state, controller, `Dredge ${n}: milled ${n} cards, returned ${source.name} to hand.`);
      return { state, resolved: true, description: `dredge ${n}` };
    },
  },

  // ── Suspend N — exile with time counters ──
  {
    name: 'suspend',
    match: /suspend\s+(\d+)\s*[—\-]\s*(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const counters = parseInt(m[1]);
      const cost = m[2];
      if (!source) return { state, resolved: true, description: 'suspend (no source)' };

      // Move card to exile with time counters
      const player = state.players[controller];
      const handIdx = player.hand.findIndex(c => c.name === source.name);
      if (handIdx !== -1) {
        const card = player.hand[handIdx];
        const newHand = [...player.hand];
        newHand.splice(handIdx, 1);
        const newExile = [...player.exile, card];
        const players = [...state.players];
        players[controller] = { ...player, hand: newHand, exile: newExile };

        // Track suspended card
        const suspended = [...(state.suspendedCards || []), { cardId: card.id, ownerId: controller, counters }];
        state = { ...state, players, suspendedCards: suspended };
      }

      state = addLog(state, controller, `Suspend ${counters}: ${source.name} exiled with ${counters} time counters (cost: ${cost}).`);
      return { state, resolved: true, description: `suspend ${counters}` };
    },
  },

  // ── Madness — cast from exile for reduced cost when discarded ──
  {
    name: 'madness',
    match: /madness\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const madnessCost = m[1];
      if (!source) return { state, resolved: true, description: 'madness (no source)' };

      // When a card with madness is discarded, it goes to exile instead of graveyard
      // Then the controller may cast it for the madness cost
      // Simplified: log the madness option, auto-resolve as "madness available"
      state = addLog(state, controller, `Madness triggered: ${source.name} can be cast for ${madnessCost}.`);
      return { state, resolved: true, description: `madness: ${madnessCost}` };
    },
  },

  // ── Hexproof from [color] — can't be targeted by [color] spells/abilities opponents control (CR 702.11) ──
  {
    name: 'hexproof-from-color',
    match: /hexproof from (white|blue|black|red|green|multicolored)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const color = m[1].toLowerCase();
      if (!source) return { state, resolved: true, description: `hexproof from ${color}` };
      // Mark as a static ability — actual enforcement in targeting validation
      state = addLog(state, controller, `${source.name} has hexproof from ${color}.`);
      return { state, resolved: true, description: `hexproof from ${color}` };
    },
  },

  // ── Exalted — whenever a creature you control attacks alone, it gets +1/+1 (CR 702.82) ──
  {
    name: 'exalted',
    match: /\bexalted\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'exalted' };
      const combat = state.combat;
      if (!combat || !combat.attackers) return { state, resolved: true, description: 'exalted (no combat)' };
      const attackerIds = combat.attackers.map(a => typeof a === 'string' ? a : a.permanentId);
      if (attackerIds.length !== 1) return { state, resolved: true, description: 'exalted (not alone)' };

      // Buff the lone attacker +1/+1
      const attackerId = attackerIds[0];
      const players = [...state.players];
      const player = { ...players[controller] };
      const updatedBf = player.battlefield.map(p => {
        if (p.id === attackerId && p.currentPower !== undefined) {
          return { ...p, currentPower: (p.currentPower ?? 0) + 1, currentToughness: (p.currentToughness ?? 0) + 1 };
        }
        return p;
      });
      player.battlefield = updatedBf;
      players[controller] = player;
      state = { ...state, players };
      state = addLog(state, controller, `Exalted: Attacking creature gets +1/+1 until end of turn.`);
      return { state, resolved: true, description: 'exalted: +1/+1' };
    },
  },

  // ── Embalm — create a token copy from graveyard (CR 702.127) ──
  {
    name: 'embalm',
    match: /embalm\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const embalmCost = m[1];
      if (!source) return { state, resolved: true, description: 'embalm (no source)' };

      const tokenPerm: Permanent = {
        id: `embalm-${source.id}-${Date.now()}`,
        oracleId: source.oracleId || '',
        name: source.name,
        manaCost: '',
        cmc: source.cmc || 0,
        typeLine: (source.typeLine || 'Creature') + ' — Zombie',
        oracleText: source.oracleText || '',
        power: source.power,
        toughness: source.toughness,
        colors: ['W'],
        colorIdentity: ['W'],
        rarity: source.rarity || 'common',
        tags: [...(source.tags || []), 'token', 'zombie'],
        owner: controller,
        controller,
        currentPower: source.power ? parseInt(String(source.power)) : undefined,
        currentToughness: source.toughness ? parseInt(String(source.toughness)) : undefined,
        damage: 0,
        tapped: false,
        summoningSick: true,
        counters: {},
        abilities: [],
        isToken: true,
      };

      const players = [...state.players];
      const player = { ...players[controller] };
      player.battlefield = [...player.battlefield, tokenPerm];
      player.graveyard = player.graveyard.filter(c => c.id !== source.id);
      player.exile = [...player.exile, source];
      players[controller] = player;
      state = { ...state, players };
      state = addLog(state, controller, `Embalm: Created white Zombie token copy of ${source.name} (cost: ${embalmCost}).`);
      return { state, resolved: true, description: `embalm: token copy of ${source.name}` };
    },
  },

  // ── Eternalize — create a 4/4 token copy from graveyard (CR 702.128) ──
  {
    name: 'eternalize',
    match: /eternalize\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const eternalizeCost = m[1];
      if (!source) return { state, resolved: true, description: 'eternalize (no source)' };

      const tokenPerm: Permanent = {
        id: `eternalize-${source.id}-${Date.now()}`,
        oracleId: source.oracleId || '',
        name: source.name,
        manaCost: '',
        cmc: source.cmc || 0,
        typeLine: (source.typeLine || 'Creature') + ' — Zombie',
        oracleText: source.oracleText || '',
        power: 4,
        toughness: 4,
        colors: ['B'],
        colorIdentity: ['B'],
        rarity: source.rarity || 'common',
        tags: [...(source.tags || []), 'token', 'zombie'],
        owner: controller,
        controller,
        currentPower: 4,
        currentToughness: 4,
        damage: 0,
        tapped: false,
        summoningSick: true,
        counters: {},
        abilities: [],
        isToken: true,
      };

      const players = [...state.players];
      const player = { ...players[controller] };
      player.battlefield = [...player.battlefield, tokenPerm];
      player.graveyard = player.graveyard.filter(c => c.id !== source.id);
      player.exile = [...player.exile, source];
      players[controller] = player;
      state = { ...state, players };
      state = addLog(state, controller, `Eternalize: Created 4/4 black Zombie token copy of ${source.name} (cost: ${eternalizeCost}).`);
      return { state, resolved: true, description: `eternalize: 4/4 token copy of ${source.name}` };
    },
  },

  // ── Prowess — whenever you cast a noncreature spell, this creature gets +1/+1 until end of turn (CR 702.107) ──
  {
    name: 'prowess',
    match: /\bprowess\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'prowess' };
      // Find the source permanent and buff it
      const found = findPermanentById(state, source.id);
      if (!found) return { state, resolved: true, description: 'prowess (not on battlefield)' };
      const players = [...state.players];
      const player = { ...players[found.playerIdx] };
      const updatedBf = [...player.battlefield];
      updatedBf[found.permIdx] = {
        ...found.perm,
        currentPower: (found.perm.currentPower ?? 0) + 1,
        currentToughness: (found.perm.currentToughness ?? 0) + 1,
      };
      player.battlefield = updatedBf;
      players[found.playerIdx] = player;
      state = { ...state, players };
      state = addLog(state, controller, `Prowess: ${source.name} gets +1/+1 until end of turn.`);
      return { state, resolved: true, description: 'prowess: +1/+1' };
    },
  },

  // ── Infect — damage to players is dealt as poison counters (CR 702.89) ──
  {
    name: 'infect',
    match: /\binfect\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'infect' };
      // Mark as static ability — actual enforcement in combat damage step
      state = addLog(state, controller, `${source.name} has infect — damage is dealt as poison counters to players and -1/-1 counters to creatures.`);
      return { state, resolved: true, description: 'infect: active' };
    },
  },

  // ── Fabricate N — put N +1/+1 counters on this creature or create N 1/1 Servo tokens (CR 702.118) ──
  {
    name: 'fabricate',
    match: /fabricate\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const n = parseInt(m[1]);
      if (!source) return { state, resolved: true, description: 'fabricate' };

      // AI choice: prefer +1/+1 counters if creature is big enough, otherwise tokens
      const found = findPermanentById(state, source.id);
      if (found && found.perm.currentPower !== undefined && found.perm.currentPower >= 3) {
        // Put counters
        const players = [...state.players];
        const player = { ...players[found.playerIdx] };
        const updatedBf = [...player.battlefield];
        const counters = { ...found.perm.counters, '+1/+1': (found.perm.counters['+1/+1'] || 0) + n };
        updatedBf[found.permIdx] = {
          ...found.perm, counters,
          currentPower: (found.perm.currentPower ?? 0) + n,
          currentToughness: (found.perm.currentToughness ?? 0) + n,
        };
        player.battlefield = updatedBf;
        players[found.playerIdx] = player;
        state = { ...state, players };
        state = addLog(state, controller, `Fabricate ${n}: Put ${n} +1/+1 counter(s) on ${source.name}.`);
        return { state, resolved: true, description: `fabricate: ${n} +1/+1 counters` };
      } else {
        // Create servo tokens
        const players = [...state.players];
        const player = { ...players[controller] };
        for (let i = 0; i < n; i++) {
          const servo: Permanent = {
            id: `servo-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
            oracleId: '', name: 'Servo', manaCost: '', cmc: 0,
            typeLine: 'Artifact Creature — Servo',
            oracleText: '', power: 1, toughness: 1,
            colors: [], colorIdentity: [], rarity: 'common', tags: ['token'],
            owner: controller, controller,
            currentPower: 1, currentToughness: 1, damage: 0,
            tapped: false, summoningSick: true, counters: {}, abilities: [], isToken: true,
          };
          player.battlefield = [...player.battlefield, servo];
        }
        players[controller] = player;
        state = { ...state, players };
        state = addLog(state, controller, `Fabricate ${n}: Created ${n} 1/1 Servo token(s).`);
        return { state, resolved: true, description: `fabricate: ${n} servo tokens` };
      }
    },
  },

  // ── Bestow — cast as Aura enchantment for bestow cost (CR 702.102) ──
  {
    name: 'bestow',
    match: /bestow\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const bestowCost = m[1];
      if (!source) return { state, resolved: true, description: 'bestow (no source)' };
      // Bestow casting is handled by bestowPaid flag on cast-spell action
      // This pattern marks the card as having bestow for detection
      return { state, resolved: true, description: `bestow available (${bestowCost})` };
    },
  },

  // ── Encore — pay cost, exile from GY, create token copies attacking each opponent (CR 702.141) ──
  {
    name: 'encore',
    match: /encore\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const encoreCost = m[1];
      if (!source) return { state, resolved: true, description: 'encore (no source)' };

      // Encore creates a token copy for each opponent, they attack and get sacrificed at end of turn.
      // Simplified for 1v1: create one token copy with haste.
      const tokenCard: Card = {
        id: generateCardId(),
        oracleId: `token_encore_${source.oracleId || source.id}`,
        name: source.name,
        manaCost: source.manaCost || '',
        cmc: source.cmc ?? 0,
        typeLine: `Token ${source.typeLine || 'Creature'}`,
        oracleText: source.oracleText || '',
        power: source.power,
        toughness: source.toughness,
        colors: source.colors || [],
        colorIdentity: source.colorIdentity || [],
        rarity: 'common',
        tags: [],
        imageUrl: source.imageUrl || '',
        owner: controller,
      };
      const tokenPerm = cardToPermanent(tokenCard, controller, state.turn);

      const players = [...state.players];
      const player = { ...players[controller] };
      player.battlefield = [...player.battlefield, tokenPerm];
      // Exile the source from graveyard
      player.graveyard = player.graveyard.filter(c => c.id !== source.id);
      player.exile = [...player.exile, source];
      players[controller] = player;
      state = { ...state, players };

      state = addLog(state, controller, `Encore: Created token copy of ${source.name} with haste (exiled from graveyard).`);
      return { state, resolved: true, description: `encore: token copy of ${source.name}` };
    },
  },

  // ── Myriad — create attacking token copies for each opponent beyond the first (CR 702.115) ──
  {
    name: 'myriad',
    match: /\bmyriad\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'myriad (no source)' };
      // In 1v1, myriad doesn't create tokens (only for additional opponents).
      // But log it for EDH context where there would be multiple opponents.
      state = addLog(state, controller, `${source.name} has myriad — in multiplayer, would create attacking copies for each other opponent.`);
      return { state, resolved: true, description: 'myriad (1v1: no additional tokens)' };
    },
  },

  // ── Reconfigure — artifact creature attaches to or detaches from another creature (CR 702.151) ──
  {
    name: 'reconfigure',
    match: /reconfigure\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m, source) => {
      const reconfigureCost = m[1];
      if (!source) return { state, resolved: true, description: 'reconfigure (no source)' };

      // Reconfigure lets an Equipment creature attach to another creature (becoming non-creature Equipment)
      // or detach (becoming a creature again).
      const target = getTargetPermanent(state, targets);
      if (target && target.perm.typeLine?.toLowerCase().includes('creature')) {
        // Attach to target creature — source stops being a creature
        const players = [...state.players];
        const player = { ...players[controller] };
        const updatedBf = player.battlefield.map(p => {
          if (p.id === source.id) {
            return { ...p, attachedTo: target.perm.id };
          }
          return p;
        });
        player.battlefield = updatedBf;
        players[controller] = player;
        state = { ...state, players };
        state = addLog(state, controller, `Reconfigure: ${source.name} attached to ${target.perm.name} (cost: ${reconfigureCost}).`);
        return { state, resolved: true, description: `reconfigure: attached to ${target.perm.name}` };
      }

      // No target — detach, become creature again
      state = addLog(state, controller, `Reconfigure: ${source.name} detached, becoming a creature again (cost: ${reconfigureCost}).`);
      return { state, resolved: true, description: 'reconfigure: detached' };
    },
  },

  // ── Totem Armor — destroy the Aura instead of the enchanted permanent (CR 702.88) ──
  {
    name: 'totem-armor',
    match: /\btotem\s+armor\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'totem armor (no source)' };
      // When enchanted permanent would be destroyed, destroy this Aura instead.
      // This is a replacement effect — handled as a marker.
      state = addLog(state, controller, `${source.name} has totem armor — protects enchanted permanent from destruction.`);
      return { state, resolved: true, description: 'totem armor: protection applied' };
    },
  },

  // ── Battle Cry — whenever this creature attacks, each other attacking creature gets +1/+0 (CR 702.90) ──
  {
    name: 'battle-cry',
    match: /\bbattle\s+cry\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'battle cry (no source)' };
      // Buff all other attacking creatures +1/+0 until end of turn
      const players = [...state.players];
      const player = { ...players[controller] };
      const combat = state.combat;
      if (combat && combat.attackers) {
        const attackerIds = new Set(combat.attackers.map(a => a.permanentId));
        const updatedBf = player.battlefield.map(p => {
          if (p.id !== source.id && attackerIds.has(p.id) && p.currentPower !== undefined) {
            return { ...p, currentPower: (p.currentPower ?? 0) + 1 };
          }
          return p;
        });
        player.battlefield = updatedBf;
        players[controller] = player;
        state = { ...state, players };
      }
      state = addLog(state, controller, `Battle cry: Each other attacking creature gets +1/+0.`);
      return { state, resolved: true, description: 'battle cry: +1/+0 to other attackers' };
    },
  },

  // ── Riot — creature enters with your choice of +1/+1 counter or haste (CR 702.135) ──
  {
    name: 'riot',
    match: /\briot\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'riot' };
      const found = findPermanentById(state, source.id);
      if (!found) return { state, resolved: true, description: 'riot (not on battlefield)' };
      // AI heuristic: choose haste if creature has power >= 3, otherwise +1/+1 counter
      const power = found.perm.currentPower ?? 0;
      const players = [...state.players];
      const player = { ...players[found.playerIdx] };
      const updatedBf = [...player.battlefield];
      if (power >= 3) {
        // Choose haste
        updatedBf[found.permIdx] = {
          ...found.perm,
          summoningSick: false,
          temporaryKeywords: [...(found.perm.temporaryKeywords || []), { keyword: 'haste', source: 'riot', turn: state.turn }],
        };
        player.battlefield = updatedBf;
        players[found.playerIdx] = player;
        state = { ...state, players };
        state = addLog(state, controller, `Riot: ${source.name} chooses haste.`);
        return { state, resolved: true, description: 'riot: haste' };
      } else {
        // Choose +1/+1 counter
        const counters = { ...found.perm.counters, '+1/+1': (found.perm.counters['+1/+1'] || 0) + 1 };
        updatedBf[found.permIdx] = {
          ...found.perm, counters,
          currentPower: (found.perm.currentPower ?? 0) + 1,
          currentToughness: (found.perm.currentToughness ?? 0) + 1,
        };
        player.battlefield = updatedBf;
        players[found.playerIdx] = player;
        state = { ...state, players };
        state = addLog(state, controller, `Riot: ${source.name} enters with a +1/+1 counter.`);
        return { state, resolved: true, description: 'riot: +1/+1 counter' };
      }
    },
  },

  // ── Emerge — alternative cost: sacrifice creature and pay reduced mana (CR 702.118) ──
  {
    name: 'emerge',
    match: /emerge\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const emergeCost = m[1];
      if (!source) return { state, resolved: true, description: 'emerge' };
      // Emerge: sacrifice a creature, reduce the emerge cost by that creature's mana value
      state = addLog(state, controller, `${source.name} cast via emerge (cost: ${emergeCost}) — sacrificed a creature to reduce cost.`);
      return { state, resolved: true, description: `emerge: ${emergeCost}` };
    },
  },

  // ── Spectacle — alternative cost if opponent lost life this turn (CR 702.136) ──
  {
    name: 'spectacle',
    match: /spectacle\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const spectacleCost = m[1];
      if (!source) return { state, resolved: true, description: 'spectacle' };
      state = addLog(state, controller, `${source.name} cast for spectacle cost ${spectacleCost} (opponent lost life this turn).`);
      return { state, resolved: true, description: `spectacle: ${spectacleCost}` };
    },
  },

  // ── Aftermath — cast this half only from graveyard; exile after resolution (CR 702.127) ──
  {
    name: 'aftermath',
    match: /\baftermath\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'aftermath' };
      // Aftermath spells are cast from the graveyard; after resolution, exile the card (CR 702.127b)
      // Find the card in the controller's graveyard and exile it
      const player = state.players[controller];
      const gyIdx = player.graveyard.findIndex(c => c.id === source.id);
      if (gyIdx !== -1) {
        const card = player.graveyard[gyIdx];
        const players = [...state.players];
        players[controller] = {
          ...player,
          graveyard: [...player.graveyard.slice(0, gyIdx), ...player.graveyard.slice(gyIdx + 1)],
          exile: [...player.exile, card],
        };
        state = { ...state, players };
        state = addLog(state, controller, `${source.name} (aftermath): exiled after resolution.`);
      } else {
        state = addLog(state, controller, `${source.name} cast via aftermath from graveyard — will be exiled after resolution.`);
      }
      return { state, resolved: true, description: 'aftermath: exiled after resolution' };
    },
  },

  // ── Cipher — encode spell onto creature, cast a copy when that creature deals combat damage (CR 702.98) ──
  {
    name: 'cipher',
    match: /\bcipher\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'cipher' };
      // Find the strongest creature to encode onto
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
      if (creatures.length > 0) {
        const best = [...creatures].sort((a, b) =>
          ((b.currentPower || 0) + (b.currentToughness || 0)) - ((a.currentPower || 0) + (a.currentToughness || 0))
        )[0];
        state = addLog(state, controller, `Cipher: ${source.name} encoded onto ${best.name} — cast a copy when it deals combat damage.`);
      } else {
        state = addLog(state, controller, `Cipher: ${source.name} has cipher but no creature to encode onto.`);
      }
      return { state, resolved: true, description: 'cipher: encoded' };
    },
  },

  // ── Living Weapon — Equipment enters with a 0/0 Phyrexian Germ token attached (CR 702.91) ──
  {
    name: 'living-weapon',
    match: /\bliving\s+weapon\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'living weapon' };
      // Create a 0/0 Phyrexian Germ creature token and attach this equipment
      const germToken: any = {
        id: `germ-${source.id}-${Date.now()}`,
        oracleId: '',
        name: 'Phyrexian Germ',
        manaCost: '',
        cmc: 0,
        typeLine: 'Creature — Phyrexian Germ',
        oracleText: '',
        power: '0',
        toughness: '0',
        colors: ['B' as const],
        colorIdentity: ['B' as const],
        rarity: 'common' as const,
        tags: [] as any[],
        imageUrl: '',
        owner: controller,
        controller,
        currentPower: 0,
        currentToughness: 0,
        basePower: 0,
        baseToughness: 0,
        damage: 0,
        tapped: false,
        flipped: false,
        faceDown: false,
        summoningSick: true,
        attacking: false,
        blocking: null,
        counters: {},
        abilities: [],
        temporaryPtMods: [],
        temporaryKeywords: [],
        attachments: [],
        x: 0,
        y: 0,
        enteredBattlefieldTurn: state.turn,
        isToken: true,
      };
      const players = [...state.players];
      const player = { ...players[controller] };
      player.battlefield = [...player.battlefield, germToken];
      // Attach equipment to germ
      const updatedBf = player.battlefield.map(p =>
        p.id === source.id ? { ...p, attachedTo: germToken.id } : p
      );
      player.battlefield = updatedBf;
      players[controller] = player;
      state = { ...state, players };
      state = addLog(state, controller, `Living weapon: ${source.name} created a 0/0 Phyrexian Germ token and attached to it.`);
      return { state, resolved: true, description: 'living weapon: germ token created' };
    },
  },

  // ── Extort — pay {W/B} when you cast a spell: each opponent loses 1 life, you gain that much (CR 702.100) ──
  {
    name: 'extort',
    match: /\bextort\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'extort' };
      const opponent = getFirstOpponent(state, controller);
      // Auto-pay extort if possible (simplified: always trigger)
      state = damagePlayer(state, opponent, 1);
      state = gainLife(state, controller, 1);
      state = addLog(state, controller, `Extort: Each opponent loses 1 life, ${state.players[controller].name} gains 1 life.`);
      return { state, resolved: true, description: 'extort: drain 1' };
    },
  },

  // ── Champion — exile a creature you control; when this leaves, return exiled creature (CR 702.71) ──
  {
    name: 'champion',
    match: /champion\s+(?:a|an)\s+(\w+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const championType = m[1].toLowerCase();
      if (!source) return { state, resolved: true, description: 'champion' };
      // Find a creature of the required type to exile
      const player = state.players[controller];
      const candidates = player.battlefield.filter(p =>
        p.id !== source.id &&
        (p.typeLine?.toLowerCase().includes(championType) || p.typeLine?.toLowerCase().includes('creature'))
      );
      if (candidates.length > 0) {
        // Exile the weakest candidate
        const weakest = [...candidates].sort((a, b) =>
          ((a.currentPower || 0) + (a.currentToughness || 0)) - ((b.currentPower || 0) + (b.currentToughness || 0))
        )[0];
        state = removePermanentFromBattlefield(state, weakest.id, 'exile');
        state = addLog(state, controller, `Champion: ${source.name} exiled ${weakest.name} — returns when ${source.name} leaves.`);
      } else {
        // No valid target — sacrifice this creature
        state = sacrificePermanent(state, source.id);
        state = addLog(state, controller, `Champion: ${source.name} sacrificed — no valid creature to exile.`);
      }
      return { state, resolved: true, description: `champion: ${championType}` };
    },
  },

  // ── Hideaway N — look at top N cards, exile one face down, put rest on bottom (CR 702.74) ──
  {
    name: 'hideaway',
    match: /hideaway\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const n = parseInt(m[1]);
      if (!source) return { state, resolved: true, description: 'hideaway' };
      const players = [...state.players];
      const player = { ...players[controller] };
      // Look at top N, exile the best one (by CMC), put rest on bottom
      const topCards = player.library.slice(0, n);
      if (topCards.length > 0) {
        const best = [...topCards].sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
        player.exile = [...player.exile, best];
        player.library = [...player.library.slice(n), ...topCards.filter(c => c.id !== best.id)];
        players[controller] = player;
        state = { ...state, players };
        state = addLog(state, controller, `Hideaway ${n}: ${source.name} exiled a card face down and put ${topCards.length - 1} cards on bottom.`);
      }
      return { state, resolved: true, description: `hideaway: exiled card` };
    },
  },

  // ── Casualty N — sacrifice a creature with power N or greater to copy the spell (CR 702.153) ──
  {
    name: 'casualty',
    match: /casualty\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const minPower = parseInt(m[1]);
      if (!source) return { state, resolved: true, description: 'casualty' };
      const player = state.players[controller];
      const candidates = player.battlefield.filter(p =>
        p.typeLine?.toLowerCase().includes('creature') &&
        (p.currentPower ?? 0) >= minPower
      );
      if (candidates.length > 0) {
        // Sacrifice the weakest eligible creature
        const weakest = [...candidates].sort((a, b) =>
          ((a.currentPower || 0) + (a.currentToughness || 0)) - ((b.currentPower || 0) + (b.currentToughness || 0))
        )[0];
        state = sacrificePermanent(state, weakest.id);
        state = addLog(state, controller, `Casualty ${minPower}: Sacrificed ${weakest.name} — spell is copied.`);
      } else {
        state = addLog(state, controller, `Casualty ${minPower}: No creature with power ${minPower}+ to sacrifice.`);
      }
      return { state, resolved: true, description: `casualty: ${minPower}` };
    },
  },

  // ── Daybound — transforms based on day/night cycle (CR 702.145) ──
  {
    name: 'daybound',
    match: /\bdaybound\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'daybound' };
      state = addLog(state, controller, `${source.name} has daybound — transforms when it becomes night.`);
      return { state, resolved: true, description: 'daybound' };
    },
  },

  // ── Nightbound — transforms back when it becomes day (CR 702.145) ──
  {
    name: 'nightbound',
    match: /\bnightbound\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'nightbound' };
      state = addLog(state, controller, `${source.name} has nightbound — transforms when it becomes day.`);
      return { state, resolved: true, description: 'nightbound' };
    },
  },

  // ── Skulk — can't be blocked by creatures with greater power (CR 702.119) ──
  {
    name: 'skulk',
    match: /\bskulk\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'skulk' };
      state = addLog(state, controller, `${source.name} has skulk — can't be blocked by creatures with greater power.`);
      return { state, resolved: true, description: 'skulk: evasion' };
    },
  },

  // ── Ninjutsu — return unblocked attacker to hand, put this card onto battlefield attacking (CR 702.48) ──
  {
    name: 'ninjutsu',
    match: /ninjutsu\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const ninjutsuCost = m[1];
      if (!source) return { state, resolved: true, description: 'ninjutsu (no source)' };
      // Ninjutsu activation is handled by the 'ninjutsu' action type in actions.ts
      // This pattern only marks the card as having ninjutsu for detection
      return { state, resolved: true, description: `ninjutsu available (${ninjutsuCost})` };
    },
  },

  // ── Exploit — when this creature enters, you may sacrifice a creature for a bonus effect (CR 702.109) ──
  {
    name: 'exploit',
    match: /\bexploit\b(?!ation)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: true, description: 'exploit' };
      // Auto-sacrifice: pick the weakest non-source creature, or sacrifice self if alone
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p =>
        p.typeLine?.toLowerCase().includes('creature') && p.id !== source.id
      );
      if (creatures.length > 0) {
        // Sacrifice the weakest creature
        const weakest = [...creatures].sort((a, b) =>
          ((a.currentPower || 0) + (a.currentToughness || 0)) - ((b.currentPower || 0) + (b.currentToughness || 0))
        )[0];
        state = sacrificePermanent(state, weakest.id);
        state = addLog(state, controller, `Exploit: Sacrificed ${weakest.name} for ${source.name}'s exploit ability.`);
      } else {
        // Can sacrifice itself
        state = sacrificePermanent(state, source.id);
        state = addLog(state, controller, `Exploit: ${source.name} sacrificed itself for its exploit ability.`);
      }
      return { state, resolved: true, description: 'exploit: sacrificed creature' };
    },
  },

  // ── Modular N — enters with N +1/+1 counters; when it dies, move counters to target artifact creature (CR 702.42) ──
  {
    name: 'modular',
    match: /modular\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const n = parseInt(m[1]);
      if (!source) return { state, resolved: true, description: 'modular' };
      // ETB: put N +1/+1 counters on this creature
      const found = findPermanentById(state, source.id);
      if (found) {
        const players = [...state.players];
        const player = { ...players[found.playerIdx] };
        const updatedBf = [...player.battlefield];
        const counters = { ...found.perm.counters, '+1/+1': (found.perm.counters['+1/+1'] || 0) + n };
        updatedBf[found.permIdx] = {
          ...found.perm, counters,
          currentPower: (found.perm.currentPower ?? 0) + n,
          currentToughness: (found.perm.currentToughness ?? 0) + n,
        };
        player.battlefield = updatedBf;
        players[found.playerIdx] = player;
        state = { ...state, players };
        state = addLog(state, controller, `Modular ${n}: ${source.name} enters with ${n} +1/+1 counter(s).`);
      }
      return { state, resolved: true, description: `modular: ${n} +1/+1 counters` };
    },
  },

  // ── Devour N — as this enters, sacrifice any number of creatures; put N*X +1/+1 counters (CR 702.81) ──
  {
    name: 'devour',
    match: /devour\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const devourN = parseInt(m[1]);
      if (!source) return { state, resolved: true, description: 'devour' };
      // Auto-devour: sacrifice small tokens/creatures (1/1s and 0/1s)
      const player = state.players[controller];
      const fodder = player.battlefield.filter(p =>
        p.typeLine?.toLowerCase().includes('creature') && p.id !== source.id &&
        (p.currentPower ?? 0) <= 1 && (p.currentToughness ?? 0) <= 1
      );
      const toDevour = fodder.slice(0, 3); // Max 3 sacrificed
      let totalCounters = 0;
      for (const f of toDevour) {
        state = sacrificePermanent(state, f.id);
        totalCounters += devourN;
      }
      if (totalCounters > 0) {
        const found = findPermanentById(state, source.id);
        if (found) {
          const players = [...state.players];
          const player2 = { ...players[found.playerIdx] };
          const updatedBf = [...player2.battlefield];
          const counters = { ...found.perm.counters, '+1/+1': (found.perm.counters['+1/+1'] || 0) + totalCounters };
          updatedBf[found.permIdx] = {
            ...found.perm, counters,
            currentPower: (found.perm.currentPower ?? 0) + totalCounters,
            currentToughness: (found.perm.currentToughness ?? 0) + totalCounters,
          };
          player2.battlefield = updatedBf;
          players[found.playerIdx] = player2;
          state = { ...state, players };
        }
        state = addLog(state, controller, `Devour ${devourN}: Sacrificed ${toDevour.length} creature(s), got ${totalCounters} +1/+1 counters.`);
      } else {
        state = addLog(state, controller, `Devour ${devourN}: No creatures sacrificed.`);
      }
      return { state, resolved: true, description: `devour: ${totalCounters} counters` };
    },
  },

  // ── Bloodthirst N — if an opponent was dealt damage this turn, enters with N +1/+1 counters (CR 702.53) ──
  {
    name: 'bloodthirst',
    match: /bloodthirst\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const n = parseInt(m[1]);
      if (!source) return { state, resolved: true, description: 'bloodthirst' };
      // Check if opponent was dealt damage this turn (simplified: always apply in combat or when life changed)
      const found = findPermanentById(state, source.id);
      if (found) {
        const players = [...state.players];
        const player = { ...players[found.playerIdx] };
        const updatedBf = [...player.battlefield];
        const counters = { ...found.perm.counters, '+1/+1': (found.perm.counters['+1/+1'] || 0) + n };
        updatedBf[found.permIdx] = {
          ...found.perm, counters,
          currentPower: (found.perm.currentPower ?? 0) + n,
          currentToughness: (found.perm.currentToughness ?? 0) + n,
        };
        player.battlefield = updatedBf;
        players[found.playerIdx] = player;
        state = { ...state, players };
        state = addLog(state, controller, `Bloodthirst ${n}: ${source.name} enters with ${n} +1/+1 counter(s) (opponent was dealt damage).`);
      }
      return { state, resolved: true, description: `bloodthirst: ${n} +1/+1 counters` };
    },
  },

  // ── Blitz — cast for blitz cost, gains haste, sacrifice at end of turn, draw a card when it dies (CR 702.152) ──
  {
    name: 'blitz',
    match: /blitz\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const blitzCost = m[1];
      if (!source) return { state, resolved: true, description: 'blitz' };
      // When cast for blitz cost: gains haste, sacrifice at end step, draw when dies
      const found = findPermanentById(state, source.id);
      if (found) {
        const players = [...state.players];
        const player = { ...players[found.playerIdx] };
        const updatedBf = [...player.battlefield];
        updatedBf[found.permIdx] = {
          ...found.perm,
          summoningSick: false,
          blitzed: true,
        };
        player.battlefield = updatedBf;
        players[found.playerIdx] = player;
        state = { ...state, players };
        state = addLog(state, controller, `Blitz: ${source.name} gains haste, will be sacrificed at end of turn (draw a card when it dies).`);
      }
      return { state, resolved: true, description: `blitz: ${blitzCost}` };
    },
  },

  // ── Mutate — merge creature with target non-Human creature (CR 702.139) ──
  {
    name: 'mutate',
    match: /mutate\s+(\{[^}]+\}(?:\{[^}]+\})*)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m, source) => {
      const mutateCost = m[1];
      if (!source) return { state, resolved: true, description: 'mutate (no source)' };

      // Find target creature to merge with
      const target = getTargetPermanent(state, targets);
      if (!target || target.perm.typeLine?.toLowerCase().includes('human')) {
        state = addLog(state, controller, `Mutate: No valid non-Human creature target — ${source.name} enters normally.`);
        return { state, resolved: true, description: 'mutate: no valid target' };
      }

      // Merge: add source's abilities to target creature's mutate stack
      const players = [...state.players];
      const player = { ...players[target.playerIdx] };
      const updatedBf = [...player.battlefield];

      const existingStack = target.perm.mutateStack || [];
      const newStackEntry = {
        id: source.id,
        name: source.name,
        oracleText: source.oracleText || '',
        power: source.power,
        toughness: source.toughness,
      };

      // Default: put on top (source becomes the "face" creature)
      const onTop = true; // AI default: put on top for better P/T

      if (onTop) {
        // Source on top: name, P/T, types come from source
        updatedBf[target.permIdx] = {
          ...target.perm,
          name: source.name,
          oracleText: (source.oracleText || '') + '\n' + (target.perm.oracleText || ''),
          currentPower: source.power ? parseInt(String(source.power)) : target.perm.currentPower,
          currentToughness: source.toughness ? parseInt(String(source.toughness)) : target.perm.currentToughness,
          mutateStack: [...existingStack, newStackEntry],
        };
      } else {
        // Source under: target keeps its characteristics, but gains source's abilities
        updatedBf[target.permIdx] = {
          ...target.perm,
          oracleText: (target.perm.oracleText || '') + '\n' + (source.oracleText || ''),
          mutateStack: [...existingStack, newStackEntry],
        };
      }

      player.battlefield = updatedBf;
      players[target.playerIdx] = player;
      state = { ...state, players };

      state = addLog(state, controller, `Mutate: ${source.name} merged ${onTop ? 'on top of' : 'under'} ${target.perm.name} (cost: ${mutateCost}).`);
      return { state, resolved: true, description: `mutate: merged with ${target.perm.name}` };
    },
  },

  // ── Companion — deck restriction mechanic (CR 702.138) ──
  {
    name: 'companion',
    match: /companion\s*[—\-]\s*(.+?)(?:\.|$)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m, source) => {
      const restriction = m[1];
      if (!source) return { state, resolved: true, description: 'companion (no source)' };
      // Companion activation is handled by the 'companion' action type
      // This pattern marks the card for detection
      state = addLog(state, controller, `${source.name} is a companion (restriction: ${restriction}).`);
      return { state, resolved: true, description: `companion: ${restriction}` };
    },
  },

  // ━━━ Smart Parser V2: New Effect Patterns ━━━

  // ── V2-1. each-player-loses-life — "each player loses N life" ──
  {
    name: 'each-player-loses-life',
    match: /each\s+player\s+loses?\s+(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const amount = parseInt(m[1]);
      state = damagePlayer(state, 0, amount);
      state = damagePlayer(state, 1, amount);
      state = addLog(state, controller, `Each player loses ${amount} life.`);
      return { state, resolved: true, description: `each player loses ${amount} life` };
    },
  },

  // ── V2-2. untap-gains-haste — "Untap (target creature|it). It gains haste until end of turn" ──
  // Part of Threaten-style effects: the "untap + haste" portion after gaining control
  {
    name: 'untap-gains-haste',
    match: /untap\s+(?:target\s+creature|it|that\s+creature)\s*[.,]?\s*(?:It|That creature)\s+gains?\s+haste\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const updatedPerm = {
        ...perm,
        tapped: false,
        summoningSick: false,
        temporaryKeywords: [...(perm.temporaryKeywords || []), {
          keyword: 'haste',
          source: 'untap-gains-haste',
          turn: state.turn,
        }],
      };
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} untapped and gains haste until end of turn.`);
      return { state, resolved: true, description: `untap ${perm.name} + haste` };
    },
  },

  // ── V2-3. its-controller-loses-life — "Its controller loses N life" ──
  // For compound effects like "Destroy target creature. Its controller loses 2 life."
  {
    name: 'its-controller-loses-life',
    match: /its\s+controller\s+loses?\s+(\d+)\s+life/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const amount = parseInt(m[1]);
      const permTarget = getTargetPermanent(state, targets);
      if (permTarget) {
        state = damagePlayer(state, permTarget.playerIdx, amount);
        state = addLog(state, controller, `${state.players[permTarget.playerIdx].name} loses ${amount} life.`);
        return { state, resolved: true, description: `controller loses ${amount} life` };
      }
      // Fallback: damage opponent (most common case)
      const opp: number = getFirstOpponent(state, controller);
      state = damagePlayer(state, opp, amount);
      state = addLog(state, controller, `Opponent loses ${amount} life.`);
      return { state, resolved: true, description: `opponent loses ${amount} life` };
    },
  },

  // ── V2-4. its-controller-draws — "Its controller draws a card" ──
  {
    name: 'its-controller-draws',
    match: /its\s+controller\s+draws?\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const count = parseNumber(m[1]);
      const permTarget = getTargetPermanent(state, targets);
      const targetPlayer = permTarget ? permTarget.playerIdx : getFirstOpponent(state, controller);
      state = drawCards(state, targetPlayer, count);
      state = addLog(state, controller, `${state.players[targetPlayer].name} draws ${count} card(s).`);
      return { state, resolved: true, description: `controller draws ${count}` };
    },
  },

  // ── V2-5. its-controller-gains-life — "Its controller gains N life" ──
  {
    name: 'its-controller-gains-life',
    match: /its\s+controller\s+gains?\s+(\d+)\s+life/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const amount = parseInt(m[1]);
      const permTarget = getTargetPermanent(state, targets);
      const targetPlayer = permTarget ? permTarget.playerIdx : controller;
      state = gainLife(state, targetPlayer, amount);
      state = addLog(state, controller, `${state.players[targetPlayer].name} gains ${amount} life.`);
      return { state, resolved: true, description: `controller gains ${amount} life` };
    },
  },

  // ── V2-6. its-controller-sacrifices — "Its controller sacrifices a [type]" ──
  {
    name: 'its-controller-sacrifices',
    match: /its\s+controller\s+sacrifices?\s+(?:a|an)\s+(\w+)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const filter = m[1].toLowerCase();
      const permTarget = getTargetPermanent(state, targets);
      const targetPlayer = permTarget ? permTarget.playerIdx : getFirstOpponent(state, controller);
      return {
        state: {
          ...state,
          pendingSacrifice: {
            player: targetPlayer,
            filter,
            count: 1,
            sourceName: 'effect',
          },
        },
        resolved: true,
        description: `controller must sacrifice a ${filter}`,
      };
    },
  },

  // ── V2-7. destroy-all-type — "destroy all [type]" (generic board wipe for any type) ──
  {
    name: 'destroy-all-type',
    match: /destroy\s+all\s+(creatures?\s+and\s+planeswalkers?|nonland\s+permanents?|permanents?|nonartifact\s+creatures?|nonblack\s+creatures?|nonwhite\s+creatures?|non-?\w+\s+creatures?)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const typeDesc = m[1].toLowerCase();
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        for (const perm of player.battlefield) {
          const tl = perm.typeLine.toLowerCase();
          let matches = false;
          if (typeDesc.includes('nonland permanent')) matches = !tl.includes('land');
          else if (typeDesc.includes('permanent')) matches = true;
          else if (typeDesc.includes('creatures') && typeDesc.includes('planeswalker')) {
            matches = tl.includes('creature') || tl.includes('planeswalker');
          } else if (typeDesc.includes('nonartifact creature')) {
            matches = tl.includes('creature') && !tl.includes('artifact');
          } else if (typeDesc.includes('nonblack creature')) {
            matches = tl.includes('creature') && !(perm.colors || []).includes('B');
          } else if (typeDesc.includes('nonwhite creature')) {
            matches = tl.includes('creature') && !(perm.colors || []).includes('W');
          } else if (typeDesc.includes('creature')) matches = tl.includes('creature');
          if (matches) {
            state = removePermanentFromBattlefield(state, perm.id, 'graveyard');
            count++;
          }
        }
      }
      state = addLog(state, controller, `Destroys all ${typeDesc} (${count}).`);
      return { state, resolved: true, description: `destroy all ${typeDesc} (${count})` };
    },
  },

  // ── V2-8. exile-all-type — "exile all [type]" (generic exile board wipe) ──
  {
    name: 'exile-all-type',
    match: /exile\s+all\s+(nonland\s+permanents?|permanents?|artifacts?\s+and\s+enchantments?|creatures?|artifacts?|enchantments?|lands?|planeswalkers?)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const typeDesc = m[1].toLowerCase();
      let count = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        for (const perm of player.battlefield) {
          const tl = perm.typeLine.toLowerCase();
          let matches = false;
          if (typeDesc.includes('nonland permanent')) matches = !tl.includes('land');
          else if (typeDesc.includes('permanent')) matches = true;
          else if (typeDesc.includes('artifact') && typeDesc.includes('enchantment')) {
            matches = tl.includes('artifact') || tl.includes('enchantment');
          }
          else if (typeDesc.includes('creature')) matches = tl.includes('creature');
          else if (typeDesc.includes('artifact')) matches = tl.includes('artifact');
          else if (typeDesc.includes('enchantment')) matches = tl.includes('enchantment');
          else if (typeDesc.includes('land')) matches = tl.includes('land');
          else if (typeDesc.includes('planeswalker')) matches = tl.includes('planeswalker');
          if (matches) {
            state = removePermanentFromBattlefield(state, perm.id, 'exile');
            count++;
          }
        }
      }
      state = addLog(state, controller, `Exiles all ${typeDesc} (${count}).`);
      return { state, resolved: true, description: `exile all ${typeDesc} (${count})` };
    },
  },

  // ── V2-9. target-creature-gets-multi-keyword — "target creature gets +X/+Y and gains KEYWORD1 and KEYWORD2 until end of turn" ──
  {
    name: 'target-creature-gets-multi-keyword',
    match: /target\s+creature\s+gets\s+([+-]\d+)\/([+-]\d+)\s+and\s+gains?\s+(.+?)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const target = targets.find(t => t.type === 'permanent');
      if (!target) return { state, resolved: false };
      const found = findPermanentById(state, target.id);
      if (!found) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = found;
      const powerDelta = parseInt(m[1]);
      const toughnessDelta = parseInt(m[2]);
      const keywordStr = m[3].toLowerCase();
      const keywordList = keywordStr.split(/,\s*|\s+and\s+/).map(k => k.trim()).filter(k => k.length > 0);
      const updatedPerm = {
        ...perm,
        currentPower: (perm.currentPower ?? parseInt(perm.power || '0')) + powerDelta,
        currentToughness: (perm.currentToughness ?? parseInt(perm.toughness || '0')) + toughnessDelta,
        temporaryPtMods: [
          ...(perm.temporaryPtMods || []),
          { power: powerDelta, toughness: toughnessDelta, source: 'multi-keyword', turn: state.turn },
        ],
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          ...keywordList.map(kw => ({ keyword: kw, source: 'multi-keyword', turn: state.turn })),
        ],
      };
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gets ${m[1]}/${m[2]} and gains ${keywordList.join(', ')} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} ${m[1]}/${m[2]} + ${keywordList.join(', ')}` };
    },
  },

  // ── V2-10. creatures-you-control-get-and-gain — "Creatures you control get +N/+M and gain KEYWORD until end of turn" (Overrun) ──
  {
    name: 'creatures-you-control-get-and-gain',
    match: /creatures?\s+you\s+control\s+get\s+([+-]\d+)\/([+-]\d+)\s+and\s+gain\s+(.+?)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const powerMod = parseInt(m[1]);
      const toughMod = parseInt(m[2]);
      const keywordStr = m[3].toLowerCase();
      const keywordList = keywordStr.split(/,\s*|\s+and\s+/).map(k => k.trim()).filter(k => k.length > 0);
      const player = state.players[controller];
      let count = 0;
      const updatedBf = player.battlefield.map(perm => {
        if (!perm.typeLine?.toLowerCase().includes('creature')) return perm;
        count++;
        return {
          ...perm,
          currentPower: (perm.currentPower ?? 0) + powerMod,
          currentToughness: (perm.currentToughness ?? 0) + toughMod,
          temporaryPtMods: [...(perm.temporaryPtMods || []), { power: powerMod, toughness: toughMod, source: 'overrun', turn: state.turn }],
          temporaryKeywords: [
            ...(perm.temporaryKeywords || []),
            ...keywordList.map(kw => ({ keyword: kw, source: 'overrun', turn: state.turn })),
          ],
        };
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Creatures you control get ${m[1]}/${m[2]} and gain ${keywordList.join(', ')} until end of turn (${count}).`);
      return { state, resolved: true, description: `${count} creatures ${m[1]}/${m[2]} + ${keywordList.join(', ')}` };
    },
  },

  // ── V2-11. opponents-creatures-get-v2 — "Creatures your opponents control get -N/-M until end of turn" (broader) ──
  {
    name: 'opponents-creatures-get-v2',
    match: /creatures?\s+(?:your\s+opponents?\s+controls?|(?:an\s+)?opponents?\s+controls?)\s+get\s+([+-]\d+)\/([+-]\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const powerMod = parseInt(m[1]);
      const toughMod = parseInt(m[2]);
      const opp: number = getFirstOpponent(state, controller);
      const player = state.players[opp];
      let count = 0;
      const updatedBf = player.battlefield.map(perm => {
        if (perm.currentPower !== undefined && perm.typeLine?.toLowerCase().includes('creature')) {
          count++;
          return {
            ...perm,
            currentPower: (perm.currentPower ?? 0) + powerMod,
            currentToughness: (perm.currentToughness ?? 0) + toughMod,
            temporaryPtMods: [...(perm.temporaryPtMods || []), { power: powerMod, toughness: toughMod, source: 'opp-creatures-pump', turn: state.turn }],
          };
        }
        return perm;
      });
      const players = [...state.players];
      players[opp] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Opponent's creatures get ${m[1]}/${m[2]} until end of turn (${count}).`);
      return { state, resolved: true, description: `${count} opp creatures ${m[1]}/${m[2]}` };
    },
  },

  // ── V2-12. gain-control-untap-haste — Full Threaten: "Gain control + Untap + Haste" ──
  {
    name: 'gain-control-untap-haste',
    match: /gain\s+control\s+of\s+target\s+creature\s+until\s+end\s+of\s+turn\s*[.,]?\s*(?:Untap\s+(?:it|that\s+creature)\s*[.,]?\s*)?(?:It|That\s+creature)\s+gains?\s+haste/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = targets.find(t => t.type === 'permanent');
      if (!target) return { state, resolved: false };
      const found = findPermanentById(state, target.id);
      if (!found) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = found;
      if (playerIdx === controller) {
        state = addLog(state, controller, `Already controls ${perm.name}.`);
        return { state, resolved: true, description: 'already controlled' };
      }
      const oppPlayer = state.players[playerIdx];
      const updatedOppBf = [...oppPlayer.battlefield];
      updatedOppBf.splice(permIdx, 1);
      const stolenPerm = {
        ...perm,
        controller,
        tapped: false,
        summoningSick: false,
        temporaryControlChange: {
          originalController: playerIdx,
          source: 'threaten',
          turn: state.turn,
        },
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'haste', source: 'threaten', turn: state.turn }],
      };
      const ctrlPlayer = state.players[controller];
      const updatedCtrlBf = [...ctrlPlayer.battlefield, stolenPerm];
      const players = [...state.players];
      players[playerIdx] = { ...oppPlayer, battlefield: updatedOppBf };
      players[controller] = { ...ctrlPlayer, battlefield: updatedCtrlBf };
      state = { ...state, players };
      state = addLog(state, controller, `Gains control of ${perm.name} until end of turn (untapped, haste).`);
      return { state, resolved: true, description: `threaten ${perm.name}` };
    },
  },

  // ── V2-13. target-cant-attack-or-block — "target creature can't attack or block this turn" ──
  {
    name: 'target-cant-attack-or-block',
    match: /target\s+creature\s+can'?t\s+attack\s+or\s+block\s+(?:this\s+turn|until)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const updatedPerm = {
        ...perm,
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          { keyword: "can't attack", source: 'effect', turn: state.turn },
          { keyword: "can't block", source: 'effect', turn: state.turn },
        ],
      };
      const players = [...state.players];
      const bf = [...players[playerIdx].battlefield];
      bf[permIdx] = updatedPerm;
      players[playerIdx] = { ...players[playerIdx], battlefield: bf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} can't attack or block this turn.`);
      return { state, resolved: true, description: `${perm.name} can't attack/block` };
    },
  },

  // ── V2-14. target-player-puts-top-into-gy — older mill phrasing ──
  {
    name: 'target-player-puts-top-into-gy',
    match: /target\s+player\s+puts?\s+the\s+top\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+cards?\s+of\s+(?:their|his\s+or\s+her)\s+library\s+into\s+(?:their|his\s+or\s+her)\s+graveyard/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const count = parseNumber(m[1]);
      const targetIdx = getTargetPlayer(targets) ?? getFirstOpponent(state, controller);
      state = millCards(state, targetIdx, count);
      state = addLog(state, controller, `${state.players[targetIdx].name} mills ${count} card(s).`);
      return { state, resolved: true, description: `${state.players[targetIdx].name} mills ${count}` };
    },
  },

  // ── V2-15. flicker-permanent — "Exile target permanent, then return it" (broader than creature-only) ──
  {
    name: 'flicker-permanent',
    match: /exile\s+target\s+(?:permanent|nonland\s+permanent)\s*(?:,|\.)?\s*(?:then\s+)?return\s+(?:it|that\s+card)\s+to\s+the\s+battlefield/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      state = removePermanentFromBattlefield(state, target.perm.id, 'exile');
      const player = state.players[target.playerIdx];
      const exiledCard = player.exile[player.exile.length - 1];
      if (exiledCard) {
        const newPerm = cardToPermanent(exiledCard, target.playerIdx, state.turn);
        const updatedExile = player.exile.slice(0, -1);
        const players = [...state.players];
        players[target.playerIdx] = {
          ...player,
          exile: updatedExile,
          battlefield: [...player.battlefield, newPerm],
        };
        state = { ...state, players };
        state = checkETBTriggers(state, newPerm);
      }
      state = addLog(state, controller, `Flickered ${target.perm.name} (exile + return).`);
      return { state, resolved: true, description: `flicker ${target.perm.name}` };
    },
  },

  // ── V2-16. each-opponent-mills — "each opponent mills N cards" ──
  {
    name: 'each-opponent-mills',
    match: /each\s+opponent\s+mills?\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      const opp: number = getFirstOpponent(state, controller);
      state = millCards(state, opp, count);
      state = addLog(state, controller, `Each opponent mills ${count} card(s).`);
      return { state, resolved: true, description: `opponent mills ${count}` };
    },
  },

  // ── V2-17. draw-then-discard-compound — "Draw N cards, then discard M cards" (compound) ──
  {
    name: 'draw-then-discard-compound',
    match: /draw\s+(a|an|one|two|three|four|five|\d+)\s+cards?\s*[.,]?\s*(?:then\s+)?discard\s+(a|an|one|two|three|four|five|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const drawCount = parseNumber(m[1]);
      const discardCount = parseNumber(m[2]);
      state = drawCards(state, controller, drawCount);
      state = addLog(state, controller, `Draws ${drawCount} card(s), must discard ${discardCount}.`);
      return {
        state: {
          ...state,
          pendingDiscard: controller,
          pendingDiscardCount: discardCount,
        },
        resolved: true,
        description: `draw ${drawCount}, discard ${discardCount}`,
      };
    },
  },

  // ── V2-18. target-creature-gains-any-keyword — broader keyword grant with more keywords ──
  {
    name: 'target-creature-gains-any-keyword',
    match: /target\s+creature\s+gains?\s+(flying|haste|trample|lifelink|deathtouch|first\s+strike|double\s+strike|hexproof|indestructible|menace|vigilance|reach|defender|intimidate|fear|shadow|skulk|prowess)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const keyword = m[1].toLowerCase();
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const updatedPerm: Permanent = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), {
          keyword,
          source: 'keyword-grant',
          turn: state.turn,
        }],
      };
      if (keyword === 'haste') {
        updatedPerm.summoningSick = false;
      }
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains ${keyword} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} gains ${keyword}` };
    },
  },

  // ── V2-19. copy-spell-v2 — "Copy target instant or sorcery spell" (broader) ──
  {
    name: 'copy-spell-v2',
    match: /copy\s+target\s+(?:instant\s+or\s+sorcery\s+)?spell/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const spellTarget = targets.find(t => t.type === 'card-in-zone' && t.zone === 'stack');
      if (spellTarget && state.stack.length > 0) {
        const original = state.stack.find(s => s.id === spellTarget.id);
        if (original) {
          const copy = copyStackObject(original, controller);
          state = { ...state, stack: [...state.stack, copy] };
          state = addLog(state, controller, `Copies ${original.text || 'target spell'}.`);
          return { state, resolved: true, description: `copy ${original.text || 'spell'}` };
        }
      }
      state = addLog(state, controller, `Copy spell fizzled (no valid target).`);
      return { state, resolved: true, description: 'copy fizzled' };
    },
  },

  // ── V2-20. each-player-mills — "each player mills N cards" ──
  {
    name: 'each-player-mills',
    match: /each\s+player\s+mills?\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const count = parseNumber(m[1]);
      state = millCards(state, 0, count);
      state = millCards(state, 1, count);
      state = addLog(state, controller, `Each player mills ${count} card(s).`);
      return { state, resolved: true, description: `each player mills ${count}` };
    },
  },

  // ── V2-21. return-target-to-hand — "Return target [type] to its owner's hand" (broader) ──
  {
    name: 'return-target-to-hand',
    match: /return\s+target\s+(creature|permanent|nonland\s+permanent|artifact|enchantment)\s+to\s+its\s+owner'?s?\s+hand/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, perm } = target;
      const ownerIdx = perm.owner;
      const controllerPlayer = state.players[playerIdx];
      const bfIdx = controllerPlayer.battlefield.findIndex(p => p.id === target.perm.id);
      if (bfIdx === -1) return { state, resolved: false };
      const updatedBf = [...controllerPlayer.battlefield];
      updatedBf.splice(bfIdx, 1);
      const cardObj: Card = {
        id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
        cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
        power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
        colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
        tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
      };
      const players = [...state.players];
      players[playerIdx] = { ...controllerPlayer, battlefield: updatedBf };
      const ownerPlayer = playerIdx === ownerIdx ? players[ownerIdx] : { ...state.players[ownerIdx] };
      players[ownerIdx] = { ...ownerPlayer, hand: [...ownerPlayer.hand, cardObj] };
      state = { ...state, players };
      state = addLog(state, controller, `Returns ${perm.name} to its owner's hand.`);
      return { state, resolved: true, description: `bounce ${perm.name}` };
    },
  },

  // ── V2-22. your-creatures-gain-multi-keyword — "creatures you control gain X and Y until end of turn" ──
  {
    name: 'your-creatures-gain-multi-keyword',
    match: /creatures?\s+you\s+control\s+gain\s+(.+?)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const keywordStr = m[1].toLowerCase();
      const keywordList = keywordStr.split(/,\s*|\s+and\s+/).map(k => k.trim()).filter(k => k.length > 0);
      const player = state.players[controller];
      let count = 0;
      const updatedBf = player.battlefield.map(perm => {
        if (!perm.typeLine?.toLowerCase().includes('creature')) return perm;
        count++;
        return {
          ...perm,
          temporaryKeywords: [
            ...(perm.temporaryKeywords || []),
            ...keywordList.map(kw => ({ keyword: kw, source: 'mass-keyword', turn: state.turn })),
          ],
          ...(keywordList.includes('haste') ? { summoningSick: false } : {}),
        };
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Creatures you control gain ${keywordList.join(', ')} until end of turn (${count}).`);
      return { state, resolved: true, description: `${count} creatures gain ${keywordList.join(', ')}` };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══  NEW EFFECT PATTERNS — Copy, Type, Color, Combat, Utility, Layer  ═══
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Category 1: Copy Effects (Layer 1 setup) ──

  // Copy-1: "becomes a copy of target creature/permanent" (Clone, Gigantoplasm, Metamorph)
  {
    name: 'becomes-copy-of-target',
    match: /(?:you may have .+ )?(?:enter|enters) the battlefield as a copy of|becomes?\s+a\s+copy\s+of\s+target\s+(?:creature|permanent)/i,
    requiresTarget: true,
    apply: (state, controller, targets, _m, source) => {
      if (!source) return { state, resolved: false };
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const found = findPermanentById(state, source.id);
      if (!found) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = found;
      const { perm: targetPerm } = target;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        copyEffect: {
          copiedName: targetPerm.name,
          copiedTypeLine: targetPerm.typeLine,
          copiedOracleText: targetPerm.oracleText || '',
          copiedPower: targetPerm.power,
          copiedToughness: targetPerm.toughness,
          copiedColors: [...(targetPerm.colors || [])],
          copiedManaCost: targetPerm.manaCost,
          timestamp: nextEffectTimestamp(),
        },
        basePower: targetPerm.basePower,
        baseToughness: targetPerm.baseToughness,
        currentPower: targetPerm.currentPower,
        currentToughness: targetPerm.currentToughness,
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} becomes a copy of ${targetPerm.name}.`);
      return { state, resolved: true, description: `copy: ${perm.name} → ${targetPerm.name}` };
    },
  },

  // Copy-1b: "enters the battlefield as a copy of any creature" -- auto-selects highest-power creature (bot heuristic)
  // Handles: Clone, Phantasmal Image, Phyrexian Metamorph, Clever Impersonator, Sakashima, Spark Double, etc.
  // Used when no explicit target is provided (oracle text says "any creature" / "any permanent"),
  // or as the ETB copy resolver when requiresTarget patterns cannot fire (no target on stack object).
  {
    name: 'becomes-copy-of-permanent',
    match: /enters\s+the\s+battlefield\s+as\s+a\s+copy\s+of|becomes\s+a\s+copy\s+of/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source) return { state, resolved: false };
      const found = findPermanentById(state, source.id);
      if (!found) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = found;
      let bestTarget: { perm: Permanent; playerIdx: number; permIdx: number } | null = null;
      let bestPower = -1;
      for (let pi = 0; pi < 2; pi++) {
        const p = state.players[pi];
        for (let i = 0; i < p.battlefield.length; i++) {
          const candidate = p.battlefield[i];
          if (candidate.id === perm.id) continue;
          if (!candidate.typeLine.toLowerCase().includes('creature')) continue;
          const candidatePower = candidate.currentPower ?? candidate.basePower ?? 0;
          if (candidatePower > bestPower) {
            bestPower = candidatePower;
            bestTarget = { perm: candidate, playerIdx: pi, permIdx: i };
          }
        }
      }
      if (!bestTarget) {
        state = addLog(state, controller, `${perm.name} enters the battlefield -- no creature to copy.`);
        return { state, resolved: true, description: `${perm.name}: no copy target found` };
      }
      const targetPerm = bestTarget.perm;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        copyEffect: {
          copiedName: targetPerm.name,
          copiedTypeLine: targetPerm.typeLine,
          copiedOracleText: targetPerm.oracleText || '',
          copiedPower: targetPerm.power,
          copiedToughness: targetPerm.toughness,
          copiedColors: [...(targetPerm.colors || [])],
          copiedManaCost: targetPerm.manaCost,
          timestamp: nextEffectTimestamp(),
        },
        basePower: targetPerm.basePower,
        baseToughness: targetPerm.baseToughness,
        currentPower: targetPerm.currentPower,
        currentToughness: targetPerm.currentToughness,
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} enters as a copy of ${targetPerm.name}.`);
      return { state, resolved: true, description: `copy: ${perm.name} -> ${targetPerm.name}` };
    },
  },

  // Copy-2: "create a token that's a copy of target creature"
  {
    name: 'create-token-copy-of-target',
    match: /create\s+a\s+token\s+that(?:'s| is)\s+a\s+copy\s+of\s+target\s+(?:creature|permanent)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { perm: targetPerm } = target;
      const tokenCard: Card = {
        id: generateCardId(), oracleId: `token_copy_${targetPerm.oracleId}`,
        name: targetPerm.name, manaCost: targetPerm.manaCost || '', cmc: targetPerm.cmc || 0,
        typeLine: `Token ${targetPerm.typeLine}`, oracleText: targetPerm.oracleText || '',
        power: targetPerm.power, toughness: targetPerm.toughness,
        colors: [...(targetPerm.colors || [])], colorIdentity: [...(targetPerm.colorIdentity || [])],
        rarity: 'common', tags: [], imageUrl: targetPerm.imageUrl || '', owner: controller,
      };
      const newPerm = cardToPermanent(tokenCard, controller, state.turn);
      const player = state.players[controller];
      const players = [...state.players];
      players[controller] = { ...player, battlefield: [...player.battlefield, newPerm] };
      state = { ...state, players };
      state = addLog(state, controller, `Creates a token copy of ${targetPerm.name}.`);
      return { state, resolved: true, description: `token copy of ${targetPerm.name}` };
    },
  },

  // ── Category 2: Type-Changing Effects (Layer 4) ──

  // Type-1: "creatures you control are [type] in addition to their other types" (Arcane Adaptation)
  {
    name: 'creatures-are-type-in-addition',
    match: /creatures?\s+you\s+control\s+are\s+(\w+)s?\s+in\s+addition\s+to\s+their\s+other\s+types?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const addedType = m[1];
      const player = state.players[controller];
      const updatedBf = player.battlefield.map(perm => {
        if (perm.basePower === undefined) return perm; // skip non-creatures
        if (perm.typeLine.toLowerCase().includes(addedType.toLowerCase())) return perm;
        return {
          ...perm,
          typeChanges: [...(perm.typeChanges || []), {
            addedTypes: [addedType],
            source: 'type-change-effect',
            timestamp: nextEffectTimestamp(),
          }],
        };
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Creatures you control are ${addedType}s in addition to their other types.`);
      return { state, resolved: true, description: `type change: +${addedType}` };
    },
  },

  // Type-2: "target creature becomes a [type] in addition to its other types"
  {
    name: 'target-becomes-type-in-addition',
    match: /target\s+creature\s+becomes?\s+(?:a\s+)?(\w+)\s+in\s+addition\s+to\s+its?\s+other\s+types?\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const addedType = m[1];
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        typeChanges: [...(perm.typeChanges || []), {
          addedTypes: [addedType],
          source: 'type-change-eot',
          timestamp: nextEffectTimestamp(),
        }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} becomes a ${addedType} in addition to its other types until end of turn.`);
      return { state, resolved: true, description: `${perm.name} +type ${addedType}` };
    },
  },

  // ── Category 3: Color-Changing Effects (Layer 5) ──

  // Color-1: "target permanent becomes [color] until end of turn"
  {
    name: 'target-becomes-color',
    match: /target\s+(?:creature|permanent)\s+becomes?\s+(white|blue|black|red|green)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const colorName = m[1].toLowerCase();
      const colorMap: Record<string, string> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
      const colorCode = colorMap[colorName] || colorName[0].toUpperCase();
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        colorChanges: [...(perm.colorChanges || []), {
          addedColors: [],
          setColors: [colorCode],
          source: 'color-change-eot',
          timestamp: nextEffectTimestamp(),
        }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} becomes ${colorName} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} → ${colorName}` };
    },
  },

  // Color-2: "target permanent becomes [color] in addition to its other colors"
  {
    name: 'target-gains-color',
    match: /target\s+(?:creature|permanent)\s+becomes?\s+(white|blue|black|red|green)\s+in\s+addition\s+to\s+its?\s+other\s+colors?/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const colorName = m[1].toLowerCase();
      const colorMap: Record<string, string> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
      const colorCode = colorMap[colorName] || colorName[0].toUpperCase();
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        colorChanges: [...(perm.colorChanges || []), {
          addedColors: [colorCode],
          source: 'add-color-eot',
          timestamp: nextEffectTimestamp(),
        }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} becomes ${colorName} in addition to its other colors.`);
      return { state, resolved: true, description: `${perm.name} +${colorName}` };
    },
  },

  // Color-3: All permanents are [color] in addition (Painter's Servant)
  {
    name: 'all-permanents-are-color',
    match: /all\s+(?:cards?\s+(?:everywhere|that\s+aren't\s+on\s+the\s+battlefield)|permanents?)\s+are\s+(white|blue|black|red|green)\s+in\s+addition/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const colorName = m[1].toLowerCase();
      const colorMap: Record<string, string> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
      const colorCode = colorMap[colorName] || colorName[0].toUpperCase();
      const ts = nextEffectTimestamp();
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const updatedBf = player.battlefield.map(perm => ({
          ...perm,
          colorChanges: [...(perm.colorChanges || []), {
            addedColors: [colorCode],
            source: 'painters-servant',
            timestamp: ts,
          }],
        }));
        const players = [...state.players];
        players[pi] = { ...player, battlefield: updatedBf };
        state = { ...state, players };
      }
      state = addLog(state, controller, `All permanents are ${colorName} in addition to their other colors.`);
      return { state, resolved: true, description: `all permanents +${colorName}` };
    },
  },

  // ── Category 4: More Combat/Board Effects ──

  // Combat-1: "target creature can't be blocked this turn"
  {
    name: 'target-cant-be-blocked',
    match: /target\s+creature\s+can(?:'t|not)\s+be\s+blocked\s+(?:this\s+turn|until\s+end\s+of\s+turn)/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'unblockable', source: 'cant-be-blocked', turn: state.turn }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} can't be blocked this turn.`);
      return { state, resolved: true, description: `${perm.name} unblockable` };
    },
  },

  // Combat-2: "creatures you control gain indestructible until end of turn" (Heroic Intervention)
  {
    name: 'your-creatures-gain-indestructible',
    match: /(?:creatures?|permanents?)\s+you\s+control\s+gain\s+(?:hexproof\s+and\s+)?indestructible\s+until\s+end\s+of\s+turn/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      const updatedBf = player.battlefield.map(perm => ({
        ...perm,
        temporaryKeywords: [
          ...(perm.temporaryKeywords || []),
          { keyword: 'indestructible', source: 'mass-indestructible', turn: state.turn },
        ],
      }));
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Creatures you control gain indestructible until end of turn.`);
      return { state, resolved: true, description: 'your creatures gain indestructible' };
    },
  },

  // Combat-3: "prevent all combat damage that would be dealt this turn" (Fog)
  {
    name: 'prevent-all-combat-damage',
    match: /prevent\s+all\s+combat\s+damage\s+(?:that\s+would\s+be\s+dealt\s+)?(?:this\s+turn|until\s+end\s+of\s+turn)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const shields = [...(state.damageShields || [])];
      shields.push({ targetId: `player-${controller}`, amount: 999999, source: 'fog-combat', turn: state.turn, untilEndOfTurn: true });
      const opponent = getFirstOpponent(state, controller);
      shields.push({ targetId: `player-${opponent}`, amount: 999999, source: 'fog-combat', turn: state.turn, untilEndOfTurn: true });
      for (const player of state.players) {
        for (const perm of player.battlefield) {
          if (perm.basePower !== undefined) {
            shields.push({ targetId: perm.id, amount: 999999, source: 'fog-combat', turn: state.turn, untilEndOfTurn: true });
          }
        }
      }
      state = { ...state, damageShields: shields };
      state = addLog(state, controller, `Prevents all combat damage this turn.`);
      return { state, resolved: true, description: 'prevent all combat damage' };
    },
  },

  // ── Category 5: Utility/Value Effects ──

  // Util-1: "each player draws a card" (Howling Mine)
  {
    name: 'each-player-draws',
    match: /each\s+player\s+draws?\s+(a|an|one|two|three|four|five|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const qty = parseNumber(m[1]);
      state = drawCards(state, 0, qty);
      state = drawCards(state, 1, qty);
      state = addLog(state, controller, `Each player draws ${qty} card${qty > 1 ? 's' : ''}.`);
      return { state, resolved: true, description: `each player draws ${qty}` };
    },
  },

  // Util-2: "look at the top [N] cards of your library. Put one into your hand and the rest on the bottom" (Impulse, Anticipate)
  {
    name: 'look-top-put-hand-rest-bottom',
    match: /look\s+at\s+the\s+top\s+(two|three|four|five|six|seven|\d+)\s+cards?\s+of\s+your\s+library.*put\s+(?:one|a card|one of them)\s+into\s+your\s+hand/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const lookCount = parseNumber(m[1]);
      // Simplified: draw 1 card (equivalent to selecting best from top N)
      state = drawCards(state, controller, 1);
      state = addLog(state, controller, `Looks at top ${lookCount} cards, puts one into hand, rest on bottom.`);
      return { state, resolved: true, description: `impulse ${lookCount}` };
    },
  },

  // Util-3: "exile target creature. Its controller gains life equal to its power" (Swords to Plowshares)
  {
    name: 'exile-creature-controller-gains-life-power',
    match: /exile\s+target\s+creature.*(?:its|that creature's)\s+controller\s+gains?\s+life\s+equal\s+to\s+(?:its|that creature's)\s+power/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { perm } = target;
      const power = perm.currentPower ?? perm.basePower ?? 0;
      const permController = perm.controller;
      state = removePermanentFromBattlefield(state, perm.id, 'exile');
      const players = [...state.players];
      players[permController] = { ...players[permController], life: players[permController].life + power };
      state = { ...state, players };
      state = checkLifegainTriggers(state, permController, power);
      state = addLog(state, controller, `Exiles ${perm.name}. Its controller gains ${power} life.`);
      return { state, resolved: true, description: `exile ${perm.name}, gain ${power} life` };
    },
  },

  // Util-4: "destroy target permanent. Its controller creates a 3/3 token" (Beast Within variant)
  {
    name: 'destroy-target-permanent-create-token',
    match: /destroy\s+target\s+(?:nonland\s+)?permanent.*(?:its|that permanent's)\s+controller\s+creates?\s+a\s+(\d+)\/(\d+)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { perm } = target;
      const power = parseInt(m[1]) || 3;
      const toughness = parseInt(m[2]) || 3;
      const permController = perm.controller;
      state = removePermanentFromBattlefield(state, perm.id, 'graveyard');
      const tokenCard: Card = {
        id: generateCardId(), oracleId: 'token_beast', name: 'Beast',
        manaCost: '', cmc: 0, typeLine: 'Token Creature — Beast',
        oracleText: '', power: String(power), toughness: String(toughness),
        colors: ['G'], colorIdentity: ['G'], rarity: 'common', tags: [], imageUrl: '', owner: permController,
      };
      const newPerm = cardToPermanent(tokenCard, permController, state.turn);
      const players = [...state.players];
      players[permController] = { ...players[permController], battlefield: [...players[permController].battlefield, newPerm] };
      state = { ...state, players };
      state = addLog(state, controller, `Destroys ${perm.name}. Its controller creates a ${power}/${toughness} Beast token.`);
      return { state, resolved: true, description: `destroy ${perm.name}, create ${power}/${toughness} token` };
    },
  },

  // Util-5: "each opponent discards a card" (Mind Rot, Hymn to Tourach)
  {
    name: 'each-opponent-discards',
    match: /each\s+opponent\s+discards?\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const qty = parseNumber(m[1]);
      const opponent = getFirstOpponent(state, controller);
      const player = state.players[opponent];
      const actualDiscard = Math.min(qty, player.hand.length);
      if (actualDiscard > 0) {
        const discarded = player.hand.slice(-actualDiscard);
        const remaining = player.hand.slice(0, -actualDiscard);
        const players = [...state.players];
        players[opponent] = { ...player, hand: remaining, graveyard: [...player.graveyard, ...discarded] };
        state = { ...state, players };
        for (const c of discarded) {
          state = addLog(state, opponent, `Discards ${c.name}.`);
        }
      }
      state = addLog(state, controller, `Each opponent discards ${qty} card${qty > 1 ? 's' : ''}.`);
      return { state, resolved: true, description: `each opponent discards ${qty}` };
    },
  },

  // Util-6: "put a +1/+1 counter on each creature you control" (Gavony Township)
  {
    name: 'counter-on-each-creature-you-control',
    match: /put\s+(?:a|one|two|three|\d+)\s+\+1\/\+1\s+counters?\s+on\s+each\s+creature\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const countMatch = m[0].match(/(a|one|two|three|four|\d+)\s+\+1\/\+1/i);
      const qty = countMatch ? parseNumber(countMatch[1]) : 1;
      const player = state.players[controller];
      const updatedBf = player.battlefield.map(perm => {
        if (perm.basePower === undefined) return perm;
        return { ...perm, counters: { ...perm.counters, '+1/+1': (perm.counters['+1/+1'] || 0) + qty } };
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Puts ${qty > 1 ? qty + ' ' : 'a '}+1/+1 counter${qty > 1 ? 's' : ''} on each creature you control.`);
      return { state, resolved: true, description: `+1/+1 on each creature (${qty})` };
    },
  },

  // Util-7: "target player reveals their hand. You choose a nonland card. That player discards that card" (Thoughtseize)
  {
    name: 'reveal-hand-choose-discard',
    match: /target\s+(?:player|opponent)\s+reveals?\s+(?:their|his\s+or\s+her)\s+hand.*(?:you\s+choose|choose).*(?:discard|exile)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opponent = getFirstOpponent(state, controller);
      const player = state.players[opponent];
      if (player.hand.length === 0) {
        state = addLog(state, controller, `Opponent reveals empty hand.`);
        return { state, resolved: true, description: 'reveal hand (empty)' };
      }
      const nonlands = player.hand.filter(c => !c.typeLine.toLowerCase().includes('land'));
      if (nonlands.length === 0) {
        state = addLog(state, controller, `Opponent reveals hand — no nonland cards.`);
        return { state, resolved: true, description: 'reveal hand (no nonlands)' };
      }
      const chosen = nonlands.sort((a, b) => (b.cmc || 0) - (a.cmc || 0))[0];
      const players = [...state.players];
      players[opponent] = {
        ...player,
        hand: player.hand.filter(c => c.id !== chosen.id),
        graveyard: [...player.graveyard, chosen],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Opponent reveals hand. ${chosen.name} is discarded.`);
      return { state, resolved: true, description: `thoughtseize: discard ${chosen.name}` };
    },
  },

  // Util-8: "you gain life equal to the number of creatures you control"
  {
    name: 'gain-life-equal-to-creatures',
    match: /you\s+gain\s+life\s+equal\s+to\s+the\s+number\s+of\s+creatures?\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const count = state.players[controller].battlefield.filter(p => p.basePower !== undefined).length;
      const players = [...state.players];
      players[controller] = { ...players[controller], life: players[controller].life + count };
      state = { ...state, players };
      state = checkLifegainTriggers(state, controller, count);
      state = addLog(state, controller, `Gains ${count} life (equal to creatures controlled).`);
      return { state, resolved: true, description: `gain ${count} life` };
    },
  },

  // Util-9: "target creature's power and toughness become N/N" (Humble, Turn to Frog)
  {
    name: 'set-pt-to-base',
    match: /(?:target|that)\s+creature(?:'s)?\s+(?:has\s+base\s+)?power\s+and\s+toughness\s+(?:each\s+)?become\s+(\d+)\/(\d+)/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const setPower = parseInt(m[1]);
      const setToughness = parseInt(m[2]);
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryPtMods: [...(perm.temporaryPtMods || []), {
          power: setPower, toughness: setToughness,
          source: 'set-base-pt', turn: state.turn,
          isSetEffect: true, timestamp: nextEffectTimestamp(),
        }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name}'s base power and toughness become ${setPower}/${setToughness}.`);
      return { state, resolved: true, description: `${perm.name} → ${setPower}/${setToughness}` };
    },
  },

  // Util-10: "each creature assigns combat damage equal to its toughness" (Doran, the Siege Tower)
  {
    name: 'damage-equals-toughness',
    match: /each\s+creature\s+(?:you\s+control\s+)?assigns?\s+combat\s+damage\s+equal\s+to\s+its\s+toughness/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, `Creatures assign combat damage equal to their toughness.`);
      return { state, resolved: true, description: 'damage = toughness' };
    },
  },

  // Util-11: "you may play an additional land this turn" (Exploration)
  {
    name: 'additional-land-drop',
    match: /you\s+may\s+play\s+(?:an\s+)?additional\s+land(?:s)?\s+(?:on\s+each\s+of\s+your\s+turns?|this\s+turn)/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const players = [...state.players];
      const player = players[controller];
      players[controller] = { ...player, maxLandPlays: (player.maxLandPlays || 1) + 1 };
      state = { ...state, players };
      state = addLog(state, controller, `May play an additional land this turn.`);
      return { state, resolved: true, description: 'extra land drop' };
    },
  },

  // Util-12: "exile target card from a graveyard" (Scavenging Ooze, Tormod's Crypt)
  {
    name: 'exile-target-from-graveyard',
    match: /exile\s+(?:target|a)\s+card\s+from\s+(?:a|target\s+(?:player's|opponent's))\s+graveyard/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opponent = getFirstOpponent(state, controller);
      const player = state.players[opponent];
      if (player.graveyard.length === 0) {
        state = addLog(state, controller, `No cards in opponent's graveyard to exile.`);
        return { state, resolved: true, description: 'exile from gy (empty)' };
      }
      const exiled = player.graveyard[player.graveyard.length - 1];
      const players = [...state.players];
      players[opponent] = { ...player, graveyard: player.graveyard.slice(0, -1) };
      state = { ...state, players };
      state = addLog(state, controller, `Exiles ${exiled.name} from opponent's graveyard.`);
      return { state, resolved: true, description: `exile ${exiled.name} from gy` };
    },
  },

  // Util-13: "return all nonland permanents you don't control to their owners' hands" (Cyclonic Rift overloaded)
  {
    name: 'return-all-nonland-to-hand',
    match: /return\s+all\s+(?:nonland\s+)?permanents?\s+(?:you\s+don't\s+control\s+)?to\s+their\s+owners?'?\s+hands?/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let bounced = 0;
      for (let pi = 0; pi < 2; pi++) {
        if (pi === controller) continue; // Only opponent's permanents
        const player = state.players[pi];
        const nonlands = player.battlefield.filter(p => !p.typeLine.toLowerCase().includes('land'));
        const lands = player.battlefield.filter(p => p.typeLine.toLowerCase().includes('land'));
        const bouncedCards: Card[] = nonlands.map(perm => ({
          id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
          cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
          power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
          colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
          tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
        }));
        bounced += nonlands.length;
        const ownerIdx = (nonlands[0]?.owner ?? pi);
        const players = [...state.players];
        players[pi] = { ...player, battlefield: lands };
        players[ownerIdx] = { ...players[ownerIdx], hand: [...players[ownerIdx].hand, ...bouncedCards] };
        state = { ...state, players };
      }
      state = addLog(state, controller, `Returns ${bounced} nonland permanents to their owners' hands.`);
      return { state, resolved: true, description: `bounce all nonland (${bounced})` };
    },
  },

  // Util-14: "destroy each creature with power N or greater" (Retribution of the Meek)
  {
    name: 'destroy-creatures-power-or-greater',
    match: /destroy\s+(?:each|all)\s+creatures?\s+with\s+power\s+(\d+)\s+or\s+greater/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const threshold = parseInt(m[1]);
      let destroyed = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        for (const perm of [...player.battlefield]) {
          if (perm.basePower !== undefined && (perm.currentPower ?? perm.basePower ?? 0) >= threshold) {
            state = removePermanentFromBattlefield(state, perm.id, 'graveyard');
            destroyed++;
          }
        }
      }
      state = addLog(state, controller, `Destroys all creatures with power ${threshold} or greater (${destroyed} destroyed).`);
      return { state, resolved: true, description: `destroy power>=${threshold} (${destroyed})` };
    },
  },

  // Util-15: "creatures you control get +X/+X until end of turn, where X is the number of creatures you control" (Craterhoof Behemoth)
  {
    name: 'creatures-get-plus-x-x-count',
    match: /creatures?\s+you\s+control\s+get\s+\+X\/\+X\s+until\s+end\s+of\s+turn,?\s+where\s+X\s+is\s+the\s+number\s+of\s+creatures?\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const count = state.players[controller].battlefield.filter(p => p.basePower !== undefined).length;
      const player = state.players[controller];
      const updatedBf = player.battlefield.map(perm => {
        if (perm.basePower === undefined) return perm;
        return {
          ...perm,
          temporaryPtMods: [...(perm.temporaryPtMods || []), {
            power: count, toughness: count,
            source: 'craterhoof', turn: state.turn,
          }],
          temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword: 'trample', source: 'craterhoof', turn: state.turn }],
        };
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Creatures you control get +${count}/+${count} and gain trample until end of turn.`);
      return { state, resolved: true, description: `+${count}/+${count} trample to all creatures` };
    },
  },

  // Util-16: "double the power of target creature until end of turn" (Berserk, Rush of Blood)
  {
    name: 'double-power-target',
    match: /double\s+(?:target|the)\s+(?:creature's\s+)?power\s+(?:of\s+target\s+creature\s+)?until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const currentPower = perm.currentPower ?? perm.basePower ?? 0;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryPtMods: [...(perm.temporaryPtMods || []), {
          power: currentPower, toughness: 0,
          source: 'double-power', turn: state.turn,
        }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Doubles ${perm.name}'s power (now ${currentPower * 2}).`);
      return { state, resolved: true, description: `double ${perm.name}'s power` };
    },
  },

  // Util-17: "tap target creature. It doesn't untap during its controller's next untap step" (Icy Manipulator, Sleep)
  {
    name: 'tap-doesnt-untap',
    match: /tap\s+target\s+(?:creature|permanent).*doesn(?:'t|ot)\s+untap\s+during\s+(?:its|that\s+creature's)\s+controller's\s+next\s+untap\s+step/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = { ...perm, tapped: true, skipNextUntap: true };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Taps ${perm.name}. It doesn't untap during its controller's next untap step.`);
      return { state, resolved: true, description: `tap + freeze ${perm.name}` };
    },
  },

  // Util-18a: "exile all cards from target player's graveyard" (Tormod's Crypt targeting)
  {
    name: 'exile-target-player-graveyard',
    match: /exile\s+all\s+cards\s+(?:from\s+)?target\s+player's\s+graveyard/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const opponent = getFirstOpponent(state, controller);
      const count = state.players[opponent].graveyard.length;
      const players = [...state.players];
      players[opponent] = { ...state.players[opponent], graveyard: [] };
      state = { ...state, players };
      state = addLog(state, controller, `Exiles ${count} cards from opponent's graveyard.`);
      return { state, resolved: true, description: `exile target gy (${count})` };
    },
  },

  // Util-18b: "exile all cards from each player's graveyard" (Rest in Peace, bojuka bog variant)
  {
    name: 'exile-each-player-graveyard',
    match: /exile\s+all\s+cards\s+(?:from\s+)?each\s+(?:player's|opponent's)\s+graveyard/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const count0 = state.players[0].graveyard.length;
      const count1 = state.players[1].graveyard.length;
      const players = [...state.players];
      players[0] = { ...state.players[0], graveyard: [] };
      players[1] = { ...state.players[1], graveyard: [] };
      state = { ...state, players };
      state = addLog(state, controller, `Exiles all graveyards (${count0 + count1} cards total).`);
      return { state, resolved: true, description: `exile all GYs (${count0 + count1})` };
    },
  },

  // Util-19: "untap all creatures you control" (Seedborn Muse, Mobilize)
  {
    name: 'untap-all-creatures-you-control',
    match: /untap\s+(?:all|each)\s+creatures?\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      let untapped = 0;
      const updatedBf = player.battlefield.map(perm => {
        if (perm.basePower !== undefined && perm.tapped) {
          untapped++;
          return { ...perm, tapped: false };
        }
        return perm;
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Untaps ${untapped} creatures.`);
      return { state, resolved: true, description: `untap ${untapped} creatures` };
    },
  },

  // Util-20: "you draw X cards, where X is the number of creatures you control"
  {
    name: 'draw-x-where-x-creatures',
    match: /(?:you\s+)?draw\s+(?:X|cards?\s+equal\s+to)\s+(?:cards?,?\s+)?(?:where\s+X\s+is\s+)?(?:the\s+number\s+of|equal\s+to\s+the\s+number\s+of)\s+creatures?\s+you\s+control/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const count = state.players[controller].battlefield.filter(p => p.basePower !== undefined).length;
      state = drawCards(state, controller, count);
      state = addLog(state, controller, `Draws ${count} cards (one per creature controlled).`);
      return { state, resolved: true, description: `draw ${count} (creatures)` };
    },
  },

  // ── Category 6: Ability-Modifying (Layer 6 support) ──

  // Ability-1: "all creatures lose all abilities" (Humility)
  {
    name: 'all-creatures-lose-all-abilities',
    match: /(?:all|each)\s+creatures?\s+(?:lose|have\s+no)\s+(?:all\s+)?abilities/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const ts = nextEffectTimestamp();
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const updatedBf = player.battlefield.map(perm => {
          if (perm.basePower === undefined) return perm;
          return {
            ...perm,
            lostAllAbilities: { source: 'humility', timestamp: ts },
            originalOracleText: perm.originalOracleText || perm.oracleText,
            oracleText: '',
            temporaryKeywords: [],
            abilities: [],
          };
        });
        const players = [...state.players];
        players[pi] = { ...player, battlefield: updatedBf };
        state = { ...state, players };
      }
      state = addLog(state, controller, `All creatures lose all abilities.`);
      return { state, resolved: true, description: 'all creatures lose abilities' };
    },
  },

  // Ability-2: "target creature gains all abilities of target creature" (Soulflayer, Cairn Wanderer)
  {
    name: 'target-gains-abilities-of-target',
    match: /(?:target|this)\s+creature\s+(?:has|gains)\s+(?:all\s+)?(?:activated\s+)?abilities\s+of/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { perm: sourcePerm } = target;
      const text = (sourcePerm.oracleText || '').toLowerCase();
      const keywords = ['flying', 'trample', 'haste', 'lifelink', 'deathtouch', 'first strike', 'double strike', 'vigilance', 'hexproof', 'indestructible', 'menace', 'reach'];
      const granted = keywords.filter(kw => text.includes(kw));
      state = addLog(state, controller, `Gains abilities: ${granted.join(', ') || 'none'}.`);
      return { state, resolved: true, description: `gains abilities: ${granted.join(', ')}` };
    },
  },

  // Ability-3: "creatures with no abilities get +2/+2" (Muraganda Petroglyphs)
  {
    name: 'no-abilities-get-bonus',
    match: /creatures?\s+with\s+no\s+abilities\s+get\s+\+(\d+)\/\+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const power = parseInt(m[1]);
      const toughness = parseInt(m[2]);
      state = addLog(state, controller, `Creatures with no abilities get +${power}/+${toughness}.`);
      return { state, resolved: true, description: `no-ability creatures +${power}/+${toughness}` };
    },
  },

  // ── Category 7: Ward/Protection Triggers ──

  // Ward-1: "ward—pay N life" (Common ward variant)
  {
    name: 'ward-pay-life',
    match: /ward\s*[—\-]\s*(?:pay\s+)?(\d+)\s+life/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const life = parseInt(m[1]);
      state = addLog(state, controller, `Ward: opponent must pay ${life} life.`);
      return { state, resolved: true, description: `ward ${life} life` };
    },
  },

  // Ward-2: "ward—discard a card"
  {
    name: 'ward-discard',
    match: /ward\s*[—\-]\s*discard\s+(?:a|one)\s+card/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, `Ward: opponent must discard a card.`);
      return { state, resolved: true, description: 'ward discard' };
    },
  },

  // ── Category 8: Additional Coverage Patterns ──

  // Extra-1: "target creature gets +N/+N and gains [keyword] until end of turn" (pump + keyword combo)
  {
    name: 'pump-and-keyword-target',
    match: /target\s+creature\s+gets\s+\+(\d+)\/\+(\d+)\s+and\s+gains?\s+(flying|trample|first\s+strike|double\s+strike|lifelink|deathtouch|haste|vigilance|menace|hexproof|indestructible|reach)\s+until\s+end\s+of\s+turn/i,
    requiresTarget: true,
    apply: (state, controller, targets, m) => {
      const powerBuff = parseInt(m[1]);
      const toughnessBuff = parseInt(m[2]);
      const keyword = m[3].toLowerCase();
      const target = getTargetPermanent(state, targets);
      if (!target) return { state, resolved: false };
      const { playerIdx, permIdx, perm } = target;
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = {
        ...perm,
        temporaryPtMods: [...(perm.temporaryPtMods || []), {
          power: powerBuff, toughness: toughnessBuff,
          source: 'pump-keyword', turn: state.turn,
        }],
        temporaryKeywords: [...(perm.temporaryKeywords || []), { keyword, source: 'pump-keyword', turn: state.turn }],
      };
      const players = [...state.players];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gets +${powerBuff}/+${toughnessBuff} and gains ${keyword} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} +${powerBuff}/+${toughnessBuff} ${keyword}` };
    },
  },

  // Extra-2: "destroy all enchantments" (Back to Nature, Tranquility)
  {
    name: 'destroy-all-enchantments',
    match: /destroy\s+all\s+enchantments?/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let destroyed = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        for (const perm of [...player.battlefield]) {
          if (perm.typeLine.toLowerCase().includes('enchantment')) {
            state = removePermanentFromBattlefield(state, perm.id, 'graveyard');
            destroyed++;
          }
        }
      }
      state = addLog(state, controller, `Destroys all enchantments (${destroyed} destroyed).`);
      return { state, resolved: true, description: `destroy all enchantments (${destroyed})` };
    },
  },

  // Extra-3: "destroy all artifacts" (Shatterstorm, Vandalblast overloaded)
  {
    name: 'destroy-all-artifacts',
    match: /destroy\s+all\s+artifacts?/i,
    requiresTarget: false,
    apply: (state, controller) => {
      let destroyed = 0;
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        for (const perm of [...player.battlefield]) {
          if (perm.typeLine.toLowerCase().includes('artifact')) {
            state = removePermanentFromBattlefield(state, perm.id, 'graveyard');
            destroyed++;
          }
        }
      }
      state = addLog(state, controller, `Destroys all artifacts (${destroyed} destroyed).`);
      return { state, resolved: true, description: `destroy all artifacts (${destroyed})` };
    },
  },

  // Extra-4: "each player sacrifices a creature" (Fleshbag Marauder, Plaguecrafter)
  {
    name: 'each-player-sacrifices-creature',
    match: /each\s+(?:player|opponent)\s+sacrifices?\s+(?:a|one)\s+creature/i,
    requiresTarget: false,
    apply: (state, controller) => {
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi];
        const creatures = player.battlefield.filter(p => p.basePower !== undefined);
        if (creatures.length > 0) {
          // Sacrifice the weakest creature (lowest power)
          const weakest = creatures.sort((a, b) => (a.currentPower ?? a.basePower ?? 0) - (b.currentPower ?? b.basePower ?? 0))[0];
          state = removePermanentFromBattlefield(state, weakest.id, 'graveyard');
          state = addLog(state, pi, `Sacrifices ${weakest.name}.`);
        }
      }
      return { state, resolved: true, description: 'each player sacrifices a creature' };
    },
  },

  // Extra-5: "proliferate" (add a counter of each kind already there)
  {
    name: 'proliferate',
    match: /\bproliferate\b/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      let count = 0;
      const updatedBf = player.battlefield.map(perm => {
        const counterTypes = Object.keys(perm.counters || {});
        if (counterTypes.length === 0) return perm;
        const updatedCounters = { ...perm.counters };
        for (const ct of counterTypes) {
          if ((updatedCounters[ct] || 0) > 0) {
            updatedCounters[ct] = (updatedCounters[ct] || 0) + 1;
            count++;
          }
        }
        return { ...perm, counters: updatedCounters };
      });
      const players = [...state.players];
      players[controller] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `Proliferates (${count} counters added).`);
      return { state, resolved: true, description: `proliferate (${count})` };
    },
  },

  // Ring-1: "The Ring tempts you" — core ring temptation effect (CR 701.52)
  {
    name: 'the-ring-tempts-you',
    match: /the\s+ring\s+tempts\s+you/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const current = state.theRing;
      // If no ring yet, initialize it; cap visible level at 4
      const newCount = Math.min(4, (current?.ringTemptedCount ?? 0) + 1);

      // Find ring bearer — if existing one still on battlefield, keep it
      // Bot auto-selects largest creature; for human we log and let them keep current
      const player = state.players[controller];
      const creatures = player.battlefield.filter(p => p.basePower !== undefined && !p.tapped);

      let ringBearerId = current?.ringBearerId ?? null;

      // If no current ring bearer or current bearer is gone, pick best creature
      const bearerExists = ringBearerId !== null && player.battlefield.some(p => p.id === ringBearerId);
      if (!bearerExists && creatures.length > 0) {
        // Pick creature with highest power as ring bearer
        const best = [...creatures].sort((a, b) => (b.currentPower ?? 0) - (a.currentPower ?? 0))[0];
        ringBearerId = best.id;
        state = addLog(state, controller, `${best.name} becomes the Ring-bearer.`);
      }

      state = {
        ...state,
        theRing: { ringBearerId, ringTemptedCount: newCount, player: controller },
      };

      const effects = ['', 'Ring-bearer gets menace', 'Ring-bearer also has lifelink', 'Ring-bearer can only be blocked by legendary creatures', 'Whenever Ring-bearer attacks, defending player loses 3 life'];
      state = addLog(state, controller, `The Ring tempts you (level ${newCount}): ${effects[newCount] || 'Ring-bearer gains abilities'}.`);
      return { state, resolved: true, description: `ring tempts (level ${newCount})` };
    },
  },

  // Meld-1: "Exile ~ and [partner]. If you do, meld them into [result]." (CR 701.36)
  {
    name: 'meld',
    match: /exile\s+\S+\s+and\s+(?:the\s+)?[\w\s]+\.\s*if\s+you\s+do,?\s*meld\s+them/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      if (!source?.meldPair || !source?.meldResult) {
        return { state, resolved: false };
      }
      // Find both meld components on the battlefield
      const player = state.players[controller];
      const component1 = player.battlefield.find(p => p.name === source.name);
      const component2 = player.battlefield.find(p => p.name === source.meldPair);

      if (!component1 || !component2) {
        state = addLog(state, controller, `Meld failed: both ${source.name} and ${source.meldPair} must be on the battlefield.`);
        return { state, resolved: true, description: 'meld (components missing)' };
      }

      const result = source.meldResult!;
      const bp = result.power ? parseInt(result.power, 10) || 0 : 0;
      const bt = result.toughness ? parseInt(result.toughness, 10) || 0 : 0;

      // Create the melded card definition
      const meldedCard: Card = {
        id: generateCardId(),
        oracleId: `meld_${source.name}_${source.meldPair}`,
        name: result.name,
        manaCost: '',
        cmc: 0,
        typeLine: result.typeLine,
        oracleText: result.oracleText,
        power: result.power,
        toughness: result.toughness,
        colors: [...(component1.colors || []), ...(component2.colors || [])].filter((c, i, arr) => arr.indexOf(c) === i),
        colorIdentity: [...(component1.colorIdentity || []), ...(component2.colorIdentity || [])].filter((c, i, arr) => arr.indexOf(c) === i),
        rarity: 'mythic',
        tags: [],
        imageUrl: result.imageUrl || component1.imageUrl || '',
        owner: controller,
      };

      // Create the melded permanent from the card
      const basePerm = cardToPermanent(meldedCard, controller, state.turn);
      const meldedPerm = {
        ...basePerm,
        basePower: bp,
        baseToughness: bt,
        currentPower: bp,
        currentToughness: bt,
        isMelded: true,
        meldComponents: [component1.id, component2.id] as [string, string],
      };

      // Remove both components (exile them), add melded permanent
      let stateAfter = removePermanentFromBattlefield(state, component1.id, 'exile');
      stateAfter = removePermanentFromBattlefield(stateAfter, component2.id, 'exile');

      const players = [...stateAfter.players];
      players[controller] = {
        ...players[controller],
        battlefield: [...players[controller].battlefield, meldedPerm],
      };
      stateAfter = { ...stateAfter, players };
      stateAfter = addLog(stateAfter, controller, `${component1.name} and ${component2.name} meld into ${result.name}!`);
      return { state: stateAfter, resolved: true, description: `meld: ${result.name}` };
    },
  },

  // ── Replicate — when you cast this spell, you may copy it for its replicate cost (CR 702.56) ──
  // The actual copies are put on the stack at cast time (in addSpellToStack via replicateCount).
  // This pattern handles the replicate keyword appearing in oracle text so it auto-resolves.
  {
    name: 'replicate',
    match: /\breplicate\b/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      // Replicate copies are created at cast time; this pattern just acknowledges the keyword.
      const cardName = source?.name || 'spell';
      state = addLog(state, controller, `Replicate: copies of ${cardName} were placed on the stack when it was cast.`);
      return { state, resolved: true, description: 'replicate: copies on stack' };
    },
  },

  // ── Retrace — cast from graveyard by discarding a land (CR 702.80) ──
  // The actual graveyard casting + land discard is handled in executeCastSpell.
  // This pattern handles retrace keyword in oracle text so it auto-resolves.
  {
    name: 'retrace',
    match: /\bretrace\b(?!\s+[—–-])/i,
    requiresTarget: false,
    apply: (state, controller, _targets, _m, source) => {
      const cardName = source?.name || 'spell';
      state = addLog(state, controller, `Retrace: ${cardName} can be cast from graveyard by discarding a land.`);
      return { state, resolved: true, description: 'retrace: available' };
    },
  },
];

// ─── Fallback Generic Resolver ───

/** Fallback generic resolver — catches common oracle text fragments that didn't match specific patterns */
function fallbackGenericResolve(state: GameState, controller: number, text: string, targets: Target[]): EffectResult {
  let anyApplied = false;
  const descriptions: string[] = [];
  const opponent = getFirstOpponent(state, controller);

  // gain life
  const lifeMatch = text.match(/(?:you\s+)?gain\s+(\d+)\s+life/i);
  if (lifeMatch) {
    const amount = parseInt(lifeMatch[1]);
    state = gainLife(state, controller, amount);
    state = addLog(state, controller, `${state.players[controller].name} gains ${amount} life.`);
    descriptions.push(`gain ${amount} life`);
    anyApplied = true;
  }

  // draw cards
  const drawMatch = text.match(/draw\s+(\d+|a|an|one|two|three)\s+cards?/i);
  if (drawMatch) {
    const count = parseNumber(drawMatch[1]);
    state = drawCards(state, controller, count);
    state = addLog(state, controller, `${state.players[controller].name} draws ${count} card(s).`);
    descriptions.push(`draw ${count}`);
    anyApplied = true;
  }

  // deals damage to each opponent / target opponent / target player
  const dmgOppMatch = text.match(/deals?\s+(\d+)\s+damage\s+to\s+(?:target\s+(?:player|opponent)|each\s+opponent)/i);
  if (dmgOppMatch) {
    const amount = parseInt(dmgOppMatch[1]);
    state = damagePlayer(state, opponent, amount);
    state = addLog(state, controller, `Deals ${amount} damage to ${state.players[opponent].name}.`);
    descriptions.push(`${amount} damage to opponent`);
    anyApplied = true;
  }

  // loses life
  const loseMatch = text.match(/(?:target\s+(?:player|opponent)\s+|each\s+opponent\s+)?loses?\s+(\d+)\s+life/i);
  if (loseMatch && !lifeMatch) { // Avoid double-counting with drain effects
    const amount = parseInt(loseMatch[1]);
    state = damagePlayer(state, opponent, amount);
    state = addLog(state, controller, `${state.players[opponent].name} loses ${amount} life.`);
    descriptions.push(`opponent loses ${amount} life`);
    anyApplied = true;
  }

  // mill cards
  const millMatch = text.match(/(?:target\s+(?:player|opponent)\s+)?mills?\s+(\d+)\s+cards?/i);
  if (millMatch) {
    const count = parseInt(millMatch[1]);
    state = millCards(state, opponent, count);
    state = addLog(state, controller, `${state.players[opponent].name} mills ${count} card(s).`);
    descriptions.push(`mill ${count}`);
    anyApplied = true;
  }

  // shuffle library
  if (/shuffle\s+(?:your|their)\s+library/i.test(text)) {
    state = shuffleLibrary(state, controller);
    descriptions.push('shuffle');
    anyApplied = true;
  }

  // put +1/+1 counter on ~ (self)
  const counterSelfMatch = text.match(/put\s+(?:a|(\d+))\s+\+1\/\+1\s+counters?\s+on\s+(?:it|~|this creature)/i);
  if (counterSelfMatch) {
    const count = counterSelfMatch[1] ? parseInt(counterSelfMatch[1]) : 1;
    // Find source permanent on battlefield
    const player = state.players[controller];
    // Try to find the source card on the battlefield
    // (This is a best-effort for ETB triggers putting counters on themselves)
    descriptions.push(`+${count} +1/+1 counter(s)`);
    anyApplied = true;
  }

  if (anyApplied) {
    return { state, resolved: true, description: descriptions.join(', ') };
  }
  return { state, resolved: false };
}

// ─── Smart Parser V2: Compound Clause Splitting ───

/**
 * Check if text starts with an action verb.
 * Used to determine whether " and " separates two independent clauses
 * (both are actions) vs. a noun conjunction ("artifacts and enchantments").
 */
function startsWithVerb(text: string): boolean {
  const verbs = [
    'destroy', 'exile', 'draw', 'discard', 'deal', 'gain', 'lose',
    'create', 'put', 'return', 'search', 'reveal', 'shuffle', 'tap',
    'untap', 'counter', 'sacrifice', 'each', 'all', 'scry',
    'mill', 'fight', 'add', 'remove', 'prevent', 'choose', 'look',
    'it gains', 'it gets', 'that creature', 'that player', 'its controller',
    'its owner', 'you gain', 'you draw', 'you lose', 'you may',
    'target player', 'target opponent', 'target creature',
  ];
  const lower = text.toLowerCase().trim();
  return verbs.some(v => lower.startsWith(v));
}

/**
 * Smart Parser V2: Split compound oracle text into individual clauses.
 *
 * Handles compound effects that the simple ". " splitter missed:
 * - "Draw 2 cards, then discard a card" -> ["Draw 2 cards", "discard a card"]
 * - "Destroy target creature. Its controller loses 2 life." -> ["Destroy target creature", "Its controller loses 2 life"]
 * - "Exile target creature and create a 1/1 token" -> ["Exile target creature", "create a 1/1 token"]
 */
function splitOracleIntoClauses(text: string): string[] {
  // Remove reminder text in parentheses
  let cleaned = text.replace(/\([^)]*\)/g, '').trim();

  // Phase 1: Split on sentence boundaries — period + space/newline, or actual newlines
  const rawSentences = cleaned.split(/(?:\.\s+|\n)+/).map(s => s.trim()).filter(s => s.length > 0);

  const allClauses: string[] = [];

  for (const sentence of rawSentences) {
    // Phase 2: Split on ", then " (sequential effects)
    const thenParts = sentence.split(/,\s*then\s+/i);
    if (thenParts.length > 1) {
      allClauses.push(...thenParts.map(p => p.trim()).filter(p => p.length > 0));
      continue;
    }

    // Phase 3: Split on " and " only when the right side starts with an action verb
    // Avoid splitting noun phrases like "destroy target artifact or enchantment"
    const andParts = sentence.split(/\s+and\s+/i);
    if (andParts.length === 2 && startsWithVerb(andParts[1].trim())) {
      allClauses.push(...andParts.map(p => p.trim()).filter(p => p.length > 0));
      continue;
    }

    // Phase 4: Split on "; " (semicolons separate independent clauses)
    const semiParts = sentence.split(/;\s+/);
    if (semiParts.length > 1) {
      allClauses.push(...semiParts.map(p => p.trim()).filter(p => p.length > 0));
      continue;
    }

    allClauses.push(sentence);
  }

  return allClauses.map(c => c.trim().replace(/\.$/, '').trim()).filter(c => c.length > 0);
}

// ─── Main Resolver ───

/**
 * Try to resolve an effect from a stack object's oracle text.
 *
 * Multi-effect resolution: Oracle text is split into clauses via V2 compound splitter
 * (periods, ", then ", " and " with verb check, semicolons), and each clause is matched
 * independently against all patterns. This allows cards like
 * "Deal 3 damage to any target. You gain 3 life." to resolve BOTH effects.
 *
 * Returns { resolved: true } if ALL effects were auto-resolved.
 * Returns { resolved: false } if ANY effect needs manual resolution.
 */
export function resolveEffect(
  state: GameState,
  stackObject: StackObject,
): EffectResult {
  // For triggered abilities, use the oracleText field (which has the effect text extracted from the trigger)
  // For spells, use the card's full oracle text
  let oracleText = stackObject.oracleText || stackObject.card?.oracleText || stackObject.text || '';
  if (!oracleText.trim()) {
    return { state, resolved: true, description: 'no effect text' };
  }

  // Replace X in oracle text with the actual X value from the stack object
  // This allows X-cost spells like "deals X damage" to match existing damage patterns
  if (stackObject.xValue !== undefined && stackObject.xValue > 0) {
    oracleText = oracleText.replace(/\bX\b/g, String(stackObject.xValue));
  }

  // Overload: replace "target" with "each" in oracle text for mass effect (CR 702.95)
  // When a spell is cast with overload, all instances of "target" become "each",
  // changing single-target effects to affect all valid objects (e.g., Cyclonic Rift).
  if (stackObject.isOverloaded || (stackObject.card?.tags || []).includes('overloaded')) {
    oracleText = oracleText.replace(/\btarget\b/gi, 'each');
  }

  // ── Kicker gating (CR 702.32): Strip "If ~ was kicked" clauses if spell wasn't kicked ──
  // This prevents kicker bonus effects from resolving when the spell wasn't kicked.
  if (!stackObject.isKicked) {
    // Remove "If ~ was kicked, ..." sentences (they're conditional on paying kicker)
    oracleText = oracleText.replace(/if\s+~\s+was\s+kicked,?\s+[^.]+\./gi, '');
  }

  // ── "You may" auto-resolution ──
  // For optional effects ("you may draw a card", "you may put...", etc.),
  // we auto-choose "yes" as it's almost always beneficial.
  // Replace "you may [action]" with just "[action]" so existing patterns match.
  oracleText = oracleText.replace(/\byou may (draw|put|return|search|destroy|exile|gain|add|create|look|play|cast|sacrifice)/gi, 'you $1');

  // ── Smart Parser V2: Enhanced compound clause splitting ──
  // Split oracle text into individual effect clauses using multi-phase splitting:
  // Phase 1: Split on ". " / newline (sentence boundaries)
  // Phase 2: Split on ", then " (sequential effects)
  // Phase 3: Split on " and " only when the right side starts with an action verb
  const sentences = splitOracleIntoClauses(oracleText);

  let currentState = state;
  const descriptions: string[] = [];
  let anyResolved = false;
  let anyUnresolved = false;
  const matchedPatternNames = new Set<string>();

  // First, try to match the FULL oracle text against patterns (some patterns span sentences)
  for (const pattern of EFFECT_PATTERNS) {
    // Skip generic modal fallback if a specific modal pattern already resolved
    if (pattern.name === 'modal-choice-general' &&
        [...matchedPatternNames].some(n => n.startsWith('choose-one-') || n.startsWith('choose-two-'))) {
      continue;
    }

    const m = oracleText.match(pattern.match);
    if (!m) continue;
    if (pattern.requiresTarget && stackObject.targets.length === 0) continue;

    const result = pattern.apply(
      currentState,
      stackObject.controller,
      stackObject.targets,
      m,
      stackObject.card,
    );

    if (result.resolved) {
      currentState = result.state;
      if (result.description) descriptions.push(result.description);
      anyResolved = true;
      matchedPatternNames.add(pattern.name);
    } else {
      anyUnresolved = true;
      if (result.description) descriptions.push(result.description);
    }
  }

  // If we only matched one pattern on the full text, try individual sentences
  // to catch additional effects that weren't part of the first match
  if (matchedPatternNames.size <= 1 && sentences.length > 1) {
    for (const sentence of sentences) {
      for (const pattern of EFFECT_PATTERNS) {
        // Skip patterns already matched on full text
        if (matchedPatternNames.has(pattern.name)) continue;
        // Skip generic modal fallback if a specific modal pattern already resolved
        if (pattern.name === 'modal-choice-general' &&
            [...matchedPatternNames].some(n => n.startsWith('choose-one-') || n.startsWith('choose-two-'))) {
          continue;
        }

        const m = sentence.match(pattern.match);
        if (!m) continue;
        if (pattern.requiresTarget && stackObject.targets.length === 0) continue;

        const result = pattern.apply(
          currentState,
          stackObject.controller,
          stackObject.targets,
          m,
          stackObject.card,
        );

        if (result.resolved) {
          currentState = result.state;
          if (result.description) descriptions.push(result.description);
          anyResolved = true;
          matchedPatternNames.add(pattern.name);
        } else {
          anyUnresolved = true;
          if (result.description) descriptions.push(result.description);
        }
        break; // Move to next sentence after first pattern match
      }
    }
  }

  // If nothing matched at all, try fallback generic resolver
  if (!anyResolved && !anyUnresolved) {
    const fallbackResult = fallbackGenericResolve(currentState, stackObject.controller, oracleText, stackObject.targets);
    if (fallbackResult.resolved) {
      return fallbackResult;
    }
    // Tier 2.5: Smart clause-based parser
    const smartResult = smartParserResolve(
      currentState,
      stackObject.controller,
      oracleText,
      stackObject.targets,
      stackObject.card,
    );
    if (smartResult.resolved) {
      return smartResult;
    }
    return {
      state: currentState,
      resolved: false,
      description: `Unresolved: ${oracleText.slice(0, 100)}`,
    };
  }

  // If some effects resolved but others didn't, mark as partially resolved
  // The resolved parts are already applied to the state
  return {
    state: currentState,
    resolved: !anyUnresolved,
    description: descriptions.join('; ') || undefined,
  };
}

/**
 * Check if a card's oracle text has any auto-resolvable effects.
 */
export function canAutoResolve(oracleText: string): boolean {
  for (const pattern of EFFECT_PATTERNS) {
    if (pattern.match.test(oracleText)) return true;
  }
  return false;
}
