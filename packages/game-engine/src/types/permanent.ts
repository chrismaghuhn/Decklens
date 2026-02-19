import type { Card } from './card.ts';
import { parseAbilities } from '../rules/abilities.ts';

/** An ability on a permanent */
export interface Ability {
  id: string;
  type: 'activated' | 'triggered' | 'static' | 'mana';
  cost?: string;
  text: string;
  /** Whether this ability can be activated at instant speed */
  instantSpeed: boolean;
}

/** A temporary P/T modification that expires at end of turn */
export interface TemporaryPtMod {
  power: number;
  toughness: number;
  source: string; // description of where this came from
  turn: number; // turn it was applied
}

/** A temporary control change that expires at end of turn (e.g., Threaten effects) */
export interface TemporaryControlChange {
  originalController: 0 | 1;
  source: string; // description of what caused the steal
  turn: number; // turn it was applied
}

/** A temporary keyword grant that expires at end of turn */
export interface TemporaryKeyword {
  keyword: string; // e.g., 'flying', 'haste', 'trample'
  source: string;
  turn: number;
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
  /** Base power/toughness before temporary modifications */
  basePower?: number;
  baseToughness?: number;
  /** Temporary P/T modifications that expire at end of turn */
  temporaryPtMods: TemporaryPtMod[];
  /** Damage marked on this permanent this turn */
  damage: number;

  /** Planeswalker loyalty */
  currentLoyalty?: number;
  /** Whether this planeswalker has used a loyalty ability this turn */
  loyaltyUsedThisTurn?: boolean;

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

  // ─── Temporary Effects (expire at end of turn) ───

  /** If this permanent's controller was temporarily changed (e.g. Threaten), stores original controller */
  temporaryControlChange?: TemporaryControlChange;
  /** Keywords granted until end of turn (e.g. "gains flying until end of turn") */
  temporaryKeywords?: TemporaryKeyword[];

  // ─── Equipment / Aura Attachment ───

  /** ID of the permanent this is attached to (for Equipment/Auras) */
  attachedTo?: string;
  /** IDs of permanents attached to this one (Equipment/Auras on this creature) */
  attachments: string[];

  // ─── Phasing ───

  /** Whether this permanent is currently phased out (CR 702.26).
   *  Phased-out permanents are treated as though they don't exist.
   *  They phase back in during their controller's untap step. */
  phasedOut?: boolean;

  // ─── Alternative Cast Flags ───

  /** Whether this creature was dashed (return to hand at end step, CR 702.108) */
  dashedThisTurn?: boolean;
  /** Whether this creature should be sacrificed (evoke ETB, CR 702.73) */
  sacrificeOnETB?: boolean;
  /** Whether this creature is goaded (must attack, CR 701.38) */
  goaded?: boolean;
  /** Whether this creature was cast for its blitz cost (haste, sacrifice at end step, draw on death, CR 702.152) */
  blitzed?: boolean;
  /** Mutate stack — cards merged under/over this creature (CR 702.139) */
  mutateStack?: { id: string; name: string; oracleText: string; power?: string | number; toughness?: string | number }[];
  /** Whether this permanent should skip untapping during its controller's next untap step */
  skipNextUntap?: boolean;
}

/**
 * Transform a permanent to its back face (CR 701.28).
 * Swaps name, type line, oracle text, P/T, loyalty, image, and abilities
 * with the back face data. Stores the current front face in backFace for re-transform.
 * Returns null if the permanent has no back face.
 */
export function transformPermanent(perm: Permanent): Permanent | null {
  if (!perm.backFace) return null;
  const bf = perm.backFace;
  const bp = bf.power ? parseInt(bf.power, 10) || 0 : undefined;
  const bt = bf.toughness ? parseInt(bf.toughness, 10) || 0 : undefined;
  return {
    ...perm,
    name: bf.name,
    typeLine: bf.typeLine,
    oracleText: bf.oracleText,
    power: bf.power,
    toughness: bf.toughness,
    loyalty: bf.loyalty,
    imageUrl: bf.imageUrl || perm.imageUrl,
    basePower: bp,
    baseToughness: bt,
    currentPower: bp,
    currentToughness: bt,
    currentLoyalty: bf.loyalty ? parseInt(bf.loyalty, 10) || 0 : perm.currentLoyalty,
    // Store current front face in backFace for re-transform
    backFace: {
      name: perm.name,
      manaCost: perm.manaCost,
      typeLine: perm.typeLine,
      oracleText: perm.oracleText || '',
      power: perm.power,
      toughness: perm.toughness,
      loyalty: perm.loyalty,
      imageUrl: perm.imageUrl,
    },
    flipped: !perm.flipped,
    abilities: parseAbilities({ ...perm, oracleText: bf.oracleText } as Card),
    // Reset damage when transforming (new creature characteristics)
    damage: 0,
    temporaryPtMods: [],
  };
}

/** Create a Permanent from a Card when it enters the battlefield */
export function cardToPermanent(
  card: Card,
  controller: 0 | 1,
  turn: number
): Permanent {
  const basePower = card.power ? parseInt(card.power, 10) || 0 : undefined;
  const baseToughness = card.toughness ? parseInt(card.toughness, 10) || 0 : undefined;

  return {
    ...card,
    controller,
    tapped: false,
    flipped: false,
    faceDown: false,
    currentPower: basePower,
    currentToughness: baseToughness,
    basePower,
    baseToughness,
    temporaryPtMods: [],
    damage: 0,
    currentLoyalty: card.loyalty ? parseInt(card.loyalty, 10) || 0 : undefined,
    counters: {},
    summoningSick: true,
    attacking: false,
    blocking: null,
    abilities: parseAbilities(card),
    x: 0,
    y: 0,
    enteredBattlefieldTurn: turn,
    attachments: [],
  };
}
