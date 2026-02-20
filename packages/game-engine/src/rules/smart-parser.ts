/**
 * Smart Parser — Clause-based NLP Oracle Text Interpreter.
 *
 * Tier 2.5 fallback in effect resolution pipeline.
 * Runs AFTER the ~375 regex patterns fail AND after the 7-pattern fallback fails,
 * but BEFORE manual resolution.
 *
 * Pipeline: Oracle Text -> stripReminderText -> splitIntoClauses -> parseClause -> executeClause -> chain state
 */

import type { GameState, GameLogEntry } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { Card, Color } from '../types/card.ts';
import type { Target } from '../types/action.ts';
import type { Permanent } from '../types/permanent.ts';
import { cardToPermanent } from '../types/permanent.ts';

// ─── Types ───

type ActionVerb =
  | 'draw' | 'deal' | 'destroy' | 'exile' | 'gain' | 'lose'
  | 'create' | 'return' | 'sacrifice' | 'search' | 'mill' | 'scry'
  | 'put' | 'tap' | 'untap' | 'add' | 'discard' | 'shuffle'
  | 'fight' | 'bounce' | 'counter' | 'proliferate' | 'surveil'
  | 'explore' | 'populate' | 'investigate' | 'connive' | 'amass'
  | 'goad' | 'transform' | 'bolster' | 'adapt' | 'reveal';

interface ParsedClause {
  verb: ActionVerb;
  quantity: number;
  targetScope: 'target' | 'each' | 'all' | 'self' | 'controller' | 'opponent' | 'each-opponent' | 'each-player' | 'its-controller';
  targetFilter: string;
  targetZone?: string;
  modifiers: string[];
  raw: string;
}

interface TokenSpec {
  quantity: number;
  power: number;
  toughness: number;
  name: string;
  typeLine: string;
  colors: string[];
  keywords: string[];
}

interface EffectResult {
  state: GameState;
  resolved: boolean;
  description?: string;
}

/**
 * Context passed between clauses for pronoun resolution.
 * When a clause affects a target permanent (e.g., "Destroy target creature"),
 * the context stores its controller so that subsequent clauses like
 * "Its controller loses 2 life" can resolve the pronoun "its controller".
 */
interface ClauseContext {
  /** Controller of the last affected permanent (for "its controller" resolution) */
  lastTargetController?: number;
  /** ID of the last affected permanent (for "it" resolution) */
  lastTargetPermanentId?: string;
  /** Name of the last affected permanent (for logging) */
  lastTargetName?: string;
}

// ─── ID Generation ───

let _smartId = 90000;
function generateSmartId(): string {
  return `smart-${_smartId++}`;
}

// ─── Immutable State Helpers ───

function parseNumber(s: string): number {
  const map: Record<string, number> = {
    'a': 1, 'an': 1, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
    'twenty': 20,
  };
  const lower = s.toLowerCase().trim();
  if (lower in map) return map[lower];
  const n = parseInt(lower, 10);
  return Number.isFinite(n) ? n : 1;
}

/** Normalize a filter string for typeLine matching: strip "permanents/cards/spells", de-pluralize */
function normalizeFilter(f: string): string {
  let s = f.toLowerCase().trim();
  // Remove generic suffixes that don't appear in typeLines
  s = s.replace(/\b(?:permanents?|cards?|spells?|tokens?)\b/g, '').trim();
  // De-pluralize common types: "creatures" → "creature", "artifacts" → "artifact", etc.
  s = s.replace(/\b(creature|artifact|enchantment|land|planeswalker|instant|sorcerie)s\b/g, '$1');
  s = s.replace(/\bsorceries\b/g, 'sorcery');
  // Clean up multiple spaces
  s = s.replace(/\s+/g, ' ').trim();
  return s || 'creature'; // Default to creature if nothing left
}

function addLogEntry(state: GameState, player: number, message: string): GameState {
  const entry: GameLogEntry = {
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase,
    step: state.step,
    player,
    message,
    actionType: 'effect',
  };
  return {
    ...state,
    log: [...state.log, entry],
  };
}

function gainLife(state: GameState, playerIdx: number, amount: number): GameState {
  const player = state.players[playerIdx];
  const updatedPlayer = { ...player, life: player.life + amount };
  const players = [...state.players];
  players[playerIdx] = updatedPlayer;
  return { ...state, players };
}

function loseLife(state: GameState, playerIdx: number, amount: number): GameState {
  const player = state.players[playerIdx];
  const updatedPlayer = { ...player, life: player.life - amount };
  const players = [...state.players];
  players[playerIdx] = updatedPlayer;
  return { ...state, players };
}

function drawCards(state: GameState, player: number, count: number): GameState {
  let currentState = state;
  for (let i = 0; i < count; i++) {
    const p = currentState.players[player];
    if (p.library.length === 0) break;
    const drawn = p.library[0];
    const updatedPlayer: PlayerState = {
      ...p,
      library: p.library.slice(1),
      hand: [...p.hand, drawn],
    };
    const players = [...currentState.players];
    players[player] = updatedPlayer;
    currentState = { ...currentState, players };
  }
  return currentState;
}

function millCards(state: GameState, player: number, count: number): GameState {
  const p = state.players[player];
  const toMill = Math.min(count, p.library.length);
  const milled = p.library.slice(0, toMill);
  const updatedPlayer: PlayerState = {
    ...p,
    library: p.library.slice(toMill),
    graveyard: [...p.graveyard, ...milled],
  };
  const players = [...state.players];
  players[player] = updatedPlayer;
  return { ...state, players };
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function shuffleLibrary(state: GameState, player: number): GameState {
  const p = state.players[player];
  const updatedPlayer: PlayerState = {
    ...p,
    library: shuffleArray(p.library),
  };
  const players = [...state.players];
  players[player] = updatedPlayer;
  return { ...state, players };
}

function findPermanentById(
  state: GameState,
  id: string,
): { perm: Permanent; playerIdx: number; permIdx: number } | null {
  for (let pi = 0; pi < 2; pi++) {
    const player = state.players[pi];
    const idx = player.battlefield.findIndex(p => p.id === id);
    if (idx !== -1) return { perm: player.battlefield[idx], playerIdx: pi, permIdx: idx };
  }
  return null;
}

function removePermanent(
  state: GameState,
  permanentId: string,
  toZone: 'graveyard' | 'exile',
): GameState {
  const found = findPermanentById(state, permanentId);
  if (!found) return state;

  const { playerIdx, perm } = found;
  const owner = perm.owner;
  const player = state.players[playerIdx];
  const currentIdx = player.battlefield.findIndex(p => p.id === permanentId);
  if (currentIdx === -1) return state;

  const updatedBf = [...player.battlefield];
  updatedBf.splice(currentIdx, 1);

  const cardObj: Card = {
    id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
    cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
    power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
    colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
    tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
  };

  const players = [...state.players];
  // Remove from battlefield of the controller
  players[playerIdx] = { ...player, battlefield: updatedBf };

  // Add to the zone of the owner (not necessarily the controller)
  const ownerState = playerIdx === owner ? players[owner] : { ...state.players[owner] };
  if (toZone === 'graveyard') {
    players[owner] = { ...ownerState, graveyard: [...ownerState.graveyard, cardObj] };
  } else {
    players[owner] = { ...ownerState, exile: [...ownerState.exile, cardObj] };
  }

  return { ...state, players };
}

function opponent(p: number): number {
  return p === 0 ? 1 : 0;
}

// ─── Text Processing ───

function stripReminderText(text: string): string {
  return text.replace(/\([^)]*\)/g, '').trim();
}

/**
 * Check if a string fragment starts with an action verb (used for " and " splitting).
 * Only split on " and " when the right side starts with a verb, to avoid splitting
 * noun phrases like "artifacts and enchantments".
 */
function startsWithActionVerb(text: string): boolean {
  const actionPrefixes = [
    'destroy', 'exile', 'draw', 'discard', 'deal', 'gain', 'lose',
    'create', 'put', 'return', 'search', 'reveal', 'shuffle', 'tap',
    'untap', 'counter', 'sacrifice', 'each', 'all', 'scry',
    'mill', 'fight', 'add', 'remove', 'prevent', 'choose', 'look',
    'it gains', 'it gets', 'that creature', 'that player', 'its controller',
    'its owner', 'you gain', 'you draw', 'you lose', 'you may',
    'target player', 'target opponent', 'target creature',
  ];
  const lower = text.toLowerCase().trim();
  return actionPrefixes.some(v => lower.startsWith(v));
}

/**
 * Smart Parser V2: Split compound oracle text into individual clauses.
 *
 * Handles compound clauses that the original splitter missed:
 * - "Draw 2 cards, then discard a card" -> ["Draw 2 cards", "discard a card"]
 * - "Destroy target creature. Its controller loses 2 life." -> ["Destroy target creature", "Its controller loses 2 life"]
 * - "Exile target creature and create a 1/1 token" -> ["Exile target creature", "create a 1/1 token"]
 * - "Untap it. It gains haste until end of turn" -> ["Untap it", "It gains haste until end of turn"]
 */
function splitIntoClauses(text: string): string[] {
  // Normalize newlines to periods for multi-line oracle text
  let normalized = text.replace(/\n/g, '. ');

  // Phase 1: Split on sentence boundaries — ". " followed by capital letter
  // Handles: "Destroy target creature. Its controller loses 2 life."
  const sentences = normalized.split(/(?<=[a-z])\.\s+(?=[A-Z])/);

  let allClauses: string[] = [];

  for (const sentence of sentences) {
    // Phase 2: Split on "; " (semicolons always separate independent clauses)
    const semiParts = sentence.split(/;\s+/);

    for (const semiPart of semiParts) {
      // Phase 3: Split on ", then " (sequential effects)
      // Handles: "Draw 2 cards, then discard a card"
      const thenParts = semiPart.split(/,\s*then\s+/i);
      if (thenParts.length > 1) {
        allClauses.push(...thenParts);
        continue;
      }

      // Phase 4: Split on " and " ONLY when both sides are action clauses
      // Handles: "Exile target creature and create a 1/1 token"
      // Does NOT split: "destroy target artifact or enchantment" (noun conjunction)
      const andParts = semiPart.split(/\s+and\s+/i);
      if (andParts.length === 2 && startsWithActionVerb(andParts[1].trim())) {
        allClauses.push(...andParts);
        continue;
      }

      // Phase 5: Split on ". " without requiring case change (catch-all for remaining periods)
      const periodParts = semiPart.split(/\.\s+/);
      allClauses.push(...periodParts);
    }
  }

  // Clean and filter clauses
  const cleaned = allClauses
    .map(c => c.trim().replace(/\.$/, '').trim())
    .filter(c => c.length > 0);

  return cleaned.filter(clause => {
    const lower = clause.toLowerCase();

    // Filter out trigger/condition lines
    if (/^when(ever)?\b/i.test(lower)) return false;
    if (/^at the beginning\b/i.test(lower)) return false;
    if (/^as long as\b/i.test(lower)) return false;
    if (/^as ~? ?enters\b/i.test(lower)) return false;
    if (/^if you do\b/i.test(lower)) return false;
    if (/^if you don'?t\b/i.test(lower)) return false;
    if (/^at the end\b/i.test(lower)) return false;

    // Filter out activated ability cost lines (contain ": ")
    if (/^[^"]*:\s/.test(clause) && /^\{/.test(clause.trim())) return false;

    // Filter out keyword-only lines (e.g., "Flying", "Haste, trample, vigilance")
    const keywords = [
      'flying', 'first strike', 'double strike', 'deathtouch', 'trample',
      'lifelink', 'vigilance', 'reach', 'haste', 'hexproof', 'indestructible',
      'menace', 'flash', 'defender', 'ward', 'shroud', 'fear', 'intimidate',
      'prowess', 'afflict', 'wither', 'infect', 'persist', 'undying',
      'cascade', 'convoke', 'delve', 'flashback', 'retrace', 'storm',
    ];
    const parts = lower.split(/,\s*/);
    const allKeywords = parts.every(part => {
      const trimmed = part.trim();
      return keywords.some(kw => trimmed === kw || trimmed.startsWith(kw + ' '));
    });
    if (allKeywords && parts.length >= 1 && parts[0].trim().length > 0) {
      // Verify it really is just keywords (no verbs or complex text)
      if (!/\b(draw|destroy|exile|gain|lose|create|deal|return|sacrifice|search|mill|scry|put|tap|untap|discard|shuffle|fight)\b/i.test(lower)) {
        return false;
      }
    }

    return true;
  });
}

// ─── Clause Parsing ───

/** Ordered verb detection patterns (first match wins) */
const VERB_PATTERNS: [RegExp, ActionVerb][] = [
  // Bounce must come before return (it is a specific return pattern)
  [/\breturn\b.*\bto\s+(?:its|their)\s+owner'?s?\s+hands?\b/i, 'bounce'],
  [/\bdraws?\b|\bdrew\b/i, 'draw'],
  [/\bdeals?\s+\d+\s+damage\b/i, 'deal'],
  [/\bdestroys?\b/i, 'destroy'],
  [/\bexiles?\b/i, 'exile'],
  [/\bgains?\s+\d+\s+life\b/i, 'gain'],
  [/\bloses?\s+\d+\s+life\b/i, 'lose'],
  [/\bcreates?\b/i, 'create'],
  [/\breturns?\b/i, 'return'],
  [/\bsacrifices?\b/i, 'sacrifice'],
  [/\bsearchh?e?s?\s+(?:your|their|a|his|her)\s+library\b/i, 'search'],
  [/\bmills?\b/i, 'mill'],
  [/\bscry\b/i, 'scry'],
  [/\bputs?\b.*\bcounters?\s+on\b/i, 'put'],
  [/\buntaps?\b/i, 'untap'],
  [/\btaps?\b/i, 'tap'],
  [/\badd\b.*\bmana\b/i, 'add'],
  [/\badd\s+\{/i, 'add'],
  [/\bdiscards?\b/i, 'discard'],
  [/\bshuffles?\b/i, 'shuffle'],
  [/\bfights?\b/i, 'fight'],
  [/\bproliferate\b/i, 'proliferate'],
  [/\bsurveils?\b/i, 'surveil'],
  [/\bexplores?\b/i, 'explore'],
  [/\bpopulate\b/i, 'populate'],
  [/\binvestigate\b/i, 'investigate'],
  [/\bconnives?\b/i, 'connive'],
  [/\bamass\b/i, 'amass'],
  [/\bgoads?\b/i, 'goad'],
  [/\btransforms?\b/i, 'transform'],
  [/\bbolsters?\b/i, 'bolster'],
  [/\badapts?\b/i, 'adapt'],
  [/\breveals?\b/i, 'reveal'],
];

function parseClause(clause: string): ParsedClause | null {
  const lower = clause.toLowerCase();

  // Detect verb
  let verb: ActionVerb | null = null;
  for (const [pattern, v] of VERB_PATTERNS) {
    if (pattern.test(lower)) {
      verb = v;
      break;
    }
  }
  if (!verb) return null;

  // Extract quantity
  let quantity = 1;

  // Try quantity next to common verbs
  const qtyPatterns = [
    /\bdraws?\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+cards?\b/i,
    /\bdeals?\s+(\d+)\s+damage\b/i,
    /\bgains?\s+(\d+)\s+life\b/i,
    /\bloses?\s+(\d+)\s+life\b/i,
    /\bmills?\s+(\d+)\b/i,
    /\bscry\s+(\d+)\b/i,
    /\bsurveils?\s+(\d+)\b/i,
    /\bbolsters?\s+(\d+)\b/i,
    /\badapts?\s+(\d+)\b/i,
    /\bamass\s+(\d+)\b/i,
    /\bconnives?\s+(\d+)\b/i,
    /\bputs?\s+(\d+|a|an|one|two|three|four|five)\s+[+\-]?\d*\/?\+?\d*\s*counters?\b/i,
    /\bdiscards?\s+(\d+|a|an|one|two|three)\s+cards?\b/i,
    /\bcreates?\s+(\d+|a|an|one|two|three|four|five)\b/i,
  ];
  for (const qp of qtyPatterns) {
    const qm = clause.match(qp);
    if (qm) {
      quantity = parseNumber(qm[1]);
      break;
    }
  }

  // Extract target scope and filter
  let targetScope: ParsedClause['targetScope'] = 'controller';
  let targetFilter = '';

  if (/\btarget\s+([\w\s]+?)(?:\.|,|;|$)/i.test(clause)) {
    targetScope = 'target';
    const m = clause.match(/\btarget\s+([\w\s]+?)(?:\.|,|;|$)/i);
    if (m) targetFilter = m[1].trim().toLowerCase();
  } else if (/\beach\s+opponent\b/i.test(lower)) {
    targetScope = 'each-opponent';
  } else if (/\beach\s+player\b/i.test(lower)) {
    targetScope = 'each-player';
  } else if (/\ball\s+([\w\s]+)/i.test(lower)) {
    targetScope = 'all';
    const m = lower.match(/\ball\s+([\w\s]+?)(?:\.|,|;|$)/i);
    if (m) targetFilter = m[1].trim();
  } else if (/\bcreatures?\s+you\s+control\b/i.test(lower)) {
    targetScope = 'controller';
    targetFilter = 'creature';
  } else if (/\bcreatures?\s+(?:an\s+)?opponents?\s+controls?\b/i.test(lower)) {
    targetScope = 'opponent';
    targetFilter = 'creature';
  } else if (/\bits\s+controller\b/i.test(lower)) {
    targetScope = 'its-controller';
  } else if (/\btarget\s+opponent\b/i.test(lower)) {
    targetScope = 'opponent';
  } else if (/\btarget\s+player\b/i.test(lower)) {
    targetScope = 'target';
    targetFilter = 'player';
  } else if (/\byou\b/i.test(lower) || /\byour\b/i.test(lower)) {
    targetScope = 'controller';
  }

  // Extract target zone
  let targetZone: string | undefined;
  if (/\bfrom\s+(?:a|the|your|their)?\s*graveyard\b/i.test(lower)) {
    targetZone = 'graveyard';
  } else if (/\bfrom\s+exile\b/i.test(lower)) {
    targetZone = 'exile';
  } else if (/\bto\s+(?:your|the|their)\s+hand\b/i.test(lower)) {
    targetZone = 'hand';
  } else if (/\bon\s+top\s+of\s+(?:your|their)\s+library\b/i.test(lower)) {
    targetZone = 'library';
  }

  // Extract modifiers
  const modifiers: string[] = [];
  if (/\buntil\s+end\s+of\s+turn\b/i.test(lower)) modifiers.push('until end of turn');
  if (/\btapped\b/i.test(lower) && verb === 'create') modifiers.push('tapped');
  if (/\bwith\s+haste\b/i.test(lower)) modifiers.push('haste');
  if (/\bat\s+random\b/i.test(lower)) modifiers.push('at random');
  if (/\bface\s*down\b/i.test(lower)) modifiers.push('face down');

  return {
    verb,
    quantity,
    targetScope,
    targetFilter,
    targetZone,
    modifiers,
    raw: clause,
  };
}

// ─── Token Parsing ───

const COLOR_MAP: Record<string, string> = {
  'white': 'W', 'blue': 'U', 'black': 'B', 'red': 'R', 'green': 'G',
  'colorless': 'C',
};

interface PredefinedToken {
  name: string;
  typeLine: string;
  power: number;
  toughness: number;
  colors: string[];
  keywords: string[];
  oracleText: string;
}

const PREDEFINED_TOKENS: Record<string, PredefinedToken> = {
  'treasure': {
    name: 'Treasure',
    typeLine: 'Token Artifact — Treasure',
    power: 0, toughness: 0,
    colors: [], keywords: [],
    oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.',
  },
  'food': {
    name: 'Food',
    typeLine: 'Token Artifact — Food',
    power: 0, toughness: 0,
    colors: [], keywords: [],
    oracleText: '{2}, {T}, Sacrifice this artifact: You gain 3 life.',
  },
  'clue': {
    name: 'Clue',
    typeLine: 'Token Artifact — Clue',
    power: 0, toughness: 0,
    colors: [], keywords: [],
    oracleText: '{2}, Sacrifice this artifact: Draw a card.',
  },
  'blood': {
    name: 'Blood',
    typeLine: 'Token Artifact — Blood',
    power: 0, toughness: 0,
    colors: [], keywords: [],
    oracleText: '{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card.',
  },
  'map': {
    name: 'Map',
    typeLine: 'Token Artifact — Map',
    power: 0, toughness: 0,
    colors: [], keywords: [],
    oracleText: '{1}, {T}, Sacrifice this artifact: Target creature you control explores.',
  },
  'powerstone': {
    name: 'Powerstone',
    typeLine: 'Token Artifact — Powerstone',
    power: 0, toughness: 0,
    colors: [], keywords: [],
    oracleText: '{T}: Add {C}. This mana can\'t be spent to cast a nonartifact spell.',
  },
};

function parseTokenSpec(text: string): TokenSpec | null {
  const lower = text.toLowerCase();

  // Check predefined artifact tokens first
  for (const [key, def] of Object.entries(PREDEFINED_TOKENS)) {
    const pat = new RegExp(`\\b${key}\\s+tokens?\\b`, 'i');
    if (pat.test(lower)) {
      // Extract quantity
      const qMatch = text.match(/creates?\s+(\d+|a|an|one|two|three|four|five)\s+/i);
      const qty = qMatch ? parseNumber(qMatch[1]) : 1;
      return {
        quantity: qty,
        power: def.power,
        toughness: def.toughness,
        name: def.name,
        typeLine: def.typeLine,
        colors: [...def.colors],
        keywords: [...def.keywords],
      };
    }
  }

  // General creature token pattern:
  // "create (qty) (P/T) (colors) (type) creature token(s) (with keywords)"
  const creatureTokenPattern =
    /creates?\s+(?:(\d+|a|an|one|two|three|four|five)\s+)?(?:(\d+)\/(\d+)\s+)?(.+?)\s*(?:creature\s+)?tokens?(?:\s+with\s+(.+))?$/i;
  const ctm = text.match(creatureTokenPattern);
  if (!ctm) return null;

  const qty = ctm[1] ? parseNumber(ctm[1]) : 1;
  const power = ctm[2] ? parseInt(ctm[2], 10) : 1;
  const toughness = ctm[3] ? parseInt(ctm[3], 10) : 1;
  const descriptor = ctm[4]?.trim().toLowerCase() || '';
  const keywordStr = ctm[5]?.trim().toLowerCase() || '';

  // Parse colors from descriptor
  const colors: string[] = [];
  for (const [colorName, colorCode] of Object.entries(COLOR_MAP)) {
    if (descriptor.includes(colorName)) {
      colors.push(colorCode);
    }
  }

  // Extract type name: remove color words, clean up
  let typeName = descriptor;
  for (const colorName of Object.keys(COLOR_MAP)) {
    typeName = typeName.replace(new RegExp(`\\b${colorName}\\b`, 'gi'), '').trim();
  }
  typeName = typeName.replace(/\band\b/g, '').replace(/\s+/g, ' ').trim();

  // Capitalize type name
  const capitalizedName = typeName
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  // Parse keywords
  const keywords: string[] = [];
  if (keywordStr) {
    keywords.push(
      ...keywordStr
        .split(/,\s*|\s+and\s+/)
        .map(k => k.trim())
        .filter(k => k.length > 0),
    );
  }

  return {
    quantity: qty,
    power,
    toughness,
    name: capitalizedName || 'Token',
    typeLine: `Token Creature — ${capitalizedName || 'Token'}`,
    colors,
    keywords,
  };
}

// ─── Dynamic Quantity Resolution ───

function resolveDynamicQuantity(
  text: string,
  state: GameState,
  controller: number,
): number {
  const lower = text.toLowerCase();

  // "equal to the number of creatures you control"
  if (/equal to the number of creatures you control/i.test(lower)) {
    return state.players[controller].battlefield.filter(
      p => p.typeLine.toLowerCase().includes('creature'),
    ).length;
  }

  // "equal to the number of cards in your graveyard"
  if (/equal to the number of cards in your graveyard/i.test(lower)) {
    return state.players[controller].graveyard.length;
  }

  // "equal to your life total"
  if (/equal to your life total/i.test(lower)) {
    return state.players[controller].life;
  }

  // "equal to the number of artifacts you control"
  if (/equal to the number of artifacts you control/i.test(lower)) {
    return state.players[controller].battlefield.filter(
      p => p.typeLine.toLowerCase().includes('artifact'),
    ).length;
  }

  // "equal to the number of lands you control"
  if (/equal to the number of lands you control/i.test(lower)) {
    return state.players[controller].battlefield.filter(
      p => p.typeLine.toLowerCase().includes('land'),
    ).length;
  }

  // "equal to the number of enchantments you control"
  if (/equal to the number of enchantments you control/i.test(lower)) {
    return state.players[controller].battlefield.filter(
      p => p.typeLine.toLowerCase().includes('enchantment'),
    ).length;
  }

  // Fallback: try to find a plain number
  const numMatch = lower.match(/(\d+)/);
  if (numMatch) return parseInt(numMatch[1], 10);

  return 1;
}

// ─── Clause Execution ───

/**
 * Resolve a clause that references "its controller" using the context from a prior clause.
 * Returns null if context is insufficient or the clause doesn't reference a pronoun.
 */
function resolveItsControllerClause(
  clause: ParsedClause,
  state: GameState,
  ctx: ClauseContext,
  source?: Card,
): EffectResult | null {
  if (clause.targetScope !== 'its-controller') return null;
  if (ctx.lastTargetController === undefined) return null;

  const resolvedPlayer = ctx.lastTargetController;

  // "its controller loses N life"
  if (clause.verb === 'lose') {
    const s = loseLife(state, resolvedPlayer, clause.quantity);
    return { state: s, resolved: true, description: `${s.players[resolvedPlayer].name} loses ${clause.quantity} life` };
  }
  // "its controller draws a card"
  if (clause.verb === 'draw') {
    const s = drawCards(state, resolvedPlayer, clause.quantity);
    return { state: s, resolved: true, description: `${s.players[resolvedPlayer].name} draws ${clause.quantity} card(s)` };
  }
  // "its controller gains N life"
  if (clause.verb === 'gain') {
    const s = gainLife(state, resolvedPlayer, clause.quantity);
    return { state: s, resolved: true, description: `${s.players[resolvedPlayer].name} gains ${clause.quantity} life` };
  }
  // "its controller discards a card"
  if (clause.verb === 'discard') {
    return {
      state: { ...state, pendingDiscard: resolvedPlayer, pendingDiscardCount: clause.quantity },
      resolved: true,
      description: `${state.players[resolvedPlayer].name} must discard ${clause.quantity} card(s)`,
    };
  }
  // "its controller sacrifices a creature"
  if (clause.verb === 'sacrifice') {
    const filter = clause.targetFilter || 'permanent';
    return {
      state: {
        ...state,
        pendingSacrifice: { player: resolvedPlayer, filter, count: clause.quantity, sourceName: source?.name },
      },
      resolved: true,
      description: `${state.players[resolvedPlayer].name} must sacrifice ${clause.quantity} ${filter}(s)`,
    };
  }

  return null;
}

function executeClause(
  clause: ParsedClause,
  state: GameState,
  controller: number,
  targets: Target[],
  source?: Card,
): EffectResult {
  const opp = opponent(controller);
  const controllerName = state.players[controller].name;
  const opponentName = state.players[opp].name;

  switch (clause.verb) {
    // ── Draw ──
    case 'draw': {
      const qty = clause.quantity;
      let s = state;
      const descriptions: string[] = [];

      if (clause.targetScope === 'each-player') {
        s = drawCards(s, 0, qty);
        s = drawCards(s, 1, qty);
        descriptions.push(`Each player draws ${qty} card(s)`);
      } else if (clause.targetScope === 'each-opponent') {
        s = drawCards(s, opp, qty);
        descriptions.push(`${opponentName} draws ${qty} card(s)`);
      } else if (clause.targetScope === 'target' && clause.targetFilter === 'player') {
        const targetPlayer = targets.find(t => t.type === 'player');
        const tp = targetPlayer ? (parseInt(targetPlayer.id)) : controller;
        s = drawCards(s, tp, qty);
        descriptions.push(`Target player draws ${qty} card(s)`);
      } else {
        s = drawCards(s, controller, qty);
        descriptions.push(`${controllerName} draws ${qty} card(s)`);
      }

      return { state: s, resolved: true, description: descriptions.join('; ') };
    }

    // ── Deal Damage ──
    case 'deal': {
      const dmgMatch = clause.raw.match(/deals?\s+(\d+)\s+damage/i);
      const amount = dmgMatch ? parseInt(dmgMatch[1], 10) : clause.quantity;
      let s = state;

      if (clause.targetScope === 'each-opponent') {
        s = loseLife(s, opp, amount);
        return { state: s, resolved: true, description: `Deals ${amount} damage to ${opponentName}` };
      }
      if (clause.targetScope === 'each-player') {
        s = loseLife(s, 0, amount);
        s = loseLife(s, 1, amount);
        return { state: s, resolved: true, description: `Deals ${amount} damage to each player` };
      }

      // Try targeting a permanent first
      const permTarget = targets.find(t => t.type === 'permanent');
      if (permTarget) {
        const found = findPermanentById(s, permTarget.id);
        if (found) {
          const { playerIdx, permIdx, perm } = found;
          const updatedPerm = { ...perm, damage: perm.damage + amount };
          const player = s.players[playerIdx];
          const updatedBf = [...player.battlefield];
          updatedBf[permIdx] = updatedPerm;
          const updatedPlayer = { ...player, battlefield: updatedBf };
          const players = [...s.players];
          players[playerIdx] = updatedPlayer;
          s = { ...s, players };
          return { state: s, resolved: true, description: `Deals ${amount} damage to ${perm.name}` };
        }
      }

      // Try targeting a player
      const playerTarget = targets.find(t => t.type === 'player');
      if (playerTarget) {
        const tp = parseInt(playerTarget.id);
        s = loseLife(s, tp, amount);
        return { state: s, resolved: true, description: `Deals ${amount} damage to ${s.players[tp].name}` };
      }

      // Default: damage opponent
      if (clause.targetScope === 'target' || clause.targetScope === 'opponent') {
        s = loseLife(s, opp, amount);
        return { state: s, resolved: true, description: `Deals ${amount} damage to ${opponentName}` };
      }

      return { state, resolved: false };
    }

    // ── Destroy ──
    case 'destroy': {
      let s = state;

      // Mass destroy: "destroy all creatures"
      if (clause.targetScope === 'all') {
        const filter = normalizeFilter(clause.targetFilter || 'creature');
        const toRemove: string[] = [];
        for (let pi = 0; pi < 2; pi++) {
          for (const perm of s.players[pi].battlefield) {
            if (perm.typeLine.toLowerCase().includes(filter)) {
              toRemove.push(perm.id);
            }
          }
        }
        for (const id of toRemove) {
          s = removePermanent(s, id, 'graveyard');
        }
        return { state: s, resolved: true, description: `Destroys all ${filter}s` };
      }

      // Targeted destroy
      const permTarget = targets.find(t => t.type === 'permanent');
      if (permTarget) {
        const found = findPermanentById(s, permTarget.id);
        if (found) {
          const name = found.perm.name;
          s = removePermanent(s, permTarget.id, 'graveyard');
          return { state: s, resolved: true, description: `Destroys ${name}` };
        }
      }

      return { state, resolved: false };
    }

    // ── Exile ──
    case 'exile': {
      let s = state;

      // Mass exile: "exile all ..."
      if (clause.targetScope === 'all') {
        const filter = normalizeFilter(clause.targetFilter || 'creature');
        const toRemove: string[] = [];
        for (let pi = 0; pi < 2; pi++) {
          for (const perm of s.players[pi].battlefield) {
            if (perm.typeLine.toLowerCase().includes(filter)) {
              toRemove.push(perm.id);
            }
          }
        }
        for (const id of toRemove) {
          s = removePermanent(s, id, 'exile');
        }
        return { state: s, resolved: true, description: `Exiles all ${filter}s` };
      }

      // Targeted exile
      const permTarget = targets.find(t => t.type === 'permanent');
      if (permTarget) {
        const found = findPermanentById(s, permTarget.id);
        if (found) {
          const name = found.perm.name;
          s = removePermanent(s, permTarget.id, 'exile');
          return { state: s, resolved: true, description: `Exiles ${name}` };
        }
      }

      return { state, resolved: false };
    }

    // ── Gain Life ──
    case 'gain': {
      let s = state;
      // Check for dynamic quantity
      let qty = clause.quantity;
      if (/equal to/i.test(clause.raw)) {
        qty = resolveDynamicQuantity(clause.raw, state, controller);
      }

      if (clause.targetScope === 'each-player') {
        s = gainLife(s, 0, qty);
        s = gainLife(s, 1, qty);
        return { state: s, resolved: true, description: `Each player gains ${qty} life` };
      }

      s = gainLife(s, controller, qty);
      return { state: s, resolved: true, description: `${controllerName} gains ${qty} life` };
    }

    // ── Lose Life ──
    case 'lose': {
      let s = state;
      let qty = clause.quantity;
      if (/equal to/i.test(clause.raw)) {
        qty = resolveDynamicQuantity(clause.raw, state, controller);
      }

      if (clause.targetScope === 'each-opponent') {
        s = loseLife(s, opp, qty);
        return { state: s, resolved: true, description: `${opponentName} loses ${qty} life` };
      }
      if (clause.targetScope === 'each-player') {
        s = loseLife(s, 0, qty);
        s = loseLife(s, 1, qty);
        return { state: s, resolved: true, description: `Each player loses ${qty} life` };
      }

      // "you lose" vs "target player loses"
      if (clause.targetScope === 'target') {
        const playerTarget = targets.find(t => t.type === 'player');
        const tp = playerTarget ? (parseInt(playerTarget.id)) : opp;
        s = loseLife(s, tp, qty);
        return { state: s, resolved: true, description: `Target player loses ${qty} life` };
      }

      // Default: controller loses life (oracle text says "you lose")
      s = loseLife(s, controller, qty);
      return { state: s, resolved: true, description: `${controllerName} loses ${qty} life` };
    }

    // ── Create Token ──
    case 'create': {
      const tokenSpec = parseTokenSpec(clause.raw);
      if (!tokenSpec) return { state, resolved: false };

      let s = state;
      const isTapped = clause.modifiers.includes('tapped');

      // Check if this is a predefined artifact token
      const lowerRaw = clause.raw.toLowerCase();
      let predefined: PredefinedToken | null = null;
      for (const [key, def] of Object.entries(PREDEFINED_TOKENS)) {
        if (lowerRaw.includes(key)) {
          predefined = def;
          break;
        }
      }

      for (let i = 0; i < tokenSpec.quantity; i++) {
        const tokenId = generateSmartId();
        const tokenCard: Card = {
          id: tokenId,
          oracleId: `token-${tokenSpec.name.toLowerCase().replace(/\s+/g, '-')}`,
          name: tokenSpec.name,
          manaCost: '',
          cmc: 0,
          typeLine: predefined ? predefined.typeLine : tokenSpec.typeLine,
          oracleText: predefined ? predefined.oracleText : (tokenSpec.keywords.length > 0 ? tokenSpec.keywords.join(', ') : ''),
          power: tokenSpec.power > 0 ? String(tokenSpec.power) : undefined,
          toughness: tokenSpec.toughness > 0 ? String(tokenSpec.toughness) : undefined,
          colors: tokenSpec.colors as Color[],
          colorIdentity: tokenSpec.colors as Color[],
          rarity: 'common',
          tags: [],
          imageUrl: '',
          owner: controller,
        };

        const perm = cardToPermanent(tokenCard, controller, s.turn);
        const tappedPerm: Permanent = isTapped ? { ...perm, tapped: true } : perm;
        // Grant haste if modifier present
        const finalPerm: Permanent = clause.modifiers.includes('haste')
          ? { ...tappedPerm, summoningSick: false }
          : tappedPerm;

        const player = s.players[controller];
        const updatedPlayer: PlayerState = {
          ...player,
          battlefield: [...player.battlefield, finalPerm],
        };
        const players = [...s.players];
        players[controller] = updatedPlayer;
        s = { ...s, players };
      }

      return {
        state: s,
        resolved: true,
        description: `Creates ${tokenSpec.quantity} ${tokenSpec.name} token(s)`,
      };
    }

    // ── Return (from graveyard/exile to hand/battlefield) ──
    case 'return': {
      // This handles "return target card from your graveyard to your hand" etc.
      const cardTarget = targets.find(t => t.type === 'card-in-zone');
      if (cardTarget) {
        let s = state;
        const fromZone = clause.targetZone || cardTarget.zone || 'graveyard';
        const toZone = /to\s+(?:the\s+)?battlefield\b/i.test(clause.raw) ? 'battlefield' : 'hand';

        // Find the card
        for (let pi = 0; pi < 2; pi++) {
          const player = s.players[pi];
          const zoneCards = fromZone === 'graveyard' ? player.graveyard
            : fromZone === 'exile' ? player.exile
            : player.hand;
          const idx = zoneCards.findIndex(c => c.id === cardTarget.id);
          if (idx !== -1) {
            const card = zoneCards[idx];
            const updatedFrom = [...zoneCards];
            updatedFrom.splice(idx, 1);

            const updatedPlayer = { ...player } as PlayerState;
            if (fromZone === 'graveyard') updatedPlayer.graveyard = updatedFrom;
            else if (fromZone === 'exile') updatedPlayer.exile = updatedFrom;

            if (toZone === 'hand') {
              updatedPlayer.hand = [...player.hand, card];
            } else if (toZone === 'battlefield') {
              const perm = cardToPermanent(card, pi, s.turn);
              updatedPlayer.battlefield = [...player.battlefield, perm];
            }

            const players = [...s.players];
            players[pi] = updatedPlayer;
            s = { ...s, players };
            return { state: s, resolved: true, description: `Returns ${card.name} from ${fromZone} to ${toZone}` };
          }
        }
      }

      return { state, resolved: false };
    }

    // ── Sacrifice ──
    case 'sacrifice': {
      // Set up pending sacrifice for the appropriate player
      const sacPlayer = /\beach\s+(?:opponent|player)\b/i.test(clause.raw) ? opp : controller;
      const filter = clause.targetFilter || 'permanent';
      const count = clause.quantity;

      // If there is exactly one valid permanent to sacrifice, do it automatically
      const validPerms = state.players[sacPlayer].battlefield.filter(
        p => filter === 'permanent' || p.typeLine.toLowerCase().includes(filter),
      );

      if (validPerms.length === 1 && count === 1) {
        const s = removePermanent(state, validPerms[0].id, 'graveyard');
        return { state: s, resolved: true, description: `${state.players[sacPlayer].name} sacrifices ${validPerms[0].name}` };
      }

      // Otherwise set pending sacrifice
      return {
        state: {
          ...state,
          pendingSacrifice: {
            player: sacPlayer,
            filter,
            count,
            sourceName: source?.name,
          },
        },
        resolved: true,
        description: `${state.players[sacPlayer].name} must sacrifice ${count} ${filter}(s)`,
      };
    }

    // ── Search Library ──
    case 'search': {
      // Determine what to search for
      let filter = '';
      const searchMatch = clause.raw.match(/search\s+(?:your|their|a)\s+library\s+for\s+(?:a|an|up\s+to\s+\w+)?\s*(.+?)(?:\s+and\s+put|\s+card|\.|,|$)/i);
      if (searchMatch) {
        filter = searchMatch[1].trim().toLowerCase();
        // Map common filter strings
        if (filter.includes('basic land')) filter = 'basic land';
        else if (filter.includes('land')) filter = 'land';
        else if (filter.includes('creature')) filter = 'creature';
        else if (filter.includes('artifact')) filter = 'artifact';
        else if (filter.includes('enchantment')) filter = 'enchantment';
        else if (filter.includes('instant or sorcery')) filter = 'instant';
        else filter = ''; // any card
      }

      const destination: 'hand' | 'battlefield' | 'top-of-library' =
        /put\s+(?:it|that card|them)\s+(?:onto|on)\s+the\s+battlefield/i.test(clause.raw) ? 'battlefield'
        : /put\s+(?:it|that card|them)\s+on\s+top/i.test(clause.raw) ? 'top-of-library'
        : 'hand';

      return {
        state: {
          ...state,
          pendingSearch: {
            player: controller,
            filter,
            count: clause.quantity,
            destination,
            sourceName: source?.name,
          },
        },
        resolved: true,
        description: `${controllerName} searches library for ${filter || 'a card'}`,
      };
    }

    // ── Mill ──
    case 'mill': {
      let s = state;
      const qty = clause.quantity;

      if (clause.targetScope === 'each-opponent') {
        s = millCards(s, opp, qty);
        return { state: s, resolved: true, description: `${opponentName} mills ${qty} card(s)` };
      }
      if (clause.targetScope === 'each-player') {
        s = millCards(s, 0, qty);
        s = millCards(s, 1, qty);
        return { state: s, resolved: true, description: `Each player mills ${qty} card(s)` };
      }
      if (clause.targetScope === 'target') {
        const playerTarget = targets.find(t => t.type === 'player');
        const tp = playerTarget ? (parseInt(playerTarget.id)) : opp;
        s = millCards(s, tp, qty);
        return { state: s, resolved: true, description: `Target player mills ${qty} card(s)` };
      }

      // Default: controller mills (rare but possible)
      s = millCards(s, controller, qty);
      return { state: s, resolved: true, description: `${controllerName} mills ${qty} card(s)` };
    }

    // ── Scry ──
    case 'scry': {
      const scryCount = clause.quantity;
      const lib = state.players[controller].library;
      const topCards = lib.slice(0, Math.min(scryCount, lib.length));

      if (topCards.length === 0) {
        return { state, resolved: true, description: `Scry ${scryCount} (library empty)` };
      }

      return {
        state: {
          ...state,
          pendingScry: {
            player: controller,
            count: scryCount,
            cards: topCards.map(c => c.id),
          },
        },
        resolved: true,
        description: `${controllerName} scries ${scryCount}`,
      };
    }

    // ── Put Counters ──
    case 'put': {
      // Parse counter type and quantity: "put two +1/+1 counters on ..."
      const counterMatch = clause.raw.match(/puts?\s+(?:(\d+|a|an|one|two|three|four|five)\s+)?([+\-]?\d+\/[+\-]?\d+|[\w]+)\s+counters?\s+on/i);
      if (!counterMatch) return { state, resolved: false };

      const counterQty = counterMatch[1] ? parseNumber(counterMatch[1]) : clause.quantity;
      const counterType = counterMatch[2].trim();

      let s = state;

      // "on each creature you control"
      if (/on\s+each\s+creature\s+you\s+control/i.test(clause.raw)) {
        const player = s.players[controller];
        const updatedBf = player.battlefield.map(perm => {
          if (!perm.typeLine.toLowerCase().includes('creature')) return perm;
          const counters = { ...perm.counters };
          counters[counterType] = (counters[counterType] || 0) + counterQty;
          const updatedPerm: Permanent = { ...perm, counters };
          if (counterType === '+1/+1') {
            updatedPerm.currentPower = (updatedPerm.basePower || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0);
            updatedPerm.currentToughness = (updatedPerm.baseToughness || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0);
          }
          return updatedPerm;
        });
        const updatedPlayer = { ...player, battlefield: updatedBf };
        const players = [...s.players];
        players[controller] = updatedPlayer;
        s = { ...s, players };
        return { state: s, resolved: true, description: `Puts ${counterQty} ${counterType} counter(s) on each creature you control` };
      }

      // Targeted permanent
      const permTarget = targets.find(t => t.type === 'permanent');
      if (permTarget) {
        const found = findPermanentById(s, permTarget.id);
        if (found) {
          const { playerIdx, permIdx, perm } = found;
          const counters = { ...perm.counters };
          counters[counterType] = (counters[counterType] || 0) + counterQty;
          const updatedPerm: Permanent = { ...perm, counters };
          if (counterType === '+1/+1') {
            updatedPerm.currentPower = (updatedPerm.basePower || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0);
            updatedPerm.currentToughness = (updatedPerm.baseToughness || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0);
          }
          if (counterType === '-1/-1') {
            updatedPerm.currentPower = (updatedPerm.basePower || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0);
            updatedPerm.currentToughness = (updatedPerm.baseToughness || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0);
          }
          const player = s.players[playerIdx];
          const updatedBf = [...player.battlefield];
          updatedBf[permIdx] = updatedPerm;
          const updatedPlayer = { ...player, battlefield: updatedBf };
          const players = [...s.players];
          players[playerIdx] = updatedPlayer;
          s = { ...s, players };
          return { state: s, resolved: true, description: `Puts ${counterQty} ${counterType} counter(s) on ${perm.name}` };
        }
      }

      return { state, resolved: false };
    }

    // ── Tap / Untap ──
    case 'tap':
    case 'untap': {
      const isTapping = clause.verb === 'tap';
      const permTarget = targets.find(t => t.type === 'permanent');

      // "untap all creatures you control"
      if (clause.targetScope === 'all' || /\ball\b/i.test(clause.raw)) {
        let s = state;
        const filter = clause.targetFilter || 'permanent';
        for (let pi = 0; pi < 2; pi++) {
          const shouldAffect =
            (clause.targetScope === 'controller' || clause.targetScope === 'all') ? pi === controller
            : true;
          if (!shouldAffect && clause.targetScope !== 'all') continue;
          const player = s.players[pi];
          const updatedBf = player.battlefield.map(perm => {
            if (filter !== 'permanent' && !perm.typeLine.toLowerCase().includes(filter)) return perm;
            return { ...perm, tapped: isTapping };
          });
          const updatedPlayer = { ...player, battlefield: updatedBf };
          const players = [...s.players];
          players[pi] = updatedPlayer;
          s = { ...s, players };
        }
        return { state: s, resolved: true, description: `${isTapping ? 'Taps' : 'Untaps'} all ${filter}s` };
      }

      if (permTarget) {
        const found = findPermanentById(state, permTarget.id);
        if (found) {
          const { playerIdx, permIdx, perm } = found;
          const updatedPerm = { ...perm, tapped: isTapping };
          const player = state.players[playerIdx];
          const updatedBf = [...player.battlefield];
          updatedBf[permIdx] = updatedPerm;
          const updatedPlayer = { ...player, battlefield: updatedBf };
          const players = [...state.players];
          players[playerIdx] = updatedPlayer;
          return {
            state: { ...state, players },
            resolved: true,
            description: `${isTapping ? 'Taps' : 'Untaps'} ${perm.name}`,
          };
        }
      }

      return { state, resolved: false };
    }

    // ── Discard ──
    case 'discard': {
      const qty = clause.quantity;
      let discardPlayer = controller;

      if (clause.targetScope === 'each-opponent' || clause.targetScope === 'opponent') {
        discardPlayer = opp;
      } else if (clause.targetScope === 'each-player') {
        // Both players must discard — set pending for opponent, and auto-discard for controller
        return {
          state: {
            ...state,
            pendingDiscard: controller,
            pendingDiscardCount: qty,
          },
          resolved: true,
          description: `Each player discards ${qty} card(s)`,
        };
      } else if (clause.targetScope === 'target') {
        const playerTarget = targets.find(t => t.type === 'player');
        if (playerTarget) {
          discardPlayer = parseInt(playerTarget.id);
        }
      }

      // Random discard
      if (clause.modifiers.includes('at random')) {
        let s = state;
        const player = s.players[discardPlayer];
        if (player.hand.length === 0) {
          return { state: s, resolved: true, description: `${player.name} has no cards to discard` };
        }
        const toDiscard = Math.min(qty, player.hand.length);
        const handCopy = [...player.hand];
        const discarded: Card[] = [];
        for (let i = 0; i < toDiscard; i++) {
          const randIdx = Math.floor(Math.random() * handCopy.length);
          discarded.push(handCopy[randIdx]);
          handCopy.splice(randIdx, 1);
        }
        const updatedPlayer: PlayerState = {
          ...player,
          hand: handCopy,
          graveyard: [...player.graveyard, ...discarded],
        };
        const players = [...s.players];
        players[discardPlayer] = updatedPlayer;
        s = { ...s, players };
        return {
          state: s,
          resolved: true,
          description: `${player.name} discards ${toDiscard} card(s) at random`,
        };
      }

      // Non-random: set pending discard
      return {
        state: {
          ...state,
          pendingDiscard: discardPlayer,
          pendingDiscardCount: qty,
        },
        resolved: true,
        description: `${state.players[discardPlayer].name} must discard ${qty} card(s)`,
      };
    }

    // ── Shuffle ──
    case 'shuffle': {
      let s = state;
      if (/\beach\s+player\b/i.test(clause.raw)) {
        s = shuffleLibrary(s, 0);
        s = shuffleLibrary(s, 1);
        return { state: s, resolved: true, description: 'Each player shuffles their library' };
      }
      s = shuffleLibrary(s, controller);
      return { state: s, resolved: true, description: `${controllerName} shuffles their library` };
    }

    // ── Fight ──
    case 'fight': {
      // "target creature you control fights target creature you don't control"
      const permTargets = targets.filter(t => t.type === 'permanent');
      if (permTargets.length < 2) return { state, resolved: false };

      const found1 = findPermanentById(state, permTargets[0].id);
      const found2 = findPermanentById(state, permTargets[1].id);
      if (!found1 || !found2) return { state, resolved: false };

      let s = state;
      const p1 = found1.perm;
      const p2 = found2.perm;
      const dmg1 = p1.currentPower ?? 0;
      const dmg2 = p2.currentPower ?? 0;

      // Each creature deals damage equal to its power to the other
      // Damage p1 -> p2
      {
        const upd = { ...found2.perm, damage: found2.perm.damage + dmg1 };
        const player = s.players[found2.playerIdx];
        const bf = [...player.battlefield];
        const idx = bf.findIndex(p => p.id === upd.id);
        if (idx !== -1) bf[idx] = upd;
        const players = [...s.players];
        players[found2.playerIdx] = { ...player, battlefield: bf };
        s = { ...s, players };
      }
      // Damage p2 -> p1
      {
        const refound1 = findPermanentById(s, p1.id);
        if (refound1) {
          const upd = { ...refound1.perm, damage: refound1.perm.damage + dmg2 };
          const player = s.players[refound1.playerIdx];
          const bf = [...player.battlefield];
          const idx = bf.findIndex(p => p.id === upd.id);
          if (idx !== -1) bf[idx] = upd;
          const players = [...s.players];
          players[refound1.playerIdx] = { ...player, battlefield: bf };
          s = { ...s, players };
        }
      }

      return { state: s, resolved: true, description: `${p1.name} fights ${p2.name}` };
    }

    // ── Bounce ──
    case 'bounce': {
      const permTarget = targets.find(t => t.type === 'permanent');
      if (!permTarget) return { state, resolved: false };

      const found = findPermanentById(state, permTarget.id);
      if (!found) return { state, resolved: false };

      const { playerIdx, perm } = found;
      const ownerIdx = perm.owner;
      let s = removePermanent(state, permTarget.id, 'graveyard');

      // Actually bounce to hand, not graveyard. We need to undo the GY add and put in hand instead.
      // Simpler: remove from battlefield manually and add to owner's hand.
      // Let's redo this properly:
      s = state;
      const controllerPlayer = s.players[playerIdx];
      const bfIdx = controllerPlayer.battlefield.findIndex(p => p.id === permTarget.id);
      if (bfIdx === -1) return { state, resolved: false };

      const updatedBf = [...controllerPlayer.battlefield];
      updatedBf.splice(bfIdx, 1);

      const cardObj: Card = {
        id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
        cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
        power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
        colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
        tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
      };

      const players = [...s.players];
      players[playerIdx] = { ...controllerPlayer, battlefield: updatedBf };
      // Add to owner's hand
      const ownerPlayer = playerIdx === ownerIdx ? players[ownerIdx] : { ...s.players[ownerIdx] };
      players[ownerIdx] = { ...ownerPlayer, hand: [...ownerPlayer.hand, cardObj] };
      s = { ...s, players };

      return { state: s, resolved: true, description: `Returns ${perm.name} to its owner's hand` };
    }

    // ── Add Mana ──
    case 'add': {
      // Parse mana symbols: {W}, {U}, {B}, {R}, {G}, {C}
      const manaRegex = /\{([WUBRGC])\}/gi;
      let s = state;
      const player = s.players[controller];
      const pool = { ...player.manaPool };
      let match: RegExpExecArray | null;
      let anyAdded = false;
      const added: string[] = [];

      // Reset regex
      const fullText = clause.raw;
      const manaPattern = /\{([WUBRGC])\}/gi;
      while ((match = manaPattern.exec(fullText)) !== null) {
        const color = match[1].toUpperCase() as keyof typeof pool;
        if (color in pool && color !== 'generic' && color !== 'S') {
          (pool as Record<string, number>)[color] = ((pool as Record<string, number>)[color] || 0) + 1;
          added.push(`{${color}}`);
          anyAdded = true;
        }
      }

      // Handle "add one mana of any color" or "add X mana"
      if (!anyAdded && /\badd\s+(?:one\s+)?mana\s+of\s+any\s+color\b/i.test(clause.raw)) {
        // Default to green for "any color" when AI decides
        pool.G = (pool.G || 0) + 1;
        added.push('{G}');
        anyAdded = true;
      }

      if (!anyAdded) return { state, resolved: false };

      const updatedPlayer = { ...player, manaPool: pool };
      const players = [...s.players];
      players[controller] = updatedPlayer;
      s = { ...s, players };

      return { state: s, resolved: true, description: `Adds ${added.join('')} to mana pool` };
    }

    // ── Proliferate ──
    case 'proliferate': {
      let s = state;

      // For each permanent with counters, add one of each counter type
      for (let pi = 0; pi < 2; pi++) {
        const player = s.players[pi];
        const updatedBf = player.battlefield.map(perm => {
          const counterKeys = Object.keys(perm.counters).filter(k => perm.counters[k] > 0);
          if (counterKeys.length === 0) return perm;
          const newCounters = { ...perm.counters };
          for (const key of counterKeys) {
            newCounters[key] = (newCounters[key] || 0) + 1;
          }
          const updatedPerm: Permanent = { ...perm, counters: newCounters };
          // Recalculate P/T for +1/+1 and -1/-1 counters
          if (newCounters['+1/+1'] || newCounters['-1/-1']) {
            updatedPerm.currentPower = (updatedPerm.basePower || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0);
            updatedPerm.currentToughness = (updatedPerm.baseToughness || 0) + (newCounters['+1/+1'] || 0) - (newCounters['-1/-1'] || 0);
          }
          return updatedPerm;
        });
        const updatedPlayer = { ...player, battlefield: updatedBf };
        const players = [...s.players];
        players[pi] = updatedPlayer;
        s = { ...s, players };
      }

      // Also proliferate player counters (poison, energy, experience)
      const players = [...s.players];
      for (let pi = 0; pi < 2; pi++) {
        const p = players[pi];
        let updated = false;
        const updatedP = { ...p };
        if (p.poisonCounters > 0) { updatedP.poisonCounters = p.poisonCounters + 1; updated = true; }
        if (p.energyCounters > 0) { updatedP.energyCounters = p.energyCounters + 1; updated = true; }
        if (p.experienceCounters > 0) { updatedP.experienceCounters = p.experienceCounters + 1; updated = true; }
        if (updated) players[pi] = updatedP;
      }
      s = { ...s, players };

      return { state: s, resolved: true, description: 'Proliferates' };
    }

    // ── Surveil ──
    case 'surveil': {
      const count = clause.quantity;
      const lib = state.players[controller].library;
      const topCards = lib.slice(0, Math.min(count, lib.length));

      if (topCards.length === 0) {
        return { state, resolved: true, description: `Surveil ${count} (library empty)` };
      }

      // Surveil is like scry but cards go to graveyard instead of bottom.
      // Use pendingScry as UI fallback (the UI can be updated to handle surveil separately).
      return {
        state: {
          ...state,
          pendingScry: {
            player: controller,
            count,
            cards: topCards.map(c => c.id),
          },
        },
        resolved: true,
        description: `${controllerName} surveils ${count}`,
      };
    }

    // ── Explore ──
    case 'explore': {
      // Reveal top card. If it's a land, put it into hand. Otherwise, +1/+1 counter and optionally put in GY.
      let s = state;
      const player = s.players[controller];
      if (player.library.length === 0) {
        return { state: s, resolved: true, description: 'Explores (library empty)' };
      }

      const topCard = player.library[0];
      const isLand = topCard.typeLine.toLowerCase().includes('land');

      if (isLand) {
        // Put the land into hand
        const updatedPlayer: PlayerState = {
          ...player,
          library: player.library.slice(1),
          hand: [...player.hand, topCard],
        };
        const players = [...s.players];
        players[controller] = updatedPlayer;
        s = { ...s, players };
        return { state: s, resolved: true, description: `Explores: reveals ${topCard.name} (land), puts it into hand` };
      } else {
        // Put +1/+1 counter on the exploring creature (if source is on battlefield)
        let updatedBf = [...player.battlefield];
        if (source) {
          const srcIdx = updatedBf.findIndex(p => p.id === source.id || p.name === source.name);
          if (srcIdx !== -1) {
            const perm = updatedBf[srcIdx];
            const counters = { ...perm.counters };
            counters['+1/+1'] = (counters['+1/+1'] || 0) + 1;
            updatedBf[srcIdx] = {
              ...perm,
              counters,
              currentPower: (perm.basePower || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0),
              currentToughness: (perm.baseToughness || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0),
            };
          }
        }

        // Put the revealed card into graveyard (simplified; in real MTG, player can choose to keep on top)
        const updatedPlayer: PlayerState = {
          ...player,
          library: player.library.slice(1),
          graveyard: [...player.graveyard, topCard],
          battlefield: updatedBf,
        };
        const players = [...s.players];
        players[controller] = updatedPlayer;
        s = { ...s, players };
        return { state: s, resolved: true, description: `Explores: reveals ${topCard.name} (nonland), gets +1/+1 counter` };
      }
    }

    // ── Populate ──
    case 'populate': {
      // Copy a creature token you control
      const player = state.players[controller];
      const tokens = player.battlefield.filter(
        p => p.typeLine.toLowerCase().includes('token') && p.typeLine.toLowerCase().includes('creature'),
      );
      if (tokens.length === 0) {
        return { state, resolved: true, description: 'Populates (no tokens to copy)' };
      }

      // Pick the strongest token
      const bestToken = tokens.reduce((a, b) =>
        ((a.currentPower || 0) >= (b.currentPower || 0)) ? a : b,
      );

      const tokenId = generateSmartId();
      const tokenCard: Card = {
        id: tokenId,
        oracleId: bestToken.oracleId,
        name: bestToken.name,
        manaCost: '',
        cmc: 0,
        typeLine: bestToken.typeLine,
        oracleText: bestToken.oracleText,
        power: bestToken.power,
        toughness: bestToken.toughness,
        colors: [...bestToken.colors],
        colorIdentity: [...bestToken.colorIdentity],
        rarity: 'common',
        tags: [],
        imageUrl: bestToken.imageUrl,
        owner: controller,
      };

      const perm = cardToPermanent(tokenCard, controller, state.turn);
      const updatedPlayer: PlayerState = {
        ...player,
        battlefield: [...player.battlefield, perm],
      };
      const players = [...state.players];
      players[controller] = updatedPlayer;

      return {
        state: { ...state, players },
        resolved: true,
        description: `Populates — copies ${bestToken.name} token`,
      };
    }

    // ── Investigate ──
    case 'investigate': {
      // Create a Clue token
      const tokenId = generateSmartId();
      const clueDef = PREDEFINED_TOKENS['clue'];
      const tokenCard: Card = {
        id: tokenId,
        oracleId: 'token-clue',
        name: clueDef.name,
        manaCost: '',
        cmc: 0,
        typeLine: clueDef.typeLine,
        oracleText: clueDef.oracleText,
        colors: [],
        colorIdentity: [],
        rarity: 'common',
        tags: [],
        imageUrl: '',
        owner: controller,
      };

      const perm = cardToPermanent(tokenCard, controller, state.turn);
      const player = state.players[controller];
      const updatedPlayer: PlayerState = {
        ...player,
        battlefield: [...player.battlefield, perm],
      };
      const players = [...state.players];
      players[controller] = updatedPlayer;

      return {
        state: { ...state, players },
        resolved: true,
        description: `${controllerName} investigates (creates Clue token)`,
      };
    }

    // ── Connive ──
    case 'connive': {
      // Draw N cards, then discard N cards. For each nonland card discarded, put a +1/+1 counter on source.
      const qty = clause.quantity;
      let s = drawCards(state, controller, qty);

      // Set pending discard for the connive cards
      return {
        state: {
          ...s,
          pendingDiscard: controller,
          pendingDiscardCount: qty,
        },
        resolved: true,
        description: `${controllerName} connives ${qty} (draws ${qty}, must discard ${qty})`,
      };
    }

    // ── Amass ──
    case 'amass': {
      const qty = clause.quantity;
      let s = state;
      const player = s.players[controller];

      // Find existing Army token
      const armyIdx = player.battlefield.findIndex(
        p => p.typeLine.toLowerCase().includes('army'),
      );

      if (armyIdx !== -1) {
        // Put +1/+1 counters on existing Army
        const army = player.battlefield[armyIdx];
        const counters = { ...army.counters };
        counters['+1/+1'] = (counters['+1/+1'] || 0) + qty;
        const updatedArmy: Permanent = {
          ...army,
          counters,
          currentPower: (army.basePower || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0),
          currentToughness: (army.baseToughness || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0),
        };
        const updatedBf = [...player.battlefield];
        updatedBf[armyIdx] = updatedArmy;
        const updatedPlayer = { ...player, battlefield: updatedBf };
        const players = [...s.players];
        players[controller] = updatedPlayer;
        s = { ...s, players };
        return { state: s, resolved: true, description: `Amass ${qty} (adds ${qty} +1/+1 counters to Army)` };
      }

      // Create a 0/0 Zombie Army token, then put counters
      const tokenId = generateSmartId();
      const armyCard: Card = {
        id: tokenId,
        oracleId: 'token-zombie-army',
        name: 'Zombie Army',
        manaCost: '',
        cmc: 0,
        typeLine: 'Token Creature — Zombie Army',
        oracleText: '',
        power: '0',
        toughness: '0',
        colors: ['B'] as Color[],
        colorIdentity: ['B'] as Color[],
        rarity: 'common',
        tags: [],
        imageUrl: '',
        owner: controller,
      };

      const perm = cardToPermanent(armyCard, controller, s.turn);
      const counters: Record<string, number> = { '+1/+1': qty };
      const finalPerm: Permanent = {
        ...perm,
        counters,
        currentPower: qty,
        currentToughness: qty,
      };

      const updatedPlayer: PlayerState = {
        ...player,
        battlefield: [...player.battlefield, finalPerm],
      };
      const players = [...s.players];
      players[controller] = updatedPlayer;
      s = { ...s, players };

      return { state: s, resolved: true, description: `Amass ${qty} (creates ${qty}/${qty} Zombie Army)` };
    }

    // ── Goad ──
    case 'goad': {
      const permTarget = targets.find(t => t.type === 'permanent');
      if (!permTarget) return { state, resolved: false };

      const found = findPermanentById(state, permTarget.id);
      if (!found) return { state, resolved: false };

      const { playerIdx, permIdx, perm } = found;
      const updatedPerm: Permanent = { ...perm, goaded: true };
      const player = state.players[playerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...state.players];
      players[playerIdx] = updatedPlayer;

      return {
        state: { ...state, players },
        resolved: true,
        description: `Goads ${perm.name}`,
      };
    }

    // ── Transform ──
    case 'transform': {
      // Find the source permanent on the battlefield and flip it
      let s = state;
      let targetPerm: Permanent | null = null;
      let targetPlayerIdx: number = controller;
      let targetPermIdx = -1;

      const permTarget = targets.find(t => t.type === 'permanent');
      if (permTarget) {
        const found = findPermanentById(s, permTarget.id);
        if (found) {
          targetPerm = found.perm;
          targetPlayerIdx = found.playerIdx;
          targetPermIdx = found.permIdx;
        }
      } else if (source) {
        // Transform self
        const player = s.players[controller];
        targetPermIdx = player.battlefield.findIndex(p => p.id === source.id || p.name === source.name);
        if (targetPermIdx !== -1) {
          targetPerm = player.battlefield[targetPermIdx];
          targetPlayerIdx = controller;
        }
      }

      if (!targetPerm || targetPermIdx === -1) return { state, resolved: false };
      if (!targetPerm.backFace) return { state, resolved: false };

      const flipped: Permanent = {
        ...targetPerm,
        flipped: !targetPerm.flipped,
      };

      const player = s.players[targetPlayerIdx];
      const updatedBf = [...player.battlefield];
      updatedBf[targetPermIdx] = flipped;
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...s.players];
      players[targetPlayerIdx] = updatedPlayer;
      s = { ...s, players };

      return { state: s, resolved: true, description: `Transforms ${targetPerm.name}` };
    }

    // ── Bolster ──
    case 'bolster': {
      const qty = clause.quantity;
      const player = state.players[controller];

      // Find creature with least toughness among your creatures
      const creatures = player.battlefield.filter(
        p => p.typeLine.toLowerCase().includes('creature'),
      );
      if (creatures.length === 0) {
        return { state, resolved: true, description: `Bolster ${qty} (no creatures)` };
      }

      const weakest = creatures.reduce((a, b) =>
        (a.currentToughness || 0) <= (b.currentToughness || 0) ? a : b,
      );

      const permIdx = player.battlefield.findIndex(p => p.id === weakest.id);
      if (permIdx === -1) return { state, resolved: false };

      const counters = { ...weakest.counters };
      counters['+1/+1'] = (counters['+1/+1'] || 0) + qty;
      const updatedPerm: Permanent = {
        ...weakest,
        counters,
        currentPower: (weakest.basePower || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0),
        currentToughness: (weakest.baseToughness || 0) + (counters['+1/+1'] || 0) - (counters['-1/-1'] || 0),
      };

      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...state.players];
      players[controller] = updatedPlayer;

      return {
        state: { ...state, players },
        resolved: true,
        description: `Bolster ${qty} — puts ${qty} +1/+1 counter(s) on ${weakest.name}`,
      };
    }

    // ── Adapt ──
    case 'adapt': {
      const qty = clause.quantity;
      if (!source) return { state, resolved: false };

      const player = state.players[controller];
      const permIdx = player.battlefield.findIndex(
        p => p.id === source.id || p.name === source.name,
      );
      if (permIdx === -1) return { state, resolved: false };

      const perm = player.battlefield[permIdx];

      // Adapt only works if the creature has no +1/+1 counters
      if ((perm.counters['+1/+1'] || 0) > 0) {
        return { state, resolved: true, description: `${perm.name} already has +1/+1 counters, adapt fails` };
      }

      const counters = { ...perm.counters };
      counters['+1/+1'] = qty;
      const updatedPerm: Permanent = {
        ...perm,
        counters,
        currentPower: (perm.basePower || 0) + qty,
        currentToughness: (perm.baseToughness || 0) + qty,
      };

      const updatedBf = [...player.battlefield];
      updatedBf[permIdx] = updatedPerm;
      const updatedPlayer = { ...player, battlefield: updatedBf };
      const players = [...state.players];
      players[controller] = updatedPlayer;

      return {
        state: { ...state, players },
        resolved: true,
        description: `${perm.name} adapts ${qty}`,
      };
    }

    // ── Counter (spell) ──
    case 'counter': {
      // Counter target spell — remove it from the stack
      if (state.stack.length === 0) return { state, resolved: false };

      // Find the targeted spell on the stack
      const spellTarget = targets.find(t => t.type === 'card-in-zone' && t.zone === 'stack');
      if (spellTarget) {
        const stackIdx = state.stack.findIndex(s => s.id === spellTarget.id);
        if (stackIdx !== -1) {
          const countered = state.stack[stackIdx];
          const updatedStack = [...state.stack];
          updatedStack.splice(stackIdx, 1);
          let s: GameState = { ...state, stack: updatedStack };

          // Move countered spell's card to graveyard
          if (countered.card) {
            const owner = countered.card.owner;
            const player = s.players[owner];
            const updatedPlayer: PlayerState = {
              ...player,
              graveyard: [...player.graveyard, countered.card],
            };
            const players = [...s.players];
            players[owner] = updatedPlayer;
            s = { ...s, players };
          }

          return { state: s, resolved: true, description: `Counters ${countered.text || 'a spell'}` };
        }
      }

      return { state, resolved: false };
    }

    // ── Reveal ──
    case 'reveal': {
      // Reveal is mostly informational in a digital game. Just log it.
      return {
        state,
        resolved: true,
        description: `${controllerName} reveals cards`,
      };
    }

    default:
      return { state, resolved: false };
  }
}

// ─── Entry Point ───

export function smartParserResolve(
  state: GameState,
  controller: number,
  oracleText: string,
  targets: Target[],
  source?: Card,
): EffectResult {
  const cleaned = stripReminderText(oracleText);
  const clauses = splitIntoClauses(cleaned);

  let currentState = state;
  let anyResolved = false;
  const descriptions: string[] = [];

  // Context tracks the last affected permanent's controller for pronoun resolution
  // e.g., "Destroy target creature. Its controller loses 2 life."
  let ctx: ClauseContext = {};

  for (const clauseText of clauses) {
    const parsed = parseClause(clauseText);
    if (!parsed) continue;

    // Try "its controller" pronoun resolution first
    const pronounResult = resolveItsControllerClause(parsed, currentState, ctx, source);
    if (pronounResult && pronounResult.resolved) {
      currentState = pronounResult.state;
      anyResolved = true;
      if (pronounResult.description) descriptions.push(pronounResult.description);
      continue;
    }

    const result = executeClause(parsed, currentState, controller, targets, source);
    if (result.resolved) {
      currentState = result.state;
      anyResolved = true;
      if (result.description) descriptions.push(result.description);

      // Update context: if this clause targeted/destroyed/exiled a permanent, track its controller
      if (parsed.targetScope === 'target' && (parsed.verb === 'destroy' || parsed.verb === 'exile' || parsed.verb === 'bounce')) {
        const permTarget = targets.find(t => t.type === 'permanent');
        if (permTarget) {
          // The permanent was already removed, so look up from original state
          const found = findPermanentById(state, permTarget.id);
          if (found) {
            ctx = {
              lastTargetController: found.playerIdx,
              lastTargetPermanentId: found.perm.id,
              lastTargetName: found.perm.name,
            };
          }
        }
      }
    }
  }

  if (anyResolved) {
    currentState = addLogEntry(
      currentState,
      controller,
      `Smart parser resolved: ${descriptions.join('; ')}`,
    );
    return {
      state: currentState,
      resolved: true,
      description: descriptions.join('; '),
    };
  }

  return { state: currentState, resolved: false };
}
