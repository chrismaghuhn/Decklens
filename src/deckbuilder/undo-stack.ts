import type { DeckbuilderDeck } from './types.js';

const MAX_HISTORY = 50;

let undoStack: string[] = [];
let redoStack: string[] = [];
let onChange: (() => void) | null = null;

export function initUndoStack(onChangeCallback: () => void): void {
  onChange = onChangeCallback;
  undoStack = [];
  redoStack = [];
}

export function pushSnapshot(deck: DeckbuilderDeck): void {
  const json = JSON.stringify(deck.boards);
  // Don't push if identical to last snapshot
  if (undoStack.length > 0 && undoStack[undoStack.length - 1] === json) return;
  undoStack.push(json);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  onChange?.();
}

export function undo(deck: DeckbuilderDeck): boolean {
  if (undoStack.length === 0) return false;
  const currentJson = JSON.stringify(deck.boards);
  redoStack.push(currentJson);
  const prev = undoStack.pop()!;
  deck.boards = JSON.parse(prev);
  onChange?.();
  return true;
}

export function redo(deck: DeckbuilderDeck): boolean {
  if (redoStack.length === 0) return false;
  const currentJson = JSON.stringify(deck.boards);
  undoStack.push(currentJson);
  const next = redoStack.pop()!;
  deck.boards = JSON.parse(next);
  onChange?.();
  return true;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}
