/**
 * Archetype Catalog
 * Comprehensive definitions of MTG Commander archetypes
 * Includes signature cards, synergies, counters, and detection rules
 */

export type ArchetypeCategory = 'aggressive' | 'controlling' | 'combo' | 'midrange' | 'synergy';

export type ArchetypeId =
  // cEDH / Competitive
  | 'reanimator'
  | 'storm'
  | 'food-chain'
  | 'ad-naus'
  | 'thassa-oracle'
  | 'doomsday'
  | 'underworld-breach'
  | 'gitrog-dredge'
  | 'malcolm-tana'
  | 'stax'
  | 'artifact-combo'
  | 'eggs'
  // Casual / Synergy
  | 'tribal-elves'
  | 'tribal-goblins'
  | 'tribal-zombies'
  | 'tribal-dragons'
  | 'lifegain'
  | 'tokens'
  | 'aristocrats'
  | 'voltron'
  | 'group-hug'
  | 'chaos'
  | 'lands-matter'
  | 'spellslinger'
  | 'enchantress'
  | 'vehicles'
  | '+1-counters'
  | 'equipment';

export interface PlaySequenceStep {
  turns: string;
  phase: string;
  goal: string;
  keyCards: string[];
  priority: 'critical' | 'high' | 'medium';
}

export interface ComboDefinition {
  name: string;
  cards: string[];
  description: string;
  requiresCommander?: boolean;
}

export interface ArchetypeDefinition {
  id: ArchetypeId;
  name: string;
  category: ArchetypeCategory;
  description: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  powerLevel: 'low' | 'mid' | 'high' | 'competitive';
  preferredColors: string[]; // e.g., ['B'], ['U', 'R']
  keyCards: string[]; // Essential cards for the archetype
  signatureCards: string[]; // Cards that define the archetype
  synergisticCards: string[]; // Common good inclusions
  gamePlan: string;
  combos?: ComboDefinition[];
  counterCards: string[]; // Cards that beat this archetype
  edhrecTheme?: string;
  playSequence?: PlaySequenceStep[];
  detection: {
    minSignatureCards: number;
    minKeyCards: number;
    weightMultiplier: number;
  };
}

// ============================================
// COMBO ARCHETYPES (cEDH/Competitive)
// ============================================

export const REANIMATOR: ArchetypeDefinition = {
  id: 'reanimator',
  name: 'Reanimator',
  category: 'combo',
  description: 'Put expensive creatures in the graveyard early, then reanimate them for massive value',
  difficulty: 'intermediate',
  powerLevel: 'high',
  preferredColors: ['B'],
  keyCards: [
    'Reanimate',
    'Animate Dead',
    'Necromancy',
    'Dance of the Dead',
    'Entomb',
    'Buried Alive',
  ],
  signatureCards: [
    'Grief',
    'Archon of Cruelty',
    'Griselbrand',
    'Jin-Gitaxias, Core Augur',
    'Sire of Insanity',
    'Ashen Rider',
    'Void Winnower',
    'Massacre Wurm',
    'Razaketh, the Foulblooded',
    'Sheoldred, the Apocalypse',
  ],
  synergisticCards: [
    'Faithless Looting',
    'Cathartic Reunion',
    'Dack Fayden',
    'Collective Brutality',
    'Duress',
    'Unmarked Grave',
    'Final Parting',
    'Victimize',
    'Exhume',
    'Life // Death',
  ],
  gamePlan: 'Discard or mill expensive creatures into graveyard, then use reanimation spells to bring them back early. Win through overwhelming board presence or combo loops.',
  counterCards: [
    "Rest in Peace",
    "Grafdigger's Cage",
    'Leyline of the Void',
    'Planar Void',
    'Tormod\'s Crypt',
    'Bojuka Bog',
    'Scavenger Grounds',
    'Soul-Guide Lantern',
    'Weathered Runestone',
    'Containment Priest',
  ],
  edhrecTheme: 'reanimator',
  playSequence: [
    { turns: '1-2', phase: 'Setup', goal: 'Play mana rocks, discard/mill enablers', keyCards: ['Entomb', 'Faithless Looting', 'Sol Ring'], priority: 'critical' },
    { turns: '3-4', phase: 'Reanimate', goal: 'Reanimate a big threat from graveyard', keyCards: ['Reanimate', 'Animate Dead', 'Necromancy'], priority: 'critical' },
    { turns: '5-6', phase: 'Protect', goal: 'Protect reanimated threat, add backup threats', keyCards: ['Grief', 'Archon of Cruelty', 'Razaketh, the Foulblooded'], priority: 'high' },
    { turns: '7+', phase: 'Close Out', goal: 'Grind out remaining opponents', keyCards: ['Living Death', 'Victimize'], priority: 'medium' },
  ],
  detection: {
    minSignatureCards: 2,
    minKeyCards: 2,
    weightMultiplier: 2.0,
  },
};

export const STORM: ArchetypeDefinition = {
  id: 'storm',
  name: 'Storm',
  category: 'combo',
  description: 'Cast many spells in a single turn to build storm count, then win with a storm payoff',
  difficulty: 'expert',
  powerLevel: 'competitive',
  preferredColors: ['U', 'B', 'R'],
  keyCards: [
    'Brain Freeze',
    'Grapeshot',
    'Tendrils of Agony',
    "Mind's Desire",
    'Aetherflux Reservoir',
    'High Tide',
    'Turnabout',
  ],
  signatureCards: [
    'Underworld Breach',
    'Lion\'s Eye Diamond',
    'Brain Freeze',
    'Wheel of Fortune',
    'Windfall',
    'Time Spiral',
    'Frantic Search',
    'Paradoxical Outcome',
    'Sensei\'s Divining Top',
    'Helm of Awakening',
  ],
  synergisticCards: [
    'Ponder',
    'Preordain',
    'Brainstorm',
    'Mystic Remora',
    'Rhystic Study',
    'Chrome Mox',
    'Mox Diamond',
    'Lotus Petal',
    'Dark Ritual',
    'Cabal Ritual',
    'Seething Song',
    'Rite of Flame',
    'Desperate Ritual',
    'Pyretic Ritual',
  ],
  gamePlan: 'Generate mana and card advantage quickly, cast many spells in one turn to build storm count, then finish with Brain Freeze, Grapeshot, or Tendrils of Agony.',
  combos: [
    {
      name: 'High Tide Loop',
      cards: ['High Tide', 'Time Spiral', 'Brain Freeze'],
      description: 'Generate huge mana with High Tide, Time Spiral to reload, then Brain Freeze opponents',
    },
    {
      name: 'Breach LED',
      cards: ['Underworld Breach', 'Lion\'s Eye Diamond', 'Brain Freeze'],
      description: 'Escape LED repeatedly for mana, escape Brain Freeze to win',
    },
  ],
  counterCards: [
    'Rule of Law',
    'Ethersworn Canonist',
    'Deafening Silence',
    'Trinisphere',
    'Thorn of Amethyst',
    'Sphere of Resistance',
    'Damping Sphere',
    'Cursed Totem',
    'Linvala, Keeper of Silence',
    'Aven Mindcensor',
  ],
  edhrecTheme: 'storm',
  playSequence: [
    { turns: '1-2', phase: 'Ramp', goal: 'Deploy fast mana, cheap cantrips', keyCards: ['Sol Ring', 'Lotus Petal', 'Dark Ritual', 'Ponder'], priority: 'critical' },
    { turns: '3-4', phase: 'Engine', goal: 'Resolve card draw engine or cost reducer', keyCards: ['Aetherflux Reservoir', "Sensei's Divining Top", 'Helm of Awakening'], priority: 'high' },
    { turns: '5-6', phase: 'Storm Turn', goal: 'Chain spells, build storm count, go off', keyCards: ['Underworld Breach', "Lion's Eye Diamond", 'Wheel of Fortune'], priority: 'critical' },
    { turns: '7+', phase: 'Finish', goal: 'Win with storm payoff', keyCards: ['Brain Freeze', 'Tendrils of Agony', 'Grapeshot'], priority: 'critical' },
  ],
  detection: {
    minSignatureCards: 2,
    minKeyCards: 2,
    weightMultiplier: 2.5,
  },
};

export const FOOD_CHAIN: ArchetypeDefinition = {
  id: 'food-chain',
  name: 'Food Chain',
  category: 'combo',
  description: 'Exile creatures to Food Chain for infinite mana, cast commander infinitely',
  difficulty: 'advanced',
  powerLevel: 'competitive',
  preferredColors: ['G', 'B'],
  keyCards: [
    'Food Chain',
    'Eternal Scourge',
    'Misthollow Griffin',
    "Squee, the Immortal",
  ],
  signatureCards: [
    'Food Chain',
    'Eternal Scourge',
    'Misthollow Griffin',
    "Squee, the Immortal",
    'Necropotence',
    'Bolas\'s Citadel',
    'Aetherflux Reservoir',
    'Walking Ballista',
  ],
  synergisticCards: [
    'Commander Beacon',
    'Genesis',
    'Eternal Witness',
    'Worldly Tutor',
    'Survival of the Fittest',
    'Birthing Pod',
    'Eldritch Evolution',
    'Neoform',
    'Finale of Devastation',
    'Chord of Calling',
  ],
  gamePlan: 'Play Food Chain, exile creatures that return to hand (Eternal Scourge, Misthollow Griffin, Squee) for infinite mana, cast commander infinite times to win.',
  combos: [
    {
      name: 'Food Chain Infinite',
      cards: ['Food Chain', 'Eternal Scourge'],
      description: 'Exile Eternal Scourge to Food Chain for 5 mana, it returns to hand, repeat for infinite mana',
    },
    {
      name: 'Walking Ballista Kill',
      cards: ['Food Chain', 'Misthollow Griffin', 'Walking Ballista'],
      description: 'Infinite mana with Food Chain + Griffin, cast infinitely large Walking Ballista',
    },
  ],
  counterCards: [
    'Cursed Totem',
    'Linvala, Keeper of Silence',
    'Pithing Needle',
    'Phyrexian Revoker',
    'Null Rod',
    'Collector Ouphe',
    'Stony Silence',
    'Aven Mindcensor',
    'Opposition Agent',
    'Ash Zealot',
  ],
  edhrecTheme: 'food-chain',
  playSequence: [
    { turns: '1-2', phase: 'Ramp', goal: 'Play mana dorks and rocks', keyCards: ['Sol Ring', 'Arcane Signet', 'Elves of Deep Shadow'], priority: 'high' },
    { turns: '3-4', phase: 'Assemble', goal: 'Resolve Food Chain + exile creature', keyCards: ['Food Chain', 'Eternal Scourge', 'Misthollow Griffin'], priority: 'critical' },
    { turns: '5-6', phase: 'Combo', goal: 'Infinite mana, cast commander/payoff infinitely', keyCards: ['Walking Ballista', "Squee, the Immortal"], priority: 'critical' },
    { turns: '7+', phase: 'Backup', goal: 'Tutor or grind for combo pieces', keyCards: ['Worldly Tutor', 'Finale of Devastation'], priority: 'medium' },
  ],
  detection: {
    minSignatureCards: 2,
    minKeyCards: 1,
    weightMultiplier: 3.0,
  },
};

export const THASSA_ORACLE: ArchetypeDefinition = {
  id: 'thassa-oracle',
  name: 'Thassa\'s Oracle',
  category: 'combo',
  description: 'Mill your entire library, then win with Thassa\'s Oracle',
  difficulty: 'advanced',
  powerLevel: 'competitive',
  preferredColors: ['U', 'B'],
  keyCards: [
    "Thassa's Oracle",
    'Jace, Wielder of Mysteries',
    'Laboratory Maniac',
    'Demonic Consultation',
    'Tainted Pact',
  ],
  signatureCards: [
    "Thassa's Oracle",
    'Demonic Consultation',
    'Tainted Pact',
    'Jace, Wielder of Mysteries',
    'Laboratory Maniac',
    'Hermit Druid',
    'Nomads en-Kor',
    'Cephalid Illusionist',
  ],
  synergisticCards: [
    'Dread Return',
    'Flash',
    'Protean Hulk',
    'Gitaxian Probe',
    'Ponder',
    'Preordain',
    'Brainstorm',
    'Mystical Tutor',
    'Vampiric Tutor',
    'Intuition',
    'Imperial Seal',
  ],
  gamePlan: 'Use Demonic Consultation or Tainted Pact to exile your entire library, then play Thassa\'s Oracle to win. Alternatively, mill yourself with Hermit Druid.',
  combos: [
    {
      name: 'Consultation Oracle',
      cards: ["Thassa's Oracle", 'Demonic Consultation'],
      description: 'Name a card not in your deck with Consultation, exile library, play Oracle to win',
    },
    {
      name: 'Hermit Druid',
      cards: ['Hermit Druid', "Thassa's Oracle"],
      description: 'Activate Hermit Druid repeatedly with no basic lands to mill yourself, then Oracle',
    },
  ],
  counterCards: [
    'Stifle',
    'Trickbind',
    'Disallow',
    'Void Slime',
    'Tale\'s End',
    'Stony Silence',
    'Cursed Totem',
    'Phyrexian Revoker',
    'Pithing Needle',
    'Torpor Orb',
    'Hushbringer',
  ],
  edhrecTheme: 'laboratory-maniac',
  playSequence: [
    { turns: '1-2', phase: 'Setup', goal: 'Cantrips, mana rocks, sculpt hand', keyCards: ['Ponder', 'Preordain', 'Sol Ring'], priority: 'high' },
    { turns: '3-4', phase: 'Protect', goal: 'Hold protection, find combo pieces', keyCards: ['Vampiric Tutor', 'Mystical Tutor', 'Intuition'], priority: 'high' },
    { turns: '5-6', phase: 'Combo', goal: 'Resolve Consultation/Pact + Oracle to win', keyCards: ["Thassa's Oracle", 'Demonic Consultation', 'Tainted Pact'], priority: 'critical' },
    { turns: '7+', phase: 'Alt Win', goal: 'Backup plan: Hermit Druid or Jace', keyCards: ['Hermit Druid', 'Jace, Wielder of Mysteries', 'Laboratory Maniac'], priority: 'medium' },
  ],
  detection: {
    minSignatureCards: 2,
    minKeyCards: 2,
    weightMultiplier: 2.5,
  },
};

export const UNDERWORLD_BREACH: ArchetypeDefinition = {
  id: 'underworld-breach',
  name: 'Underworld Breach',
  category: 'combo',
  description: 'Escape cards from graveyard repeatedly to generate infinite resources',
  difficulty: 'expert',
  powerLevel: 'competitive',
  preferredColors: ['U', 'R'],
  keyCards: [
    'Underworld Breach',
    'Brain Freeze',
    'Lion\'s Eye Diamond',
    'Wheel of Fortune',
    'Burning Inquiry',
  ],
  signatureCards: [
    'Underworld Breach',
    'Brain Freeze',
    'Lion\'s Eye Diamond',
    'Wheel of Fortune',
    'Windfall',
    'Molten Psyche',
    'Timetwister',
    'Time Spiral',
    'Echo of Eons',
  ],
  synergisticCards: [
    'Gitaxian Probe',
    'Manamorphose',
    'Desperate Ritual',
    'Pyretic Ritual',
    'Seething Song',
    'Rite of Flame',
    'Lotus Petal',
    'Mox Diamond',
    'Chrome Mox',
    'Mystic Remora',
  ],
  gamePlan: 'Fill graveyard with wheels and rituals, use Breach to escape LED for mana, escape wheels to refill, loop until you can Brain Freeze everyone.',
  combos: [
    {
      name: 'Breach LED',
      cards: ['Underworld Breach', 'Lion\'s Eye Diamond', 'Wheel of Fortune'],
      description: 'Escape LED, crack it for mana, escape Wheel to refill graveyard and hand, repeat',
    },
  ],
  counterCards: [
    'Rest in Peace',
    'Leyline of the Void',
    'Grafdigger\'s Cage',
    'Planar Void',
    'Bojuka Bog',
    'Scavenger Grounds',
    'Cursed Totem',
    'Linvala, Keeper of Silence',
  ],
  edhrecTheme: 'underworld-breach',
  playSequence: [
    { turns: '1-2', phase: 'Ramp', goal: 'Fast mana, fill graveyard with looting', keyCards: ['Lotus Petal', 'Chrome Mox', 'Faithless Looting'], priority: 'critical' },
    { turns: '3-4', phase: 'Fill GY', goal: 'Wheel effects to fill graveyard + hand', keyCards: ['Wheel of Fortune', 'Windfall', 'Echo of Eons'], priority: 'high' },
    { turns: '5-6', phase: 'Breach Turn', goal: 'Resolve Breach, escape LED + wheel loop', keyCards: ['Underworld Breach', "Lion's Eye Diamond"], priority: 'critical' },
    { turns: '7+', phase: 'Win', goal: 'Brain Freeze all opponents', keyCards: ['Brain Freeze'], priority: 'critical' },
  ],
  detection: {
    minSignatureCards: 2,
    minKeyCards: 1,
    weightMultiplier: 2.5,
  },
};

export const ARTIFACT_COMBO: ArchetypeDefinition = {
  id: 'artifact-combo',
  name: 'Artifact Combo',
  category: 'combo',
  description: 'Use artifact synergies to generate infinite mana or draw your deck',
  difficulty: 'advanced',
  powerLevel: 'high',
  preferredColors: ['U'],
  keyCards: [
    'Grim Monolith',
    'Basalt Monolith',
    'Power Artifact',
    'Rings of Brighthearth',
    'Sensei\'s Divining Top',
  ],
  signatureCards: [
    'Grim Monolith',
    'Basalt Monolith',
    'Power Artifact',
    'Rings of Brighthearth',
    'Sensei\'s Divining Top',
    'Mystic Forge',
    'Future Sight',
    'Topdeck Manipulation',
    'Voltaic Key',
    'Manifold Key',
  ],
  synergisticCards: [
    "Mishra's Workshop",
    'Metalworker',
    'Vedalken Archmage',
    'Sai, Master Thopterist',
    'Urza, Lord High Artificer',
    'Emry, Lurker of the Loch',
    'Mirran Spy',
    'Lotus Petal',
    'Mox Diamond',
    'Chrome Mox',
  ],
  gamePlan: 'Generate infinite mana with Monolith + Power Artifact or Basalt Monolith + Rings, then draw your deck with Mystic Forge or Future Sensei\'s Divining Top.',
  combos: [
    {
      name: 'Monolith Power',
      cards: ['Grim Monolith', 'Power Artifact'],
      description: 'Enchant Monolith with Power Artifact to untap for 3, pay 4, net +2 mana infinite',
    },
    {
      name: 'Basalt Rings',
      cards: ['Basalt Monolith', 'Rings of Brighthearth'],
      description: 'Activate Monolith for 3 mana, copy with Rings, get 6 mana, pay 3 to untap, net +3 infinite',
    },
  ],
  counterCards: [
    'Collector Ouphe',
    'Null Rod',
    'Stony Silence',
    'Kataki, War\'s Wage',
    'Vandalblast',
    'Creeping Corrosion',
    'Energy Flux',
    'Shattering Spree',
    'By Force',
    'Meltdown',
  ],
  edhrecTheme: 'artifacts-matter',
  playSequence: [
    { turns: '1-2', phase: 'Ramp', goal: 'Deploy mana rocks, cheap artifacts', keyCards: ['Sol Ring', 'Mana Crypt', 'Mox Diamond', 'Voltaic Key'], priority: 'critical' },
    { turns: '3-4', phase: 'Engine', goal: 'Resolve combo monolith or draw engine', keyCards: ['Grim Monolith', 'Basalt Monolith', 'Mystic Forge'], priority: 'critical' },
    { turns: '5-6', phase: 'Combo', goal: 'Attach Power Artifact or Rings, go infinite', keyCards: ['Power Artifact', 'Rings of Brighthearth', "Sensei's Divining Top"], priority: 'critical' },
    { turns: '7+', phase: 'Win', goal: 'Draw deck or infinite mana payoff', keyCards: ['Walking Ballista', 'Aetherflux Reservoir'], priority: 'high' },
  ],
  detection: {
    minSignatureCards: 2,
    minKeyCards: 2,
    weightMultiplier: 2.0,
  },
};

export const STAX: ArchetypeDefinition = {
  id: 'stax',
  name: 'Stax',
  category: 'controlling',
  description: 'Lock opponents out of the game with resource denial and asymmetric effects',
  difficulty: 'intermediate',
  powerLevel: 'high',
  preferredColors: ['W', 'B'],
  keyCards: [
    'Winter Orb',
    'Static Orb',
    'Stasis',
    'Smokestack',
    'Tangle Wire',
    'Trinisphere',
  ],
  signatureCards: [
    'Winter Orb',
    'Static Orb',
    'Sphere of Resistance',
    'Thorn of Amethyst',
    'Glowrider',
    'Vryn Wingmare',
    'Rule of Law',
    'Ethersworn Canonist',
    'Drannith Magistrate',
    'Opposition Agent',
  ],
  synergisticCards: [
    'Smokestack',
    'Tangle Wire',
    'Trinisphere',
    'Blood Moon',
    'Magus of the Moon',
    'Contamination',
    'Infernal Darkness',
    'Chains of Mephistopheles',
    'Aven Mindcensor',
    'Leonin Arbiter',
  ],
  gamePlan: 'Play resource denial effects that hurt opponents more than you. Break parity with mana rocks, mana dorks, or commanders that work through the lock.',
  counterCards: [
    'Nature\'s Claim',
    'Force of Vigor',
    'Abrupt Decay',
    'Assassin\'s Trophy',
    'Collector Ouphe',
    'Kataki, War\'s Wage',
    'Vandalblast',
    'Creeping Corrosion',
    ' Seeds of Innocence',
    'By Force',
  ],
  edhrecTheme: 'stax',
  playSequence: [
    { turns: '1-2', phase: 'Ramp', goal: 'Play mana dorks/rocks to break parity', keyCards: ['Sol Ring', 'Arcane Signet', 'Chrome Mox'], priority: 'critical' },
    { turns: '3-4', phase: 'Lock', goal: 'Deploy stax pieces to slow opponents', keyCards: ['Winter Orb', 'Trinisphere', 'Rule of Law'], priority: 'critical' },
    { turns: '5-6', phase: 'Tighten', goal: 'Stack more hate pieces, maintain lock', keyCards: ['Static Orb', 'Smokestack', 'Tangle Wire'], priority: 'high' },
    { turns: '7+', phase: 'Win', goal: 'Win through commander or slow attrition', keyCards: ['Opposition Agent', 'Drannith Magistrate'], priority: 'medium' },
  ],
  detection: {
    minSignatureCards: 3,
    minKeyCards: 2,
    weightMultiplier: 1.8,
  },
};

// ============================================
// TRIBAL ARCHETYPES
// ============================================

export const TRIBAL_ELVES: ArchetypeDefinition = {
  id: 'tribal-elves',
  name: 'Tribal Elves',
  category: 'synergy',
  description: 'Play many elves, generate huge mana, overwhelm with numbers or Craterhoof',
  difficulty: 'beginner',
  powerLevel: 'mid',
  preferredColors: ['G'],
  keyCards: [
    'Priest of Titania',
    'Elvish Archdruid',
    'Heritage Druid',
    'Craterhoof Behemoth',
    'Beast Whisperer',
  ],
  signatureCards: [
    'Llanowar Elves',
    'Elvish Mystic',
    'Fyndhorn Elves',
    'Priest of Titania',
    'Elvish Archdruid',
    'Heritage Druid',
    'Nettle Sentinel',
    'Wirewood Symbiote',
    'Quirion Ranger',
    'Craterhoof Behemoth',
  ],
  synergisticCards: [
    'Allosaurus Shepherd',
    'Eladamri, Lord of Leaves',
    'Ezuri, Renegade Leader',
    'Elvish Warmaster',
    'Marwyn, the Nurturer',
    'Beast Whisperer',
    'The Great Henge',
    'Growing Rites of Itlimoc',
    'Natural Order',
    ' finale of Devastation',
  ],
  gamePlan: 'Play cheap elves to build a board, use mana elves to ramp quickly, draw cards with Beast Whisperer, then win with Craterhoof Behemoth or overwhelming attacks.',
  counterCards: [
    'Pyroclasm',
    'Toxic Deluge',
    'Elesh Norn, Grand Cenobite',
    'Cursed Totem',
    'Linvala, Keeper of Silence',
    'Suppression Field',
    'Web of Inertia',
    'Engineered Plague',
    'Illness in the Ranks',
    'Night of Souls\' Betrayal',
  ],
  edhrecTheme: 'elves',
  playSequence: [
    { turns: '1-2', phase: 'Ramp', goal: 'Play mana elves: Llanowar, Elvish Mystic', keyCards: ['Llanowar Elves', 'Elvish Mystic', 'Heritage Druid'], priority: 'critical' },
    { turns: '3-4', phase: 'Engine', goal: 'Resolve mana lord + card draw engine', keyCards: ['Priest of Titania', 'Elvish Archdruid', 'Beast Whisperer'], priority: 'critical' },
    { turns: '5-6', phase: 'Swarm', goal: 'Dump hand of elves, generate massive mana', keyCards: ['Wirewood Symbiote', 'Nettle Sentinel', 'Marwyn, the Nurturer'], priority: 'high' },
    { turns: '7+', phase: 'Finish', goal: 'Craterhoof or alpha strike', keyCards: ['Craterhoof Behemoth', 'Finale of Devastation'], priority: 'critical' },
  ],
  detection: {
    minSignatureCards: 5,
    minKeyCards: 3,
    weightMultiplier: 1.5,
  },
};

export const TRIBAL_GOBLINS: ArchetypeDefinition = {
  id: 'tribal-goblins',
  name: 'Tribal Goblins',
  category: 'aggressive',
  description: 'Aggressive swarm strategy with goblins and sacrifice payoffs',
  difficulty: 'beginner',
  powerLevel: 'mid',
  preferredColors: ['R'],
  keyCards: [
    'Krenko, Mob Boss',
    'Krenko, Tin Street Kingpin',
    'Goblin Lackey',
    'Goblin Recruiter',
    'Conspicuous Snoop',
  ],
  signatureCards: [
    'Goblin Lackey',
    'Goblin Matron',
    'Goblin Recruiter',
    'Conspicuous Snoop',
    'Kiki-Jiki, Mirror Breaker',
    'Mogg War Marshal',
    'Goblin Chieftain',
    'Goblin King',
    'Legion Loyalist',
    'Skirk Prospector',
  ],
  synergisticCards: [
    'Krenko, Mob Boss',
    'Krenko, Tin Street Kingpin',
    'Ib Halfheart, Goblin Tactician',
    'Goblin Bombardment',
    'Skirk Fire Marshal',
    'Goblin Grenade',
    'Munitions Expert',
    'Sling-Gang Lieutenant',
    'Pashalik Mons',
    'Boggart Harbinger',
  ],
  gamePlan: 'Play cheap goblins, use Krenko to generate massive numbers, sacrifice them for damage with Bombardment or Grenade, or overwhelm with Krenko tokens.',
  counterCards: [
    'Toxic Deluge',
    'Elesh Norn, Grand Cenobite',
    'Cursed Totem',
    'Linvala, Keeper of Silence',
    'Suppression Field',
    'Illness in the Ranks',
    'Night of Souls\' Betrayal',
    'An-Zerrin Ruins',
  ],
  edhrecTheme: 'goblins',
  playSequence: [
    { turns: '1-2', phase: 'Aggro', goal: 'Play cheap goblins, attack early', keyCards: ['Goblin Lackey', 'Legion Loyalist', 'Skirk Prospector'], priority: 'critical' },
    { turns: '3-4', phase: 'Engine', goal: 'Resolve Krenko or token generator', keyCards: ['Krenko, Mob Boss', 'Goblin Chieftain', 'Conspicuous Snoop'], priority: 'critical' },
    { turns: '5-6', phase: 'Swarm', goal: 'Multiply goblins, overwhelm board', keyCards: ['Goblin Bombardment', 'Sling-Gang Lieutenant', 'Kiki-Jiki, Mirror Breaker'], priority: 'high' },
    { turns: '7+', phase: 'Finish', goal: 'Sacrifice for lethal or alpha strike', keyCards: ['Goblin Grenade', 'Pashalik Mons'], priority: 'high' },
  ],
  detection: {
    minSignatureCards: 5,
    minKeyCards: 3,
    weightMultiplier: 1.5,
  },
};

// ============================================
// CASUAL ARCHETYPES
// ============================================

export const LIFEGAIN: ArchetypeDefinition = {
  id: 'lifegain',
  name: 'Lifegain',
  category: 'synergy',
  description: 'Gain life repeatedly, use payoffs that care about life total or life gained',
  difficulty: 'beginner',
  powerLevel: 'mid',
  preferredColors: ['W'],
  keyCards: [
    'Soul Warden',
    'Soul\'s Attendant',
    'Serra Ascendant',
    'Felidar Sovereign',
    'Aetherflux Reservoir',
  ],
  signatureCards: [
    'Soul Warden',
    'Soul\'s Attendant',
    'Ajani\'s Pridemate',
    'Archangel of Thune',
    'Serra Ascendant',
    'Felidar Sovereign',
    'Test of Endurance',
    'Aetherflux Reservoir',
    'Rhox Faithmender',
    'Beacon of Immortality',
  ],
  synergisticCards: [
    'Authority of the Consuls',
    'Soul Sisters',
    'Karlov of the Ghost Council',
    'Oloro, Ageless Ascetic',
    'Daxos, the Returned',
    'Heliod, Sun-Crowned',
    'Walking Ballista',
    'Triskaidekaphile',
    'Fumigate',
    'Austere Command',
  ],
  gamePlan: 'Play creatures that gain life when creatures enter, use payoffs like Serra Ascendant or Felidar Sovereign that care about high life totals.',
  counterCards: [
    'Erebos, God of the Dead',
    'Tainted Remedy',
    'Sulfuric Vortex',
    'Rampaging Ferocidon',
    'Harsh Mentor',
    'Rampaging Monument',
    'Stormbreath Dragon',
    'Skullcrack',
    'Atark\'s Command',
    'Rain of Gore',
  ],
  edhrecTheme: 'lifegain',
  playSequence: [
    { turns: '1-2', phase: 'Triggers', goal: 'Play soul sisters and cheap lifegain', keyCards: ['Soul Warden', "Soul's Attendant", 'Serra Ascendant'], priority: 'critical' },
    { turns: '3-4', phase: 'Payoffs', goal: 'Resolve lifegain payoffs', keyCards: ["Ajani's Pridemate", 'Heliod, Sun-Crowned', 'Archangel of Thune'], priority: 'high' },
    { turns: '5-6', phase: 'Engine', goal: 'Double lifegain, build board presence', keyCards: ['Rhox Faithmender', 'Beacon of Immortality', 'Aetherflux Reservoir'], priority: 'high' },
    { turns: '7+', phase: 'Win', goal: 'Win with life total payoff or Aetherflux', keyCards: ['Felidar Sovereign', 'Test of Endurance', 'Aetherflux Reservoir'], priority: 'critical' },
  ],
  detection: {
    minSignatureCards: 4,
    minKeyCards: 2,
    weightMultiplier: 1.3,
  },
};

export const TOKENS: ArchetypeDefinition = {
  id: 'tokens',
  name: 'Tokens',
  category: 'synergy',
  description: 'Create many token creatures, then pump them or use sacrifice payoffs',
  difficulty: 'beginner',
  powerLevel: 'mid',
  preferredColors: ['W', 'G'],
  keyCards: [
    'Anointed Procession',
    'Parallel Lives',
    'Doubling Season',
    'Craterhoof Behemoth',
    'Divine Visitation',
  ],
  signatureCards: [
    'Anointed Procession',
    'Parallel Lives',
    'Doubling Season',
    'Primal Vigor',
    'Craterhoof Behemoth',
    'Beastmaster Ascension',
    'Cathars\' Crusade',
    'Divine Visitation',
    'Intangible Virtue',
    'Elesh Norn, Grand Cenobite',
  ],
  synergisticCards: [
    'Avenger of Zendikar',
    'Hero of Bladehold',
    'White Sun\'s Zenith',
    'Secure the Wastes',
    'Martial Coup',
    'Decree of Justice',
    'Ophiomancer',
    'Tireless Tracker',
    'Chatterfang, Squirrel General',
    'Nested Shambler',
  ],
  gamePlan: 'Create token creatures with various spells and abilities, use token doublers to multiply them, then either pump them with anthems or sacrifice them for value.',
  counterCards: [
    'Elesh Norn, Grand Cenobite',
    'Night of Souls\' Betrayal',
    'Illness in the Ranks',
    'Engineered Plague',
    'Cursed Totem',
    'Linvala, Keeper of Silence',
    'Suppression Field',
    'An-Zerrin Ruins',
    'Pyroclasm',
    'Toxic Deluge',
  ],
  edhrecTheme: 'tokens',
  playSequence: [
    { turns: '1-2', phase: 'Ramp', goal: 'Play mana rocks, cheap token producers', keyCards: ['Sol Ring', 'Arcane Signet', 'Ophiomancer'], priority: 'high' },
    { turns: '3-4', phase: 'Doublers', goal: 'Resolve token doublers', keyCards: ['Anointed Procession', 'Parallel Lives', 'Doubling Season'], priority: 'critical' },
    { turns: '5-6', phase: 'Flood', goal: 'Mass token creation', keyCards: ['Avenger of Zendikar', 'White Sun\'s Zenith', 'Secure the Wastes'], priority: 'high' },
    { turns: '7+', phase: 'Finish', goal: 'Pump and alpha strike', keyCards: ['Craterhoof Behemoth', 'Beastmaster Ascension', "Cathars' Crusade"], priority: 'critical' },
  ],
  detection: {
    minSignatureCards: 3,
    minKeyCards: 2,
    weightMultiplier: 1.3,
  },
};

export const ARISTOCRATS: ArchetypeDefinition = {
  id: 'aristocrats',
  name: 'Aristocrats',
  category: 'synergy',
  description: 'Sacrifice creatures for value, drain opponents, and recur creatures from graveyard',
  difficulty: 'intermediate',
  powerLevel: 'mid',
  preferredColors: ['B', 'W'],
  keyCards: [
    'Blood Artist',
    'Zulaport Cutthroat',
    'Cruel Celebrant',
    'Ashnod\'s Altar',
    'Phyrexian Altar',
  ],
  signatureCards: [
    'Blood Artist',
    'Zulaport Cutthroat',
    'Cruel Celebrant',
    'Falkenrath Noble',
    'Vindictive Vampire',
    'Ashnod\'s Altar',
    'Phyrexian Altar',
    'Altar of Dementia',
    'Carrion Feeder',
    'Yawgmoth, Thran Physician',
  ],
  synergisticCards: [
    'Teysa Karlov',
    'Teysa, Orzhov Scion',
    'Elenda, the Dusk Rose',
    'Athreos, God of Passage',
    'Orah, Skyclave Hierophant',
    'Living Death',
    'Victimize',
    'Gravecrawler',
    'Bloodghast',
    'Reassembling Skeleton',
  ],
  gamePlan: 'Play cheap creatures that create tokens or return from graveyard, sacrifice them repeatedly to drain opponents with Blood Artist effects or generate mana.',
  counterCards: [
    'Rest in Peace',
    'Leyline of the Void',
    'Grafdigger\'s Cage',
    'Planar Void',
    'Anafenza, the Foremost',
    'Kalitas, Traitor of Ghet',
    'Scavenging Ooze',
    'Relic of Progenitus',
    'Tormod\'s Crypt',
    'Bojuka Bog',
  ],
  edhrecTheme: 'aristocrats',
  playSequence: [
    { turns: '1-2', phase: 'Ramp', goal: 'Play mana rocks, cheap creatures', keyCards: ['Sol Ring', 'Arcane Signet', 'Blood Artist'], priority: 'critical' },
    { turns: '3-4', phase: 'Engine', goal: 'Establish sac outlet + death trigger', keyCards: ['Viscera Seer', 'Zulaport Cutthroat', 'Skullclamp'], priority: 'high' },
    { turns: '5-6', phase: 'Fuel', goal: 'Generate recursive fuel', keyCards: ['Gravecrawler', 'Reassembling Skeleton', 'Pitiless Plunderer'], priority: 'high' },
    { turns: '7+', phase: 'Combo', goal: 'Loop for lethal drain', keyCards: ['Phyrexian Altar', 'Gravecrawler'], priority: 'critical' },
  ],
  detection: {
    minSignatureCards: 3,
    minKeyCards: 2,
    weightMultiplier: 1.4,
  },
};

export const VOLTRON: ArchetypeDefinition = {
  id: 'voltron',
  name: 'Voltron',
  category: 'aggressive',
  description: 'Equip commander with powerful auras and equipment, kill with commander damage',
  difficulty: 'beginner',
  powerLevel: 'mid',
  preferredColors: ['W', 'U', 'G'],
  keyCards: [
    'Lightning Greaves',
    'Swiftfoot Boots',
    'Swiftsteel Boots',
    'Colossus Hammer',
    'Blackblade Reforged',
  ],
  signatureCards: [
    'Lightning Greaves',
    'Swiftfoot Boots',
    'Swiftsteel Boots',
    'Colossus Hammer',
    'Blackblade Reforged',
    'Eldrazi Conscription',
    'Armored Ascension',
    'Battle Mastery',
    'Fireshrieker',
    'Inquisitor\'s Flail',
  ],
  synergisticCards: [
    'Sigarda\'s Aid',
    'Puresteel Paladin',
    'Stoneforge Mystic',
    'Stonehewer Giant',
    'Open the Armory',
    'Steelshaper\'s Gift',
    'Fighter Class',
    'Rogue\'s Passage',
    'Whispersilk Cloak',
    'Trailblazer\'s Boots',
  ],
  gamePlan: 'Play your commander early, protect it with hexproof/shroud equipment, then suit it up with powerful equipment and auras to deal 21 commander damage.',
  counterCards: [
    'Darksteel Mutation',
    'Imprisoned in the Moon',
    'Oubliette',
    'Song of the Dryads',
    'Lignify',
    'Kenrith\'s Transformation',
    'Humility',
    'Arcane Lighthouse',
    'Detection Tower',
    'Shadowspear',
  ],
  edhrecTheme: 'equipments',
  playSequence: [
    { turns: '1-2', phase: 'Ramp', goal: 'Play cheap equipment, mana rocks', keyCards: ['Sol Ring', 'Lightning Greaves', 'Swiftfoot Boots'], priority: 'critical' },
    { turns: '3-4', phase: 'Commander', goal: 'Cast commander, equip protection', keyCards: ['Lightning Greaves', 'Swiftfoot Boots', "Sigarda's Aid"], priority: 'critical' },
    { turns: '5-6', phase: 'Suit Up', goal: 'Stack power equipment on commander', keyCards: ['Colossus Hammer', 'Blackblade Reforged', 'Eldrazi Conscription'], priority: 'high' },
    { turns: '7+', phase: 'Kill', goal: 'Swing for 21 commander damage', keyCards: ['Battle Mastery', "Rogue's Passage"], priority: 'critical' },
  ],
  detection: {
    minSignatureCards: 4,
    minKeyCards: 2,
    weightMultiplier: 1.2,
  },
};

export const LANDS_MATTER: ArchetypeDefinition = {
  id: 'lands-matter',
  name: 'Lands Matter',
  category: 'synergy',
  description: 'Use land-based strategies, landfall triggers, and utility lands for value',
  difficulty: 'intermediate',
  powerLevel: 'mid',
  preferredColors: ['G', 'R'],
  keyCards: [
    'The Gitrog Monster',
    'Titania, Protector of Argoth',
    'Omnath, Locus of Rage',
    'Azusa, Lost but Seeking',
    'Oracle of Mul Daya',
  ],
  signatureCards: [
    'The Gitrog Monster',
    'Titania, Protector of Argoth',
    'Omnath, Locus of Rage',
    'Omnath, Locus of Creation',
    'Azusa, Lost but Seeking',
    'Oracle of Mul Daya',
    'Crucible of Worlds',
    'Ramunap Excavator',
    'Splendid Reclamation',
    'World Shaper',
  ],
  synergisticCards: [
    'Scapeshift',
    'Splendid Reclamation',
    'Life from the Loam',
    'Wrenn and Six',
    'Tireless Tracker',
    'Avenger of Zendikar',
    'Rampaging Baloths',
    'Ob Nixilis, the Fallen',
    'Field of the Dead',
    'Dark Depths',
  ],
  gamePlan: 'Play extra lands with Azusa effects, use landfall triggers for value, recur lands from graveyard, win with massive token armies or direct damage.',
  counterCards: [
    'Blood Moon',
    'Magus of the Moon',
    'Back to Basics',
    'Destructive Flow',
    'Ruination',
    'Acid Rain',
    'Price of Progress',
    'Ankh of Mishra',
    'Zo-Zu the Punisher',
    'Tunnel Ignus',
  ],
  edhrecTheme: 'lands-matter',
  playSequence: [
    { turns: '1-2', phase: 'Ramp', goal: 'Play ramp spells and extra land enablers', keyCards: ['Sol Ring', 'Exploration', 'Burgeoning'], priority: 'critical' },
    { turns: '3-4', phase: 'Engine', goal: 'Resolve landfall engines and extra land drops', keyCards: ['Azusa, Lost but Seeking', 'Oracle of Mul Daya', 'Crucible of Worlds'], priority: 'critical' },
    { turns: '5-6', phase: 'Value', goal: 'Landfall triggers for tokens/damage/card draw', keyCards: ['Omnath, Locus of Rage', 'Tireless Tracker', 'Rampaging Baloths'], priority: 'high' },
    { turns: '7+', phase: 'Finish', goal: 'Scapeshift or mass land recursion for lethal', keyCards: ['Scapeshift', 'Splendid Reclamation', 'Field of the Dead'], priority: 'critical' },
  ],
  detection: {
    minSignatureCards: 3,
    minKeyCards: 2,
    weightMultiplier: 1.3,
  },
};

// ============================================
// COMPLETE ARCHETYPE CATALOG
// ============================================

export const ARCHETYPE_CATALOG: ArchetypeDefinition[] = [
  // Combo
  REANIMATOR,
  STORM,
  FOOD_CHAIN,
  THASSA_ORACLE,
  UNDERWORLD_BREACH,
  ARTIFACT_COMBO,
  STAX,
  
  // Tribal
  TRIBAL_ELVES,
  TRIBAL_GOBLINS,
  
  // Casual
  LIFEGAIN,
  TOKENS,
  ARISTOCRATS,
  VOLTRON,
  LANDS_MATTER,
];

export const ARCHETYPE_BY_ID: Map<ArchetypeId, ArchetypeDefinition> = new Map(
  ARCHETYPE_CATALOG.map(a => [a.id, a])
);

// Helper functions
export function getArchetypeById(id: ArchetypeId): ArchetypeDefinition | undefined {
  return ARCHETYPE_BY_ID.get(id);
}

export function getAllArchetypes(): ArchetypeDefinition[] {
  return [...ARCHETYPE_CATALOG];
}

export function getArchetypesByCategory(category: ArchetypeCategory): ArchetypeDefinition[] {
  return ARCHETYPE_CATALOG.filter(a => a.category === category);
}

export function getArchetypesByPowerLevel(level: ArchetypeDefinition['powerLevel']): ArchetypeDefinition[] {
  return ARCHETYPE_CATALOG.filter(a => a.powerLevel === level);
}

export function getCounterCardsForArchetype(archetypeId: ArchetypeId): string[] {
  const archetype = getArchetypeById(archetypeId);
  return archetype?.counterCards || [];
}

export function getAllCounterCards(): Map<string, ArchetypeId[]> {
  const counterMap = new Map<string, ArchetypeId[]>();
  
  for (const archetype of ARCHETYPE_CATALOG) {
    for (const card of archetype.counterCards) {
      const normalizedCard = card.toLowerCase();
      if (!counterMap.has(normalizedCard)) {
        counterMap.set(normalizedCard, []);
      }
      counterMap.get(normalizedCard)!.push(archetype.id);
    }
  }
  
  return counterMap;
}
