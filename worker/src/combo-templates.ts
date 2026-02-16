/**
 * Combo Template Matching Engine
 *
 * Encodes repeatable combo patterns like "Kiki-Jiki + any creature with
 * an untap ability" using hardcoded oracle-text regex matching.
 *
 * Safety:
 *  - ALL regex patterns are hardcoded — never user-provided.
 *  - Patterns are short and simple (no nested quantifiers).
 *  - Oracle text length is capped per slot (default 1000 chars).
 *  - Regex construction is wrapped in try/catch.
 */

// ─── D1 type placeholder ────────────────────────────────────────────
type D1 = any;

// ─── Types ──────────────────────────────────────────────────────────

export interface SlotRequirement {
  slot: string;                     // e.g. "untapper", "sac-outlet", "x-sink"
  oracleTextPattern: string;        // Short anchored regex — NO user-defined
  typePattern?: string;             // e.g. "creature"
  maxTextLength?: number;           // Safety: skip cards with oracle_text > N chars
}

export interface ComboTemplate {
  id: string;
  name: string;
  description: string;
  anchorCards: string[];            // Cards that must be present (by name)
  slots: SlotRequirement[];
  resultTags: string[];
}

export interface TemplateMatch {
  templateId: string;
  templateName: string;
  description: string;
  anchorCards: string[];            // Matched anchor cards from deck
  slotFills: Array<{ slot: string; cardName: string }>;
  resultTags: string[];
  allCards: string[];               // anchorCards + slot fill cards
}

export interface CardInfo {
  name: string;
  oracle_text: string;
  type_line: string;
  mana_cost?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Normalize a card name for comparison: lowercase, trim whitespace.
 */
function normalizeName(name: string): string {
  return name.toLowerCase().trim();
}

/**
 * Safely compile a regex from a hardcoded pattern string.
 * Returns null on failure and logs the error.
 */
function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    console.error(`[combo-templates] Invalid regex pattern "${pattern}":`, err);
    return null;
  }
}

/**
 * Test whether a card's oracle text matches a slot requirement.
 * Respects maxTextLength and type constraints.
 */
function cardMatchesSlot(card: CardInfo, slot: SlotRequirement): boolean {
  const maxLen = slot.maxTextLength ?? 1000;
  if ((card.oracle_text?.length ?? 0) > maxLen) return false;

  // Type constraint
  if (slot.typePattern) {
    const typeRe = safeRegex(slot.typePattern);
    if (!typeRe) return false;
    if (!typeRe.test(card.type_line ?? '')) return false;
  }

  // Oracle text pattern
  const re = safeRegex(slot.oracleTextPattern);
  if (!re) return false;
  return re.test(card.oracle_text ?? '');
}

// ─── Builtin Templates ─────────────────────────────────────────────

/**
 * Returns the 5 hardcoded combo templates shipped with DeckLens.
 */
export function getBuiltinTemplates(): ComboTemplate[] {
  return [
    // 1. Kiki-Jiki + Untapper ─────────────────────────────────────
    {
      id: 'kiki-untapper',
      name: 'Kiki-Jiki + Untapper',
      description:
        'Kiki-Jiki, Mirror Breaker combined with any creature that can untap ' +
        'itself or another creature creates infinite token copies with haste, ' +
        'triggering infinite ETB effects.',
      anchorCards: ['Kiki-Jiki, Mirror Breaker'],
      slots: [
        {
          slot: 'untapper',
          oracleTextPattern: 'untap (it|target creature|all creatures)',
          typePattern: 'creature',
          maxTextLength: 1000,
        },
      ],
      resultTags: ['infinite-tokens', 'infinite-etb'],
    },

    // 2. Persist + Sac Outlet + Death Payoff ─────────────────────
    {
      id: 'persist-sac-payoff',
      name: 'Persist + Sac Outlet + Death Trigger',
      description:
        'A creature with persist returns to the battlefield with a -1/-1 counter. ' +
        'A +1/+1 counter source (or similar) removes it, allowing infinite sacrifice ' +
        'loops that trigger "whenever a creature dies" payoffs.',
      anchorCards: [],
      slots: [
        {
          slot: 'persist-creature',
          oracleTextPattern: '\\bpersist\\b',
          typePattern: 'creature',
          maxTextLength: 800,
        },
        {
          slot: 'sac-outlet',
          oracleTextPattern: 'sacrifice (a|another) creature',
          maxTextLength: 1000,
        },
        {
          slot: 'death-payoff',
          oracleTextPattern: 'whenever (a|another) creature dies',
          maxTextLength: 1000,
        },
      ],
      resultTags: ['infinite-death-triggers'],
    },

    // 3. Isochron Scepter + Dramatic Reversal ────────────────────
    {
      id: 'isochron-dramatic',
      name: 'Isochron Scepter + Dramatic Reversal',
      description:
        'Imprint Dramatic Reversal on Isochron Scepter. With 3+ mana from ' +
        'nonland mana sources (rocks/dorks), each activation untaps them all, ' +
        'generating infinite mana.',
      anchorCards: ['Isochron Scepter', 'Dramatic Reversal'],
      slots: [
        {
          slot: 'mana-producer',
          oracleTextPattern: 'add \\{',
          maxTextLength: 600,
        },
      ],
      resultTags: ['infinite-mana'],
    },

    // 4. Gravecrawler Loop ───────────────────────────────────────
    {
      id: 'gravecrawler-loop',
      name: 'Gravecrawler Sac Loop',
      description:
        'Gravecrawler can be recast from the graveyard as long as you control a ' +
        'Zombie. Pair with a free sacrifice outlet and a death-trigger payoff for ' +
        'infinite death triggers and ETB effects.',
      anchorCards: ['Gravecrawler'],
      slots: [
        {
          slot: 'sac-outlet',
          oracleTextPattern: 'sacrifice (a|another) creature',
          maxTextLength: 1000,
        },
        {
          slot: 'death-payoff',
          oracleTextPattern: 'whenever (a|another) creature dies',
          maxTextLength: 1000,
        },
      ],
      resultTags: ['infinite-death-triggers', 'infinite-etb'],
    },

    // 5. Infinite Mana → X-Spell Payoff ──────────────────────────
    {
      id: 'infinite-mana-x-sink',
      name: 'Infinite Mana + X-Spell Win Condition',
      description:
        'Once infinite mana is established by another combo in the deck, an ' +
        'X-cost spell that deals damage, creates tokens, draws cards, or causes ' +
        'life loss serves as the win condition.',
      anchorCards: [],
      slots: [
        {
          slot: 'x-sink',
          oracleTextPattern: '(damage|create|draw|loses)',
          maxTextLength: 1000,
        },
      ],
      resultTags: ['win-condition'],
    },
  ];
}

// ─── Template Matching ──────────────────────────────────────────────

/**
 * Match combo templates against a deck's card list.
 *
 * For each template:
 *  1. Verify ALL anchor cards are present in the deck.
 *  2. For each slot, find at least one card that matches.
 *  3. Only return a match when every anchor and every slot is satisfied.
 *
 * The special template "infinite-mana-x-sink" is evaluated after all other
 * templates so it can check whether an "infinite-mana" result tag was found.
 *
 * @param templates - Combo templates to evaluate
 * @param deckCards - Cards in the player's deck
 * @returns Array of matched combos
 */
export function matchTemplates(
  templates: ComboTemplate[],
  deckCards: CardInfo[],
): TemplateMatch[] {
  const matches: TemplateMatch[] = [];

  // Build a normalised name set for fast anchor lookups
  const deckNameSet = new Set(deckCards.map((c) => normalizeName(c.name)));

  // Separate the x-sink template so we can evaluate it last
  const regularTemplates: ComboTemplate[] = [];
  const deferredTemplates: ComboTemplate[] = [];

  for (const t of templates) {
    if (t.id === 'infinite-mana-x-sink') {
      deferredTemplates.push(t);
    } else {
      regularTemplates.push(t);
    }
  }

  // Evaluate regular templates first
  for (const template of regularTemplates) {
    const match = evaluateTemplate(template, deckCards, deckNameSet);
    if (match) matches.push(match);
  }

  // Evaluate deferred templates (x-sink) — only if infinite-mana is already
  // present in found matches
  const foundTags = new Set(matches.flatMap((m) => m.resultTags));

  for (const template of deferredTemplates) {
    if (!foundTags.has('infinite-mana')) continue;

    const match = evaluateXSinkTemplate(template, deckCards);
    if (match) matches.push(match);
  }

  return matches;
}

/**
 * Evaluate a single (non-deferred) template against the deck.
 */
function evaluateTemplate(
  template: ComboTemplate,
  deckCards: CardInfo[],
  deckNameSet: Set<string>,
): TemplateMatch | null {
  // 1. Check all anchor cards are present
  const matchedAnchors: string[] = [];
  for (const anchor of template.anchorCards) {
    if (!deckNameSet.has(normalizeName(anchor))) return null;
    matchedAnchors.push(anchor);
  }

  // 2. Fill every slot
  const slotFills: Array<{ slot: string; cardName: string }> = [];
  const usedCards = new Set(matchedAnchors.map(normalizeName));

  for (const slot of template.slots) {
    let filled = false;

    // For isochron-dramatic's mana-producer slot, we need >= 3 matching cards
    const minCount = template.id === 'isochron-dramatic' && slot.slot === 'mana-producer' ? 3 : 1;
    const matchedForSlot: string[] = [];

    for (const card of deckCards) {
      if (usedCards.has(normalizeName(card.name))) continue;
      if (cardMatchesSlot(card, slot)) {
        matchedForSlot.push(card.name);
        if (matchedForSlot.length >= minCount) break;
      }
    }

    if (matchedForSlot.length >= minCount) {
      for (const cardName of matchedForSlot) {
        slotFills.push({ slot: slot.slot, cardName });
        usedCards.add(normalizeName(cardName));
      }
      filled = true;
    }

    if (!filled) return null;
  }

  const allCards = [
    ...matchedAnchors,
    ...slotFills.map((sf) => sf.cardName),
  ];

  return {
    templateId: template.id,
    templateName: template.name,
    description: template.description,
    anchorCards: matchedAnchors,
    slotFills,
    resultTags: [...template.resultTags],
    allCards,
  };
}

/**
 * Evaluate the special "infinite-mana-x-sink" template.
 * This template has no anchors; it just requires an X-cost payoff card.
 */
function evaluateXSinkTemplate(
  template: ComboTemplate,
  deckCards: CardInfo[],
): TemplateMatch | null {
  const slotFills: Array<{ slot: string; cardName: string }> = [];

  for (const slot of template.slots) {
    let filled = false;
    for (const card of deckCards) {
      // X-sink must have {X} in mana cost
      if (!(card.mana_cost ?? '').includes('{X}')) continue;
      if (cardMatchesSlot(card, slot)) {
        slotFills.push({ slot: slot.slot, cardName: card.name });
        filled = true;
        break;
      }
    }
    if (!filled) return null;
  }

  return {
    templateId: template.id,
    templateName: template.name,
    description: template.description,
    anchorCards: [],
    slotFills,
    resultTags: [...template.resultTags],
    allCards: slotFills.map((sf) => sf.cardName),
  };
}

// ─── Database Persistence ───────────────────────────────────────────

/**
 * Seed the `combo_templates` table with all builtin templates.
 * Uses INSERT OR REPLACE so this is idempotent.
 *
 * @param db - D1 database binding
 * @returns Number of templates seeded
 */
export async function seedTemplates(db: D1): Promise<number> {
  const templates = getBuiltinTemplates();
  const now = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO combo_templates
       (id, name, description, anchor_cards_json, slot_requirements_json, result_tags_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const batch = templates.map((t) =>
    stmt.bind(
      t.id,
      t.name,
      t.description,
      JSON.stringify(t.anchorCards),
      JSON.stringify(t.slots),
      JSON.stringify(t.resultTags),
      now,
    ),
  );

  try {
    await db.batch(batch);
  } catch (err) {
    console.error('[combo-templates] Failed to seed templates:', err);
    throw err;
  }

  return templates.length;
}

/**
 * Load combo templates from the D1 database.
 * Falls back to builtin templates if the table doesn't exist or is empty.
 *
 * @param db - D1 database binding
 * @returns Array of combo templates
 */
export async function loadTemplates(db: D1): Promise<ComboTemplate[]> {
  try {
    const result = await db
      .prepare('SELECT id, name, description, anchor_cards_json, slot_requirements_json, result_tags_json FROM combo_templates')
      .all();

    if (!result?.results?.length) {
      console.warn('[combo-templates] No templates in DB, using builtins');
      return getBuiltinTemplates();
    }

    return result.results.map((row: any): ComboTemplate => ({
      id: row.id,
      name: row.name,
      description: row.description,
      anchorCards: JSON.parse(row.anchor_cards_json),
      slots: JSON.parse(row.slot_requirements_json),
      resultTags: JSON.parse(row.result_tags_json),
    }));
  } catch (err) {
    console.warn('[combo-templates] Failed to load from DB, using builtins:', err);
    return getBuiltinTemplates();
  }
}
