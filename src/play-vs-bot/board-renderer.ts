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

  // Monarch crown display
  const yourName = el('your-name');
  const botName = el('bot-name');
  if (yourName) {
    const existingCrown = yourName.querySelector('.monarch-crown');
    if (existingCrown) existingCrown.remove();
    if ((state as any).monarch === humanPlayer) {
      const crown = document.createElement('span');
      crown.className = 'monarch-crown';
      crown.textContent = ' \u{1F451}';
      crown.title = 'Monarch — draws an extra card at end step';
      yourName.appendChild(crown);
    }
  }
  if (botName) {
    const existingCrown = botName.querySelector('.monarch-crown');
    if (existingCrown) existingCrown.remove();
    if ((state as any).monarch === botPlayer) {
      const crown = document.createElement('span');
      crown.className = 'monarch-crown';
      crown.textContent = ' \u{1F451}';
      crown.title = 'Monarch — draws an extra card at end step';
      botName.appendChild(crown);
    }
  }

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

  // Make exile zone links clickable
  setupExileClick('your-exile-count', humanPlayer, callbacks);
  setupExileClick('bot-exile-count', botPlayer, callbacks);

  // Make graveyard zone links clickable
  setupGraveyardClick('your-gy-count', humanPlayer, callbacks);
  setupGraveyardClick('bot-gy-count', botPlayer, callbacks);

  // Commander damage display
  const yourCmdr = el('your-cmdr-dmg');
  const botCmdr = el('bot-cmdr-dmg');
  if (yourCmdr) {
    const totalDmg = Object.values(me.commanderDamage || {}).reduce((a, b) => a + b, 0);
    yourCmdr.textContent = `Cmdr: ${totalDmg}/21`;
    yourCmdr.className = `pvb-cmdr-dmg${totalDmg >= 15 ? ' danger' : ''}`;
  }
  if (botCmdr) {
    const totalDmg = Object.values(opp.commanderDamage || {}).reduce((a, b) => a + b, 0);
    botCmdr.textContent = `Cmdr: ${totalDmg}/21`;
    botCmdr.className = `pvb-cmdr-dmg${totalDmg >= 15 ? ' danger' : ''}`;
  }

  // Undo button
  const undoBtn = el('btn-undo') as HTMLButtonElement | null;
  if (undoBtn) undoBtn.disabled = !callbacks.canUndo?.();
}

/** Callbacks from board clicks */
export interface BoardCallbacks {
  onHandCardClick?: (card: Card, index: number) => void;
  onBattlefieldCardClick?: (perm: Permanent, controller: 0 | 1) => void;
  onExileClick?: (player: 0 | 1) => void;
  onGraveyardClick?: (player: 0 | 1) => void;
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

    // Goad badge — creature must attack this turn
    if ((perm as any).goaded) {
      const badge = document.createElement('span');
      badge.className = 'goaded-badge';
      badge.textContent = '!';
      badge.title = 'Goaded — must attack if able';
      cardEl.style.position = 'relative';
      cardEl.appendChild(badge);
    }

    // Dash badge — will return to hand at end of turn
    if ((perm as any).dashedThisTurn) {
      const badge = document.createElement('span');
      badge.className = 'dashed-badge';
      badge.textContent = '\u21A9';
      badge.title = 'Dashed — returns to hand at end step';
      cardEl.style.position = 'relative';
      cardEl.appendChild(badge);
    }

    // Loyalty badge for planeswalkers
    if (perm.typeLine.toLowerCase().includes('planeswalker') && (perm.currentLoyalty != null || perm.loyalty)) {
      const loyaltyBadge = document.createElement('span');
      loyaltyBadge.className = 'loyalty-badge';
      loyaltyBadge.textContent = String(perm.currentLoyalty ?? perm.loyalty ?? '?');
      loyaltyBadge.title = `Loyalty: ${perm.currentLoyalty ?? perm.loyalty}`;
      cardEl.style.position = 'relative';
      cardEl.appendChild(loyaltyBadge);
    }

    // Equipment/Aura attachment indicator
    if (perm.attachedTo) {
      const attachBadge = document.createElement('span');
      attachBadge.className = 'attached-badge';
      attachBadge.textContent = '\u{1F517}'; // link emoji
      attachBadge.title = 'Attached to another permanent';
      cardEl.style.position = 'relative';
      cardEl.appendChild(attachBadge);
    }
    if (perm.attachments && perm.attachments.length > 0) {
      const equipBadge = document.createElement('span');
      equipBadge.className = 'equipped-badge';
      equipBadge.textContent = `+${perm.attachments.length}`;
      equipBadge.title = `${perm.attachments.length} equipment/aura(s) attached`;
      cardEl.style.position = 'relative';
      cardEl.appendChild(equipBadge);
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

    // Oracle text preview
    const card = item.card;
    if (card?.oracleText) {
      const oraclePreview = document.createElement('div');
      oraclePreview.className = 'stack-oracle-preview';
      const text = card.oracleText.length > 60 ? card.oracleText.substring(0, 57) + '...' : card.oracleText;
      oraclePreview.textContent = text;
      nameDiv.appendChild(oraclePreview);
    }

    // Type line
    if (card?.typeLine) {
      const typeLabel = document.createElement('div');
      typeLabel.className = 'stack-type-label';
      typeLabel.textContent = card.typeLine;
      nameDiv.appendChild(typeLabel);
    }

    row.appendChild(nameDiv);
    container.appendChild(row);
  }
}

/** Make an exile zone count clickable to open exile browser */
function setupExileClick(countId: string, player: 0 | 1, callbacks: BoardCallbacks): void {
  const countEl = el(countId);
  if (!countEl) return;
  // Find the parent zone-link div
  const zoneLink = countEl.closest('.pvb-zone-link');
  if (!zoneLink) return;
  // Avoid duplicate listeners by checking data attribute
  if ((zoneLink as HTMLElement).dataset.exileWired) return;
  (zoneLink as HTMLElement).dataset.exileWired = '1';
  (zoneLink as HTMLElement).style.cursor = 'pointer';
  zoneLink.addEventListener('click', () => {
    callbacks.onExileClick?.(player);
  });
}

/** Make a graveyard zone count clickable to open graveyard browser */
function setupGraveyardClick(countId: string, player: 0 | 1, callbacks: BoardCallbacks): void {
  const countEl = el(countId);
  if (!countEl) return;
  const zoneLink = countEl.closest('.pvb-zone-link');
  if (!zoneLink) return;
  if ((zoneLink as HTMLElement).dataset.gyWired) return;
  (zoneLink as HTMLElement).dataset.gyWired = '1';
  (zoneLink as HTMLElement).style.cursor = 'pointer';
  zoneLink.addEventListener('click', () => {
    callbacks.onGraveyardClick?.(player);
  });
}

/** Update a zone count element */
function setCount(id: string, count: number): void {
  const e = el(id);
  if (e) e.textContent = String(count);
}

// ═══════════════ Combat Arrows ═══════════════

/** Draw SVG arrows between attackers (bot BF) and blockers (your BF) */
export function renderCombatArrows(
  attackerIds: string[],
  blockerAssignment: Map<string, string>,
): void {
  const svg = document.getElementById('combat-arrows') as unknown as SVGSVGElement | null;
  if (!svg) return;
  svg.innerHTML = '';

  const bfContainer = document.getElementById('battlefield');
  if (!bfContainer) return;
  const bfRect = bfContainer.getBoundingClientRect();

  // Arrow marker def
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

  const attackMarker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  attackMarker.setAttribute('id', 'arrow-attack');
  attackMarker.setAttribute('markerWidth', '8');
  attackMarker.setAttribute('markerHeight', '8');
  attackMarker.setAttribute('refX', '8');
  attackMarker.setAttribute('refY', '4');
  attackMarker.setAttribute('orient', 'auto');
  const attackPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  attackPoly.setAttribute('points', '0,0 8,4 0,8');
  attackPoly.setAttribute('fill', '#ef4444');
  attackMarker.appendChild(attackPoly);
  defs.appendChild(attackMarker);

  const blockMarker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  blockMarker.setAttribute('id', 'arrow-block');
  blockMarker.setAttribute('markerWidth', '8');
  blockMarker.setAttribute('markerHeight', '8');
  blockMarker.setAttribute('refX', '8');
  blockMarker.setAttribute('refY', '4');
  blockMarker.setAttribute('orient', 'auto');
  const blockPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  blockPoly.setAttribute('points', '0,0 8,4 0,8');
  blockPoly.setAttribute('fill', '#6366f1');
  blockMarker.appendChild(blockPoly);
  defs.appendChild(blockMarker);

  svg.appendChild(defs);

  // Draw attack arrows (attacker → center divider)
  for (const attackerId of attackerIds) {
    const attackerEl = document.querySelector(`[data-permanent-id="${attackerId}"]`) as HTMLElement | null;
    if (!attackerEl) continue;
    const aRect = attackerEl.getBoundingClientRect();
    const fromX = aRect.left + aRect.width / 2 - bfRect.left;
    const fromY = aRect.top + aRect.height / 2 - bfRect.top;
    // Arrow points toward the center (divider between bot and player BF)
    const toY = bfRect.height / 2;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(fromX));
    line.setAttribute('y1', String(fromY));
    line.setAttribute('x2', String(fromX));
    line.setAttribute('y2', String(toY));
    line.setAttribute('class', 'attack-arrow');
    line.setAttribute('marker-end', 'url(#arrow-attack)');
    svg.appendChild(line);
  }

  // Draw block arrows (blocker → attacker)
  for (const [blockerId, attackerId] of blockerAssignment.entries()) {
    const blockerEl = document.querySelector(`[data-permanent-id="${blockerId}"]`) as HTMLElement | null;
    const attackerEl = document.querySelector(`[data-permanent-id="${attackerId}"]`) as HTMLElement | null;
    if (!blockerEl || !attackerEl) continue;

    const bRect = blockerEl.getBoundingClientRect();
    const aRect = attackerEl.getBoundingClientRect();
    const fromX = bRect.left + bRect.width / 2 - bfRect.left;
    const fromY = bRect.top + bRect.height / 2 - bfRect.top;
    const toX = aRect.left + aRect.width / 2 - bfRect.left;
    const toY = aRect.top + aRect.height / 2 - bfRect.top;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(fromX));
    line.setAttribute('y1', String(fromY));
    line.setAttribute('x2', String(toX));
    line.setAttribute('y2', String(toY));
    line.setAttribute('class', 'block-arrow');
    line.setAttribute('marker-end', 'url(#arrow-block)');
    svg.appendChild(line);
  }
}

/** Clear all combat arrows */
export function clearCombatArrows(): void {
  const svg = document.getElementById('combat-arrows');
  if (svg) svg.innerHTML = '';
}

// ═══════════════ Life Change Popups ═══════════════

let _lastLifeYou = -1;
let _lastLifeBot = -1;

/** Show floating life change numbers when life changes */
export function trackLifeChanges(yourLife: number, botLife: number): void {
  if (_lastLifeYou === -1) {
    // First call — initialize
    _lastLifeYou = yourLife;
    _lastLifeBot = botLife;
    return;
  }

  const yourDelta = yourLife - _lastLifeYou;
  const botDelta = botLife - _lastLifeBot;

  if (yourDelta !== 0) {
    const lifeEl = document.getElementById('your-life');
    if (lifeEl) showLifePopup(lifeEl, yourDelta);
  }
  if (botDelta !== 0) {
    const lifeEl = document.getElementById('bot-life');
    if (lifeEl) showLifePopup(lifeEl, botDelta);
  }

  _lastLifeYou = yourLife;
  _lastLifeBot = botLife;
}

function showLifePopup(anchor: HTMLElement, delta: number): void {
  const rect = anchor.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.className = `pvb-life-popup ${delta < 0 ? 'damage' : 'heal'}`;
  popup.textContent = delta > 0 ? `+${delta}` : String(delta);
  popup.style.left = `${rect.left + rect.width / 2 - 20}px`;
  popup.style.top = `${rect.top - 10}px`;
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 1300);
}

/** Reset life tracking (e.g. on new game) */
export function resetLifeTracking(): void {
  _lastLifeYou = -1;
  _lastLifeBot = -1;
}

// ═══════════════ Phase Banner ═══════════════

let _lastBannerPhase = '';

/** Show a dramatic phase banner on major phase changes */
export function showPhaseBanner(phase: Phase, step: Step): void {
  const phaseKey = `${phase}-${step}`;
  if (phaseKey === _lastBannerPhase) return;
  _lastBannerPhase = phaseKey;

  // Only show banners for significant phases
  let text = '';
  let isCombat = false;
  switch (phase) {
    case 'precombat-main':
      text = 'Main Phase';
      break;
    case 'combat':
      if (step === 'begin-combat') { text = 'Combat'; isCombat = true; }
      else if (step === 'declare-attackers') { text = 'Declare Attackers'; isCombat = true; }
      else if (step === 'declare-blockers') { text = 'Declare Blockers'; isCombat = true; }
      else if (step === 'combat-damage') { text = 'Combat Damage'; isCombat = true; }
      break;
    case 'postcombat-main':
      text = 'Main Phase 2';
      break;
    case 'ending':
      if (step === 'end') text = 'End Step';
      break;
    default:
      break;
  }

  if (!text) return;

  const banner = document.createElement('div');
  banner.className = `pvb-phase-banner${isCombat ? ' combat' : ''}`;
  banner.textContent = text;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 1500);
}

// ═══════════════ Turn Glow ═══════════════

let _lastTurn = -1;

/** Flash the turn indicator on new turn */
export function trackTurnChange(turn: number): void {
  if (turn === _lastTurn) return;
  _lastTurn = turn;
  const turnEl = document.getElementById('turn-display');
  if (turnEl) {
    turnEl.classList.remove('new-turn');
    // Force reflow for re-triggering animation
    void turnEl.offsetWidth;
    turnEl.classList.add('new-turn');
    setTimeout(() => turnEl.classList.remove('new-turn'), 1600);
  }
}

// ═══════════════ Card Entrance Tracking ═══════════════

let _lastBattlefieldIds = new Set<string>();

/** Track which cards are new on battlefield and add entrance animation */
export function animateNewCards(permanents: { id: string }[]): void {
  const currentIds = new Set(permanents.map(p => p.id));
  for (const id of currentIds) {
    if (!_lastBattlefieldIds.has(id)) {
      // New card — add entrance animation after render
      requestAnimationFrame(() => {
        const cardEl = document.querySelector(`[data-permanent-id="${id}"]`);
        if (cardEl) {
          cardEl.classList.add('zone-enter');
          setTimeout(() => cardEl.classList.remove('zone-enter'), 400);
        }
      });
    }
  }
  _lastBattlefieldIds = currentIds;
}

/** Reset animation tracking */
export function resetAnimationTracking(): void {
  _lastBattlefieldIds = new Set();
  _lastBannerPhase = '';
  _lastTurn = -1;
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
