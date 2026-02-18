/**
 * Multiplayer Goldfish Launch UI
 *
 * Shows a setup modal where the local player configures a multiplayer goldfish game:
 * - Choose game mode: Hotseat (local) or Online (WebSocket)
 * - Choose number of players (2-4)
 * - Name each player + assign decks
 * - Start or Host/Join the game
 *
 * For local play: All players use the same device (hotseat mode)
 * For online play: Host creates a game, others join via collab session
 */

import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import { openMultiplayerGoldfish, type MPGameMode, type HouseRules, DEFAULT_HOUSE_RULES } from './goldfish-mp.js';
import { PLAYER_COLORS, PLAYER_LABELS } from './goldfish-types.js';
import { getCollabManager } from './collab-manager.js';
import { listDecks, getDeckById } from './storage.js';

// ─── Load ALL saved decks from the real storage ───

function getAllSavedDecks(): DeckbuilderDeck[] {
  try {
    return listDecks();
  } catch { return []; }
}

// ─── Launch Modal ───

export function showMultiplayerLaunchModal(
  currentDeck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'mp-launch-overlay';

  const modal = document.createElement('div');
  modal.className = 'mp-launch-modal';

  // Title
  const title = document.createElement('div');
  title.className = 'mp-launch-title';
  title.textContent = 'Multiplayer Goldfish';
  modal.appendChild(title);

  // ─── Mode Toggle: Hotseat / Online ───
  let gameMode: MPGameMode = 'hotseat';
  let onlineRole: 'host' | 'join' = 'host';

  const modeRow = document.createElement('div');
  modeRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;justify-content:center;';

  const hotseatBtn = document.createElement('button');
  hotseatBtn.className = 'gf-btn';
  hotseatBtn.textContent = '🖥 Hotseat';

  const onlineBtn = document.createElement('button');
  onlineBtn.className = 'gf-btn';
  onlineBtn.textContent = '🌐 Online';

  function updateModeButtons(): void {
    const activeStyle = 'background:var(--gold,#c9a84c)!important;color:#000!important;font-weight:700!important;';
    hotseatBtn.style.cssText = gameMode === 'hotseat' ? activeStyle : '';
    onlineBtn.style.cssText = gameMode === 'online' ? activeStyle : '';
    renderContent();
  }

  hotseatBtn.addEventListener('click', () => { gameMode = 'hotseat'; updateModeButtons(); });
  onlineBtn.addEventListener('click', () => {
    const mgr = getCollabManager();
    if (!mgr.isConnected) {
      // Show warning that collab session is required
      alert('You need to be in an active collab session to play online.\nOpen the Collab panel and join/create a session first.');
      return;
    }
    gameMode = 'online';
    updateModeButtons();
  });

  modeRow.appendChild(hotseatBtn);
  modeRow.appendChild(onlineBtn);
  modal.appendChild(modeRow);

  // Subtitle (dynamic based on mode)
  const subtitle = document.createElement('div');
  subtitle.className = 'mp-launch-subtitle';
  modal.appendChild(subtitle);

  // Content container (changes based on mode)
  const contentContainer = document.createElement('div');
  modal.appendChild(contentContainer);

  // Get ALL saved decks from real storage (not the old separate key)
  const savedDecks = getAllSavedDecks();

  // Player configurations
  interface PlayerConfig {
    name: string;
    deckSource: 'current' | 'saved';
    savedDeckId?: string;
  }

  const configs: PlayerConfig[] = [
    { name: 'Player 1', deckSource: 'current' },
    { name: 'Player 2', deckSource: 'current' },
    { name: 'Player 3', deckSource: 'current' },
    { name: 'Player 4', deckSource: 'current' },
  ];

  let playerCount = 2;

  // ─── House Rules State ───
  const houseRules: HouseRules = { ...DEFAULT_HOUSE_RULES };

  function buildHouseRulesPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.style.cssText = 'margin:16px 0 8px;border:1px solid #2a2f3e;border-radius:10px;overflow:hidden;';

    // Toggle header
    const header = document.createElement('button');
    header.style.cssText = 'width:100%;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#1a1f2e;border:none;color:#e0e0e0;cursor:pointer;font-size:0.85rem;font-family:inherit;';
    header.innerHTML = '<span>⚙ House Rules</span><span class="mp-hr-arrow" style="transition:transform 0.2s;">▸</span>';
    panel.appendChild(header);

    const body = document.createElement('div');
    body.style.cssText = 'display:none;padding:12px 14px;background:#0f1623;';
    panel.appendChild(body);

    let expanded = false;
    header.addEventListener('click', () => {
      expanded = !expanded;
      body.style.display = expanded ? 'block' : 'none';
      const arrow = header.querySelector('.mp-hr-arrow') as HTMLElement;
      if (arrow) arrow.style.transform = expanded ? 'rotate(90deg)' : '';
    });

    // ── Toggle rows ──
    const toggles: { key: keyof HouseRules; label: string; desc: string; invertDisplay?: boolean }[] = [
      { key: 'landPerTurn', label: '🌍 Land per Turn', desc: 'Only 1 land per turn' },
      { key: 'summoningSickness', label: '💤 Summoning Sickness', desc: 'Creatures can\'t attack the turn they enter' },
      { key: 'commanderDamage21', label: '⚔ Commander Damage (21)', desc: 'Players eliminated at 21 commander damage' },
      { key: 'poisonElimination', label: '☠ Poison (10 counters)', desc: 'Players eliminated at 10 poison counters' },
      { key: 'maxHandSize', label: '✋ Max Hand Size (7)', desc: 'Show discard warning above 7 cards' },
      { key: 'freePlay', label: '🎲 Free Play Mode', desc: 'Any player can act at any time, ignore turn order', invertDisplay: true },
    ];

    for (const t of toggles) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;font-size:0.82rem;color:#cbd5e1;';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.cssText = 'accent-color:#c9a84c;width:16px;height:16px;cursor:pointer;';
      // For invertDisplay (freePlay), checked = true means enabled, but default is false
      const currentVal = houseRules[t.key];
      cb.checked = t.invertDisplay ? Boolean(currentVal) : Boolean(currentVal);

      cb.addEventListener('change', () => {
        (houseRules as Record<string, unknown>)[t.key] = cb.checked;
      });

      const labelText = document.createElement('div');
      labelText.innerHTML = `<div style="font-weight:600;color:#e0e0e0;">${t.label}</div><div style="font-size:0.75rem;color:#64748b;">${t.desc}</div>`;

      row.appendChild(cb);
      row.appendChild(labelText);
      body.appendChild(row);
    }

    // ── Starting life ──
    const lifeRow = document.createElement('div');
    lifeRow.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0 2px;';

    const lifeLabel = document.createElement('span');
    lifeLabel.style.cssText = 'font-size:0.82rem;color:#e0e0e0;font-weight:600;';
    lifeLabel.textContent = '❤ Starting Life:';

    const lifeInput = document.createElement('input');
    lifeInput.type = 'number';
    lifeInput.min = '1';
    lifeInput.max = '999';
    lifeInput.value = String(houseRules.startingLife);
    lifeInput.style.cssText = 'background:#1a1f2e;border:1px solid #2a2f3e;color:#e0e0e0;padding:4px 8px;border-radius:6px;font-size:0.85rem;width:70px;text-align:center;';
    lifeInput.addEventListener('input', () => {
      const v = parseInt(lifeInput.value);
      if (Number.isFinite(v) && v >= 1 && v <= 999) houseRules.startingLife = v;
    });

    lifeRow.appendChild(lifeLabel);
    lifeRow.appendChild(lifeInput);
    body.appendChild(lifeRow);

    // ── Quick preset buttons ──
    const presetRow = document.createElement('div');
    presetRow.style.cssText = 'display:flex;gap:6px;margin-top:12px;flex-wrap:wrap;';

    const presets: { label: string; apply: () => void }[] = [
      {
        label: '📋 Default (EDH Rules)',
        apply: () => { Object.assign(houseRules, DEFAULT_HOUSE_RULES); },
      },
      {
        label: '🎲 Free Play (No Rules)',
        apply: () => {
          houseRules.landPerTurn = false;
          houseRules.summoningSickness = false;
          houseRules.commanderDamage21 = false;
          houseRules.poisonElimination = false;
          houseRules.maxHandSize = false;
          houseRules.freePlay = true;
        },
      },
      {
        label: '⚡ 20 Life (Duel)',
        apply: () => { Object.assign(houseRules, DEFAULT_HOUSE_RULES); houseRules.startingLife = 20; },
      },
    ];

    for (const preset of presets) {
      const btn = document.createElement('button');
      btn.className = 'gf-btn';
      btn.style.cssText = 'font-size:0.75rem;padding:4px 10px;';
      btn.textContent = preset.label;
      btn.addEventListener('click', () => {
        preset.apply();
        // Re-render the panel body
        const newPanel = buildHouseRulesPanel();
        panel.replaceWith(newPanel);
        // Auto-expand the new panel
        const newHeader = newPanel.querySelector('button') as HTMLButtonElement;
        if (newHeader) newHeader.click();
      });
      presetRow.appendChild(btn);
    }
    body.appendChild(presetRow);

    return panel;
  }

  function renderContent(): void {
    contentContainer.textContent = '';

    if (gameMode === 'hotseat') {
      renderHotseatSetup();
    } else {
      renderOnlineSetup();
    }
  }

  // ─── Hotseat Setup ───

  function renderHotseatSetup(): void {
    subtitle.textContent = 'Local multiplayer playtest (2-4 players, same device)';

    // Player count selector
    const countRow = document.createElement('div');
    countRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;justify-content:center;';
    countRow.innerHTML = `<span style="font-size:0.78rem;color:#94a3b8;">Players:</span>`;

    const countBtns: HTMLButtonElement[] = [];

    for (let n = 2; n <= 4; n++) {
      const btn = document.createElement('button');
      btn.className = 'gf-btn';
      btn.textContent = `${n}P`;
      btn.style.cssText = n === playerCount
        ? 'background:var(--gold,#c9a84c)!important;color:#000!important;font-weight:700!important;'
        : '';
      btn.addEventListener('click', () => {
        playerCount = n;
        countBtns.forEach((b, i) => {
          b.style.cssText = i + 2 === n
            ? 'background:var(--gold,#c9a84c)!important;color:#000!important;font-weight:700!important;'
            : '';
        });
        renderPlayerRows(setupContainer);
      });
      countBtns.push(btn);
      countRow.appendChild(btn);
    }
    contentContainer.appendChild(countRow);

    // Player setup container
    const setupContainer = document.createElement('div');
    setupContainer.className = 'mp-player-setup';
    contentContainer.appendChild(setupContainer);
    renderPlayerRows(setupContainer);

    // House Rules panel
    contentContainer.appendChild(buildHouseRulesPanel());

    // Actions
    const actions = document.createElement('div');
    actions.className = 'mp-launch-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mp-launch-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const startBtn = document.createElement('button');
    startBtn.className = 'mp-launch-start';
    startBtn.textContent = 'Start Game';
    startBtn.addEventListener('click', () => {
      const decks = buildDecks();
      overlay.remove();
      openMultiplayerGoldfish(decks, cardByName, { mode: 'hotseat', houseRules });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(startBtn);
    contentContainer.appendChild(actions);
  }

  // ─── Online Setup ───

  function renderOnlineSetup(): void {
    subtitle.textContent = 'Play online with friends via collab session';

    // Host / Join toggle
    const roleRow = document.createElement('div');
    roleRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:16px;justify-content:center;';

    const hostBtn = document.createElement('button');
    hostBtn.className = 'gf-btn';
    hostBtn.textContent = '👑 Host Game';

    const joinBtn = document.createElement('button');
    joinBtn.className = 'gf-btn';
    joinBtn.textContent = '🎮 Join Game';

    function updateRoleBtns(): void {
      const activeStyle = 'background:var(--gold,#c9a84c)!important;color:#000!important;font-weight:700!important;';
      hostBtn.style.cssText = onlineRole === 'host' ? activeStyle : '';
      joinBtn.style.cssText = onlineRole === 'join' ? activeStyle : '';
      renderOnlineContent();
    }

    hostBtn.addEventListener('click', () => { onlineRole = 'host'; updateRoleBtns(); });
    joinBtn.addEventListener('click', () => { onlineRole = 'join'; updateRoleBtns(); });

    roleRow.appendChild(hostBtn);
    roleRow.appendChild(joinBtn);
    contentContainer.appendChild(roleRow);

    const onlineContent = document.createElement('div');
    contentContainer.appendChild(onlineContent);

    function renderOnlineContent(): void {
      onlineContent.textContent = '';

      if (onlineRole === 'host') {
        renderHostSetup(onlineContent);
      } else {
        renderJoinSetup(onlineContent);
      }
    }

    updateRoleBtns();
  }

  function renderHostSetup(container: HTMLElement): void {
    // Host info
    const info = document.createElement('div');
    info.style.cssText = 'text-align:center;margin-bottom:16px;font-size:0.82rem;color:#94a3b8;';
    info.innerHTML = `
      <p style="margin:0 0 8px">You'll host the game. Other players in your collab session can join.</p>
      <p style="margin:0;color:#34d399;">Share your collab session link with friends to play together.</p>
    `;
    container.appendChild(info);

    // Player count selector
    const countRow = document.createElement('div');
    countRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;justify-content:center;';
    countRow.innerHTML = `<span style="font-size:0.78rem;color:#94a3b8;">Max Players:</span>`;

    const countBtns: HTMLButtonElement[] = [];
    for (let n = 2; n <= 4; n++) {
      const btn = document.createElement('button');
      btn.className = 'gf-btn';
      btn.textContent = `${n}P`;
      btn.style.cssText = n === playerCount
        ? 'background:var(--gold,#c9a84c)!important;color:#000!important;font-weight:700!important;'
        : '';
      btn.addEventListener('click', () => {
        playerCount = n;
        countBtns.forEach((b, i) => {
          b.style.cssText = i + 2 === n
            ? 'background:var(--gold,#c9a84c)!important;color:#000!important;font-weight:700!important;'
            : '';
        });
      });
      countBtns.push(btn);
      countRow.appendChild(btn);
    }
    container.appendChild(countRow);

    // Your name input
    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;justify-content:center;';
    const nameLabel = document.createElement('span');
    nameLabel.style.cssText = 'font-size:0.78rem;color:#94a3b8;';
    nameLabel.textContent = 'Your Name:';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Player 1';
    nameInput.value = configs[0].name;
    nameInput.style.cssText = 'background:#1a1f2e;border:1px solid #2a2f3e;color:#e0e0e0;padding:6px 10px;border-radius:6px;font-size:0.85rem;width:150px;';
    nameInput.addEventListener('input', () => { configs[0].name = nameInput.value || 'Player 1'; });
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    container.appendChild(nameRow);

    // Deck selection for yourself
    const deckRow = document.createElement('div');
    deckRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;justify-content:center;';
    const deckLabel = document.createElement('span');
    deckLabel.style.cssText = 'font-size:0.78rem;color:#94a3b8;';
    deckLabel.textContent = 'Your Deck:';
    const deckSelect = document.createElement('select');
    deckSelect.style.cssText = 'background:#1a1f2e;border:1px solid #2a2f3e;color:#e0e0e0;padding:6px 10px;border-radius:6px;font-size:0.85rem;';

    const currentOpt = document.createElement('option');
    currentOpt.value = 'current';
    currentOpt.textContent = `Current Deck (${currentDeck.name || 'Untitled'})`;
    deckSelect.appendChild(currentOpt);

    for (const saved of savedDecks) {
      const opt = document.createElement('option');
      opt.value = saved.id;
      opt.textContent = saved.name || saved.id;
      deckSelect.appendChild(opt);
    }
    deckSelect.addEventListener('change', () => {
      if (deckSelect.value === 'current') {
        configs[0].deckSource = 'current';
        configs[0].savedDeckId = undefined;
      } else {
        configs[0].deckSource = 'saved';
        configs[0].savedDeckId = deckSelect.value;
      }
    });

    deckRow.appendChild(deckLabel);
    deckRow.appendChild(deckSelect);
    container.appendChild(deckRow);

    // House Rules panel
    container.appendChild(buildHouseRulesPanel());

    // Actions
    const actions = document.createElement('div');
    actions.className = 'mp-launch-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mp-launch-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const hostStartBtn = document.createElement('button');
    hostStartBtn.className = 'mp-launch-start';
    hostStartBtn.textContent = '👑 Host & Start';
    hostStartBtn.style.cssText = 'background:linear-gradient(135deg,#c9a84c,#34d399)!important;color:#000!important;font-weight:700!important;';
    hostStartBtn.addEventListener('click', () => {
      // Build decks — host starts with their own deck and placeholders for others
      const decks = buildOnlineHostDecks();
      overlay.remove();
      openMultiplayerGoldfish(decks, cardByName, {
        mode: 'online',
        isHost: true,
        onlinePlayerId: 'p1',
        houseRules,
      });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(hostStartBtn);
    container.appendChild(actions);
  }

  function renderJoinSetup(container: HTMLElement): void {
    // Join info
    const info = document.createElement('div');
    info.style.cssText = 'text-align:center;margin-bottom:16px;font-size:0.82rem;color:#94a3b8;';
    info.innerHTML = `
      <p style="margin:0 0 8px">Join a game that someone else is hosting in your collab session.</p>
      <p style="margin:0;color:#60a5fa;">The host will set up the game. You just need your deck and name.</p>
    `;
    container.appendChild(info);

    // Your name input
    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;justify-content:center;';
    const nameLabel = document.createElement('span');
    nameLabel.style.cssText = 'font-size:0.78rem;color:#94a3b8;';
    nameLabel.textContent = 'Your Name:';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Your Name';
    nameInput.value = '';
    nameInput.style.cssText = 'background:#1a1f2e;border:1px solid #2a2f3e;color:#e0e0e0;padding:6px 10px;border-radius:6px;font-size:0.85rem;width:150px;';
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    container.appendChild(nameRow);

    // Deck selection
    const deckRow = document.createElement('div');
    deckRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;justify-content:center;';
    const deckLabel = document.createElement('span');
    deckLabel.style.cssText = 'font-size:0.78rem;color:#94a3b8;';
    deckLabel.textContent = 'Your Deck:';
    const deckSelect = document.createElement('select');
    deckSelect.style.cssText = 'background:#1a1f2e;border:1px solid #2a2f3e;color:#e0e0e0;padding:6px 10px;border-radius:6px;font-size:0.85rem;';

    const currentOpt = document.createElement('option');
    currentOpt.value = 'current';
    currentOpt.textContent = `Current Deck (${currentDeck.name || 'Untitled'})`;
    deckSelect.appendChild(currentOpt);

    for (const saved of savedDecks) {
      const opt = document.createElement('option');
      opt.value = saved.id;
      opt.textContent = saved.name || saved.id;
      deckSelect.appendChild(opt);
    }

    deckRow.appendChild(deckLabel);
    deckRow.appendChild(deckSelect);
    container.appendChild(deckRow);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'mp-launch-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mp-launch-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const joinStartBtn = document.createElement('button');
    joinStartBtn.className = 'mp-launch-start';
    joinStartBtn.textContent = '🎮 Join Game';
    joinStartBtn.style.cssText = 'background:linear-gradient(135deg,#60a5fa,#34d399)!important;color:#000!important;font-weight:700!important;';
    joinStartBtn.addEventListener('click', () => {
      const myName = nameInput.value || 'Player';
      // Resolve deck choice
      const joinConfig: PlayerConfig = {
        name: myName,
        deckSource: deckSelect.value === 'current' ? 'current' : 'saved',
        savedDeckId: deckSelect.value === 'current' ? undefined : deckSelect.value,
      };
      const myDeck = resolveDeck(joinConfig);

      overlay.remove();
      // Join with a single deck — the host's game state will be synced via WebSocket
      // Player ID is dynamically assigned based on available slots (not hardcoded to p2)
      // The collab system assigns the next free slot, but we pass our name so it's correct
      openMultiplayerGoldfish(
        [{ deck: myDeck, playerName: myName }],
        cardByName,
        { mode: 'online', isHost: false, onlinePlayerId: myName },
      );
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(joinStartBtn);
    container.appendChild(actions);
  }

  // ─── Shared: Player Row Rendering (for hotseat) ───

  function renderPlayerRows(container: HTMLElement): void {
    container.textContent = '';

    for (let i = 0; i < playerCount; i++) {
      const row = document.createElement('div');
      row.className = 'mp-player-row';

      // Color dot
      const dot = document.createElement('div');
      dot.className = 'mp-player-color-dot';
      dot.style.background = PLAYER_COLORS[i];
      row.appendChild(dot);

      // Name input
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = PLAYER_LABELS[i];
      nameInput.value = configs[i].name || PLAYER_LABELS[i];
      nameInput.addEventListener('input', () => {
        configs[i].name = nameInput.value || PLAYER_LABELS[i];
      });
      row.appendChild(nameInput);

      // Deck source selector
      const deckSelect = document.createElement('select');
      const currentOpt = document.createElement('option');
      currentOpt.value = 'current';
      currentOpt.textContent = `Current Deck (${currentDeck.name || 'Untitled'})`;
      deckSelect.appendChild(currentOpt);

      for (const saved of savedDecks) {
        if (saved.id === currentDeck.id) continue; // Skip current deck (already shown)
        const cardCount = saved.boards.mainboard.reduce((s, e) => s + e.qty, 0) + saved.boards.commander.reduce((s, e) => s + e.qty, 0);
        const opt = document.createElement('option');
        opt.value = saved.id;
        opt.textContent = `${saved.name || 'Untitled'} (${cardCount} cards)`;
        deckSelect.appendChild(opt);
      }

      deckSelect.value = configs[i].deckSource === 'current' ? 'current' : (configs[i].savedDeckId || 'current');
      deckSelect.addEventListener('change', () => {
        if (deckSelect.value === 'current') {
          configs[i].deckSource = 'current';
          configs[i].savedDeckId = undefined;
        } else {
          configs[i].deckSource = 'saved';
          configs[i].savedDeckId = deckSelect.value;
        }
      });
      row.appendChild(deckSelect);

      container.appendChild(row);
    }
  }

  // ─── Build Decks ───

  /** Resolve a player config to a full DeckbuilderDeck (deep clone) */
  function resolveDeck(config: PlayerConfig): DeckbuilderDeck {
    if (config.deckSource === 'saved' && config.savedDeckId) {
      // Try real storage first (getDeckById), then fallback to in-memory list
      const fromStorage = getDeckById(config.savedDeckId);
      if (fromStorage) return JSON.parse(JSON.stringify(fromStorage));
      const fromList = savedDecks.find(d => d.id === config.savedDeckId);
      if (fromList) return JSON.parse(JSON.stringify(fromList));
    }
    return JSON.parse(JSON.stringify(currentDeck));
  }

  function buildDecks(): { deck: DeckbuilderDeck; playerName: string }[] {
    const decks: { deck: DeckbuilderDeck; playerName: string }[] = [];

    for (let i = 0; i < playerCount; i++) {
      const config = configs[i];
      decks.push({ deck: resolveDeck(config), playerName: config.name || PLAYER_LABELS[i] });
    }

    return decks;
  }

  function buildOnlineHostDecks(): { deck: DeckbuilderDeck; playerName: string }[] {
    // Host provides their own deck + placeholder decks for other players
    const decks: { deck: DeckbuilderDeck; playerName: string }[] = [];

    // Host's own deck
    decks.push({ deck: resolveDeck(configs[0]), playerName: configs[0].name || 'Host' });

    // Placeholder decks for other players (they'll sync their own deck on join)
    for (let i = 1; i < playerCount; i++) {
      decks.push({
        deck: JSON.parse(JSON.stringify(currentDeck)),
        playerName: `Waiting for Player ${i + 1}...`,
      });
    }

    return decks;
  }

  // ─── Initialize ───

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Initial render
  updateModeButtons();
}
