// packages/game-engine/src/rules/n-player.ts
import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';

/** Returns all player indices except the given one */
export function getOpponents(state: GameState, player: number): number[] {
  return state.players.map((_, i) => i).filter(i => i !== player);
}

/** Returns the first opponent (for migration from binary flip) */
export function getFirstOpponent(state: GameState, player: number): number {
  const opponents = getOpponents(state, player);
  if (opponents.length === 0) return player; // safe fallback: no opponents
  return opponents[0];
}

/** Next player in clockwise order, wraps around */
export function nextPlayer(current: number, total: number): number {
  return (current + 1) % total;
}

/** Immutable update of a player in the players array */
export function updatePlayer(
  players: PlayerState[],
  index: number,
  update: Partial<PlayerState>
): PlayerState[] {
  const next = [...players];
  next[index] = { ...next[index], ...update };
  return next;
}
