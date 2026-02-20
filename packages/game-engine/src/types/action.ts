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
  controller: number;
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
  /** Whether this creature was cast for its blitz cost (haste, sacrifice at end step, draw on death) */
  isBlitzed?: boolean;
  /** Whether this spell was cast with overload (replace "target" with "each") */
  isOverloaded?: boolean;
  /** Whether buyback was paid (return to hand instead of GY on resolution) */
  isBuyback?: boolean;
  /** Whether escape was used (exile after resolution) */
  isEscape?: boolean;
  /** Whether jump-start was used (exile after resolution) */
  isJumpStart?: boolean;
  /** Whether this was cast via foretell cost */
  isForetold?: boolean;
  /** Whether this creature was cast with mutate (merge with target non-Human creature, CR 702.139) */
  isMutate?: boolean;
  /** ID of the creature to mutate onto */
  mutateTargetId?: string;
  /** Whether to place on top (true) or under (false) the target */
  mutateOnTop?: boolean;
  /** Whether this was cast with bestow (enters as Aura, becomes creature if enchanted creature leaves) */
  isBestow?: boolean;
  /** Whether this spell can't be countered (set from oracle text at cast time) */
  uncounterable?: boolean;
  /** Whether this spell has split second (no spells/non-mana abilities while on stack, CR 702.61) */
  splitSecond?: boolean;
  /** How many times replicate was paid (CR 702.56) — this spell has N copies put on the stack */
  replicateCount?: number;
  /** Whether this spell was cast with retrace (exiled after resolution) */
  isRetrace?: boolean;
  /** Whether this modal spell was cast with entwine (choose ALL modes, CR 702.39) */
  isEntwined?: boolean;
}

/** All possible game actions a player can take */
export type GameAction =
  | { type: 'pass'; player: number }
  | { type: 'play-land'; player: number; cardId: string }
  | {
      type: 'cast-spell';
      player: number;
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
      /** Affinity for artifacts: automatic cost reduction (1 per artifact you control) */
      affinityReduction?: number;
      /** Artifact IDs tapped for improvise (each reduces generic cost by {1}) */
      improviseArtifacts?: string[];
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
      /** Overload — pay alt cost, replace "target" with "each" for mass effect (CR 702.95) */
      overloadPaid?: boolean;
      /** Buyback — pay extra cost, return to hand after resolution (CR 702.26) */
      buybackPaid?: boolean;
      /** Blitz — pay alt cost, gains haste, sacrifice at end step, draw on death (CR 702.152) */
      blitzPaid?: boolean;
      /** Escape — cast from graveyard, exiling N other GY cards (CR 702.137) */
      escapePaid?: boolean;
      /** Jump-start — cast from graveyard by discarding a card, exile after (CR 702.132) */
      jumpStartPaid?: boolean;
      /** Foretell — cast from exile for foretell cost (CR 702.142) */
      foretellCast?: boolean;
      /** Mutate — pay mutate cost, merge with target non-Human creature (CR 702.139) */
      mutatePaid?: boolean;
      /** ID of the creature to mutate onto */
      mutateTargetId?: string;
      /** Whether to place on top (true) or under (false) the target */
      mutateOnTop?: boolean;
      /** Bestow — cast as Aura enchantment for bestow cost (CR 702.102) */
      bestowPaid?: boolean;
      /** Replicate — how many times the replicate cost was paid (each adds a copy) (CR 702.56) */
      replicateCount?: number;
      /** Retrace — cast from graveyard by discarding a land as additional cost (CR 702.80) */
      castWithRetrace?: boolean;
      /** Entwine — pay additional cost to choose ALL modes instead of just one (CR 702.39) */
      entwineePaid?: boolean;
    }
  | {
      type: 'activate-ability';
      player: number;
      sourceId: string;
      abilityIndex: number;
      targets: Target[];
    }
  | {
      type: 'declare-attackers';
      player: number;
      attackers: string[];
      /** Optional per-attacker defender map: creatureId -> defenderId.
       *  defenderId is 0|1 for a player, or a string permanent ID for a planeswalker.
       *  If omitted, all attackers target the opponent player. */
      defenderMap?: Record<string, number | string>;
    }
  | {
      type: 'declare-blockers';
      player: number;
      blocks: { blocker: string; attacker: string }[];
    }
  | {
      type: 'mulligan';
      player: number;
      /** Cards to put on bottom of library (London mulligan) */
      toBottom: string[];
    }
  | { type: 'concede'; player: number }
  // ─── Rules Engine Actions ───
  | {
      /** Tap a permanent to activate its mana ability */
      type: 'tap-for-mana';
      player: number;
      permanentId: string;
      /** Index into the permanent's abilities[] array (for multi-mana-ability permanents) */
      abilityIndex: number;
      /** For "any color" mana abilities — which color to produce */
      chosenColor?: 'W' | 'U' | 'B' | 'R' | 'G';
    }
  // ─── Manual Resolution Actions (for effects the engine can't auto-resolve) ───
  | { type: 'manual-move'; player: number; cardId: string; from: Zone; to: Zone }
  | { type: 'manual-life'; player: number; targetPlayer: number; delta: number }
  | { type: 'manual-counter'; player: number; permanentId: string; counterType: string; delta: number }
  | { type: 'manual-pt'; player: number; permanentId: string; powerDelta: number; toughnessDelta: number }
  | { type: 'manual-token'; player: number; name: string; power: number; toughness: number; typeLine: string; qty: number }
  | { type: 'manual-draw'; player: number; targetPlayer: number; count: number }
  | { type: 'manual-damage'; player: number; targetId: string; targetType: 'permanent' | 'player'; amount: number }
  | { type: 'manual-done'; player: number }
  // ─── Planeswalker ───
  | {
      /** Activate a planeswalker loyalty ability */
      type: 'activate-loyalty';
      player: number;
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
      player: number;
      /** The equipment permanent's ID */
      equipmentId: string;
      /** The target creature permanent's ID */
      targetCreatureId: string;
    }
  // ─── Hand Size Enforcement ───
  | { type: 'discard'; player: number; cardIds: string[] }
  // ─── Legend Rule Choice ───
  | { type: 'legend-choice'; player: number; keepPermanentId: string }
  // ─── Commander Zone Replacement (2020 Rule Change) ───
  | { type: 'commander-zone-choice'; player: number; moveToCommandZone: boolean }
  // ─── Morph: Turn Face-Up (CR 702.36) ───
  | { type: 'turn-face-up'; player: number; permanentId: string }
  // ─── Cycling (CR 702.28) ───
  | { type: 'cycle'; player: number; cardId: string }
  // ─── Companion (CR 702.138) ───
  | {
      /** Pay {3} to move companion from outside the game to hand */
      type: 'companion';
      player: number;
    }
  // ─── Combat Damage Assignment (CR 510.1) ───
  | {
      /** Assign damage from an attacker to multiple blockers in DAO order */
      type: 'assign-damage';
      player: number;
      /** Damage assignment: blockerId → damage amount */
      assignments: Record<string, number>;
      /** Remaining damage to defending player (trample) */
      trampleDamage?: number;
    }
  // ─── Ninjutsu (CR 702.48) ───
  | {
      /** Activate ninjutsu from hand — swap unblocked attacker for ninja (CR 702.48) */
      type: 'ninjutsu';
      player: number;
      /** The ninja card ID (in hand) */
      cardId: string;
      /** The unblocked attacking creature to return to hand */
      returnCreatureId: string;
      /** Mana payment for ninjutsu cost */
      manaPayment: ManaPayment;
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
  /** number = attacking a player (by index), string = attacking a planeswalker (permanent ID) */
  defenderId: number | string;
}

export interface BlockingCreature {
  permanentId: string;
  /** ID of the attacking creature being blocked */
  blockingId: string;
  /** Damage assignment for multi-blocker scenarios */
  damageAssignment?: number;
}
