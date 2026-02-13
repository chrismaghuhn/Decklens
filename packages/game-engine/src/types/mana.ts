import type { Color } from './card.ts';

/** Available mana in a player's pool */
export interface ManaPool {
  W: number;
  U: number;
  B: number;
  R: number;
  G: number;
  C: number;
  S: number;
  generic: number;
}

/** Parsed mana cost from a card's cost string */
export interface ManaCost {
  W: number;
  U: number;
  B: number;
  R: number;
  G: number;
  C: number;
  generic: number;
  X: number;
  snow: number;
  phyrexian: PhyrexianCost[];
  hybrid: HybridCost[];
}

export interface PhyrexianCost {
  color: Color;
  count: number;
}

export interface HybridCost {
  colors: [Color, Color];
  count: number;
}

/** How a player chooses to pay a mana cost */
export interface ManaPayment {
  /** Mana spent from pool */
  from: ManaPool;
  /** Life paid for phyrexian mana */
  phyrexianLife: number;
  /** Chosen colors for hybrid mana symbols */
  hybridChoices: Color[];
  /** Value chosen for X costs */
  xValue: number;
}
