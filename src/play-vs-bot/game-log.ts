/**
 * Game Log — Renders action history to the log panel.
 */

import type { GameState, GameAction, Phase, Step } from '@mtg/game-engine';

const MAX_LOG_ENTRIES = 200;

/** Add a log entry from an action */
export function logAction(
  state: GameState,
  action: GameAction,
  humanPlayer: 0 | 1,
): void {
  const logEl = document.getElementById('game-log');
  if (!logEl) return;

  const isHuman = action.player === humanPlayer;
  const who = isHuman ? 'You' : 'Bot';
  const whoClass = isHuman ? 'pvb-log-you' : 'pvb-log-bot';

  let text = '';
  switch (action.type) {
    case 'pass':
      text = 'Passed priority';
      break;
    case 'play-land':
      text = `Played ${findCardName(state, action.cardId, action.player)}`;
      break;
    case 'cast-spell':
      text = `Cast ${findCardName(state, action.cardId, action.player)}`;
      break;
    case 'activate-ability':
      text = `Activated ability of ${findPermanentName(state, action.sourceId, action.player)}`;
      break;
    case 'declare-attackers':
      text = `Declared ${action.attackers.length} attacker(s)`;
      break;
    case 'declare-blockers':
      text = `Declared ${action.blocks.length} blocker(s)`;
      break;
    case 'mulligan':
      text = action.toBottom.length > 0
        ? `Mulliganed (put ${action.toBottom.length} on bottom)`
        : 'Kept hand';
      break;
    case 'concede':
      text = 'Conceded';
      break;
  }

  addEntry(logEl, `<span class="pvb-log-turn">[T${state.turn}]</span> <span class="${whoClass}">${who}:</span> ${text}`);
}

/** Add a phase change entry */
export function logPhaseChange(turn: number, phase: Phase, step: Step): void {
  const logEl = document.getElementById('game-log');
  if (!logEl) return;
  addEntry(logEl, `<span class="pvb-log-phase">── ${formatStep(phase, step)} ──</span>`);
}

/** Add game over entry */
export function logGameOver(winner: 0 | 1 | null, humanPlayer: 0 | 1): void {
  const logEl = document.getElementById('game-log');
  if (!logEl) return;
  if (winner === humanPlayer) {
    addEntry(logEl, '<span class="pvb-log-you" style="font-weight:700;">You win!</span>');
  } else if (winner !== null) {
    addEntry(logEl, '<span class="pvb-log-bot" style="font-weight:700;">Bot wins!</span>');
  } else {
    addEntry(logEl, '<span style="font-weight:700;">Game ended in a draw.</span>');
  }
}

/** Add an arbitrary message */
export function logMessage(msg: string): void {
  const logEl = document.getElementById('game-log');
  if (logEl) addEntry(logEl, msg);
}

function addEntry(container: HTMLElement, html: string): void {
  const entry = document.createElement('div');
  entry.className = 'pvb-log-entry';
  entry.innerHTML = html;
  container.appendChild(entry);
  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
  // Trim old entries
  while (container.children.length > MAX_LOG_ENTRIES) {
    container.removeChild(container.firstChild!);
  }
}

function findCardName(state: GameState, cardId: string, player: 0 | 1): string {
  const p = state.players[player];
  const card = p.hand.find(c => c.id === cardId)
    ?? p.battlefield.find(c => c.id === cardId)
    ?? p.graveyard.find(c => c.id === cardId)
    ?? p.commandZone.find(c => c.id === cardId);
  return card?.name ?? 'a card';
}

function findPermanentName(state: GameState, permId: string, player: 0 | 1): string {
  const perm = state.players[player].battlefield.find(p => p.id === permId);
  return perm?.name ?? 'a permanent';
}

function formatStep(phase: Phase, step: Step): string {
  switch (step) {
    case 'untap': return 'Untap Step';
    case 'upkeep': return 'Upkeep';
    case 'draw': return 'Draw Step';
    case 'main': return phase === 'precombat-main' ? 'Main Phase 1' : 'Main Phase 2';
    case 'begin-combat': return 'Begin Combat';
    case 'declare-attackers': return 'Declare Attackers';
    case 'declare-blockers': return 'Declare Blockers';
    case 'first-strike-damage': return 'First Strike Damage';
    case 'combat-damage': return 'Combat Damage';
    case 'end-combat': return 'End Combat';
    case 'end': return 'End Step';
    case 'cleanup': return 'Cleanup';
    default: return String(step);
  }
}
