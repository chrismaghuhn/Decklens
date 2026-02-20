/**
 * EDH Bot Arena — Main Entry Point.
 *
 * Handles deck selection, game initialization, and button wiring.
 * Also handles multiplayer mode via MultiplayerClient (Phase 5).
 */

import type { Card } from '@mtg/game-engine';
import { createSimpleCard, resetIdCounter } from '@mtg/game-engine';
import { GameLoop, type BotInterface } from './game-loop.ts';
import { MLBot, PolicyNetwork, ValueNetwork, FEATURE_DIM } from '@mtg/bot-ml';
import { listDecks } from '../deckbuilder/storage.js';
import type { DeckbuilderDeck, DeckbuilderCardEntry } from '../deckbuilder/types.js';
import { getCardImageUrl } from './card-renderer.ts';
import { resolveCardNames, validateEDHDeck, type ProgressCallback } from './card-resolver.ts';
import { MultiplayerClient, createGameSession, type SeatInfo, type GameStateView } from './mp-client.ts';

let gameLoop: GameLoop | null = null;
let mpClient: MultiplayerClient | null = null;

// ==================== Deck Selection ====================

/** Parse a decklist from text (Arena/MTGO format) into name+qty pairs */
function parseDeckListNames(text: string): { name: string; qty: number }[] {
  const lines = text.trim().split('\n');
  const entries: { name: string; qty: number }[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('Sideboard') || line.startsWith('Commander')) continue;

    // Match: "1 Card Name" or "1x Card Name"
    const match = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (!match) continue;

    const count = parseInt(match[1], 10);
    const name = match[2].trim();
    entries.push({ name, qty: count });
  }

  return entries;
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

/** Convert a DeckbuilderDeck to Card[] + commander using Scryfall data */
async function deckbuilderToCards(
  deck: DeckbuilderDeck,
  onProgress?: ProgressCallback,
): Promise<{ deck: Card[]; commander: Card; warnings: string[] } | null> {
  const boards = deck.boards;
  if (!boards.commander.length) return null;

  // Collect all card names (with quantities) for bulk resolution
  const allNames: string[] = [];
  // Commander first
  allNames.push(boards.commander[0].name);
  // Then mainboard
  for (const entry of boards.mainboard) {
    for (let i = 0; i < entry.qty; i++) {
      if (allNames.length >= 100) break;
      allNames.push(entry.name);
    }
  }

  // Fill remaining with forests if deck is too small
  while (allNames.length < 100) {
    allNames.push('Forest');
  }

  // Resolve all card names via Scryfall (with cache)
  const { cards, notFound } = await resolveCardNames(allNames, 0, onProgress);

  const commander = cards[0];
  const deckCards = cards.slice(1);

  // Validate
  const validation = validateEDHDeck(deckCards, commander);
  const warnings = [...validation.warnings];
  if (notFound.length > 0) {
    warnings.push(`${notFound.length} cards not found on Scryfall: ${notFound.slice(0, 3).join(', ')}${notFound.length > 3 ? '...' : ''}`);
  }

  return { deck: deckCards, commander, warnings };
}

/** Convert text decklist to Card[] + commander using Scryfall data */
async function textDeckToCards(
  text: string,
  onProgress?: ProgressCallback,
): Promise<{ deck: Card[]; commander: Card; warnings: string[] } | null> {
  const entries = parseDeckListNames(text);
  if (entries.length < 5) return null;

  // Expand quantities into flat name list
  const allNames: string[] = [];
  for (const entry of entries) {
    for (let i = 0; i < entry.qty; i++) {
      allNames.push(entry.name);
    }
  }

  if (allNames.length < 10) return null;

  // Resolve via Scryfall
  const { cards, notFound } = await resolveCardNames(allNames, 0, onProgress);

  // First card is commander
  const commander = cards[0];
  const deckCards = cards.slice(1);

  const warnings: string[] = [];
  if (notFound.length > 0) {
    warnings.push(`${notFound.length} cards not found: ${notFound.slice(0, 3).join(', ')}`);
  }

  return { deck: deckCards, commander, warnings };
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

// ==================== Loading UI ====================

function showLoadingOverlay(): HTMLElement {
  let overlay = document.getElementById('card-loading-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'card-loading-overlay';
  overlay.innerHTML = `
    <div class="card-loading-content">
      <div class="card-loading-icon">&#9876;</div>
      <h3>Forging Your Deck</h3>
      <p id="card-loading-status">Loading card data...</p>
      <div class="card-loading-bar-bg">
        <div class="card-loading-bar-fill" id="card-loading-bar"></div>
      </div>
      <p class="card-loading-sub" id="card-loading-detail"></p>
    </div>
  `;
  document.body.appendChild(overlay);

  // Inject styles once
  if (!document.getElementById('card-loading-styles')) {
    const style = document.createElement('style');
    style.id = 'card-loading-styles';
    style.textContent = `
      #card-loading-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(10, 14, 23, 0.92);
        display: flex; align-items: center; justify-content: center;
        z-index: 2000; animation: fadeIn 0.3s ease;
      }
      .card-loading-content {
        background: linear-gradient(135deg, #1a1f2e, #0f1623);
        border: 1px solid rgba(201, 168, 76, 0.3);
        border-radius: 16px; padding: 32px 40px;
        text-align: center; max-width: 380px; width: 90%;
        font-family: 'Outfit', sans-serif; color: #e2e8f0;
      }
      .card-loading-icon {
        font-size: 2.5rem; margin-bottom: 8px;
        animation: pulse 1.5s ease-in-out infinite;
      }
      .card-loading-content h3 {
        color: #c9a84c; font-family: 'Cinzel', serif;
        font-size: 1.2rem; margin: 0 0 12px;
      }
      #card-loading-status {
        font-size: 0.9rem; margin: 0 0 16px; color: #94a3b8;
      }
      .card-loading-bar-bg {
        width: 100%; height: 6px; background: rgba(201, 168, 76, 0.15);
        border-radius: 3px; overflow: hidden;
      }
      .card-loading-bar-fill {
        height: 100%; width: 0%; border-radius: 3px;
        background: linear-gradient(90deg, #c9a84c, #e8d48b);
        transition: width 0.3s ease;
      }
      .card-loading-sub {
        font-size: 0.75rem; color: #64748b; margin: 10px 0 0;
      }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
    `;
    document.head.appendChild(style);
  }

  return overlay;
}

function updateLoadingProgress(resolved: number, total: number, status: string): void {
  const bar = document.getElementById('card-loading-bar');
  const statusEl = document.getElementById('card-loading-status');
  const detailEl = document.getElementById('card-loading-detail');
  if (bar) bar.style.width = `${Math.round((resolved / Math.max(total, 1)) * 100)}%`;
  if (statusEl) statusEl.textContent = status;
  if (detailEl) detailEl.textContent = `${resolved} / ${total} cards`;
}

function hideLoadingOverlay(): void {
  document.getElementById('card-loading-overlay')?.remove();
}

// ==================== Game Initialization ====================

async function initGame(deckText?: string, savedDeck?: DeckbuilderDeck): Promise<void> {
  resetIdCounter();

  let playerDeck: Card[];
  let playerCommander: Card;
  let warnings: string[] = [];

  // Show loading overlay
  showLoadingOverlay();

  try {
    if (savedDeck) {
      // Load from deckbuilder storage with Scryfall resolution
      const converted = await deckbuilderToCards(savedDeck, updateLoadingProgress);
      if (converted) {
        playerDeck = converted.deck;
        playerCommander = converted.commander;
        warnings = converted.warnings;
      } else {
        updateLoadingProgress(100, 100, 'No commander found, using sample deck...');
        const sample = createSampleDeck(0);
        playerDeck = sample.deck;
        playerCommander = sample.commander;
      }
    } else if (deckText && deckText.trim().length > 10) {
      // Parse text and resolve via Scryfall
      const converted = await textDeckToCards(deckText, updateLoadingProgress);
      if (converted) {
        playerDeck = converted.deck;
        playerCommander = converted.commander;
        warnings = converted.warnings;
      } else {
        updateLoadingProgress(100, 100, 'Could not parse deck, using sample...');
        const sample = createSampleDeck(0);
        playerDeck = sample.deck;
        playerCommander = sample.commander;
      }
    } else {
      // Sample deck — also resolve via Scryfall for real card data
      updateLoadingProgress(0, 100, 'Loading sample deck from Scryfall...');
      const sample = await resolveSampleDeck(0, updateLoadingProgress);
      playerDeck = sample.deck;
      playerCommander = sample.commander;
    }

    // Also resolve bot deck via Scryfall
    updateLoadingProgress(80, 100, 'Loading bot deck...');
    const botSample = await resolveSampleDeck(1, (r, t, s) => {
      updateLoadingProgress(80 + Math.round((r / Math.max(t, 1)) * 20), 100, s);
    });

    updateLoadingProgress(100, 100, 'Ready!');
  } catch (err) {
    console.warn('[EDH Bot Arena] Scryfall resolution failed, falling back:', err);
    updateLoadingProgress(100, 100, 'Scryfall unavailable, using fallback data...');
    // Fallback to old heuristic system
    const sample = createSampleDeck(0);
    playerDeck = sample.deck;
    playerCommander = sample.commander;
    var botSample = createSampleDeck(1);
  }

  // Show warnings if any
  if (warnings.length > 0) {
    console.warn('[EDH Bot Arena] Deck warnings:', warnings);
  }

  // Hide loading overlay
  hideLoadingOverlay();

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

  // Hide deck selector, show game — activate game layout
  document.body.classList.add('game-active');
  const deckOverlay = document.getElementById('deck-overlay');
  if (deckOverlay) deckOverlay.classList.add('hidden');

  // Use resolved bot deck or fallback
  const botDeck = typeof botSample !== 'undefined' ? botSample : createSampleDeck(1);

  gameLoop = new GameLoop(playerDeck!, botDeck.deck, playerCommander!, botDeck.commander, bot);

  // Wire up buttons
  wireButtons();

  // Handle mulligan
  await gameLoop.handleMulligan();

  // Start game loop
  await gameLoop.start();
}

/** Resolve the sample deck via Scryfall for real card data */
async function resolveSampleDeck(
  owner: 0 | 1,
  onProgress?: ProgressCallback,
): Promise<{ deck: Card[]; commander: Card }> {
  const cmdName = owner === 0 ? "Atraxa, Praetors' Voice" : 'Kenrith, the Returned King';

  const sampleNames = [
    cmdName,
    'Command Tower', 'Sol Ring', 'Arcane Signet',
    'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest',
    'Island', 'Island', 'Island', 'Island', 'Island', 'Island',
    'Plains', 'Plains', 'Plains', 'Plains', 'Plains',
    'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp',
    'Mountain', 'Mountain', 'Mountain', 'Mountain',
    'Llanowar Elves', 'Birds of Paradise', 'Swords to Plowshares',
    'Counterspell', 'Cultivate', "Kodama's Reach",
    'Rhystic Study', 'Smothering Tithe', 'Beast Within',
    'Path to Exile', 'Wrath of God', 'Heroic Intervention',
    'Eternal Witness', 'Sun Titan', 'Mulldrifter',
    'Sakura-Tribe Elder', 'Solemn Simulacrum',
  ];

  // Fill to 100
  while (sampleNames.length < 100) {
    sampleNames.push('Forest');
  }

  try {
    const { cards } = await resolveCardNames(sampleNames, owner, onProgress);
    return { deck: cards.slice(1), commander: cards[0] };
  } catch {
    // Fallback to hardcoded sample
    return createSampleDeck(owner);
  }
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

// ==================== Multiplayer — UI Helpers ====================

/** Hide the mode selection screen */
function hideModeScreen(): void {
  const el = document.getElementById('mode-screen');
  if (el) el.style.display = 'none';
}

/** Show the lobby screen */
function showLobbyScreen(): void {
  hideModeScreen();
  const el = document.getElementById('lobby-screen');
  if (el) el.style.display = 'flex';
}

/** Hide the lobby screen */
function hideLobbyScreen(): void {
  const el = document.getElementById('lobby-screen');
  if (el) el.style.display = 'none';
}

/** Show the join-code dialog, optionally pre-filling the code */
function showJoinDialog(prefill?: string): void {
  const dialog = document.getElementById('join-dialog');
  if (dialog) dialog.style.display = 'flex';

  const input = document.getElementById('join-code-input') as HTMLInputElement | null;
  if (input) {
    if (prefill) input.value = prefill.toUpperCase();
    setTimeout(() => input.focus(), 50);
  }
}

/** Hide the join-code dialog */
function hideJoinDialog(): void {
  const dialog = document.getElementById('join-dialog');
  if (dialog) dialog.style.display = 'none';
}

/** Set the session code display in the lobby header */
function setSessionCodeDisplay(code: string): void {
  const el = document.getElementById('session-code-text');
  if (el) el.textContent = code;
}

/** Rebuild the seat grid from a SeatInfo[] array */
function updateLobbyUI(seats: SeatInfo[]): void {
  const grid = document.getElementById('seat-grid');
  if (!grid) return;

  grid.innerHTML = '';

  for (const s of seats) {
    const card = document.createElement('div');

    let classes = 'seat-card';
    let icon = '🪑';
    let name = 'Empty';
    let badge = 'Waiting for player...';
    let badgeClass = 'seat-badge';

    if (s.playerName) {
      const isMe = mpClient !== null && s.seat === mpClient.seat;
      if (s.isBot) {
        classes += ' seat-card bot';
        icon = '🤖';
      } else if (isMe) {
        classes += ' seat-card you';
        icon = '⭐';
      } else {
        classes += ' seat-card occupied';
        icon = '🧙';
      }

      name = s.playerName;

      if (s.ready) {
        badge = s.isBot ? 'Bot · Ready' : (isMe ? 'You · Ready' : 'Ready');
        badgeClass = 'seat-badge ready';
      } else {
        badge = s.isBot ? 'Bot' : (isMe ? 'You · Not ready' : (s.connected ? 'Connected' : 'Disconnected'));
      }
    } else {
      classes += ' seat-card empty';
    }

    card.className = classes;
    card.innerHTML = `
      <div class="seat-icon">${icon}</div>
      <div class="seat-name">${name}</div>
      <div class="${badgeClass}">Seat ${s.seat + 1} · ${badge}</div>
    `;

    grid.appendChild(card);
  }
}

/** Get the next empty (non-bot, non-player) seat index, or -1 if none */
function nextEmptySeat(seats: SeatInfo[]): number {
  const empty = seats.find(s => s.playerName === null && !s.isBot);
  return empty ? empty.seat : -1;
}

/** Get the deck JSON string for the current player's deck (from textarea or saved deck) */
function getCurrentDeckJson(): string {
  // Try to get from the import textarea
  const textarea = document.getElementById('deck-import') as HTMLTextAreaElement | null;
  const text = textarea?.value?.trim() ?? '';
  if (text.length > 10) {
    return text; // Arena/MTGO format — server can parse this
  }
  // Return empty JSON — server will use a placeholder deck
  return '{}';
}

/** Get a player name (from localStorage or a default) */
function getPlayerName(): string {
  try {
    const stored = localStorage.getItem('decklens-player-name');
    if (stored) return stored;
  } catch { /* ignore */ }
  return `Player${Math.floor(Math.random() * 9000) + 1000}`;
}

/** Show the MP status banner */
function showMpStatus(text: string, connected: boolean): void {
  const banner = document.getElementById('mp-status-banner');
  const dot = document.getElementById('mp-status-dot');
  const textEl = document.getElementById('mp-status-text');
  if (banner) banner.classList.add('visible');
  if (dot) dot.className = `mp-status-dot${connected ? '' : ' disconnected'}`;
  if (textEl) textEl.textContent = text;
}

/** Update the MP game panel in the sidebar with current player states */
function updateMpGamePanel(state: GameStateView): void {
  const panel = document.getElementById('mp-game-panel');
  if (panel) panel.style.display = 'block';

  const list = document.getElementById('mp-player-list');
  if (!list) return;

  list.innerHTML = '';

  for (const p of state.players) {
    const row = document.createElement('div');
    const isActive = p.id === state.activePlayer;
    const isMe = mpClient !== null && p.id === mpClient.seat;
    const isElim = p.eliminated;

    row.className = [
      'mp-player-row',
      isActive ? 'active-player' : '',
      isMe ? 'you-marker' : '',
    ].filter(Boolean).join(' ');

    if (isElim) row.style.opacity = '0.4';

    row.innerHTML = `
      <span>${p.name}${isMe ? ' (you)' : ''}${isElim ? ' 💀' : ''}</span>
      <span class="mp-player-life">${p.life} ♥</span>
    `;

    list.appendChild(row);
  }
}

// ==================== Multiplayer — Core Functions ====================

let _lastSeats: SeatInfo[] = [];

/** Host a new multiplayer game session */
async function createAndHostGame(): Promise<void> {
  const hostBtn = document.getElementById('btn-mp-host') as HTMLButtonElement | null;
  if (hostBtn) { hostBtn.disabled = true; hostBtn.textContent = 'Creating...'; }

  try {
    const sessionId = await createGameSession();

    // Tear down any existing client
    if (mpClient) {
      mpClient.disconnect();
      mpClient = null;
    }

    mpClient = new MultiplayerClient(sessionId);

    // Show lobby
    showLobbyScreen();
    setSessionCodeDisplay(sessionId);

    // Wire lobby events
    _wireMpClientEvents(mpClient);

    // Connect
    const playerName = getPlayerName();
    const deckJson = getCurrentDeckJson();
    mpClient.connect(playerName, deckJson);

  } catch (err) {
    console.error('[MP] Failed to create session:', err);
    alert(`Failed to create game session: ${err instanceof Error ? err.message : String(err)}`);
    if (hostBtn) { hostBtn.disabled = false; hostBtn.textContent = 'Host Game'; }
  }
}

/** Join an existing multiplayer game session by code */
async function joinGame(code: string): Promise<void> {
  const clean = code.trim().toUpperCase();
  if (clean.length < 3) {
    alert('Please enter a valid session code.');
    return;
  }

  // Tear down any existing client
  if (mpClient) {
    mpClient.disconnect();
    mpClient = null;
  }

  mpClient = new MultiplayerClient(clean);

  hideJoinDialog();
  showLobbyScreen();
  setSessionCodeDisplay(clean);

  _wireMpClientEvents(mpClient);

  const playerName = getPlayerName();
  const deckJson = getCurrentDeckJson();
  mpClient.connect(playerName, deckJson);
}

/** Wire all event listeners on a MultiplayerClient instance */
function _wireMpClientEvents(client: MultiplayerClient): void {
  client.addEventListener('lobby-update', (ev) => {
    const { seats } = (ev as CustomEvent<{ seats: SeatInfo[] }>).detail;
    _lastSeats = seats;
    updateLobbyUI(seats);
    // Keep session code updated from server
    // (sessionCode is already set from the client's sessionId)
  });

  client.addEventListener('game-started', (ev) => {
    const { yourSeat, playerCount } = (ev as CustomEvent<{ yourSeat: number; playerCount: number }>).detail;

    // Transition from lobby to a simple MP game view
    hideLobbyScreen();

    // Activate game layout (locks body overflow)
    document.body.classList.add('game-active');

    // Show the game container but replace topbar labels for MP context
    const gameContainer = document.getElementById('game-container');
    if (gameContainer) gameContainer.style.display = 'grid';

    // Hide solo-mode overlays (deck overlay should already be hidden)
    const deckOverlay = document.getElementById('deck-overlay');
    if (deckOverlay) deckOverlay.classList.add('hidden');

    // Show MP status
    showMpStatus(`MP Game · ${playerCount} players · Seat ${yourSeat + 1}`, true);

    // Show MP game panel
    const panel = document.getElementById('mp-game-panel');
    if (panel) panel.style.display = 'block';

    console.log(`[MP] Game started! You are seat ${yourSeat} of ${playerCount}`);

    // Request a state sync immediately
    client.requestSync();
  });

  client.addEventListener('state-update', (ev) => {
    const state = (ev as CustomEvent<GameStateView>).detail;

    // Update MP game panel
    updateMpGamePanel(state);

    // Update top-bar displays with MP state
    _updateTopBarFromMpState(state);

    // Append new log entries
    _appendMpLogEntries(state.log);

    // If game is over, show result
    if (state.gameOver && state.winner !== null) {
      const panel = document.getElementById('gameover-panel');
      const overlay = document.getElementById('gameover-overlay');
      if (panel && overlay) {
        const myName = state.players[client.seat]?.name ?? 'Unknown';
        const winnerName = state.players[state.winner]?.name ?? `Player ${state.winner}`;
        const isWinner = state.winner === client.seat;
        panel.className = `pvb-gameover ${isWinner ? 'win' : 'loss'}`;
        panel.innerHTML = `
          <h2>${isWinner ? 'Victory!' : 'Defeated'}</h2>
          <div class="pvb-gameover-stats">${winnerName} wins the game!</div>
          <div class="pvb-gameover-actions">
            <button class="pvb-btn primary" onclick="location.reload()">Play Again</button>
          </div>
        `;
        overlay.classList.remove('hidden');
      }
    }
  });

  client.addEventListener('action-rejected', (ev) => {
    const reason = (ev as CustomEvent<string>).detail;
    console.warn('[MP] Action rejected:', reason);
    // Brief flash in the log
    _appendMpLogEntry(`Action rejected: ${reason}`, 'pvb-log-bot');
  });

  client.addEventListener('game-over', (ev) => {
    const { winner, reason } = (ev as CustomEvent<{ winner: number | null; reason: string }>).detail;
    const panel = document.getElementById('gameover-panel');
    const overlay = document.getElementById('gameover-overlay');
    if (panel && overlay) {
      const isWinner = winner !== null && winner === client.seat;
      panel.className = `pvb-gameover ${isWinner ? 'win' : 'loss'}`;
      panel.innerHTML = `
        <h2>${isWinner ? 'Victory!' : (winner === null ? 'Draw' : 'Defeated')}</h2>
        <div class="pvb-gameover-stats">${reason}</div>
        <div class="pvb-gameover-actions">
          <button class="pvb-btn primary" onclick="location.reload()">Play Again</button>
        </div>
      `;
      overlay.classList.remove('hidden');
    }
    showMpStatus('Game Over', false);
  });

  client.addEventListener('connection-error', (ev) => {
    const detail = (ev as CustomEvent<string>).detail;
    showMpStatus(`Disconnected: ${detail}`, false);
    console.error('[MP] Connection error:', detail);
  });
}

/** Update the existing top-bar UI elements with MP game state */
function _updateTopBarFromMpState(state: GameStateView): void {
  const turnDisplay = document.getElementById('turn-display');
  if (turnDisplay) turnDisplay.textContent = `Turn ${state.turn}`;

  const phaseDisplay = document.getElementById('phase-display');
  if (phaseDisplay) phaseDisplay.textContent = `${state.phase} · ${state.step}`;

  // Priority
  const priorityDisplay = document.getElementById('priority-display');
  if (priorityDisplay && mpClient) {
    const hasPriority = state.priorityPlayer === mpClient.seat;
    priorityDisplay.textContent = hasPriority ? 'Your Priority' : `Player ${state.priorityPlayer + 1} Priority`;
    priorityDisplay.className = `pvb-priority ${hasPriority ? 'yours' : 'theirs'}`;
  }

  // Life totals — show yours and active player
  const yourLife = document.getElementById('your-life');
  const botLife = document.getElementById('bot-life');
  if (mpClient && yourLife) {
    const me = state.players[mpClient.seat];
    if (me) yourLife.textContent = String(me.life);
  }
  if (botLife && state.players.length > 1) {
    // Show the active player's life (if not yourself)
    const other = state.players.find(p => mpClient ? p.id !== mpClient.seat : true);
    if (other) botLife.textContent = String(other.life);
  }
}

let _lastLogCount = 0;

/** Append new log entries to the game log panel */
function _appendMpLogEntries(log: unknown[]): void {
  const newEntries = log.slice(_lastLogCount);
  _lastLogCount = log.length;
  for (const entry of newEntries) {
    _appendMpLogEntry(String(entry), 'pvb-log-turn');
  }
}

function _appendMpLogEntry(text: string, cssClass: string = 'pvb-log-turn'): void {
  const logEl = document.getElementById('game-log');
  if (!logEl) return;
  const div = document.createElement('div');
  div.className = `pvb-log-entry ${cssClass}`;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ==================== Entry Point ====================

document.addEventListener('DOMContentLoaded', () => {
  // ── Check URL params to decide startup mode ──────────────────────────────
  const params = new URLSearchParams(window.location.search);
  const modeParam = params.get('mode');
  const joinParam = params.get('join');

  if (modeParam === 'solo') {
    // Directly launch solo mode — skip mode screen
    hideModeScreen();
    // Show deck selector overlay (existing flow)
    const deckOverlay = document.getElementById('deck-overlay');
    if (deckOverlay) deckOverlay.classList.remove('hidden');
  } else if (joinParam) {
    // Auto-open join dialog with pre-filled code
    hideModeScreen();
    showJoinDialog(joinParam);
  }
  // else: show mode screen (default — it's already visible)

  // ── Mode Screen Buttons ──────────────────────────────────────────────────
  document.getElementById('btn-solo')?.addEventListener('click', () => {
    hideModeScreen();
    // Show deck selector overlay (existing solo flow)
    const deckOverlay = document.getElementById('deck-overlay');
    if (deckOverlay) deckOverlay.classList.remove('hidden');
  });

  document.getElementById('btn-mp-host')?.addEventListener('click', () => {
    void createAndHostGame();
  });

  document.getElementById('btn-mp-join')?.addEventListener('click', () => {
    hideModeScreen();
    showJoinDialog();
  });

  // ── Join Dialog Buttons ──────────────────────────────────────────────────
  document.getElementById('btn-join-confirm')?.addEventListener('click', () => {
    const input = document.getElementById('join-code-input') as HTMLInputElement | null;
    const code = input?.value?.trim() ?? '';
    void joinGame(code);
  });

  document.getElementById('btn-join-cancel')?.addEventListener('click', () => {
    hideJoinDialog();
    // Return to mode screen
    const modeScreen = document.getElementById('mode-screen');
    if (modeScreen) modeScreen.style.display = 'flex';
  });

  // Allow pressing Enter in the code input to confirm join
  document.getElementById('join-code-input')?.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      const input = document.getElementById('join-code-input') as HTMLInputElement | null;
      const code = input?.value?.trim() ?? '';
      void joinGame(code);
    }
  });

  // ── Lobby Buttons ────────────────────────────────────────────────────────
  document.getElementById('btn-copy-code')?.addEventListener('click', async () => {
    const code = document.getElementById('session-code-text')?.textContent ?? '';
    if (!code || code === '--------') return;
    try {
      await navigator.clipboard.writeText(code);
      const btn = document.getElementById('btn-copy-code') as HTMLButtonElement | null;
      if (btn) {
        btn.textContent = '✅';
        setTimeout(() => { if (btn) btn.textContent = '📋'; }, 1500);
      }
    } catch {
      // Clipboard may not be available
    }
  });

  document.getElementById('btn-add-bot')?.addEventListener('click', () => {
    if (!mpClient) return;
    const emptySeat = nextEmptySeat(_lastSeats);
    if (emptySeat === -1) {
      alert('No empty seats available.');
      return;
    }
    mpClient.addBot(emptySeat);
  });

  document.getElementById('btn-ready')?.addEventListener('click', () => {
    if (!mpClient) return;
    mpClient.sendReady();
    // Update button state
    const btn = document.getElementById('btn-ready') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Waiting...'; }
  });

  // ── Quick-start button (import text, solo mode) ──────────────────────────
  document.getElementById('btn-start-import')?.addEventListener('click', () => {
    const textarea = document.getElementById('deck-import') as HTMLTextAreaElement | null;
    const text = textarea?.value ?? '';
    void initGame(text);
  });

  // ── Populate deck grid with saved decks + prebuilt options ───────────────
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

      option.addEventListener('click', () => void initGame(undefined, deck));
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

      option.addEventListener('click', () => void initGame());
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
