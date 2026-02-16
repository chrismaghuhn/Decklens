// ==================== Enhanced Version Panel ====================
// Combines local snapshots (deck-diff.ts) with cloud branches & snapshots (version-api.ts).
// Renders an enhanced timeline with branch selector and cloud sync badges.

import type { DeckbuilderDeck, DeckbuilderBoards } from './types.js';
import { loadSnapshots, createSnapshot, type HistoryCallbacks } from './deck-diff.js';
import { computeDiff } from './deck-diff.js';
import {
  fetchBranches,
  createBranch,
  fetchSnapshots,
  createCloudSnapshot,
  type CloudBranch,
  type CloudSnapshot,
} from './version-api.js';
import { showPromptModal, showConfirmModal } from './confirm-modal.js';
import { STORAGE_KEYS, storageGet } from '../shared/storage.js';

interface MergedSnapshot {
  id: string;
  label: string;
  timestamp: string;
  boards: DeckbuilderBoards | null; // null if cloud-only without boards
  source: 'local' | 'cloud' | 'both';
  snapshotType: 'auto' | 'manual';
  cardCount: number;
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function isCloudSyncEnabled(): boolean {
  return storageGet<boolean>(STORAGE_KEYS.DECKBUILDER_CLOUD_SYNC, false);
}

/**
 * Merge local snapshots with cloud snapshots, deduplicating by timestamp proximity.
 */
function mergeSnapshots(
  localSnaps: Array<{ timestamp: string; label: string; boards: DeckbuilderBoards }>,
  cloudSnaps: CloudSnapshot[],
): MergedSnapshot[] {
  const merged: MergedSnapshot[] = [];
  const usedCloud = new Set<string>();

  // First pass: match local to cloud by timestamp (within 5 seconds)
  for (const local of localSnaps) {
    const localTime = new Date(local.timestamp).getTime();
    const match = cloudSnaps.find((c) => {
      if (usedCloud.has(c.id)) return false;
      const cloudTime = new Date(c.createdAt).getTime();
      return Math.abs(localTime - cloudTime) < 5000;
    });

    if (match) {
      usedCloud.add(match.id);
      merged.push({
        id: match.id,
        label: match.label || local.label,
        timestamp: local.timestamp,
        boards: local.boards,
        source: 'both',
        snapshotType: (match.snapshotType as 'auto' | 'manual') || 'auto',
        cardCount: match.cardCount || 0,
      });
    } else {
      merged.push({
        id: `local-${local.timestamp}`,
        label: local.label,
        timestamp: local.timestamp,
        boards: local.boards,
        source: 'local',
        snapshotType: local.label.startsWith('Auto') ? 'auto' : 'manual',
        cardCount: 0,
      });
    }
  }

  // Second pass: add cloud-only snapshots
  for (const cloud of cloudSnaps) {
    if (usedCloud.has(cloud.id)) continue;
    merged.push({
      id: cloud.id,
      label: cloud.label,
      timestamp: cloud.createdAt,
      boards: null,
      source: 'cloud',
      snapshotType: (cloud.snapshotType as 'auto' | 'manual') || 'auto',
      cardCount: cloud.cardCount || 0,
    });
  }

  // Sort by timestamp descending (newest first)
  return merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export async function renderVersionPanel(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  callbacks: HistoryCallbacks,
): Promise<void> {
  container.textContent = '';

  const cloudEnabled = isCloudSyncEnabled();

  // ── Branch Selector ──
  const branchBar = document.createElement('div');
  branchBar.className = 'version-branch-bar';

  let branches: CloudBranch[] = [];
  if (cloudEnabled) {
    branches = await fetchBranches(deck.id);
  }

  if (branches.length > 0 || cloudEnabled) {
    const branchSelect = document.createElement('select');
    branchSelect.className = 'version-branch-select';

    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All Branches';
    branchSelect.appendChild(allOption);

    for (const b of branches) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.name + (b.isDefault ? ' (default)' : '');
      branchSelect.appendChild(opt);
    }

    const newBranchBtn = document.createElement('button');
    newBranchBtn.className = 'btn version-new-branch-btn';
    newBranchBtn.textContent = '+ Branch';
    newBranchBtn.addEventListener('click', async () => {
      const name = await showPromptModal({
        title: 'New Branch',
        message: 'Enter a name for this branch variant:',
        placeholder: 'e.g. Budget version, Aggro variant',
        defaultValue: '',
      });
      if (!name) return;
      await createBranch(deck.id, name, {
        boardsJson: JSON.stringify(deck.boards),
      });
      renderVersionPanel(container, deck, callbacks);
    });

    branchBar.append(branchSelect, newBranchBtn);
    container.appendChild(branchBar);

    // Re-render when branch changes
    branchSelect.addEventListener('change', () => {
      renderVersionPanel(container, deck, callbacks);
    });
  }

  // ── Load Snapshots ──
  const localSnaps = loadSnapshots(deck.id);
  let cloudSnaps: CloudSnapshot[] = [];
  if (cloudEnabled) {
    cloudSnaps = await fetchSnapshots(deck.id);
  }

  const snapshots = mergeSnapshots(localSnaps, cloudSnaps);

  // ── Actions Bar ──
  const actionsBar = document.createElement('div');
  actionsBar.className = 'version-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn';
  saveBtn.style.fontSize = '0.72rem';
  saveBtn.textContent = 'Save Snapshot Now';
  saveBtn.addEventListener('click', async () => {
    const label = await showPromptModal({
      title: 'Save Snapshot',
      message: 'Enter a label for this snapshot:',
      placeholder: 'e.g. Before mana base rework',
      defaultValue: 'Manual save',
    });
    if (label === null) return;
    createSnapshot(deck, label);

    // Also sync to cloud if enabled
    if (cloudEnabled) {
      const totalCards = deck.boards.mainboard.reduce((s, e) => s + e.qty, 0)
        + deck.boards.commander.reduce((s, e) => s + e.qty, 0);
      await createCloudSnapshot(deck.id, {
        label,
        boardsJson: JSON.stringify(deck.boards),
        cardCount: totalCards,
        snapshotType: 'manual',
      });
    }

    renderVersionPanel(container, deck, callbacks);
  });

  actionsBar.appendChild(saveBtn);

  if (cloudEnabled) {
    const syncBadge = document.createElement('span');
    syncBadge.className = 'version-sync-badge version-sync-cloud';
    syncBadge.textContent = 'Cloud Sync ON';
    actionsBar.appendChild(syncBadge);
  }

  container.appendChild(actionsBar);

  // ── Empty State ──
  if (snapshots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.fontSize = '0.78rem';
    empty.textContent = 'No snapshots yet. Changes are auto-saved when 3+ cards change.';
    container.appendChild(empty);
    return;
  }

  // ── Timeline ──
  const timeline = document.createElement('div');
  timeline.className = 'version-timeline';

  for (const snap of snapshots) {
    const item = document.createElement('div');
    item.className = 'version-entry';

    // Timeline dot
    const dot = document.createElement('div');
    dot.className = `version-dot ${snap.source === 'cloud' ? 'version-dot-cloud' : snap.source === 'both' ? 'version-dot-synced' : 'version-dot-local'}`;

    // Entry content
    const content = document.createElement('div');
    content.className = 'version-entry-content';

    // Header row
    const header = document.createElement('div');
    header.className = 'version-entry-header';
    header.style.cursor = snap.boards ? 'pointer' : 'default';

    const labelEl = document.createElement('span');
    labelEl.className = 'version-entry-label';
    labelEl.textContent = snap.label || 'Snapshot';

    const timeEl = document.createElement('span');
    timeEl.className = 'version-entry-time';
    timeEl.textContent = relativeTime(snap.timestamp);

    const badges = document.createElement('span');
    badges.className = 'version-entry-badges';

    // Source badge
    const sourceBadge = document.createElement('span');
    sourceBadge.className = `version-sync-badge version-sync-${snap.source}`;
    sourceBadge.textContent = snap.source === 'both' ? 'synced' : snap.source;
    badges.appendChild(sourceBadge);

    // Changes count
    if (snap.boards) {
      const diff = computeDiff(snap.boards, deck.boards);
      if (diff.length > 0) {
        const changesEl = document.createElement('span');
        changesEl.className = 'version-entry-changes';
        changesEl.textContent = `${diff.length} change${diff.length !== 1 ? 's' : ''}`;
        badges.appendChild(changesEl);
      }
    }

    header.append(labelEl, timeEl, badges);

    // Body (hidden by default, expandable)
    const body = document.createElement('div');
    body.className = 'version-entry-body';
    body.style.display = 'none';

    if (snap.boards) {
      const diff = computeDiff(snap.boards, deck.boards);

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
        if (confirmed && snap.boards) {
          callbacks.onRestore(JSON.parse(JSON.stringify(snap.boards)));
        }
      });
      body.appendChild(restoreBtn);

      header.addEventListener('click', () => {
        body.style.display = body.style.display === 'none' ? 'block' : 'none';
      });
    } else {
      const info = document.createElement('div');
      info.className = 'muted';
      info.style.fontSize = '0.72rem';
      info.textContent = 'Cloud-only snapshot. Full boards available via API.';
      body.appendChild(info);

      header.addEventListener('click', () => {
        body.style.display = body.style.display === 'none' ? 'block' : 'none';
      });
    }

    content.append(header, body);
    item.append(dot, content);
    timeline.appendChild(item);
  }

  container.appendChild(timeline);
}
