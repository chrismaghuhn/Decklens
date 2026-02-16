import type { DeckbuilderCardView, DeckbuilderDeck, EdhRuleIssue, EdhRuleResult } from './types.js';

// Curated replacement suggestions for commonly banned/problematic EDH cards.
// Maps normalized card name → { replacement, reason }.
const BANNED_CARD_REPLACEMENTS: Record<string, { replacement: string; reason: string }[]> = {
  // Banned commanders / creatures
  'golos, tireless pilgrim': [
    { replacement: 'Kenrith, the Returned King', reason: 'Similar 5C value engine commander' },
    { replacement: 'Jodah, the Unifier', reason: '5C legendary-matters value' },
  ],
  'braids, cabal minion': [
    { replacement: 'Tergrid, God of Fright', reason: 'Similar sacrifice-matters strategy' },
    { replacement: 'Rankle, Master of Pranks', reason: 'Evasive with sacrifice/discard modes' },
  ],
  'leovold, emissary of trest': [
    { replacement: 'Notion Thief', reason: 'Similar draw-denial on a creature' },
    { replacement: 'Narset, Parter of Veils', reason: 'Limits opponents to 1 draw per turn' },
  ],
  'emrakul, the aeons torn': [
    { replacement: 'Ulamog, the Ceaseless Hunger', reason: 'Powerful Eldrazi finisher, legal' },
    { replacement: 'Blightsteel Colossus', reason: 'Indestructible one-shot threat' },
  ],
  'griselbrand': [
    { replacement: 'Vilis, Broker of Blood', reason: 'Life-to-cards payoff, more fair' },
    { replacement: 'Razaketh, the Foulblooded', reason: 'Tutor-on-a-stick, sacrifice-based' },
  ],
  'hullbreacher': [
    { replacement: 'Narset, Parter of Veils', reason: 'Draw-limiting effect (no treasure)' },
    { replacement: 'Notion Thief', reason: 'Steals draws instead of creating treasure' },
  ],
  'iona, shield of emeria': [
    { replacement: 'Void Winnower', reason: 'Limits opponents casting without full lock' },
    { replacement: 'Archon of Emeria', reason: 'Slows opponents with Rule of Law effect' },
  ],
  'coalition victory': [
    { replacement: 'Approach of the Second Sun', reason: 'Alternate wincon, telegraphed' },
    { replacement: 'Maze\'s End', reason: 'Land-based alternate wincon' },
  ],
  'biorhythm': [
    { replacement: 'Triumph of the Hordes', reason: 'Creature-based wincon' },
    { replacement: 'Craterhoof Behemoth', reason: 'Powerful creature-based finisher' },
  ],
  'panoptic mirror': [
    { replacement: 'Isochron Scepter', reason: 'Imprint instants with CMC ≤2 only' },
    { replacement: 'Elite Arcanist', reason: 'Creature-based spell repeater (removable)' },
  ],
  'primeval titan': [
    { replacement: 'Ulvenwald Hydra', reason: 'Fetches a land on ETB, fair body' },
    { replacement: 'Hour of Promise', reason: 'Fetches 2 lands, sorcery speed' },
  ],
  'prophet of kruphix': [
    { replacement: 'Seedborn Muse', reason: 'Untaps permanents, no free flash' },
    { replacement: 'Leyline of Anticipation', reason: 'Gives flash to everything' },
  ],
  'rofellos, llanowar emissary': [
    { replacement: 'Selvala, Heart of the Wilds', reason: 'Big mana from creatures, more interactive' },
    { replacement: 'Marwyn, the Nurturer', reason: 'Elf-based ramp commander' },
  ],
  'sundering titan': [
    { replacement: 'Meteor Golem', reason: 'Artifact creature with removal ETB' },
    { replacement: 'Duplicant', reason: 'Exiles a creature on ETB' },
  ],
  'sylvan primordial': [
    { replacement: 'Terastodon', reason: 'Destroys noncreature permanents' },
    { replacement: 'Bane of Progress', reason: 'Destroys all artifacts/enchantments' },
  ],
  'trade secrets': [
    { replacement: 'Windfall', reason: 'Wheel effect that draws cards for everyone' },
    { replacement: 'Fact or Fiction', reason: 'Powerful instant-speed card selection' },
  ],
  'upheaval': [
    { replacement: 'Cyclonic Rift', reason: 'One-sided bounce (overloaded)' },
    { replacement: 'Devastation Tide', reason: 'Miracle-cost bounce all' },
  ],
  'limited resources': [
    { replacement: 'Land Tax', reason: 'Catches you up on lands fairly' },
    { replacement: 'Weathered Wayfarer', reason: 'Land search when behind' },
  ],
  'balance': [
    { replacement: 'Restore Balance', reason: 'Suspend-only, telegraphed' },
    { replacement: 'Cataclysmic Gearhulk', reason: 'Each player keeps one of each type' },
  ],
  'channel': [
    { replacement: 'Selvala, Heart of the Wilds', reason: 'Big mana from creatures' },
  ],
  'fastbond': [
    { replacement: 'Exploration', reason: 'Extra land drop per turn' },
    { replacement: 'Azusa, Lost but Seeking', reason: 'Two extra land drops' },
  ],
  'gifts ungiven': [
    { replacement: 'Fact or Fiction', reason: 'Similar pile-splitting card selection' },
    { replacement: 'Intuition', reason: 'Searches for 3, opponent chooses 1 (if legal)' },
  ],
  'recurring nightmare': [
    { replacement: 'Phyrexian Reclamation', reason: 'Repeatable creature recursion' },
    { replacement: 'Animate Dead', reason: 'Classic reanimation enchantment' },
  ],
  'time vault': [
    { replacement: 'Lithoform Engine', reason: 'Copy abilities/spells, no infinite turns' },
  ],
  'tinker': [
    { replacement: 'Fabricate', reason: 'Tutors an artifact without cheating mana' },
    { replacement: 'Whir of Invention', reason: 'Improvise-based artifact tutor' },
  ],
  'tolarian academy': [
    { replacement: 'Academy Ruins', reason: 'Artifact recursion utility land' },
    { replacement: 'Seat of the Synod', reason: 'Artifact land for synergy' },
  ],
  'yawgmoth\'s bargain': [
    { replacement: 'Necropotence', reason: 'Similar life-for-cards (if legal in your bracket)' },
    { replacement: 'Bolas\'s Citadel', reason: 'Play from top of library, pay life' },
  ],
  'mana crypt': [
    { replacement: 'Sol Ring', reason: 'Iconic fast mana, 1 mana cost' },
    { replacement: 'Arcane Signet', reason: 'Fixes colors, 2 mana' },
  ],
  'jeweled lotus': [
    { replacement: 'Sol Ring', reason: 'Versatile fast mana' },
    { replacement: 'Arcane Signet', reason: 'Color-fixing 2-mana rock' },
  ],
  'dockside extortionist': [
    { replacement: 'Magus of the Moon', reason: 'Red disruption creature' },
    { replacement: 'Professional Face-Breaker', reason: 'Treasure generation from combat' },
  ],
  'Nadu, winged wisdom': [
    { replacement: 'Chulane, Teller of Tales', reason: 'Creature-based card advantage engine' },
    { replacement: 'Derevi, Empyrial Tactician', reason: 'Bant untap synergies' },
  ],
  'lutri, the spellchaser': [
    { replacement: 'Dualcaster Mage', reason: 'Copies an instant/sorcery on ETB' },
  ],
};

const BASIC_NAME_ALLOWLIST = new Set([
  'plains',
  'island',
  'swamp',
  'mountain',
  'forest',
  'wastes',
  'snow-covered plains',
  'snow-covered island',
  'snow-covered swamp',
  'snow-covered mountain',
  'snow-covered forest',
]);

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isBasicLand(card: DeckbuilderCardView | undefined, cardName: string): boolean {
  if (BASIC_NAME_ALLOWLIST.has(normalizeNameKey(cardName))) return true;
  const typeLine = (card?.type_line || '').toLowerCase();
  return typeLine.includes('basic land');
}

function hasPartner(card: DeckbuilderCardView | undefined): boolean {
  const keywords = Array.isArray(card?.keywords) ? card?.keywords : [];
  const keywordsLower = keywords.map((k) => k.toLowerCase());

  // Standard Partner keyword
  if (keywordsLower.includes('partner')) return true;

  // Friends Forever (Commander Legends: Battle for Baldur's Gate / Commander Masters)
  if (keywordsLower.includes('friends forever')) return true;

  // Doctor's Companion (Doctor Who)
  if (keywordsLower.some((k) => k.includes("doctor's companion"))) return true;

  // Choose a Background (CLB) — the commander with this ability pairs with a Background enchantment
  const oracle = (card?.oracle_text || '').toLowerCase();
  if (/\bchoose a background\b/.test(oracle)) return true;

  // Background type line — the enchantment half that pairs with "Choose a Background" commanders
  const tl = (card?.type_line || '').toLowerCase();
  if (tl.includes('enchantment') && tl.includes('background')) return true;

  // "Partner with <specific name>" (Battlebond-style)
  if (/\bpartner with\b/.test(oracle)) return true;

  // Fallback: keyword text in oracle
  if (/\bpartner\b/.test(oracle)) return true;
  if (/\bfriends forever\b/.test(oracle)) return true;

  return false;
}

/**
 * Check if two commanders form a legal pair.
 * - Both have generic "Partner" → legal
 * - Both have "Friends Forever" → legal
 * - One has "Partner with <name>" naming the other → legal
 * - One has "Choose a Background" and the other is a Background → legal
 * - One has "Doctor's Companion" and the other is a Doctor → legal
 */
function isLegalCommanderPair(
  cardA: DeckbuilderCardView | undefined,
  cardB: DeckbuilderCardView | undefined,
): boolean {
  if (!cardA || !cardB) return false;

  const keywordsA = (cardA.keywords || []).map((k) => k.toLowerCase());
  const keywordsB = (cardB.keywords || []).map((k) => k.toLowerCase());
  const oracleA = (cardA.oracle_text || '').toLowerCase();
  const oracleB = (cardB.oracle_text || '').toLowerCase();
  const typeA = (cardA.type_line || '').toLowerCase();
  const typeB = (cardB.type_line || '').toLowerCase();

  // Both have generic Partner
  if (keywordsA.includes('partner') && keywordsB.includes('partner')) return true;

  // Both have Friends Forever
  if (keywordsA.includes('friends forever') && keywordsB.includes('friends forever')) return true;

  // Partner with <name>: A names B or B names A
  const partnerWithA = oracleA.match(/partner with ([^\n(]+)/);
  const partnerWithB = oracleB.match(/partner with ([^\n(]+)/);
  if (partnerWithA && normalizeNameKey(partnerWithA[1]) === normalizeNameKey(cardB.name)) return true;
  if (partnerWithB && normalizeNameKey(partnerWithB[1]) === normalizeNameKey(cardA.name)) return true;

  // Choose a Background + Background enchantment
  if (/\bchoose a background\b/.test(oracleA) && typeB.includes('background')) return true;
  if (/\bchoose a background\b/.test(oracleB) && typeA.includes('background')) return true;

  // Doctor's Companion + Time Lord Doctor
  const isDoctorCompanionA = keywordsA.some((k) => k.includes("doctor's companion"));
  const isDoctorCompanionB = keywordsB.some((k) => k.includes("doctor's companion"));
  const isDoctorA = typeA.includes('time lord') && typeA.includes('doctor');
  const isDoctorB = typeB.includes('time lord') && typeB.includes('doctor');
  if (isDoctorCompanionA && isDoctorB) return true;
  if (isDoctorCompanionB && isDoctorA) return true;

  return false;
}

function colorSet(card: DeckbuilderCardView | undefined): Set<string> {
  const result = new Set<string>();
  const identity = Array.isArray(card?.color_identity) ? card?.color_identity : [];
  for (const color of identity) {
    const normalized = String(color).trim().toUpperCase();
    if (normalized === 'W' || normalized === 'U' || normalized === 'B' || normalized === 'R' || normalized === 'G') {
      result.add(normalized);
    }
  }
  return result;
}

function addIssue(issues: EdhRuleIssue[], issue: EdhRuleIssue): void {
  issues.push(issue);
}

function getSuggestionsForCard(cardName: string): Array<{ cardName: string; replacement: string; reason: string }> {
  const key = normalizeNameKey(cardName);
  const replacements = BANNED_CARD_REPLACEMENTS[key];
  if (!replacements) return [];
  return replacements.map((r) => ({ cardName: cardName, replacement: r.replacement, reason: r.reason }));
}

export function evaluateEdhRules(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderCardView | undefined>,
): EdhRuleResult {
  const issues: EdhRuleIssue[] = [];

  const commanderCount = deck.boards.commander.reduce((sum, entry) => sum + entry.qty, 0);
  const maindeckCount = deck.boards.mainboard.reduce((sum, entry) => sum + entry.qty, 0);
  const effectiveDeckSize = commanderCount + maindeckCount;

  if (commanderCount === 0) {
    addIssue(issues, {
      code: 'missing_commander',
      severity: 'error',
      message: 'Commander is required. Add one commander card.',
    });
  } else if (commanderCount > 2) {
    addIssue(issues, {
      code: 'too_many_commanders',
      severity: 'error',
      message: `Too many commanders (${commanderCount}). Commander decks support one commander, or two with Partner.`,
    });
  }

  if (commanderCount === 2) {
    const commanderEntries = deck.boards.commander.filter((entry) => entry.qty > 0);
    const validPairShape = commanderEntries.length === 2 && commanderEntries.every((entry) => entry.qty === 1);

    if (!validPairShape) {
      addIssue(issues, {
        code: 'commander_partner_invalid',
        severity: 'error',
        message: 'Two commanders must each have quantity 1.',
      });
    } else {
      const cardA = cardByName[normalizeNameKey(commanderEntries[0].name)];
      const cardB = cardByName[normalizeNameKey(commanderEntries[1].name)];
      const bothHavePartnerAbility = hasPartner(cardA) && hasPartner(cardB);
      const isLegalPair = isLegalCommanderPair(cardA, cardB);

      if (!bothHavePartnerAbility) {
        addIssue(issues, {
          code: 'commander_partner_invalid',
          severity: 'error',
          message: 'Two commanders require both to have Partner, Friends Forever, Choose a Background, or Doctor\'s Companion.',
        });
      } else if (!isLegalPair) {
        addIssue(issues, {
          code: 'commander_partner_invalid',
          severity: 'warning',
          message: 'These commanders may not be a legal pair. Verify their pairing ability matches (e.g., Partner with <name>, Background type, Doctor + Companion).',
        });
      }
    }
  }

  if (effectiveDeckSize < 100) {
    const missing = 100 - effectiveDeckSize;
    addIssue(issues, {
      code: 'deck_size_under',
      severity: 'error',
      message: `Deck is under 100 cards by ${missing}. Commander decks must be exactly 100 cards including commander(s).`,
    });
  } else if (effectiveDeckSize > 100) {
    const extra = effectiveDeckSize - 100;
    addIssue(issues, {
      code: 'deck_size_over',
      severity: 'error',
      message: `Deck is over 100 cards by ${extra}. Commander decks must be exactly 100 cards including commander(s).`,
    });
  }

  const singletonViolations: string[] = [];
  for (const board of [deck.boards.mainboard, deck.boards.commander]) {
    for (const entry of board) {
      if (entry.qty <= 1) continue;
      const card = cardByName[normalizeNameKey(entry.name)];
      if (!isBasicLand(card, entry.name)) {
        singletonViolations.push(`${entry.name} (${entry.qty})`);
      }
    }
  }
  if (singletonViolations.length > 0) {
    addIssue(issues, {
      code: 'singleton_violation',
      severity: 'error',
      message: 'Singleton violation detected (only basic lands may have multiples).',
      cards: singletonViolations.slice(0, 12),
    });
  }

  const commanderColorIdentity = new Set<string>();
  let hasKnownCommanderIdentity = false;
  for (const entry of deck.boards.commander) {
    const card = cardByName[normalizeNameKey(entry.name)];
    const colors = colorSet(card);
    if (colors.size > 0 || (card && Array.isArray(card.color_identity))) {
      hasKnownCommanderIdentity = true;
    }
    for (const color of Array.from(colors)) commanderColorIdentity.add(color);

    const commanderLegality = card?.legalities?.commander;
    if (commanderLegality && commanderLegality !== 'legal') {
      const suggestions = getSuggestionsForCard(entry.name);
      addIssue(issues, {
        code: 'commander_legality_warning',
        severity: commanderLegality === 'banned' ? 'error' : 'warning',
        message: `${entry.name} is ${commanderLegality} in Commander.`,
        cards: [entry.name],
        suggestions,
      });
    }
  }

  // Check all mainboard cards for commander legality
  const bannedMainboard: string[] = [];
  const bannedSuggestions: Array<{ cardName: string; replacement: string; reason: string }> = [];
  for (const entry of deck.boards.mainboard) {
    const card = cardByName[normalizeNameKey(entry.name)];
    const legality = card?.legalities?.commander;
    if (legality && legality !== 'legal') {
      bannedMainboard.push(entry.name);
      const sug = getSuggestionsForCard(entry.name);
      for (const s of sug) bannedSuggestions.push(s);
    }
  }
  if (bannedMainboard.length > 0) {
    addIssue(issues, {
      code: 'commander_legality_warning',
      severity: 'error',
      message: `${bannedMainboard.length} card${bannedMainboard.length > 1 ? 's are' : ' is'} not legal in Commander.`,
      cards: bannedMainboard.slice(0, 16),
      suggestions: bannedSuggestions.length > 0 ? bannedSuggestions : undefined,
    });
  }

  if (hasKnownCommanderIdentity) {
    const outOfIdentity: string[] = [];
    for (const entry of deck.boards.mainboard) {
      const card = cardByName[normalizeNameKey(entry.name)];
      const colors = colorSet(card);
      const isOutside = Array.from(colors).some((color) => !commanderColorIdentity.has(color));
      if (isOutside) outOfIdentity.push(entry.name);
    }

    if (outOfIdentity.length > 0) {
      addIssue(issues, {
        code: 'color_identity_violation',
        severity: 'warning',
        message: 'Some cards are outside your commander color identity.',
        cards: outOfIdentity.slice(0, 16),
      });
    }
  }

  // Companion detection (sideboard)
  for (const entry of deck.boards.sideboard) {
    const card = cardByName[normalizeNameKey(entry.name)];
    if (!card) continue;
    const kws = (card.keywords || []).map((k) => k.toLowerCase());
    if (kws.includes('companion')) {
      addIssue(issues, {
        code: 'companion_detected',
        severity: 'warning',
        message: `Companion detected: ${entry.name}. Verify your deck meets its construction restriction.`,
        cards: [entry.name],
      });
      break; // Only one companion allowed
    }
  }

  return {
    issues,
    counts: {
      commander: commanderCount,
      maindeck: maindeckCount,
      effectiveDeckSize,
    },
  };
}
