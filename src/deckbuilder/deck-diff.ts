import type { DeckbuilderDeck, DeckbuilderBoards } from './types.js';
import { showConfirmModal, showPromptModal } from './confirm-modal.js';

interface DeckSnapshot {
  timestamp: string;
  label: string;
  boards: DeckbuilderBoards;
}

const MAX_SNAPSHOTS = 20;

function storageKey(deckId: string): string {
  return `decklens_snapshots_${deckId}`;
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function loadSnapshots(deckId: string): DeckSnapshot[] {
  try {
    const raw = localStorage.getItem(storageKey(deckId));
    if (!raw) return [];
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function saveSnapshots(deckId: string, snapshots: DeckSnapshot[]): void {
  localStorage.setItem(storageKey(deckId), JSON.stringify(snapshots.slice(-MAX_SNAPSHOTS)));
}

export function createSnapshot(deck: DeckbuilderDeck, label?: string): void {
  const snapshots = loadSnapshots(deck.id);
  snapshots.push({
    timestamp: new Date().toISOString(),
    label: label || `Snapshot ${snapshots.length + 1}`,
    boards: JSON.parse(JSON.stringify(deck.boards)),
  });
  saveSnapshots(deck.id, snapshots);
}

export function autoSnapshotIfNeeded(deck: DeckbuilderDeck, prevCardCount: number): void {
  const currentCount = deck.boards.mainboard.reduce((s, e) => s + e.qty, 0)
    + deck.boards.commander.reduce((s, e) => s + e.qty, 0);
  if (Math.abs(currentCount - prevCardCount) >= 3) {
    createSnapshot(deck, `Auto: ${currentCount} cards`);
  }
}

interface DiffEntry {
  name: string;
  oldQty: number;
  newQty: number;
}

export function computeDiff(oldBoards: DeckbuilderBoards, newBoards: DeckbuilderBoards): DiffEntry[] {
  const oldMap = new Map<string, number>();
  const newMap = new Map<string, number>();

  for (const e of [...oldBoards.commander, ...oldBoards.mainboard, ...oldBoards.sideboard]) {
    const key = normalizeKey(e.name);
    oldMap.set(key, (oldMap.get(key) || 0) + e.qty);
  }
  for (const e of [...newBoards.commander, ...newBoards.mainboard, ...newBoards.sideboard]) {
    const key = normalizeKey(e.name);
    newMap.set(key, (newMap.get(key) || 0) + e.qty);
  }

  const allKeys = new Set([...oldMap.keys(), ...newMap.keys()]);
  const diff: DiffEntry[] = [];

  for (const key of allKeys) {
    const oldQty = oldMap.get(key) || 0;
    const newQty = newMap.get(key) || 0;
    if (oldQty !== newQty) {
      // Use proper cased name from whichever side has it
      const name = [...oldBoards.commander, ...oldBoards.mainboard, ...oldBoards.sideboard,
        ...newBoards.commander, ...newBoards.mainboard, ...newBoards.sideboard]
        .find((e) => normalizeKey(e.name) === key)?.name || key;
      diff.push({ name, oldQty, newQty });
    }
  }

  return diff.sort((a, b) => a.name.localeCompare(b.name));
}

export interface HistoryCallbacks {
  onRestore(boards: DeckbuilderBoards): void;
}

export function renderDeckHistory(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  callbacks: HistoryCallbacks,
): void {
  container.textContent = '';

  const snapshots = loadSnapshots(deck.id);

  if (snapshots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.fontSize = '0.78rem';
    empty.textContent = 'No snapshots yet. Changes are auto-saved when 3+ cards change.';
    container.appendChild(empty);
    return;
  }

  // Manual save button
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn';
  saveBtn.style.cssText = 'font-size:0.72rem; margin-bottom:10px;';
  saveBtn.textContent = 'Save Snapshot Now';
  saveBtn.addEventListener('click', async () => {
    const label = await showPromptModal({
      title: 'Save Snapshot',
      message: 'Enter a label for this snapshot:',
      placeholder: 'e.g. Before changes',
      defaultValue: 'Manual save',
    });
    if (label === null) return;
    createSnapshot(deck, label);
    renderDeckHistory(container, deck, callbacks);
  });
  container.appendChild(saveBtn);

  // Timeline
  const timeline = document.createElement('div');
  timeline.className = 'history-timeline';

  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snap = snapshots[i];
    const diff = computeDiff(snap.boards, deck.boards);

    const item = document.createElement('div');
    item.className = 'history-item';

    // Header
    const header = document.createElement('div');
    header.className = 'history-header';
    header.style.cursor = 'pointer';

    const label = document.createElement('span');
    label.className = 'history-label';
    label.textContent = snap.label;

    const time = document.createElement('span');
    time.className = 'history-time';
    const date = new Date(snap.timestamp);
    time.textContent = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const changes = document.createElement('span');
    changes.className = 'history-changes';
    changes.textContent = diff.length > 0 ? `${diff.length} changes` : 'identical';

    header.append(label, time, changes);

    // Diff body (hidden by default)
    const body = document.createElement('div');
    body.className = 'history-body';
    body.style.display = 'none';

    if (diff.length > 0) {
      for (const d of diff.slice(0, 20)) {
        const row = document.createElement('div');
        row.className = 'history-diff-row';
        if (d.oldQty === 0) {
          row.className += ' history-added';
          row.textContent = `+ ${d.newQty}x ${d.name}`;
        } else if (d.newQty === 0) {
          row.className += ' history-removed';
          row.textContent = `- ${d.oldQty}x ${d.name}`;
        } else {
          row.className += ' history-changed';
          row.textContent = `${d.name}: ${d.oldQty} → ${d.newQty}`;
        }
        body.appendChild(row);
      }
      if (diff.length > 20) {
        const more = document.createElement('div');
        more.className = 'muted';
        more.style.fontSize = '0.68rem';
        more.textContent = `... and ${diff.length - 20} more`;
        body.appendChild(more);
      }
    } else {
      const same = document.createElement('div');
      same.className = 'muted';
      same.style.fontSize = '0.72rem';
      same.textContent = 'No changes from current deck.';
      body.appendChild(same);
    }

    // Restore button
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'btn';
    restoreBtn.style.cssText = 'font-size:0.68rem; margin-top:6px;';
    restoreBtn.textContent = 'Restore This Version';
    restoreBtn.addEventListener('click', async () => {
      const confirmed = await showConfirmModal({
        title: 'Restore Snapshot',
        message: 'Restore this snapshot? Current changes will be lost.',
        confirmLabel: 'Restore',
        danger: true,
      });
      if (confirmed) {
        callbacks.onRestore(JSON.parse(JSON.stringify(snap.boards)));
      }
    });
    body.appendChild(restoreBtn);

    header.addEventListener('click', () => {
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });

    item.append(header, body);
    timeline.appendChild(item);
  }

  container.appendChild(timeline);
}
