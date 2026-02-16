/**
 * Board Renderer — Updates all game zones from GameState.
 *
 * Renders: battlefield (both players), opponent zone, hand, stack,
 * zone counts, life totals, turn/phase display, priority indicator.
 */

import type { GameState, Permanent, Card, StackObject, Phase, Step } from '@mtg/game-engine';
import {
  renderHandCard,
  renderBattlefieldCard,
  renderCardBacks,
  renderCommanderCard,
  renderVisibleOpponentCard,
} from './card-renderer.ts';

// Cache DOM elements
let _els: Record<string, HTMLElement | null> = {};
function el(id: string): HTMLElement | null {
  if (!(id in _els)) _els[id] = document.getElementById(id);
  return _els[id];
}

/** Clear DOM element cache (call on remount) */
export function clearDomCache(): void {
  _els = {};
}

/** Render the full board from game state */
export function renderBoard(
  state: GameState,
  humanPlayer: 0 | 1,
  callbacks: BoardCallbacks,
): void {
  const botPlayer = (humanPlayer === 0 ? 1 : 0) as 0 | 1;
  const me = state.players[humanPlayer];
  const opp = state.players[botPlayer];

  // Turn / Phase
  const turnEl = el('turn-display');
  if (turnEl) turnEl.textContent = `Turn ${state.turn}`;
  const phaseEl = el('phase-display');
  if (phaseEl) phaseEl.textContent = formatPhase(state.phase, state.step);

  // Life totals
  const yourLife = el('your-life');
  if (yourLife) yourLife.textContent = String(me.life);
  const botLife = el('bot-life');
  if (botLife) botLife.textContent = String(opp.life);
  const oppDetail = el('opp-life-detail');
  if (oppDetail) oppDetail.textContent = `Life: ${opp.life} | Poison: ${opp.poisonCounters}`;

  // Priority
  const prioEl = el('priority-display');
  if (prioEl) {
    const isYours = state.priorityPlayer === humanPlayer;
    prioEl.textContent = isYours ? 'Your Priority' : "Bot's Priority";
    prioEl.className = `pvb-priority ${isYours ? 'yours' : 'theirs'}`;
  }

  // Opponent hand — perfect information: show actual cards
  const oppHand = el('opp-hand-display');
  if (oppHand) {
    oppHand.innerHTML = '';
    for (const card of opp.hand) {
      const cardEl = renderVisibleOpponentCard(card);
      oppHand.appendChild(cardEl);
    }
  }

  // Opponent commander
  const oppCmd = el('opp-commander');
  if (oppCmd && opp.commandZone.length > 0) {
    oppCmd.innerHTML = '';
    const cmdEl = renderCommanderCard(opp.commandZone[0]);
    oppCmd.appendChild(cmdEl);
  }

  // Battlefield — Bot
  renderBattlefieldZone('bf-bot', opp.battlefield, botPlayer, callbacks);

  // Battlefield — Player
  renderBattlefieldZone('bf-you', me.battlefield, humanPlayer, callbacks);

  // Player commander
  const yourCmd = el('your-commander');
  if (yourCmd) {
    yourCmd.innerHTML = '';
    if (me.commandZone.length > 0) {
      const cmdCard = me.commandZone[0];
      const cmdImg = document.createElement('img');
      cmdImg.src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(cmdCard.name)}&format=image&version=normal`;
      cmdImg.alt = cmdCard.name;
      cmdImg.loading = 'lazy';
      yourCmd.appendChild(cmdImg);
    }
  }

  // Player hand
  renderPlayerHand(me.hand, callbacks);

  // Stack
  renderStack(state.stack, humanPlayer);

  // Zone counts
  setCount('your-library-count', me.library.length);
  setCount('your-gy-count', me.graveyard.length);
  setCount('your-exile-count', me.exile.length);
  setCount('bot-library-count', opp.library.length);
  setCount('bot-gy-count', opp.graveyard.length);
  setCount('bot-exile-count', opp.exile.length);

  // Undo button
  const undoBtn = el('btn-undo') as HTMLButtonElement | null;
  if (undoBtn) undoBtn.disabled = !callbacks.canUndo?.();
}

/** Callbacks from board clicks */
export interface BoardCallbacks {
  onHandCardClick?: (card: Card, index: number) => void;
  onBattlefieldCardClick?: (perm: Permanent, controller: 0 | 1) => void;
  canUndo?: () => boolean;
  selectedHandCardId?: string | null;
  targetingMode?: boolean;
  legalTargetIds?: string[];
  attackerIds?: string[];
  blockerAssignment?: Map<string, string>;
  pendingBlockerId?: string | null;
}

/** Render battlefield zone for one player */
function renderBattlefieldZone(
  containerId: string,
  permanents: Permanent[],
  controller: 0 | 1,
  callbacks: BoardCallbacks,
): void {
  const container = el(containerId);
  if (!container) return;

  // Keep the label
  const label = container.querySelector('.pvb-bf-label');
  container.innerHTML = '';
  if (label) container.appendChild(label);

  const legalTargets = callbacks.legalTargetIds ?? [];
  const attackerIds = callbacks.attackerIds ?? [];
  const blockerMap = callbacks.blockerAssignment ?? new Map();

  for (const perm of permanents) {
    const cardEl = renderBattlefieldCard(perm, () => {
      callbacks.onBattlefieldCardClick?.(perm, controller);
    });

    // Targeting highlights
    if (callbacks.targetingMode && legalTargets.includes(perm.id)) {
      cardEl.classList.add('legal-target');
    }

    // Attacker highlights
    if (attackerIds.includes(perm.id)) {
      cardEl.classList.add('attacking');
    }

    // Blocker highlights
    if (blockerMap.has(perm.id)) {
      cardEl.classList.add('blocking');
    }

    // Pending blocker selection
    if (callbacks.pendingBlockerId === perm.id) {
      cardEl.classList.add('selected');
    }

    container.appendChild(cardEl);
  }
}

/** Render player's hand */
function renderPlayerHand(
  hand: Card[],
  callbacks: BoardCallbacks,
): void {
  const container = el('player-hand');
  if (!container) return;
  container.innerHTML = '';

  console.log(`[DEBUG] Rendering ${hand.length} cards in hand`);

  hand.forEach((card, i) => {
    const cardEl = renderHandCard(card, () => {
      console.log(`[DEBUG] Hand card clicked:`, card.name, 'index:', i);
      callbacks.onHandCardClick?.(card, i);
    });

    // Highlight selected card in hand (targeting mode)
    if (callbacks.selectedHandCardId === card.id) {
      cardEl.classList.add('selected');
    }

    container.appendChild(cardEl);
  });
}

/** Render the stack */
function renderStack(stack: StackObject[], humanPlayer: 0 | 1): void {
  const container = el('stack-display');
  const countEl = el('stack-count');
  if (!container) return;
  if (countEl) countEl.textContent = String(stack.length);

  container.innerHTML = '';
  if (stack.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pvb-stack-empty';
    empty.textContent = 'Stack is empty';
    container.appendChild(empty);
    return;
  }

  // Show stack top-to-bottom (LIFO)
  for (let i = stack.length - 1; i >= 0; i--) {
    const item = stack[i];
    const row = document.createElement('div');
    row.className = 'pvb-stack-item';

    const nameDiv = document.createElement('div');
    const nameSpan = document.createElement('div');
    nameSpan.className = 'pvb-stack-name';
    nameSpan.textContent = item.card?.name ?? item.text;
    nameDiv.appendChild(nameSpan);

    const controllerSpan = document.createElement('div');
    controllerSpan.className = 'pvb-stack-controller';
    controllerSpan.textContent = item.controller === humanPlayer ? 'You' : 'Bot';
    nameDiv.appendChild(controllerSpan);

    row.appendChild(nameDiv);
    container.appendChild(row);
  }
}

/** Update a zone count element */
function setCount(id: string, count: number): void {
  const e = el(id);
  if (e) e.textContent = String(count);
}

/** Format phase + step for display */
function formatPhase(phase: Phase, step: Step): string {
  switch (phase) {
    case 'beginning':
      if (step === 'untap') return 'Untap';
      if (step === 'upkeep') return 'Upkeep';
      if (step === 'draw') return 'Draw';
      return 'Beginning';
    case 'precombat-main': return 'Main 1';
    case 'combat':
      if (step === 'begin-combat') return 'Begin Combat';
      if (step === 'declare-attackers') return 'Declare Attackers';
      if (step === 'declare-blockers') return 'Declare Blockers';
      if (step === 'first-strike-damage') return 'First Strike';
      if (step === 'combat-damage') return 'Combat Damage';
      if (step === 'end-combat') return 'End Combat';
      return 'Combat';
    case 'postcombat-main': return 'Main 2';
    case 'ending':
      if (step === 'end') return 'End Step';
      if (step === 'cleanup') return 'Cleanup';
      return 'Ending';
    default: return String(phase);
  }
}
