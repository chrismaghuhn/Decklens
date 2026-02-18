/**
 * Replacement Effects (CR 614)
 *
 * "If [event] would [happen], [replacement] instead."
 *
 * Replacement effects modify events BEFORE they happen. They don't use the stack.
 * Key rules:
 * - CR 614.1: A replacement effect changes how an event affects objects/players.
 * - CR 614.5: Only one replacement effect can apply to any given event.
 *   If multiple apply, the affected player (or controller) chooses which to apply.
 * - CR 614.6: Once a replacement effect has been applied, it can't apply again
 *   to the same event (self-replacement rule).
 *
 * Common replacement effects:
 * - "If a creature you control would die, exile it instead" (Rest in Peace, Leyline of the Void)
 * - "If you would draw a card, [do something] instead" (Notion Thief, Underrealm Lich)
 * - "If damage would be dealt to ~, prevent that damage" (prevention, see CR 615)
 * - "If a creature would enter the battlefield, it enters with [counters]" (Doubling Season)
 * - "If you would gain life, you gain that much life plus 1 instead" (Trostani's Summoner)
 * - "If a permanent would be put into a graveyard from the battlefield, exile it instead"
 * - "If a player would draw a card except the first one they draw in each draw step..."
 */

import type { GameState } from '../types/game-state.ts';
import type { Permanent } from '../types/permanent.ts';
import type { Card } from '../types/card.ts';

// ─── Types ───

export type ReplacementEventType =
  | 'die'            // creature/permanent would go to graveyard from battlefield
  | 'draw'           // player would draw a card
  | 'damage'         // damage would be dealt to a creature/player
  | 'gain-life'      // player would gain life
  | 'lose-life'      // player would lose life
  | 'enter-battlefield' // permanent would enter the battlefield
  | 'go-to-graveyard'  // card would go to graveyard (from anywhere)
  | 'discard';       // player would discard a card

export interface ReplacementEvent {
  type: ReplacementEventType;
  /** The permanent/card involved */
  source?: Permanent | Card;
  /** Which player is affected */
  affectedPlayer: 0 | 1;
  /** Additional data */
  amount?: number;        // damage amount, life amount, etc.
  fromZone?: string;      // where the card is coming from
  toZone?: string;        // where it would normally go
}

export interface ReplacementResult {
  /** Whether a replacement effect was applied */
  replaced: boolean;
  /** Modified event (after replacement) — null means event is entirely prevented */
  modifiedEvent?: ReplacementEvent | null;
  /** Description of what the replacement did */
  description?: string;
  /** New game state if the replacement directly modified state */
  state?: GameState;
}

export interface ReplacementEffectDef {
  /** Unique name for this replacement */
  name: string;
  /** Which event type this replaces */
  eventType: ReplacementEventType;
  /** Regex to match the permanent's oracle text */
  match: RegExp;
  /** Whether this affects the controller's events only, or any player */
  controllerOnly: boolean;
  /** Apply the replacement. Returns modified event or null (event prevented). */
  apply: (
    state: GameState,
    event: ReplacementEvent,
    source: Permanent,
    match: RegExpMatchArray,
  ) => ReplacementResult;
}

// ─── Replacement Effect Registry ───

export const REPLACEMENT_EFFECTS: ReplacementEffectDef[] = [
  // ─── Death Replacement: "If ~ would die, exile it instead" ───
  {
    name: 'self-exile-instead-of-die',
    eventType: 'die',
    match: /if\s+~\s+would\s+die,?\s+exile\s+(?:it|~)\s+instead/i,
    controllerOnly: false,
    apply: (state, event, _source, _m) => {
      return {
        replaced: true,
        modifiedEvent: { ...event, toZone: 'exile' },
        description: `${_source.name} is exiled instead of dying`,
      };
    },
  },

  // ─── "If a creature you control would die, exile it instead" (Leyline of the Void-like) ───
  {
    name: 'exile-your-creatures-instead-of-die',
    eventType: 'die',
    match: /if\s+a\s+creature\s+(?:you\s+control\s+)?would\s+die,?\s+exile\s+it\s+instead/i,
    controllerOnly: true,
    apply: (state, event, _source, _m) => {
      // Only applies to creatures
      const src = event.source;
      if (!src || !src.typeLine?.toLowerCase().includes('creature')) {
        return { replaced: false };
      }
      return {
        replaced: true,
        modifiedEvent: { ...event, toZone: 'exile' },
        description: `${src.name} is exiled instead of dying`,
      };
    },
  },

  // ─── "If a card would be put into an opponent's graveyard from anywhere, exile it instead" (Rest in Peace) ───
  {
    name: 'exile-instead-of-graveyard',
    eventType: 'go-to-graveyard',
    match: /if\s+a\s+(?:card|nontoken\s+permanent)\s+would\s+(?:be\s+put\s+into\s+a\s+graveyard|die)\s+from\s+anywhere,?\s+exile\s+it\s+instead/i,
    controllerOnly: false,
    apply: (_state, event, _source, _m) => {
      return {
        replaced: true,
        modifiedEvent: { ...event, toZone: 'exile' },
        description: `card is exiled instead of going to graveyard (${_source.name})`,
      };
    },
  },

  // ─── "If a permanent you control would be put into a graveyard, exile it instead" ───
  {
    name: 'exile-your-permanents-instead-of-graveyard',
    eventType: 'go-to-graveyard',
    match: /if\s+a\s+(?:permanent|creature|artifact|enchantment)\s+you\s+control\s+would\s+be\s+put\s+into\s+(?:a\s+|your\s+)?graveyard/i,
    controllerOnly: true,
    apply: (_state, event, _source, _m) => {
      return {
        replaced: true,
        modifiedEvent: { ...event, toZone: 'exile' },
        description: `permanent is exiled instead of going to graveyard`,
      };
    },
  },

  // ─── "If you would draw a card, instead [do X]" (e.g., Underrealm Lich, Notion Thief) ───
  {
    name: 'replace-draw-mill-choose',
    eventType: 'draw',
    match: /if\s+you\s+would\s+draw\s+a\s+card,?\s+instead\s+(?:look\s+at|reveal)\s+the\s+top\s+(\d+)\s+cards/i,
    controllerOnly: true,
    apply: (state, event, source, m) => {
      const count = parseInt(m[1]) || 3;
      const player = event.affectedPlayer;
      const lib = state.players[player].library;

      // Reveal top N, put one in hand, rest on bottom (simplified Underrealm Lich)
      if (lib.length === 0) {
        return { replaced: true, modifiedEvent: null, description: 'no cards to reveal' };
      }

      const revealed = lib.slice(0, count);
      // Put best card in hand (heuristic: lowest CMC for now)
      const sorted = [...revealed].sort((a, b) => (a.cmc ?? 0) - (b.cmc ?? 0));
      const chosen = sorted[0];
      const rest = revealed.filter(c => c.id !== chosen.id);

      const newLib = [...lib.slice(count), ...rest]; // rest go to bottom
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
      players[player] = {
        ...players[player],
        library: newLib,
        hand: [...players[player].hand, chosen],
      };

      return {
        replaced: true,
        modifiedEvent: null, // event fully replaced
        state: { ...state, players },
        description: `${source.name}: revealed ${count}, put ${chosen.name} in hand`,
      };
    },
  },

  // ─── "If you would draw a card, instead you don't" (e.g., Spirit of the Labyrinth after first draw) ───
  {
    name: 'prevent-extra-draws',
    eventType: 'draw',
    match: /(?:players?\s+can(?:'t|not)\s+draw\s+more\s+than\s+one\s+card\s+each\s+turn|if\s+(?:a\s+player|you)\s+would\s+draw\s+a\s+card\s+except\s+the\s+first)/i,
    controllerOnly: false,
    apply: (_state, event, source, _m) => {
      // This is a simplified check — in real MTG you'd track draws-this-turn
      return {
        replaced: true,
        modifiedEvent: null, // prevent the draw
        description: `draw prevented by ${source.name}`,
      };
    },
  },

  // ─── "If damage would be dealt to ~, prevent that damage" (e.g., protection effects, Mark of Asylum) ───
  {
    name: 'prevent-damage-to-self',
    eventType: 'damage',
    match: /(?:prevent\s+all\s+damage\s+that\s+would\s+be\s+dealt\s+to\s+~|if\s+damage\s+would\s+be\s+dealt\s+to\s+~,?\s+prevent\s+that\s+damage)/i,
    controllerOnly: false,
    apply: (_state, event, source, _m) => {
      // Only prevent damage to this specific permanent
      if (event.source?.id !== source.id) {
        return { replaced: false };
      }
      return {
        replaced: true,
        modifiedEvent: { ...event, amount: 0 },
        description: `damage to ${source.name} prevented`,
      };
    },
  },

  // ─── "Prevent all damage that would be dealt to creatures you control" (Mark of Asylum) ───
  {
    name: 'prevent-damage-to-your-creatures',
    eventType: 'damage',
    match: /prevent\s+all\s+(?:noncombat\s+)?damage\s+that\s+would\s+be\s+dealt\s+to\s+creatures?\s+you\s+control/i,
    controllerOnly: true,
    apply: (_state, event, source, _m) => {
      const src = event.source;
      if (!src || !src.typeLine?.toLowerCase().includes('creature')) {
        return { replaced: false };
      }
      return {
        replaced: true,
        modifiedEvent: { ...event, amount: 0 },
        description: `damage prevented by ${source.name}`,
      };
    },
  },

  // ─── "Prevent all damage that would be dealt" (Fog effects) ───
  {
    name: 'prevent-all-damage',
    eventType: 'damage',
    match: /prevent\s+all\s+(?:combat\s+)?damage\s+that\s+would\s+be\s+dealt(?:\s+this\s+turn)?/i,
    controllerOnly: false,
    apply: (_state, event, source, _m) => {
      return {
        replaced: true,
        modifiedEvent: { ...event, amount: 0 },
        description: `damage prevented by ${source.name}`,
      };
    },
  },

  // ─── "If you would gain life, you gain that much life plus N instead" (Trostani-like) ───
  {
    name: 'gain-extra-life',
    eventType: 'gain-life',
    match: /if\s+you\s+would\s+gain\s+life,?\s+you\s+gain\s+that\s+much\s+life\s+plus\s+(\d+)/i,
    controllerOnly: true,
    apply: (_state, event, source, m) => {
      const extra = parseInt(m[1]) || 1;
      return {
        replaced: true,
        modifiedEvent: { ...event, amount: (event.amount ?? 0) + extra },
        description: `${source.name}: gain ${extra} extra life`,
      };
    },
  },

  // ─── "If you would gain life, you gain twice that much life instead" (e.g., Boon Reflection) ───
  {
    name: 'double-life-gain',
    eventType: 'gain-life',
    match: /if\s+you\s+would\s+gain\s+life,?\s+you\s+gain\s+twice\s+that\s+much\s+(?:life\s+)?instead/i,
    controllerOnly: true,
    apply: (_state, event, source, _m) => {
      return {
        replaced: true,
        modifiedEvent: { ...event, amount: (event.amount ?? 0) * 2 },
        description: `${source.name}: life gain doubled`,
      };
    },
  },

  // ─── "If one or more counters would be placed on a permanent you control, that many plus one are placed instead" (Doubling Season for counters — simplified) ───
  {
    name: 'double-counters',
    eventType: 'enter-battlefield',
    match: /if\s+(?:one\s+or\s+more\s+)?(?:\+1\/\+1\s+)?counters\s+would\s+be\s+(?:put|placed)\s+on\s+a\s+(?:creature|permanent)\s+you\s+control/i,
    controllerOnly: true,
    apply: (_state, event, source, _m) => {
      // Doubling Season / Hardened Scales style — this is a marker
      return {
        replaced: true,
        modifiedEvent: event,
        description: `${source.name}: counter placement modified`,
      };
    },
  },

  // ─── "If ~ would be put into a graveyard from anywhere, reveal ~ and shuffle it into its owner's library instead" (Eldrazi-style) ───
  {
    name: 'shuffle-instead-of-graveyard',
    eventType: 'go-to-graveyard',
    match: /if\s+~\s+would\s+be\s+put\s+into\s+a\s+graveyard\s+from\s+anywhere,?\s+(?:reveal\s+~\s+and\s+)?shuffle\s+(?:it|~)\s+into\s+(?:its\s+)?owner'?s?\s+library/i,
    controllerOnly: false,
    apply: (_state, event, source, _m) => {
      if (event.source?.name !== source.name) {
        return { replaced: false };
      }
      return {
        replaced: true,
        modifiedEvent: { ...event, toZone: 'library' },
        description: `${source.name} is shuffled into library instead of going to graveyard`,
      };
    },
  },

  // ─── "If a token you control would die, exile it instead" (for token cleanup) ───
  {
    name: 'token-exile-on-death',
    eventType: 'die',
    match: /if\s+a\s+token\s+(?:you\s+control\s+)?would\s+die,?\s+exile\s+it\s+instead/i,
    controllerOnly: true,
    apply: (_state, event, _source, _m) => {
      return {
        replaced: true,
        modifiedEvent: { ...event, toZone: 'exile' },
        description: `token exiled instead of dying`,
      };
    },
  },

  // ─── "If an opponent would draw a card, instead you draw a card" (Notion Thief) ───
  {
    name: 'steal-opponent-draw',
    eventType: 'draw',
    match: /if\s+an?\s+opponent\s+would\s+draw\s+a\s+card\s+except\s+the\s+first[^.]*,?\s+(?:instead\s+)?(?:that\s+player\s+skips\s+that\s+draw|you\s+draw\s+a\s+card)/i,
    controllerOnly: false,
    apply: (state, event, source, _m) => {
      // Only steal opponent's draws (not controller's)
      if (event.affectedPlayer === source.controller) {
        return { replaced: false };
      }

      // Instead of opponent drawing, controller draws
      const controller = source.controller;
      const lib = state.players[controller].library;
      if (lib.length === 0) {
        return { replaced: true, modifiedEvent: null, description: `${source.name}: no cards to steal-draw` };
      }

      const drawn = lib[0];
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
      players[controller] = {
        ...players[controller],
        library: lib.slice(1),
        hand: [...players[controller].hand, drawn],
      };

      return {
        replaced: true,
        modifiedEvent: null, // original draw is fully replaced
        state: { ...state, players },
        description: `${source.name}: stole opponent's draw`,
      };
    },
  },

  // ─── "Damage that would be dealt to you is dealt to ~ instead" (Palisade Giant-like) ───
  {
    name: 'redirect-damage-to-self',
    eventType: 'damage',
    match: /(?:all\s+)?damage\s+that\s+would\s+be\s+dealt\s+to\s+you\s+is\s+dealt\s+to\s+~\s+instead/i,
    controllerOnly: true,
    apply: (state, event, source, _m) => {
      // Only redirect player-targeted damage
      if (event.source?.typeLine) {
        // This is damage to a permanent, not the player — skip
        return { replaced: false };
      }
      // Redirect: deal damage to this permanent instead
      const found = findPermOnBoard(state, source.id);
      if (!found) return { replaced: false };

      const perm = { ...found.perm, damage: found.perm.damage + (event.amount ?? 0) };
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
      const bf = [...players[found.playerIdx].battlefield];
      bf[found.permIdx] = perm;
      players[found.playerIdx] = { ...players[found.playerIdx], battlefield: bf };

      return {
        replaced: true,
        modifiedEvent: null,
        state: { ...state, players },
        description: `${source.name} takes ${event.amount} damage instead of player`,
      };
    },
  },

  // ─── "If a source would deal damage to a permanent or player, it deals double that damage instead" (Furnace of Rath) ───
  {
    name: 'double-damage',
    eventType: 'damage',
    match: /if\s+a\s+source\s+would\s+deal\s+damage\s+to\s+(?:a\s+)?(?:permanent|creature|player|opponent)[^.]*,?\s+it\s+deals\s+(?:double|twice)\s+that\s+(?:much\s+)?damage\s+instead/i,
    controllerOnly: false,
    apply: (_state, event, source, _m) => {
      return {
        replaced: true,
        modifiedEvent: { ...event, amount: (event.amount ?? 0) * 2 },
        description: `${source.name}: damage doubled`,
      };
    },
  },

  // ─── "If you would lose life, you lose that much life minus 1 instead" (Platinum Emperion-like) ───
  {
    name: 'prevent-life-loss',
    eventType: 'lose-life',
    match: /your\s+life\s+total\s+can(?:'t|not)\s+change/i,
    controllerOnly: true,
    apply: (_state, event, source, _m) => {
      return {
        replaced: true,
        modifiedEvent: null, // completely prevent
        description: `${source.name}: life total can't change`,
      };
    },
  },

  // ─── "If you would discard a card, exile it instead" ───
  {
    name: 'exile-instead-of-discard',
    eventType: 'discard',
    match: /if\s+(?:you|a\s+player)\s+would\s+discard\s+a\s+card,?\s+(?:that\s+player\s+)?exile[sd]?\s+(?:it|that\s+card)\s+instead/i,
    controllerOnly: false,
    apply: (_state, event, source, _m) => {
      return {
        replaced: true,
        modifiedEvent: { ...event, toZone: 'exile' },
        description: `${source.name}: discarded card exiled instead`,
      };
    },
  },

  // ─── "Whenever a creature enters the battlefield under your control, it enters with an additional +1/+1 counter" ───
  {
    name: 'extra-etb-counter',
    eventType: 'enter-battlefield',
    match: /(?:creatures?\s+you\s+control\s+)?enter(?:s)?\s+(?:the\s+battlefield\s+)?with\s+(?:an?\s+)?additional\s+\+1\/\+1\s+counter/i,
    controllerOnly: true,
    apply: (_state, event, source, _m) => {
      // Marker — the actual counter addition happens during ETB processing
      return {
        replaced: true,
        modifiedEvent: event,
        description: `${source.name}: additional +1/+1 counter on ETB`,
      };
    },
  },
];

// ─── Helper ───

function findPermOnBoard(state: GameState, id: string): { perm: Permanent; playerIdx: 0 | 1; permIdx: number } | null {
  for (let pi = 0; pi < 2; pi++) {
    const player = state.players[pi as 0 | 1];
    const idx = player.battlefield.findIndex(p => p.id === id);
    if (idx !== -1) return { perm: player.battlefield[idx], playerIdx: pi as 0 | 1, permIdx: idx };
  }
  return null;
}

// ─── Main API ───

/**
 * Check all permanents on the battlefield for applicable replacement effects.
 * Returns the first matching replacement result, or { replaced: false } if none apply.
 *
 * Per CR 614.5, if multiple apply, the affected player chooses. We simplify by
 * applying the first match (controller's effects first, then opponent's).
 */
export function checkReplacementEffects(
  state: GameState,
  event: ReplacementEvent,
): ReplacementResult {
  // Check controller's permanents first (CR 616.1 — affected player chooses)
  const playerOrder: (0 | 1)[] = [event.affectedPlayer, event.affectedPlayer === 0 ? 1 : 0];

  for (const playerIdx of playerOrder) {
    const player = state.players[playerIdx];

    for (const perm of player.battlefield) {
      const oracleText = perm.oracleText || '';
      if (!oracleText) continue;

      for (const effect of REPLACEMENT_EFFECTS) {
        if (effect.eventType !== event.type) continue;

        // Controller-only effects only apply to the controller's events
        if (effect.controllerOnly && playerIdx !== event.affectedPlayer) continue;

        const m = oracleText.match(effect.match);
        if (!m) continue;

        const result = effect.apply(state, event, perm, m);
        if (result.replaced) {
          return result;
        }
      }
    }
  }

  return { replaced: false };
}

/**
 * Apply replacement effects to a "die" event (permanent going to graveyard from battlefield).
 * Returns the actual destination zone after replacement effects are applied.
 *
 * Checks both 'die' and 'go-to-graveyard' replacement effects because dying IS a
 * specific case of going to graveyard from the battlefield (CR 700.4).
 */
export function applyDeathReplacement(
  state: GameState,
  dying: Permanent,
): { zone: 'graveyard' | 'exile' | 'library'; state: GameState; description?: string } {
  // First check 'die'-specific replacements (e.g., "If ~ would die, exile it instead")
  const dieEvent: ReplacementEvent = {
    type: 'die',
    source: dying,
    affectedPlayer: dying.controller,
    fromZone: 'battlefield',
    toZone: 'graveyard',
  };

  const dieResult = checkReplacementEffects(state, dieEvent);

  if (dieResult.replaced && dieResult.modifiedEvent) {
    const dest = (dieResult.modifiedEvent.toZone as 'graveyard' | 'exile' | 'library') || 'graveyard';
    return { zone: dest, state: dieResult.state || state, description: dieResult.description };
  }
  if (dieResult.replaced && !dieResult.modifiedEvent) {
    return { zone: 'graveyard', state: dieResult.state || state, description: dieResult.description };
  }

  // Then check 'go-to-graveyard' replacements (e.g., Rest in Peace: "If a card would be
  // put into a graveyard from anywhere, exile it instead")
  const graveyardEvent: ReplacementEvent = {
    type: 'go-to-graveyard',
    source: dying,
    affectedPlayer: dying.controller,
    fromZone: 'battlefield',
    toZone: 'graveyard',
  };

  const graveyardResult = checkReplacementEffects(state, graveyardEvent);

  if (graveyardResult.replaced && graveyardResult.modifiedEvent) {
    const dest = (graveyardResult.modifiedEvent.toZone as 'graveyard' | 'exile' | 'library') || 'graveyard';
    return { zone: dest, state: graveyardResult.state || state, description: graveyardResult.description };
  }
  if (graveyardResult.replaced && !graveyardResult.modifiedEvent) {
    return { zone: 'graveyard', state: graveyardResult.state || state, description: graveyardResult.description };
  }

  return { zone: 'graveyard', state };
}

/**
 * Apply replacement effects to a "draw" event.
 * Returns whether the draw should proceed normally.
 */
export function applyDrawReplacement(
  state: GameState,
  player: 0 | 1,
): { shouldDraw: boolean; state: GameState; description?: string } {
  const event: ReplacementEvent = {
    type: 'draw',
    affectedPlayer: player,
  };

  const result = checkReplacementEffects(state, event);

  if (result.replaced) {
    if (result.modifiedEvent === null) {
      // Draw fully replaced (either prevented or replaced with different effect)
      return {
        shouldDraw: false,
        state: result.state || state,
        description: result.description,
      };
    }
    // Draw modified but still happens
    return {
      shouldDraw: true,
      state: result.state || state,
      description: result.description,
    };
  }

  return { shouldDraw: true, state };
}

/**
 * Apply replacement effects to damage.
 * Returns the modified damage amount (0 = prevented).
 */
export function applyDamageReplacement(
  state: GameState,
  target: Permanent | null,
  targetPlayer: 0 | 1,
  amount: number,
): { amount: number; state: GameState; description?: string } {
  const event: ReplacementEvent = {
    type: 'damage',
    source: target || undefined,
    affectedPlayer: targetPlayer,
    amount,
  };

  const result = checkReplacementEffects(state, event);

  if (result.replaced && result.modifiedEvent) {
    return {
      amount: result.modifiedEvent.amount ?? 0,
      state: result.state || state,
      description: result.description,
    };
  }

  if (result.replaced && !result.modifiedEvent) {
    // Damage redirected or fully replaced
    return {
      amount: 0,
      state: result.state || state,
      description: result.description,
    };
  }

  return { amount, state };
}

/**
 * Apply replacement effects to life gain.
 * Returns the modified life gain amount.
 */
export function applyLifeGainReplacement(
  state: GameState,
  player: 0 | 1,
  amount: number,
): { amount: number; state: GameState; description?: string } {
  const event: ReplacementEvent = {
    type: 'gain-life',
    affectedPlayer: player,
    amount,
  };

  const result = checkReplacementEffects(state, event);

  if (result.replaced && result.modifiedEvent) {
    return {
      amount: result.modifiedEvent.amount ?? amount,
      state: result.state || state,
      description: result.description,
    };
  }

  return { amount, state };
}

/**
 * Apply replacement effects to a "go to graveyard" event (from any zone).
 * Returns the actual destination zone.
 */
export function applyGraveyardReplacement(
  state: GameState,
  card: Card,
  fromZone: string,
  affectedPlayer: 0 | 1,
): { zone: 'graveyard' | 'exile' | 'library'; state: GameState; description?: string } {
  const event: ReplacementEvent = {
    type: 'go-to-graveyard',
    source: card as any,
    affectedPlayer,
    fromZone,
    toZone: 'graveyard',
  };

  const result = checkReplacementEffects(state, event);

  if (result.replaced && result.modifiedEvent) {
    const dest = (result.modifiedEvent.toZone as 'graveyard' | 'exile' | 'library') || 'graveyard';
    return {
      zone: dest,
      state: result.state || state,
      description: result.description,
    };
  }

  return { zone: 'graveyard', state };
}
