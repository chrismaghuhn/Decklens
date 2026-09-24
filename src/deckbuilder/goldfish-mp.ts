/**
 * Multiplayer Goldfish Engine
 *
 * Extends the single-player goldfish playtest to support 2-4 players.
 * Uses the existing collab infrastructure for real-time sync.
 *
 * Architecture:
 * - Each player has their own PlayerGameState (hand, battlefield, life, etc.)
 * - Turn rotation: P1 → P2 → P3 → P4 → P1 → ...
 * - Combat: Active player declares attackers targeting specific opponents
 * - State sync: Uses existing CollabManager WebSocket broadcast
 */

import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import { showHoverPreview, hideHoverPreview } from './card-preview.js';
import { broadcastGoldfishStart, broadcastGoldfishAction, broadcastGoldfishEnd } from './collab-goldfish.js';
import { initCoach, onCoachStateChange, savePrefs as saveCoachPrefs, type DeckCoach, type CoachGameState } from './goldfish-coach.js';
import { renderCoachPanel, getRoleBadge, initCoachLines, updateCoachLines, destroyCoachLines } from './goldfish-coach-ui.js';
import { renderCoachWidget } from './goldfish-coach-widget.js';
import {
  type Phase, type GfZone, type GoldfishPermanent, type DetectedToken,
  type PlayerGameState, type MultiplayerGoldfishState, type CombatState,
  type AttackerDeclaration, type GfDragPayload, type GfCtxItem,
  PHASES, PHASE_LABELS, PLAYER_COLORS, PLAYER_LABELS,
  createPlayerGameState, createMultiplayerState,
  getActivePlayer, getActivePlayerId, canPlayerAct,
  getAlivePlayers, shouldGameEnd,
  serializeMPState, deserializeMPState,
} from './goldfish-types.js';
import {
  initMPCollab, cleanupMPCollab,
  hostMPGame, joinMPGame, leaveMPGame,
  broadcastMPAction, broadcastMPTurnChange, broadcastMPCombat, broadcastMPBlockers, broadcastMPStateSync,
  isMPOnline, isMPHost, getLocalPlayerId as getCollabPlayerId,
} from './collab-goldfish-mp.js';
import { getCollabManager } from './collab-manager.js';

/** Game mode: hotseat (local) or online (WebSocket) */
export type MPGameMode = 'hotseat' | 'online';

/** House Rules — toggle game rules on/off */
export interface HouseRules {
  /** One land per turn (default: true) */
  landPerTurn: boolean;
  /** Summoning sickness (default: true) */
  summoningSickness: boolean;
  /** Commander damage elimination at 21 (default: true) */
  commanderDamage21: boolean;
  /** Poison elimination at 10 (default: true) */
  poisonElimination: boolean;
  /** Maximum hand size warning (default: true) */
  maxHandSize: boolean;
  /** Starting life total (default: 40) */
  startingLife: number;
  /** Free play mode — anyone can act at any time, not just active player (default: false) */
  freePlay: boolean;
}

export const DEFAULT_HOUSE_RULES: HouseRules = {
  landPerTurn: true,
  summoningSickness: true,
  commanderDamage21: true,
  poisonElimination: true,
  maxHandSize: true,
  startingLife: 40,
  freePlay: false,
};

const MAX_UNDO = 30;
const PREDEFINED_TOKENS = ['Treasure', 'Food', 'Clue', 'Blood', 'Map', 'Powerstone', 'Incubator', 'Shard', 'Junk', 'Gold', 'Walker'];

// ─── Token Image Cache (shared with single-player) ───
const tokenImageCache = new Map<string, string>();
const tokenImagePending = new Set<string>();

// ─── DOM Image Cache (prevents flicker on full re-render) ───
const imgCache = new Map<string, HTMLImageElement>();

async function fetchTokenImage(name: string): Promise<string> {
  if (tokenImageCache.has(name)) return tokenImageCache.get(name)!;
  if (tokenImagePending.has(name)) return '';
  tokenImagePending.add(name);
  try {
    const q = `!"${name}" t:token`;
    const resp = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released&dir=desc`);
    if (resp.ok) {
      const data = await resp.json() as any;
      const card = data.data?.[0];
      const img = card?.image_uris?.normal || card?.image_uris?.small
        || card?.card_faces?.[0]?.image_uris?.normal || card?.card_faces?.[0]?.image_uris?.small || '';
      if (img) { tokenImageCache.set(name, img); tokenImagePending.delete(name); return img; }
    }
    const q2 = `t:token name:"${name}"`;
    const resp2 = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q2)}&unique=prints&order=released&dir=desc`);
    if (resp2.ok) {
      const data2 = await resp2.json() as any;
      const card2 = data2.data?.[0];
      const img2 = card2?.image_uris?.normal || card2?.image_uris?.small
        || card2?.card_faces?.[0]?.image_uris?.normal || card2?.card_faces?.[0]?.image_uris?.small || '';
      tokenImageCache.set(name, img2); tokenImagePending.delete(name); return img2;
    }
    tokenImageCache.set(name, ''); tokenImagePending.delete(name); return '';
  } catch { tokenImagePending.delete(name); return ''; }
}

function extractTokensFromOracle(oracleText: string): DetectedToken[] {
  const tokens: DetectedToken[] = [];
  const seen = new Set<string>();
  const creatureRe = /[Cc]reates?\s+(?:a\s+|an\s+|two\s+|three\s+|four\s+|five\s+|\d+\s+)?(\d+|\*)\/(\d+|\*)\s+([\w\s,]+?)\s+creature\s+tokens?(?:\s+with\s+([\w\s,]+?))?(?:\.|,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = creatureRe.exec(oracleText)) !== null) {
    const power = m[1]; const toughness = m[2]; const descriptor = m[3].trim(); const abilities = (m[4] || '').trim();
    const colorWords = ['white', 'blue', 'black', 'red', 'green', 'colorless'];
    const parts = descriptor.split(/\s+/);
    const colors: string[] = []; const typeWords: string[] = [];
    for (const w of parts) { if (colorWords.includes(w.toLowerCase())) colors.push(w); else if (w.toLowerCase() !== 'and') typeWords.push(w); }
    const name = typeWords.join(' ') || 'Token';
    const key = `${name}-${power}/${toughness}`;
    if (seen.has(key)) continue; seen.add(key);
    tokens.push({ name, power, toughness, colors: colors.join(' '), typeLine: `Creature — ${name}`, abilities });
  }
  for (const tName of PREDEFINED_TOKENS) {
    const re = new RegExp(`[Cc]reates?\\s+(?:a\\s+|an\\s+|two\\s+|three\\s+|\\d+\\s+)?${tName}\\s+tokens?`, 'g');
    if (re.test(oracleText) && !seen.has(tName)) {
      seen.add(tName);
      tokens.push({ name: tName, colors: '', typeLine: `Token — ${tName}`, abilities: '' });
    }
  }
  return tokens;
}

// ─── Card helpers ───

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function shuffle(arr: string[]): string[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function getCard(name: string, cardByName: Record<string, DeckbuilderSearchCard | undefined>): DeckbuilderSearchCard | undefined {
  return cardByName[normalizeKey(name)];
}

function getImgUrl(name: string, cardByName: Record<string, DeckbuilderSearchCard | undefined>): string {
  const card = getCard(name, cardByName);
  return card?.image_uris?.small || card?.image_uris?.normal || '';
}

function classifyCard(name: string, cardByName: Record<string, DeckbuilderSearchCard | undefined>): { isLand: boolean; isCreature: boolean; typeLine: string } {
  const card = getCard(name, cardByName);
  const tl = (card?.type_line || '').toLowerCase();
  return { isLand: tl.includes('land'), isCreature: tl.includes('creature'), typeLine: card?.type_line || '' };
}

// ─── Keyword & Combat Helpers ───

/** Check if a permanent has a specific keyword (via Scryfall keywords[] or oracle text fallback) */
function hasKeywordGoldfish(perm: GoldfishPermanent, keyword: string): boolean {
  const kw = keyword.toLowerCase();
  if (perm.keywords.some(k => k.toLowerCase() === kw)) return true;
  // Oracle text fallback for common keywords (word-boundary match to avoid "breach" matching "reach")
  if (perm.oracleText) {
    const ot = perm.oracleText.toLowerCase();
    if (new RegExp(`\\b${kw}\\b`).test(ot)) return true;
  }
  return false;
}

/** Get creatures eligible to attack (untapped, no summoning sickness unless haste) */
function getEligibleAttackersGoldfish(player: PlayerGameState, currentTurn: number, skipSummoningSickness = false): GoldfishPermanent[] {
  return player.battlefield.filter(p => {
    if (!p.isCreature || p.tapped) return false;
    // Summoning sickness: can't attack the turn it entered (unless haste or house rules disabled)
    if (!skipSummoningSickness && p.enteredTurn === currentTurn && !hasKeywordGoldfish(p, 'haste')) return false;
    // Defender keyword: can't attack
    if (hasKeywordGoldfish(p, 'defender')) return false;
    return true;
  });
}

/** Get creatures eligible to block (untapped creatures) */
function getEligibleBlockersGoldfish(player: PlayerGameState): GoldfishPermanent[] {
  return player.battlefield.filter(p => p.isCreature && !p.tapped);
}

/** Check if a blocker can legally block an attacker (flying/reach/unblockable/shadow/horsemanship) */
function canBlockAttacker(blocker: GoldfishPermanent, attacker: GoldfishPermanent): boolean {
  // Unblockable: "can't be blocked" in oracle text
  if (attacker.oracleText && /can't be blocked/i.test(attacker.oracleText)) return false;
  // Protection: "protection from" color matching blocker (simplified — check blocker color identity)
  // Shadow: can only be blocked by shadow
  if (hasKeywordGoldfish(attacker, 'shadow')) {
    return hasKeywordGoldfish(blocker, 'shadow');
  }
  // Horsemanship: can only be blocked by horsemanship
  if (hasKeywordGoldfish(attacker, 'horsemanship')) {
    return hasKeywordGoldfish(blocker, 'horsemanship');
  }
  // Flying: only flying or reach can block
  if (hasKeywordGoldfish(attacker, 'flying')) {
    return hasKeywordGoldfish(blocker, 'flying') || hasKeywordGoldfish(blocker, 'reach');
  }
  return true;
}

/** Check if menace is satisfied (needs 2+ blockers) */
function isMenaceSatisfied(attackerPermId: string, combat: CombatState): boolean {
  const blockerCount = combat.blockers.filter(b => b.blockingPermanentId === attackerPermId).length;
  return blockerCount >= 2;
}

/** Check if a permanent has indestructible */
function isIndestructible(perm: GoldfishPermanent): boolean {
  return hasKeywordGoldfish(perm, 'indestructible');
}

/** Check if creature has infect keyword */
function hasInfect(perm: GoldfishPermanent): boolean {
  return hasKeywordGoldfish(perm, 'infect');
}

/** Check if creature has wither keyword */
function hasWither(perm: GoldfishPermanent): boolean {
  return hasKeywordGoldfish(perm, 'wither');
}

/** Check if creature has deathtouch */
function hasDeathtouch(perm: GoldfishPermanent): boolean {
  return hasKeywordGoldfish(perm, 'deathtouch');
}

/** Recalculate current P/T from base + counters */
function recalcPT(perm: GoldfishPermanent): void {
  const basePower = parseInt(perm.power || '0') || 0;
  const baseToughness = parseInt(perm.toughness || '0') || 0;
  const plus = perm.counters['+1/+1'] || 0;
  const minus = perm.counters['-1/-1'] || 0;
  perm.currentPower = basePower + plus - minus;
  perm.currentToughness = baseToughness + plus - minus;
}

// ─── Initialize player from deck ───

function initPlayerFromDeck(
  deck: DeckbuilderDeck,
  playerId: string,
  playerName: string,
  playerColor: string,
): PlayerGameState {
  const allCards: string[] = [];
  for (const entry of deck.boards.mainboard) {
    for (let i = 0; i < entry.qty; i++) allCards.push(entry.name);
  }
  const library = shuffle(allCards);
  const hand = library.splice(0, 7);

  const commandZone: string[] = [];
  if (deck.boards.commander) {
    for (const entry of deck.boards.commander) {
      for (let i = 0; i < entry.qty; i++) commandZone.push(entry.name);
    }
  }

  const playerState = createPlayerGameState(playerId, playerName, playerColor, library, commandZone);
  playerState.hand = hand;
  return playerState;
}

// ═════════════════════════════════════════════════════════════
// MAIN: openMultiplayerGoldfish
// ═════════════════════════════════════════════════════════════

export function openMultiplayerGoldfish(
  decks: { deck: DeckbuilderDeck; playerName: string }[],
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  options?: { mode?: MPGameMode; isHost?: boolean; onlinePlayerId?: string; houseRules?: HouseRules },
): void {
  const gameMode: MPGameMode = options?.mode || 'hotseat';
  const isOnlineHost = options?.isHost ?? true;
  const rules: HouseRules = { ...DEFAULT_HOUSE_RULES, ...options?.houseRules };

  if (gameMode === 'hotseat' && (decks.length < 2 || decks.length > 4)) {
    console.error('[MP Goldfish] Need 2-4 players, got', decks.length);
    return;
  }

  // ─── Initialize players ───
  const playerOrder: string[] = [];
  const players = new Map<string, PlayerGameState>();

  decks.forEach((d, i) => {
    const playerId = `p${i + 1}`;
    const playerName = d.playerName || PLAYER_LABELS[i];
    const playerColor = PLAYER_COLORS[i];
    const playerState = initPlayerFromDeck(d.deck, playerId, playerName, playerColor);
    // Apply custom starting life from house rules
    if (rules.startingLife !== 40) playerState.lifeTotal = rules.startingLife;
    playerOrder.push(playerId);
    players.set(playerId, playerState);
  });

  // Randomize turn order (can be toggled via URL param or default)
  const randomTurnOrder = localStorage.getItem('mp-random-turn-order') !== 'false';
  if (randomTurnOrder && gameMode === 'hotseat') {
    // Shuffle player order for fairness
    for (let i = playerOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerOrder[i], playerOrder[j]] = [playerOrder[j], playerOrder[i]];
    }
  }

  let mpState = createMultiplayerState(playerOrder, players);

  // Local player: p1 for hotseat, dynamic for online
  let localPlayerId = options?.onlinePlayerId || 'p1';

  // ─── Online Multiplayer Setup ───
  if (gameMode === 'online') {
    initMPCollab({
      onRemoteAction: (playerId, action, details, turn) => {
        // Apply remote action to local state
        mpState.sharedLog.push(`T${turn} [${getPlayer(playerId).playerName}]: ${details}`);
        render();
      },
      onRemoteTurnChange: (currentPlayerIndex, turn, activePlayerId) => {
        mpState.currentPlayerIndex = currentPlayerIndex;
        mpState.turn = turn;
        mpState.phase = 'main1';
        mpState.combat = null;
        const newPlayer = getPlayer(activePlayerId);
        newPlayer.landPlayedThisTurn = false;
        newPlayer.battlefield.forEach(p => p.tapped = false);
        render();
      },
      onRemoteCombat: (attackerPlayerId, attackers) => {
        const player = getPlayer(attackerPlayerId);
        // Apply remote combat declarations: set up combat state
        mpState.phase = 'combat';
        mpState.combat = {
          phase: 'declare-blockers',
          attackers: attackers.map(a => ({ permanentId: a.permanentId, attackerPlayerId, targetPlayerId: a.targetPlayerId })),
          blockers: [],
          defendingPlayerIds: [...new Set(attackers.map(a => a.targetPlayerId))],
          activeDefenderIndex: 0,
          hasFirstStrike: false,
          firstStrikeDamageResolved: false,
        };
        // Tap and mark attackers
        for (const atk of attackers) {
          const perm = player.battlefield.find(p => p.id === atk.permanentId);
          if (perm) {
            if (!hasKeywordGoldfish(perm, 'vigilance')) perm.tapped = true;
            perm.attacking = true;
          }
        }
        render();
      },
      onRemoteBlockers: (defenderPlayerId, blockers) => {
        if (!mpState.combat) return;
        const defender = getPlayer(defenderPlayerId);
        // Apply remote blocker declarations
        for (const blk of blockers) {
          const blocker = defender.battlefield.find(p => p.id === blk.permanentId);
          if (blocker) blocker.blockingId = blk.blockingPermanentId;
          // Add to combat state
          mpState.combat.blockers.push({
            permanentId: blk.permanentId,
            blockerPlayerId: defenderPlayerId,
            blockingPermanentId: blk.blockingPermanentId,
          });
        }
        // Advance defender index
        mpState.combat.activeDefenderIndex++;
        if (mpState.combat.activeDefenderIndex >= mpState.combat.defendingPlayerIds.length) {
          // All blockers declared — host resolves damage
          if (isOnlineHost) {
            proceedToDamage();
          }
        }
        render();
      },
      onRemoteStateSync: (stateJson) => {
        try {
          const parsed = JSON.parse(stateJson);
          const synced = deserializeMPState(parsed);
          // Preserve our own hand (server strips it for privacy)
          const ourState = synced.players.get(localPlayerId);
          const localState = mpState.players.get(localPlayerId);
          if (ourState && localState && ourState.hand.length === 0) {
            ourState.hand = localState.hand;
          }
          mpState = synced;
          render();
        } catch (e) {
          console.warn('[MP Online] Failed to parse state sync:', e);
        }
      },
      onPlayerJoined: (playerId, playerName, playerColor) => {
        // Update placeholder player name ("Waiting for Player X..." → actual name)
        const joinedPlayer = mpState.players.get(playerId);
        if (joinedPlayer && joinedPlayer.playerName.startsWith('Waiting for')) {
          joinedPlayer.playerName = playerName || `Player ${playerId.replace('p', '')}`;
        }
        // Also check all players for any "Waiting" placeholders and assign first available
        if (!joinedPlayer) {
          for (const [pid, pState] of mpState.players) {
            if (pState.playerName.startsWith('Waiting for')) {
              pState.playerName = playerName || `Player ${pid.replace('p', '')}`;
              break;
            }
          }
        }
        mpState.sharedLog.push(`${playerName} joined the game`);
        render();
        // Host sends full state to sync the new player
        if (isOnlineHost) {
          broadcastMPStateSync(mpState);
        }
      },
      onPlayerLeft: (playerId) => {
        const player = mpState.players.get(playerId);
        if (player) {
          player.isEliminated = true;
          player.eliminatedReason = 'concede';
          mpState.sharedLog.push(`${player.playerName} disconnected`);
        }
        render();
      },
      onGameCreated: (gameId, hostPlayerId) => {
        mpState.sharedLog.push(`Online game created (ID: ${gameId.slice(0, 8)}...)`);
        render();
      },
    });

    // Host creates the game, joiner joins
    if (isOnlineHost) {
      hostMPGame(decks.length, decks[0].deck.name || 'Untitled', localPlayerId);
    } else {
      joinMPGame(decks[0].deck.name || 'Untitled', localPlayerId);
    }
  }

  // ─── DOM ───
  let ctxMenuEl: HTMLElement | null = null;
  let zoneModalEl: HTMLElement | null = null;

  const overlay = document.createElement('div');
  overlay.className = 'goldfish-overlay mp-goldfish';

  // Raise card preview above overlay
  const previewEl = document.querySelector<HTMLElement>('.card-hover-preview');
  const origPreviewZ = previewEl?.style.zIndex || '';
  if (previewEl) previewEl.style.zIndex = '10000';

  function cleanup(): void {
    broadcastGoldfishEnd('completed', mpState.turn);
    if (gameMode === 'online') {
      leaveMPGame();
      cleanupMPCollab();
    }
    destroyCoachLines();
    hideCtxMenu(); // Remove context menu from document.body
    if (previewEl) previewEl.style.zIndex = origPreviewZ;
    hideHoverPreview();
    overlay.remove();
  }

  // ─── Helpers ───

  function getPlayer(playerId: string): PlayerGameState {
    return mpState.players.get(playerId)!;
  }

  function activePlayer(): PlayerGameState {
    return getActivePlayer(mpState)!;
  }

  function isMyTurn(): boolean {
    // Free play mode: anyone can act at any time
    if (rules.freePlay) return true;
    // In hotseat mode, local player controls all players
    if (gameMode === 'hotseat') return true;
    // In online mode, only the active player can act if it's our turn
    return canPlayerAct(mpState, localPlayerId);
  }

  function nextId(player: PlayerGameState): string {
    return `gf-${player.playerId}-${player.nextPermanentId++}`;
  }

  // ─── Undo (per-player) ───

  function snapshotPlayer(player: PlayerGameState): string {
    const { undoStack: _, ...rest } = player;
    return JSON.stringify(rest);
  }

  function pushUndo(player: PlayerGameState): void {
    player.undoStack.push(snapshotPlayer(player));
    if (player.undoStack.length > MAX_UNDO) player.undoStack.shift();
  }

  function performUndo(playerId: string): void {
    const player = getPlayer(playerId);
    if (player.undoStack.length === 0) return;
    const snap = player.undoStack.pop()!;
    const restored = JSON.parse(snap) as Omit<PlayerGameState, 'undoStack'>;
    const stack = player.undoStack;
    Object.assign(player, restored);
    player.undoStack = stack;
    render();
  }

  // ─── Logging ───

  function addLog(msg: string, playerId?: string): void {
    const player = playerId ? getPlayer(playerId) : activePlayer();
    const pLabel = player.playerName;
    const phaseLbl = PHASE_LABELS[mpState.phase];
    const formatted = `T${mpState.turn} ${phaseLbl} [${pLabel}]: ${msg}`;
    mpState.sharedLog.push(formatted);
    broadcastGoldfishAction(msg, formatted, mpState.turn);
    // Online: broadcast action to remote players
    if (gameMode === 'online' && playerId === localPlayerId) {
      broadcastMPAction(msg, playerId, formatted, mpState.turn);
    }
    // Update coach hints
    const coachPid = playerId || getActivePlayerId(mpState);
    updateCoachState(coachPid);
  }

  // ─── Context Menu ───

  function hideCtxMenu(): void {
    if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
  }

  function showCtxMenu(event: MouseEvent, items: GfCtxItem[]): void {
    hideCtxMenu();
    // Always create a fresh context menu element (old one may have been detached by render())
    ctxMenuEl = document.createElement('div');
    ctxMenuEl.className = 'gf-context-menu';
    for (const item of items) {
      if (item.divider) { const div = document.createElement('div'); div.className = 'gf-ctx-divider'; ctxMenuEl.appendChild(div); }
      const btn = document.createElement('button');
      btn.className = `gf-ctx-item${item.danger ? ' gf-ctx-danger' : ''}`;
      btn.textContent = item.label;
      btn.addEventListener('click', (e) => { e.stopPropagation(); hideCtxMenu(); item.action(); });
      ctxMenuEl.appendChild(btn);
    }
    ctxMenuEl.style.left = '0px'; ctxMenuEl.style.top = '0px'; ctxMenuEl.classList.add('visible');
    // Append to document.body instead of overlay (so render() can't destroy it)
    document.body.appendChild(ctxMenuEl);
    const menuW = 200; const menuH = ctxMenuEl.offsetHeight;
    let left = event.clientX; let top = event.clientY;
    if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 8;
    if (top + menuH > window.innerHeight) top = window.innerHeight - menuH - 8;
    if (left < 0) left = 8; if (top < 0) top = 8;
    ctxMenuEl.style.left = `${left}px`; ctxMenuEl.style.top = `${top}px`;

    // Close on any click outside the menu
    const closeHandler = (ce: MouseEvent) => {
      if (ctxMenuEl && !ctxMenuEl.contains(ce.target as Node)) {
        hideCtxMenu();
        document.removeEventListener('mousedown', closeHandler, true);
      }
    };
    // Delay so the current right-click event doesn't immediately close it
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', closeHandler, true);
    });
  }

  // ─── Zone Modal ───

  function hideZoneModal(): void { if (zoneModalEl) { zoneModalEl.remove(); zoneModalEl = null; } }

  function showZoneModal(title: string, cards: string[], zone: GfZone, playerId: string): void {
    hideZoneModal();
    zoneModalEl = document.createElement('div');
    zoneModalEl.className = 'gf-zone-modal-overlay';
    zoneModalEl.addEventListener('click', (e) => { if (e.target === zoneModalEl) hideZoneModal(); });

    const modal = document.createElement('div');
    modal.className = 'gf-zone-modal';
    modal.innerHTML = `<div class="gf-zone-modal-title">${title} (${cards.length})</div>`;

    // Search filter for graveyard/exile
    const filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.className = 'gf-search-input';
    filterInput.placeholder = 'Filter cards...';
    filterInput.style.cssText = 'margin-bottom:8px;';
    modal.appendChild(filterInput);

    const grid = document.createElement('div');
    grid.className = 'gf-zone-grid';

    function renderZoneCards(filter: string): void {
      grid.textContent = '';
      const filtered = filter
        ? cards.map((name, idx) => ({ name, idx })).filter(c => c.name.toLowerCase().includes(filter.toLowerCase()))
        : cards.map((name, idx) => ({ name, idx }));

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#94a3b8;padding:16px;text-align:center;grid-column:1/-1;';
        empty.textContent = filter ? 'No cards match.' : 'Empty.';
        grid.appendChild(empty);
        return;
      }

      for (const { name: cardName, idx } of filtered) {
        renderZoneCard(cardName, idx);
      }
    }

    function renderZoneCard(cardName: string, idx: number): void {
      const cardEl = document.createElement('div');
      cardEl.className = 'gf-zone-card';
      const img = getImgUrl(cardName, cardByName);
      if (img) {
        cardEl.innerHTML = `<img src="${img}" alt="${cardName}" decoding="async" />`;
      } else {
        cardEl.innerHTML = `<div class="gf-card-fallback">${cardName}</div>`;
      }
      // Flashback/disturb indicator
      const card = getCard(cardName, cardByName);
      if (zone === 'graveyard' && card?.oracle_text) {
        const ot = card.oracle_text.toLowerCase();
        if (ot.includes('flashback') || ot.includes('disturb') || ot.includes('unearth') || ot.includes('escape') || ot.includes('aftermath')) {
          const flashBadge = document.createElement('span');
          flashBadge.className = 'gf-flashback-badge';
          flashBadge.textContent = '↩';
          flashBadge.title = 'Can be cast from graveyard';
          cardEl.appendChild(flashBadge);
          cardEl.classList.add('gf-has-flashback');
        }
      }
      attachPreview(cardEl, cardName);

      // Context menu for zone cards (only for local player)
      if (playerId === localPlayerId) {
        cardEl.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const items: GfCtxItem[] = [];
          if (zone === 'graveyard') {
            items.push({ label: '→ Hand', action: () => { moveCard(playerId, 'graveyard', 'hand', idx); hideZoneModal(); } });
            items.push({ label: '→ Battlefield', action: () => { moveCard(playerId, 'graveyard', 'battlefield', idx); hideZoneModal(); } });
            items.push({ label: '→ Exile', action: () => { moveCard(playerId, 'graveyard', 'exile', idx); hideZoneModal(); } });
          } else if (zone === 'exile') {
            items.push({ label: '→ Hand', action: () => { moveCard(playerId, 'exile', 'hand', idx); hideZoneModal(); } });
            items.push({ label: '→ Battlefield', action: () => { moveCard(playerId, 'exile', 'battlefield', idx); hideZoneModal(); } });
          }
          if (items.length > 0) showCtxMenu(e, items);
        });
      }

      // Click to zoom
      cardEl.addEventListener('click', () => showCardZoom(cardName));

      grid.appendChild(cardEl);
    }

    filterInput.addEventListener('input', () => renderZoneCards(filterInput.value));
    renderZoneCards('');

    modal.appendChild(grid);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'gf-zone-close-btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', hideZoneModal);
    modal.appendChild(closeBtn);

    zoneModalEl.appendChild(modal);
    overlay.appendChild(zoneModalEl);
    setTimeout(() => filterInput.focus(), 50);
  }

  // ─── Card Preview ───

  function attachPreview(el: HTMLElement, cardName: string): void {
    el.addEventListener('mouseenter', () => showHoverPreview(cardName, cardByName));
    el.addEventListener('mouseleave', () => hideHoverPreview());
  }

  /** Show a large card zoom overlay (click to dismiss) */
  function showCardZoom(cardName: string, imgUrl?: string): void {
    const src = imgUrl || getCard(cardName, cardByName)?.image_uris?.normal
      || getCard(cardName, cardByName)?.image_uris?.large
      || getImgUrl(cardName, cardByName);
    if (!src) return;

    const zoomOverlay = document.createElement('div');
    zoomOverlay.className = 'gf-card-zoom-overlay';
    zoomOverlay.addEventListener('click', () => zoomOverlay.remove());

    const img = document.createElement('img');
    img.src = src;
    img.alt = cardName;
    img.className = 'gf-card-zoom-img';

    const label = document.createElement('div');
    label.className = 'gf-card-zoom-label';
    label.textContent = cardName;

    zoomOverlay.appendChild(img);
    zoomOverlay.appendChild(label);
    document.body.appendChild(zoomOverlay);
  }

  // ─── Auto-position ───

  function autoPosition(player: PlayerGameState, isLand: boolean, isCreature: boolean): { x: number; y: number } {
    const bf = player.battlefield;
    const sameType = bf.filter(p => isLand ? p.isLand : isCreature ? p.isCreature : (!p.isLand && !p.isCreature));
    const count = sameType.length;
    const col = count % 8;
    const row = Math.floor(count / 8);
    const x = 5 + col * 12;
    const y = isCreature ? 25 + row * 18 : isLand ? 68 + row * 15 : 3 + row * 18;
    return { x, y };
  }

  // ─── Card Actions ───

  function drawCard(playerId: string): void {
    const player = getPlayer(playerId);
    if (player.library.length === 0) {
      // Empty library draw → player loses (Rule 704.5b)
      player.isEliminated = true;
      player.eliminatedReason = 'library';
      addLog(`${player.playerName} tried to draw from an empty library — eliminated!`, playerId);
      if (shouldGameEnd(mpState)) {
        const winner = getAlivePlayers(mpState)[0];
        if (winner) {
          mpState.winnerId = winner.playerId;
          mpState.gameEndedAt = Date.now();
          addLog(`${winner.playerName} wins the game!`);
        }
      }
      render();
      return;
    }
    pushUndo(player);
    const card = player.library.shift()!;
    player.hand.push(card);
    playSound('draw');
    turnSummary.drawn++;
    trackStat(playerId, 'cardsDrawn');
    addLog(`Drew a card`, playerId);
    render();
  }

  function playFromHand(playerId: string, handIndex: number): void {
    if (!rules.freePlay && !canPlayerAct(mpState, playerId)) return;
    const player = getPlayer(playerId);
    if (handIndex < 0 || handIndex >= player.hand.length) return;
    pushUndo(player);
    const cardName = player.hand.splice(handIndex, 1)[0];
    const { isLand, isCreature, typeLine } = classifyCard(cardName, cardByName);
    if (isLand) {
      if (rules.landPerTurn && player.landPlayedThisTurn) {
        // Put it back — show feedback
        player.hand.splice(handIndex, 0, cardName);
        player.undoStack.pop();
        showFloatingText('Already played a land this turn!', '#f59e0b');
        return;
      }
      if (rules.landPerTurn) player.landPlayedThisTurn = true;
    }
    const pos = autoPosition(player, isLand, isCreature);
    const card = getCard(cardName, cardByName);
    const perm: GoldfishPermanent = {
      id: nextId(player), name: cardName, tapped: false, isLand, isCreature,
      isToken: false, typeLine, imgUrl: getImgUrl(cardName, cardByName),
      counters: {}, x: pos.x, y: pos.y, ownerId: playerId, enteredTurn: mpState.turn,
      damage: 0,
      currentPower: parseInt(card?.power || '0') || 0,
      currentToughness: parseInt(card?.toughness || '0') || 0,
      oracleText: card?.oracle_text || '',
      keywords: card?.keywords || [],
      attacking: false,
      blockingId: null,
    };
    player.battlefield.push(perm);
    setLastAction(perm.id);
    // Storm count: increment for non-land spells
    if (!isLand) stormCount++;
    turnSummary.played++;
    trackStat(playerId, 'cardsPlayed');
    addLog(`Played ${cardName}`, playerId);
    render();
  }

  function tapPermanent(playerId: string, bfIdx: number): void {
    const player = getPlayer(playerId);
    if (bfIdx < 0 || bfIdx >= player.battlefield.length) return;
    pushUndo(player);
    player.battlefield[bfIdx].tapped = !player.battlefield[bfIdx].tapped;
    const p = player.battlefield[bfIdx];
    playSound('tap');
    setLastAction(p.id);
    addLog(`${p.tapped ? 'Tapped' : 'Untapped'} ${p.name}`, playerId);
    render();
  }

  function moveCard(playerId: string, from: GfZone, to: GfZone, index: number): void {
    const player = getPlayer(playerId);
    pushUndo(player);

    let cardName: string;
    if (from === 'battlefield') {
      const removed = player.battlefield.splice(index, 1)[0];
      cardName = removed.name;
      // Clean up equipment attachments (both as equipment and as target)
      equipmentAttachments.delete(removed.id);
      for (const [eqId, targetId] of equipmentAttachments) {
        if (targetId === removed.id) equipmentAttachments.delete(eqId);
      }
      // Commander returns to command zone (check original name for DFC)
      const originalName = removed._savedName || removed.name;
      const dk = decks.find(d => d.playerName === player.playerName)?.deck;
      if ((isCommander(cardName, dk) || isCommander(originalName, dk)) && (to === 'graveyard' || to === 'exile')) {
        player.commandZone.push(originalName);
        addLog(`${cardName} returned to command zone`, playerId);
        render();
        return;
      }
    } else {
      const arr = (player as any)[from] as string[];
      cardName = arr.splice(index, 1)[0];
    }

    if (to === 'battlefield') {
      const { isLand, isCreature, typeLine } = classifyCard(cardName, cardByName);
      const pos = autoPosition(player, isLand, isCreature);
      const card = getCard(cardName, cardByName);
      const perm: GoldfishPermanent = {
        id: nextId(player), name: cardName, tapped: false, isLand, isCreature,
        isToken: false, typeLine, imgUrl: getImgUrl(cardName, cardByName),
        counters: {}, x: pos.x, y: pos.y, ownerId: playerId, enteredTurn: mpState.turn,
        damage: 0,
        currentPower: parseInt(card?.power || '0') || 0,
        currentToughness: parseInt(card?.toughness || '0') || 0,
        oracleText: card?.oracle_text || '',
        keywords: card?.keywords || [],
        attacking: false,
        blockingId: null,
      };
      player.battlefield.push(perm);
      setLastAction(perm.id);
    } else {
      const arr = (player as any)[to] as string[];
      if (to === 'library') arr.unshift(cardName);
      else arr.push(cardName);
    }

    addLog(`Moved ${cardName} from ${from} to ${to}`, playerId);
    render();
  }

  function adjustCounter(playerId: string, bfIdx: number, delta: number, type: string = '+1/+1'): void {
    const player = getPlayer(playerId);
    if (bfIdx < 0 || bfIdx >= player.battlefield.length) return;
    pushUndo(player);
    const p = player.battlefield[bfIdx];
    p.counters[type] = (p.counters[type] || 0) + delta;
    if (p.counters[type] <= 0) delete p.counters[type];
    // Rule 704.5q: +1/+1 and -1/-1 counters annihilate each other
    if ((type === '+1/+1' || type === '-1/-1') && p.counters['+1/+1'] && p.counters['-1/-1']) {
      const annihilate = Math.min(p.counters['+1/+1'], p.counters['-1/-1']);
      p.counters['+1/+1'] -= annihilate;
      p.counters['-1/-1'] -= annihilate;
      if (p.counters['+1/+1'] <= 0) delete p.counters['+1/+1'];
      if (p.counters['-1/-1'] <= 0) delete p.counters['-1/-1'];
    }
    // Recalculate P/T if +1/+1 or -1/-1 counters changed
    if (type === '+1/+1' || type === '-1/-1') recalcPT(p);
    addLog(`${delta > 0 ? '+' : ''}${delta} ${type} counter on ${p.name}`, playerId);
    // Check SBAs (creature may die from -1/-1 counters)
    runStateBasedActions();
    render();
  }

  // ─── Proliferate ───
  function proliferate(playerId: string): void {
    const player = getPlayer(playerId);
    pushUndo(player);
    let count = 0;
    const details: string[] = [];
    for (const perm of player.battlefield) {
      const counterTypes = Object.keys(perm.counters);
      if (counterTypes.length === 0) continue;
      count++;
      for (const ct of counterTypes) {
        perm.counters[ct] = (perm.counters[ct] || 0) + 1;
      }
      // Recalc P/T if +1/+1 or -1/-1 counters
      if (perm.counters['+1/+1'] || perm.counters['-1/-1']) recalcPT(perm);
      details.push(`${perm.name} (${counterTypes.map(c => `+1 ${c}`).join(', ')})`);
    }
    // Also proliferate poison on the player if they have any
    if (player.poisonCounters > 0) {
      player.poisonCounters++;
      details.push(`+1 poison (now ${player.poisonCounters})`);
    }
    if (count > 0 || details.length > 0) {
      addLog(`Proliferated ${count} permanent${count !== 1 ? 's' : ''}: ${details.slice(0, 5).join(', ')}${details.length > 5 ? '...' : ''}`, playerId);
      showFloatingText(`Proliferate ×${count}`, '#34d399');
      playSound('tap');
    } else {
      addLog('Proliferate — no counters to proliferate', playerId);
    }
    runStateBasedActions();
    render();
  }

  // ─── Coin Flip / Dice Roll ───
  function rollDice(sides: number, playerId: string): void {
    const result = Math.floor(Math.random() * sides) + 1;
    const label = sides === 2 ? (result === 1 ? 'Heads' : 'Tails') : `${result}`;
    addLog(`Rolled d${sides}: ${label}`, playerId);
    showFloatingText(`d${sides} → ${label}`, '#60a5fa', 2500);
    playSound('draw');
    render();
  }

  function showDiceRollModal(): void {
    const actionPid = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;
    const diceOverlay = document.createElement('div');
    diceOverlay.className = 'gf-zone-modal-overlay';
    diceOverlay.addEventListener('click', (e) => { if (e.target === diceOverlay) diceOverlay.remove(); });
    const modal = document.createElement('div');
    modal.className = 'gf-zone-modal';
    modal.style.maxWidth = '320px';
    modal.innerHTML = `<div class="gf-zone-modal-title">Dice & Coin</div>`;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px;';
    const diceTypes = [
      { label: 'Coin Flip', sides: 2 },
      { label: 'D6', sides: 6 },
      { label: 'D20', sides: 20 },
      { label: 'D100', sides: 100 },
    ];
    for (const dt of diceTypes) {
      const btn = document.createElement('button');
      btn.className = 'gf-btn';
      btn.style.cssText = 'padding:12px 8px;font-size:1rem;';
      btn.textContent = dt.label;
      btn.addEventListener('click', () => { rollDice(dt.sides, actionPid); diceOverlay.remove(); });
      grid.appendChild(btn);
    }
    modal.appendChild(grid);
    // Custom dice
    const customRow = document.createElement('div');
    customRow.style.cssText = 'display:flex;gap:6px;padding:0 12px 12px;align-items:center;';
    const customLabel = document.createElement('span');
    customLabel.textContent = 'Custom:';
    customLabel.style.cssText = 'font-size:0.8rem;color:#94a3b8;';
    const customInput = document.createElement('input');
    customInput.type = 'number'; customInput.min = '2'; customInput.max = '1000';
    customInput.placeholder = 'Sides';
    customInput.className = 'gf-token-input';
    customInput.style.cssText = 'width:70px;';
    const customBtn = document.createElement('button');
    customBtn.className = 'gf-btn gf-btn-small';
    customBtn.textContent = 'Roll';
    customBtn.addEventListener('click', () => {
      const sides = parseInt(customInput.value, 10);
      if (sides >= 2 && sides <= 1000) { rollDice(sides, actionPid); diceOverlay.remove(); }
    });
    customRow.appendChild(customLabel);
    customRow.appendChild(customInput);
    customRow.appendChild(customBtn);
    modal.appendChild(customRow);
    diceOverlay.appendChild(modal);
    overlay.appendChild(diceOverlay);
    customInput.focus();
  }

  // ─── Random Discard ───
  function randomDiscard(playerId: string): void {
    const player = getPlayer(playerId);
    if (player.hand.length === 0) { addLog('No cards in hand to discard', playerId); return; }
    pushUndo(player);
    const idx = Math.floor(Math.random() * player.hand.length);
    const card = player.hand.splice(idx, 1)[0];
    player.graveyard.push(card);
    addLog(`Randomly discarded: ${card}`, playerId);
    showFloatingText(`Discarded: ${card}`, '#ef4444', 2500);
    playSound('damage');
    render();
  }

  // ─── Battlefield Notes ───
  interface BfNote { id: string; text: string; x: number; y: number; playerId: string; }
  let battlefieldNotes: BfNote[] = [];
  let noteIdCounter = 0;

  function addBattlefieldNote(playerId: string, x: number, y: number): void {
    const text = prompt('Add note (max 60 chars):');
    if (!text || !text.trim()) return;
    battlefieldNotes.push({
      id: `note-${noteIdCounter++}`,
      text: text.trim().slice(0, 60),
      x, y, playerId,
    });
    render();
  }

  function removeBattlefieldNote(noteId: string): void {
    battlefieldNotes = battlefieldNotes.filter(n => n.id !== noteId);
    render();
  }

  // ─── Game Stats Tracking ───
  const gameStats = {
    damageDealt: {} as Record<string, number>,
    cardsPlayed: {} as Record<string, number>,
    cardsDrawn: {} as Record<string, number>,
    creaturesKilled: 0,
    combatPhases: 0,
    spellsCast: 0,
    lifeTotalHistory: {} as Record<string, number[]>,
    turnHistory: [] as { turn: number; phase: Phase; playerId: string; action: string }[],
  };

  function trackStat(playerId: string, stat: 'damageDealt' | 'cardsPlayed' | 'cardsDrawn', amount: number = 1): void {
    (gameStats[stat] as Record<string, number>)[playerId] = ((gameStats[stat] as Record<string, number>)[playerId] || 0) + amount;
  }

  function trackLifeHistory(): void {
    for (const pid of mpState.playerOrder) {
      const p = getPlayer(pid);
      if (!gameStats.lifeTotalHistory[pid]) gameStats.lifeTotalHistory[pid] = [];
      gameStats.lifeTotalHistory[pid].push(p.lifeTotal);
    }
  }

  // ─── Game Replay Snapshots ───
  const MAX_SNAPSHOTS = 200;
  const replaySnapshots: string[] = [];
  let replayMode = false;
  let replayIndex = -1;

  function captureSnapshot(): void {
    if (replayMode) return; // Don't capture while replaying
    const snap = JSON.stringify(serializeMPState(mpState));
    replaySnapshots.push(snap);
    if (replaySnapshots.length > MAX_SNAPSHOTS) replaySnapshots.shift();
  }

  function viewReplayAt(index: number): void {
    if (index < 0 || index >= replaySnapshots.length) return;
    replayIndex = index;
    replayMode = true;
    const data = JSON.parse(replaySnapshots[index]);
    const replayState = deserializeMPState(data);
    // Temporarily swap mpState for rendering
    const savedState = mpState;
    mpState = replayState;
    render();
    mpState = savedState;
  }

  function exitReplay(): void {
    replayMode = false;
    replayIndex = -1;
    render();
  }

  // ─── Emotes ───
 const EMOTE_LIST = ['😂', '🤔', '👍', '😱', 'gg', '👏'] as const;
  let activeEmotes: { playerId: string; emote: string; timer: ReturnType<typeof setTimeout> }[] = [];

  function sendEmote(playerId: string, emote: string): void {
    // Remove existing emote from same player
    activeEmotes = activeEmotes.filter(e => e.playerId !== playerId);
    const timer = setTimeout(() => {
      activeEmotes = activeEmotes.filter(e => e.playerId !== playerId);
      render();
    }, 3000);
    activeEmotes.push({ playerId, emote, timer });
    addLog(`${emote}`, playerId);
    if (gameMode === 'online') broadcastMPAction(`emote:${emote}`, playerId, `${emote}`, mpState.turn);
    render();
  }

  function untapAll(playerId: string): void {
    const player = getPlayer(playerId);
    pushUndo(player);
    player.battlefield.forEach(p => p.tapped = false);
    addLog('Untapped all permanents', playerId);
    render();
  }

  function shuffleLibrary(playerId: string): void {
    const player = getPlayer(playerId);
    pushUndo(player);
    player.library = shuffle(player.library);
    addLog('Shuffled library', playerId);
    render();
  }

  function adjustLife(playerId: string, delta: number): void {
    const player = getPlayer(playerId);
    pushUndo(player);
    player.lifeTotal += delta;
    addLog(`Life: ${player.lifeTotal} (${delta > 0 ? '+' : ''}${delta})`, playerId);
    showFloatingDamage(playerId, delta);
    checkElimination(playerId);
    render();
  }

  function adjustPoison(playerId: string, delta: number): void {
    const player = getPlayer(playerId);
    pushUndo(player);
    player.poisonCounters = Math.max(0, player.poisonCounters + delta);
    addLog(`Poison: ${player.poisonCounters} (${delta > 0 ? '+' : ''}${delta})`, playerId);
    checkElimination(playerId);
    render();
  }

  function castCommander(playerId: string, cmdIdx: number): void {
    if (!rules.freePlay && !canPlayerAct(mpState, playerId)) return;
    const player = getPlayer(playerId);
    if (cmdIdx < 0 || cmdIdx >= player.commandZone.length) return;
    pushUndo(player);
    const cardName = player.commandZone.splice(cmdIdx, 1)[0];
    player.commanderTax += 2;
    const { isLand, isCreature, typeLine } = classifyCard(cardName, cardByName);
    const pos = autoPosition(player, isLand, isCreature);
    const card = getCard(cardName, cardByName);
    const perm: GoldfishPermanent = {
      id: nextId(player), name: cardName, tapped: false, isLand, isCreature,
      isToken: false, typeLine, imgUrl: getImgUrl(cardName, cardByName),
      counters: {}, x: pos.x, y: pos.y, ownerId: playerId, enteredTurn: mpState.turn,
      damage: 0,
      currentPower: parseInt(card?.power || '0') || 0,
      currentToughness: parseInt(card?.toughness || '0') || 0,
      oracleText: card?.oracle_text || '',
      keywords: card?.keywords || [],
      attacking: false,
      blockingId: null,
    };
    player.battlefield.push(perm);
    addLog(`Cast commander ${cardName} (tax: ${player.commanderTax - 2})`, playerId);
    render();
  }

  function isCommander(name: string, deck?: DeckbuilderDeck): boolean {
    if (!deck) return false;
    return deck.boards.commander?.some(e => e.name === name) || false;
  }

  // ─── London Mulligan ───
  const mulliganCounts = new Map<string, number>(); // Track mulligan count per player

  function mulliganHand(playerId: string): void {
    const player = getPlayer(playerId);
    pushUndo(player);

    // Track mulligan count
    const prevCount = mulliganCounts.get(playerId) || 0;
    const newCount = prevCount + 1;
    mulliganCounts.set(playerId, newCount);

    // Collect ALL cards from ALL zones back into the library
    const allCards = [
      ...player.library,
      ...player.hand,
      ...player.graveyard,
      ...player.exile,
      ...player.battlefield.filter(p => !p.isToken).map(p => p.name),
    ];

    // Remove commanders from the pile — they go to command zone
    const deck = decks.find(d => d.playerName === player.playerName)?.deck;
    const commanderNames = new Set<string>();
    if (deck?.boards.commander) {
      for (const entry of deck.boards.commander) commanderNames.add(entry.name);
    }

    const nonCommanderCards = allCards.filter(c => !commanderNames.has(c));

    player.library = shuffle(nonCommanderCards);
    player.hand = player.library.splice(0, 7);
    player.battlefield = [];
    player.graveyard = [];
    player.exile = [];
    player.lifeTotal = 40;
    player.poisonCounters = 0;
    player.commanderTax = 0;
    player.landPlayedThisTurn = false;

    // Restore commanders to command zone
    player.commandZone = [];
    if (deck?.boards.commander) {
      for (const entry of deck.boards.commander) {
        for (let i = 0; i < entry.qty; i++) player.commandZone.push(entry.name);
      }
    }

    // London Mulligan: put N cards on bottom (N = mulligan count)
    if (newCount > 0 && player.hand.length >= newCount) {
      showLondonMulliganModal(playerId, newCount);
    }

    addLog(`Mulligan #${newCount} — draw 7, put ${newCount} on bottom`, playerId);
    render();
  }

  /** London Mulligan modal: let player choose N cards to put on bottom */
  function showLondonMulliganModal(playerId: string, putBackCount: number): void {
    const player = getPlayer(playerId);
    const selected = new Set<number>();

    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'gf-zone-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'gf-zone-modal';
    modal.style.maxWidth = '600px';

    const title = document.createElement('div');
    title.className = 'gf-zone-modal-title';
    title.textContent = `London Mulligan — Put ${putBackCount} card${putBackCount > 1 ? 's' : ''} on bottom`;
    modal.appendChild(title);

    const hint = document.createElement('div');
    hint.style.cssText = 'color:#94a3b8;font-size:0.78rem;text-align:center;margin-bottom:8px;';
    hint.textContent = `Click ${putBackCount} card${putBackCount > 1 ? 's' : ''} to put on the bottom of your library.`;
    modal.appendChild(hint);

    const cardGrid = document.createElement('div');
    cardGrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center;padding:8px;';

    function renderCards(): void {
      cardGrid.innerHTML = '';
      player.hand.forEach((cardName, idx) => {
        const cardEl = document.createElement('div');
        cardEl.className = `gf-hand-card${selected.has(idx) ? ' gf-hand-dimmed' : ''}`;
        cardEl.style.cssText = `width:90px;cursor:pointer;border:2px solid ${selected.has(idx) ? '#ef4444' : 'transparent'};border-radius:8px;transition:all 0.15s;`;
        const img = getImgUrl(cardName, cardByName);
        if (img) cardEl.innerHTML = `<img src="${img}" alt="${cardName}" decoding="async" style="width:100%;border-radius:6px;" />`;
        else cardEl.innerHTML = `<div class="gf-card-fallback">${cardName}</div>`;
        cardEl.addEventListener('click', () => {
          if (selected.has(idx)) selected.delete(idx);
          else if (selected.size < putBackCount) selected.add(idx);
          renderCards();
          confirmBtn.disabled = selected.size !== putBackCount;
          confirmBtn.textContent = selected.size === putBackCount
 ? ` Put ${putBackCount} on Bottom`
            : `Select ${putBackCount - selected.size} more`;
        });
        cardGrid.appendChild(cardEl);
      });
    }
    modal.appendChild(cardGrid);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'gf-btn gf-btn-phase';
    confirmBtn.textContent = `Select ${putBackCount} card${putBackCount > 1 ? 's' : ''}`;
    confirmBtn.disabled = true;
    confirmBtn.style.cssText = 'display:block;margin:12px auto 0;';
    confirmBtn.addEventListener('click', () => {
      // Put selected cards on bottom of library
      const putBack = [...selected].sort((a, b) => b - a); // reverse order for safe splice
      for (const idx of putBack) {
        const card = player.hand.splice(idx, 1)[0];
        player.library.push(card);
      }
      modalOverlay.remove();
      addLog(`Put ${putBackCount} card${putBackCount > 1 ? 's' : ''} on bottom (London Mulligan)`, playerId);
      render();
    });
    modal.appendChild(confirmBtn);

    renderCards();
    modalOverlay.appendChild(modal);
    overlay.appendChild(modalOverlay);
  }

  // ─── Token Creation Modal ───

  function showTokenCreationModal(): void {
    const actionPlayerId = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;
    const player = getPlayer(actionPlayerId);

    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'gf-zone-modal-overlay';
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'gf-zone-modal gf-token-modal';
    modal.style.maxWidth = '560px';

    const title = document.createElement('div');
    title.className = 'gf-zone-modal-title';
 title.textContent = '□ Create Token';
    modal.appendChild(title);

    // Collect ALL available tokens from all decks
    const allTokens = new Map<string, { name: string; power?: string; toughness?: string; typeLine: string; imgUrl: string; source: string }>();

    for (const d of decks) {
      const allEntries = [...(d.deck.boards.mainboard || []), ...(d.deck.boards.commander || []), ...(d.deck.boards.sideboard || [])];
      for (const entry of allEntries) {
        const c = getCard(entry.name, cardByName);
        if (c?.oracle_text) {
          const detected = extractTokensFromOracle(c.oracle_text);
          for (const dt of detected) {
            const key = dt.power ? `${dt.name}-${dt.power}/${dt.toughness}` : dt.name;
            if (!allTokens.has(key)) {
              allTokens.set(key, { name: dt.name, power: dt.power, toughness: dt.toughness, typeLine: dt.typeLine, imgUrl: tokenImageCache.get(dt.name) || '', source: entry.name });
            }
          }
        }
      }
    }

    // Also include tokens already on battlefield
    for (const [, p] of mpState.players) {
      for (const perm of p.battlefield) {
        if (perm.isToken) {
          const key = perm.power ? `${perm.name}-${perm.power}/${perm.toughness}` : perm.name;
          if (!allTokens.has(key)) allTokens.set(key, { name: perm.name, power: perm.power, toughness: perm.toughness, typeLine: perm.typeLine, imgUrl: perm.imgUrl, source: 'Battlefield' });
        }
      }
    }

    // Token grid
    if (allTokens.size > 0) {
      const gridLabel = document.createElement('div');
      gridLabel.className = 'gf-quick-pick-label';
      gridLabel.textContent = `Tokens from decks (${allTokens.size}) \u2014 click=1, shift+click=5:`;
      modal.appendChild(gridLabel);

      const tokenGrid = document.createElement('div');
      tokenGrid.className = 'gf-token-grid';

      for (const [, tmpl] of allTokens) {
        const tokenCard = document.createElement('div');
        tokenCard.className = 'gf-token-grid-card';
        tokenCard.title = `${tmpl.name}${tmpl.power ? ` ${tmpl.power}/${tmpl.toughness}` : ''} \u2014 from ${tmpl.source}`;

        if (tmpl.imgUrl) {
          const img = document.createElement('img');
          img.src = tmpl.imgUrl;
          img.alt = tmpl.name;
          img.loading = 'lazy';
          tokenCard.appendChild(img);
        } else {
          const placeholder = document.createElement('div');
          placeholder.className = 'gf-token-grid-placeholder';
          placeholder.textContent = tmpl.name;
          tokenCard.appendChild(placeholder);
        }

        const label = document.createElement('div');
        label.className = 'gf-token-grid-label';
        label.textContent = tmpl.power ? `${tmpl.name} ${tmpl.power}/${tmpl.toughness}` : tmpl.name;
        tokenCard.appendChild(label);

        tokenCard.addEventListener('click', (e) => {
          const count = e.shiftKey ? 5 : 1;
          const imgUrl = tokenImageCache.get(tmpl.name) || tmpl.imgUrl;
          createTokensFromTemplate(actionPlayerId, { name: tmpl.name, power: tmpl.power, toughness: tmpl.toughness, typeLine: tmpl.typeLine, imgUrl }, count);
          if (!imgUrl) {
            fetchTokenImage(tmpl.name).then(url => {
              if (url) {
                for (const bf of player.battlefield) { if (bf.isToken && bf.name === tmpl.name && !bf.imgUrl) bf.imgUrl = url; }
                render();
              }
            });
          }
          modalOverlay.remove();
        });

        tokenGrid.appendChild(tokenCard);
      }
      modal.appendChild(tokenGrid);
    } else {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'color:#94a3b8;font-size:0.82rem;padding:12px 0;text-align:center;';
      emptyMsg.textContent = 'No token-producing cards detected in decks.';
      modal.appendChild(emptyMsg);
    }

    // Custom Token (collapsible)
    const customToggle = document.createElement('button');
    customToggle.className = 'btn gf-btn';
    customToggle.style.cssText = 'margin-top:12px;width:100%;font-size:0.78rem;';
    customToggle.textContent = '+ Custom Token';
    const customSection = document.createElement('div');
    customSection.style.display = 'none';
    customToggle.addEventListener('click', () => {
      customSection.style.display = customSection.style.display === 'none' ? 'block' : 'none';
      customToggle.textContent = customSection.style.display === 'none' ? '+ Custom Token' : '\u2212 Custom Token';
      if (customSection.style.display !== 'none') setTimeout(() => (document.getElementById('_mpTkName') as HTMLInputElement)?.focus(), 50);
    });
    modal.appendChild(customToggle);

    const fields: { label: string; id: string; type: string; placeholder: string }[] = [
      { label: 'Name', id: '_mpTkName', type: 'text', placeholder: 'e.g. Soldier, Treasure' },
      { label: 'Power', id: '_mpTkPower', type: 'text', placeholder: 'e.g. 1, *' },
      { label: 'Toughness', id: '_mpTkToughness', type: 'text', placeholder: 'e.g. 1, *' },
      { label: 'Creature Type', id: '_mpTkType', type: 'text', placeholder: 'e.g. Creature \u2014 Soldier' },
      { label: 'Quantity', id: '_mpTkQty', type: 'number', placeholder: '1' },
    ];

    for (const f of fields) {
      const lbl = document.createElement('label');
      lbl.className = 'gf-token-label';
      lbl.textContent = f.label;
      customSection.appendChild(lbl);
      const inp = document.createElement('input');
      inp.type = f.type;
      inp.id = f.id;
      inp.className = 'gf-token-input';
      inp.placeholder = f.placeholder;
      if (f.id === '_mpTkQty') { inp.min = '1'; inp.max = '20'; inp.value = '1'; }
      customSection.appendChild(inp);
    }

    const customActions = document.createElement('div');
    customActions.className = 'gf-token-actions';
    const customCreateBtn = document.createElement('button');
    customCreateBtn.className = 'btn gf-btn';
    customCreateBtn.style.background = 'var(--cobalt, #c9a84c)';
    customCreateBtn.style.color = '#000';
    customCreateBtn.textContent = 'Create Custom';
    customCreateBtn.addEventListener('click', () => {
      const name = (document.getElementById('_mpTkName') as HTMLInputElement)?.value?.trim() || 'Token';
      const power = (document.getElementById('_mpTkPower') as HTMLInputElement)?.value?.trim() || undefined;
      const toughness = (document.getElementById('_mpTkToughness') as HTMLInputElement)?.value?.trim() || undefined;
      const typeLine = (document.getElementById('_mpTkType') as HTMLInputElement)?.value?.trim() || (power ? 'Creature \u2014 Token' : 'Token');
      const qty = Math.max(1, Math.min(20, parseInt((document.getElementById('_mpTkQty') as HTMLInputElement)?.value || '1', 10) || 1));
      const cachedImg = tokenImageCache.get(name) || '';
      createTokensFromTemplate(actionPlayerId, { name, power, toughness, typeLine, imgUrl: cachedImg }, qty);
      if (!cachedImg) {
        fetchTokenImage(name).then(url => {
          if (url) { for (const bf of player.battlefield) { if (bf.isToken && bf.name === name && !bf.imgUrl) bf.imgUrl = url; } render(); }
        });
      }
      modalOverlay.remove();
    });
    customActions.appendChild(customCreateBtn);
    customSection.appendChild(customActions);
    modal.appendChild(customSection);

    // Close button
    const closeActions = document.createElement('div');
    closeActions.className = 'gf-token-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn gf-btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => modalOverlay.remove());
    closeActions.appendChild(closeBtn);
    modal.appendChild(closeActions);

    modalOverlay.appendChild(modal);
    overlay.appendChild(modalOverlay);
  }

  function createTokensFromTemplate(playerId: string, template: { name: string; power?: string; toughness?: string; typeLine: string; imgUrl: string }, qty: number): void {
    const player = getPlayer(playerId);
    pushUndo(player);
    for (let i = 0; i < qty; i++) {
      const pos = autoPosition(player, false, !!template.power);
      const perm: GoldfishPermanent = {
        id: nextId(player), name: template.name, tapped: false, isLand: false,
        isCreature: !!template.power, isToken: true, typeLine: template.typeLine,
        imgUrl: template.imgUrl, counters: {}, power: template.power, toughness: template.toughness,
        x: pos.x, y: pos.y, ownerId: playerId, enteredTurn: mpState.turn,
        damage: 0,
        currentPower: parseInt(template.power || '0') || 0,
        currentToughness: parseInt(template.toughness || '0') || 0,
        oracleText: '', keywords: [], attacking: false, blockingId: null,
      };
      player.battlefield.push(perm);
    }
    addLog(`Created ${qty}x ${template.name}${template.power && template.toughness ? ` ${template.power}/${template.toughness}` : ''} token${qty > 1 ? 's' : ''}`, playerId);
    render();
  }

  // ─── Library Search Modal ───

  function showLibrarySearchModal(): void {
    const actionPlayerId = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;
    const player = getPlayer(actionPlayerId);

    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'gf-zone-modal-overlay';
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'gf-zone-modal gf-search-modal';

    const titleEl = document.createElement('div');
    titleEl.className = 'gf-zone-modal-title';
 titleEl.textContent = `◇ Search Library (${player.library.length} cards)`;
    modal.appendChild(titleEl);

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'gf-search-input';
    searchInput.placeholder = 'Type to filter cards...';
    modal.appendChild(searchInput);

    const grid = document.createElement('div');
    grid.className = 'gf-zone-modal-grid';
    modal.appendChild(grid);

    function renderSearchResults(filter: string): void {
      grid.textContent = '';
      const indexed = player.library.map((name, idx) => ({ name, idx }));
      const filtered = filter ? indexed.filter(c => c.name.toLowerCase().includes(filter.toLowerCase())) : indexed;

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#94a3b8;padding:16px;text-align:center;grid-column:1/-1;';
        empty.textContent = filter ? 'No cards match.' : 'Library is empty.';
        grid.appendChild(empty);
        return;
      }

      for (const { name, idx } of filtered) {
        const cardEl = document.createElement('div');
        cardEl.className = 'gf-zone-modal-card';
        cardEl.title = 'Left-click: \u2192 Hand | Right-click: more options';

        const imgUrl = getImgUrl(name, cardByName);
        if (imgUrl) {
          const img = document.createElement('img');
          img.src = imgUrl;
          img.alt = name;
          img.loading = 'lazy';
          cardEl.appendChild(img);
        } else {
          cardEl.textContent = name;
          cardEl.style.cssText = 'font-size:0.72rem;color:#94a3b8;padding:8px;background:rgba(255,255,255,0.04);min-height:60px;display:flex;align-items:center;justify-content:center;';
        }

        attachPreview(cardEl, name);

        // Left-click → Hand + shuffle
        cardEl.addEventListener('click', () => {
          pushUndo(player);
          player.library.splice(idx, 1);
          player.hand.push(name);
          player.library = shuffle(player.library);
          addLog(`Searched: ${name} \u2192 Hand (library shuffled)`, actionPlayerId);
          modalOverlay.remove();
          render();
        });

        // Right-click → context menu
        cardEl.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          showCtxMenu(ev, [
            { label: '\u2192 Hand (shuffle)', action: () => {
              pushUndo(player); player.library.splice(idx, 1); player.hand.push(name);
              player.library = shuffle(player.library);
              addLog(`Searched: ${name} \u2192 Hand (library shuffled)`, actionPlayerId);
              modalOverlay.remove(); render();
            }},
            { label: '\u2192 Battlefield (shuffle)', action: () => {
              pushUndo(player); player.library.splice(idx, 1);
              const { isLand, isCreature, typeLine } = classifyCard(name, cardByName);
              const pos = autoPosition(player, isLand, isCreature);
              const card = getCard(name, cardByName);
              const perm: GoldfishPermanent = {
                id: nextId(player), name, tapped: false, isLand, isCreature,
                isToken: false, typeLine, imgUrl: getImgUrl(name, cardByName),
                counters: {}, x: pos.x, y: pos.y, ownerId: actionPlayerId, enteredTurn: mpState.turn,
                damage: 0, currentPower: parseInt(card?.power || '0') || 0,
                currentToughness: parseInt(card?.toughness || '0') || 0,
                oracleText: card?.oracle_text || '', keywords: card?.keywords || [],
                attacking: false, blockingId: null,
              };
              player.battlefield.push(perm);
              player.library = shuffle(player.library);
              addLog(`Searched: ${name} \u2192 Battlefield (library shuffled)`, actionPlayerId);
              modalOverlay.remove(); render();
            }},
            { label: '\u2192 Graveyard (shuffle)', action: () => {
              pushUndo(player); player.library.splice(idx, 1); player.graveyard.push(name);
              player.library = shuffle(player.library);
              addLog(`Searched: ${name} \u2192 Graveyard (library shuffled)`, actionPlayerId);
              modalOverlay.remove(); render();
            }},
            { label: '\u2192 Top of Library (no shuffle)', action: () => {
              pushUndo(player); player.library.splice(idx, 1); player.library.unshift(name);
              addLog(`Searched: ${name} \u2192 Top of Library`, actionPlayerId);
              modalOverlay.remove(); render();
            }},
          ]);
        });

        grid.appendChild(cardEl);
      }
    }

    searchInput.addEventListener('input', () => renderSearchResults(searchInput.value));
    renderSearchResults('');

    modalOverlay.appendChild(modal);
    overlay.appendChild(modalOverlay);
    setTimeout(() => searchInput.focus(), 50);
  }

  // ─── Library Top N Peek ───

  function showTopNModal(): void {
    const actionPlayerId = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;
    const player = getPlayer(actionPlayerId);
    if (player.library.length === 0) { addLog('Library is empty \u2014 cannot peek', actionPlayerId); render(); return; }

    const phase1Overlay = document.createElement('div');
    phase1Overlay.className = 'gf-zone-modal-overlay';
    phase1Overlay.addEventListener('click', (e) => { if (e.target === phase1Overlay) phase1Overlay.remove(); });

    const phase1Modal = document.createElement('div');
    phase1Modal.className = 'gf-zone-modal gf-topn-modal';

    const p1Title = document.createElement('div');
    p1Title.className = 'gf-zone-modal-title';
 p1Title.textContent = '◇ Look at Top N Cards';
    phase1Modal.appendChild(p1Title);

    const p1Label = document.createElement('label');
    p1Label.className = 'gf-token-label';
    p1Label.textContent = `How many? (1-${Math.min(10, player.library.length)})`;
    phase1Modal.appendChild(p1Label);

    const p1Input = document.createElement('input');
    p1Input.type = 'number';
    p1Input.className = 'gf-token-input';
    p1Input.min = '1';
    p1Input.max = String(Math.min(10, player.library.length));
    p1Input.value = String(Math.min(3, player.library.length));
    phase1Modal.appendChild(p1Input);

    const p1Actions = document.createElement('div');
    p1Actions.className = 'gf-token-actions';

    const p1Cancel = document.createElement('button');
    p1Cancel.className = 'btn gf-btn';
    p1Cancel.textContent = 'Cancel';
    p1Cancel.addEventListener('click', () => phase1Overlay.remove());

    const p1Look = document.createElement('button');
    p1Look.className = 'btn gf-btn';
    p1Look.style.background = 'var(--cobalt, #c9a84c)';
    p1Look.style.color = '#000';
    p1Look.textContent = 'Look';
    p1Look.addEventListener('click', () => {
      const n = Math.max(1, Math.min(Math.min(10, player.library.length), parseInt(p1Input.value, 10) || 1));
      phase1Overlay.remove();
      showTopNPhase2(actionPlayerId, n);
    });

    p1Actions.appendChild(p1Cancel);
    p1Actions.appendChild(p1Look);
    phase1Modal.appendChild(p1Actions);

    phase1Overlay.appendChild(phase1Modal);
    overlay.appendChild(phase1Overlay);
    setTimeout(() => { p1Input.focus(); p1Input.select(); }, 50);
  }

  function showTopNPhase2(playerId: string, n: number): void {
    const player = getPlayer(playerId);
    const topCards = player.library.slice(0, n);
    const cardStates: { name: string; dest: 'top' | 'bottom' | 'graveyard' | 'hand' }[] = topCards.map(name => ({ name, dest: 'top' }));

    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'gf-zone-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'gf-zone-modal gf-topn-modal';
    modal.style.maxWidth = '560px';

    const titleEl = document.createElement('div');
    titleEl.className = 'gf-zone-modal-title';
    titleEl.textContent = `Top ${n} Cards \u2014 Reorder & Place`;
    modal.appendChild(titleEl);

    const listEl = document.createElement('div');
    listEl.className = 'gf-topn-list';
    modal.appendChild(listEl);

    function renderTopNList(): void {
      listEl.textContent = '';
      for (let i = 0; i < cardStates.length; i++) {
        const cs = cardStates[i];
        const row = document.createElement('div');
        row.className = 'gf-topn-row';

        // Thumbnail
        const thumb = document.createElement('div');
        thumb.className = 'gf-topn-thumb';
        const imgUrl = getImgUrl(cs.name, cardByName);
        if (imgUrl) {
          const img = document.createElement('img');
          img.src = imgUrl;
          img.alt = cs.name;
          thumb.appendChild(img);
        } else {
          thumb.textContent = cs.name.slice(0, 10);
        }
        attachPreview(thumb, cs.name);
        row.appendChild(thumb);

        // Name
        const nameEl = document.createElement('span');
        nameEl.className = 'gf-topn-name';
        nameEl.textContent = cs.name;
        row.appendChild(nameEl);

        // Reorder buttons
        const reorder = document.createElement('div');
        reorder.className = 'gf-topn-reorder';
        if (i > 0) {
          const upBtn = document.createElement('button');
          upBtn.className = 'btn gf-btn-sm';
          upBtn.textContent = '\u25B2';
          upBtn.title = 'Move up';
          upBtn.addEventListener('click', () => { [cardStates[i - 1], cardStates[i]] = [cardStates[i], cardStates[i - 1]]; renderTopNList(); });
          reorder.appendChild(upBtn);
        }
        if (i < cardStates.length - 1) {
          const downBtn = document.createElement('button');
          downBtn.className = 'btn gf-btn-sm';
          downBtn.textContent = '\u25BC';
          downBtn.title = 'Move down';
          downBtn.addEventListener('click', () => { [cardStates[i], cardStates[i + 1]] = [cardStates[i + 1], cardStates[i]]; renderTopNList(); });
          reorder.appendChild(downBtn);
        }
        row.appendChild(reorder);

        // Destination radio buttons
        const destEl = document.createElement('div');
        destEl.className = 'gf-topn-dest';
        for (const d of ['top', 'bottom', 'hand', 'graveyard'] as const) {
          const label = document.createElement('label');
          label.className = `gf-topn-dest-label${cs.dest === d ? ' active' : ''}`;
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = `topn-dest-${i}`;
          radio.value = d;
          radio.checked = cs.dest === d;
          radio.addEventListener('change', () => { cs.dest = d; renderTopNList(); });
          label.appendChild(radio);
          label.appendChild(document.createTextNode(d === 'top' ? 'Top' : d === 'bottom' ? 'Bottom' : d === 'hand' ? 'Hand' : 'GY'));
          destEl.appendChild(label);
        }
        row.appendChild(destEl);

        listEl.appendChild(row);
      }
    }

    renderTopNList();

    const actions = document.createElement('div');
    actions.className = 'gf-token-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn gf-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => modalOverlay.remove());

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn gf-btn';
    confirmBtn.style.background = 'var(--cobalt, #c9a84c)';
    confirmBtn.style.color = '#000';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.addEventListener('click', () => {
      pushUndo(player);
      player.library.splice(0, n);
      const toTop: string[] = [];
      const toBottom: string[] = [];
      for (const cs of cardStates) {
        if (cs.dest === 'top') toTop.push(cs.name);
        else if (cs.dest === 'bottom') toBottom.push(cs.name);
        else if (cs.dest === 'hand') player.hand.push(cs.name);
        else player.graveyard.push(cs.name);
      }
      player.library.unshift(...toTop);
      player.library.push(...toBottom);
      const summary = cardStates.map(cs => `${cs.name} \u2192 ${cs.dest}`).join(', ');
      addLog(`Top ${n}: ${summary}`, playerId);
      modalOverlay.remove();
      render();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);

    modalOverlay.appendChild(modal);
    overlay.appendChild(modalOverlay);
  }

  // ─── Help / Keybinds Modal ───

  function showKeybindsHelp(): void {
    const bindings: [string, string][] = [
      ['Space', 'Next Phase'],
      ['Enter', 'End Turn (skip to next player)'],
      ['D', 'Draw a Card'],
      ['U', 'Untap All'],
      ['F', 'Enter Combat'],
      ['A', 'Attack with All'],
      ['B', 'Confirm Blockers'],
      ['T', 'Create Token'],
      ['S', 'Search Library'],
      ['L', 'Look at Top N Cards'],
      ['R', 'Scry (Top of Library)'],
      ['N', 'Reveal Top Card'],
      ['G', 'View Graveyard'],
      ['X', 'View Exile'],
      ['M', 'London Mulligan'],
      ['P', 'Proliferate (all counters +1)'],
      ['C', 'Toggle Coach'],
      ['Ctrl+Z', 'Undo Last Action'],
      ['1-4', 'Scroll to Player Zone'],
      ['Esc', 'Deselect / Close / Exit'],
      ['?', 'Show This Help'],
    ];
    const tips: string[] = [
      'Click a card in hand to play it (or drag to battlefield)',
      'Click a battlefield card to zoom in (large view)',
      'Ctrl+Click OR Double-Click a permanent to tap/untap',
      'Right-click cards for more options (counters, mana, move, tokens, transform)',
      'Right-click → "Transform" for double-faced cards (DFCs)',
      'Right-click → "Turn Face Down" for morph/manifest',
      'Right-click → "Bottom of Library" for tuck effects',
      'Right-click tokens for "Copy Token" option',
      'Drag permanents to reposition on battlefield',
      'Drag hand cards to Graveyard/Exile zones',
      'Click life total to type a new value directly',
      'Click poison counter for +1, right-click for -1',
      'Commanders auto-return to Command Zone when killed/exiled',
      'Search (S) auto-shuffles after picking a card',
      'Top N (L) lets you peek and reorder top cards',
      'Shift+Click on a token template = create 5 at once',
      'Shift+Click Mill = mill 3 cards at once',
      'Click phase steps to jump ahead to that phase',
      'Non-playable hand cards are dimmed (land already played, etc.)',
      'Counter types: +1/+1, -1/-1, loyalty, lore, charge, shield, custom',
      'Storm count shows in the phase bar when spells are cast',
      'Sagas auto-advance lore counters at the start of each turn',
      'Right-click Equipment → "Equip" to attach it to a creature',
      'Battlefield cards are grouped by type (Creatures / Other / Lands)',
      'Life sparkline graph shows each player\'s life trend over time',
      'Hover over any card to see a preview tooltip',
      'Cards with flashback/disturb/unearth show ↩ in the graveyard',
      'Turn order is randomized in hotseat mode for fairness',
    ];

    const helpOverlay = document.createElement('div');
    helpOverlay.className = 'gf-help-overlay';
    helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) helpOverlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'gf-help-modal';

    const htitle = document.createElement('h2');
    htitle.className = 'gf-help-title';
    htitle.textContent = '\u2328 Keyboard Shortcuts';
    modal.appendChild(htitle);

    const grid = document.createElement('div');
    grid.className = 'gf-help-grid';
    for (const [key, desc] of bindings) {
      const keyEl = document.createElement('kbd');
      keyEl.className = 'gf-help-key';
      keyEl.textContent = key;
      const descEl = document.createElement('span');
      descEl.className = 'gf-help-desc';
      descEl.textContent = desc;
      grid.appendChild(keyEl);
      grid.appendChild(descEl);
    }
    modal.appendChild(grid);

    const tipsTitle = document.createElement('h3');
    tipsTitle.className = 'gf-help-subtitle';
    tipsTitle.textContent = 'Tips';
    modal.appendChild(tipsTitle);

    const tipList = document.createElement('ul');
    tipList.className = 'gf-help-tips';
    for (const tip of tips) {
      const li = document.createElement('li');
      li.textContent = tip;
      tipList.appendChild(li);
    }
    modal.appendChild(tipList);

    const closeBtn2 = document.createElement('button');
    closeBtn2.className = 'btn gf-btn';
    closeBtn2.textContent = 'Close';
    closeBtn2.style.marginTop = '12px';
    closeBtn2.addEventListener('click', () => helpOverlay.remove());
    modal.appendChild(closeBtn2);

    helpOverlay.appendChild(modal);
    overlay.appendChild(helpOverlay);
  }

  // ─── Coach System ───

  const coaches = new Map<string, DeckCoach>();
  let coachEnabled = localStorage.getItem('mp-coach-enabled') !== 'false'; // default ON

  // Initialize coaches for all players
  for (const d of decks) {
    const pId = playerOrder[decks.indexOf(d)];
    try {
      const coach = initCoach(d.deck, cardByName);
      coaches.set(pId, coach);
    } catch (e) {
      console.warn(`[MP Coach] Failed to init coach for ${pId}:`, e);
    }
  }

  function getCoachForActivePlayer(): DeckCoach | undefined {
    if (!coachEnabled) return undefined;
    const pid = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;
    return coaches.get(pid);
  }

  function buildCoachState(playerId: string): CoachGameState | null {
    const player = mpState.players.get(playerId);
    if (!player) return null;
    return {
      hand: player.hand,
      battlefield: player.battlefield.map(p => ({ name: p.name, isToken: p.isToken })),
      graveyard: player.graveyard,
      exile: player.exile,
      commandZone: player.commandZone,
      turn: mpState.turn,
      phase: mpState.phase,
      library: player.library,
    };
  }

  function updateCoachState(playerId: string): void {
    if (!coachEnabled) return;
    const coach = coaches.get(playerId);
    if (!coach) return;
    const state = buildCoachState(playerId);
    if (state) onCoachStateChange(coach, state);
  }

  function toggleCoach(): void {
    coachEnabled = !coachEnabled;
    localStorage.setItem('mp-coach-enabled', String(coachEnabled));
    if (!coachEnabled) {
      destroyCoachLines();
    }
    render();
  }

  // ─── Life History (for mini sparkline graph) ───
  const lifeHistory = new Map<string, number[]>();
  for (const pid of playerOrder) lifeHistory.set(pid, [40]);

  function recordLifeHistory(): void {
    for (const pid of mpState.playerOrder) {
      const p = getPlayer(pid);
      const hist = lifeHistory.get(pid) || [];
      hist.push(p.lifeTotal);
      // Keep max 50 data points
      if (hist.length > 50) hist.shift();
      lifeHistory.set(pid, hist);
    }
  }

  // ─── Saga Tracking ───
  /** Check if a permanent is a Saga and auto-advance lore counters at the start of each turn */
  function advanceSagas(playerId: string): void {
    const player = getPlayer(playerId);
    const completedSagas: GoldfishPermanent[] = [];
    // First pass: advance lore counters and collect completed sagas
    for (const perm of player.battlefield) {
      if (isSaga(perm)) {
        perm.counters['lore'] = (perm.counters['lore'] || 0) + 1;
        const chapterCount = getSagaChapterCount(perm);
        if (chapterCount > 0 && (perm.counters['lore'] || 0) > chapterCount) {
          completedSagas.push(perm);
        } else {
          addLog(`${perm.name} — Lore counter ${perm.counters['lore']}`, playerId);
        }
      }
    }
    // Second pass: remove completed sagas (safe — not iterating battlefield)
    for (const perm of completedSagas) {
      addLog(`${perm.name} Saga completed → sacrificed`, playerId);
      const idx = player.battlefield.indexOf(perm);
      if (idx >= 0) {
        player.battlefield.splice(idx, 1);
        equipmentAttachments.delete(perm.id);
        if (!perm.isToken) player.graveyard.push(perm.name);
      }
    }
  }

  function isSaga(perm: GoldfishPermanent): boolean {
    return perm.typeLine.toLowerCase().includes('saga');
  }

  function getSagaChapterCount(perm: GoldfishPermanent): number {
    // Try to detect chapter count from oracle text
    const text = perm.oracleText || '';
    const matches = text.match(/[IVX]+\s*—/g);
    return matches ? matches.length : 3; // Default 3 chapters
  }

  // ─── Equipment tracking ───
  /** Map of equipment perm ID → attached creature perm ID */
  const equipmentAttachments = new Map<string, string>();

  function isEquipment(perm: GoldfishPermanent): boolean {
    return perm.typeLine.toLowerCase().includes('equipment') && !perm.isCreature;
  }

  function isAura(perm: GoldfishPermanent): boolean {
    return perm.typeLine.toLowerCase().includes('aura');
  }

  function attachEquipment(playerId: string, equipmentIdx: number, creatureIdx: number): void {
    const player = getPlayer(playerId);
    const equip = player.battlefield[equipmentIdx];
    const creature = player.battlefield[creatureIdx];
    if (!equip || !creature || !creature.isCreature) return;
    pushUndo(player);
    equipmentAttachments.set(equip.id, creature.id);
    addLog(`Attached ${equip.name} to ${creature.name}`, playerId);
    render();
  }

  function detachEquipment(playerId: string, equipmentIdx: number): void {
    const player = getPlayer(playerId);
    const equip = player.battlefield[equipmentIdx];
    if (!equip) return;
    pushUndo(player);
    equipmentAttachments.delete(equip.id);
    addLog(`Detached ${equip.name}`, playerId);
    render();
  }

  // ─── Live State Sync (Online) ───
  let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleStateSync(): void {
    if (gameMode !== 'online') return;
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => { broadcastMPStateSync(mpState); }, 500);
  }

  // ─── Sound Effects ───
  let soundEnabled = localStorage.getItem('mp-sound') === 'true';
  let audioCtx: AudioContext | null = null;
  function getAudioCtx(): AudioContext | null {
    if (!audioCtx && typeof AudioContext !== 'undefined') audioCtx = new AudioContext();
    return audioCtx;
  }
  function playSound(type: 'tap' | 'draw' | 'combat' | 'damage'): void {
    const ctx = getAudioCtx();
    if (!soundEnabled || !ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.08;
    if (type === 'tap') { osc.frequency.value = 800; gain.gain.value = 0.06; osc.type = 'sine'; }
    else if (type === 'draw') { osc.frequency.value = 600; osc.type = 'triangle'; }
    else if (type === 'combat') { osc.frequency.value = 300; osc.type = 'sawtooth'; }
    else { osc.frequency.value = 150; osc.type = 'square'; }
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (type === 'damage' ? 0.4 : 0.15));
    osc.stop(ctx.currentTime + 0.5);
  }
  function toggleSound(): void {
    soundEnabled = !soundEnabled;
    localStorage.setItem('mp-sound', String(soundEnabled));
    render();
  }

  // ─── Mana Pool (UI-only) ───
  const manaPool: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  function addMana(color: string): void { manaPool[color] = (manaPool[color] || 0) + 1; render(); }
  function clearManaPool(): void { for (const k of Object.keys(manaPool)) manaPool[k] = 0; }
  function getManaString(): string {
    const parts: string[] = [];
    for (const [c, n] of Object.entries(manaPool)) { if (n > 0) parts.push(`${n}${c}`); }
    return parts.length > 0 ? parts.join(' ') : 'empty';
  }

  // ─── Hand Sort ───
  let handSortMode: 'default' | 'cmc' | 'name' | 'type' = 'default';
  function sortHand(hand: string[]): string[] {
    if (handSortMode === 'default') return hand;
    const sorted = [...hand];
    if (handSortMode === 'cmc') sorted.sort((a, b) => (getCard(a, cardByName)?.cmc || 0) - (getCard(b, cardByName)?.cmc || 0));
    else if (handSortMode === 'name') sorted.sort((a, b) => a.localeCompare(b));
    else if (handSortMode === 'type') sorted.sort((a, b) => (getCard(a, cardByName)?.type_line || '').localeCompare(getCard(b, cardByName)?.type_line || ''));
    return sorted;
  }

  // ─── Log Filter ───
  let logFilter: 'all' | 'combat' | 'life' | 'cards' = 'all';
  function filterLog(entries: string[]): string[] {
    if (logFilter === 'all') return entries;
    return entries.filter(e => {
      const lower = e.toLowerCase();
      if (logFilter === 'combat') return lower.includes('combat') || lower.includes('attack') || lower.includes('block') || lower.includes('damage');
      if (logFilter === 'life') return lower.includes('life') || lower.includes('poison') || lower.includes('eliminated');
      if (logFilter === 'cards') return lower.includes('played') || lower.includes('drew') || lower.includes('cast') || lower.includes('searched') || lower.includes('token');
      return true;
    });
  }

  // ─── Storm Count (spells cast this turn) ───
  let stormCount = 0;

  // ─── Turn Summary tracking ───
  let turnSummary = { drawn: 0, played: 0, damage: 0 };
  function resetTurnSummary(): void { turnSummary = { drawn: 0, played: 0, damage: 0 }; }

  // ─── Last Action Highlight ───
  let lastActionPermId: string | null = null;
  let lastActionTimer: ReturnType<typeof setTimeout> | null = null;
  function setLastAction(permId: string): void {
    lastActionPermId = permId;
    if (lastActionTimer) clearTimeout(lastActionTimer);
    lastActionTimer = setTimeout(() => { lastActionPermId = null; }, 1200);
  }

  // ─── Floating Text Notifications ───
  function showFloatingText(text: string, color: string = '#fff', duration: number = 1800): void {
    const el = document.createElement('div');
    el.className = 'mp-floating-text';
    el.style.color = color;
    el.textContent = text;
    overlay.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  /** Show floating damage number near a player avatar */
  function showFloatingDamage(playerId: string, amount: number): void {
    const avatarEl = overlay.querySelector(`.mp-player-avatar [data-pid="${playerId}"]`);
    if (!avatarEl) return;
    const el = document.createElement('span');
    el.className = 'mp-floating-damage';
    el.textContent = amount > 0 ? `+${amount}` : `${amount}`;
    el.style.color = amount > 0 ? '#34d399' : '#ef4444';
    const rect = avatarEl.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    el.style.left = `${rect.left - overlayRect.left + rect.width / 2}px`;
    el.style.top = `${rect.top - overlayRect.top - 8}px`;
    overlay.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  // ─── Scry/Surveil Modal ───
  function showScryModal(): void {
    const actionPlayerId = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;
    const player = getPlayer(actionPlayerId);
    if (player.library.length === 0) { addLog('Library is empty', actionPlayerId); render(); return; }

    const p1Overlay = document.createElement('div');
    p1Overlay.className = 'gf-zone-modal-overlay';
    p1Overlay.addEventListener('click', (e) => { if (e.target === p1Overlay) p1Overlay.remove(); });

    const p1Modal = document.createElement('div');
    p1Modal.className = 'gf-zone-modal gf-topn-modal';

 p1Modal.innerHTML = `<div class="gf-zone-modal-title">◇ Scry</div>`;
    const p1Label = document.createElement('label');
    p1Label.className = 'gf-token-label';
    p1Label.textContent = `How many? (1-${Math.min(5, player.library.length)})`;
    p1Modal.appendChild(p1Label);

    const p1Input = document.createElement('input');
    p1Input.type = 'number'; p1Input.className = 'gf-token-input';
    p1Input.min = '1'; p1Input.max = String(Math.min(5, player.library.length));
    p1Input.value = '1';
    p1Modal.appendChild(p1Input);

    const p1Actions = document.createElement('div');
    p1Actions.className = 'gf-token-actions';
    const p1Cancel = document.createElement('button');
    p1Cancel.className = 'btn gf-btn'; p1Cancel.textContent = 'Cancel';
    p1Cancel.addEventListener('click', () => p1Overlay.remove());
    const p1Go = document.createElement('button');
    p1Go.className = 'btn gf-btn'; p1Go.style.background = 'var(--cobalt)'; p1Go.style.color = '#000';
    p1Go.textContent = 'Scry';
    p1Go.addEventListener('click', () => {
      const n = Math.max(1, Math.min(Math.min(5, player.library.length), parseInt(p1Input.value, 10) || 1));
      p1Overlay.remove();
      showScryPhase2(actionPlayerId, n);
    });
    p1Actions.appendChild(p1Cancel); p1Actions.appendChild(p1Go);
    p1Modal.appendChild(p1Actions);

    p1Overlay.appendChild(p1Modal);
    overlay.appendChild(p1Overlay);
    setTimeout(() => { p1Input.focus(); p1Input.select(); }, 50);
  }

  function showScryPhase2(playerId: string, n: number): void {
    const player = getPlayer(playerId);
    const topCards = player.library.slice(0, n);
    const cardDests: { name: string; dest: 'top' | 'bottom' }[] = topCards.map(name => ({ name, dest: 'top' }));

    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'gf-zone-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'gf-zone-modal gf-topn-modal'; modal.style.maxWidth = '480px';
    modal.innerHTML = `<div class="gf-zone-modal-title">Scry ${n} \u2014 Top or Bottom?</div>`;
    const listEl = document.createElement('div'); listEl.className = 'gf-topn-list';
    modal.appendChild(listEl);

    function renderScryList(): void {
      listEl.textContent = '';
      for (let i = 0; i < cardDests.length; i++) {
        const cs = cardDests[i];
        const row = document.createElement('div'); row.className = 'gf-topn-row';
        const thumb = document.createElement('div'); thumb.className = 'gf-topn-thumb';
        const imgUrl = getImgUrl(cs.name, cardByName);
        if (imgUrl) { const img = document.createElement('img'); img.src = imgUrl; img.alt = cs.name; thumb.appendChild(img); }
        else thumb.textContent = cs.name.slice(0, 10);
        attachPreview(thumb, cs.name);
        row.appendChild(thumb);
        const nameEl = document.createElement('span'); nameEl.className = 'gf-topn-name'; nameEl.textContent = cs.name;
        row.appendChild(nameEl);
        const destEl = document.createElement('div'); destEl.className = 'gf-topn-dest';
        for (const d of ['top', 'bottom'] as const) {
          const label = document.createElement('label');
          label.className = `gf-topn-dest-label${cs.dest === d ? ' active' : ''}`;
          const radio = document.createElement('input'); radio.type = 'radio';
          radio.name = `scry-dest-${i}`; radio.value = d; radio.checked = cs.dest === d;
          radio.addEventListener('change', () => { cs.dest = d; renderScryList(); });
          label.appendChild(radio);
          label.appendChild(document.createTextNode(d === 'top' ? 'Top' : 'Bottom'));
          destEl.appendChild(label);
        }
        row.appendChild(destEl);
        listEl.appendChild(row);
      }
    }
    renderScryList();

    const actions = document.createElement('div'); actions.className = 'gf-token-actions';
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn gf-btn'; confirmBtn.style.background = 'var(--cobalt)'; confirmBtn.style.color = '#000';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.addEventListener('click', () => {
      pushUndo(player);
      player.library.splice(0, n);
      const toTop: string[] = []; const toBottom: string[] = [];
      for (const cs of cardDests) { if (cs.dest === 'top') toTop.push(cs.name); else toBottom.push(cs.name); }
      player.library.unshift(...toTop);
      player.library.push(...toBottom);
      addLog(`Scry ${n}: ${toTop.length} top, ${toBottom.length} bottom`, playerId);
      modalOverlay.remove(); render();
    });
    actions.appendChild(confirmBtn); modal.appendChild(actions);
    modalOverlay.appendChild(modal); overlay.appendChild(modalOverlay);
  }

  // ─── Game State Export (Enhanced Format) ───
  function exportGameState(): void {
    const lines: string[] = [];
    const round = Math.ceil(mpState.turn / mpState.playerOrder.length);
 lines.push(` DeckLens Playtest \u2014 Turn ${mpState.turn} (Round ${round}), ${PHASE_LABELS[mpState.phase]}`);
    lines.push('\u2501'.repeat(40));
    lines.push('');
    for (const pid of mpState.playerOrder) {
      const p = getPlayer(pid);
 const status = p.isEliminated ? ' ELIMINATED' : '';
 const isActive = pid === getActivePlayerId(mpState) ? '◆ ' : '';
      const poisonStr = p.poisonCounters > 0 ? `, ${p.poisonCounters} poison` : '';
      lines.push(`${isActive}${p.playerName}${status} \u2014 ${p.lifeTotal} life${poisonStr}`);
      // Battlefield details
      if (p.battlefield.length > 0) {
        const bfParts = p.battlefield.map(b => {
          let s = b.name;
          if (b.tapped) s += ' (T)';
          const counters = Object.entries(b.counters).filter(([, v]) => v > 0).map(([k, v]) => `${v}x ${k}`);
          if (counters.length > 0) s += ` [${counters.join(', ')}]`;
          if (b.isCreature) s += ` ${b.currentPower}/${b.currentToughness}`;
          return s;
        });
 lines.push(` ✕ Battlefield: ${bfParts.join(', ')}`);
      } else {
 lines.push(` ✕ Battlefield: empty`);
      }
 lines.push(` Hand: ${p.hand.length} | Library: ${p.library.length} | GY: ${p.graveyard.length} | Exile: ${p.exile.length}`);
      lines.push('');
    }
    lines.push(`Generated by DeckLens \u2014 https://decklens.chrisgarkisch.workers.dev`);
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      addLog('Game state copied to clipboard');
 showFloatingText('▤ Copied to clipboard!', '#34d399');
      render();
    }).catch(() => {
      alert(text);
    });
  }

  // ─── Reset Game ───
  function resetGame(): void {
    if (!confirm('Reset the entire game? All progress will be lost.')) return;
    // Re-initialize all players
    for (let i = 0; i < decks.length; i++) {
      const pid = mpState.playerOrder[i];
      const d = decks[i];
      const p = initPlayerFromDeck(d.deck, pid, d.playerName || PLAYER_LABELS[i], PLAYER_COLORS[i]);
      mpState.players.set(pid, p);
    }
    mpState.turn = 1;
    mpState.currentPlayerIndex = 0;
    mpState.phase = 'main1';
    mpState.combat = null;
    mpState.sharedLog = ['Game reset.'];
    mpState.winnerId = undefined;
    mpState.gameEndedAt = undefined;
    clearManaPool();
    render();
  }

  // ─── Turn / Phase ───

  function nextPhase(): void {
    if (!isMyTurn()) return;
    const playerId = getActivePlayerId(mpState);
    const player = activePlayer();

    const idx = PHASES.indexOf(mpState.phase);
    if (idx === PHASES.length - 1) {
      // End of turn → next player
      nextTurn();
      return;
    }

    pushUndo(player);
    mpState.phase = PHASES[idx + 1];
    clearManaPool();

    // Auto-actions for each phase
    if (mpState.phase === 'untap') {
      player.battlefield.forEach(p => p.tapped = false);
      player.landPlayedThisTurn = false;
    } else if (mpState.phase === 'draw' && mpState.turn > mpState.playerOrder.length) {
      // Auto-draw (skip first turn for each player)
      drawCard(playerId);
    }

    addLog(`Phase → ${PHASE_LABELS[mpState.phase]}`, playerId);
    runStateBasedActions();
    render();
  }

  function nextTurn(): void {
    if (!isMyTurn()) return;
    const prevPlayer = activePlayer();
    pushUndo(prevPlayer);

    // Cleanup step: clear damage from all permanents
    for (const [, player] of mpState.players) {
      for (const perm of player.battlefield) {
        perm.damage = 0;
      }
    }

    // Find next non-eliminated player (with safety guard against infinite loop)
    let nextIdx = mpState.currentPlayerIndex;
    let safetyCounter = 0;
    do {
      nextIdx = (nextIdx + 1) % mpState.playerOrder.length;
      safetyCounter++;
      if (safetyCounter > mpState.playerOrder.length) break; // All players eliminated
    } while (getPlayer(mpState.playerOrder[nextIdx]).isEliminated && nextIdx !== mpState.currentPlayerIndex);

    mpState.currentPlayerIndex = nextIdx;
    mpState.turn++;
    mpState.phase = 'untap';
    mpState.combat = null;

    const newPlayer = activePlayer();
    newPlayer.landPlayedThisTurn = false;
    newPlayer.battlefield.forEach(p => p.tapped = false);
    stormCount = 0; // Reset storm count on new turn
    resetTurnSummary(); // Reset turn summary

    // Saga auto-advance (at start of new player's turn)
    advanceSagas(newPlayer.playerId);

    // Record life totals for sparkline
    recordLifeHistory();

    // Auto-draw (skip first complete round) — use drawCard for proper undo/sound/tracking
    if (mpState.turn > mpState.playerOrder.length) {
      drawCard(newPlayer.playerId);
    }

    // Skip to main phase
    mpState.phase = 'main1';

    addLog(`Turn ${mpState.turn} — ${newPlayer.playerName}'s turn`, newPlayer.playerId);

    // Online: broadcast turn change
    if (gameMode === 'online') {
      broadcastMPTurnChange(mpState.currentPlayerIndex, mpState.turn, getActivePlayerId(mpState));
    }

    if (shouldGameEnd(mpState)) {
      const winner = getAlivePlayers(mpState)[0];
      if (winner) {
        mpState.winnerId = winner.playerId;
        mpState.gameEndedAt = Date.now();
        addLog(`${winner.playerName} wins!`);
      }
    }

    render();
  }

  // ─── Combat ───

  /** Currently selected blocker (player clicks own creature, then clicks attacker to assign block) */
  let selectedBlocker: string | null = null;

  function enterCombat(): void {
    if (!isMyTurn()) return;
    mpState.phase = 'combat';
    gameStats.combatPhases++;
    mpState.combat = {
      phase: 'declare-attackers',
      attackers: [],
      blockers: [],
      defendingPlayerIds: [],
      activeDefenderIndex: 0,
      hasFirstStrike: false,
      firstStrikeDamageResolved: false,
    };
    selectedBlocker = null;
    playSound('combat');
    addLog('Entering combat', getActivePlayerId(mpState));
    render();
  }

  function declareAttacker(permanentId: string, targetPlayerId: string): void {
    if (!mpState.combat || mpState.combat.phase !== 'declare-attackers') return;
    const playerId = getActivePlayerId(mpState);
    const player = activePlayer();
    const perm = player.battlefield.find(p => p.id === permanentId);
    if (!perm || perm.tapped || !perm.isCreature) return;

    // Check summoning sickness (using keyword helper) — skipped if house rule disabled
    if (rules.summoningSickness && perm.enteredTurn === mpState.turn && !hasKeywordGoldfish(perm, 'haste')) return;
    // Defender keyword: can't attack
    if (hasKeywordGoldfish(perm, 'defender')) return;

    // Toggle attacker: if already attacking, remove
    const existingIdx = mpState.combat.attackers.findIndex(a => a.permanentId === permanentId);
    if (existingIdx >= 0) {
      mpState.combat.attackers.splice(existingIdx, 1);
      perm.attacking = false;
    } else {
      mpState.combat.attackers.push({ permanentId, attackerPlayerId: playerId, targetPlayerId });
      perm.attacking = true;
    }

    // Update defending player IDs
    mpState.combat.defendingPlayerIds = [...new Set(mpState.combat.attackers.map(a => a.targetPlayerId))];
    render();
  }

  function confirmAttackers(): void {
    if (!mpState.combat || mpState.combat.phase !== 'declare-attackers') return;
    const player = activePlayer();

    // Tap all attackers (unless they have vigilance)
    for (const atk of mpState.combat.attackers) {
      const perm = player.battlefield.find(p => p.id === atk.permanentId);
      if (perm) {
        if (!hasKeywordGoldfish(perm, 'vigilance')) perm.tapped = true;
        perm.attacking = true;
      }
    }

    // Online: broadcast combat
    if (gameMode === 'online' && mpState.combat.attackers.length > 0) {
      broadcastMPCombat(
        getActivePlayerId(mpState),
        mpState.combat.attackers.map(a => ({ permanentId: a.permanentId, targetPlayerId: a.targetPlayerId })),
      );
    }

    if (mpState.combat.attackers.length === 0) {
      // No attackers → skip combat
      clearCombatFlags();
      mpState.combat = null;
      mpState.phase = 'main2';
      addLog('No attackers declared, skipping combat', getActivePlayerId(mpState));
    } else {
      // Check if any defenders have eligible blockers
      const hasBlockers = mpState.combat.defendingPlayerIds.some(defId => {
        const defender = getPlayer(defId);
        return !defender.isEliminated && getEligibleBlockersGoldfish(defender).length > 0;
      });

      if (hasBlockers) {
        // Move to declare-blockers phase
        mpState.combat.phase = 'declare-blockers';
        mpState.combat.activeDefenderIndex = 0;
        selectedBlocker = null;
        addLog(`${mpState.combat.attackers.length} attacker(s) declared — defenders may declare blockers`, getActivePlayerId(mpState));
      } else {
        // No possible blockers → skip to damage
        addLog(`${mpState.combat.attackers.length} attacker(s) declared — no blockers available`, getActivePlayerId(mpState));
        proceedToDamage();
      }
    }
    render();
  }

  /** Assign a blocker to an attacker */
  function declareBlocker(blockerPermId: string, attackerPermId: string, defenderPlayerId: string): void {
    if (!mpState.combat || mpState.combat.phase !== 'declare-blockers') return;

    const defender = getPlayer(defenderPlayerId);
    const blocker = defender.battlefield.find(p => p.id === blockerPermId);
    const attackerPlayer = activePlayer();
    const attacker = attackerPlayer.battlefield.find(p => p.id === attackerPermId);

    if (!blocker || !attacker || !blocker.isCreature || blocker.tapped) return;
    if (!canBlockAttacker(blocker, attacker)) return;

    // Toggle: if already blocking this attacker, remove
    const existingIdx = mpState.combat.blockers.findIndex(
      b => b.permanentId === blockerPermId && b.blockingPermanentId === attackerPermId,
    );
    if (existingIdx >= 0) {
      mpState.combat.blockers.splice(existingIdx, 1);
      blocker.blockingId = null;
    } else {
      // Remove any previous blocking assignment for this blocker
      mpState.combat.blockers = mpState.combat.blockers.filter(b => b.permanentId !== blockerPermId);
      // Assign block
      mpState.combat.blockers.push({
        permanentId: blockerPermId,
        blockerPlayerId: defenderPlayerId,
        blockingPermanentId: attackerPermId,
      });
      blocker.blockingId = attackerPermId;
    }

    selectedBlocker = null;
    render();
  }

  /** Current defender confirms their blockers (or skips) */
  function confirmBlockers(): void {
    if (!mpState.combat || mpState.combat.phase !== 'declare-blockers') return;

    // Validate menace: creatures with menace need 2+ blockers or 0
    const atkPlayer = activePlayer();
    for (const atk of mpState.combat.attackers) {
      const attacker = atkPlayer.battlefield.find(p => p.id === atk.permanentId);
      if (attacker && hasKeywordGoldfish(attacker, 'menace')) {
        const blockerCount = mpState.combat.blockers.filter(b => b.blockingPermanentId === atk.permanentId).length;
        if (blockerCount === 1) {
          // Remove the single blocker — menace requires 2+
          const invalidBlocker = mpState.combat.blockers.find(b => b.blockingPermanentId === atk.permanentId);
          if (invalidBlocker) {
            const blockerPerm = getPlayer(invalidBlocker.blockerPlayerId).battlefield.find(p => p.id === invalidBlocker.permanentId);
            if (blockerPerm) blockerPerm.blockingId = null;
            mpState.combat.blockers = mpState.combat.blockers.filter(b => b.blockingPermanentId !== atk.permanentId);
            addLog(`${attacker.name} has menace — single blocker removed (needs 2+)`, getActivePlayerId(mpState));
          }
        }
      }
    }

    const currentDefId = mpState.combat.defendingPlayerIds[mpState.combat.activeDefenderIndex];
    const defender = getPlayer(currentDefId);
    const myBlockers = mpState.combat.blockers.filter(b => b.blockerPlayerId === currentDefId);
    addLog(`${defender.playerName} declared ${myBlockers.length} blocker(s)`, currentDefId);

    // Online: broadcast blocker declarations
    if (gameMode === 'online') {
      broadcastMPBlockers(
        currentDefId,
        myBlockers.map(b => ({ permanentId: b.permanentId, blockingPermanentId: b.blockingPermanentId })),
      );
    }

    // Move to next defender
    mpState.combat.activeDefenderIndex++;

    if (mpState.combat.activeDefenderIndex >= mpState.combat.defendingPlayerIds.length) {
      // All defenders done → proceed to damage
      proceedToDamage();
    }

    selectedBlocker = null;
    render();
  }

  /** Transition from blockers to damage step(s) */
  function proceedToDamage(): void {
    if (!mpState.combat) return;
    const atkPlayer = activePlayer();

    // Check if any creature has first strike or double strike
    let hasFS = false;
    for (const atk of mpState.combat.attackers) {
      const perm = atkPlayer.battlefield.find(p => p.id === atk.permanentId);
      if (perm && (hasKeywordGoldfish(perm, 'first strike') || hasKeywordGoldfish(perm, 'double strike'))) {
        hasFS = true;
        break;
      }
    }
    if (!hasFS) {
      // Check blockers too
      for (const blk of mpState.combat.blockers) {
        const defender = getPlayer(blk.blockerPlayerId);
        const perm = defender.battlefield.find(p => p.id === blk.permanentId);
        if (perm && (hasKeywordGoldfish(perm, 'first strike') || hasKeywordGoldfish(perm, 'double strike'))) {
          hasFS = true;
          break;
        }
      }
    }

    mpState.combat.hasFirstStrike = hasFS;
    mpState.combat.firstStrikeDamageResolved = false;

    if (hasFS) {
      mpState.combat.phase = 'first-strike-damage';
      applyCombatDamage(true);
      runStateBasedActions();
      // After first strike, proceed to regular damage
      mpState.combat.firstStrikeDamageResolved = true;
      mpState.combat.phase = 'damage';
      applyCombatDamage(false);
    } else {
      mpState.combat.phase = 'damage';
      applyCombatDamage(false);
    }

    runStateBasedActions();
    endCombatPhase();
  }

  /** Apply combat damage — full rules-compliant implementation */
  function applyCombatDamage(firstStrikeOnly: boolean): void {
    if (!mpState.combat) return;
    const atkPlayer = activePlayer();
    const atkPlayerId = getActivePlayerId(mpState);

    for (const atk of mpState.combat.attackers) {
      const attacker = atkPlayer.battlefield.find(p => p.id === atk.permanentId);
      if (!attacker || !attacker.isCreature) continue;

      const hasFS = hasKeywordGoldfish(attacker, 'first strike') || hasKeywordGoldfish(attacker, 'double strike');
      const hasDS = hasKeywordGoldfish(attacker, 'double strike');

      // First-strike step: only first/double strike creatures deal damage
      if (firstStrikeOnly && !hasFS) continue;
      // Regular step: first strike creatures DON'T deal damage again (unless double strike)
      if (!firstStrikeOnly && hasFS && !hasDS && mpState.combat.firstStrikeDamageResolved) continue;

      const attackPower = attacker.currentPower;
      if (attackPower <= 0) continue;

      // Find blockers assigned to this attacker
      const blockerDecls = mpState.combat.blockers.filter(b => b.blockingPermanentId === atk.permanentId);

      if (blockerDecls.length === 0) {
        // UNBLOCKED — damage goes to defending player
        const target = getPlayer(atk.targetPlayerId);
        if (!target || target.isEliminated) continue;

        // Infect: deals damage as poison counters to players (instead of life loss)
        if (hasInfect(attacker)) {
          target.poisonCounters += attackPower;
          addLog(`${attacker.name} infects ${target.playerName} for ${attackPower} poison (total: ${target.poisonCounters})`, atkPlayerId);
        } else {
          target.lifeTotal -= attackPower;
          trackStat(atkPlayerId, 'damageDealt', attackPower);
          addLog(`${attacker.name} deals ${attackPower} combat damage to ${target.playerName} (life: ${target.lifeTotal})`, atkPlayerId);
        }

        // Lifelink
        if (hasKeywordGoldfish(attacker, 'lifelink')) {
          atkPlayer.lifeTotal += attackPower;
          addLog(`${attacker.name} — lifelink gains ${attackPower} life for ${atkPlayer.playerName}`, atkPlayerId);
        }

        // Commander damage tracking (even with infect, commander damage still tracks)
        const deck = decks.find(d => d.playerName === atkPlayer.playerName)?.deck;
        if (isCommander(attacker.name, deck)) {
          target.commanderDamageReceived[attacker.name] = (target.commanderDamageReceived[attacker.name] || 0) + attackPower;
          if (target.commanderDamageReceived[attacker.name] >= 21) {
            addLog(`${target.playerName} received lethal commander damage from ${attacker.name}!`, atkPlayerId);
          }
        }

        checkElimination(atk.targetPlayerId);
      } else {
        // BLOCKED — distribute damage among blockers
        let remainingDamage = attackPower;
        const attackerHasDT = hasDeathtouch(attacker);
        const attackerHasInfect = hasInfect(attacker);
        const attackerHasWither = hasWither(attacker);

        for (const blkDecl of blockerDecls) {
          const defender = getPlayer(blkDecl.blockerPlayerId);
          const blocker = defender.battlefield.find(p => p.id === blkDecl.permanentId);
          if (!blocker || !blocker.isCreature) continue;

          // Blocker deals damage to attacker — MTG rules:
          // First-strike step: only FS/DS creatures deal damage
          // Regular step: non-FS creatures deal damage; DS creatures deal again; FS-only creatures do NOT
          const blockerHasFS = hasKeywordGoldfish(blocker, 'first strike') || hasKeywordGoldfish(blocker, 'double strike');
          const blockerHasDS = hasKeywordGoldfish(blocker, 'double strike');
          let blockerDeals: boolean;
          if (firstStrikeOnly) {
            blockerDeals = blockerHasFS; // Only FS/DS deal in first-strike step
          } else {
            // Regular step: non-FS creatures always deal; DS deals again; FS-only does NOT deal
            blockerDeals = !blockerHasFS || blockerHasDS;
          }

          if (blockerDeals && blocker.currentPower > 0) {
            // Blocker infect/wither: deals damage as -1/-1 counters to attacker
            if (hasInfect(blocker) || hasWither(blocker)) {
              attacker.counters['-1/-1'] = (attacker.counters['-1/-1'] || 0) + blocker.currentPower;
              recalcPT(attacker);
              addLog(`${blocker.name} puts ${blocker.currentPower} -1/-1 counter(s) on ${attacker.name}`, blkDecl.blockerPlayerId);
            } else {
              attacker.damage += blocker.currentPower;
              addLog(`${blocker.name} deals ${blocker.currentPower} damage to ${attacker.name}`, blkDecl.blockerPlayerId);
            }
            // Mark deathtouch on attacker if blocker has it
            if (hasDeathtouch(blocker)) {
              (attacker as any)._deathtouchDamage = true;
            }
            // Blocker lifelink
            if (hasKeywordGoldfish(blocker, 'lifelink')) {
              defender.lifeTotal += blocker.currentPower;
            }
          }

          // Attacker deals damage to blocker
          // Deathtouch: only need 1 damage to be lethal
          const dmgNeeded = attackerHasDT ? 1 : Math.max(0, blocker.currentToughness - blocker.damage);
          const dmgToBlocker = Math.min(remainingDamage, dmgNeeded);
          if (dmgToBlocker > 0) {
            // Infect/Wither: damage to creatures as -1/-1 counters
            if (attackerHasInfect || attackerHasWither) {
              blocker.counters['-1/-1'] = (blocker.counters['-1/-1'] || 0) + dmgToBlocker;
              recalcPT(blocker);
              addLog(`${attacker.name} puts ${dmgToBlocker} -1/-1 counter(s) on ${blocker.name}`, atkPlayerId);
            } else {
              blocker.damage += dmgToBlocker;
              addLog(`${attacker.name} deals ${dmgToBlocker} damage to ${blocker.name}`, atkPlayerId);
            }
            if (attackerHasDT) (blocker as any)._deathtouchDamage = true;
            remainingDamage -= dmgToBlocker;
          }
        }

        // Trample: excess damage goes to defending player
        if (remainingDamage > 0 && hasKeywordGoldfish(attacker, 'trample')) {
          const target = getPlayer(atk.targetPlayerId);
          if (target && !target.isEliminated) {
            if (attackerHasInfect) {
              target.poisonCounters += remainingDamage;
              addLog(`${attacker.name} tramples ${remainingDamage} infect to ${target.playerName} (poison: ${target.poisonCounters})`, atkPlayerId);
            } else {
              target.lifeTotal -= remainingDamage;
              addLog(`${attacker.name} tramples ${remainingDamage} damage to ${target.playerName} (life: ${target.lifeTotal})`, atkPlayerId);
            }

            if (hasKeywordGoldfish(attacker, 'lifelink')) {
              atkPlayer.lifeTotal += remainingDamage;
            }

            const deck = decks.find(d => d.playerName === atkPlayer.playerName)?.deck;
            if (isCommander(attacker.name, deck)) {
              target.commanderDamageReceived[attacker.name] = (target.commanderDamageReceived[attacker.name] || 0) + remainingDamage;
            }

            checkElimination(atk.targetPlayerId);
          }
        }

        // Attacker lifelink for damage dealt to blockers
        if (hasKeywordGoldfish(attacker, 'lifelink')) {
          const damageDealt = attackPower - remainingDamage;
          if (damageDealt > 0) atkPlayer.lifeTotal += damageDealt;
        }
      }
    }
    playSound('damage');
  }

  /** Clear all combat flags from permanents */
  function clearCombatFlags(): void {
    for (const [, player] of mpState.players) {
      for (const perm of player.battlefield) {
        perm.attacking = false;
        perm.blockingId = null;
      }
    }
  }

  /** End combat: clean up flags, move to main2 */
  function endCombatPhase(): void {
    clearCombatFlags();
    // Clear deathtouch markers from all permanents
    for (const [, player] of mpState.players) {
      for (const perm of player.battlefield) {
        delete (perm as any)._deathtouchDamage;
      }
    }
    mpState.combat = null;
    mpState.phase = 'main2';
    selectedBlocker = null;
    selectedAttackTarget = null;
    addLog('Combat ended', getActivePlayerId(mpState));
  }

  /** Attack with all eligible creatures at a target */
  function attackWithAll(targetPlayerId: string): void {
    if (!mpState.combat || mpState.combat.phase !== 'declare-attackers') return;
    const player = activePlayer();
    const eligible = getEligibleAttackersGoldfish(player, mpState.turn, !rules.summoningSickness);
    for (const perm of eligible) {
      if (!perm.attacking) {
        mpState.combat.attackers.push({ permanentId: perm.id, attackerPlayerId: getActivePlayerId(mpState), targetPlayerId });
        perm.attacking = true;
      }
    }
    mpState.combat.defendingPlayerIds = [...new Set(mpState.combat.attackers.map(a => a.targetPlayerId))];
    render();
  }

  // ─── State-Based Actions (Rule 704) ───

  function runStateBasedActions(): void {
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 20) {
      changed = false;
      iterations++;

      for (const [pid, player] of mpState.players) {
        if (player.isEliminated) continue;

        // 704.5a — Player at 0 or less life loses
        if (player.lifeTotal <= 0 && !player.isEliminated) {
          player.isEliminated = true;
          player.eliminatedReason = 'life';
          addLog(`${player.playerName} eliminated — life total ${player.lifeTotal}`, pid);
          changed = true;
        }

        // 704.5c — Player with 10+ poison loses
        if (player.poisonCounters >= 10 && !player.isEliminated) {
          player.isEliminated = true;
          player.eliminatedReason = 'poison';
          addLog(`${player.playerName} eliminated — 10+ poison counters`, pid);
          changed = true;
        }

        // Commander damage ≥ 21
        for (const [cmdName, dmg] of Object.entries(player.commanderDamageReceived)) {
          if (dmg >= 21 && !player.isEliminated) {
            player.isEliminated = true;
            player.eliminatedReason = 'commander';
            addLog(`${player.playerName} eliminated — 21+ commander damage from ${cmdName}`, pid);
            changed = true;
            break;
          }
        }

        // 704.5f/g — Creature with lethal damage or toughness ≤ 0
        // 704.5h — Creature with deathtouch damage ≥ 1
        const dying: number[] = [];
        for (let i = player.battlefield.length - 1; i >= 0; i--) {
          const perm = player.battlefield[i];
          if (!perm.isCreature) continue;

          // Indestructible: immune to lethal damage (but NOT zero toughness)
          const indestructible = isIndestructible(perm);

          const lethalDamage = perm.damage >= perm.currentToughness && perm.currentToughness > 0;
          const deathtouchLethal = perm.damage > 0 && (perm as any)._deathtouchDamage; // marked by combat
          const zeroToughness = perm.currentToughness <= 0;

          // Indestructible prevents destruction from damage but NOT from zero toughness
          if (zeroToughness) {
            dying.push(i);
          } else if ((lethalDamage || deathtouchLethal) && !indestructible) {
            dying.push(i);
          }
        }

        for (const idx of dying) {
          const perm = player.battlefield[idx];
          const deathReason = perm.damage >= perm.currentToughness ? 'lethal damage' : (perm as any)._deathtouchDamage ? 'deathtouch' : 'zero toughness';

          // Visual death notification
 showFloatingText(` ${perm.name} dies (${deathReason})`, '#ef4444', 2200);
          // Mark card for death animation (CSS handles the rest)
          const cardEl = overlay.querySelector(`[data-perm-id="${perm.id}"]`);
          if (cardEl) cardEl.classList.add('gf-dying');

          // Clean up equipment attachments
          equipmentAttachments.delete(perm.id);
          for (const [eqId, targetId] of equipmentAttachments) {
            if (targetId === perm.id) equipmentAttachments.delete(eqId);
          }

          // Token: remove from game entirely (no graveyard)
          if (perm.isToken) {
            player.battlefield.splice(idx, 1);
            addLog(`${perm.name} token destroyed (${deathReason})`, pid);
            changed = true;
            continue;
          }

          // Commander: return to command zone (check original name for DFC)
          const originalName = perm._savedName || perm.name;
          const deck = decks.find(d => d.playerName === player.playerName)?.deck;
          if (isCommander(perm.name, deck) || isCommander(originalName, deck)) {
            player.battlefield.splice(idx, 1);
            player.commandZone.push(originalName);
            addLog(`${perm.name} died (${deathReason}) → returned to command zone`, pid);
            changed = true;
            continue;
          }

          // Normal creature: goes to graveyard
          player.battlefield.splice(idx, 1);
          player.graveyard.push(perm.name);
          addLog(`${perm.name} died (${deathReason})`, pid);
          changed = true;
        }

        // Track creature kills for stats
        gameStats.creaturesKilled += dying.length;

        // Recalculate P/T for surviving creatures (counters may have changed interactions)
        if (dying.length > 0) {
          for (const perm of player.battlefield) {
            if (perm.isCreature) recalcPT(perm);
          }
        }
      }
    }

    // Check game end after all SBAs resolved
    if (shouldGameEnd(mpState)) {
      const winner = getAlivePlayers(mpState)[0];
      if (winner && !mpState.winnerId) {
        mpState.winnerId = winner.playerId;
        mpState.gameEndedAt = Date.now();
        addLog(`${winner.playerName} wins the game!`);
      }
    }
  }

  // ─── Elimination ───

  function checkElimination(playerId: string): void {
    const player = getPlayer(playerId);
    if (player.isEliminated) return;

    if (player.lifeTotal <= 0) {
      player.isEliminated = true;
      player.eliminatedReason = 'life';
      addLog(`${player.playerName} eliminated! (life total: ${player.lifeTotal})`, playerId);
    } else if (rules.poisonElimination && player.poisonCounters >= 10) {
      player.isEliminated = true;
      player.eliminatedReason = 'poison';
      addLog(`${player.playerName} eliminated! (10+ poison counters)`, playerId);
    } else if (rules.commanderDamage21) {
      // Check commander damage
      for (const [cmdName, dmg] of Object.entries(player.commanderDamageReceived)) {
        if (dmg >= 21) {
          player.isEliminated = true;
          player.eliminatedReason = 'commander';
          addLog(`${player.playerName} eliminated! (21+ commander damage from ${cmdName})`, playerId);
          break;
        }
      }
    }

    if (player.isEliminated && shouldGameEnd(mpState)) {
      const winner = getAlivePlayers(mpState)[0];
      if (winner) {
        mpState.winnerId = winner.playerId;
        mpState.gameEndedAt = Date.now();
        addLog(`${winner.playerName} wins the game!`);
      }
    }
  }

  function concede(playerId: string): void {
    const player = getPlayer(playerId);
    player.isEliminated = true;
    player.eliminatedReason = 'concede';
    addLog(`${player.playerName} conceded`, playerId);

    if (shouldGameEnd(mpState)) {
      const winner = getAlivePlayers(mpState)[0];
      if (winner) {
        mpState.winnerId = winner.playerId;
        mpState.gameEndedAt = Date.now();
        addLog(`${winner.playerName} wins the game!`);
      }
    }
    render();
  }

  // ═════════════════════════════════════════════════════════════
  // RENDERING
  // ═════════════════════════════════════════════════════════════

  let renderPending = false;
  function render(): void {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      renderNow();
    });
  }

  /** Immediate render — called once per frame max.
   *  Builds entire UI into a DocumentFragment first, then swaps atomically
   *  to prevent visible flash of empty content. */
  function renderNow(): void {
    const frag = document.createDocumentFragment();
    // We build everything into `frag`, then swap at the very end.
    // Alias: wherever we used to append to `overlay`, we now append to `frag`.
    const renderTarget = frag;

    // ── Top Bar: Player Status ──
    const topBar = document.createElement('div');
    topBar.className = 'mp-topbar';

    // Turn / Phase info
    const turnInfo = document.createElement('div');
    turnInfo.className = 'mp-turn-info';
    const ap = activePlayer();
    const onlineBadge = gameMode === 'online'
      ? `<span class="mp-online-badge" style="color:#34d399;font-size:0.7rem;margin-left:6px;">● ONLINE</span>`
      : `<span class="mp-online-badge" style="color:#94a3b8;font-size:0.7rem;margin-left:6px;">◇ HOTSEAT</span>`;
    const round = Math.ceil(mpState.turn / mpState.playerOrder.length);
    const playerIdx = ((mpState.turn - 1) % mpState.playerOrder.length) + 1;
    turnInfo.innerHTML = `
      <span class="mp-turn-label">Turn ${mpState.turn} (R${round})</span>${onlineBadge}
      <span class="mp-phase-label" style="color:${ap.playerColor}">${PHASE_LABELS[mpState.phase]}</span>
      <span class="mp-active-player" style="color:${ap.playerColor}">${ap.playerName} (${playerIdx}/${mpState.playerOrder.length})</span>
    `;
    topBar.appendChild(turnInfo);

    // Player avatars
    const playerAvatars = document.createElement('div');
    playerAvatars.className = 'mp-player-avatars';
    for (const pid of mpState.playerOrder) {
      const p = getPlayer(pid);
      const avatar = document.createElement('div');
      avatar.className = `mp-player-avatar${pid === getActivePlayerId(mpState) ? ' active' : ''}${p.isEliminated ? ' eliminated' : ''}`;
      avatar.style.borderColor = p.playerColor;
      avatar.innerHTML = `
        <span class="mp-avatar-name" style="color:${p.playerColor}">${p.playerName}</span>
        <span class="mp-avatar-life" data-pid="${pid}">${p.isEliminated ? '&#9760;' : p.lifeTotal}</span>
 <span class="mp-avatar-poison-wrap">${p.poisonCounters > 0 ? `<span class="mp-avatar-poison">${p.poisonCounters}</span>` : `<span class="mp-avatar-poison dim">0</span>`}</span>
      `;

      // Life total click to edit
      if (!p.isEliminated) {
        const lifeEl = avatar.querySelector('.mp-avatar-life') as HTMLElement;
        if (lifeEl) {
          lifeEl.style.cursor = 'pointer';
          lifeEl.title = 'Click to set life total';
          lifeEl.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = 'number'; input.value = String(p.lifeTotal);
            input.className = 'mp-life-edit-input';
            input.style.cssText = 'width:42px;font-size:0.75rem;text-align:center;background:rgba(0,0,0,0.5);border:1px solid var(--cobalt);border-radius:4px;color:#fff;padding:1px 3px;';
            lifeEl.replaceWith(input);
            input.focus(); input.select();
            const commit = () => {
              const val = parseInt(input.value, 10);
              if (!isNaN(val) && val !== p.lifeTotal) {
                adjustLife(pid, val - p.lifeTotal);
              } else {
                render();
              }
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (ke) => { if (ke.key === 'Enter') commit(); if (ke.key === 'Escape') render(); });
          });
        }

        // Poison +/- on click/contextmenu
        const poisonWrap = avatar.querySelector('.mp-avatar-poison-wrap') as HTMLElement;
        if (poisonWrap) {
          poisonWrap.style.cursor = 'pointer';
          poisonWrap.title = 'Click: +1 poison | Right-click: -1';
          poisonWrap.addEventListener('click', (e) => { e.stopPropagation(); adjustPoison(pid, 1); });
          poisonWrap.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); adjustPoison(pid, -1); });
        }
      }

      // Mini life sparkline
      const hist = lifeHistory.get(pid);
      if (hist && hist.length > 2) {
        const spark = document.createElement('canvas');
        spark.className = 'mp-life-spark';
        spark.width = 48; spark.height = 16;
        spark.title = `Life history: ${hist.join(' → ')}`;
        avatar.appendChild(spark);
        // Draw sparkline after attach
        requestAnimationFrame(() => {
          const ctx = spark.getContext('2d');
          if (!ctx) return;
          const max = Math.max(...hist, 1);
          const min = Math.min(...hist, 0);
          const range = Math.max(max - min, 1);
          ctx.strokeStyle = p.playerColor;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let i = 0; i < hist.length; i++) {
            const x = (i / (hist.length - 1)) * 48;
            const y = 16 - ((hist[i] - min) / range) * 14;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        });
      }

      // Click opponent avatar to target in combat
      if (mpState.combat?.phase === 'declare-attackers' && pid !== getActivePlayerId(mpState) && !p.isEliminated) {
        avatar.classList.add('mp-attackable');
        // Highlight the currently selected attack target
        if (selectedAttackTarget === pid) {
          avatar.classList.add('mp-attack-selected');
          const targetLabel = document.createElement('div');
          targetLabel.className = 'mp-attack-target-label';
 targetLabel.textContent = ' TARGET';
          avatar.appendChild(targetLabel);
        }
        avatar.addEventListener('click', () => {
          // Toggle: clicking same target deselects
          selectedAttackTarget = selectedAttackTarget === pid ? null : pid;
          render();
        });
      }

      // During declare-blockers, highlight the selected blocker
      if (mpState.combat?.phase === 'declare-blockers' && selectedBlocker) {
        // Show which creature is selected as a blocker
        const blockerPerm = p.battlefield.find(perm => perm.id === selectedBlocker);
        if (blockerPerm) {
          avatar.classList.add('mp-blocking-active');
        }
      }

      // Active emote display
      const emoteData = activeEmotes.find(e => e.playerId === pid);
      if (emoteData) {
        const emoteEl = document.createElement('div');
        emoteEl.className = 'mp-emote-bubble';
        emoteEl.textContent = emoteData.emote;
        avatar.appendChild(emoteEl);
      }

      playerAvatars.appendChild(avatar);
    }

    // Emote bar (quick emotes for local player)
    const emotePid = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;
    const emoteBar = document.createElement('div');
    emoteBar.className = 'mp-emote-bar';
    for (const emote of EMOTE_LIST) {
      const btn = document.createElement('button');
      btn.className = 'mp-emote-btn';
      btn.textContent = emote;
      btn.title = `Send ${emote}`;
      btn.addEventListener('click', (e) => { e.stopPropagation(); sendEmote(emotePid, emote); });
      emoteBar.appendChild(btn);
    }
    playerAvatars.appendChild(emoteBar);

    topBar.appendChild(playerAvatars);

    // Top bar action buttons
    const topActions = document.createElement('div');
    topActions.className = 'mp-top-actions';

    // In hotseat, buttons always work (you control active player). In online, only when it's your turn.
    const actionPlayerId = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;
    if (isMyTurn() && !mpState.winnerId) {
      // Next Phase button
      const nextPhaseBtn = document.createElement('button');
      nextPhaseBtn.className = 'gf-btn gf-btn-phase';
      nextPhaseBtn.textContent = mpState.phase === 'end' ? 'End Turn' : `Next Phase ▸`;
      nextPhaseBtn.addEventListener('click', nextPhase);
      topActions.appendChild(nextPhaseBtn);

      // Draw button
      const drawBtn = document.createElement('button');
      drawBtn.className = 'gf-btn';
      drawBtn.textContent = `Draw (${activePlayer().library.length})`;
      drawBtn.addEventListener('click', () => drawCard(actionPlayerId));
      topActions.appendChild(drawBtn);

      // Draw X button
      const drawXBtn = document.createElement('button');
      drawXBtn.className = 'gf-btn gf-btn-secondary';
      drawXBtn.textContent = 'Draw X';
      drawXBtn.title = 'Draw multiple cards';
      drawXBtn.addEventListener('click', () => {
        const x = prompt('How many cards to draw?');
        if (x) {
          const count = parseInt(x, 10);
          if (!isNaN(count) && count > 0 && count <= 50) {
            pushUndo(activePlayer());
            for (let i = 0; i < count; i++) {
              const p = getPlayer(actionPlayerId);
              if (p.library.length === 0) break;
              p.hand.push(p.library.shift()!);
            }
            turnSummary.drawn += count;
            addLog(`Drew ${count} cards`, actionPlayerId);
            render();
          }
        }
      });
      topActions.appendChild(drawXBtn);

      // Combat button
      if (mpState.phase === 'main1' || mpState.phase === 'combat') {
        const combatBtn = document.createElement('button');
        combatBtn.className = 'gf-btn gf-btn-combat';
 combatBtn.textContent = ' Combat';
        combatBtn.addEventListener('click', enterCombat);
        topActions.appendChild(combatBtn);
      }
    } else if (gameMode === 'online' && !mpState.winnerId) {
      // Show waiting indicator when it's not your turn
      const waitLabel = document.createElement('span');
      waitLabel.style.cssText = 'color:#94a3b8;font-size:0.8rem;padding:6px 12px;';
      waitLabel.textContent = `Waiting for ${activePlayer().playerName}...`;
      topActions.appendChild(waitLabel);
    }

    // ── Grouped toolbar: Library / Tokens / Utilities ──
    const toolPid = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;

    // Helper: create a dropdown group
    function createToolGroup(label: string, items: { text: string; title?: string; action: (e: MouseEvent) => void; active?: boolean }[]): HTMLElement {
      const group = document.createElement('div');
      group.className = 'mp-tool-group';
      const trigger = document.createElement('button');
      trigger.className = 'gf-btn gf-btn-secondary mp-tool-trigger';
      trigger.textContent = label;
      group.appendChild(trigger);
      const dropdown = document.createElement('div');
      dropdown.className = 'mp-tool-dropdown';
      for (const item of items) {
        const btn = document.createElement('button');
        btn.className = `mp-tool-item${item.active ? ' active' : ''}`;
        btn.textContent = item.text;
        if (item.title) btn.title = item.title;
        btn.addEventListener('click', (e) => { item.action(e); dropdown.classList.remove('open'); });
        dropdown.appendChild(btn);
      }
      group.appendChild(dropdown);
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close other dropdowns
        overlay.querySelectorAll('.mp-tool-dropdown.open').forEach(el => { if (el !== dropdown) el.classList.remove('open'); });
        dropdown.classList.toggle('open');
      });
      return group;
    }

    // Library group
    topActions.appendChild(createToolGroup('Library', [
      { text: 'Search Library', title: 'S', action: () => showLibrarySearchModal() },
 { text: 'Look at Top N', title: 'L', action: () => showTopNModal() },
 { text: 'Scry', title: 'R', action: () => showScryModal() },
      { text: 'Mill 1', title: 'Mill top card', action: () => {
        const p = getPlayer(toolPid); pushUndo(p);
        if (p.library.length > 0) { const c = p.library.shift()!; p.graveyard.push(c); addLog(`Milled: ${c}`, toolPid); render(); }
      }},
      { text: 'Mill 3', title: 'Mill top 3 cards', action: () => {
        const p = getPlayer(toolPid); pushUndo(p); const milled: string[] = [];
        for (let i = 0; i < 3 && p.library.length > 0; i++) { const c = p.library.shift()!; p.graveyard.push(c); milled.push(c); }
        if (milled.length) { addLog(`Milled ${milled.length}: ${milled.join(', ')}`, toolPid); render(); }
      }},
      { text: 'Shuffle', title: 'Shuffle Library', action: () => shuffleLibrary(toolPid) },
 { text: 'Reveal Top', title: 'Reveal top card of library', action: () => {
        const p = getPlayer(toolPid);
        if (p.library.length > 0) {
          const topCard = p.library[0];
          showFloatingText(`Top: ${topCard}`, '#60a5fa', 3000);
          showCardZoom(topCard);
          addLog(`Revealed top card: ${topCard}`, toolPid);
        } else { showFloatingText('Library is empty!', '#ef4444'); }
      }},
    ]));

    // Tokens & Create group
 topActions.appendChild(createToolGroup('Create', [
 { text: 'Create Token', title: 'T', action: () => showTokenCreationModal() },
 { text: '↻ Mulligan', title: 'M — London Mulligan', action: () => mulliganHand(toolPid) },
    ]));

    // Utilities group
    const undoPlayerId = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;
    topActions.appendChild(createToolGroup('Tools', [
      { text: `↩ Undo (${getPlayer(undoPlayerId).undoStack.length})`, title: 'Ctrl+Z', action: () => performUndo(undoPlayerId) },
      { text: 'Proliferate', title: 'P — +1 all counters', action: () => proliferate(toolPid) },
      { text: 'Dice / Coin', title: 'Roll dice or flip a coin', action: () => showDiceRollModal() },
      { text: 'Random Discard', title: 'Discard a random card', action: () => randomDiscard(toolPid) },
 { text: soundEnabled ? 'Sound ON' : 'Sound OFF', action: () => toggleSound(), active: soundEnabled },
      { text: coachEnabled ? 'Coach ON' : 'Coach OFF', action: () => toggleCoach(), active: coachEnabled },
      { text: 'Export', title: 'Copy game state (enhanced)', action: () => exportGameState() },
      { text: '↻ Reset Game', action: () => resetGame() },
      { text: '? Shortcuts', action: () => showKeybindsHelp() },
    ]));

    // Mana Pool display with colored symbols + Clear button
    const manaStr = getManaString();
    if (manaStr !== 'empty') {
      const manaEl = document.createElement('span');
      manaEl.className = 'mp-mana-display';
      manaEl.title = 'Mana Pool (auto-clears on phase change)';
      // Build colored mana symbols
      for (const [color, count] of Object.entries(manaPool)) {
        if (count <= 0) continue;
        for (let i = 0; i < count; i++) {
          const sym = document.createElement('span');
          sym.className = `mp-mana-symbol mp-mana-${color}`;
          sym.textContent = color;
          manaEl.appendChild(sym);
        }
      }
      topActions.appendChild(manaEl);

      const manaClearBtn = document.createElement('button');
      manaClearBtn.className = 'gf-btn gf-btn-small';
 manaClearBtn.textContent = '✕';
      manaClearBtn.title = 'Clear Mana Pool';
      manaClearBtn.style.cssText = 'min-width:24px;padding:2px 6px;font-size:0.7rem;margin-left:2px;';
      manaClearBtn.addEventListener('click', () => { clearManaPool(); render(); });
      topActions.appendChild(manaClearBtn);
    }

    // House rules indicator (show when non-default rules are active)
    const nonDefaultRules: string[] = [];
    if (!rules.landPerTurn) nonDefaultRules.push('∞ Lands');
    if (!rules.summoningSickness) nonDefaultRules.push('No Sickness');
    if (!rules.commanderDamage21) nonDefaultRules.push('No Cmd Dmg');
    if (!rules.poisonElimination) nonDefaultRules.push('No Poison');
    if (!rules.maxHandSize) nonDefaultRules.push('No Hand Limit');
    if (rules.freePlay) nonDefaultRules.push('Free Play');
    if (rules.startingLife !== 40) nonDefaultRules.push(`${rules.startingLife} Life`);
    if (nonDefaultRules.length > 0) {
      const hrBadge = document.createElement('span');
      hrBadge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;background:rgba(201,168,76,0.15);border:1px solid rgba(201,168,76,0.3);font-size:0.72rem;color:#c9a84c;cursor:default;';
      hrBadge.title = `House Rules: ${nonDefaultRules.join(', ')}`;
      hrBadge.textContent = `${nonDefaultRules.join(' · ')}`;
      topActions.appendChild(hrBadge);
    }

    // Exit button
    const exitBtn = document.createElement('button');
    exitBtn.className = 'gf-btn gf-btn-danger';
    exitBtn.textContent = 'Exit';
    exitBtn.addEventListener('click', cleanup);
    topActions.appendChild(exitBtn);

    topBar.appendChild(topActions);
    // Close toolbar dropdowns when clicking outside
    topBar.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.mp-tool-group')) {
        topBar.querySelectorAll('.mp-tool-dropdown.open').forEach(el => el.classList.remove('open'));
      }
    });
    renderTarget.appendChild(topBar);

    // ── Visual Phase Bar ──
    const phaseBar = document.createElement('div');
    phaseBar.className = 'mp-phase-bar';
    for (const p of PHASES) {
      const phaseEl = document.createElement('div');
      phaseEl.className = `mp-phase-step${p === mpState.phase ? ' active' : ''}`;
      phaseEl.textContent = PHASE_LABELS[p];
      phaseEl.style.borderBottomColor = p === mpState.phase ? ap.playerColor : 'transparent';
      if (isMyTurn() && !mpState.winnerId) {
        phaseEl.style.cursor = 'pointer';
        phaseEl.addEventListener('click', () => {
          // Skip directly to target phase (no intermediate auto-actions)
          const currentIdx = PHASES.indexOf(mpState.phase);
          const targetIdx = PHASES.indexOf(p);
          if (targetIdx > currentIdx) {
            mpState.phase = p;
            addLog(`Phase → ${PHASE_LABELS[p]}`, getActivePlayerId(mpState));
            render();
          }
        });
      }
      phaseBar.appendChild(phaseEl);
    }
    // Storm count (instants/sorceries cast this turn)
    if (stormCount > 0) {
      const stormEl = document.createElement('span');
      stormEl.className = 'mp-storm-count';
      stormEl.textContent = `Storm: ${stormCount}`;
      stormEl.title = 'Spells cast this turn (storm count)';
      phaseBar.appendChild(stormEl);
    }

    // Turn summary
    if (turnSummary.drawn > 0 || turnSummary.played > 0) {
      const summaryEl = document.createElement('span');
      summaryEl.className = 'mp-turn-summary';
      const parts: string[] = [];
      if (turnSummary.drawn > 0) parts.push(`${turnSummary.drawn} drawn`);
      if (turnSummary.played > 0) parts.push(`${turnSummary.played} played`);
      summaryEl.textContent = parts.join(', ');
      summaryEl.title = 'Actions this turn';
      phaseBar.appendChild(summaryEl);
    }

    // Match timer (live-updating)
    const timerEl = document.createElement('span');
    timerEl.className = 'mp-match-timer';
    timerEl.title = 'Match duration';
    const updateTimer = () => {
      const elapsed = Math.floor((Date.now() - mpState.gameStartedAt) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
 timerEl.textContent = ` ${mins}:${secs.toString().padStart(2, '0')}`;
    };
    updateTimer();
    // Update timer every second (clean up on next render via DOM replacement)
    const timerInterval = setInterval(updateTimer, 1000);
    // Auto-cleanup: when element is removed from DOM, stop interval
    const timerObserver = new MutationObserver(() => {
      if (!document.body.contains(timerEl)) { clearInterval(timerInterval); timerObserver.disconnect(); }
    });
    timerObserver.observe(document.body, { childList: true, subtree: true });
    phaseBar.appendChild(timerEl);

    renderTarget.appendChild(phaseBar);

    // ── Replay Timeline (if snapshots exist) ──
    if (replaySnapshots.length > 1) {
      const replayBar = document.createElement('div');
      replayBar.className = 'mp-replay-bar';
      if (replayMode) {
        const exitBtn = document.createElement('button');
        exitBtn.className = 'gf-btn gf-btn-small';
        exitBtn.textContent = '▶ Live';
        exitBtn.title = 'Return to live game';
        exitBtn.addEventListener('click', exitReplay);
        replayBar.appendChild(exitBtn);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = String(replaySnapshots.length - 1);
        slider.value = String(replayIndex);
        slider.className = 'mp-replay-slider';
        slider.addEventListener('input', () => viewReplayAt(parseInt(slider.value, 10)));
        replayBar.appendChild(slider);
        const label = document.createElement('span');
        label.className = 'mp-replay-label';
        label.textContent = `Step ${replayIndex + 1}/${replaySnapshots.length}`;
        replayBar.appendChild(label);
      } else {
        const replayBtn = document.createElement('button');
        replayBtn.className = 'gf-btn gf-btn-small';
 replayBtn.textContent = ` Replay (${replaySnapshots.length})`;
        replayBtn.title = 'Review game history';
        replayBtn.addEventListener('click', () => viewReplayAt(replaySnapshots.length - 1));
        replayBar.appendChild(replayBtn);
      }
      renderTarget.appendChild(replayBar);
    }

    // ── Game Over Banner (with Victory Animation) ──
    if (mpState.winnerId) {
      const winner = getPlayer(mpState.winnerId);
      const banner = document.createElement('div');
      banner.className = 'mp-game-over mp-victory-animate';
      const confetti = document.createElement('div');
      confetti.className = 'mp-victory-confetti';
      banner.appendChild(confetti);
      const winnerText = document.createElement('div');
      winnerText.className = 'mp-winner-text';
      winnerText.style.color = winner.playerColor;
      winnerText.textContent = `${winner.playerName} wins! `;
      banner.appendChild(winnerText);
      const closeBtn = document.createElement('button');
      closeBtn.className = 'gf-btn';
      closeBtn.textContent = 'Close Game';
      closeBtn.addEventListener('click', cleanup);
      banner.appendChild(closeBtn);
      const newGameBtn = document.createElement('button');
      newGameBtn.className = 'gf-btn gf-btn-secondary';
      newGameBtn.textContent = '↻ Play Again';
      newGameBtn.style.marginLeft = '8px';
      newGameBtn.addEventListener('click', () => { resetGame(); });
      banner.appendChild(newGameBtn);

      // ── Post-Game Statistics ──
      const statsPanel = document.createElement('div');
      statsPanel.className = 'mp-postgame-stats';
      statsPanel.innerHTML = '<div class="mp-stats-title">Game Statistics</div>';

      const statsGrid = document.createElement('div');
      statsGrid.className = 'mp-stats-grid';

      // Per-player stats
      for (const pid of mpState.playerOrder) {
        const p = getPlayer(pid);
        const card = document.createElement('div');
        card.className = 'mp-stats-card';
        card.style.borderColor = p.playerColor;
        const dmgDealt = gameStats.damageDealt[pid] || 0;
        const cardsPlayed = gameStats.cardsPlayed[pid] || 0;
        const cardsDrawn = gameStats.cardsDrawn[pid] || 0;
 const statusIcon = pid === mpState.winnerId ? '' : p.isEliminated ? '✕' : '●';
        card.innerHTML = `
          <div class="mp-stats-player" style="color:${p.playerColor}">${statusIcon} ${p.playerName}</div>
          <div class="mp-stats-row">Final Life: ${p.lifeTotal}</div>
 <div class="mp-stats-row"> Damage Dealt: ${dmgDealt}</div>
          <div class="mp-stats-row">Cards Played: ${cardsPlayed}</div>
          <div class="mp-stats-row">Cards Drawn: ${cardsDrawn}</div>
 <div class="mp-stats-row"> Creatures on BF: ${p.battlefield.filter(b => b.isCreature).length}</div>
        `;
        statsGrid.appendChild(card);
      }
      statsPanel.appendChild(statsGrid);

      // Global stats
      const globalStats = document.createElement('div');
      globalStats.className = 'mp-stats-global';
      const totalTurns = mpState.turn;
      const elapsed = Math.floor(((mpState.gameEndedAt || Date.now()) - mpState.gameStartedAt) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      globalStats.innerHTML = `
        <span>↻ Total Turns: ${totalTurns}</span>
 <span> Duration: ${mins}:${secs.toString().padStart(2, '0')}</span>
 <span> Creatures Killed: ${gameStats.creaturesKilled}</span>
 <span> Combat Phases: ${gameStats.combatPhases}</span>
      `;
      statsPanel.appendChild(globalStats);

      // Life History Canvas
      const lifeCanvas = document.createElement('canvas');
      lifeCanvas.className = 'mp-life-chart';
      lifeCanvas.width = 400;
      lifeCanvas.height = 120;
      statsPanel.appendChild(lifeCanvas);
      // Draw life history chart
      requestAnimationFrame(() => {
        const ctx = lifeCanvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = 'rgba(10,14,23,0.8)';
        ctx.fillRect(0, 0, 400, 120);
        // Find range
        let allVals: number[] = [];
        for (const vals of Object.values(gameStats.lifeTotalHistory)) allVals = allVals.concat(vals);
        const maxL = Math.max(...allVals, 45);
        const minL = Math.min(...allVals, 0);
        const range = Math.max(maxL - minL, 1);
        // Draw grid
        ctx.strokeStyle = 'rgba(100,100,100,0.3)';
        ctx.lineWidth = 0.5;
        for (let y = 0; y <= 120; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(400, y); ctx.stroke(); }
        // Draw each player's life line
        for (const pid of mpState.playerOrder) {
          const hist = gameStats.lifeTotalHistory[pid];
          if (!hist || hist.length < 2) continue;
          const p = getPlayer(pid);
          ctx.strokeStyle = p.playerColor;
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let i = 0; i < hist.length; i++) {
            const x = (i / (hist.length - 1)) * 400;
            const y = 110 - ((hist[i] - minL) / range) * 100;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        // Labels
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px monospace';
        ctx.fillText(`${maxL}`, 2, 12);
        ctx.fillText(`${minL}`, 2, 118);
        ctx.fillText('Life Total History', 140, 12);
      });

      banner.appendChild(statsPanel);
      renderTarget.appendChild(banner);
    }

    // ── Main Game Area ──
    const gameArea = document.createElement('div');
    gameArea.className = `mp-game-area mp-${mpState.playerOrder.length}p`;

    // Render each player zone
    for (const pid of mpState.playerOrder) {
      const player = getPlayer(pid);
      // In hotseat, the current controller sees all hands; in online, only own hand
      const isLocal = gameMode === 'hotseat' ? true : pid === localPlayerId;
      const canControl = gameMode === 'hotseat' ? true : pid === localPlayerId;
      const isActive = pid === getActivePlayerId(mpState);

      const zone = document.createElement('div');
      zone.className = `mp-player-zone${isActive ? ' active-zone' : ''}${player.isEliminated ? ' eliminated-zone' : ''}`;
      zone.style.borderColor = player.playerColor;
      zone.dataset.player = pid;

      // Player zone header
      const header = document.createElement('div');
      header.className = 'mp-zone-header';
      header.style.background = `linear-gradient(90deg, ${player.playerColor}22, transparent)`;
      const creatures = player.battlefield.filter(b => b.isCreature).length;
      const lands = player.battlefield.filter(b => b.isLand).length;
      const otherPerms = player.battlefield.length - creatures - lands;
      const landBadge = player.landPlayedThisTurn ? '<span class="mp-land-played" title="Land played this turn"></span>' : '';
      header.innerHTML = `
 <span class="mp-zone-name" style="color:${player.playerColor}">${player.playerName}${isActive ? ' ★' : ''}${gameMode === 'online' && pid === localPlayerId ? ' <span class="mp-you-badge">YOU</span>' : ''}</span>
        <span class="mp-zone-stats">
          Life: <strong>${player.lifeTotal}</strong>
          ${player.poisonCounters > 0 ? ` | Poison: <strong class="poison">${player.poisonCounters}</strong>` : ''}
          | Library: ${player.library.length}
          | Hand: ${player.hand.length}
          | BF: ${creatures}C ${lands}L${otherPerms > 0 ? ` ${otherPerms}O` : ''}
          ${landBadge}
        </span>
      `;

      // Life adjustment buttons
      if (canControl || (gameMode === 'hotseat' && isActive)) {
        const lifeControls = document.createElement('div');
        lifeControls.className = 'mp-life-controls';
        const lifeDown = document.createElement('button');
        lifeDown.className = 'gf-btn gf-btn-small';
        lifeDown.textContent = '-1';
        lifeDown.addEventListener('click', () => adjustLife(pid, -1));
        const lifeUp = document.createElement('button');
        lifeUp.className = 'gf-btn gf-btn-small';
        lifeUp.textContent = '+1';
        lifeUp.addEventListener('click', () => adjustLife(pid, 1));
        lifeControls.appendChild(lifeDown);
        lifeControls.appendChild(lifeUp);
        header.appendChild(lifeControls);
      }

      zone.appendChild(header);

      // ── Battlefield ──
      const battlefield = document.createElement('div');
      battlefield.className = 'mp-battlefield';

      // Board-wide context menu (right-click on empty battlefield area)
      if (canControl) {
        battlefield.addEventListener('contextmenu', (e) => {
          // Only trigger when clicking the background, not a card
          if ((e.target as HTMLElement).closest('.gf-bf-card')) return;
          e.preventDefault();
          const bfCreatureCount = player.battlefield.filter(p => p.isCreature).length;
          const bfTokenCount = player.battlefield.filter(p => p.isToken).length;
          const bfTappedCount = player.battlefield.filter(p => p.tapped).length;
          const boardItems: GfCtxItem[] = [
            { label: `Untap All (${bfTappedCount})`, action: () => untapAll(pid) },
            { label: 'Tap All Creatures', action: () => {
              pushUndo(player);
              player.battlefield.filter(p => p.isCreature && !p.tapped).forEach(p => p.tapped = true);
              addLog('Tapped all creatures', pid);
              render();
            }},
          ];
          if (bfCreatureCount > 0) {
            boardItems.push({ label: `── Board Wipes ──`, divider: true, action: () => {} });
 boardItems.push({ label: ` Destroy All Creatures (${bfCreatureCount})`, danger: true, action: () => {
              if (!confirm(`Destroy all ${bfCreatureCount} creatures?`)) return;
              pushUndo(player);
              const dying = player.battlefield.filter(p => p.isCreature && !isIndestructible(p));
              for (const d of dying) {
                const idx = player.battlefield.indexOf(d);
                if (idx >= 0) {
                  player.battlefield.splice(idx, 1);
                  if (!d.isToken) {
                    const dk = decks.find(dc => dc.playerName === player.playerName)?.deck;
                    if (isCommander(d.name, dk)) player.commandZone.push(d.name);
                    else player.graveyard.push(d.name);
                  }
                }
              }
              addLog(`Board wipe — ${dying.length} creatures destroyed`, pid);
              render();
            }});
          }
          if (bfTokenCount > 0) {
            boardItems.push({ label: `Remove All Tokens (${bfTokenCount})`, danger: true, action: () => {
              pushUndo(player);
              player.battlefield = player.battlefield.filter(p => !p.isToken);
              addLog(`Removed all ${bfTokenCount} tokens`, pid);
              render();
            }});
          }
          boardItems.push({ label: '── Tools ──', divider: true, action: () => {} });
          boardItems.push({ label: 'Add Note', action: () => {
            const rect = battlefield.getBoundingClientRect();
            const x = ((e as MouseEvent).clientX - rect.left) / rect.width * 100;
            const y = ((e as MouseEvent).clientY - rect.top) / rect.height * 100;
            addBattlefieldNote(pid, x, y);
          }});
          boardItems.push({ label: '── Zone Actions ──', divider: true, action: () => {} });
          boardItems.push({ label: '↻ Bounce All to Hand', danger: true, action: () => {
            if (!confirm(`Return all permanents to hand?`)) return;
            pushUndo(player);
            for (const p of [...player.battlefield]) {
              if (!p.isToken) player.hand.push(p.name);
            }
            player.battlefield = [];
            addLog('All permanents returned to hand', pid);
            render();
          }});
 boardItems.push({ label: ' Sacrifice All', danger: true, action: () => {
            if (!confirm(`Sacrifice all permanents?`)) return;
            pushUndo(player);
            for (const p of [...player.battlefield]) {
              if (!p.isToken) {
                const dk = decks.find(dc => dc.playerName === player.playerName)?.deck;
                if (isCommander(p.name, dk)) player.commandZone.push(p.name);
                else player.graveyard.push(p.name);
              }
            }
            player.battlefield = [];
            addLog('All permanents sacrificed', pid);
            render();
          }});
          showCtxMenu(e, boardItems);
        });
      }

      // Drop zone: drop from hand → battlefield (play)
      // Only activate when there's actually a drag happening (native HTML5 drag from hand cards)
      if (canControl) {
        battlefield.addEventListener('dragover', (ev) => {
          // Only allow drop if it's from a hand card drag (has text/plain data)
          if (ev.dataTransfer?.types.includes('text/plain')) {
            ev.preventDefault();
            battlefield.classList.add('drop-highlight');
          }
        });
        battlefield.addEventListener('dragleave', () => battlefield.classList.remove('drop-highlight'));
        battlefield.addEventListener('drop', (ev) => {
          ev.preventDefault();
          battlefield.classList.remove('drop-highlight');
          try {
            const raw = ev.dataTransfer?.getData('text/plain');
            if (!raw) return;
            const data = JSON.parse(raw);
            if (data.playerId === pid) {
              if (data.zone === 'hand') playFromHand(data.playerId, data.index);
              else if (data.zone === 'graveyard' || data.zone === 'exile') {
                // Return from GY/Exile to battlefield (recursion)
                moveCard(data.playerId, data.zone, 'battlefield', data.index);
              }
            }
          } catch { /* ignore */ }
        });
      }

      // Group permanents by type for visual clarity
      const bfCreatures: { perm: GoldfishPermanent; idx: number }[] = [];
      const bfLands: { perm: GoldfishPermanent; idx: number }[] = [];
      const bfOther: { perm: GoldfishPermanent; idx: number }[] = [];
      player.battlefield.forEach((perm, bfIdx) => {
        if (perm.isCreature) bfCreatures.push({ perm, idx: bfIdx });
        else if (perm.isLand) bfLands.push({ perm, idx: bfIdx });
        else bfOther.push({ perm, idx: bfIdx });
      });

      // Add group labels if there's a mix of types
      const hasMultipleTypes = (bfCreatures.length > 0 ? 1 : 0) + (bfLands.length > 0 ? 1 : 0) + (bfOther.length > 0 ? 1 : 0) > 1;

      if (hasMultipleTypes && bfCreatures.length > 0) {
        const label = document.createElement('div');
        label.className = 'mp-bf-group-label';
 label.textContent = ` Creatures (${bfCreatures.length})`;
        battlefield.appendChild(label);
      }
      for (const { perm, idx } of bfCreatures) renderBfCard(perm, idx, battlefield, player, canControl);

      if (hasMultipleTypes && bfOther.length > 0) {
        const label = document.createElement('div');
        label.className = 'mp-bf-group-label';
 label.textContent = ` Other (${bfOther.length})`;
        battlefield.appendChild(label);
      }
      for (const { perm, idx } of bfOther) renderBfCard(perm, idx, battlefield, player, canControl);

      if (hasMultipleTypes && bfLands.length > 0) {
        const label = document.createElement('div');
        label.className = 'mp-bf-group-label';
        label.textContent = `Lands (${bfLands.length})`;
        battlefield.appendChild(label);
      }
      for (const { perm, idx } of bfLands) renderBfCard(perm, idx, battlefield, player, canControl);

      // Render battlefield notes
      const playerNotes = battlefieldNotes.filter(n => n.playerId === pid);
      for (const note of playerNotes) {
        const noteEl = document.createElement('div');
        noteEl.className = 'mp-bf-note';
        noteEl.style.left = `${note.x}%`;
        noteEl.style.top = `${note.y}%`;
        noteEl.textContent = note.text;
        noteEl.title = 'Click to remove';
        noteEl.addEventListener('click', (e) => { e.stopPropagation(); removeBattlefieldNote(note.id); });
        // Make notes draggable
        noteEl.draggable = true;
        noteEl.addEventListener('dragstart', (ev) => {
          ev.dataTransfer?.setData('application/note-id', note.id);
          ev.stopPropagation();
        });
        battlefield.appendChild(noteEl);
      }
      // Accept note drops to reposition
      battlefield.addEventListener('drop', (ev) => {
        const noteId = ev.dataTransfer?.getData('application/note-id');
        if (noteId) {
          ev.preventDefault();
          const rect = battlefield.getBoundingClientRect();
          const n = battlefieldNotes.find(bn => bn.id === noteId);
          if (n) {
            n.x = ((ev.clientX - rect.left) / rect.width) * 100;
            n.y = ((ev.clientY - rect.top) / rect.height) * 100;
            render();
          }
        }
      });

      zone.appendChild(battlefield);

      // ── Hand (only show own hand, hide opponents in online mode) ──
      // In hotseat: show all hands. In online: only show own hand.
      const showHand = gameMode === 'hotseat' || pid === localPlayerId;
      const handArea = document.createElement('div');
      handArea.className = `mp-hand${showHand ? '' : ' opponent-hand'}`;

      // Hand as drop target (return cards from battlefield)
      if (canControl) {
        handArea.addEventListener('dragover', (ev) => {
          if (ev.dataTransfer?.types.includes('text/plain')) { ev.preventDefault(); handArea.classList.add('drop-highlight'); }
        });
        handArea.addEventListener('dragleave', () => handArea.classList.remove('drop-highlight'));
        handArea.addEventListener('drop', (ev) => {
          ev.preventDefault(); handArea.classList.remove('drop-highlight');
          try {
            const data = JSON.parse(ev.dataTransfer?.getData('text/plain') || '{}');
            if (data.playerId === pid && data.zone === 'battlefield') {
              moveCard(data.playerId, 'battlefield', 'hand', data.index);
            }
          } catch { /* ignore */ }
        });
      }

      if (showHand) {
        const handTitle = document.createElement('div');
        handTitle.className = 'mp-hand-title';
        handTitle.textContent = `${gameMode === 'online' && pid === localPlayerId ? 'Your ' : ''}Hand (${player.hand.length})`;

        // Hand sort buttons (only for own hand)
        const isOwnHand = gameMode === 'hotseat' || pid === localPlayerId;
        if (isOwnHand && player.hand.length > 1) {
          const sortWrap = document.createElement('span');
          sortWrap.className = 'mp-hand-sort-wrap';
          for (const mode of ['default', 'cmc', 'name', 'type'] as const) {
            const btn = document.createElement('button');
            btn.className = `mp-hand-sort-btn${handSortMode === mode ? ' active' : ''}`;
            btn.textContent = mode === 'default' ? 'Unsorted' : mode.toUpperCase();
            btn.addEventListener('click', () => { handSortMode = mode; render(); });
            sortWrap.appendChild(btn);
          }
          handTitle.appendChild(sortWrap);
        }
        handArea.appendChild(handTitle);

        const handCards = document.createElement('div');
        handCards.className = 'mp-hand-cards';

        // In hotseat, play from active player's hand. In online, play from own hand.
        const handPlayerId = gameMode === 'hotseat' ? pid : localPlayerId;

        // Apply sort for display (actual hand array order preserved)
        const displayHand = isOwnHand ? sortHand(player.hand) : player.hand;
        const usedHandIndices = new Set<number>();
        displayHand.forEach((cardName) => {
          // Find original index in the actual hand — skip already-used indices for duplicate names
          let handIdx = -1;
          for (let hi = 0; hi < player.hand.length; hi++) {
            if (player.hand[hi] === cardName && !usedHandIndices.has(hi)) {
              handIdx = hi;
              usedHandIndices.add(hi);
              break;
            }
          }
          if (handIdx < 0) return; // safety
          const cardEl = document.createElement('div');
          cardEl.className = 'gf-hand-card';

          // Dim non-playable cards (land already played, or not active player)
          const cardInfo = classifyCard(cardName, cardByName);
          const isActivePlayerCard = gameMode === 'hotseat' ? pid === getActivePlayerId(mpState) : (pid === localPlayerId && isMyTurn());
          if (isActivePlayerCard) {
            if (rules.landPerTurn && cardInfo.isLand && player.landPlayedThisTurn) {
              cardEl.classList.add('gf-hand-dimmed');
              cardEl.title = 'Land already played this turn';
            }
          } else {
            cardEl.classList.add('gf-hand-dimmed');
          }

          const img = getImgUrl(cardName, cardByName);
          if (img) {
            cardEl.innerHTML = `<img src="${img}" alt="${cardName}" decoding="async" />`;
          } else {
            cardEl.innerHTML = `<div class="gf-card-fallback">${cardName}</div>`;
          }
          attachPreview(cardEl, cardName);

          // Drag & Drop: make hand cards draggable
          if (canControl) {
            cardEl.draggable = true;
            cardEl.addEventListener('dragstart', (ev) => {
              ev.dataTransfer?.setData('text/plain', JSON.stringify({ zone: 'hand', index: handIdx, cardName, playerId: pid }));
              cardEl.classList.add('dragging');
            });
            cardEl.addEventListener('dragend', () => cardEl.classList.remove('dragging'));
          }

          // Click to play (only when it's the player's turn)
          const canPlay = gameMode === 'hotseat'
            ? pid === getActivePlayerId(mpState)
            : (pid === localPlayerId && isMyTurn());
          if (canPlay) {
            cardEl.addEventListener('click', () => playFromHand(handPlayerId, handIdx));
          }

          // Context menu (only for own hand)
          if (canControl) {
            cardEl.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              const items: GfCtxItem[] = [
                { label: 'Play', action: () => playFromHand(handPlayerId, handIdx) },
                { label: 'Discard', action: () => moveCard(handPlayerId, 'hand', 'graveyard', handIdx) },
                { label: '→ Exile', action: () => moveCard(handPlayerId, 'hand', 'exile', handIdx) },
                { label: '→ Top of Library', action: () => moveCard(handPlayerId, 'hand', 'library', handIdx) },
                { label: '→ Bottom of Library', action: () => {
                  const p = getPlayer(handPlayerId);
                  pushUndo(p);
                  const removed = p.hand.splice(handIdx, 1)[0];
                  p.library.push(removed);
                  addLog(`${removed} → bottom of library`, handPlayerId);
                  render();
                }},
                { label: '→ Command Zone', action: () => {
                  const p = getPlayer(handPlayerId);
                  pushUndo(p);
                  const removed = p.hand.splice(handIdx, 1)[0];
                  p.commandZone.push(removed);
                  addLog(`${removed} → Command Zone`, handPlayerId);
                  render();
                }},
              ];
              showCtxMenu(e, items);
            });
          }

          handCards.appendChild(cardEl);
        });

        handArea.appendChild(handCards);

        // Hand size warning (> 7 cards at end step) — skipped if house rule disabled
        if (rules.maxHandSize && player.hand.length > 7 && (mpState.phase === 'end' || mpState.phase === 'main2')) {
          const warnEl = document.createElement('div');
          warnEl.className = 'mp-hand-warning';
          warnEl.textContent = `! ${player.hand.length - 7} cards over hand size limit — discard to 7`;
          handArea.appendChild(warnEl);
        }
      } else {
        // Opponent hand: show card backs (max 10 visible)
        const handCount = player.hand.length;
        const visibleBacks = Math.min(handCount, 10);
        const moreLabel = handCount > 10 ? `<span class="mp-hand-more">+${handCount - 10} more</span>` : '';
        handArea.innerHTML = `<div class="mp-hand-title">${player.playerName}'s Hand (${handCount})</div>
          <div class="mp-hand-backs">${'<div class="gf-card-back"></div>'.repeat(visibleBacks)}${moreLabel}</div>`;
      }

      zone.appendChild(handArea);

      // ── Side zones (graveyard, exile, command zone) ──
      const sideZones = document.createElement('div');
      sideZones.className = 'mp-side-zones';

      // Command Zone
      if (player.commandZone.length > 0) {
        const czEl = document.createElement('div');
        czEl.className = 'mp-mini-zone';
        czEl.innerHTML = `<div class="mp-mini-title">Command Zone (${player.commandZone.length}) | Tax: ${player.commanderTax}</div>`;
        player.commandZone.forEach((cardName, cmdIdx) => {
          const cardEl = document.createElement('div');
          cardEl.className = 'gf-zone-card';
          const img = getImgUrl(cardName, cardByName);
          if (img) cardEl.innerHTML = `<img src="${img}" alt="${cardName}" decoding="async" />`;
          else cardEl.innerHTML = `<div class="gf-card-fallback">${cardName}</div>`;
          attachPreview(cardEl, cardName);
          if (canControl && (gameMode === 'hotseat' ? pid === getActivePlayerId(mpState) : isMyTurn())) {
            cardEl.addEventListener('click', () => castCommander(pid, cmdIdx));
          }
          czEl.appendChild(cardEl);
        });
        sideZones.appendChild(czEl);
      }

      // Graveyard (drop target)
      const gyEl = document.createElement('div');
      gyEl.className = 'mp-mini-zone clickable';
      gyEl.innerHTML = `<div class="mp-mini-title">Graveyard (${player.graveyard.length})</div>`;
      if (player.graveyard.length > 0) {
        const lastCard = player.graveyard[player.graveyard.length - 1];
        const img = getImgUrl(lastCard, cardByName);
        gyEl.innerHTML += img ? `<img src="${img}" class="mp-mini-card" alt="${lastCard}" />` : `<div class="gf-card-fallback-sm">${lastCard}</div>`;
        gyEl.addEventListener('click', () => showZoneModal(`${player.playerName}'s Graveyard`, player.graveyard, 'graveyard', pid));
      }
      if (canControl) {
        gyEl.addEventListener('dragover', (ev) => { ev.preventDefault(); gyEl.classList.add('drop-highlight'); });
        gyEl.addEventListener('dragleave', () => gyEl.classList.remove('drop-highlight'));
        gyEl.addEventListener('drop', (ev) => {
          ev.preventDefault(); gyEl.classList.remove('drop-highlight');
          try {
            const data = JSON.parse(ev.dataTransfer?.getData('text/plain') || '{}');
            if (data.playerId === pid) moveCard(data.playerId, data.zone, 'graveyard', data.index);
          } catch { /* ignore */ }
        });
      }
      sideZones.appendChild(gyEl);

      // Exile (drop target)
      const exEl = document.createElement('div');
      exEl.className = 'mp-mini-zone clickable';
      exEl.innerHTML = `<div class="mp-mini-title">Exile (${player.exile.length})</div>`;
      if (player.exile.length > 0) {
        const lastCard = player.exile[player.exile.length - 1];
        const img = getImgUrl(lastCard, cardByName);
        exEl.innerHTML += img ? `<img src="${img}" class="mp-mini-card" alt="${lastCard}" />` : `<div class="gf-card-fallback-sm">${lastCard}</div>`;
        exEl.addEventListener('click', () => showZoneModal(`${player.playerName}'s Exile`, player.exile, 'exile', pid));
      }
      if (canControl) {
        exEl.addEventListener('dragover', (ev) => { ev.preventDefault(); exEl.classList.add('drop-highlight'); });
        exEl.addEventListener('dragleave', () => exEl.classList.remove('drop-highlight'));
        exEl.addEventListener('drop', (ev) => {
          ev.preventDefault(); exEl.classList.remove('drop-highlight');
          try {
            const data = JSON.parse(ev.dataTransfer?.getData('text/plain') || '{}');
            if (data.playerId === pid) moveCard(data.playerId, data.zone, 'exile', data.index);
          } catch { /* ignore */ }
        });
      }
      sideZones.appendChild(exEl);

      zone.appendChild(sideZones);
      gameArea.appendChild(zone);
    }

    renderTarget.appendChild(gameArea);

    // ── Combat UI (if active) ──
    if (mpState.combat) {
      const combatBar = document.createElement('div');
      combatBar.className = 'mp-combat-bar';

      if (mpState.combat.phase === 'declare-attackers' && isMyTurn()) {
        // Attacker declaration phase
        combatBar.classList.add('mp-combat-attackers');
        const combatInfo = document.createElement('div');
        combatInfo.className = 'mp-combat-info';
        const eligible = getEligibleAttackersGoldfish(activePlayer(), mpState.turn, !rules.summoningSickness);
 combatInfo.textContent = ` Declare Attackers — Click creatures, then click target player (${mpState.combat.attackers.length}/${eligible.length} attacking)`;

        // Attack-All button
        const opponents = mpState.playerOrder.filter(p => p !== getActivePlayerId(mpState) && !getPlayer(p).isEliminated);
        if (eligible.length > 0 && opponents.length > 0) {
          const atkAllBtn = document.createElement('button');
          atkAllBtn.className = 'gf-btn gf-btn-secondary';
 atkAllBtn.textContent = ` Attack All (${eligible.length})`;
          atkAllBtn.title = 'Attack with all eligible creatures';
          if (opponents.length === 1) {
            atkAllBtn.addEventListener('click', () => attackWithAll(opponents[0]));
            combatBar.appendChild(atkAllBtn);
          } else {
            // Multiple opponents: show per-target buttons
            const atkWrap = document.createElement('div');
            atkWrap.className = 'mp-atk-target-wrap';
            atkWrap.appendChild(atkAllBtn);
            // Dropdown target buttons
            const atkTargets = document.createElement('div');
            atkTargets.className = 'mp-atk-target-grid';
            atkTargets.style.display = 'none';
            for (const opp of opponents) {
              const op = getPlayer(opp);
              const tBtn = document.createElement('button');
              tBtn.className = 'gf-btn gf-btn-small mp-atk-target-btn';
              tBtn.style.borderColor = op.playerColor;
 tBtn.innerHTML = `<span style="color:${op.playerColor}">✕</span> ${op.playerName} (${op.lifeTotal})`;
              tBtn.addEventListener('click', () => { attackWithAll(opp); atkTargets.style.display = 'none'; });
              atkTargets.appendChild(tBtn);
            }
            atkAllBtn.addEventListener('click', () => {
              atkTargets.style.display = atkTargets.style.display === 'none' ? 'flex' : 'none';
            });
            atkWrap.appendChild(atkTargets);
            combatBar.appendChild(atkWrap);
          }
        }

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'gf-btn gf-btn-combat';
 confirmBtn.textContent = mpState.combat.attackers.length > 0 ? ' Confirm Attackers' : 'Skip Combat';
        confirmBtn.addEventListener('click', confirmAttackers);

        combatBar.appendChild(combatInfo);
        combatBar.appendChild(confirmBtn);
      } else if (mpState.combat.phase === 'declare-blockers') {
        // Blocker declaration phase
        combatBar.classList.add('mp-combat-blockers');
        const currentDefId = mpState.combat.defendingPlayerIds[mpState.combat.activeDefenderIndex];
        const defender = currentDefId ? getPlayer(currentDefId) : null;

        // In hotseat, current defender can block. In online, only if it's our player.
        const canDeclareBlockers = gameMode === 'hotseat' || currentDefId === localPlayerId;

        const combatInfo = document.createElement('div');
        combatInfo.className = 'mp-combat-info';
        if (canDeclareBlockers && defender) {
          combatInfo.innerHTML = `■ <strong style="color:${defender.playerColor}">${defender.playerName}</strong> — Declare Blockers: Click your creature → Click an attacker to block`;
        } else if (defender) {
          combatInfo.textContent = `■ Waiting for ${defender.playerName} to declare blockers...`;
        }

        if (canDeclareBlockers) {
          const blockerCount = mpState.combat.blockers.filter(b => b.blockerPlayerId === currentDefId).length;
          const confirmBtn = document.createElement('button');
          confirmBtn.className = 'gf-btn gf-btn-combat';
          confirmBtn.textContent = blockerCount > 0 ? `■ Confirm ${blockerCount} Blocker(s)` : 'No Blocks';
          confirmBtn.addEventListener('click', confirmBlockers);
          combatBar.appendChild(combatInfo);
          combatBar.appendChild(confirmBtn);
        } else {
          combatBar.appendChild(combatInfo);
        }
      }

      if (combatBar.children.length > 0) {
        renderTarget.appendChild(combatBar);
      }
    }

    // ── Shared Game Log ──
    const logPanel = document.createElement('div');
    logPanel.className = 'mp-log-panel';
    logPanel.innerHTML = `<div class="mp-log-title">Game Log</div>`;

    // Log filter buttons
    const logFilterBar = document.createElement('div');
    logFilterBar.className = 'mp-log-filter-bar';
    for (const f of ['all', 'combat', 'life', 'cards'] as const) {
      const btn = document.createElement('button');
      btn.className = `mp-log-filter-btn${logFilter === f ? ' active' : ''}`;
      btn.textContent = f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1);
      btn.addEventListener('click', () => { logFilter = f; render(); });
      logFilterBar.appendChild(btn);
    }
    logPanel.appendChild(logFilterBar);

    const logEntries = document.createElement('div');
    logEntries.className = 'mp-log-entries';
    const last30 = filterLog(mpState.sharedLog.slice(-40)).slice(-30);
    for (const entry of last30) {
      const logEl = document.createElement('div');
      logEl.className = 'mp-log-entry';
      // Color-code by player
      let logColor = '';
      for (const pid of mpState.playerOrder) {
        const p = getPlayer(pid);
        if (entry.includes(p.playerName)) { logColor = p.playerColor; break; }
      }
      if (logColor) {
        const dot = document.createElement('span');
        dot.style.cssText = `display:inline-block;width:6px;height:6px;border-radius:50%;background:${logColor};margin-right:4px;vertical-align:middle;`;
        logEl.appendChild(dot);
      }
      const textNode = document.createTextNode(entry);
      logEl.appendChild(textNode);
      logEntries.appendChild(logEl);
    }
    logPanel.appendChild(logEntries);

    // ── Commander Damage Matrix (Enhanced Interactive) ──
    {
      const ledger = document.createElement('div');
      ledger.className = 'mp-commander-ledger';
      const ledgerToggle = document.createElement('div');
      ledgerToggle.className = 'mp-ledger-title mp-ledger-toggle';
      ledgerToggle.textContent = 'Commander Damage Matrix ▾';
      ledgerToggle.style.cursor = 'pointer';
      ledger.appendChild(ledgerToggle);

      const ledgerBody = document.createElement('div');
      ledgerBody.className = 'mp-ledger-body';
      ledgerBody.style.display = 'none';

      // Collect all commander names from all players' received damage
      const allCmds = new Set<string>();
      for (const pid of mpState.playerOrder) {
        for (const k of Object.keys(getPlayer(pid).commanderDamageReceived)) allCmds.add(k);
      }
      // Also add commanders from command zone and battlefield
      for (const pid of mpState.playerOrder) {
        const p = getPlayer(pid);
        const dk = decks.find(d => d.playerName === p.playerName)?.deck;
        if (dk) {
          for (const cmd of dk.boards.commander) {
            allCmds.add(cmd.name);
          }
        }
      }

      if (allCmds.size > 0) {
        const table = document.createElement('table');
        table.className = 'mp-ledger-table';
        // Header row
        const thead = document.createElement('tr');
        thead.innerHTML = `<th>Receiver ↓</th>` + [...allCmds].map(c => `<th title="${c}">${c.length > 12 ? c.slice(0, 12) + '…' : c}</th>`).join('');
        table.appendChild(thead);
        // Data rows
        for (const pid of mpState.playerOrder) {
          const p = getPlayer(pid);
          const tr = document.createElement('tr');
          let cells = `<td style="color:${p.playerColor}">${p.playerName}</td>`;
          for (const cmd of allCmds) {
            const dmg = p.commanderDamageReceived[cmd] || 0;
            const colorClass = dmg >= 21 ? 'mp-cmd-lethal' : dmg >= 16 ? 'mp-cmd-danger' : dmg >= 10 ? 'mp-cmd-warning' : '';
            cells += `<td class="${colorClass}" data-pid="${pid}" data-cmd="${cmd}">${dmg}</td>`;
          }
          tr.innerHTML = cells;
          // Make cells clickable for manual adjustment
          table.appendChild(tr);
        }
        ledgerBody.appendChild(table);

        // Click handler for manual adjustment
        table.addEventListener('click', (e) => {
          const cell = (e.target as HTMLElement).closest('td[data-pid]') as HTMLElement | null;
          if (!cell) return;
          const pid = cell.dataset.pid!;
          const cmd = cell.dataset.cmd!;
          const p = getPlayer(pid);
          const current = p.commanderDamageReceived[cmd] || 0;
          const newVal = prompt(`Commander damage from ${cmd} to ${p.playerName}:`, String(current));
          if (newVal === null) return;
          const parsed = parseInt(newVal, 10);
          if (!isNaN(parsed) && parsed >= 0) {
            p.commanderDamageReceived[cmd] = parsed;
            addLog(`Commander damage adjusted: ${cmd} → ${p.playerName} = ${parsed}`, pid);
            checkElimination(pid);
            render();
          }
        });
      } else {
        ledgerBody.innerHTML = '<div style="padding:8px;color:#64748b;font-size:0.75rem;">No commander damage recorded yet</div>';
      }

      ledger.appendChild(ledgerBody);
      ledgerToggle.addEventListener('click', () => {
        const open = ledgerBody.style.display !== 'none';
        ledgerBody.style.display = open ? 'none' : 'block';
        ledgerToggle.textContent = open ? 'Commander Damage Matrix ▾' : 'Commander Damage Matrix ▴';
      });
      logPanel.appendChild(ledger);
    }

    // Coach Panel (below log)
    const activeCoach = getCoachForActivePlayer();
    if (activeCoach) {
      const coachPid = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;
      const coachState = buildCoachState(coachPid);
      if (coachState) {
        const coachContainer = document.createElement('div');
        coachContainer.className = 'mp-coach-container';
        renderCoachPanel(coachContainer, activeCoach, coachState);
        logPanel.appendChild(coachContainer);
      }
    }

    renderTarget.appendChild(logPanel);

    // ── Atomic DOM swap: replace all children at once ──
    overlay.textContent = '';
    overlay.appendChild(frag);

    // Scroll log to bottom
    requestAnimationFrame(() => { logEntries.scrollTop = logEntries.scrollHeight; });

    // Coach SVG lines (after DOM is attached)
    if (activeCoach) {
      const gameArea = overlay.querySelector('.mp-game-area') as HTMLElement | null;
      if (gameArea) {
        const coachPid = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;
        const coachState = buildCoachState(coachPid);
        initCoachLines(gameArea, activeCoach);
        if (coachState) updateCoachLines(activeCoach, coachState);
      }
    }

    // Live state sync for online mode (debounced)
    scheduleStateSync();

    // Capture replay snapshot (debounced — only on real state changes)
    if (!replayMode) captureSnapshot();

    // Track life history
    trackLifeHistory();
  }

  // ── Combat target tracking ──
  let selectedAttackTarget: string | null = null;

  // ── Battlefield Card Renderer ──
  function renderBfCard(
    perm: GoldfishPermanent,
    bfIdx: number,
    container: HTMLElement,
    player: PlayerGameState,
    isLocal: boolean,
  ): void {
    const card = document.createElement('div');
    const isNew = perm.enteredTurn === mpState.turn;
    card.className = `gf-bf-card${perm.tapped ? ' tapped' : ''}${perm.isToken ? ' token' : ''}${perm.id === lastActionPermId ? ' last-action' : ''}${isNew ? ' entering' : ''}`;
    card.style.left = `${perm.x}%`;
    card.style.top = `${perm.y}%`;
    card.style.borderColor = player.playerColor;
    card.dataset.permId = perm.id;

    // Attacker highlight
    const isAttacker = mpState.combat?.attackers.some(a => a.permanentId === perm.id);
    if (isAttacker) card.classList.add('attacking');

    // Blocker highlight
    if (perm.blockingId) card.classList.add('blocking');
    // Selected blocker (player clicked this creature to use as blocker)
    if (perm.id === selectedBlocker) card.classList.add('mp-blocker-selected');

    // Legal move indicators during combat
    if (mpState.combat?.phase === 'declare-attackers' && isLocal && perm.isCreature) {
      const eligible = getEligibleAttackersGoldfish(player, mpState.turn, !rules.summoningSickness);
      if (eligible.some(e => e.id === perm.id) && !perm.attacking) {
        card.classList.add('mp-can-attack');
      }
    }
    if (mpState.combat?.phase === 'declare-blockers') {
      const currentDefId = mpState.combat.defendingPlayerIds[mpState.combat.activeDefenderIndex];
      const canDeclareBlockers = gameMode === 'hotseat' ? player.playerId === currentDefId : currentDefId === localPlayerId;
      if (canDeclareBlockers && player.playerId === currentDefId && perm.isCreature && !perm.tapped) {
        card.classList.add('mp-can-block');
      }
      // Attacker that can be targeted by blocker
      if (isAttacker && selectedBlocker) {
        card.classList.add('mp-block-target');
      }
    }

    // Face-down indicator
    if (perm.faceDown) {
      card.classList.add('face-down');
 card.innerHTML = `<div class="gf-face-down-label"><br>2/2</div>`;
    }
    // Image (use cloneNode from preloaded cache to avoid flicker)
    else if (perm.imgUrl) {
      const cached = imgCache.get(perm.imgUrl);
      if (cached) {
        const clone = cached.cloneNode(true) as HTMLImageElement;
        clone.alt = perm.name;
        clone.draggable = false;
        card.appendChild(clone);
      } else {
        const img = document.createElement('img');
        img.src = perm.imgUrl;
        img.alt = perm.name;
        img.draggable = false;
        img.decoding = 'async';
        img.addEventListener('load', () => { imgCache.set(perm.imgUrl, img); }, { once: true });
        card.appendChild(img);
      }
    } else {
      card.innerHTML = `<div class="gf-token-label">${perm.name}${perm.power ? ` ${perm.power}/${perm.toughness}` : ''}</div>`;
    }

    // Hover preview on battlefield cards
    attachPreview(card, perm.name);

    // Counter badges
    const counterTypes = Object.entries(perm.counters);
    const positions = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'top-center', 'bottom-center', 'left-center', 'right-center'];
    counterTypes.forEach(([type, count], i) => {
      if (count <= 0) return;
      const badge = document.createElement('span');
      badge.className = `gf-counter-badge ${positions[i % positions.length]}`;
      badge.textContent = `${count} ${type}`;
      card.appendChild(badge);
    });

    // Damage badge (creatures with marked damage)
    if (perm.isCreature && perm.damage > 0) {
      const dmgBadge = document.createElement('span');
      const isLethal = perm.damage >= perm.currentToughness;
      dmgBadge.className = `gf-damage-badge${isLethal ? ' lethal' : ''}`;
      dmgBadge.textContent = `${perm.damage} dmg`;
      card.appendChild(dmgBadge);
    }

    // P/T overlay for creatures (shows base vs modified)
    if (perm.isCreature && (perm.power || perm.currentPower > 0 || perm.currentToughness > 0)) {
      const basePower = parseInt(perm.power || '0') || 0;
      const baseToughness = parseInt(perm.toughness || '0') || 0;
      const isBuffed = perm.currentPower > basePower || perm.currentToughness > baseToughness;
      const isNerfed = perm.currentPower < basePower || perm.currentToughness < baseToughness;
      const isModified = isBuffed || isNerfed;
      const ptOverlay = document.createElement('span');
      ptOverlay.className = `gf-pt-overlay${isBuffed ? ' buffed' : isNerfed ? ' nerfed' : ''}${isModified ? ' modified' : ''}`;
      // Show base → current when modified
      if (isModified) {
        ptOverlay.innerHTML = `<small style="opacity:0.5;text-decoration:line-through">${basePower}/${baseToughness}</small> ${perm.currentPower}/${perm.currentToughness}`;
      } else {
        ptOverlay.textContent = `${perm.currentPower}/${perm.currentToughness}`;
      }
      ptOverlay.title = `Base: ${basePower}/${baseToughness} | Current: ${perm.currentPower}/${perm.currentToughness} | Damage: ${perm.damage}`;
      card.appendChild(ptOverlay);
    }

    // Role badge (Coach)
    const coachForBadge = coaches.get(player.playerId);
    if (coachEnabled && coachForBadge) {
      const badge = getRoleBadge(perm.name, coachForBadge);
      if (badge) card.appendChild(badge);
    }

    // Player color indicator
    const ownerTag = document.createElement('div');
    ownerTag.className = 'mp-owner-tag';
    ownerTag.style.background = player.playerColor;
    card.appendChild(ownerTag);

    // Saga indicator (show chapter progress)
    if (isSaga(perm)) {
      const loreCount = perm.counters['lore'] || 0;
      const chapterTotal = getSagaChapterCount(perm);
      const sagaBadge = document.createElement('span');
      sagaBadge.className = 'gf-saga-badge';
      sagaBadge.textContent = `${loreCount}/${chapterTotal}`;
      sagaBadge.title = `Saga — Chapter ${loreCount} of ${chapterTotal}`;
      card.appendChild(sagaBadge);
    }

    // Equipment/Aura attachment indicator
    const attachedTo = equipmentAttachments.get(perm.id);
    if (attachedTo) {
      const targetPerm = player.battlefield.find(p => p.id === attachedTo);
      if (targetPerm) {
        const attachBadge = document.createElement('span');
        attachBadge.className = 'gf-attach-badge';
 attachBadge.textContent = isEquipment(perm) ? `✕→${targetPerm.name.slice(0, 8)}` : `→${targetPerm.name.slice(0, 8)}`;
        attachBadge.title = `Attached to ${targetPerm.name}`;
        card.appendChild(attachBadge);
      }
    }
    // Show equipment attached to this creature
    if (perm.isCreature) {
      const attachedItems: string[] = [];
      for (const [eqId, targetId] of equipmentAttachments) {
        if (targetId === perm.id) {
          const eq = player.battlefield.find(p => p.id === eqId);
          if (eq) attachedItems.push(eq.name);
        }
      }
      if (attachedItems.length > 0) {
        const eqLabel = document.createElement('span');
        eqLabel.className = 'gf-equipped-label';
        eqLabel.textContent = `[${attachedItems.map(n => n.slice(0, 6)).join(', ')}]`;
        eqLabel.title = `Equipped: ${attachedItems.join(', ')}`;
        card.appendChild(eqLabel);
      }
    }

    // Interactions
    if (isLocal) {
      // Double-click: tap/untap (alternative to Ctrl+Click)
      card.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        tapPermanent(player.playerId, bfIdx);
      });

      // Click: Ctrl+Click = tap/untap, Normal click = zoom preview
      // During combat: normal click = declare attacker/blocker (no Ctrl needed)
      card.addEventListener('click', (e) => {
        e.stopPropagation();

        // Declare attackers phase: toggle attacker (no Ctrl needed)
        if (mpState.combat?.phase === 'declare-attackers' && perm.isCreature && player.playerId === getActivePlayerId(mpState)) {
          const atkPlayerId = getActivePlayerId(mpState);
          const opponents = mpState.playerOrder.filter(p => p !== atkPlayerId && !getPlayer(p).isEliminated);

          // Already attacking → toggle off
          const existingAtk = mpState.combat.attackers.findIndex(a => a.permanentId === perm.id);
          if (existingAtk >= 0) {
            declareAttacker(perm.id, opponents[0]); // toggle off
            return;
          }

          // Determine target: use selected, or auto-pick sole opponent, or auto-pick first
          let target = selectedAttackTarget;
          if (!target && opponents.length >= 1) {
            target = opponents[0]; // Auto-pick first/only opponent
          }
          if (target) {
            declareAttacker(perm.id, target);
          }
          return; // Always consume click during declare-attackers for creatures
        }

        // Declare blockers phase: select blocker or assign to attacker (no Ctrl needed)
        if (mpState.combat?.phase === 'declare-blockers') {
          const currentDefId = mpState.combat.defendingPlayerIds[mpState.combat.activeDefenderIndex];
          const canBlock = gameMode === 'hotseat' ? player.playerId === currentDefId : currentDefId === localPlayerId;

          if (canBlock && player.playerId === currentDefId && perm.isCreature && !perm.tapped) {
            // Toggle: clicking same blocker deselects
            if (selectedBlocker === perm.id) {
              selectedBlocker = null;
            } else {
              selectedBlocker = perm.id;
            }
            render();
            return;
          }
          if (selectedBlocker && isAttacker) {
            declareBlocker(selectedBlocker, perm.id, currentDefId);
            return;
          }
        }

        // Ctrl+Click (or Cmd on Mac): tap/untap
        if (e.ctrlKey || e.metaKey) {
          tapPermanent(player.playerId, bfIdx);
          return;
        }

        // Normal click: show large card zoom (only outside combat)
        if (!mpState.combat) {
          const normalImg = getCard(perm.name, cardByName)?.image_uris?.normal || perm.imgUrl;
          showCardZoom(perm.name, normalImg);
        } else {
          // During combat, tap/untap on regular click for non-creature permanents
          tapPermanent(player.playerId, bfIdx);
        }
      });

      // Context menu
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const items: GfCtxItem[] = [
          { label: perm.tapped ? 'Untap' : 'Tap', action: () => tapPermanent(player.playerId, bfIdx) },
        ];
        // Quick-damage for creatures
        if (perm.isCreature) {
 items.push({ label: `Deal Damage...`, action: () => {
            const amt = prompt(`How much damage to ${perm.name}? (current: ${perm.damage}/${perm.currentToughness})`);
            if (amt) {
              const val = parseInt(amt, 10);
              if (!isNaN(val) && val > 0) {
                pushUndo(player);
                perm.damage += val;
                addLog(`${perm.name} takes ${val} damage (total: ${perm.damage}/${perm.currentToughness})`, player.playerId);
                runStateBasedActions();
                render();
              }
            }
          }});
          items.push({ label: `Remove Damage`, action: () => {
            if (perm.damage > 0) {
              pushUndo(player);
              perm.damage = 0;
              addLog(`Damage cleared from ${perm.name}`, player.playerId);
              render();
            }
          }});
        }
        items.push(
          { label: '+1/+1 Counter', action: () => adjustCounter(player.playerId, bfIdx, 1, '+1/+1') },
          { label: '-1/-1 Counter', action: () => adjustCounter(player.playerId, bfIdx, 1, '-1/-1') },
          { label: 'Loyalty +1', action: () => adjustCounter(player.playerId, bfIdx, 1, 'loyalty') },
          { label: 'Loyalty -1', action: () => adjustCounter(player.playerId, bfIdx, -1, 'loyalty') },
          { label: 'Lore Counter', action: () => adjustCounter(player.playerId, bfIdx, 1, 'lore') },
          { label: 'Charge Counter', action: () => adjustCounter(player.playerId, bfIdx, 1, 'charge') },
          { label: 'Shield Counter', action: () => adjustCounter(player.playerId, bfIdx, 1, 'shield') },
          { label: 'Custom Counter...', action: () => {
            const name = prompt('Counter name:');
            if (name && name.trim()) adjustCounter(player.playerId, bfIdx, 1, name.trim());
          }},
        );

        // Remove existing counters section
        const existingCounters = Object.entries(perm.counters).filter(([, v]) => v > 0);
        if (existingCounters.length > 0) {
          items.push({ label: '── Remove Counters ──', divider: true, action: () => {} });
          for (const [cType, cCount] of existingCounters) {
            items.push({ label: `- ${cType} (${cCount})`, danger: true, action: () => adjustCounter(player.playerId, bfIdx, -1, cType) });
          }
        }

        // Mana option (only for lands / tapped permanents that could produce mana)
        if (perm.isLand || perm.oracleText.toLowerCase().includes('add {') || perm.oracleText.toLowerCase().includes('add one mana')) {
          items.push({ label: '+ Mana (W/U/B/R/G/C)...', divider: true, action: () => {
            const color = prompt('Mana color? (W, U, B, R, G, or C)')?.toUpperCase().trim();
            if (color && 'WUBRGC'.includes(color)) addMana(color);
          }});
        }

        // Auto-detect tokens from Oracle text
        if (perm.oracleText) {
          const detectedTokens = extractTokensFromOracle(perm.oracleText);
          if (detectedTokens.length > 0) {
            items.push({ label: '── Create Token ──', divider: true, action: () => {} });
            for (const dt of detectedTokens) {
              const tokenLabel = dt.power ? `${dt.name} ${dt.power}/${dt.toughness}` : dt.name;
 items.push({ label: `${tokenLabel} (1x)`, action: () => {
                const imgUrl = tokenImageCache.get(dt.name) || '';
                createTokensFromTemplate(player.playerId, { name: dt.name, power: dt.power, toughness: dt.toughness, typeLine: dt.typeLine, imgUrl }, 1);
                if (!imgUrl) fetchTokenImage(dt.name).then(url => { if (url) { for (const bf of player.battlefield) { if (bf.isToken && bf.name === dt.name && !bf.imgUrl) bf.imgUrl = url; } render(); } });
              }});
            }
          }
        }

        // Token Clone / Copy as Token options
        if (perm.isToken) {
 items.push({ label: ' Copy Token (1x)', divider: true, action: () => {
            createTokensFromTemplate(player.playerId, {
              name: perm.name, power: perm.power, toughness: perm.toughness,
              colors: '', typeLine: perm.typeLine, abilities: '', imgUrl: perm.imgUrl,
            }, 1);
          }});
 items.push({ label: ' Copy Token (5x)', action: () => {
            createTokensFromTemplate(player.playerId, {
              name: perm.name, power: perm.power, toughness: perm.toughness,
              colors: '', typeLine: perm.typeLine, abilities: '', imgUrl: perm.imgUrl,
            }, 5);
          }});
        } else if (perm.isCreature) {
          // Copy any creature as token copy
 items.push({ label: ' Create Token Copy', divider: true, action: () => {
            createTokensFromTemplate(player.playerId, {
              name: perm.name, power: perm.power, toughness: perm.toughness,
              typeLine: perm.typeLine, imgUrl: perm.imgUrl,
            }, 1);
          }});
        }
        // Equipment: attach to creature or detach
        if (isEquipment(perm)) {
          const creatures = player.battlefield.filter(p => p.isCreature);
          if (creatures.length > 0) {
            items.push({ label: '── Equipment ──', divider: true, action: () => {} });
            const attachedTo = equipmentAttachments.get(perm.id);
            if (attachedTo) {
              const attached = player.battlefield.find(p => p.id === attachedTo);
              items.push({ label: `Detach from ${attached?.name || '?'}`, action: () => detachEquipment(player.playerId, bfIdx) });
            }
            for (const cr of creatures.slice(0, 6)) {
              const crIdx = player.battlefield.indexOf(cr);
 items.push({ label: ` Equip → ${cr.name}`, action: () => attachEquipment(player.playerId, bfIdx, crIdx) });
            }
          }
        }
        // Aura: attach indicator
        if (isAura(perm)) {
          const creatures = player.battlefield.filter(p => p.isCreature);
          if (creatures.length > 0) {
            items.push({ label: '── Enchant ──', divider: true, action: () => {} });
            const attachedTo = equipmentAttachments.get(perm.id);
            if (attachedTo) {
              const attached = player.battlefield.find(p => p.id === attachedTo);
              items.push({ label: `Detach from ${attached?.name || '?'}`, action: () => detachEquipment(player.playerId, bfIdx) });
            }
            for (const cr of creatures.slice(0, 6)) {
              const crIdx = player.battlefield.indexOf(cr);
              items.push({ label: `Enchant → ${cr.name}`, action: () => attachEquipment(player.playerId, bfIdx, crIdx) });
            }
          }
        }
        // Transform / Flip (DFC) — check if card has back face
        const cardData = getCard(perm.name, cardByName);
        if (cardData?.card_faces && cardData.card_faces.length > 1) {
          const currentFace = perm.transformed ? cardData.card_faces[1] : cardData.card_faces[0];
          const otherFace = perm.transformed ? cardData.card_faces[0] : cardData.card_faces[1];
          items.push({ label: `↻ Transform → ${(otherFace as any).name || 'Back'}`, divider: true, action: () => {
            pushUndo(player);
            perm.transformed = !perm.transformed;
            const face = perm.transformed ? cardData!.card_faces![1] : cardData!.card_faces![0];
            // Update perm with the new face's data
            if ((face as any).name) perm.name = (face as any).name;
            if ((face as any).image_uris?.normal) perm.imgUrl = (face as any).image_uris.normal;
            if ((face as any).power) { perm.power = (face as any).power; perm.currentPower = parseInt((face as any).power) || 0; }
            if ((face as any).toughness) { perm.toughness = (face as any).toughness; perm.currentToughness = parseInt((face as any).toughness) || 0; }
            if ((face as any).oracle_text) perm.oracleText = (face as any).oracle_text;
            if ((face as any).type_line) perm.typeLine = (face as any).type_line;
            addLog(`${currentFace ? (currentFace as any).name : perm.name} transforms → ${perm.name}`, player.playerId);
            render();
          }});
        }
        // Face-down / Morph
        if (!perm.faceDown) {
 items.push({ label: 'Turn Face Down', action: () => {
            pushUndo(player);
            perm.faceDown = true;
            perm._savedName = perm.name;
            perm._savedImg = perm.imgUrl;
            perm._savedPower = perm.currentPower;
            perm._savedToughness = perm.currentToughness;
            perm.name = 'Face-Down Creature';
            perm.imgUrl = '';
            perm.currentPower = 2;
            perm.currentToughness = 2;
            perm.isCreature = true;
            addLog('Turned a permanent face down (2/2)', player.playerId);
            render();
          }});
        } else {
 items.push({ label: 'Turn Face Up', action: () => {
            pushUndo(player);
            perm.faceDown = false;
            if (perm._savedName) perm.name = perm._savedName;
            if (perm._savedImg) perm.imgUrl = perm._savedImg;
            if (perm._savedPower !== undefined) perm.currentPower = perm._savedPower;
            if (perm._savedToughness !== undefined) perm.currentToughness = perm._savedToughness;
            addLog(`Turned ${perm.name} face up`, player.playerId);
            render();
          }});
        }
        items.push({ label: '→ Graveyard', danger: true, divider: true, action: () => moveCard(player.playerId, 'battlefield', 'graveyard', bfIdx) });
        items.push({ label: '→ Exile', danger: true, action: () => moveCard(player.playerId, 'battlefield', 'exile', bfIdx) });
        items.push({ label: '→ Hand (Bounce)', action: () => moveCard(player.playerId, 'battlefield', 'hand', bfIdx) });
        items.push({ label: '→ Top of Library', action: () => moveCard(player.playerId, 'battlefield', 'library', bfIdx) });
        items.push({ label: '→ Bottom of Library', action: () => {
          pushUndo(player);
          const removed = player.battlefield.splice(bfIdx, 1)[0];
          if (!removed.isToken) player.library.push(removed.name);
          equipmentAttachments.delete(removed.id);
          addLog(`${removed.name} → bottom of library`, player.playerId);
          render();
        }});
        items.push({ label: '→ Command Zone', action: () => {
          pushUndo(player);
          const removed = player.battlefield.splice(bfIdx, 1)[0];
          player.commandZone.push(removed.name);
          addLog(`${removed.name} → Command Zone`, player.playerId);
          render();
        }});
        showCtxMenu(e, items);
      });

      // Free-form drag-to-reposition
      let dragging = false;
      let startX = 0, startY = 0;
      card.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = false;
        startX = e.clientX;
        startY = e.clientY;

        const onMove = (me: MouseEvent) => {
          if (!dragging && (Math.abs(me.clientX - startX) > 5 || Math.abs(me.clientY - startY) > 5)) {
            dragging = true;
          }
          if (dragging) {
            card.style.left = `${me.clientX - container.getBoundingClientRect().left}px`;
            card.style.top = `${me.clientY - container.getBoundingClientRect().top}px`;
          }
        };

        const onUp = (me: MouseEvent) => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (dragging) {
            const rect = container.getBoundingClientRect();
            perm.x = Math.max(0, Math.min(95, ((me.clientX - rect.left) / rect.width) * 100));
            perm.y = Math.max(0, Math.min(95, ((me.clientY - rect.top) / rect.height) * 100));
            render();
          }
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    } else if (mpState.combat?.phase === 'declare-blockers') {
      // Non-local attacker cards: can be clicked to assign blockers
      if (isAttacker && selectedBlocker) {
        card.classList.add('mp-block-target');
        card.addEventListener('click', (e) => {
          e.stopPropagation();
          const currentDefId = mpState.combat!.defendingPlayerIds[mpState.combat!.activeDefenderIndex];
          declareBlocker(selectedBlocker!, perm.id, currentDefId);
        });
      }
    }

    // Make battlefield cards draggable to other zones
    if (isLocal && !mpState.combat) {
      card.draggable = true;
      card.addEventListener('dragstart', (ev) => {
        ev.dataTransfer?.setData('text/plain', JSON.stringify({
          zone: 'battlefield', index: bfIdx, cardName: perm.name, playerId: player.playerId,
        }));
        card.classList.add('dragging');
        ev.stopPropagation();
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    }

    container.appendChild(card);
  }

  // ─── Keyboard Shortcuts ───

  function onKeyDown(e: KeyboardEvent): void {
    // Don't trigger if in input/modal
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (zoneModalEl) {
      if (e.key === 'Escape') { hideZoneModal(); return; }
      return;
    }

    // In hotseat, keyboard controls the active player; in online, the local player
    const kbPlayerId = gameMode === 'hotseat' ? getActivePlayerId(mpState) : localPlayerId;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        nextPhase();
        break;
      case 'd':
      case 'D':
        if (isMyTurn()) { drawCard(kbPlayerId); render(); }
        break;
      case 'z':
      case 'Z':
        // Ctrl+Z / Cmd+Z → undo
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          performUndo(kbPlayerId);
        }
        break;
      case 'u':
      case 'U':
        if (isMyTurn()) untapAll(kbPlayerId);
        break;
      case 't':
      case 'T':
        showTokenCreationModal();
        break;
      case 's':
      case 'S':
        showLibrarySearchModal();
        break;
      case 'l':
      case 'L':
        showTopNModal();
        break;
      case 'g':
      case 'G': {
        // G = open graveyard view
        const gPlayer = getPlayer(kbPlayerId);
        showZoneModal(`${gPlayer.playerName}'s Graveyard`, gPlayer.graveyard, 'graveyard', kbPlayerId);
        break;
      }
      case 'x':
      case 'X': {
        // X = open exile view
        const xPlayer = getPlayer(kbPlayerId);
        showZoneModal(`${xPlayer.playerName}'s Exile`, xPlayer.exile, 'exile', kbPlayerId);
        break;
      }
      case 'r':
      case 'R':
        showScryModal();
        break;
      case 'm':
      case 'M':
        mulliganHand(kbPlayerId);
        break;
      case 'p':
      case 'P':
        if (isMyTurn()) proliferate(kbPlayerId);
        break;
      case 'c':
      case 'C':
        toggleCoach();
        break;
      case 'f':
      case 'F':
        // F = enter combat
        if (isMyTurn() && (mpState.phase === 'main1' || mpState.phase === 'combat')) enterCombat();
        break;
      case 'a':
      case 'A':
        // A = Attack all (auto-pick sole opponent, or first opponent)
        if (mpState.combat?.phase === 'declare-attackers' && isMyTurn()) {
          const opponents = mpState.playerOrder.filter(p => p !== getActivePlayerId(mpState) && !getPlayer(p).isEliminated);
          if (opponents.length > 0) attackWithAll(opponents[0]);
        }
        break;
      case 'b':
      case 'B':
        // B = Confirm blockers (when in blocker phase)
        if (mpState.combat?.phase === 'declare-blockers') confirmBlockers();
        break;
      case '1': case '2': case '3': case '4': {
        // Number keys: scroll to player zone
        const pIdx = parseInt(e.key, 10) - 1;
        if (pIdx >= 0 && pIdx < mpState.playerOrder.length) {
          const zoneEl = overlay.querySelector(`[data-player="p${pIdx + 1}"]`);
          if (zoneEl) zoneEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        break;
      }
      case 'Enter':
        // Enter = End Turn (skip to next turn directly)
        if (isMyTurn() && !mpState.winnerId) {
          e.preventDefault();
          nextTurn();
        }
        break;
      case 'n':
      case 'N':
        // N = reveal top card
        {
          const p = getPlayer(kbPlayerId);
          if (p.library.length > 0) {
            showFloatingText(`Top: ${p.library[0]}`, '#60a5fa', 3000);
            showCardZoom(p.library[0]);
            addLog(`Revealed top card: ${p.library[0]}`, kbPlayerId);
          }
        }
        break;
      case '?':
        showKeybindsHelp();
        break;
      case 'Escape': {
        // Close zoom overlay if open (appended to body, not overlay)
        const zoomOverlay = document.body.querySelector('.gf-card-zoom-overlay');
        if (zoomOverlay) { zoomOverlay.remove(); break; }
        // Close help overlay if open
        const helpOverlay = overlay.querySelector('.gf-help-overlay');
        if (helpOverlay) { helpOverlay.remove(); break; }
        // Deselect blocker/attack target if active
        if (selectedBlocker) { selectedBlocker = null; render(); break; }
        if (selectedAttackTarget) { selectedAttackTarget = null; render(); break; }
        // Confirm before exiting game
        if (confirm('Exit the game? All progress will be lost.')) cleanup();
        break;
      }
    }
  }

  // ─── Setup ───
  document.addEventListener('keydown', onKeyDown);

  // Cleanup listener on overlay removal
  const observer = new MutationObserver(() => {
    if (!document.body.contains(overlay)) {
      document.removeEventListener('keydown', onKeyDown);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  // Broadcast game start
  broadcastGoldfishStart(`Multiplayer ${decks.length}P`);

  // Initial render
  document.body.appendChild(overlay);
  render();
  addLog('Multiplayer Goldfish started!');
}
