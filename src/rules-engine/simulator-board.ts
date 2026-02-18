/**
 * Simulator Board Renderer — Renders the full game board for the Rules Engine.
 *
 * Uses Scryfall images for cards, shows all zones, stack, and game state.
 * Adapted from play-vs-bot board-renderer with enhanced features:
 * - Mana ability indicators on lands
 * - Counter/damage badges
 * - Stack items with click interaction
 * - Zone count click handlers
 */

import type { GameState, Permanent, Card, StackObject } from '@mtg/game-engine';
import { isCreature } from '@mtg/game-engine';

// ─── Types ───

export interface SimBoardCallbacks {
  onHandCardClick?: (card: Card, index: number) => void;
  onBattlefieldCardClick?: (perm: Permanent, controller: 0 | 1) => void;
  onPlayerClick?: (playerIdx: 0 | 1) => void;
  canUndo?: () => boolean;
  selectedHandCardId?: string | null;
  targetingMode?: boolean;
  legalTargetIds?: string[];
  attackerIds?: string[];
  blockerAssignment?: Map<string, string>;
  pendingBlockerId?: string | null;
  viewPlayer: 0 | 1;
  playerNames: string[];
}

// ─── DOM Cache ───

let _els: Record<string, HTMLElement | null> = {};
function el(id: string): HTMLElement | null {
  if (!(id in _els)) _els[id] = document.getElementById(id);
  return _els[id];
}
export function clearDomCache(): void {
  _els = {};
  _bfCache.clear();
  _handCache = '';
  _urlCache.clear();
}

// ─── Scryfall Image (with URL cache for performance) ───

const SCRYFALL_IMG = 'https://api.scryfall.com/cards/named';
const _urlCache = new Map<string, string>();
function getCardImageUrl(cardName: string, version: 'normal' | 'small' = 'normal'): string {
  const key = `${cardName}|${version}`;
  let url = _urlCache.get(key);
  if (!url) {
    url = `${SCRYFALL_IMG}?exact=${encodeURIComponent(cardName)}&format=image&version=${version}`;
    _urlCache.set(key, url);
  }
  return url;
}

// ─── Card Preview ───

let previewTimeout: ReturnType<typeof setTimeout> | null = null;
function addHoverPreview(element: HTMLElement, cardName: string): void {
  element.addEventListener('mouseenter', (e) => {
    previewTimeout = setTimeout(() => { // 200ms delay per Phase 4.5
      const preview = el('card-preview');
      const img = document.getElementById('card-preview-img') as HTMLImageElement;
      if (!preview || !img) return;

      img.src = getCardImageUrl(cardName, 'normal');
      preview.style.display = 'block';

      // Position near mouse
      const rect = element.getBoundingClientRect();
      let left = rect.right + 12;
      let top = rect.top;

      // Clamp to viewport
      if (left + 260 > window.innerWidth) left = rect.left - 262;
      if (top + 370 > window.innerHeight) top = window.innerHeight - 370;
      if (top < 0) top = 0;

      preview.style.left = `${left}px`;
      preview.style.top = `${top}px`;
    }, 200);
  });

  element.addEventListener('mouseleave', () => {
    if (previewTimeout) clearTimeout(previewTimeout);
    const preview = el('card-preview');
    if (preview) preview.style.display = 'none';
  });
}

// ─── Main Render ───

export function renderBoard(
  state: GameState,
  viewPlayer: 0 | 1,
  callbacks: SimBoardCallbacks,
): void {
  const oppPlayer = (viewPlayer === 0 ? 1 : 0) as 0 | 1;
  const me = state.players[viewPlayer];
  const opp = state.players[oppPlayer];

  // Turn
  const turnEl = el('turn-display');
  if (turnEl) turnEl.textContent = `Turn ${state.turn}`;

  // Life totals
  const lifeYou = el('life-you-val');
  if (lifeYou) lifeYou.textContent = String(me.life);
  const lifeOpp = el('life-opp-val');
  if (lifeOpp) lifeOpp.textContent = String(opp.life);

  // Life labels
  const lifeYouBox = el('life-you');
  const lifeOppBox = el('life-opp');
  if (lifeYouBox) {
    const label = lifeYouBox.querySelector('.re-life-label');
    if (label) label.textContent = callbacks.playerNames[viewPlayer] || 'You';
    // Make clickable for targeting
    lifeYouBox.style.cursor = callbacks.targetingMode ? 'pointer' : '';
    lifeYouBox.onclick = callbacks.targetingMode ? () => callbacks.onPlayerClick?.(viewPlayer) : null;
  }
  if (lifeOppBox) {
    const label = lifeOppBox.querySelector('.re-life-label');
    if (label) label.textContent = callbacks.playerNames[oppPlayer] || 'Opp';
    lifeOppBox.style.cursor = callbacks.targetingMode ? 'pointer' : '';
    lifeOppBox.onclick = callbacks.targetingMode ? () => callbacks.onPlayerClick?.(oppPlayer) : null;
  }

  // Priority
  const prioEl = el('priority-display');
  if (prioEl) {
    const isYours = state.priorityPlayer === viewPlayer;
    prioEl.textContent = isYours
      ? `${callbacks.playerNames[viewPlayer]}'s Priority`
      : `${callbacks.playerNames[oppPlayer]}'s Priority`;
    prioEl.className = `re-priority ${isYours ? 'yours' : 'theirs'}`;
  }

  // Battlefield — Opponent
  renderBattlefieldZone('bf-opp', opp.battlefield, oppPlayer, callbacks);

  // Battlefield — You
  renderBattlefieldZone('bf-you', me.battlefield, viewPlayer, callbacks);

  // Hand
  renderPlayerHand(me.hand, viewPlayer, callbacks);

  // Commander zone
  renderCommanderZone(me.commandZone, viewPlayer);

  // Stack
  renderStack(state.stack, viewPlayer, callbacks);

  // Zone counts
  setCount('your-library-count', me.library.length);
  setCount('your-gy-count', me.graveyard.length);
  setCount('your-exile-count', me.exile.length);
  setCount('opp-library-count', opp.library.length);
  setCount('opp-gy-count', opp.graveyard.length);
  setCount('opp-exile-count', opp.exile.length);

  // Game log — auto-render from state log (last 50 entries)
  renderLogFromState(state);
}

// ─── Battlefield (with diff-based rendering) ───

/** Fingerprint a permanent for change detection */
function permFingerprint(p: Permanent, targeting: boolean, legalTargets: string[], attackerIds: string[], blockerMap: Map<string, string>, pendingBlocker?: string | null): string {
  return `${p.id}|${p.tapped ? 1 : 0}|${p.damage}|${p.currentPower ?? ''}|${p.currentToughness ?? ''}|${JSON.stringify(p.counters)}|${p.summoningSick ? 1 : 0}|${targeting ? (legalTargets.includes(p.id) ? 'L' : 'I') : ''}|${attackerIds.includes(p.id) ? 'A' : ''}|${blockerMap.has(p.id) ? 'B' : ''}|${pendingBlocker === p.id ? 'S' : ''}`;
}

const _bfCache = new Map<string, { fingerprints: string; permIds: string }>();

function renderBattlefieldZone(
  containerId: string,
  permanents: Permanent[],
  controller: 0 | 1,
  callbacks: SimBoardCallbacks,
): void {
  const container = el(containerId);
  if (!container) return;

  const legalTargets = callbacks.legalTargetIds ?? [];
  const attackerIds = callbacks.attackerIds ?? [];
  const blockerMap = callbacks.blockerAssignment ?? new Map();

  // Separate lands and non-lands for organized display
  const lands = permanents.filter(p => p.typeLine.toLowerCase().includes('land'));
  const nonlands = permanents.filter(p => !p.typeLine.toLowerCase().includes('land'));
  const ordered = [...nonlands, ...lands];

  // Build fingerprint for this render
  const fingerprints = ordered.map(p =>
    permFingerprint(p, !!callbacks.targetingMode, legalTargets, attackerIds, blockerMap, callbacks.pendingBlockerId)
  ).join('|');
  const permIds = ordered.map(p => p.id).join(',');

  // Check cache — skip full re-render if nothing changed
  const cached = _bfCache.get(containerId);
  if (cached && cached.fingerprints === fingerprints && cached.permIds === permIds) {
    return; // No changes — skip rendering entirely
  }
  _bfCache.set(containerId, { fingerprints, permIds });

  // Full re-render (changed state)
  const label = container.querySelector('.re-bf-label');
  container.innerHTML = '';
  if (label) container.appendChild(label);

  for (const perm of ordered) {
    const cardEl = createBattlefieldCard(perm, () => {
      callbacks.onBattlefieldCardClick?.(perm, controller);
    });

    if (callbacks.targetingMode) {
      if (legalTargets.includes(perm.id)) {
        cardEl.classList.add('legal-target');
      } else {
        cardEl.classList.add('illegal-target');
      }
    }
    if (attackerIds.includes(perm.id)) cardEl.classList.add('attacking');
    if (blockerMap.has(perm.id)) cardEl.classList.add('blocking');
    if (callbacks.pendingBlockerId === perm.id) cardEl.classList.add('selected');

    container.appendChild(cardEl);
  }
}

function createBattlefieldCard(perm: Permanent, onClick?: () => void): HTMLElement {
  const div = document.createElement('div');
  div.className = 're-card';
  if (perm.tapped) div.classList.add('tapped');
  if (isCreature(perm) && perm.summoningSick) div.classList.add('summoning-sick');
  div.dataset.permanentId = perm.id;
  div.dataset.cardName = perm.name;

  const img = document.createElement('img');
  img.src = getCardImageUrl(perm.name, 'normal');
  img.alt = perm.name;
  img.loading = 'lazy';
  img.onerror = () => {
    img.remove();
    const fallback = document.createElement('div');
    fallback.className = 're-card-name-fallback';
    fallback.textContent = perm.name;
    div.appendChild(fallback);
  };
  div.appendChild(img);

  // P/T badge
  if (isCreature(perm)) {
    const pt = document.createElement('span');
    pt.className = 'pt-badge';
    const p = perm.currentPower ?? parseInt(perm.power || '0');
    const t = perm.currentToughness ?? parseInt(perm.toughness || '0');
    pt.textContent = `${p}/${t}`;
    div.appendChild(pt);
  }

  // Damage badge
  if (perm.damage > 0) {
    const dmg = document.createElement('span');
    dmg.className = 'damage-badge';
    dmg.textContent = String(perm.damage);
    div.appendChild(dmg);
  }

  // Counter badge
  const totalCounters = Object.values(perm.counters).reduce((s, v) => s + v, 0);
  if (totalCounters > 0) {
    const ctr = document.createElement('span');
    ctr.className = 'counter-badge';
    const entries = Object.entries(perm.counters).filter(([, v]) => v > 0);
    ctr.textContent = entries.map(([name, val]) => `${val} ${name}`).join(', ');
    ctr.title = entries.map(([name, val]) => `${val} ${name} counter(s)`).join('\n');
    div.appendChild(ctr);
  }

  // Loyalty badge for planeswalkers
  if (perm.currentLoyalty !== undefined) {
    const loy = document.createElement('span');
    loy.className = 'pt-badge';
    loy.style.background = 'rgba(100, 100, 100, 0.9)';
    loy.textContent = String(perm.currentLoyalty);
    div.appendChild(loy);
  }

  if (onClick) div.addEventListener('click', onClick);
  addHoverPreview(div, perm.name);

  return div;
}

// ─── Hand (with change detection) ───

let _handCache = '';

function renderPlayerHand(
  hand: Card[],
  viewPlayer: 0 | 1,
  callbacks: SimBoardCallbacks,
): void {
  const container = el('player-hand');
  if (!container) return;

  // Skip re-render if hand hasn't changed
  const handKey = hand.map(c => c.id).join(',') + '|' + (callbacks.selectedHandCardId ?? '');
  if (handKey === _handCache) return;
  _handCache = handKey;

  container.innerHTML = '';

  hand.forEach((card, i) => {
    const div = document.createElement('div');
    div.className = 're-card';
    div.dataset.cardId = card.id;
    div.dataset.cardName = card.name;

    if (callbacks.selectedHandCardId === card.id) div.classList.add('selected');

    const img = document.createElement('img');
    img.src = getCardImageUrl(card.name, 'normal');
    img.alt = card.name;
    img.loading = 'lazy';
    img.onerror = () => {
      img.remove();
      const fallback = document.createElement('div');
      fallback.className = 're-card-name-fallback';
      fallback.textContent = card.name;
      div.appendChild(fallback);
    };
    div.appendChild(img);

    div.addEventListener('click', () => callbacks.onHandCardClick?.(card, i));
    addHoverPreview(div, card.name);

    container.appendChild(div);
  });
}

// ─── Commander Zone ───

function renderCommanderZone(commandZone: Card[], viewPlayer: 0 | 1): void {
  const container = el('commander-zone');
  if (!container) return;
  container.innerHTML = '';

  for (const card of commandZone) {
    const div = document.createElement('div');
    div.className = 're-card';
    div.style.borderColor = 'var(--gold)';

    const img = document.createElement('img');
    img.src = getCardImageUrl(card.name, 'small');
    img.alt = card.name;
    img.loading = 'lazy';
    div.appendChild(img);

    addHoverPreview(div, card.name);
    container.appendChild(div);
  }
}

// ─── Stack ───

function renderStack(
  stack: StackObject[],
  viewPlayer: 0 | 1,
  callbacks: SimBoardCallbacks,
): void {
  const container = el('stack-display');
  if (!container) return;
  container.innerHTML = '';

  if (stack.length === 0) {
    container.innerHTML = '<span class="re-stack-empty">Empty</span>';
    return;
  }

  // Render top-to-bottom (LIFO order)
  for (let i = stack.length - 1; i >= 0; i--) {
    const item = stack[i];
    const div = document.createElement('div');
    div.className = 're-stack-item entering';

    // Distinguish triggered abilities from spells
    const isTrigger = item.type === 'ability' && item.id?.startsWith('trigger_');
    if (isTrigger) {
      div.classList.add('triggered');
    } else if (item.type === 'ability') {
      div.classList.add('activated');
    }

    // Type badge
    const badge = document.createElement('span');
    badge.className = 'stack-type-badge';
    if (isTrigger) {
      badge.textContent = '⚡ Trigger';
      badge.style.color = '#f59e0b'; // amber
    } else if (item.type === 'ability') {
      badge.textContent = '🔮 Ability';
      badge.style.color = '#a78bfa'; // purple
    } else {
      badge.textContent = '📜 Spell';
      badge.style.color = '#60a5fa'; // blue
    }
    div.appendChild(badge);

    const text = document.createElement('div');
    text.textContent = item.text;
    text.style.marginTop = '2px';
    div.appendChild(text);

    const controller = document.createElement('div');
    controller.className = 'stack-controller';
    controller.textContent = `Controller: ${callbacks.playerNames[item.controller]}`;
    div.appendChild(controller);

    if (item.card) addHoverPreview(div, item.card.name);
    container.appendChild(div);
  }
}

// ─── Zone Counts ───

function setCount(id: string, count: number): void {
  const span = el(id);
  if (span) span.textContent = String(count);
}

// ─── Game Log ───

let lastRenderedLogLength = 0;

function renderLogFromState(state: GameState): void {
  const logEl = el('game-log');
  if (!logEl) return;

  // Only render new entries
  const entries = state.log;
  if (entries.length <= lastRenderedLogLength) return;

  for (let i = lastRenderedLogLength; i < entries.length; i++) {
    const entry = entries[i];
    const div = document.createElement('div');
    div.className = 're-log-entry';

    if (entry.actionType === 'effect') div.classList.add('effect');
    if (entry.message.includes('damage') || entry.message.includes('attack') || entry.message.includes('block')) {
      div.classList.add('combat');
    }

    const turnTag = `<span class="log-turn">T${entry.turn}</span> `;
    div.innerHTML = turnTag + entry.message;
    logEl.appendChild(div);
  }

  lastRenderedLogLength = entries.length;
  logEl.scrollTop = logEl.scrollHeight;
}
