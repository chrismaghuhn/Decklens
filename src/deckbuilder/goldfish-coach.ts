/**
 * Deck Coach / Combo Helper — Analysis engine for the Goldfish Playtester.
 *
 * Provides: card role classification, gameplan summary, combo progress tracking,
 * contextual hints (sequencing, mulligan, tutor guidance), and relationship edges
 * for the visual combo lines overlay.
 *
 * All heavy analysis runs once at game start via `initCoach()`.
 * Live hints are recomputed cheaply on each state change via `onCoachStateChange()`.
 */

import { detectDeckArchetype, type ArchetypeDetectionResult } from '../mtg/engine/archetype-detector.js';
import { getArchetypeById, ARCHETYPE_CATALOG, type ArchetypeDefinition, type ComboDefinition, type PlaySequenceStep } from '../mtg/engine/archetype-catalog.js';
import { analyzeDeckDNA, type DNAAnalysisResult } from '../mtg/engine/analyzers.js';
import { detectStructuredSynergies } from './synergy-map.js';
import { fetchSpellbookCombos, type SpellbookCombo } from '../shared/api.js';
import { fetchDeckCombos, type ComboMatch } from './combo-client.js';
import type { Deck, DeckEntry } from '../shared/types.js';
import type { DeckbuilderDeck, DeckbuilderCardEntry } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export type CardRole =
  | 'ramp' | 'draw' | 'removal' | 'protection' | 'combo-piece'
  | 'engine' | 'payoff' | 'setup' | 'land';

/** Priority order for display — only show highest-priority role badge */
const ROLE_PRIORITY: CardRole[] = [
  'combo-piece', 'payoff', 'engine', 'setup', 'ramp', 'draw', 'removal', 'protection', 'land',
];

export interface ComboPiece {
  comboName: string;
  cards: string[];
  description: string;
  produces: string[];
  source?: 'spellbook' | 'catalog' | 'community';
  matchLevel?: 'complete' | 'near-miss' | 'partial';
  spellbookUrl?: string;
  resultTags?: string[];
  hasTemplateReqs?: boolean;
  missingCards?: string[];
}

export interface RelEdge {
  a: string;
  b: string;
  type: 'combo' | 'synergy' | 'tutor-target';
  score: number;
  explainShort: string;
  explainResult?: string;
  comboName?: string;
}

export interface CoachHint {
  id: string;
  priority: number;
  category: 'combo' | 'sequencing' | 'mulligan' | 'warning' | 'opportunity';
  icon: string;
  shortText: string;
  expandedText: string;
  highlightCards?: string[];
}

export type CardFlowStatus = 'done' | 'in-hand' | 'in-graveyard' | 'in-exile' | 'missing' | 'not-in-deck';

export interface FlowStepStatus {
  step: PlaySequenceStep;
  stepStatus: 'done' | 'active' | 'future';
  cards: Array<{ name: string; status: CardFlowStatus }>;
}

export interface GameplanSummary {
  archetype: string;
  archetypeDesc: string;
  dominantDNA: string;
  gamePlan: string;
  winConditions: string[];
  keyEngines: string[];
  interactionSuite: string[];
  tutorTargets: string[];
  playSequence: PlaySequenceStep[];
}

export interface ComboProgress {
  have: string[];
  need: string[];
  pct: number;
  inGraveyard: string[];
}

export interface DeckCoach {
  // Pre-computed (immutable after init)
  gameplan: GameplanSummary;
  cardRoles: Map<string, CardRole[]>;
  comboPieces: ComboPiece[];
  relEdges: RelEdge[];
  archetypeResult: ArchetypeDetectionResult | null;
  dnaResult: DNAAnalysisResult | null;
  spellbookCombos: SpellbookCombo[] | null;
  cardByName: Record<string, DeckbuilderSearchCard | undefined>;
  deckCardNames: Set<string>; // normalized names of all cards in the deck

  // User prefs (localStorage persisted)
  enabled: boolean;
  level: 'beginner' | 'advanced';
  filter: 'all' | 'combos-only';
  linesMode: 'hover' | 'locked' | 'off';

  // Live state
  activeHints: CoachHint[];
  comboProgress: Map<string, ComboProgress>;
  lastHintTurn: number;
  hintsShownThisTurn: number;
  hoveredCard: string | null;
  lockedCard: string | null;

  // Internal
  _debounceTimer: ReturnType<typeof setTimeout> | null;
}

/** Minimal game state view needed by the coach */
export interface CoachGameState {
  hand: string[];
  battlefield: Array<{ name: string; isToken: boolean }>;
  graveyard: string[];
  exile: string[];
  commandZone: string[];
  turn: number;
  phase: string;
  library: string[];
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function norm(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCardData(name: string, cbn: Record<string, DeckbuilderSearchCard | undefined>): DeckbuilderSearchCard | undefined {
  return cbn[norm(name)];
}

function getOracleText(card: DeckbuilderSearchCard | undefined): string {
  if (!card) return '';
  let text = card.oracle_text || '';
  if (card.card_faces) {
    for (const face of card.card_faces) {
      if (face.oracle_text) text += ' ' + face.oracle_text;
    }
  }
  return text.toLowerCase();
}

function getTypeLine(card: DeckbuilderSearchCard | undefined): string {
  return (card?.type_line || '').toLowerCase();
}

// ═══════════════════════════════════════════════════════
// Step 1: Init + Adapter
// ═══════════════════════════════════════════════════════

function adaptDeck(deck: DeckbuilderDeck): Deck {
  const toEntries = (entries: DeckbuilderCardEntry[]): DeckEntry[] =>
    entries.map((e) => ({ name: e.name, qty: e.qty }));
  return {
    main: toEntries(deck.boards.mainboard || []),
    sideboard: toEntries(deck.boards.sideboard || []),
    commander: toEntries(deck.boards.commander || []),
  };
}

function cardResolver(cbn: Record<string, DeckbuilderSearchCard | undefined>) {
  return (name: string) => {
    const c = cbn[norm(name)];
    if (!c) return undefined;
    return { name: c.name, type_line: c.type_line, oracle_text: c.oracle_text, cmc: c.cmc };
  };
}

function loadPrefs(): { enabled: boolean; level: 'beginner' | 'advanced'; filter: 'all' | 'combos-only'; linesMode: 'hover' | 'locked' | 'off' } {
  try {
    const raw = localStorage.getItem('gf-coach-prefs');
    if (raw) {
      const p = JSON.parse(raw);
      return {
        enabled: p.enabled !== false,
        level: p.level === 'advanced' ? 'advanced' : 'beginner',
        filter: p.filter === 'combos-only' ? 'combos-only' : 'all',
        linesMode: p.linesMode === 'locked' ? 'locked' : p.linesMode === 'off' ? 'off' : 'hover',
      };
    }
  } catch { /* ignore */ }
  return { enabled: true, level: 'beginner', filter: 'all', linesMode: 'hover' };
}

export function savePrefs(coach: DeckCoach): void {
  try {
    localStorage.setItem('gf-coach-prefs', JSON.stringify({
      enabled: coach.enabled,
      level: coach.level,
      filter: coach.filter,
      linesMode: coach.linesMode,
    }));
  } catch { /* ignore */ }
}

export function initCoach(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): DeckCoach {
  const adapted = adaptDeck(deck);
  const resolver = cardResolver(cardByName);

  // Run analysis modules
  let archetypeResult: ArchetypeDetectionResult | null = null;
  try { archetypeResult = detectDeckArchetype(adapted, resolver); } catch { /* optional */ }

  let dnaResult: DNAAnalysisResult | null = null;
  const allEntries: DeckEntry[] = [...adapted.main, ...adapted.commander];
  try { dnaResult = analyzeDeckDNA(allEntries, resolver); } catch { /* optional */ }

  // Synergy edges
  let synergyEdges: Array<{ a: string; b: string; reason: string }> = [];
  try { synergyEdges = detectStructuredSynergies(deck, cardByName); } catch { /* optional */ }

  // Combo pieces from archetype catalog
  const comboPieces = buildComboPieces(archetypeResult, adapted);

  // Card roles
  const comboPieceNames = new Set<string>();
  for (const cp of comboPieces) {
    for (const c of cp.cards) comboPieceNames.add(norm(c));
  }
  const cardRoles = classifyAllCardRoles(deck, cardByName, comboPieceNames);

  // Relationship edges
  const relEdges = buildRelationshipEdges(comboPieces, synergyEdges, cardRoles, deck, cardByName);

  // Gameplan
  const gameplan = buildGameplan(archetypeResult, dnaResult, cardRoles, deck, cardByName);

  // Collect all deck card names (normalized) for flow status
  const deckCardNames = new Set<string>();
  for (const e of [...(deck.boards.mainboard || []), ...(deck.boards.commander || []), ...(deck.boards.sideboard || [])]) {
    deckCardNames.add(norm(e.name));
  }

  const prefs = loadPrefs();

  const coach: DeckCoach = {
    gameplan,
    cardRoles,
    comboPieces,
    relEdges,
    archetypeResult,
    dnaResult,
    spellbookCombos: null,
    cardByName,
    deckCardNames,
    ...prefs,
    activeHints: [],
    comboProgress: new Map(),
    lastHintTurn: 0,
    hintsShownThisTurn: 0,
    hoveredCard: null,
    lockedCard: null,
    _debounceTimer: null,
  };

  // Fire-and-forget async combo fetch (new combo database with Spellbook fallback)
  const allCardNames = [
    ...(deck.boards.commander || []).map((e) => e.name),
    ...(deck.boards.mainboard || []).map((e) => e.name),
    ...(deck.boards.sideboard || []).map((e) => e.name),
  ];
  if (allCardNames.length > 0) {
    fetchDeckCombos(allCardNames).then((matches: ComboMatch[]) => {
      // Also store legacy format for backwards compat
      coach.spellbookCombos = matches.map((m) => ({
        id: m.id,
        cards: m.cards,
        description: m.description,
        prerequisites: m.requires.join('; '),
        produces: m.produces,
        identity: '',
        spellbookUrl: m.spellbookUrl,
      }));

      // Merge new combo pieces from combo database
      for (const m of matches) {
        const existing = coach.comboPieces.find(
          (cp) => cp.comboName === m.name || cp.cards.length === m.cards.length &&
            cp.cards.every((c) => m.cards.some((mc) => norm(mc) === norm(c))),
        );
        if (!existing) {
          coach.comboPieces.push({
            comboName: m.name.slice(0, 80),
            cards: m.cards,
            description: m.description,
            produces: m.produces,
            source: m.source,
            matchLevel: m.matchLevel,
            spellbookUrl: m.spellbookUrl,
            resultTags: m.resultTags,
            hasTemplateReqs: m.hasTemplateReqs,
            missingCards: m.missingCards,
          });
          // Add combo-piece role to matched cards
          for (const c of m.matchedCards) {
            const key = norm(c);
            if (!coach.cardRoles.has(key)) coach.cardRoles.set(key, []);
            const roles = coach.cardRoles.get(key)!;
            if (!roles.includes('combo-piece')) roles.unshift('combo-piece');
          }
        } else {
          // Enrich existing catalog combos with database info
          if (!existing.source) existing.source = m.source;
          if (!existing.matchLevel) existing.matchLevel = m.matchLevel;
          if (!existing.spellbookUrl && m.spellbookUrl) existing.spellbookUrl = m.spellbookUrl;
          if (!existing.resultTags && m.resultTags.length > 0) existing.resultTags = m.resultTags;
          if (m.hasTemplateReqs) existing.hasTemplateReqs = true;
          if (m.missingCards.length > 0 && !existing.missingCards) existing.missingCards = m.missingCards;
        }
      }
      // Rebuild edges with enriched combo data
      const newEdges = buildRelationshipEdges(coach.comboPieces, synergyEdges, coach.cardRoles, deck, cardByName);
      coach.relEdges = newEdges;
    }).catch(() => { /* Combo database unavailable, continue with catalog-only combos */ });
  }

  return coach;
}

// ═══════════════════════════════════════════════════════
// Step 2: Card Role Classifier
// ═══════════════════════════════════════════════════════

function classifyAllCardRoles(
  deck: DeckbuilderDeck,
  cbn: Record<string, DeckbuilderSearchCard | undefined>,
  comboPieceNames: Set<string>,
): Map<string, CardRole[]> {
  const roles = new Map<string, CardRole[]>();
  const allEntries = [
    ...(deck.boards.mainboard || []),
    ...(deck.boards.commander || []),
    ...(deck.boards.sideboard || []),
  ];

  for (const entry of allEntries) {
    const key = norm(entry.name);
    if (roles.has(key)) continue;
    roles.set(key, classifyCard(entry.name, cbn, comboPieceNames));
  }

  return roles;
}

function classifyCard(
  name: string,
  cbn: Record<string, DeckbuilderSearchCard | undefined>,
  comboPieceNames: Set<string>,
): CardRole[] {
  const card = getCardData(name, cbn);
  const type = getTypeLine(card);
  const text = getOracleText(card);
  const cmc = card?.cmc ?? 99;
  const roles: CardRole[] = [];

  // Land
  if (type.includes('land')) {
    roles.push('land');
    if (text.includes('add') && text.includes('additional')) roles.push('ramp');
    return roles;
  }

  // Combo piece (from catalog / spellbook)
  if (comboPieceNames.has(norm(name))) {
    roles.push('combo-piece');
  }

  // Ramp
  if (
    (type.includes('creature') && cmc <= 2 && (text.includes('add {') || text.includes('add one mana'))) ||
    (type.includes('artifact') && (text.includes('add {') || text.includes('add one mana'))) ||
    (text.includes('search your library for a') && text.includes('land') && !text.includes('nonland'))
  ) {
    roles.push('ramp');
  }

  // Draw
  if (
    text.includes('draw a card') || text.includes('draw cards') ||
    text.includes('draw two') || text.includes('draw three') ||
    text.includes('draws a card')
  ) {
    roles.push('draw');
  }

  // Removal
  if (
    text.includes('destroy target') || text.includes('exile target') ||
    text.includes('destroy all') || text.includes('exile all') ||
    (text.includes('deals') && text.includes('damage to')) ||
    text.includes('-x/-x') || text.includes('each opponent sacrifices')
  ) {
    roles.push('removal');
  }

  // Protection
  if (
    text.includes('counter target') || text.includes('hexproof') ||
    text.includes('indestructible') || text.includes('protection from') ||
    text.includes('ward')
  ) {
    roles.push('protection');
  }

  // Engine (ongoing value)
  if (
    (text.includes('whenever') && (text.includes('draw') || text.includes('create') || text.includes('add {'))) ||
    (text.includes('at the beginning of') && (text.includes('draw') || text.includes('create') || text.includes('add')))
  ) {
    roles.push('engine');
  }

  // Payoff (win conditions)
  if (
    text.includes('you win the game') || text.includes('loses the game') ||
    text.includes('each opponent loses') ||
    (type.includes('creature') && parseInt(card?.power || '0', 10) >= 6)
  ) {
    roles.push('payoff');
  }

  // Setup (tutors)
  if (
    (text.includes('search your library') && !text.includes('land') && !type.includes('land')) ||
    text.includes('transmute')
  ) {
    roles.push('setup');
  }

  return roles;
}

export function getPrimaryRole(name: string, coach: DeckCoach): CardRole | null {
  const roles = coach.cardRoles.get(norm(name));
  if (!roles || roles.length === 0) return null;
  for (const r of ROLE_PRIORITY) {
    if (roles.includes(r)) return r;
  }
  return roles[0];
}

// ═══════════════════════════════════════════════════════
// Step 3: Relationship Edge Builder
// ═══════════════════════════════════════════════════════

function buildRelationshipEdges(
  comboPieces: ComboPiece[],
  synergyEdges: Array<{ a: string; b: string; reason: string }>,
  cardRoles: Map<string, CardRole[]>,
  deck: DeckbuilderDeck,
  cbn: Record<string, DeckbuilderSearchCard | undefined>,
): RelEdge[] {
  const edges: RelEdge[] = [];
  const seen = new Set<string>();

  function addEdge(e: RelEdge) {
    const key = [norm(e.a), norm(e.b)].sort().join('||') + '|' + e.type;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(e);
  }

  // 1) Combo edges (pairwise from combo pieces)
  for (const cp of comboPieces) {
    for (let i = 0; i < cp.cards.length; i++) {
      for (let j = i + 1; j < cp.cards.length; j++) {
        addEdge({
          a: cp.cards[i],
          b: cp.cards[j],
          type: 'combo',
          score: 10,
          explainShort: `Part of: ${cp.comboName}`,
          explainResult: cp.produces.join(', ') || cp.description.slice(0, 80),
          comboName: cp.comboName,
        });
      }
    }
  }

  // 2) Synergy edges from synergy-map
  for (const se of synergyEdges) {
    addEdge({
      a: se.a,
      b: se.b,
      type: 'synergy',
      score: 5,
      explainShort: se.reason,
    });
  }

  // 3) Tutor target edges
  const tutorTargets = buildTutorTargets(cardRoles, comboPieces);
  const allEntries = [...(deck.boards.mainboard || []), ...(deck.boards.commander || []), ...(deck.boards.sideboard || [])];
  for (const entry of allEntries) {
    const roles = cardRoles.get(norm(entry.name));
    if (roles?.includes('setup')) {
      for (const target of tutorTargets.slice(0, 3)) {
        if (norm(target) !== norm(entry.name)) {
          addEdge({
            a: entry.name,
            b: target,
            type: 'tutor-target',
            score: 7,
            explainShort: `Tutor → ${target}`,
          });
        }
      }
    }
  }

  return edges;
}

function buildTutorTargets(cardRoles: Map<string, CardRole[]>, comboPieces: ComboPiece[]): string[] {
  // Priority: combo pieces > payoffs > engines
  const targets: Array<{ name: string; priority: number }> = [];
  const comboPieceNames = new Set<string>();
  for (const cp of comboPieces) {
    for (const c of cp.cards) comboPieceNames.add(norm(c));
  }

  for (const [key, roles] of cardRoles) {
    if (roles.includes('land')) continue;
    let priority = 99;
    if (comboPieceNames.has(key)) priority = 1;
    else if (roles.includes('payoff')) priority = 2;
    else if (roles.includes('engine')) priority = 3;
    else if (roles.includes('ramp')) priority = 5;
    else continue;
    // Find original name (not normalized)
    targets.push({ name: key, priority });
  }

  targets.sort((a, b) => a.priority - b.priority);
  return targets.map((t) => t.name);
}

// ═══════════════════════════════════════════════════════
// Step 4: Gameplan Builder
// ═══════════════════════════════════════════════════════

function buildGameplan(
  archetypeResult: ArchetypeDetectionResult | null,
  dnaResult: DNAAnalysisResult | null,
  cardRoles: Map<string, CardRole[]>,
  deck: DeckbuilderDeck,
  cbn: Record<string, DeckbuilderSearchCard | undefined>,
): GameplanSummary {
  // Get archetype info
  let archetypeDef: ArchetypeDefinition | undefined;
  if (archetypeResult?.primaryArchetype) {
    archetypeDef = getArchetypeById(archetypeResult.primaryArchetype);
  }

  const archetype = archetypeDef?.name || dnaResult?.dominant || 'Unknown';
  const archetypeDesc = archetypeDef?.description || 'No archetype detected — play reactively and find your path.';
  const gamePlan = archetypeDef?.gamePlan || 'Develop your board, look for synergies, and adapt to the situation.';
  const dominantDNA = dnaResult?.dominant || 'midrange';

  // Collect cards by role
  const winConditions: string[] = [];
  const keyEngines: string[] = [];
  const interactionSuite: string[] = [];
  const setupCards: string[] = [];

  for (const [key, roles] of cardRoles) {
    if (roles.includes('land')) continue;
    // Find display name from deck
    const displayName = findDisplayName(key, deck);
    if (roles.includes('payoff') || roles.includes('combo-piece')) winConditions.push(displayName);
    if (roles.includes('engine')) keyEngines.push(displayName);
    if (roles.includes('removal') || roles.includes('protection')) interactionSuite.push(displayName);
    if (roles.includes('setup')) setupCards.push(displayName);
  }

  // Tutor targets: combo pieces first, then payoffs, then engines
  const tutorTargets = buildTutorTargets(cardRoles, []).map((key) => findDisplayName(key, deck));

  // Play sequence: catalog if available, otherwise auto-generate
  let playSequence: PlaySequenceStep[] = [];
  if (archetypeDef?.playSequence && archetypeDef.playSequence.length > 0) {
    playSequence = archetypeDef.playSequence;
  } else {
    playSequence = buildAutoSequence(cardRoles, cbn, deck);
  }

  return {
    archetype,
    archetypeDesc,
    dominantDNA,
    gamePlan,
    winConditions: winConditions.slice(0, 5),
    keyEngines: keyEngines.slice(0, 5),
    interactionSuite: interactionSuite.slice(0, 8),
    tutorTargets: tutorTargets.slice(0, 5),
    playSequence,
  };
}

function findDisplayName(normalizedKey: string, deck: DeckbuilderDeck): string {
  const allEntries = [
    ...(deck.boards.commander || []),
    ...(deck.boards.mainboard || []),
    ...(deck.boards.sideboard || []),
  ];
  for (const e of allEntries) {
    if (norm(e.name) === normalizedKey) return e.name;
  }
  return normalizedKey;
}

// ═══════════════════════════════════════════════════════
// Step 5: Combo Progress + Hints + Prioritizer
// ═══════════════════════════════════════════════════════

function buildComboPieces(
  archetypeResult: ArchetypeDetectionResult | null,
  adapted: Deck,
): ComboPiece[] {
  const pieces: ComboPiece[] = [];
  const deckNames = new Set([
    ...adapted.main.map((e) => norm(e.name)),
    ...adapted.commander.map((e) => norm(e.name)),
  ]);

  // Scan ALL archetype definitions for combos matching this deck
  for (const archetype of ARCHETYPE_CATALOG) {
    if (!archetype.combos) continue;
    for (const combo of archetype.combos) {
      // Include combo if at least 2 cards are in the deck
      const inDeck = combo.cards.filter((c) => deckNames.has(norm(c)));
      if (inDeck.length >= 2) {
        pieces.push({
          comboName: combo.name,
          cards: combo.cards,
          description: combo.description,
          produces: [],
        });
      }
    }
  }

  return pieces;
}

export function onCoachStateChange(coach: DeckCoach, state: CoachGameState): void {
  // Debounce at 100ms
  if (coach._debounceTimer) clearTimeout(coach._debounceTimer);
  coach._debounceTimer = setTimeout(() => {
    computeHints(coach, state);
  }, 100);
}

function computeHints(coach: DeckCoach, state: CoachGameState): void {
  if (!coach.enabled) {
    coach.activeHints = [];
    coach.comboProgress = new Map();
    return;
  }

  // Reset rate limit on new turn
  if (state.turn !== coach.lastHintTurn) {
    coach.lastHintTurn = state.turn;
    coach.hintsShownThisTurn = 0;
  }

  const candidates: CoachHint[] = [];

  // 1) Combo progress
  const comboHints = checkComboProgress(coach, state);
  candidates.push(...comboHints);

  // 2) Sequencing (main phases only)
  if (state.phase === 'main1' || state.phase === 'main2') {
    candidates.push(...checkSequencing(coach, state));
  }

  // 3) Mulligan advice (turn 1 only)
  if (state.turn === 1 && state.phase === 'main1') {
    const mulliganHint = checkMulliganAdvice(coach, state);
    if (mulliganHint) candidates.push(mulliganHint);
  }

  // Apply filter
  let filtered = candidates;
  if (coach.filter === 'combos-only') {
    filtered = candidates.filter((h) => h.category === 'combo');
  }

  // Apply level
  if (coach.level === 'advanced') {
    // Advanced: prefer combo & opportunity, skip basic sequencing
    filtered = filtered.filter((h) => h.category !== 'sequencing' || h.priority <= 4);
  }

  // Sort by priority (ascending = most important first)
  filtered.sort((a, b) => a.priority - b.priority);

  // Dedup by id
  const seen = new Set<string>();
  filtered = filtered.filter((h) => {
    if (seen.has(h.id)) return false;
    seen.add(h.id);
    return true;
  });

  // Rate limit: max 3/turn (priority 1 bypasses)
  const maxHints = 3;
  const result: CoachHint[] = [];
  for (const h of filtered) {
    if (h.priority === 1 || result.length < maxHints) {
      result.push(h);
    }
    if (result.length >= maxHints + 1) break; // +1 for priority-1 bypass
  }

  coach.activeHints = result;
  coach.hintsShownThisTurn = result.length;
}

function checkComboProgress(coach: DeckCoach, state: CoachGameState): CoachHint[] {
  const hints: CoachHint[] = [];
  const newProgress = new Map<string, ComboProgress>();

  // Collect all accessible card names
  const handNames = new Set(state.hand.map(norm));
  const bfNames = new Set(state.battlefield.filter((p) => !p.isToken).map((p) => norm(p.name)));
  const cmdNames = new Set(state.commandZone.map(norm));
  const gyNames = new Set(state.graveyard.map(norm));
  const accessible = new Set([...handNames, ...bfNames, ...cmdNames]);

  for (const cp of coach.comboPieces) {
    const have: string[] = [];
    const need: string[] = [];
    const inGraveyard: string[] = [];

    for (const card of cp.cards) {
      const key = norm(card);
      if (accessible.has(key)) {
        have.push(card);
      } else if (gyNames.has(key)) {
        inGraveyard.push(card);
        need.push(card);
      } else {
        need.push(card);
      }
    }

    const pct = cp.cards.length > 0 ? have.length / cp.cards.length : 0;
    newProgress.set(cp.comboName, { have, need, pct, inGraveyard });

    if (pct >= 1) {
      hints.push({
        id: `combo-ready-${cp.comboName}`,
        priority: 1,
        category: 'combo',
 icon: '◆',
        shortText: `COMBO READY: ${cp.comboName}`,
        expandedText: `All pieces available! ${have.join(' + ')}. ${cp.description}`,
        highlightCards: have,
      });
    } else if (pct >= 0.66) {
      hints.push({
        id: `combo-near-${cp.comboName}`,
        priority: 3,
        category: 'combo',
 icon: '▲',
        shortText: `${cp.comboName} ${have.length}/${cp.cards.length} — need: ${need.join(', ')}`,
        expandedText: `Have: ${have.join(', ')}. Need: ${need.join(', ')}.${inGraveyard.length > 0 ? ` (${inGraveyard.join(', ')} in graveyard — recoverable?)` : ''} ${cp.description}`,
        highlightCards: have,
      });
    } else if (pct >= 0.5) {
      hints.push({
        id: `combo-assembling-${cp.comboName}`,
        priority: 6,
        category: 'combo',
 icon: '▤',
        shortText: `${cp.comboName} assembling — ${have.length}/${cp.cards.length}`,
        expandedText: `Have: ${have.join(', ')}. Still need: ${need.join(', ')}. ${cp.description}`,
        highlightCards: have,
      });
    }
  }

  coach.comboProgress = newProgress;
  return hints;
}

function checkSequencing(coach: DeckCoach, state: CoachGameState): CoachHint[] {
  const hints: CoachHint[] = [];
  const handRoles = state.hand.map((name) => ({
    name,
    roles: coach.cardRoles.get(norm(name)) || [],
    cmc: getCardData(name, coach.cardByName)?.cmc ?? 99,
  }));

  const hasLand = handRoles.some((c) => c.roles.includes('land'));
  const hasRamp = handRoles.some((c) => c.roles.includes('ramp'));
  const hasDraw = handRoles.some((c) => c.roles.includes('draw'));
  const hasSetup = handRoles.some((c) => c.roles.includes('setup'));

  // Land-first hint
  if (hasLand) {
    const spells = handRoles.filter((c) => !c.roles.includes('land') && c.cmc <= 4);
    if (spells.length > 0) {
      hints.push({
        id: 'seq-land-first',
        priority: 4,
        category: 'sequencing',
 icon: '◆',
        shortText: 'Play your land before casting spells',
        expandedText: `You have a land in hand — play it first to maximize available mana for ${spells[0].name}.`,
      });
    }
  }

  // Ramp-first hint
  if (hasRamp) {
    const expensive = handRoles.filter((c) => c.cmc >= 4 && !c.roles.includes('ramp'));
    if (expensive.length > 0) {
      const rampCard = handRoles.find((c) => c.roles.includes('ramp'));
      hints.push({
        id: 'seq-ramp-first',
        priority: 4,
        category: 'sequencing',
 icon: '◆',
        shortText: `Cast ${rampCard?.name || 'ramp'} to accelerate into ${expensive[0].name}`,
        expandedText: `${rampCard?.name} will help you cast ${expensive[0].name} (CMC ${expensive[0].cmc}) sooner.`,
      });
    }
  }

  // Draw-first hint
  if (hasDraw && handRoles.length >= 3) {
    const drawCard = handRoles.find((c) => c.roles.includes('draw'));
    hints.push({
      id: 'seq-draw-first',
      priority: 5,
      category: 'sequencing',
 icon: '◆',
      shortText: `Consider casting ${drawCard?.name || 'draw spell'} first for more options`,
      expandedText: `Drawing cards first gives you more information before committing to a play line.`,
    });
  }

  // Tutor guidance
  if (hasSetup) {
    const setupCard = handRoles.find((c) => c.roles.includes('setup'));
    // Find best tutor target from incomplete combos
    for (const [comboName, progress] of coach.comboProgress) {
      if (progress.need.length > 0 && progress.pct > 0) {
        hints.push({
          id: `seq-tutor-${comboName}`,
          priority: 5,
          category: 'opportunity',
 icon: '◇',
          shortText: `Tutor for ${progress.need[0]} to complete ${comboName}`,
          expandedText: `${setupCard?.name || 'Tutor'} → ${progress.need[0]}. This completes the ${comboName} combo (${progress.have.length}/${progress.have.length + progress.need.length} pieces assembled).`,
          highlightCards: [setupCard?.name || '', progress.need[0]].filter(Boolean),
        });
        break; // Only one tutor hint
      }
    }
  }

  return hints;
}

function checkMulliganAdvice(coach: DeckCoach, state: CoachGameState): CoachHint | null {
  const handRoles = state.hand.map((name) => ({
    name,
    roles: coach.cardRoles.get(norm(name)) || [],
    cmc: getCardData(name, coach.cardByName)?.cmc ?? 99,
  }));

  const landCount = handRoles.filter((c) => c.roles.includes('land')).length;
  const rampCount = handRoles.filter((c) => c.roles.includes('ramp')).length;
  const avgCmc = handRoles.filter((c) => !c.roles.includes('land')).reduce((sum, c) => sum + c.cmc, 0) /
    Math.max(1, handRoles.filter((c) => !c.roles.includes('land')).length);

  const issues: string[] = [];
  let score = 70; // base

  if (landCount === 0) { score -= 40; issues.push('no lands'); }
  else if (landCount === 1) { score -= 15; issues.push('only 1 land'); }
  else if (landCount >= 5) { score -= 20; issues.push(`${landCount} lands (too many)`); }

  if (rampCount === 0 && avgCmc > 3.5) { score -= 10; issues.push('no ramp with high curve'); }

  if (avgCmc > 5) { score -= 15; issues.push('very high average CMC'); }

  const hasAction = handRoles.some((c) => c.cmc <= 3 && !c.roles.includes('land'));
  if (!hasAction) { score -= 15; issues.push('no early plays'); }

  if (score < 50) {
    return {
      id: 'mulligan-advice',
      priority: 2,
      category: 'mulligan',
 icon: '◆',
      shortText: `Consider mulligan: ${issues.slice(0, 2).join(', ')}`,
      expandedText: `Hand score: ${Math.max(0, score)}/100. Issues: ${issues.join(', ')}. A new hand of ${state.hand.length - 1} might be better.`,
    };
  } else if (score >= 70) {
    return {
      id: 'mulligan-keep',
      priority: 8,
      category: 'mulligan',
 icon: '✓',
      shortText: `Keep — solid hand with ${landCount} lands${rampCount > 0 ? ` and ${rampCount} ramp` : ''}`,
      expandedText: `Hand score: ${score}/100. ${landCount} lands, ${rampCount > 0 ? `${rampCount} ramp pieces, ` : ''}average CMC ${avgCmc.toFixed(1)} for non-lands.`,
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════
// Step 6: Play Sequence — Turn Range Parsing + Auto Builder + Flow Status
// ═══════════════════════════════════════════════════════

export function parseTurnRange(turns: string): { start: number; end: number | null } {
  if (turns.endsWith('+')) return { start: parseInt(turns, 10), end: null };
  const parts = turns.split('-').map(Number);
  return { start: parts[0], end: parts[1] ?? parts[0] };
}

export function getStepStatus(turn: number, range: { start: number; end: number | null }): 'done' | 'active' | 'future' {
  if (range.end !== null && turn > range.end) return 'done';
  if (turn >= range.start && (range.end === null || turn <= range.end)) return 'active';
  return 'future';
}

/** Build auto-generated play sequence for decks without a catalog sequence.
 *  Groups by card role first, uses CMC as tie-breaker. */
function buildAutoSequence(
  cardRoles: Map<string, CardRole[]>,
  cbn: Record<string, DeckbuilderSearchCard | undefined>,
  deck: DeckbuilderDeck,
): PlaySequenceStep[] {
  // Collect all non-land cards with roles
  const allEntries = [
    ...(deck.boards.mainboard || []),
    ...(deck.boards.commander || []),
  ];
  const cardData: Array<{ name: string; roles: CardRole[]; cmc: number }> = [];
  for (const e of allEntries) {
    const key = norm(e.name);
    const roles = cardRoles.get(key) || [];
    if (roles.includes('land') && roles.length === 1) continue; // skip pure lands
    const card = getCardData(e.name, cbn);
    cardData.push({ name: e.name, roles, cmc: card?.cmc ?? 99 });
  }

  // Define phase buckets by role priority
  const phases: Array<{ turns: string; phase: string; goal: string; roleMatch: CardRole[]; cmcRange: [number, number]; priority: 'critical' | 'high' | 'medium' }> = [
    { turns: '1-2', phase: 'Ramp', goal: 'Play ramp pieces and cheap setup', roleMatch: ['ramp', 'setup'], cmcRange: [0, 2], priority: 'critical' },
    { turns: '3-4', phase: 'Setup', goal: 'Deploy engines and card draw', roleMatch: ['engine', 'draw'], cmcRange: [2, 4], priority: 'high' },
    { turns: '5-6', phase: 'Deploy', goal: 'Play payoffs and combo pieces', roleMatch: ['payoff', 'combo-piece'], cmcRange: [4, 6], priority: 'high' },
    { turns: '7+', phase: 'Close Out', goal: 'Win the game', roleMatch: ['payoff', 'combo-piece', 'removal'], cmcRange: [6, 99], priority: 'critical' },
  ];

  const usedCards = new Set<string>();
  const steps: PlaySequenceStep[] = [];

  for (const p of phases) {
    // Primary: match by role
    const roleMatched = cardData
      .filter((c) => !usedCards.has(norm(c.name)) && c.roles.some((r) => p.roleMatch.includes(r)))
      .sort((a, b) => a.cmc - b.cmc);

    // Secondary fallback: match by CMC range only
    const cmcFallback = cardData
      .filter((c) => !usedCards.has(norm(c.name)) && !c.roles.some((r) => p.roleMatch.includes(r)) && c.cmc >= p.cmcRange[0] && c.cmc <= p.cmcRange[1])
      .sort((a, b) => a.cmc - b.cmc);

    const candidates = [...roleMatched, ...cmcFallback];
    const keyCards = candidates.slice(0, 4).map((c) => c.name);

    if (keyCards.length === 0) continue; // skip empty steps

    for (const name of keyCards) usedCards.add(norm(name));

    steps.push({
      turns: p.turns,
      phase: p.phase,
      goal: p.goal,
      keyCards,
      priority: p.priority,
    });
  }

  return steps;
}

/** Compute live flow status for each play sequence step + card */
export function computeFlowStatus(
  playSequence: PlaySequenceStep[],
  state: CoachGameState,
  deckCardNames: Set<string>,
): FlowStepStatus[] {
  const bfNames = new Set(state.battlefield.filter((p) => !p.isToken).map((p) => norm(p.name)));
  const handNames = new Set(state.hand.map(norm));
  const gyNames = new Set(state.graveyard.map(norm));
  const exileNames = new Set(state.exile.map(norm));

  return playSequence.map((step) => {
    const range = parseTurnRange(step.turns);
    const stepStatus = getStepStatus(state.turn, range);

    const cards = step.keyCards.map((cardName) => {
      const key = norm(cardName);

      // Not in the user's actual deck? Mark as not-in-deck (will be hidden in UI)
      if (!deckCardNames.has(key)) return { name: cardName, status: 'not-in-deck' as CardFlowStatus };

      if (bfNames.has(key)) return { name: cardName, status: 'done' as CardFlowStatus };
      if (handNames.has(key)) return { name: cardName, status: 'in-hand' as CardFlowStatus };
      if (gyNames.has(key)) return { name: cardName, status: 'in-graveyard' as CardFlowStatus };
      if (exileNames.has(key)) return { name: cardName, status: 'in-exile' as CardFlowStatus };
      return { name: cardName, status: 'missing' as CardFlowStatus };
    });

    return { step, stepStatus, cards };
  });
}
