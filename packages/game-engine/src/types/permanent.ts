import type { Card } from './card.ts';

/** An ability on a permanent */
export interface Ability {
  id: string;
  type: 'activated' | 'triggered' | 'static' | 'mana';
  cost?: string;
  text: string;
  /** Whether this ability can be activated at instant speed */
  instantSpeed: boolean;
}

/** A card on the battlefield */
export interface Permanent extends Card {
  /** Current controller (may differ from owner due to theft effects) */
  controller: 0 | 1;
  tapped: boolean;
  flipped: boolean;
  faceDown: boolean;

  /** Creature stats (adjusted for effects) */
  currentPower?: number;
  currentToughness?: number;
  /** Damage marked on this permanent this turn */
  damage: number;

  /** Planeswalker loyalty */
  currentLoyalty?: number;

  /** Counters on this permanent */
  counters: Record<string, number>;

  /** Cannot attack/activate tap abilities the turn it enters */
  summoningSick: boolean;
  /** Currently declared as attacker */
  attacking: boolean;
  /** ID of the attacking creature this permanent is blocking (null if not blocking) */
  blocking: string | null;

  /** Abilities this permanent provides */
  abilities: Ability[];

  /** UI positioning (percentage 0-100) */
  x: number;
  y: number;

  /** Turn this permanent entered the battlefield */
  enteredBattlefieldTurn: number;
}

/** Create a Permanent from a Card when it enters the battlefield */
export function cardToPermanent(
  card: Card,
  controller: 0 | 1,
  turn: number
): Permanent {
  return {
    ...card,
    controller,
    tapped: false,
    flipped: false,
    faceDown: false,
    currentPower: card.power ? parseInt(card.power, 10) || 0 : undefined,
    currentToughness: card.toughness
      ? parseInt(card.toughness, 10) || 0
      : undefined,
    damage: 0,
    currentLoyalty: card.loyalty ? parseInt(card.loyalty, 10) || 0 : undefined,
    counters: {},
    summoningSick: true,
    attacking: false,
    blocking: null,
    abilities: [],
    x: 0,
    y: 0,
    enteredBattlefieldTurn: turn,
  };
}
