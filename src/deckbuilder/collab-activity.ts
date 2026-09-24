/**
 * CollabActivity — Activity Feed panel for collaborative deck editing.
 *
 * Shows a chronological log of deck changes: card adds/removes/updates,
 * branch switches, snapshots, and participant join/leave events.
 */

import { h } from '../shared/dom.js';
import { cardNameWithPreview } from './card-autocomplete.js';

// ───── Types ─────

export interface ActivityEntry {
  id: string;
  action: string;
  userName: string;
  detail: string;
  timestamp: number;
  branchName?: string;
}

// ───── State ─────

let entries: ActivityEntry[] = [];
let panelEl: HTMLElement | null = null;
let panelVisible = false;
const MAX_ENTRIES = 200;
let activeFilter: string = 'all';
let refreshInterval: ReturnType<typeof setInterval> | null = null;

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'cards', label: 'Cards' },
  { key: 'snapshots', label: 'Snapshots' },
  { key: 'branches', label: 'Branches' },
  { key: 'presence', label: 'Presence' },
];

// ───── Public API ─────

export function addActivity(action: string, userName: string, detail: string, branchName?: string): void {
  entries.push({
    id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    action,
    userName,
    detail,
    timestamp: Date.now(),
    branchName,
  });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  if (panelVisible) renderList();
}

export function toggleActivityPanel(): void {
  panelVisible = !panelVisible;
  if (panelVisible) showPanel();
  else hidePanel();
}

export function isActivityPanelOpen(): boolean {
  return panelVisible;
}

export function getRecentActivity(count: number = 50): ActivityEntry[] {
  return entries.slice(-count).reverse();
}

// ───── Panel UI ─────

function showPanel(): void {
  if (panelEl) { panelEl.style.display = 'flex'; renderList(); startRefresh(); return; }

  panelEl = h('div', { className: 'activity-panel' },
    h('div', { className: 'activity-panel-header' },
 h('span', { className: 'activity-panel-title' }, '▤ Activity Feed'),
 h('button', { className: 'activity-panel-close', onClick: () => toggleActivityPanel(), title: 'Close' }, '✕'),
    ),
    h('div', { className: 'activity-filter-bar', id: '_activityFilters' }),
    h('div', { className: 'activity-panel-list', id: '_activityList' }),
  );
  document.body.appendChild(panelEl);
  renderFilters();
  renderList();
  startRefresh();
}

function hidePanel(): void {
  if (panelEl) panelEl.style.display = 'none';
  stopRefresh();
}

function matchesFilter(entry: ActivityEntry): boolean {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'cards') return entry.action.startsWith('card-');
  if (activeFilter === 'snapshots') return entry.action.startsWith('snapshot-');
  if (activeFilter === 'branches') return entry.action.startsWith('branch-');
  if (activeFilter === 'presence') return entry.action === 'joined' || entry.action === 'left';
  return true;
}

/** Extract card name from detail text like "added Sol Ring" or "removed Lightning Bolt (x2)" */
function extractCardName(action: string, detail: string): string | null {
  if (!action.startsWith('card-')) return null;
  // Pattern: "added/removed/updated CardName" or "added/removed/updated CardName (x2)"
  const match = detail.match(/^(?:added|removed|updated|moved)\s+(.+?)(?:\s+\(x\d+\))?$/i);
  return match ? match[1] : null;
}

function renderDetailWithPreview(entry: ActivityEntry): (HTMLElement | string)[] {
  const cardName = extractCardName(entry.action, entry.detail);
  if (cardName) {
    const verb = entry.detail.substring(0, entry.detail.indexOf(cardName)).trim();
    const suffix = entry.detail.substring(entry.detail.indexOf(cardName) + cardName.length);
    return [
      verb ? ` ${verb} ` : ' ',
      cardNameWithPreview(cardName, 'activity-card-name'),
      suffix || '',
    ];
  }
  return [` ${entry.detail}`];
}

function renderFilters(): void {
  const container = document.getElementById('_activityFilters');
  if (!container) return;

  container.replaceChildren(
    ...FILTERS.map((f) =>
      h('button', {
        className: `activity-filter-btn${activeFilter === f.key ? ' active' : ''}`,
        onClick: () => { activeFilter = f.key; renderFilters(); renderList(); },
      }, f.label),
    ),
  );
}

function renderList(): void {
  const container = document.getElementById('_activityList');
  if (!container) return;

  const recent = getRecentActivity(100).filter(matchesFilter);
  if (recent.length === 0) {
    const msg = activeFilter === 'all' ? 'No activity yet.' : `No ${activeFilter} activity.`;
    container.replaceChildren(h('div', { className: 'activity-empty' }, msg));
    return;
  }

  const items = recent.map((entry) => {
    const icon = getActionIcon(entry.action);
    const timeStr = formatTime(entry.timestamp);
    return h('div', { className: 'activity-entry' },
      h('span', { className: 'activity-icon' }, icon),
      h('div', { className: 'activity-entry-content' },
        h('span', { className: 'activity-user' }, entry.userName),
        ...renderDetailWithPreview(entry),
 entry.branchName ? h('span', { className: 'activity-branch-tag' }, `⑂ ${entry.branchName}`) : '',
      ),
      h('span', { className: 'activity-time' }, timeStr),
    );
  });

  container.replaceChildren(...items);
}

function getActionIcon(action: string): string {
  const icons: Record<string, string> = {
 'card-add': '+',
 'card-remove': '−',
 'card-update': '✎',
 'deck-meta': '▥',
 'branch-create': '⑂',
 'branch-switch': '⑂',
 'branch-delete': '✕',
 'snapshot-create': '◆',
 'snapshot-restore': '↺',
 'joined': '▸',
 'left': '◂',
  };
  return icons[action] || '\u25CF';
}

function formatTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Refresh timestamps every 60s while panel is visible */
function startRefresh(): void {
  stopRefresh();
  refreshInterval = setInterval(() => {
    if (panelVisible) renderList();
  }, 60_000);
}

function stopRefresh(): void {
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
}
