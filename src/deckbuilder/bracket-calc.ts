import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';

// Official WotC Game Changers list (Feb 2026 update)
const GAME_CHANGERS = new Set([
  'rhystic study', 'cyclonic rift', 'smothering tithe', 'demonic tutor',
  'ancient tomb', 'fierce guardianship', 'the one ring', "teferi's protection",
  "jeska's will", 'vampiric tutor', 'enlightened tutor', 'mystical tutor',
  'farewell', 'chrome mox', 'mana vault', 'worldly tutor', 'force of will',
  'crop rotation', 'gamble', 'orcish bowmasters', 'mox diamond',
  "bolas's citadel", 'seedborn muse', "thassa's oracle", 'underworld breach',
  'field of the dead', "gaea's cradle", 'opposition agent', 'imperial seal',
  'necropotence', 'drannith magistrate', 'consecrated sphinx', 'grim monolith',
  "lion's eye diamond", 'narset, parter of veils', 'aura shards',
  'notion thief', 'ad nauseam', 'tergrid, god of fright', 'natural order',
  'grand arbiter augustin iv', 'intuition', 'gifts ungiven', 'glacial chasm',
  'survival of the fittest', "serra's sanctum", "mishra's workshop",
  'braids, cabal minion', 'the tabernacle at pendrell vale', 'humility',
  'coalition victory', 'panoptic mirror', 'biorhythm',
]);

// Fast mana cards that signal high-power play
const FAST_MANA = new Set([
  'sol ring', 'mana crypt', 'mana vault', 'chrome mox', 'mox diamond',
  "lion's eye diamond", 'grim monolith', 'mox opal', 'mox amber',
  'jeweled lotus', 'lotus petal', 'dark ritual', 'cabal ritual',
  "rite of flame", 'simian spirit guide', 'elvish spirit guide',
]);

// Mass land destruction spells
const MASS_LAND_DESTRUCTION = new Set([
  'armageddon', 'ravages of war', 'cataclysm', 'obliterate',
  'jokulhaups', 'decree of annihilation', 'apocalypse', 'sunder',
  'ruination', 'from the ashes', 'keldon firebombers',
  'devastation', 'global ruin', 'destructive force',
]);

// Extra turn spells
const EXTRA_TURNS = new Set([
  'time warp', 'temporal manipulation', 'temporal mastery',
  'extra turn', 'capture of jingzhou', 'time stretch',
  'expropriate', 'nexus of fate', 'alrund\'s epiphany',
  'beacon of tomorrows', 'karn\'s temporal sundering',
  'temporal trespass', 'walk the aeons', 'part the waterveil',
  'savor the moment',
]);

// Stax pieces that restrict opponents
const STAX_PIECES = new Set([
  'winter orb', 'static orb', 'stasis', 'smokestack',
  'tangle wire', 'sphere of resistance', 'thorn of amethyst',
  'trinisphere', 'null rod', 'collector ouphe', 'stranglehold',
  'aven mindcensor', 'rule of law', 'arcane laboratory',
  'rest in peace', 'grafdigger\'s cage', 'torpor orb',
  'hullbreaker horror', 'drannith magistrate', 'opposition agent',
  'narset, parter of veils', 'notion thief', 'grand arbiter augustin iv',
  'blood moon', 'back to basics', 'contamination',
]);

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface BracketResult {
  bracket: number; // 1-5
  label: string;
  gameChangers: string[];
  gameChangerCount: number;
  signals: BracketSignal[];
  summary: string;
  downgradeHints: string[];
}

export interface BracketSignal {
  category: string;
  cards: string[];
  impact: string;
}

export function calculateBracket(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): BracketResult {
  const allEntries = [
    ...deck.boards.commander,
    ...deck.boards.mainboard,
    ...deck.boards.sideboard,
  ];

  const cardNames = allEntries.map((e) => normalizeKey(e.name));
  const signals: BracketSignal[] = [];
  const downgradeHints: string[] = [];

  // 1. Count game changers
  const gameChangers = cardNames.filter((n) => GAME_CHANGERS.has(n));
  const gameChangerOriginal = allEntries
    .filter((e) => GAME_CHANGERS.has(normalizeKey(e.name)))
    .map((e) => e.name);
  const gcCount = gameChangers.length;

  if (gcCount > 0) {
    signals.push({
      category: 'Game Changers',
      cards: gameChangerOriginal,
      impact: gcCount <= 3 ? 'Bracket 3+' : 'Bracket 4+',
    });
  }

  // 2. Fast mana
  const fastManaCards = allEntries.filter((e) => FAST_MANA.has(normalizeKey(e.name)));
  if (fastManaCards.length > 0) {
    signals.push({
      category: 'Fast Mana',
      cards: fastManaCards.map((e) => e.name),
      impact: fastManaCards.length >= 3 ? 'Bracket 4+' : 'Bracket 3+',
    });
  }

  // 3. Mass land destruction
  const mldCards = allEntries.filter((e) => MASS_LAND_DESTRUCTION.has(normalizeKey(e.name)));
  if (mldCards.length > 0) {
    signals.push({
      category: 'Mass Land Destruction',
      cards: mldCards.map((e) => e.name),
      impact: 'Bracket 4+',
    });
    downgradeHints.push(`Remove ${mldCards.map((c) => c.name).join(', ')} to avoid Bracket 4+`);
  }

  // 4. Extra turns
  const extraTurnCards = allEntries.filter((e) => EXTRA_TURNS.has(normalizeKey(e.name)));
  if (extraTurnCards.length > 0) {
    signals.push({
      category: 'Extra Turns',
      cards: extraTurnCards.map((e) => e.name),
      impact: extraTurnCards.length >= 2 ? 'Bracket 3+' : 'Bracket 2+',
    });
  }

  // 5. Stax pieces
  const staxCards = allEntries.filter((e) => STAX_PIECES.has(normalizeKey(e.name)));
  if (staxCards.length >= 3) {
    signals.push({
      category: 'Stax Package',
      cards: staxCards.map((e) => e.name),
      impact: staxCards.length >= 5 ? 'Bracket 4+' : 'Bracket 3+',
    });
  }

  // 6. Detect infinite combos heuristically (2-card combos)
  const oracleTexts = new Map<string, string>();
  for (const entry of allEntries) {
    const card = cardByName[normalizeKey(entry.name)];
    if (card?.oracle_text) oracleTexts.set(normalizeKey(entry.name), card.oracle_text.toLowerCase());
  }

  let hasInfiniteComboSignal = false;
  const infiniteIndicators = ['infinite', 'untap all', 'take an extra turn', 'repeat this process'];
  for (const [name, text] of oracleTexts) {
    if (infiniteIndicators.some((ind) => text.includes(ind))) {
      hasInfiniteComboSignal = true;
      break;
    }
  }

  // Also check for known infinite enablers
  const infiniteEnablers = new Set([
    'deadeye navigator', 'peregrine drake', 'palinchron', 'great whale',
    'worldgorger dragon', 'animate dead', 'kiki-jiki, mirror breaker',
    'splinter twin', 'exquisite blood', 'sanguine bond',
    'dualcaster mage', 'ghostly flicker', 'isochron scepter',
    'dramatic reversal', 'basalt monolith', 'rings of brighthearth',
  ]);
  const infiniteEnablersFound = allEntries.filter((e) => infiniteEnablers.has(normalizeKey(e.name)));
  if (infiniteEnablersFound.length >= 2) {
    hasInfiniteComboSignal = true;
    signals.push({
      category: 'Infinite Combo Potential',
      cards: infiniteEnablersFound.map((e) => e.name),
      impact: 'Bracket 4+',
    });
  }

  // 7. Average CMC analysis (low CMC = more optimized)
  let totalCmc = 0;
  let nonlandCount = 0;
  for (const entry of allEntries) {
    const card = cardByName[normalizeKey(entry.name)];
    if (!card) continue;
    const typeLine = (card.type_line || '').toLowerCase();
    if (!typeLine.includes('land')) {
      totalCmc += (card.cmc || 0) * entry.qty;
      nonlandCount += entry.qty;
    }
  }
  const avgCmc = nonlandCount > 0 ? totalCmc / nonlandCount : 3;

  // 8. Tutor density
  const tutorKeywords = ['search your library', 'tutor'];
  let tutorCount = 0;
  for (const [, text] of oracleTexts) {
    if (tutorKeywords.some((kw) => text.includes(kw))) tutorCount++;
  }
  if (tutorCount >= 5) {
    signals.push({
      category: 'High Tutor Density',
      cards: [],
      impact: 'Bracket 3+',
    });
  }

  // === Calculate final bracket ===
  let bracket = 1;

  // Bracket 2: Has some optimization (lower CMC, some value engines)
  if (avgCmc < 3.5 || tutorCount >= 2 || allEntries.length >= 90) {
    bracket = Math.max(bracket, 2);
  }

  // Bracket 3: Up to 3 game changers, extra turns, some stax, tutors
  if (gcCount >= 1 || extraTurnCards.length >= 1 || staxCards.length >= 2 || tutorCount >= 4) {
    bracket = Math.max(bracket, 3);
  }

  // Bracket 4: 4+ game changers, MLD, infinite combos, heavy fast mana, heavy stax
  if (
    gcCount > 3 ||
    mldCards.length > 0 ||
    hasInfiniteComboSignal ||
    fastManaCards.length >= 3 ||
    staxCards.length >= 5 ||
    (avgCmc < 2.5 && tutorCount >= 5)
  ) {
    bracket = Math.max(bracket, 4);
  }

  // Bracket 5: cEDH signals — very low CMC + heavy tutors + fast mana + combos
  if (
    avgCmc < 2.2 &&
    tutorCount >= 6 &&
    fastManaCards.length >= 4 &&
    hasInfiniteComboSignal
  ) {
    bracket = Math.max(bracket, 5);
  }

  // Build downgrade hints
  if (bracket >= 4 && gcCount > 3) {
    const excess = gcCount - 3;
    downgradeHints.push(`Remove ${excess} Game Changer(s) to fit Bracket 3 (max 3 allowed)`);
  }
  if (bracket >= 4 && fastManaCards.length >= 3) {
    downgradeHints.push(`Reduce fast mana (${fastManaCards.map((c) => c.name).join(', ')}) to lower bracket`);
  }

  const labels: Record<number, string> = {
    1: 'Exhibition',
    2: 'Core',
    3: 'Upgraded',
    4: 'Optimized',
    5: 'cEDH',
  };

  const summaryParts: string[] = [];
  if (gcCount > 0) summaryParts.push(`${gcCount} Game Changer${gcCount > 1 ? 's' : ''}`);
  if (fastManaCards.length > 0) summaryParts.push(`${fastManaCards.length} fast mana`);
  if (mldCards.length > 0) summaryParts.push('mass LD');
  if (extraTurnCards.length > 0) summaryParts.push(`${extraTurnCards.length} extra turns`);
  if (hasInfiniteComboSignal) summaryParts.push('infinite combo');
  if (staxCards.length >= 3) summaryParts.push(`${staxCards.length} stax`);
  const summary = summaryParts.length > 0
    ? summaryParts.join(', ')
    : avgCmc > 3.5 ? 'Casual build, no red flags' : 'Clean build';

  return {
    bracket,
    label: labels[bracket] || 'Unknown',
    gameChangers: gameChangerOriginal,
    gameChangerCount: gcCount,
    signals,
    summary,
    downgradeHints,
  };
}

export function renderBracketResult(container: HTMLElement, result: BracketResult): void {
  container.textContent = '';

  // Bracket badge
  const badge = document.createElement('div');
  badge.className = 'bracket-badge';
  badge.setAttribute('data-bracket', String(result.bracket));

  const number = document.createElement('span');
  number.className = 'bracket-number';
  number.textContent = String(result.bracket);

  const label = document.createElement('span');
  label.className = 'bracket-label';
  label.textContent = result.label;

  badge.append(number, label);
  container.appendChild(badge);

  // Summary
  const summary = document.createElement('div');
  summary.className = 'bracket-summary';
  summary.textContent = result.summary;
  container.appendChild(summary);

  // Signals
  if (result.signals.length > 0) {
    const signalList = document.createElement('div');
    signalList.className = 'bracket-signals';
    for (const signal of result.signals) {
      const row = document.createElement('div');
      row.className = 'bracket-signal';

      const cat = document.createElement('span');
      cat.className = 'bracket-signal-cat';
      cat.textContent = signal.category;

      const impact = document.createElement('span');
      impact.className = 'bracket-signal-impact';
      impact.textContent = signal.impact;

      row.append(cat, impact);

      if (signal.cards.length > 0) {
        const cards = document.createElement('div');
        cards.className = 'bracket-signal-cards';
        cards.textContent = signal.cards.join(', ');
        row.appendChild(cards);
      }

      signalList.appendChild(row);
    }
    container.appendChild(signalList);
  }

  // Downgrade hints
  if (result.downgradeHints.length > 0) {
    const hints = document.createElement('div');
    hints.className = 'bracket-hints';
    const hintTitle = document.createElement('div');
    hintTitle.className = 'bracket-hints-title';
    hintTitle.textContent = 'How to lower your bracket:';
    hints.appendChild(hintTitle);

    for (const hint of result.downgradeHints) {
      const hintEl = document.createElement('div');
      hintEl.className = 'bracket-hint';
      hintEl.textContent = hint;
      hints.appendChild(hintEl);
    }
    container.appendChild(hints);
  }
}
