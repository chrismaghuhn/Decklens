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
  rarity: 'common' | 'uncommon' | 'rare' | 'mythic' | 'special' | 'bonus';
  tags: CardTag[];
  imageUrl: string;
  /** Which player owns this card (in their deck) */
  owner: 0 | 1;

  // ─── Special Card Layouts ───

  /** Card layout type (from Scryfall) */
  layout?: 'normal' | 'transform' | 'modal_dfc' | 'adventure' | 'saga' | 'split' | 'flip';

  /** Back face for transform/MDFC cards */
  backFace?: {
    name: string;
    manaCost: string;
    typeLine: string;
    oracleText: string;
    power?: string;
    toughness?: string;
    loyalty?: string;
    imageUrl?: string;
  };

  /** Adventure half (Throne of Eldraine+) */
  adventureName?: string;
  adventureCost?: string;
  adventureTypeLine?: string;
  adventureText?: string;

  /** True when this card is exiled "on an adventure" (can be cast as creature from exile) */
  onAdventure?: boolean;

  /** True when this card was exiled via madness (can be cast for madness cost from exile) */
  madnessExile?: boolean;

  /** True when this card was exiled via rebound (cast again at next upkeep for free) */
  reboundExile?: boolean;
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

export function isSaga(card: Card): boolean {
  return card.typeLine.toLowerCase().includes('saga');
}

export function isAdventure(card: Card): boolean {
  return card.layout === 'adventure';
}

export function isDFC(card: Card): boolean {
  return card.layout === 'transform' || card.layout === 'modal_dfc';
}

export function hasFlash(card: Card): boolean {
  const text = card.oracleText?.toLowerCase() || '';
  if (!text) return false;
  // Check keyword lines only (first line typically), not ability text that
  // mentions "flash" as part of another word (e.g. "flashback")
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Keyword lines have no colon, no period, and no trigger words
    const isKeywordLine = !trimmed.includes(':') && !trimmed.includes('.') &&
      !trimmed.startsWith('when') && !trimmed.startsWith('if') &&
      !trimmed.startsWith('at ') && !trimmed.startsWith('whenever');
    if (isKeywordLine) {
      const keywords = trimmed.split(',').map(k => k.trim());
      if (keywords.some(k => k === 'flash')) return true;
    }
  }
  return false;
}
