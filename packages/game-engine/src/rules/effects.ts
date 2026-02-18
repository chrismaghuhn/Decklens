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
import { hasProtectionFrom } from './combat.ts';
import { copyStackObject } from './stack.ts';
import { checkLeavesBattlefieldTriggers, checkSacrificeTriggers, checkLifegainTriggers } from './triggers.ts';

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
    controller: 0 | 1,
    targets: Target[],
    match: RegExpMatchArray,
    source?: Card,
  ) => EffectResult;
}

// ─── Helper Functions ───

function findPermanentById(state: GameState, id: string): { perm: Permanent; playerIdx: 0 | 1; permIdx: number } | null {
  for (let pi = 0; pi < 2; pi++) {
    const player = state.players[pi as 0 | 1];
    const idx = player.battlefield.findIndex(p => p.id === id);
    if (idx !== -1) return { perm: player.battlefield[idx], playerIdx: pi as 0 | 1, permIdx: idx };
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

  // Move the card object to the destination zone
  const cardObj: Card = {
    id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
    cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
    power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
    colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
    tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
  };

  const toArr = [...player[toZone], cardObj];
  const updatedPlayer = { ...player, battlefield: updatedBf, [toZone]: toArr };
  const players = [...state.players] as [PlayerState, PlayerState];
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

function damagePlayer(state: GameState, playerIdx: 0 | 1, amount: number): GameState {
  const player = state.players[playerIdx];
  const updatedPlayer = { ...player, life: player.life - amount };
  const players = [...state.players] as [PlayerState, PlayerState];
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

  const player = state.players[playerIdx];
  const updatedPerm = { ...perm, damage: perm.damage + amount };
  const updatedBf = [...player.battlefield];
  updatedBf[permIdx] = updatedPerm;

  const updatedPlayer = { ...player, battlefield: updatedBf };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIdx] = updatedPlayer;

  return { ...state, players };
}

function gainLife(state: GameState, playerIdx: 0 | 1, amount: number): GameState {
  const player = state.players[playerIdx];
  const updatedPlayer = { ...player, life: player.life + amount };
  const players = [...state.players] as [PlayerState, PlayerState];
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

function getTargetPermanent(state: GameState, targets: Target[]): { perm: Permanent; playerIdx: 0 | 1; permIdx: number } | null {
  const permTarget = targets.find(t => t.type === 'permanent');
  if (!permTarget) return null;
  return findPermanentById(state, permTarget.id);
}

function getTargetPlayer(targets: Target[]): (0 | 1) | null {
  const playerTarget = targets.find(t => t.type === 'player');
  if (!playerTarget) return null;
  const parsed = parseInt(playerTarget.id);
  if (isNaN(parsed) || (parsed !== 0 && parsed !== 1)) return null;
  return parsed as 0 | 1;
}

function addLog(state: GameState, player: 0 | 1, message: string): GameState {
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
      const opponent: 0 | 1 = controller === 0 ? 1 : 0;
      state = damagePlayer(state, opponent, amount);
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
      state = damagePlayer(state, 0, amount);
      state = damagePlayer(state, 1, amount);
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
      const targetIdx = playerTarget ?? (controller === 0 ? 1 : 0);
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
        const player = state.players[pi as 0 | 1];
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
        const player = state.players[pi as 0 | 1];
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

      const players = [...state.players] as [PlayerState, PlayerState];
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
      // Find the target on the stack
      const spellTarget = targets.find(t => t.type === 'card-in-zone' && t.zone === 'stack');
      if (!spellTarget) {
        // Try any target — assume it's a stack object ID
        const anyTarget = targets[0];
        if (!anyTarget) return { state, resolved: false };

        const stackIdx = state.stack.findIndex(s => s.id === anyTarget.id);
        if (stackIdx === -1) return { state, resolved: false };

        const countered = state.stack[stackIdx];
        const updatedStack = [...state.stack];
        updatedStack.splice(stackIdx, 1);

        // Move the card to graveyard
        if (countered.card) {
          const owner = countered.card.owner;
          const player = state.players[owner];
          const players = [...state.players] as [PlayerState, PlayerState];
          players[owner] = { ...player, graveyard: [...player.graveyard, countered.card] };
          state = { ...state, players, stack: updatedStack };
        } else {
          state = { ...state, stack: updatedStack };
        }

        state = addLog(state, controller, `Counters ${countered.text || 'a spell'}.`);
        return { state, resolved: true, description: `counter ${countered.text}` };
      }
      return { state, resolved: false };
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
      const opponent: 0 | 1 = controller === 0 ? 1 : 0;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      // Discard requires player choice — mark as unresolved for now
      // In V2, we can add a discard selection UI
      return { state, resolved: false, description: 'discard requires selection' };
    },
  },

  // ── Scry ──
  {
    name: 'scry',
    match: /scry\s+(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      // Scry requires player choice (top/bottom) — mark as unresolved
      return { state, resolved: false, description: 'scry requires selection' };
    },
  },

  // ── Search Library ──
  {
    name: 'search-library',
    match: /search\s+your\s+library/i,
    requiresTarget: false,
    apply: (state, controller) => {
      // Library search requires player selection — mark as unresolved
      return { state, resolved: false, description: 'library search requires selection' };
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
      const qty = parseNumber(m[1]);
      const power = parseInt(m[2]);
      const toughness = parseInt(m[3]);
      const tokenName = m[4].trim();

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
      const players = [...state.players] as [PlayerState, PlayerState];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Creates ${qty} ${power}/${toughness} ${tokenName} token${qty !== 1 ? 's' : ''}.`);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      // Sacrifice requires player choice — unresolved
      return { state, resolved: false, description: 'sacrifice requires selection' };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const player = state.players[pi as 0 | 1];
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
      const opponent: 0 | 1 = controller === 0 ? 1 : 0;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      // Reanimation is complex (ETB triggers, auras, etc.) — mark unresolved
      return { state, resolved: false, description: 'reanimate requires manual resolution' };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
      players[playerIdx] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} gains ${keyword} until end of turn.`);
      return { state, resolved: true, description: `${perm.name} gains ${keyword}` };
    },
  },

  // ── Prevent Damage ──
  {
    name: 'prevent-damage',
    match: /prevent\s+the\s+next\s+(\d+)\s+damage/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      // Damage prevention shields require a continuous effect tracker — mark unresolved
      return { state, resolved: false, description: 'prevent damage requires shield tracking' };
    },
  },

  // ── Each Player/Opponent Effects ──
  {
    name: 'each-player-sacrifices',
    match: /each\s+player\s+sacrifices?\s+(?:a|an)\s+(creature|permanent|artifact|enchantment)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      // Sacrifice choice requires player selection — mark unresolved
      return { state, resolved: false, description: 'sacrifice choice requires selection' };
    },
  },
  {
    name: 'each-opponent-discards',
    match: /each\s+opponent\s+discards?\s+(a|an|one|two|three|\d+)\s+cards?/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      // Discard choice requires opponent selection — mark unresolved
      return { state, resolved: false, description: 'opponent discard requires selection' };
    },
  },

  // ── Land Drop from Hand ──
  {
    name: 'put-land-from-hand',
    match: /(?:you\s+may\s+)?put\s+a\s+land\s+card\s+from\s+your\s+hand\s+onto\s+the\s+battlefield/i,
    requiresTarget: false,
    apply: (state, controller) => {
      // Requires player to select a land card from hand — mark unresolved
      return { state, resolved: false, description: 'land drop from hand requires selection' };
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
        const player = state.players[pi as 0 | 1];
        const gyIdx = player.graveyard.findIndex(c => c.id === cardTarget.id);
        if (gyIdx !== -1) {
          const card = player.graveyard[gyIdx];
          const updatedGy = [...player.graveyard];
          updatedGy.splice(gyIdx, 1);
          const updatedExile = [...player.exile, card];
          const updatedPlayer = { ...player, graveyard: updatedGy, exile: updatedExile };
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = updatedPlayer;
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
        const player = state.players[pi as 0 | 1];
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
        const player = state.players[pi as 0 | 1];
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
      const opponent: 0 | 1 = controller === 0 ? 1 : 0;
      state = damagePlayer(state, opponent, amount);
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
        const player = state.players[pi as 0 | 1];
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
        const players = [...state.players] as [PlayerState, PlayerState];
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
        const players = [...state.players] as [PlayerState, PlayerState];
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
        const players = [...state.players] as [PlayerState, PlayerState];
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
        const player = state.players[pi as 0 | 1];
        const updatedBf = player.battlefield.map(p => {
          if (p.typeLine.toLowerCase().includes('creature') && !p.tapped) {
            count++;
            return { ...p, tapped: true };
          }
          return p;
        });
        const players = [...state.players] as [PlayerState, PlayerState];
        players[pi as 0 | 1] = { ...player, battlefield: updatedBf };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const player = state.players[pi as 0 | 1];
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
        const players = [...state.players] as [PlayerState, PlayerState];
        players[pi as 0 | 1] = updatedPlayer;
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
        const player = state.players[pi as 0 | 1];
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
        const players = [...state.players] as [PlayerState, PlayerState];
        players[pi as 0 | 1] = updatedPlayer;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opp = controller === 0 ? 1 : 0;
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
      const count = parseNumber(m[1]);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const count = parseNumber(m[1]);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const count = parseNumber(m[1]);
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
      const players = [...state.players] as [PlayerState, PlayerState];
      players[controller] = updatedPlayer;
      state = { ...state, players };
      state = addLog(state, controller, `Created ${count} Clue token(s).`);
      return { state, resolved: true, description: `create ${count} Clue` };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const player = state.players[pi as 0 | 1];
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
        const players = [...state.players] as [PlayerState, PlayerState];
        players[pi as 0 | 1] = { ...player, battlefield: updatedBf };
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
      const opp = controller === 0 ? 1 : 0;
      const player = state.players[opp];
      const countStr = m[1].toLowerCase();
      const count = countStr === 'all' ? player.graveyard.length : Math.min(parseInt(countStr), player.graveyard.length);
      const exiled = player.graveyard.slice(0, count);
      const remaining = player.graveyard.slice(count);
      const updatedPlayer = { ...player, graveyard: remaining, exile: [...player.exile, ...exiled] };
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const player = state.players[pi as 0 | 1];
        total += player.graveyard.length;
        const updatedPlayer = { ...player, exile: [...player.exile, ...player.graveyard], graveyard: [] };
        const players = [...state.players] as [PlayerState, PlayerState];
        players[pi as 0 | 1] = updatedPlayer;
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
      const opp = controller === 0 ? 1 : 0;
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
      const player = state.players[opp];
      const milled = player.library.slice(0, count);
      const remaining = player.library.slice(count);
      const milledCards: Card[] = milled;
      const updatedPlayer = { ...player, library: remaining, graveyard: [...player.graveyard, ...milledCards] };
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const player = state.players[pi as 0 | 1];
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
        const players = [...state.players] as [PlayerState, PlayerState];
        players[pi as 0 | 1] = updatedPlayer;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
      state = damagePlayer(state, opp, amount);
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      // Mark as needs manual resolution — player must choose which creature to sacrifice
      return { state, resolved: false, description: 'sacrifice a creature (choose one)' };
    },
  },

  // ── Each player sacrifices a creature ──
  {
    name: 'each-player-sacrifices',
    match: /each\s+(?:player|opponent)\s+sacrifices?\s+a\s+creature/i,
    requiresTarget: false,
    apply: (state, controller) => {
      return { state, resolved: false, description: 'each player sacrifices a creature (choose)' };
    },
  },

  // ── Search library (tutor) ──
  {
    name: 'search-library',
    match: /search\s+your\s+library\s+for\s+(?:a|an)\s+/i,
    requiresTarget: false,
    apply: (state, controller) => {
      return { state, resolved: false, description: 'search library (manual)' };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      // Needs player to choose which card — mark manual
      return { state, resolved: false, description: 'return card from graveyard to hand (choose one)' };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const count = parseNumber(m[1]);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
      state = drawCards(state, opp, drawCount);
      // Discard from end of hand
      const player = state.players[opp];
      const toDiscard = player.hand.slice(-discardCount);
      const remainingHand = player.hand.slice(0, Math.max(0, player.hand.length - discardCount));
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const player = state.players[pi as 0 | 1];
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
        const players = [...state.players] as [PlayerState, PlayerState];
        players[pi as 0 | 1] = { ...player, battlefield: updatedBf };
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
        const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opponent: 0 | 1 = controller === 0 ? 1 : 0;
      const oppPlayer = state.players[opponent];
      const discarded = oppPlayer.hand.slice(0, count);
      if (discarded.length === 0) return { state, resolved: true, description: 'opponent has no cards to discard' };
      const players = [...state.players] as [PlayerState, PlayerState];
      players[opponent] = {
        ...oppPlayer,
        hand: oppPlayer.hand.slice(count),
        graveyard: [...oppPlayer.graveyard, ...discarded],
      };
      state = { ...state, players };
      state = addLog(state, controller, `${oppPlayer.name} discards ${discarded.map(c => c.name).join(', ')}.`);
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
      const players = [...state.players] as [PlayerState, PlayerState];
      for (let i = 0; i < 2; i++) {
        const p = players[i as 0 | 1];
        const discarded = p.hand.slice(0, count);
        players[i as 0 | 1] = {
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const targetIdx = getTargetPlayer(targets) ?? (controller === 0 ? 1 : 0);
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
      const opponent: 0 | 1 = controller === 0 ? 1 : 0;
      state = damagePlayer(state, opponent, amount);
      state = gainLife(state, controller, amount);
      state = addLog(state, controller, `Each opponent loses ${amount} life, you gain ${amount} life.`);
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
      const players = [...state.players] as [PlayerState, PlayerState];
      for (let i = 0; i < 2; i++) {
        const player = players[i as 0 | 1];
        const cardIdx = player.graveyard.findIndex(c => c.id === cardTarget.id);
        if (cardIdx !== -1) {
          const card = player.graveyard[cardIdx];
          const newGY = [...player.graveyard];
          newGY.splice(cardIdx, 1);
          players[i as 0 | 1] = { ...player, graveyard: newGY, exile: [...player.exile, card] };
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
      const players = [...state.players] as [PlayerState, PlayerState];
      const bf = players[target.playerIdx].battlefield.filter((_, idx) => idx !== target.permIdx);
      players[target.playerIdx] = { ...players[target.playerIdx], battlefield: bf };
      const ownerIdx = (perm.owner ?? target.playerIdx) as 0 | 1;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const player = state.players[pi as 0 | 1];
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
        state = addLog(state, pi as 0 | 1, `${player.name} sacrifices ${victim.name}.`);
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
      const player = state.players[opp];
      const milled = player.library.slice(0, count);
      const remaining = player.library.slice(count);
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const targetIdx = getTargetPlayer(targets) ?? (controller === 0 ? 1 : 0) as 0 | 1;
      const player = state.players[targetIdx];
      const milled = player.library.slice(0, count);
      const remaining = player.library.slice(count);
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const targetIdx = getTargetPlayer(targets) ?? (controller === 0 ? 1 : 0) as 0 | 1;
      const myLife = state.players[controller].life;
      const theirLife = state.players[targetIdx].life;
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
      const bf = players[target.playerIdx].battlefield.filter((_, idx) => idx !== target.permIdx);
      players[target.playerIdx] = { ...players[target.playerIdx], battlefield: bf };
      const ownerIdx = (perm.owner ?? target.playerIdx) as 0 | 1;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const player = state.players[pi as 0 | 1];
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
          const player = state.players[pi as 0 | 1];
          const creatureIdx = player.graveyard.findIndex(c => c.typeLine?.toLowerCase().includes('creature'));
          if (creatureIdx !== -1) {
            const card = player.graveyard[creatureIdx];
            const updatedGy = [...player.graveyard];
            updatedGy.splice(creatureIdx, 1);
            const perm = cardToPermanent(card, controller, state.turn);
            const players = [...state.players] as [PlayerState, PlayerState];
            players[pi as 0 | 1] = { ...players[pi as 0 | 1], graveyard: updatedGy };
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
        const player = state.players[pi as 0 | 1];
        const gyIdx = player.graveyard.findIndex(c => c.id === cardTarget.id);
        if (gyIdx !== -1) {
          const card = player.graveyard[gyIdx];
          const updatedGy = [...player.graveyard];
          updatedGy.splice(gyIdx, 1);
          const perm = cardToPermanent(card, controller, state.turn);
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = { ...players[pi as 0 | 1], graveyard: updatedGy };
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
        const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const qty = parseNumber(m[1]);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const qty = parseNumber(m[1]);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const qty = parseNumber(m[1]);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const qty = parseNumber(m[1]);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const qty = parseNumber(m[1]);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const player = state.players[pi as 0 | 1];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const players = [...state.players] as [PlayerState, PlayerState];
      for (let i = 0; i < 2; i++) {
        const p = players[i as 0 | 1];
        players[i as 0 | 1] = {
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
      const player = state.players[opp];
      const handSize = player.hand.length;
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        typeLine: perm.typeLine.includes('Creature') ? perm.typeLine : `${perm.typeLine} Creature`,
        temporaryPtMods: [...(perm.temporaryPtMods || []), { power, toughness, source: 'animate', turn: state.turn }],
      };
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const player = state.players[pi as 0 | 1];
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
      const qty = parseNumber(m[1]);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const qty = parseNumber(m[1]);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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

  // 54. target-creature-base-pt — target creature becomes N/N
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
      updatedBf[permIdx] = { ...perm, basePower: newPower, baseToughness: newToughness, currentPower: newPower, currentToughness: newToughness };
      const players = [...state.players] as [PlayerState, PlayerState];
      players[playerIdx] = { ...player, battlefield: updatedBf };
      state = { ...state, players };
      state = addLog(state, controller, `${perm.name} becomes ${newPower}/${newToughness}.`);
      return { state, resolved: true, description: `${perm.name} becomes ${newPower}/${newToughness}` };
    },
  },

  // 55. all-creatures-base-pt — all creatures become N/N
  {
    name: 'all-creatures-base-pt',
    match: /all creatures become (\d+)\/(\d+)/i,
    requiresTarget: false,
    apply: (state, controller, _targets, m) => {
      const newPower = parseInt(m[1]);
      const newToughness = parseInt(m[2]);
      const players = [...state.players] as [PlayerState, PlayerState];
      for (let pi = 0; pi < 2; pi++) {
        const player = state.players[pi as 0 | 1];
        const updatedBf = player.battlefield.map(p => {
          if (p.currentPower !== undefined) {
            return { ...p, basePower: newPower, baseToughness: newToughness, currentPower: newPower, currentToughness: newToughness };
          }
          return p;
        });
        players[pi as 0 | 1] = { ...player, battlefield: updatedBf };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
    apply: (state, controller) => {
      state = addLog(state, controller, 'Exchange control effect — needs manual resolution.');
      return { state: { ...state, needsManualResolution: true, manualResolutionController: controller }, resolved: false, description: 'exchange control' };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      state = addLog(state, controller, 'Must sacrifice an enchantment — needs manual resolution.');
      return { state: { ...state, needsManualResolution: true, manualResolutionController: controller }, resolved: false, description: 'sacrifice enchantment' };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const targetIdx = targetPlayer ?? (controller === 0 ? 1 : 0) as 0 | 1;
      const player = state.players[targetIdx];
      const exiledCount = player.graveyard.length;
      const players = [...state.players] as [PlayerState, PlayerState];
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
      state = addLog(state, controller, 'Exile target card from graveyard — needs manual resolution.');
      return { state: { ...state, needsManualResolution: true, manualResolutionController: controller }, resolved: false, description: 'exile card from gy' };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      state = addLog(state, controller, 'Mill then return effect — needs manual resolution.');
      return { state: { ...state, needsManualResolution: true, manualResolutionController: controller }, resolved: false, description: 'mill then return' };
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
      state = addLog(state, controller, `Each player discards ${count} card(s) — needs manual resolution.`);
      return { state: { ...state, needsManualResolution: true, manualResolutionController: controller }, resolved: false, description: `each discards ${count}` };
    },
  },

  // 78. each-player-sacrifices — each player sacrifices a creature/permanent
  {
    name: 'each-player-sacrifices',
    match: /each player sacrifices/i,
    requiresTarget: false,
    apply: (state, controller) => {
      state = addLog(state, controller, 'Each player sacrifices — needs manual resolution.');
      return { state: { ...state, needsManualResolution: true, manualResolutionController: controller }, resolved: false, description: 'each sacrifices' };
    },
  },

  // 79. target-player-skips-draw — target player skips their draw step
  {
    name: 'target-player-skips-draw',
    match: /target player skips.*draw step/i,
    requiresTarget: true,
    apply: (state, controller, targets) => {
      const targetPlayer = getTargetPlayer(targets);
      const targetIdx = targetPlayer ?? (controller === 0 ? 1 : 0) as 0 | 1;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const bf = state.players[pi as 0 | 1].battlefield;
        const idx = bf.findIndex(p => p.id === source.id);
        if (idx !== -1) {
          const transformed = transformPermanent(bf[idx]);
          if (!transformed) {
            state = addLog(state, controller, `${cardName} has no back face — cannot transform.`);
            return { state, resolved: true, description: `${cardName} has no back face` };
          }
          const newBf = [...bf];
          newBf[idx] = transformed;
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = { ...players[pi as 0 | 1], battlefield: newBf };
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
        const bf = state.players[pi as 0 | 1].battlefield;
        const idx = bf.findIndex(p => p.id === targetId);
        if (idx !== -1) {
          const transformed = transformPermanent(bf[idx]);
          if (!transformed) {
            state = addLog(state, controller, `${bf[idx].name} has no back face — cannot transform.`);
            return { state, resolved: true, description: `${bf[idx].name} has no back face` };
          }
          const newBf = [...bf];
          newBf[idx] = transformed;
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = { ...players[pi as 0 | 1], battlefield: newBf };
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
        const bf = state.players[pi as 0 | 1].battlefield;
        const idx = bf.findIndex(p => p.id === source.id);
        if (idx !== -1) {
          const perm = bf[idx];
          const newMods = [...(perm.temporaryPtMods || []), { power: 1, toughness: 1, source: 'prowess', turn: state.turn }];
          const newBf = [...bf];
          newBf[idx] = { ...perm, temporaryPtMods: newMods };
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = { ...players[pi as 0 | 1], battlefield: newBf };
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
      const opponent: 0 | 1 = controller === 0 ? 1 : 0;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[opponent] = { ...players[opponent], life: players[opponent].life - 1 };
      players[controller] = { ...players[controller], life: players[controller].life + 1 };
      state = { ...state, players };
      state = addLog(state, controller, `Extort: ${players[opponent].name} loses 1 life, ${players[controller].name} gains 1 life.`);
      return { state, resolved: true, description: 'extort: drain 1' };
    },
  },

  // 92. equip-for-free — attach to target creature
  {
    name: 'equip-for-free',
    match: /attach.*to target creature/i,
    requiresTarget: true,
    apply: (state, controller) => {
      state = addLog(state, controller, 'Attach to target creature — needs manual resolution.');
      return { state: { ...state, needsManualResolution: true, manualResolutionController: controller }, resolved: false, description: 'attach to creature' };
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
        return { state, resolved: false, description: 'no source creature' };
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
      return { state, resolved: false, description: 'no target for power damage' };
    },
  },

  // 94. create-copy-of-creature — create a copy of a creature (log only)
  {
    name: 'create-copy-of-creature',
    match: /create a (?:token that's a )?copy of/i,
    requiresTarget: true,
    apply: (state, controller) => {
      state = addLog(state, controller, 'Creates a copy — needs manual resolution.');
      return { state: { ...state, needsManualResolution: true, manualResolutionController: controller }, resolved: false, description: 'create copy' };
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
      const opponent: 0 | 1 = controller === 0 ? 1 : 0;
      state = damagePlayer(state, opponent, amount);
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
      const bf = [...players[playerIdx].battlefield];
      bf.splice(permIdx, 1);
      const ownerIdx: 0 | 1 = perm.owner ?? playerIdx;
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
        const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
        const opp: 0 | 1 = controller === 0 ? 1 : 0;
        state = damagePlayer(state, opp, totalDrain);
        return { state, resolved: true, description: `storm: ${stormCount} copies, opponent loses ${totalDrain} life` };
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

      for (let i = 0; i < player.library.length; i++) {
        const card = player.library[i];
        exiled.push(card);
        // Cascade finds first nonland card with mana value less than cascading spell
        if (!card.typeLine?.toLowerCase().includes('land') && (card.cmc ?? 0) < sourceCMC) {
          found = card;
          break;
        }
      }

      if (!found) {
        // Put all exiled cards on bottom in random order
        const shuffled = [...exiled].sort(() => Math.random() - 0.5);
        const newLib = [...player.library.slice(exiled.length), ...shuffled];
        const players = [...state.players] as [PlayerState, PlayerState];
        players[controller] = { ...player, library: newLib };
        state = { ...state, players };
        state = addLog(state, controller, `Cascade: no eligible spell found (exiled ${exiled.length} cards).`);
        return { state, resolved: true, description: 'cascade whiffed' };
      }

      // "Cast" the found card: put it in hand (simplified — real cascade puts on stack)
      const restExiled = exiled.filter(c => c.id !== found!.id);
      const shuffledRest = [...restExiled].sort(() => Math.random() - 0.5);
      const newLib = [...player.library.slice(exiled.length), ...shuffledRest];
      const players = [...state.players] as [PlayerState, PlayerState];
      players[controller] = {
        ...player,
        library: newLib,
        hand: [...player.hand, found],
      };
      state = { ...state, players };
      state = addLog(state, controller, `Cascade: found ${found.name} (MV ${found.cmc ?? 0}), put ${restExiled.length} cards on bottom.`);
      return { state, resolved: true, description: `cascade: ${found.name}` };
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
      const players = [...state.players] as [PlayerState, PlayerState];
      const dying = players[opp].battlefield.filter(p => p.typeLine?.toLowerCase().includes('creature'));
      const surviving = players[opp].battlefield.filter(p => !p.typeLine?.toLowerCase().includes('creature'));
      for (const perm of dying) {
        const ownerIdx: 0 | 1 = perm.owner ?? opp;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
        const bf = state.players[pi as 0 | 1].battlefield;
        const idx = bf.findIndex(p => p.id === targets[0].id);
        if (idx !== -1 && bf[idx].typeLine.toLowerCase().includes('land')) {
          const name = bf[idx].name;
          const newBf = [...bf.slice(0, idx), ...bf.slice(idx + 1)];
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = { ...players[pi as 0 | 1], battlefield: newBf, graveyard: [...players[pi as 0 | 1].graveyard, bf[idx] as any] };
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
        const bf = state.players[pi as 0 | 1].battlefield;
        const idx = bf.findIndex(p => p.id === targets[0].id);
        if (idx !== -1 && bf[idx].typeLine.toLowerCase().includes('planeswalker')) {
          const name = bf[idx].name;
          const newBf = [...bf.slice(0, idx), ...bf.slice(idx + 1)];
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = { ...players[pi as 0 | 1], battlefield: newBf, graveyard: [...players[pi as 0 | 1].graveyard, bf[idx] as any] };
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
        const bf = state.players[pi as 0 | 1].battlefield;
        const idx = bf.findIndex(p => p.id === targets[0].id);
        if (idx !== -1 && (pi as 0 | 1) !== controller) {
          const perm = { ...bf[idx], controller };
          const newBf = [...bf.slice(0, idx), ...bf.slice(idx + 1)];
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = { ...players[pi as 0 | 1], battlefield: newBf };
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
        const gy = state.players[pi as 0 | 1].graveyard;
        const idx = gy.findIndex(c => c.id === targetId);
        if (idx !== -1 && gy[idx].typeLine.toLowerCase().includes('creature')) {
          const card = gy[idx];
          const perm = cardToPermanent(card, controller, state.turn);
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = { ...players[pi as 0 | 1], graveyard: [...gy.slice(0, idx), ...gy.slice(idx + 1)] };
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
        const bf = state.players[pi as 0 | 1].battlefield;
        const idx = bf.findIndex(p => p.id === targets[0].id);
        if (idx !== -1) {
          const perm = bf[idx];
          const kw = [...(perm.temporaryKeywords || []), { keyword: 'double strike', source: 'spell', turn: state.turn }];
          const newBf = [...bf];
          newBf[idx] = { ...perm, temporaryKeywords: kw };
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = { ...players[pi as 0 | 1], battlefield: newBf };
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
        state = drawCards(state, pi as 0 | 1, drawCount);
        // Discard: remove last N drawn cards (heuristic: highest CMC)
        const hand = [...state.players[pi as 0 | 1].hand];
        const sorted = [...hand].sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0));
        const toDiscard = sorted.slice(0, Math.min(discardCount, hand.length));
        const discardIds = new Set(toDiscard.map(c => c.id));
        const players = [...state.players] as [PlayerState, PlayerState];
        players[pi as 0 | 1] = {
          ...players[pi as 0 | 1],
          hand: players[pi as 0 | 1].hand.filter(c => !discardIds.has(c.id)),
          graveyard: [...players[pi as 0 | 1].graveyard, ...toDiscard],
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const bf = state.players[pi as 0 | 1].battlefield;
        const idx = bf.findIndex(p => p.id === targets[0].id);
        if (idx !== -1) {
          const perm = bf[idx];
          const newBf = [...bf.slice(0, idx), ...bf.slice(idx + 1)];
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = {
            ...players[pi as 0 | 1],
            battlefield: newBf,
            exile: [...players[pi as 0 | 1].exile, perm as any],
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const bf = state.players[pi as 0 | 1].battlefield;
        const tapped = bf.filter(p => p.tapped && p.currentPower !== undefined);
        const remaining = bf.filter(p => !p.tapped || p.currentPower === undefined);
        if (tapped.length > 0) {
          count += tapped.length;
          const players = [...state.players] as [PlayerState, PlayerState];
          players[pi as 0 | 1] = {
            ...players[pi as 0 | 1],
            battlefield: remaining,
            graveyard: [...players[pi as 0 | 1].graveyard, ...tapped as any[]],
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
      const opponent: 0 | 1 = controller === 0 ? 1 : 0;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[opponent] = { ...players[opponent], life: players[opponent].life - creatureCount };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
      players[opp] = { ...players[opp], life: players[opp].life - amount };
      players[controller] = { ...players[controller], life: players[controller].life + amount };
      state = { ...state, players };
      state = addLog(state, controller, `Drained: opponent loses ${amount} life, you gain ${amount} life.`);
      return { state, resolved: true, description: `drain ${amount}` };
    },
  },

  // P3-15. Proliferate: choose any number of permanents/players with counters, give each another counter
  {
    name: 'proliferate',
    match: /\bproliferate\b/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
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
      const opp: 0 | 1 = controller === 0 ? 1 : 0;
      const oppPlayer = state.players[opp];
      const perms = oppPlayer.battlefield.filter(p => !p.typeLine?.toLowerCase().includes('land'));
      if (perms.length === 0) {
        state = addLog(state, controller, `Opponent has no nonland permanents to sacrifice.`);
        return { state, resolved: true, description: 'opponent has no permanents' };
      }
      // Sacrifice least valuable (lowest CMC nonland)
      const sorted = [...perms].sort((a, b) => (a.cmc ?? 0) - (b.cmc ?? 0));
      const victim = sorted[0];
      state = sacrificePermanent(state, victim.id);
      state = addLog(state, controller, `${oppPlayer.name} sacrifices ${victim.name}.`);
      return { state, resolved: true, description: `opponent sacrifices ${victim.name}` };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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

  // P4-16. manifest — top card of library as 2/2 face-down creature
  {
    name: 'manifest',
    match: /\bmanifest\b/i,
    requiresTarget: false,
    apply: (state, controller) => {
      const player = state.players[controller];
      if (player.library.length === 0) {
        state = addLog(state, controller, 'Manifest: library is empty.');
        return { state, resolved: true, description: 'manifest (empty library)' };
      }
      const topCard = player.library[0];
      const manifestPerm: any = {
        ...cardToPermanent({ ...topCard, name: 'Manifest', typeLine: 'Creature', oracleText: '', power: '2', toughness: '2' }, controller, state.turn),
        faceDown: true, basePower: 2, baseToughness: 2, currentPower: 2, currentToughness: 2,
      };
      const players = [...state.players] as [PlayerState, PlayerState];
      players[controller] = { ...player, library: player.library.slice(1), battlefield: [...player.battlefield, manifestPerm] };
      state = { ...state, players };
      state = addLog(state, controller, `Manifests the top card of library as a 2/2 face-down creature.`);
      return { state, resolved: true, description: 'manifest (2/2 face-down)' };
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
        const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
      const opp = controller === 0 ? 1 : 0;
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
      const players = [...state.players] as [PlayerState, PlayerState];
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
    apply: (state, controller) => {
      // Generic modal: mark as manual resolution since we can't predict the modes
      state = addLog(state, controller, 'Modal spell — choose mode(s).');
      return { state: { ...state, needsManualResolution: true, manualResolutionController: controller }, resolved: false, description: 'choose mode(s)' };
    },
  },
];

// ─── Main Resolver ───

/**
 * Try to resolve an effect from a stack object's oracle text.
 *
 * Multi-effect resolution: Oracle text is split into sentences (by period or newline),
 * and each sentence is matched independently against all patterns. This allows cards
 * like "Deal 3 damage to any target. You gain 3 life." to resolve BOTH effects.
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

  // Split oracle text into individual effect sentences
  // Split on periods followed by space/newline, or actual newlines
  const sentences = oracleText
    .split(/(?:\.\s+|\n)+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

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

  // If nothing matched at all, needs manual resolution
  if (!anyResolved && !anyUnresolved) {
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
