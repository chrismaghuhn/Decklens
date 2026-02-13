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
  | { type: 'concede'; player: 0 | 1 };

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
