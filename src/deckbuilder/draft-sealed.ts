// ============================================================
// Draft/Sealed — Client-side draft lobby and sealed builder
// ============================================================
// Draft lobby UI, pack opening, pick timer, sealed pool
// builder. Creates deck repo from finished pool.
// ============================================================

import { h } from '../shared/dom.js';

// ==================== Types ====================

export interface DraftConfig {
  format: 'draft' | 'sealed';
  packSize: number;
  packCount: number;
  pickTimeSeconds: number;
  playerCount: number;
}

export interface DraftCard {
  name: string;
  set: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'mythic';
  imageUrl?: string;
}

export interface DraftPlayer {
  userId: string;
  displayName: string;
  seatNumber: number;
  isHost: boolean;
  isReady: boolean;
  picksMade: number;
}

export type DraftPhase = 'lobby' | 'drafting' | 'building' | 'complete';

export interface DraftCallbacks {
  onPick: (cardName: string) => void;
  onBuild: (mainboard: string[], sideboard: string[]) => void;
  onLeave: () => void;
}

// ==================== State ====================

interface DraftState {
  sessionId: string | null;
  phase: DraftPhase;
  config: DraftConfig;
  players: DraftPlayer[];
  currentPack: DraftCard[];
  pool: DraftCard[];
  mainboard: DraftCard[];
  sideboard: DraftCard[];
  currentRound: number;
  pickTimer: number;
  timerInterval: ReturnType<typeof setInterval> | null;
}

let state: DraftState = {
  sessionId: null,
  phase: 'lobby',
  config: {
    format: 'draft',
    packSize: 15,
    packCount: 3,
    pickTimeSeconds: 60,
    playerCount: 8,
  },
  players: [],
  currentPack: [],
  pool: [],
  mainboard: [],
  sideboard: [],
  currentRound: 0,
  pickTimer: 0,
  timerInterval: null,
};

let containerEl: HTMLElement | null = null;
let callbacks: DraftCallbacks | null = null;

// ==================== API ====================

const API_BASE = typeof window !== 'undefined'
  ? (window.location.hostname === 'localhost' ? 'http://localhost:8787' : 'https://decklens-api.chrisgarkisch.workers.dev')
  : '';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

// ==================== Init ====================

/**
 * Open draft/sealed lobby.
 */
export function openDraftLobby(
  container: HTMLElement,
  cbs: DraftCallbacks,
  config?: Partial<DraftConfig>
): void {
  containerEl = container;
  callbacks = cbs;
  state = {
    ...state,
    phase: 'lobby',
    config: { ...state.config, ...config },
    players: [],
    pool: [],
    mainboard: [],
    sideboard: [],
    currentPack: [],
  };
  render();
}

/**
 * Create a new session (host).
 */
export async function createSession(): Promise<string> {
  const result = await apiFetch<{ id: string }>('/api/draft/sessions', {
    method: 'POST',
    body: JSON.stringify({
      format: state.config.format,
      settings: state.config,
    }),
  });
  state.sessionId = result.id;
  return result.id;
}

/**
 * Join an existing session.
 */
export async function joinSession(sessionId: string): Promise<void> {
  await apiFetch(`/api/draft/sessions/${sessionId}/join`, { method: 'POST' });
  state.sessionId = sessionId;
}

/**
 * Start the session.
 */
export async function startSession(): Promise<void> {
  if (!state.sessionId) return;
  await apiFetch(`/api/draft/sessions/${state.sessionId}/start`, { method: 'POST' });
  state.phase = 'drafting';
  startPickTimer();
  render();
}

// ==================== Draft Logic ====================

/**
 * Make a pick from the current pack.
 */
export function makePick(cardIndex: number): void {
  if (state.phase !== 'drafting' || cardIndex >= state.currentPack.length) return;

  const picked = state.currentPack[cardIndex];
  state.pool.push(picked);
  state.currentPack.splice(cardIndex, 1);

  callbacks?.onPick(picked.name);

  // Check if pack is empty → next pack / next round
  if (state.currentPack.length === 0) {
    state.currentRound++;
    if (state.currentRound >= state.config.packCount) {
      state.phase = 'building';
      stopPickTimer();
    }
  }

  resetPickTimer();
  render();
}

/**
 * Move card from pool to mainboard during building phase.
 */
export function moveToMainboard(index: number): void {
  if (state.phase !== 'building') return;
  const card = state.pool.splice(index, 1)[0];
  if (card) {
    state.mainboard.push(card);
    render();
  }
}

/**
 * Move card from pool to sideboard during building phase.
 */
export function moveToSideboard(index: number): void {
  if (state.phase !== 'building') return;
  const card = state.pool.splice(index, 1)[0];
  if (card) {
    state.sideboard.push(card);
    render();
  }
}

/**
 * Move card back to pool.
 */
export function moveToPool(source: 'mainboard' | 'sideboard', index: number): void {
  const arr = source === 'mainboard' ? state.mainboard : state.sideboard;
  const card = arr.splice(index, 1)[0];
  if (card) {
    state.pool.push(card);
    render();
  }
}

/**
 * Finalize deck build.
 */
export function finalizeBuild(): void {
  callbacks?.onBuild(
    state.mainboard.map(c => c.name),
    state.sideboard.map(c => c.name)
  );
  state.phase = 'complete';
  render();
}

// ==================== Timer ====================

function startPickTimer(): void {
  state.pickTimer = state.config.pickTimeSeconds;
  state.timerInterval = setInterval(() => {
    state.pickTimer--;
    if (state.pickTimer <= 0) {
      // Auto-pick first card
      if (state.currentPack.length > 0) {
        makePick(0);
      }
    }
    render();
  }, 1000);
}

function resetPickTimer(): void {
  state.pickTimer = state.config.pickTimeSeconds;
}

function stopPickTimer(): void {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

// ==================== Render ====================

function render(): void {
  if (!containerEl) return;
  containerEl.innerHTML = '';

  switch (state.phase) {
    case 'lobby': renderLobby(); break;
    case 'drafting': renderDrafting(); break;
    case 'building': renderBuilding(); break;
    case 'complete': renderComplete(); break;
  }
}

function renderLobby(): void {
  if (!containerEl) return;

  containerEl.appendChild(h('div', { className: 'draft__lobby' },
    h('h2', {}, `${state.config.format === 'draft' ? 'Draft' : 'Sealed'} Lobby`),

    h('div', { className: 'draft__config' },
      h('div', { className: 'draft__config-row' },
        h('label', {}, 'Format'),
        makeFormatToggle(),
      ),
      h('div', { className: 'draft__config-row' },
        h('label', {}, `Pack Size: ${state.config.packSize}`),
      ),
      h('div', { className: 'draft__config-row' },
        h('label', {}, `Packs: ${state.config.packCount}`),
      ),
      h('div', { className: 'draft__config-row' },
        h('label', {}, `Pick Timer: ${state.config.pickTimeSeconds}s`),
      ),
      h('div', { className: 'draft__config-row' },
        h('label', {}, `Players: ${state.players.length}/${state.config.playerCount}`),
      ),
    ),

    h('div', { className: 'draft__players' },
      ...state.players.map(p =>
        h('div', { className: 'draft__player' },
          h('span', {}, `Seat ${p.seatNumber + 1}: ${p.displayName}`),
          p.isHost ? h('span', { className: 'draft__host-badge' }, 'Host') : null,
 p.isReady ? h('span', { className: 'draft__ready-badge' }, ' Ready') : null,
        )
      ),
    ),

    h('div', { className: 'draft__lobby-actions' },
      h('button', {
        className: 'draft__create-btn',
        onClick: async () => {
          await createSession();
          render();
        },
      }, 'Create Session'),
      h('button', {
        className: 'draft__start-btn',
        onClick: () => startSession(),
      }, 'Start'),
      h('button', {
        className: 'draft__leave-btn',
        onClick: () => callbacks?.onLeave(),
      }, 'Leave'),
    ),
  ));
}

function renderDrafting(): void {
  if (!containerEl) return;

  containerEl.appendChild(h('div', { className: 'draft__drafting' },
    h('div', { className: 'draft__header' },
      h('h3', {}, `Round ${state.currentRound + 1}/${state.config.packCount}`),
      h('div', { className: `draft__timer ${state.pickTimer <= 10 ? 'draft__timer--urgent' : ''}` },
        `${state.pickTimer}s`),
      h('span', {}, `Pool: ${state.pool.length} cards`),
    ),

    h('div', { className: 'draft__pack' },
      h('h4', {}, `Pick a card (${state.currentPack.length} remaining)`),
      h('div', { className: 'draft__pack-grid' },
        ...state.currentPack.map((card, i) =>
          h('div', {
            className: `draft__card draft__card--${card.rarity}`,
            onClick: () => makePick(i),
          },
            h('span', { className: 'draft__card-name' }, card.name),
            h('span', { className: 'draft__card-rarity' }, card.rarity),
          )
        ),
      ),
    ),

    h('div', { className: 'draft__pool-preview' },
      h('h4', {}, `Your Pool (${state.pool.length})`),
      h('div', { className: 'draft__pool-cards' },
        ...state.pool.map(card =>
          h('span', { className: 'draft__pool-chip' }, card.name)
        ),
      ),
    ),
  ));
}

function renderBuilding(): void {
  if (!containerEl) return;

  containerEl.appendChild(h('div', { className: 'draft__building' },
    h('h2', {}, 'Build Your Deck'),
    h('p', {}, `Build a deck from your ${state.pool.length + state.mainboard.length + state.sideboard.length} card pool`),

    h('div', { className: 'draft__build-zones' },
      // Pool
      h('div', { className: 'draft__zone draft__zone--pool' },
        h('h3', {}, `Pool (${state.pool.length})`),
        h('div', { className: 'draft__zone-cards' },
          ...state.pool.map((card, i) =>
            h('div', { className: 'draft__build-card' },
              h('span', {}, card.name),
              h('button', { onClick: () => moveToMainboard(i) }, 'Main'),
              h('button', { onClick: () => moveToSideboard(i) }, 'Side'),
            )
          ),
        ),
      ),

      // Mainboard
      h('div', { className: 'draft__zone draft__zone--main' },
        h('h3', {}, `Mainboard (${state.mainboard.length})`),
        h('div', { className: 'draft__zone-cards' },
          ...state.mainboard.map((card, i) =>
            h('div', { className: 'draft__build-card' },
              h('span', {}, card.name),
              h('button', { onClick: () => moveToPool('mainboard', i) }, '↩'),
            )
          ),
        ),
      ),

      // Sideboard
      h('div', { className: 'draft__zone draft__zone--side' },
        h('h3', {}, `Sideboard (${state.sideboard.length})`),
        h('div', { className: 'draft__zone-cards' },
          ...state.sideboard.map((card, i) =>
            h('div', { className: 'draft__build-card' },
              h('span', {}, card.name),
              h('button', { onClick: () => moveToPool('sideboard', i) }, '↩'),
            )
          ),
        ),
      ),
    ),

    h('button', {
      className: 'draft__finalize-btn',
      onClick: finalizeBuild,
 }, ' Finalize Deck'),
  ));
}

function renderComplete(): void {
  if (!containerEl) return;

  containerEl.appendChild(h('div', { className: 'draft__complete' },
    h('h2', {}, 'Deck Complete!'),
    h('p', {}, `Mainboard: ${state.mainboard.length} cards, Sideboard: ${state.sideboard.length} cards`),
    h('button', {
      className: 'draft__done-btn',
      onClick: () => callbacks?.onLeave(),
    }, 'Done'),
  ));
}

function makeFormatToggle(): HTMLElement {
  return h('div', { className: 'draft__format-toggle' },
    h('button', {
      className: `draft__format-btn ${state.config.format === 'draft' ? 'draft__format-btn--active' : ''}`,
      onClick: () => { state.config.format = 'draft'; render(); },
    }, 'Draft'),
    h('button', {
      className: `draft__format-btn ${state.config.format === 'sealed' ? 'draft__format-btn--active' : ''}`,
      onClick: () => { state.config.format = 'sealed'; render(); },
    }, 'Sealed'),
  );
}

// ==================== Exports ====================

export function getDraftState(): DraftState {
  return { ...state };
}

export function cleanup(): void {
  stopPickTimer();
  containerEl = null;
  callbacks = null;
}
