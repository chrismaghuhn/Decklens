/**
 * MTG Rules Engine — Main Entry Point.
 *
 * Handles:
 * - Mode selection (vs Bot / Hotseat)
 * - Deck selection (saved decks, pasted lists, sample decks)
 * - Scryfall card data loading (real oracle text, mana cost, P/T)
 * - Game initialization
 * - Button wiring
 */

import type { Card } from '@mtg/game-engine';
import { createSimpleCard, resetIdCounter } from '@mtg/game-engine';
import { SimulatorLoop } from './simulator-loop.ts';
import { HeuristicBot } from '@mtg/bot-core';
import { listDecks } from '../deckbuilder/storage.js';
import type { DeckbuilderDeck, DeckbuilderCardEntry } from '../deckbuilder/types.js';
import {
  loadCardsByName,
  parseDeckListToNames,
  expandDeckList,
} from './card-loader.ts';

let simulatorLoop: SimulatorLoop | null = null;

// ==================== Mode Selection ====================

let selectedMode: 'vs-bot' | 'hotseat' = 'vs-bot';
let selectedDeckP1: DeckbuilderDeck | null = null;
let selectedDeckP2: DeckbuilderDeck | null = null;

// ==================== Sample Deck Card Names ====================

const SAMPLE_RED_DECK: { name: string; count: number }[] = [
  { name: 'Mountain', count: 23 },
  { name: 'Lightning Bolt', count: 4 },
  { name: 'Goblin Guide', count: 4 },
  { name: 'Monastery Swiftspear', count: 4 },
  { name: 'Eidolon of the Great Revel', count: 4 },
  { name: 'Lava Spike', count: 4 },
  { name: 'Rift Bolt', count: 4 },
  { name: 'Searing Blaze', count: 4 },
  { name: 'Skullcrack', count: 4 },
  { name: 'Shard Volley', count: 4 },
];

const SAMPLE_GREEN_DECK: { name: string; count: number }[] = [
  { name: 'Forest', count: 24 },
  { name: 'Llanowar Elves', count: 4 },
  { name: 'Elvish Mystic', count: 4 },
  { name: 'Steel Leaf Champion', count: 4 },
  { name: 'Leatherback Baloth', count: 4 },
  { name: 'Rancor', count: 4 },
  { name: 'Aspect of Hydra', count: 4 },
  { name: 'Strangleroot Geist', count: 4 },
  { name: "Garruk's Companion", count: 4 },
  { name: 'Experiment One', count: 3 },
];

const SAMPLE_COMMANDERS: Record<string, string> = {
  red: 'Zurgo Bellstriker',
  green: 'Ghalta, Primal Hunger',
};

// ==================== Deckbuilder → Card Names ====================

/** Extract all card names from a DeckbuilderDeck */
function deckbuilderToNames(deck: DeckbuilderDeck): { deckNames: string[]; commanderName: string | null } {
  const boards = deck.boards;
  const commanderName = boards.commander?.length ? boards.commander[0].name : null;

  const entries: { name: string; count: number }[] = [];
  const addEntries = (boardEntries: DeckbuilderCardEntry[]) => {
    for (const entry of boardEntries) {
      entries.push({ name: entry.name, count: entry.qty });
    }
  };

  addEntries(boards.mainboard || []);
  addEntries(boards.creatures || []);
  addEntries(boards.spells || []);
  addEntries(boards.lands || []);
  addEntries(boards.artifacts || []);
  addEntries(boards.enchantments || []);
  addEntries(boards.planeswalkers || []);

  return { deckNames: expandDeckList(entries), commanderName };
}

// ==================== Loading UI ====================

function showLoadingOverlay(message: string): void {
  let overlay = document.getElementById('loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0;
      background: rgba(10,14,23,0.95);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      z-index: 2000; gap: 16px;
      font-family: 'Outfit', sans-serif; color: #e2e8f0;
    `;
    overlay.innerHTML = `
      <div style="font-family: 'Cinzel', serif; color: #c9a84c; font-size: 1.3rem;">Loading Cards...</div>
      <div id="loading-msg" style="color: #94a3b8; font-size: 0.85rem;"></div>
      <div style="width: 300px; height: 6px; background: #1a1f2e; border-radius: 3px; overflow: hidden;">
        <div id="loading-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #c9a84c, #34d399); border-radius: 3px; transition: width 0.3s;"></div>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  const msgEl = document.getElementById('loading-msg');
  if (msgEl) msgEl.textContent = message;
}

function updateLoadingProgress(loaded: number, total: number): void {
  const bar = document.getElementById('loading-bar');
  const msg = document.getElementById('loading-msg');
  if (bar) bar.style.width = `${Math.round((loaded / Math.max(total, 1)) * 100)}%`;
  if (msg) msg.textContent = `Fetching card data from Scryfall... ${loaded}/${total}`;
}

function hideLoadingOverlay(): void {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ==================== Initialization ====================

async function initGame(): Promise<void> {
  const startBtn = document.getElementById('btn-start') as HTMLButtonElement;
  if (startBtn) startBtn.disabled = true;

  const p1Name = selectedMode === 'hotseat'
    ? (document.getElementById('p1-name') as HTMLInputElement)?.value || 'Player 1'
    : 'You';
  const p2Name = selectedMode === 'hotseat'
    ? (document.getElementById('p2-name') as HTMLInputElement)?.value || 'Player 2'
    : 'Bot';

  resetIdCounter();

  showLoadingOverlay('Preparing decks...');

  try {
    // ─── Resolve P1 deck ───
    let p1Names: string[];
    let p1CmdName: string;

    const p1Text = (document.getElementById('deck-text-p1') as HTMLTextAreaElement)?.value?.trim();
    if (selectedDeckP1) {
      const result = deckbuilderToNames(selectedDeckP1);
      p1Names = result.deckNames;
      p1CmdName = result.commanderName || SAMPLE_COMMANDERS.red;
    } else if (p1Text) {
      const entries = parseDeckListToNames(p1Text);
      p1Names = expandDeckList(entries);
      // First card in list is commander
      p1CmdName = entries.length > 0 ? entries[0].name : SAMPLE_COMMANDERS.red;
      // Remove first copy of commander from deck
      const cmdIdx = p1Names.indexOf(p1CmdName);
      if (cmdIdx >= 0) p1Names.splice(cmdIdx, 1);
    } else {
      p1Names = expandDeckList(SAMPLE_RED_DECK);
      p1CmdName = SAMPLE_COMMANDERS.red;
    }

    // ─── Resolve P2 deck ───
    let p2Names: string[];
    let p2CmdName: string;

    if (selectedMode === 'hotseat') {
      const p2Text = (document.getElementById('deck-text-p2') as HTMLTextAreaElement)?.value?.trim();
      if (selectedDeckP2) {
        const result = deckbuilderToNames(selectedDeckP2);
        p2Names = result.deckNames;
        p2CmdName = result.commanderName || SAMPLE_COMMANDERS.green;
      } else if (p2Text) {
        const entries = parseDeckListToNames(p2Text);
        p2Names = expandDeckList(entries);
        p2CmdName = entries.length > 0 ? entries[0].name : SAMPLE_COMMANDERS.green;
        const cmdIdx = p2Names.indexOf(p2CmdName);
        if (cmdIdx >= 0) p2Names.splice(cmdIdx, 1);
      } else {
        p2Names = expandDeckList(SAMPLE_GREEN_DECK);
        p2CmdName = SAMPLE_COMMANDERS.green;
      }
    } else {
      p2Names = expandDeckList(SAMPLE_GREEN_DECK);
      p2CmdName = SAMPLE_COMMANDERS.green;
    }

    // ─── Fetch all card data from Scryfall ───
    const allNames = [...new Set([...p1Names, ...p2Names, p1CmdName, p2CmdName])];

    showLoadingOverlay(`Loading ${allNames.length} unique cards...`);

    // Load all unique cards at once (cache handles dedup)
    const p1Cards = await loadCardsByName(p1Names, 0, (prog) => {
      updateLoadingProgress(prog.loaded, allNames.length);
    });

    const p2Cards = await loadCardsByName(p2Names, 1);

    // Load commanders
    const [p1CmdArr, p2CmdArr] = await Promise.all([
      loadCardsByName([p1CmdName], 0),
      loadCardsByName([p2CmdName], 1),
    ]);

    const p1Commander = p1CmdArr[0] || createSimpleCard(p1CmdName, 'Legendary Creature', '{3}', 0, { colors: [], colorIdentity: [] });
    const p2Commander = p2CmdArr[0] || createSimpleCard(p2CmdName, 'Legendary Creature', '{3}', 1, { colors: [], colorIdentity: [] });

    hideLoadingOverlay();

    // Hide setup overlay
    document.getElementById('setup-overlay')?.classList.add('hidden');

    // Create game loop
    const bot = selectedMode === 'vs-bot' ? new HeuristicBot(1) : undefined;

    simulatorLoop = new SimulatorLoop({
      p1Deck: p1Cards,
      p1Commander,
      p2Deck: p2Cards,
      p2Commander,
      p1Name,
      p2Name,
      mode: selectedMode,
      bot: bot ? { player: 1 as 0 | 1, chooseAction: (s) => bot.chooseAction(s) } : undefined,
    });

    simulatorLoop.init();
  } catch (err) {
    console.error('Game init error:', err);
    hideLoadingOverlay();
    if (startBtn) startBtn.disabled = false;
    alert('Failed to load cards. Check the console for details.');
  }
}

// ==================== UI Wiring ====================

document.addEventListener('DOMContentLoaded', () => {
  // Mode buttons
  document.querySelectorAll('.re-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.re-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedMode = (btn as HTMLElement).dataset.mode as 'vs-bot' | 'hotseat';

      // Show/hide P2 deck section and names
      const p2Section = document.getElementById('p2-deck-section');
      const namesSection = document.getElementById('names-section');
      if (p2Section) p2Section.style.display = selectedMode === 'hotseat' ? '' : 'none';
      if (namesSection) namesSection.style.display = selectedMode === 'hotseat' ? '' : 'none';
    });
  });

  // Populate deck grids
  populateDeckGrid('deck-grid-p1', (deck) => { selectedDeckP1 = deck; });
  populateDeckGrid('deck-grid-p2', (deck) => { selectedDeckP2 = deck; });

  // Start button
  document.getElementById('btn-start')?.addEventListener('click', () => initGame());

  // Game action buttons
  document.getElementById('btn-pass')?.addEventListener('click', () => simulatorLoop?.pass());
  document.getElementById('btn-undo')?.addEventListener('click', () => simulatorLoop?.undo());
  document.getElementById('btn-concede')?.addEventListener('click', () => simulatorLoop?.concede());
  document.getElementById('btn-new-game')?.addEventListener('click', () => location.reload());

  // Note: Keyboard shortcuts are handled inside SimulatorLoop.wireKeyboardShortcuts()
});

/** Populate a deck grid with saved decks + sample options */
function populateDeckGrid(gridId: string, onSelect: (deck: DeckbuilderDeck | null) => void): void {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  // Add sample deck options first
  const sampleDecks = [
    { name: 'Sample: Mono-Red Burn', count: 60 },
    { name: 'Sample: Mono-Green Stompy', count: 60 },
  ];

  for (const sample of sampleDecks) {
    const el = document.createElement('div');
    el.className = 're-deck-option';
    el.innerHTML = `<div class="deck-name">${sample.name}</div><div class="deck-count">${sample.count} cards</div>`;
    el.addEventListener('click', () => {
      grid.querySelectorAll('.re-deck-option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      onSelect(null); // null = use sample
    });
    grid.appendChild(el);
  }

  // Add saved decks
  try {
    const savedDecks = listDecks();
    for (const deck of savedDecks) {
      const totalCards = Object.values(deck.boards).reduce((sum, entries) => {
        if (Array.isArray(entries)) return sum + entries.reduce((s: number, e: DeckbuilderCardEntry) => s + e.qty, 0);
        return sum;
      }, 0);

      const el = document.createElement('div');
      el.className = 're-deck-option';
      el.innerHTML = `<div class="deck-name">${deck.name}</div><div class="deck-count">${totalCards} cards</div>`;
      el.addEventListener('click', () => {
        grid.querySelectorAll('.re-deck-option').forEach(o => o.classList.remove('selected'));
        el.classList.add('selected');
        onSelect(deck);
      });
      grid.appendChild(el);
    }
  } catch {
    // No saved decks or storage error
  }
}
