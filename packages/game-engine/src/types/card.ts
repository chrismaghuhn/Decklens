/** MTG color identity */
export type Color = 'W' | 'U' | 'B' | 'R' | 'G';

/** Card functional tags derived from oracle text parsing */
export type CardTag =
  | 'ramp'
  | 'draw'
  | 'removal'
  | 'counter'
  | 'tutor'
  | 'wipe'
  | 'engine'
  | 'payoff'
  | 'combo-piece'
  | 'protection'
  | 'recursion'
  | 'reanimation'
  | 'token-generator'
  | 'sacrifice-outlet'
  | 'mana-dork'
  | 'fast-mana'
  | 'land-fetch'
  | 'card-selection'
  | 'win-condition'
  | 'finisher';

/** A card instance in any zone */
export interface Card {
  /** Unique instance ID (each copy in a game is unique) */
  id: string;
  /** Scryfall oracle ID (shared across printings) */
  oracleId: string;
  name: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracleText: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors: Color[];
  colorIdentity: Color[];
  tags: CardTag[];
  imageUrl: string;
  /** Which player owns this card (in their deck) */
  owner: 0 | 1;
}

/** Card type line helpers */
export function isLand(card: Card): boolean {
  return card.typeLine.toLowerCase().includes('land');
}

export function isCreature(card: Card): boolean {
  return card.typeLine.toLowerCase().includes('creature');
}

export function isArtifact(card: Card): boolean {
  return card.typeLine.toLowerCase().includes('artifact');
}

export function isEnchantment(card: Card): boolean {
  return card.typeLine.toLowerCase().includes('enchantment');
}

export function isPlaneswalker(card: Card): boolean {
  return card.typeLine.toLowerCase().includes('planeswalker');
}

export function isInstant(card: Card): boolean {
  return card.typeLine.toLowerCase().includes('instant');
}

export function isSorcery(card: Card): boolean {
  return card.typeLine.toLowerCase().includes('sorcery');
}

export function isLegendary(card: Card): boolean {
  return card.typeLine.toLowerCase().includes('legendary');
}

export function hasFlash(card: Card): boolean {
  return card.oracleText.toLowerCase().includes('flash');
}
