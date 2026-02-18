import type { Card } from './card.ts';
import type { Permanent } from './permanent.ts';
import type { ManaPayment } from './mana.ts';
import type { Zone } from './zones.ts';

/** A target for a spell or ability */
export interface Target {
  type: 'permanent' | 'player' | 'card-in-zone';
  id: string;
  zone?: Zone;
}

/** An object on the stack (spell or ability) */
export interface StackObject {
  id: string;
  type: 'spell' | 'ability';
  /** The card being cast (if spell) */
  card?: Card;
  /** The permanent that is the source (if ability) */
  source?: Permanent;
  controller: 0 | 1;
  targets: Target[];
  text: string;
  /** Oracle text for effect resolution (full text for spells, effect portion for triggered abilities) */
  oracleText?: string;
  /** Value of X for X-cost spells */
  xValue?: number;
  /** Whether this spell was cast with flashback (exiled after resolution) */
  isFlashback?: boolean;
  /** Whether kicker was paid (triggers kicker bonus effects) */
  isKicked?: boolean;
  /** Whether this is the adventure half of an adventure card */
  isAdventure?: boolean;
  /** Whether this creature was cast face-down (morph) */
  isFaceDown?: boolean;
  /** Whether this creature was evoked (sacrifice on ETB) */
  isEvoked?: boolean;
  /** Whether this creature was dashed (haste, return to hand at end step) */
  isDashed?: boolean;
}

/** All possible game actions a player can take */
export type GameAction =
  | { type: 'pass'; player: 0 | 1 }
  | { type: 'play-land'; player: 0 | 1; cardId: string }
  | {
      type: 'cast-spell';
      player: 0 | 1;
      cardId: string;
      targets: Target[];
      manaPayment: ManaPayment;
      /** Value of X for spells with {X} in their cost */
      xValue?: number;
      /** Set to true when casting a commander from the command zone (for tax tracking) */
      castFromCommandZone?: boolean;
      // ─── Alternative Costs ───
      /** Cast from graveyard via flashback */
      castWithFlashback?: boolean;
      /** Kicker was paid (additional cost for bonus effect) */
      kickerPaid?: boolean;
      /** Creature IDs tapped for convoke (each reduces cost by {1} or matching color) */
      convokeCreatures?: string[];
      /** Card IDs exiled from graveyard for delve (each reduces generic cost by {1}) */
      delveCards?: string[];
      /** Cast the adventure half instead of the creature */
      castAsAdventure?: boolean;
      /** Cast the back face of a modal DFC card */
      castBackFace?: boolean;
      /** Cast face-down as a 2/2 creature for {3} (morph) */
      castFaceDown?: boolean;
      /** Cast from exile for madness cost */
      castWithMadness?: boolean;
      /** Evoke — pay alt cost, sacrifice on ETB (CR 702.73) */
      evokePaid?: boolean;
      /** Dash — pay alt cost, gains haste, returns to hand at end step (CR 702.108) */
      dashPaid?: boolean;
    }
  | {
      type: 'activate-ability';
      player: 0 | 1;
      sourceId: string;
      abilityIndex: number;
      targets: Target[];
    }
  | {
      type: 'declare-attackers';
      player: 0 | 1;
      attackers: string[];
    }
  | {
      type: 'declare-blockers';
      player: 0 | 1;
      blocks: { blocker: string; attacker: string }[];
    }
  | {
      type: 'mulligan';
      player: 0 | 1;
      /** Cards to put on bottom of library (London mulligan) */
      toBottom: string[];
    }
  | { type: 'concede'; player: 0 | 1 }
  // ─── Rules Engine Actions ───
  | {
      /** Tap a permanent to activate its mana ability */
      type: 'tap-for-mana';
      player: 0 | 1;
      permanentId: string;
      /** Index into the permanent's abilities[] array (for multi-mana-ability permanents) */
      abilityIndex: number;
      /** For "any color" mana abilities — which color to produce */
      chosenColor?: 'W' | 'U' | 'B' | 'R' | 'G';
    }
  // ─── Manual Resolution Actions (for effects the engine can't auto-resolve) ───
  | { type: 'manual-move'; player: 0 | 1; cardId: string; from: Zone; to: Zone }
  | { type: 'manual-life'; player: 0 | 1; targetPlayer: 0 | 1; delta: number }
  | { type: 'manual-counter'; player: 0 | 1; permanentId: string; counterType: string; delta: number }
  | { type: 'manual-pt'; player: 0 | 1; permanentId: string; powerDelta: number; toughnessDelta: number }
  | { type: 'manual-token'; player: 0 | 1; name: string; power: number; toughness: number; typeLine: string; qty: number }
  | { type: 'manual-draw'; player: 0 | 1; targetPlayer: 0 | 1; count: number }
  | { type: 'manual-damage'; player: 0 | 1; targetId: string; targetType: 'permanent' | 'player'; amount: number }
  | { type: 'manual-done'; player: 0 | 1 }
  // ─── Planeswalker ───
  | {
      /** Activate a planeswalker loyalty ability */
      type: 'activate-loyalty';
      player: 0 | 1;
      /** The planeswalker permanent's ID */
      permanentId: string;
      /** Index into the permanent's abilities[] array */
      abilityIndex: number;
      /** Targets for the ability effect */
      targets: Target[];
    }
  // ─── Equipment ───
  | {
      /** Attach an equipment to a target creature (sorcery speed, costs mana) */
      type: 'equip';
      player: 0 | 1;
      /** The equipment permanent's ID */
      equipmentId: string;
      /** The target creature permanent's ID */
      targetCreatureId: string;
    }
  // ─── Hand Size Enforcement ───
  | { type: 'discard'; player: 0 | 1; cardIds: string[] }
  // ─── Legend Rule Choice ───
  | { type: 'legend-choice'; player: 0 | 1; keepPermanentId: string }
  // ─── Commander Zone Replacement (2020 Rule Change) ───
  | { type: 'commander-zone-choice'; player: 0 | 1; moveToCommandZone: boolean }
  // ─── Morph: Turn Face-Up (CR 702.36) ───
  | { type: 'turn-face-up'; player: 0 | 1; permanentId: string }
  // ─── Cycling (CR 702.28) ───
  | { type: 'cycle'; player: 0 | 1; cardId: string }
  // ─── Combat Damage Assignment (CR 510.1) ───
  | {
      /** Assign damage from an attacker to multiple blockers in DAO order */
      type: 'assign-damage';
      player: 0 | 1;
      /** Damage assignment: blockerId → damage amount */
      assignments: Record<string, number>;
      /** Remaining damage to defending player (trample) */
      trampleDamage?: number;
    };

/** Combat state tracking */
export interface CombatState {
  attackers: AttackingCreature[];
  blockers: BlockingCreature[];
  currentStep:
    | 'begin'
    | 'declare-attackers'
    | 'declare-blockers'
    | 'first-strike-damage'
    | 'damage'
    | 'end';
}

export interface AttackingCreature {
  permanentId: string;
  defenderId: 0 | 1;
}

export interface BlockingCreature {
  permanentId: string;
  /** ID of the attacking creature being blocked */
  blockingId: string;
  /** Damage assignment for multi-blocker scenarios */
  damageAssignment?: number;
}
