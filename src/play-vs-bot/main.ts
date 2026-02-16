/**
 * EDH Bot Arena — Main Entry Point.
 *
 * Handles deck selection, game initialization, and button wiring.
 */

import type { Card } from '@mtg/game-engine';
import { createSimpleCard, resetIdCounter } from '@mtg/game-engine';
import { GameLoop, type BotInterface } from './game-loop.ts';
import { MLBot, PolicyNetwork, ValueNetwork, FEATURE_DIM } from '@mtg/bot-ml';
import { listDecks } from '../deckbuilder/storage.js';
import type { DeckbuilderDeck, DeckbuilderCardEntry } from '../deckbuilder/types.js';
import { getCardImageUrl } from './card-renderer.ts';

let gameLoop: GameLoop | null = null;

// ==================== Deck Selection ====================

/** Parse a decklist from text (Arena/MTGO format) */
function parseDeckList(text: string): Card[] {
  const lines = text.trim().split('\n');
  const cards: Card[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('Sideboard') || line.startsWith('Commander')) continue;

    // Match: "1 Card Name" or "1x Card Name"
    const match = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (!match) continue;

    const count = parseInt(match[1], 10);
    const name = match[2].trim();

    for (let i = 0; i < count; i++) {
      cards.push(createSimpleCard(
        name,
        guessTypeLine(name),
        guessCost(name),
        0 as 0 | 1,
        { colors: [], colorIdentity: [] },
      ));
    }
  }

  return cards;
}

/** Guess type line from card name (basic heuristic) */
function guessTypeLine(name: string): string {
  const lower = name.toLowerCase();
  if (BASIC_LANDS.some(l => lower.includes(l))) return `Basic Land — ${name}`;
  if (lower.includes('command tower') || lower.includes('sol ring')) {
    if (lower.includes('tower')) return 'Land';
    return 'Artifact';
  }
  return 'Spell';
}

/** Guess mana cost (basic heuristic) */
function guessCost(name: string): string {
  const lower = name.toLowerCase();
  if (BASIC_LANDS.some(l => lower.includes(l))) return '';
  if (lower.includes('command tower')) return '';
  if (lower === 'sol ring') return '{1}';
  return '{2}';
}

const BASIC_LANDS = ['plains', 'island', 'swamp', 'mountain', 'forest'];

/** Convert a DeckbuilderDeck to Card[] + commander */
function deckbuilderToCards(deck: DeckbuilderDeck): { deck: Card[]; commander: Card } | null {
  const boards = deck.boards;
  if (!boards.commander.length) return null;

  const cmdEntry = boards.commander[0];
  const commander = createSimpleCard(
    cmdEntry.name,
    'Legendary Creature', // heuristic
    '{2}',
    0 as 0 | 1,
    { colors: [], colorIdentity: [] },
  );

  const cards: Card[] = [commander];

  const addEntries = (entries: DeckbuilderCardEntry[]) => {
    for (const entry of entries) {
      for (let i = 0; i < entry.qty; i++) {
        if (cards.length >= 99) return;
        cards.push(createSimpleCard(
          entry.name,
          guessTypeLine(entry.name),
          guessCost(entry.name),
          0 as 0 | 1,
          { colors: [], colorIdentity: [] },
        ));
      }
    }
  };

  addEntries(boards.mainboard);

  // Fill rest with forests if not enough cards
  while (cards.length < 99) {
    cards.push(createSimpleCard('Forest', 'Basic Land — Forest', '', 0 as 0 | 1, {
      oracleText: '{T}: Add {G}.', colors: [], colorIdentity: ['G'] as any,
    }));
  }

  return { deck: cards, commander };
}

/** Create a sample deck for quick start */
function createSampleDeck(owner: 0 | 1): { deck: Card[]; commander: Card } {
  const commander = createSimpleCard(
    owner === 0 ? 'Atraxa, Praetors\' Voice' : 'Kenrith, the Returned King',
    'Legendary Creature — Phyrexian Angel Horror',
    owner === 0 ? '{G}{W}{U}{B}' : '{4}{W}',
    owner,
    {
      power: owner === 0 ? '4' : '5',
      toughness: owner === 0 ? '4' : '5',
      colors: owner === 0 ? ['G', 'W', 'U', 'B'] : ['W'],
      colorIdentity: owner === 0 ? ['G', 'W', 'U', 'B'] : ['W', 'U', 'B', 'R', 'G'],
    },
  );

  const cards: Card[] = [commander];

  // Lands (37)
  const lands = [
    'Command Tower', 'Sol Ring', 'Arcane Signet',
    'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest',
    'Island', 'Island', 'Island', 'Island', 'Island', 'Island',
    'Plains', 'Plains', 'Plains', 'Plains', 'Plains',
    'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp',
    'Mountain', 'Mountain', 'Mountain', 'Mountain',
  ];

  for (const name of lands) {
    const lower = name.toLowerCase();
    if (BASIC_LANDS.some(l => lower === l)) {
      cards.push(createSimpleCard(name, `Basic Land — ${name}`, '', owner, {
        oracleText: `{T}: Add {${name[0]}}.`,
        colors: [],
        colorIdentity: [name[0].toUpperCase() === 'P' ? 'W' : name[0].toUpperCase() === 'I' ? 'U' : name[0].toUpperCase() === 'S' ? 'B' : name[0].toUpperCase() === 'M' ? 'R' : 'G'] as any,
      }));
    } else if (lower === 'command tower') {
      cards.push(createSimpleCard(name, 'Land', '', owner, {
        oracleText: '{T}: Add one mana of any color in your commander\'s color identity.',
        colors: [], colorIdentity: [],
      }));
    } else if (lower === 'sol ring') {
      cards.push(createSimpleCard(name, 'Artifact', '{1}', owner, {
        oracleText: '{T}: Add {C}{C}.', colors: [], colorIdentity: [],
        tags: ['fast-mana', 'ramp'],
      }));
    } else if (lower === 'arcane signet') {
      cards.push(createSimpleCard(name, 'Artifact', '{2}', owner, {
        oracleText: '{T}: Add one mana of any color in your commander\'s color identity.',
        colors: [], colorIdentity: [], tags: ['ramp'],
      }));
    }
  }

  // Fill remaining slots with basic creatures and spells
  const filler = [
    { name: 'Llanowar Elves', type: 'Creature — Elf Druid', cost: '{G}', p: '1', t: '1', tags: ['mana-dork', 'ramp'] as any },
    { name: 'Birds of Paradise', type: 'Creature — Bird', cost: '{G}', p: '0', t: '1', tags: ['mana-dork', 'ramp'] as any },
    { name: 'Swords to Plowshares', type: 'Instant', cost: '{W}', tags: ['removal'] as any },
    { name: 'Counterspell', type: 'Instant', cost: '{U}{U}', tags: ['counter'] as any },
    { name: 'Cultivate', type: 'Sorcery', cost: '{2}{G}', tags: ['ramp'] as any },
    { name: 'Kodama\'s Reach', type: 'Sorcery', cost: '{2}{G}', tags: ['ramp'] as any },
    { name: 'Rhystic Study', type: 'Enchantment', cost: '{2}{U}', tags: ['draw', 'engine'] as any },
    { name: 'Smothering Tithe', type: 'Enchantment', cost: '{3}{W}', tags: ['ramp', 'engine'] as any },
    { name: 'Beast Within', type: 'Instant', cost: '{2}{G}', tags: ['removal'] as any },
    { name: 'Path to Exile', type: 'Instant', cost: '{W}', tags: ['removal'] as any },
    { name: 'Wrath of God', type: 'Sorcery', cost: '{2}{W}{W}', tags: ['wipe'] as any },
    { name: 'Heroic Intervention', type: 'Instant', cost: '{1}{G}', tags: ['protection'] as any },
    { name: 'Eternal Witness', type: 'Creature — Human Shaman', cost: '{1}{G}{G}', p: '2', t: '1', tags: ['recursion'] as any },
    { name: 'Sun Titan', type: 'Creature — Giant', cost: '{4}{W}{W}', p: '6', t: '6', tags: ['recursion'] as any },
    { name: 'Mulldrifter', type: 'Creature — Elemental', cost: '{4}{U}', p: '2', t: '2', tags: ['draw'] as any },
    { name: 'Sakura-Tribe Elder', type: 'Creature — Snake Shaman', cost: '{1}{G}', p: '1', t: '1', tags: ['ramp'] as any },
    { name: 'Solemn Simulacrum', type: 'Artifact Creature — Golem', cost: '{4}', p: '2', t: '2', tags: ['ramp', 'draw'] as any },
  ];

  for (const f of filler) {
    if (cards.length >= 99) break;
    cards.push(createSimpleCard(f.name, f.type, f.cost, owner, {
      power: f.p, toughness: f.t, colors: [], colorIdentity: [], tags: f.tags,
    }));
  }

  // Fill rest with forests
  while (cards.length < 99) {
    cards.push(createSimpleCard('Forest', 'Basic Land — Forest', '', owner, {
      oracleText: '{T}: Add {G}.', colors: [], colorIdentity: ['G'] as any,
    }));
  }

  return { deck: cards, commander };
}

// ==================== ML Bot Loading ====================

/** Check if trained ML model exists in localStorage */
function hasTrainedMLModel(): boolean {
  // TF.js saves models with key pattern: tensorflowjs_models/<name>/info
  return localStorage.getItem('tensorflowjs_models/mlbot-policy/info') !== null
    && localStorage.getItem('tensorflowjs_models/mlbot-value/info') !== null;
}

/** Load a trained ML bot from localStorage */
async function loadMLBot(player: 0 | 1): Promise<MLBot | null> {
  if (!hasTrainedMLModel()) return null;

  try {
    const policyNet = await PolicyNetwork.loadFromLocalStorage('mlbot-policy');
    const valueNet = await ValueNetwork.loadFromLocalStorage('mlbot-value');
    return new MLBot(player, policyNet, valueNet, 0.3); // low temperature = exploitation
  } catch (e) {
    console.warn('[EDH Bot Arena] Failed to load ML bot weights:', e);
    return null;
  }
}

// ==================== Game Initialization ====================

async function initGame(deckText?: string, savedDeck?: DeckbuilderDeck): Promise<void> {
  resetIdCounter();

  let playerDeck: Card[];
  let playerCommander: Card;

  if (savedDeck) {
    // Load from deckbuilder storage
    const converted = deckbuilderToCards(savedDeck);
    if (converted) {
      playerDeck = converted.deck;
      playerCommander = converted.commander;
    } else {
      alert('Deck has no commander. Using sample deck.');
      const sample = createSampleDeck(0);
      playerDeck = sample.deck;
      playerCommander = sample.commander;
    }
  } else if (deckText && deckText.trim().length > 10) {
    const parsed = parseDeckList(deckText);
    if (parsed.length < 10) {
      alert('Could not parse enough cards from the decklist. Using sample deck.');
      const sample = createSampleDeck(0);
      playerDeck = sample.deck;
      playerCommander = sample.commander;
    } else {
      playerCommander = parsed[0];
      playerDeck = parsed;
    }
  } else {
    const sample = createSampleDeck(0);
    playerDeck = sample.deck;
    playerCommander = sample.commander;
  }

  const botSample = createSampleDeck(1);

  // Determine which bot to use
  const botType = (document.querySelector('input[name="bot-type"]:checked') as HTMLInputElement)?.value ?? 'heuristic';
  let bot: BotInterface | undefined;

  if (botType === 'ml') {
    try {
      const mlBot = await loadMLBot(1);
      if (mlBot) {
        bot = mlBot;
      } else {
        alert('No trained ML model found. Train the bot first!\nUsing Heuristic Bot as fallback.');
      }
    } catch (e) {
      console.warn('[EDH Bot Arena] ML bot load failed:', e);
      alert('Failed to load ML bot. Using Heuristic Bot as fallback.');
    }
  }

  // Hide deck selector, show game
  const deckOverlay = document.getElementById('deck-overlay');
  if (deckOverlay) deckOverlay.classList.add('hidden');

  gameLoop = new GameLoop(playerDeck, botSample.deck, playerCommander, botSample.commander, bot);

  // Wire up buttons
  wireButtons();

  // Handle mulligan
  await gameLoop.handleMulligan();

  // Start game loop
  await gameLoop.start();
}

function wireButtons(): void {
  if (!gameLoop) return;

  document.getElementById('btn-pass')?.addEventListener('click', () => gameLoop?.pass());
  document.getElementById('btn-end-turn')?.addEventListener('click', () => gameLoop?.endTurn());
  document.getElementById('btn-undo')?.addEventListener('click', () => gameLoop?.undo());
  document.getElementById('btn-concede')?.addEventListener('click', () => {
    if (confirm('Are you sure you want to concede?')) {
      gameLoop?.concede();
    }
  });
}

// ==================== Entry Point ====================

document.addEventListener('DOMContentLoaded', () => {
  // Quick-start button (import text)
  document.getElementById('btn-start-import')?.addEventListener('click', () => {
    const textarea = document.getElementById('deck-import') as HTMLTextAreaElement | null;
    const text = textarea?.value ?? '';
    initGame(text);
  });

  // Populate deck grid with saved decks + prebuilt options
  const deckGrid = document.getElementById('deck-grid');
  if (deckGrid) {
    // Load saved decks from deckbuilder storage
    let savedDecks: DeckbuilderDeck[] = [];
    try {
      savedDecks = listDecks();
    } catch {
      // Storage may not be available
    }

    // Show saved decks that have a commander
    for (const deck of savedDecks) {
      if (!deck.boards.commander.length) continue;

      const option = document.createElement('div');
      option.className = 'pvb-deck-option';

      const cmdName = deck.boards.commander[0].name;
      const img = document.createElement('img');
      img.src = getCardImageUrl(cmdName, 'small');
      img.alt = cmdName;
      img.loading = 'lazy';
      option.appendChild(img);

      const nameEl = document.createElement('div');
      nameEl.className = 'pvb-deck-name';
      nameEl.textContent = deck.name;
      option.appendChild(nameEl);

      const cmdEl = document.createElement('div');
      cmdEl.className = 'pvb-deck-commander';
      cmdEl.textContent = cmdName;
      option.appendChild(cmdEl);

      const cardCount = document.createElement('div');
      cardCount.className = 'pvb-deck-commander';
      const total = deck.boards.commander.reduce((s, c) => s + c.qty, 0)
        + deck.boards.mainboard.reduce((s, c) => s + c.qty, 0);
      cardCount.textContent = `${total} cards`;
      option.appendChild(cardCount);

      option.addEventListener('click', () => initGame(undefined, deck));
      deckGrid.appendChild(option);
    }

    // Prebuilt sample decks
    const prebuilt = [
      { name: 'Atraxa Superfriends', commander: 'Atraxa, Praetors\' Voice', colors: 'GWUB' },
      { name: 'Kenrith Politics', commander: 'Kenrith, the Returned King', colors: 'WUBRG' },
    ];

    for (const deck of prebuilt) {
      const option = document.createElement('div');
      option.className = 'pvb-deck-option';

      const img = document.createElement('img');
      img.src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(deck.commander)}&format=image&version=small`;
      img.alt = deck.commander;
      img.loading = 'lazy';
      option.appendChild(img);

      const nameEl = document.createElement('div');
      nameEl.className = 'pvb-deck-name';
      nameEl.textContent = deck.name;
      option.appendChild(nameEl);

      const cmdEl = document.createElement('div');
      cmdEl.className = 'pvb-deck-commander';
      cmdEl.textContent = deck.commander;
      option.appendChild(cmdEl);

      const sampleTag = document.createElement('div');
      sampleTag.className = 'pvb-deck-commander';
      sampleTag.textContent = 'Sample Deck';
      sampleTag.style.color = 'var(--gold)';
      option.appendChild(sampleTag);

      option.addEventListener('click', () => initGame());
      deckGrid.appendChild(option);
    }

    // Show message if no decks found
    if (savedDecks.filter(d => d.boards.commander.length > 0).length === 0) {
      const hint = document.createElement('div');
      hint.style.cssText = 'grid-column: 1 / -1; text-align: center; color: var(--text-dim); font-size: 0.78rem; padding: 0.5rem;';
      hint.textContent = 'Your saved decks from the Deckbuilder will appear here.';
      deckGrid.insertBefore(hint, deckGrid.firstChild);
    }
  }

  // Check if ML model is trained and update badge
  const mlBadge = document.getElementById('ml-bot-badge');
  if (mlBadge) {
    if (hasTrainedMLModel()) {
      mlBadge.textContent = 'Trained \u2713';
      mlBadge.className = 'pvb-bot-badge trained';
    } else {
      mlBadge.textContent = 'Not trained';
      mlBadge.className = 'pvb-bot-badge untrained';
    }
  }

  console.log('[EDH Bot Arena] Ready');
});
