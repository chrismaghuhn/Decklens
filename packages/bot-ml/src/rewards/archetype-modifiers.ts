/**
 * Archetype Modifiers — Adjust reward weights based on deck archetype.
 *
 * Each archetype emphasizes different gameplay aspects:
 * - Aggro/Voltron: Combat damage, early pressure
 * - Control: Interaction, card draw, answers
 * - Combo: Combo progress, tutors, protection
 * - Midrange: Balanced (all 1.0)
 * - Ramp/Big-Mana: Ramp, big spells
 * - Reanimator: Graveyard fill, reanimation
 */

/** Reward dimensions that archetypes modify */
export interface ArchetypeModifier {
  combatDamage: number;
  ramp: number;
  interaction: number;
  cardDraw: number;
  comboProgress: number;
  tutors: number;
  protection: number;
  earlyCreatures: number;
  bigSpells: number;
  graveyardFill: number;
  reanimation: number;
  creatureCasts: number;
  lateGame: number;
  earlyInteraction: number;
}

/** Available archetype names */
export type ArchetypeName =
  | 'aggro'
  | 'control'
  | 'combo'
  | 'midrange'
  | 'ramp'
  | 'reanimator';

/** Default (balanced) modifier — all 1.0 */
const DEFAULT_MODIFIER: ArchetypeModifier = {
  combatDamage: 1.0,
  ramp: 1.0,
  interaction: 1.0,
  cardDraw: 1.0,
  comboProgress: 1.0,
  tutors: 1.0,
  protection: 1.0,
  earlyCreatures: 1.0,
  bigSpells: 1.0,
  graveyardFill: 1.0,
  reanimation: 1.0,
  creatureCasts: 1.0,
  lateGame: 1.0,
  earlyInteraction: 1.0,
};

/** Archetype-specific modifiers */
export const ARCHETYPE_MODIFIERS: Record<ArchetypeName, ArchetypeModifier> = {
  aggro: {
    ...DEFAULT_MODIFIER,
    combatDamage: 1.5,
    ramp: 0.7,
    earlyCreatures: 1.4,
    lateGame: 0.8,
  },

  control: {
    ...DEFAULT_MODIFIER,
    interaction: 1.5,
    cardDraw: 1.3,
    earlyCreatures: 0.6,
    lateGame: 1.3,
  },

  combo: {
    ...DEFAULT_MODIFIER,
    comboProgress: 2.0,
    tutors: 1.5,
    protection: 1.4,
  },

  midrange: {
    ...DEFAULT_MODIFIER,
  },

  ramp: {
    ...DEFAULT_MODIFIER,
    ramp: 1.6,
    bigSpells: 1.4,
    earlyInteraction: 0.7,
  },

  reanimator: {
    ...DEFAULT_MODIFIER,
    graveyardFill: 1.8,
    reanimation: 2.0,
    creatureCasts: 0.5,
  },
};

/** Get modifier for a given archetype (defaults to midrange) */
export function getArchetypeModifier(archetype?: ArchetypeName): ArchetypeModifier {
  return ARCHETYPE_MODIFIERS[archetype ?? 'midrange'];
}

/** Get a specific reward modifier for an archetype */
export function getModifier(
  archetype: ArchetypeName | undefined,
  dimension: keyof ArchetypeModifier,
): number {
  return getArchetypeModifier(archetype)[dimension];
}
