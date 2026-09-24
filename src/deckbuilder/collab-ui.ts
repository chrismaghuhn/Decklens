/**
 * CollabUI — UI components for collaborative deck editing.
 *
 * Renders the collab toolbar, participant list, share modal,
 * connection status, and toast notifications.
 * Uses the XSS-safe `h()` helper from shared/dom.js.
 */

import { h } from '../shared/dom.js';
import {
  createCollabSession,
  closeCollabSession,
  getCollabWebSocketUrl,
} from '../shared/api.js';
import { showToast as showEditorToast, showBatchableToast, initToastContainer } from './toast.js';
import { getCollabManager, type CollabEvent, type CollabEventHandler } from './collab-manager.js';
import type { CollabConnectionState, CollabParticipant, DeckbuilderDeck } from './types.js';
import { toggleDrawingMode, isDrawingActive } from './collab-drawing.js';
import { toggleChatPanel, isChatOpen, setChatBadgeElement } from './collab-chat.js';
import { getCurrentUser, loginWithGitHub, loginWithGoogle, logout, onAuthStateChange, initAuth, getUser, type DeckLensUser } from '../shared/auth.js';
import { createBranchSelector } from './collab-branches.js';
import { toggleActivityPanel, isActivityPanelOpen, addActivity, getRecentActivity, type ActivityEntry } from './collab-activity.js';
import { initTimeline, toggleTimelinePanel, isTimelinePanelOpen, createManualSnapshot } from './collab-timeline.js';
import { toggleDiffPanel, isDiffPanelOpen } from './deck-diff-panel.js';
import { initProposals, toggleProposalPanel, isProposalPanelOpen, refreshProposals } from './collab-proposals.js';
import { initThreads, toggleThreadPanel, isThreadPanelOpen, refreshThreads } from './collab-threads.js';
import { initDecisions, toggleDecisionPanel, isDecisionPanelOpen, refreshDecisions } from './collab-decisions.js';
import { initTasks, toggleTaskPanel, isTaskPanelOpen, refreshTasks } from './collab-tasks.js';
import { initPresence, renderPresenceBar, resetPresence } from './collab-presence.js';
import { initLocking, setOnLockResult, setOnLocksChanged, setOnLockRequestReceived, releaseLock, isCardLocked, resetLocking } from './collab-locking.js';
import { initTeamCollection, toggleTeamCollectionPanel, isTeamCollectionPanelOpen, refreshTeamCollection, resetTeamCollection } from './collab-collection.js';
import { initConstraints, toggleConstraintPanel, isConstraintPanelOpen, refreshConstraints, resetConstraints } from './collab-constraints.js';
import { initPackages, togglePackagePanel, isPackagePanelOpen, resetPackages } from './collab-packages.js';
import { initGoldfish, toggleSpectatorPanel, isSpectatorPanelOpen, resetGoldfish } from './collab-goldfish.js';
import { initTestLog, toggleTestLogPanel, isTestLogPanelOpen, refreshTestLog, resetTestLog } from './collab-test-log.js';
import { initSideboardPlans, toggleSideboardPanel, isSideboardPanelOpen, refreshSideboardPlans, resetSideboardPlans } from './collab-sideboard.js';

// ───── State ─────

let collabActive = false;
let ownerToken: string | null = null;
let currentSessionId: string | null = null;

// Unread badge counters per module
const unreadCounts: Record<string, number> = {
  proposals: 0, threads: 0, decisions: 0, tasks: 0, sideboard: 0, tests: 0,
};

/** D4: Track disconnect timestamp for activity digest on reconnect */
let lastDisconnectTime: number | null = null;
const DIGEST_THRESHOLD_MS = 5 * 60 * 1000; // Show digest if away > 5 min

/** D3: Track current user's role for viewer filtering */
let currentUserRole: 'owner' | 'editor' | 'viewer' = 'editor';

/** D3: Check if the current user is a viewer (read-only mode) */
export function isCurrentUserViewer(): boolean {
  if (!collabActive) return false;
  return currentUserRole === 'viewer';
}

/** D3: Determine local user's role by matching display name to participant list */
function updateCurrentUserRole(): void {
  if (!collabActive) { currentUserRole = 'editor'; return; }
  const mgr = getCollabManager();
  const localName = mgr.currentDisplayName;
  const participants = mgr.currentParticipants;
  // Match participant by name — last joined with our name is "us"
  const me = [...participants].reverse().find((p) => p.name === localName);
  currentUserRole = (me?.role as typeof currentUserRole) || (ownerToken ? 'owner' : 'editor');
}

/** B3: Track which overflow panels are pinned (persisted to localStorage) */
let pinnedOverflowPanels: Set<string> = new Set();
const PINNED_PANELS_KEY = 'dl_collab_pinned_panels';
let overflowOpen = false;

function loadPinnedPanels(): void {
  try {
    const raw = localStorage.getItem(PINNED_PANELS_KEY);
    if (raw) pinnedOverflowPanels = new Set(JSON.parse(raw));
  } catch { /* ignore */ }
}

function savePinnedPanels(): void {
  try {
    localStorage.setItem(PINNED_PANELS_KEY, JSON.stringify([...pinnedOverflowPanels]));
  } catch { /* ignore */ }
}

function togglePinPanel(key: string): void {
  if (pinnedOverflowPanels.has(key)) {
    pinnedOverflowPanels.delete(key);
  } else {
    pinnedOverflowPanels.add(key);
  }
  savePinnedPanels();
  renderToolbar();
}

// ───── DOM References ─────

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Close all side panels. Call before opening a new one for mutual exclusivity. */
function closeAllPanels(): void {
  if (isChatOpen()) toggleChatPanel();
  if (isActivityPanelOpen()) toggleActivityPanel();
  if (isTimelinePanelOpen()) toggleTimelinePanel();
  if (isDiffPanelOpen()) toggleDiffPanel();
  if (isProposalPanelOpen()) toggleProposalPanel();
  if (isThreadPanelOpen()) toggleThreadPanel();
  if (isDecisionPanelOpen()) toggleDecisionPanel();
  if (isTaskPanelOpen()) toggleTaskPanel();
  if (isTeamCollectionPanelOpen()) toggleTeamCollectionPanel();
  if (isConstraintPanelOpen()) toggleConstraintPanel();
  if (isPackagePanelOpen()) togglePackagePanel();
  if (isSpectatorPanelOpen()) toggleSpectatorPanel();
  if (isTestLogPanelOpen()) toggleTestLogPanel();
  if (isSideboardPanelOpen()) toggleSideboardPanel();
}

/** Toggle a panel with mutual exclusivity — close others first, then toggle target. */
function exclusiveToggle(isOpen: () => boolean, toggle: () => void): void {
  if (isOpen()) {
    // If already open, just close it
    toggle();
  } else {
    // Close everything, then open this one
    closeAllPanels();
    toggle();
  }
  renderToolbar();
}

// ───── Initialization ─────

/** Render an unread badge for a module key */
function renderBadge(key: string): HTMLElement {
  const count = unreadCounts[key] || 0;
  return h('span', {
    className: `collab-unread-badge${count > 0 ? ' collab-unread-visible' : ''}`,
  }, count > 0 ? String(count > 99 ? '99+' : count) : '');
}

/** Open a panel and reset its unread count */
function exclusiveToggleWithBadge(key: string, isOpen: () => boolean, toggle: () => void): void {
  if (!isOpen()) unreadCounts[key] = 0;
  exclusiveToggle(isOpen, toggle);
}

/** Initialize the collab UI. Call once after DOM is ready. */
export function initCollabUI(): void {
  const toolbar = byId('collabToolbar');
  if (!toolbar) return;

  // Initialize toast container (unified system)
  initToastContainer();

  // Initialize auth system
  initAuth();

  // B3: Load pinned panel preferences
  loadPinnedPanels();

  // Render initial state (disconnected)
  renderToolbar();
  renderAuthButton();

  // Wire up CollabManager events
  const mgr = getCollabManager();
  mgr.on('state-change', onStateChange);
  mgr.on('sync', onSync);
  mgr.on('sync', onSyncSendAuthIdentify);
  mgr.on('participant-joined', onParticipantJoined);
  mgr.on('participant-left', onParticipantLeft);
  mgr.on('auth-identified', onAuthIdentified);
  mgr.on('role-changed', onRoleChanged);
  mgr.on('ownership-transferred', onOwnershipTransferred); // G3
  mgr.on('error', onError);

  // Versioning events (Phase 1)
  mgr.on('activity-logged', onActivityLogged);
  mgr.on('snapshot-created', onSnapshotCreated);

  // Decision Tools events (Phase 2)
  mgr.on('proposal-event', onProposalEvent);
  mgr.on('thread-event', onThreadEvent);
  mgr.on('decision-event', onDecisionEvent);
  mgr.on('task-event', onTaskEvent);

  // Team Intelligence events (Phase 4)
  mgr.on('collection-shared', onCollectionShared);
  mgr.on('constraint-event', onConstraintEvent);

  // Snapshot request listener — editor-main dispatches 'decklens:snapshot-data' in response
  window.addEventListener('decklens:snapshot-request', (e) => {
    const label = (e as CustomEvent).detail?.label || 'Manual snapshot';
    // Ask editor-main for current deck boards via CustomEvent roundtrip
    const req = new CustomEvent('decklens:get-deck-for-snapshot', { detail: { label } });
    window.dispatchEvent(req);
  });

  // Listen for deck data response from editor-main
  window.addEventListener('decklens:snapshot-data', async (e) => {
    const { label, boardsJson, cardCount } = (e as CustomEvent).detail || {};
    if (boardsJson) {
      await createManualSnapshot(label || 'Manual snapshot', boardsJson, cardCount || 0);
 showToast('◆ Snapshot created!', 'info');
    }
  });

  // Collaborative Testing events (Phase 5)
  mgr.on('goldfish-started', onGoldfishStarted);
  mgr.on('goldfish-ended', onGoldfishEnded);
  mgr.on('sideboard-plan-event', onSideboardPlanEvent);
  mgr.on('test-session-event', onTestSessionEvent);
  initGoldfish();

  // Presence & Locking (Phase 3)
  initPresence();
  initLocking();
  setOnLockResult((success, reason) => {
    if (!success && reason) {
 showToast(`◆ ${reason}`, 'error');
    }
  });
  setOnLocksChanged(() => {
    // Re-render to update lock indicators on cards
    renderToolbar();
  });
  // D2: When someone requests a lock we hold, show actionable toast
  setOnLockRequestReceived((board, cardName, requestedByName) => {
    const lockInfo = isCardLocked(board, cardName);
    if (lockInfo.locked && lockInfo.lockId) {
      const lockId = lockInfo.lockId;
      showEditorToast({
 message: ` ${requestedByName} wants to edit "${cardName}". Release your lock?`,
        type: 'info',
        duration: 15000,
        action: {
          label: 'Release Lock',
          onClick: () => {
            releaseLock(lockId);
            showToast(`Lock on "${cardName}" released.`, 'success');
          },
        },
      });
    }
  });

  // Re-render auth button when auth state changes
  onAuthStateChange(() => {
    renderAuthButton();
    renderToolbar();
  });

  // ── Keyboard shortcuts for collab panels ──
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!collabActive) return;
    const target = e.target as HTMLElement | null;
    const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (isInput) return;

    // Escape = close any open panel
    if (e.key === 'Escape') {
      closeAllPanels();
      renderToolbar();
      return;
    }

    if (!e.altKey) return;

    const shortcuts: Record<string, () => void> = {
      'c': () => exclusiveToggle(isChatOpen, toggleChatPanel),
      'a': () => exclusiveToggle(isActivityPanelOpen, toggleActivityPanel),
      't': () => exclusiveToggle(isTimelinePanelOpen, toggleTimelinePanel),
      'd': () => exclusiveToggle(isDiffPanelOpen, toggleDiffPanel),
      'p': () => exclusiveToggleWithBadge('proposals', isProposalPanelOpen, toggleProposalPanel),
      'h': () => exclusiveToggleWithBadge('threads', isThreadPanelOpen, toggleThreadPanel),
      'l': () => exclusiveToggleWithBadge('decisions', isDecisionPanelOpen, toggleDecisionPanel),
      'k': () => exclusiveToggleWithBadge('tasks', isTaskPanelOpen, toggleTaskPanel),
      'o': () => exclusiveToggle(isTeamCollectionPanelOpen, toggleTeamCollectionPanel),
      'n': () => exclusiveToggle(isConstraintPanelOpen, toggleConstraintPanel),
      'g': () => exclusiveToggle(isPackagePanelOpen, togglePackagePanel),
      's': () => exclusiveToggle(isSpectatorPanelOpen, toggleSpectatorPanel),
      'e': () => exclusiveToggleWithBadge('tests', isTestLogPanelOpen, toggleTestLogPanel),
      'b': () => exclusiveToggleWithBadge('sideboard', isSideboardPanelOpen, toggleSideboardPanel),
    };

    const handler = shortcuts[e.key.toLowerCase()];
    if (handler) {
      e.preventDefault();
      handler();
    }
  });
}

/** Check URL for ?collab= parameter and auto-join if present */
export function checkCollabUrlParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('collab');
}

// ───── Session Actions ─────

/** Start a new collab session for the given deck */
export async function startCollabSession(deck: DeckbuilderDeck): Promise<string | null> {
  try {
    showToast('Creating session...', 'info');
    const boardsPayload: Record<string, unknown[]> = {
      commander: [...deck.boards.commander],
      mainboard: [...deck.boards.mainboard],
      sideboard: [...deck.boards.sideboard],
      maybeboard: [...deck.boards.maybeboard],
    };
    const result = await createCollabSession({
      name: deck.name,
      description: deck.description || '',
      boards: boardsPayload,
    });

    currentSessionId = result.sessionId;
    ownerToken = result.ownerToken;
    collabActive = true;

    // Connect WebSocket
    const wsUrl = getCollabWebSocketUrl(result.sessionId);
    const displayName = getDisplayName();
    console.log('[CollabUI] startCollabSession → wsUrl:', wsUrl, 'sessionId:', result.sessionId);
    getCollabManager().connect(wsUrl, result.sessionId, displayName);

    // Update URL
    const url = new URL(window.location.href);
    url.searchParams.set('collab', result.sessionId);
    window.history.replaceState({}, '', url.toString());

    showToolbar();
    showToast('Session created! Share the link to invite collaborators.', 'success');

    return result.sessionId;
  } catch (err) {
    showToast(`Failed to create session: ${(err as Error).message}`, 'error');
    return null;
  }
}

/** Join an existing collab session by ID */
export function joinCollabSession(sessionId: string): void {
  console.log('[CollabUI] joinCollabSession() called with sessionId:', sessionId);
  currentSessionId = sessionId;
  collabActive = true;

  const wsUrl = getCollabWebSocketUrl(sessionId);
  console.log('[CollabUI] WebSocket URL:', wsUrl);
  const displayName = getDisplayName();
  console.log('[CollabUI] Display name:', displayName);
  getCollabManager().connect(wsUrl, sessionId, displayName);

  showToolbar();
}

/** End the collab session (owner only) */
export async function endCollabSession(): Promise<void> {
  if (!currentSessionId) return;

  if (ownerToken) {
    try {
      await closeCollabSession(currentSessionId, ownerToken);
    } catch {
      // Session might already be closed
    }
  }

  getCollabManager().disconnect();
  collabActive = false;
  ownerToken = null;
  currentSessionId = null;

  // Clean up presence & locking (Phase 3)
  resetPresence();
  resetLocking();
  resetTeamCollection();
  resetConstraints();
  resetPackages();
  // Clean up collaborative testing (Phase 5)
  resetGoldfish();
  resetTestLog();
  resetSideboardPlans();

  // Remove collab URL param
  const url = new URL(window.location.href);
  url.searchParams.delete('collab');
  window.history.replaceState({}, '', url.toString());

  hideToolbar();
  showToast('Collaborative session ended.', 'info');
}

/** Leave session (non-owner) */
export function leaveCollabSession(): void {
  getCollabManager().disconnect();
  collabActive = false;
  currentSessionId = null;

  // Clean up presence & locking (Phase 3)
  resetPresence();
  resetLocking();
  // Clean up team intelligence (Phase 4)
  resetTeamCollection();
  resetConstraints();
  resetPackages();
  // Clean up collaborative testing (Phase 5)
  resetGoldfish();
  resetTestLog();
  resetSideboardPlans();

  const url = new URL(window.location.href);
  url.searchParams.delete('collab');
  window.history.replaceState({}, '', url.toString());

  hideToolbar();
  showToast('Left collaborative session.', 'info');
}

// ───── Toolbar Rendering ─────

function showToolbar(): void {
  const toolbar = byId('collabToolbar');
  if (toolbar) toolbar.classList.remove('hidden');
  renderToolbar();
}

function hideToolbar(): void {
  const toolbar = byId('collabToolbar');
  if (toolbar) toolbar.classList.add('hidden');
}

function renderToolbar(): void {
  const toolbar = byId('collabToolbar');
  if (!toolbar) return;

  const mgr = getCollabManager();
  const state = mgr.state;
  const participants = mgr.currentParticipants;

  // Chat badge element
  const chatBadge = h('span', { className: 'collab-chat-badge' });

  // ── B3: Core panels (always visible) ──
  const coreButtons: HTMLElement[] = [
    // Draw button
    h('button', {
      className: `collab-btn collab-draw-toggle${isDrawingActive() ? ' active' : ''}`,
      onClick: () => { toggleDrawingMode(); renderToolbar(); },
      title: 'Toggle drawing mode',
 }, ' Draw'),
    // Chat button with unread badge
    h('button', {
      className: `collab-btn collab-chat-toggle${isChatOpen() ? ' active' : ''}`,
      onClick: () => exclusiveToggle(isChatOpen, toggleChatPanel),
      title: 'Toggle chat panel (Alt+C)',
 }, '❝ Chat', chatBadge),
    // Activity feed
    h('button', {
      className: `collab-btn collab-activity-toggle${isActivityPanelOpen() ? ' active' : ''}`,
      onClick: () => exclusiveToggle(isActivityPanelOpen, toggleActivityPanel),
      title: 'Activity feed (Alt+A)',
 }, '▤ Activity'),
    // Proposals with badge
    h('button', {
      className: `collab-btn collab-proposals-toggle${isProposalPanelOpen() ? ' active' : ''}`,
      onClick: () => exclusiveToggleWithBadge('proposals', isProposalPanelOpen, toggleProposalPanel),
      title: 'Change proposals (Alt+P)',
 }, '▥ Proposals', renderBadge('proposals')),
    // Tasks with badge
    h('button', {
      className: `collab-btn collab-tasks-toggle${isTaskPanelOpen() ? ' active' : ''}`,
      onClick: () => exclusiveToggleWithBadge('tasks', isTaskPanelOpen, toggleTaskPanel),
      title: 'Task board (Alt+K)',
 }, '✓ Tasks', renderBadge('tasks')),
  ];

  // ── B3: Overflow panels (hidden in "More…" dropdown) ──
  interface OverflowPanelConfig {
    key: string;
    icon: string;
    label: string;
    isOpen: () => boolean;
    toggle: () => void;
    title: string;
    badgeKey?: string;
  }
  const overflowPanels: OverflowPanelConfig[] = [
    { key: 'timeline', icon: '\u231B', label: 'Timeline', isOpen: isTimelinePanelOpen, toggle: () => exclusiveToggle(isTimelinePanelOpen, toggleTimelinePanel), title: 'Timeline / snapshots (Alt+T)' },
 { key: 'diff', icon: '◇', label: 'Diff', isOpen: isDiffPanelOpen, toggle: () => exclusiveToggle(isDiffPanelOpen, toggleDiffPanel), title: 'Deck diff (Alt+D)' },
 { key: 'threads', icon: '❝', label: 'Threads', isOpen: isThreadPanelOpen, toggle: () => exclusiveToggleWithBadge('threads', isThreadPanelOpen, toggleThreadPanel), title: 'Card discussions (Alt+H)', badgeKey: 'threads' },
 { key: 'decisions', icon: '▤', label: 'Decisions', isOpen: isDecisionPanelOpen, toggle: () => exclusiveToggleWithBadge('decisions', isDecisionPanelOpen, toggleDecisionPanel), title: 'Decision log (Alt+L)', badgeKey: 'decisions' },
 { key: 'collection', icon: '▢', label: 'Collection', isOpen: isTeamCollectionPanelOpen, toggle: () => exclusiveToggle(isTeamCollectionPanelOpen, toggleTeamCollectionPanel), title: 'Team collection pool (Alt+O)' },
 { key: 'constraints', icon: '⚙', label: 'Constraints', isOpen: isConstraintPanelOpen, toggle: () => exclusiveToggle(isConstraintPanelOpen, toggleConstraintPanel), title: 'Team constraints (Alt+N)' },
 { key: 'packages', icon: '▢', label: 'Packages', isOpen: isPackagePanelOpen, toggle: () => exclusiveToggle(isPackagePanelOpen, togglePackagePanel), title: 'Card packages (Alt+G)' },
 { key: 'spectator', icon: '▸', label: 'Spectator', isOpen: isSpectatorPanelOpen, toggle: () => exclusiveToggle(isSpectatorPanelOpen, toggleSpectatorPanel), title: 'Goldfish spectator (Alt+S)' },
 { key: 'tests', icon: '▤', label: 'Tests', isOpen: isTestLogPanelOpen, toggle: () => exclusiveToggleWithBadge('tests', isTestLogPanelOpen, toggleTestLogPanel), title: 'Test protocol (Alt+E)', badgeKey: 'tests' },
 { key: 'sideboard', icon: '■', label: 'Sideboard', isOpen: isSideboardPanelOpen, toggle: () => exclusiveToggleWithBadge('sideboard', isSideboardPanelOpen, toggleSideboardPanel), title: 'Sideboard plans (Alt+B)', badgeKey: 'sideboard' },
  ];

  // Extract pinned panels into the core area
  const pinnedButtons: HTMLElement[] = [];
  const remainingOverflow: OverflowPanelConfig[] = [];
  for (const panel of overflowPanels) {
    if (pinnedOverflowPanels.has(panel.key)) {
      pinnedButtons.push(
        h('button', {
          className: `collab-btn collab-${panel.key}-toggle${panel.isOpen() ? ' active' : ''}`,
          onClick: () => { panel.toggle(); },
          title: panel.title,
        }, `${panel.icon} ${panel.label}`, panel.badgeKey ? renderBadge(panel.badgeKey) : document.createTextNode('')),
      );
    } else {
      remainingOverflow.push(panel);
    }
  }

  // Check if any overflow panel has unread badges
  const overflowHasUnread = remainingOverflow.some((p) => p.badgeKey && (unreadCounts[p.badgeKey] || 0) > 0);
  const overflowHasActive = remainingOverflow.some((p) => p.isOpen());

  // Build the "More…" dropdown
  const overflowDropdown = h('div', { className: 'collab-overflow-wrapper' },
    h('button', {
      className: `collab-btn collab-more-btn${overflowOpen ? ' active' : ''}${overflowHasUnread ? ' collab-overflow-unread' : ''}${overflowHasActive ? ' collab-overflow-active' : ''}`,
      onClick: (e: Event) => {
        e.stopPropagation();
        overflowOpen = !overflowOpen;
        renderToolbar();
      },
      title: 'More tools…',
    }, `\u2026 More (${remainingOverflow.length})`),
    overflowOpen ? h('div', { className: 'collab-overflow-menu' },
      ...remainingOverflow.map((panel) =>
        h('div', { className: 'collab-overflow-row' },
          h('button', {
            className: `collab-overflow-item${panel.isOpen() ? ' active' : ''}`,
            onClick: () => { panel.toggle(); overflowOpen = false; },
            title: panel.title,
          }, `${panel.icon} ${panel.label}`, panel.badgeKey ? renderBadge(panel.badgeKey) : document.createTextNode('')),
          h('button', {
            className: 'collab-overflow-pin',
            onClick: (e: Event) => { e.stopPropagation(); togglePinPanel(panel.key); },
            title: 'Pin to toolbar',
 }, '◆'),
        ),
      ),
    ) : document.createTextNode(''),
  );

  toolbar.replaceChildren(
    // Connection status
    renderConnectionBadge(state),

    // D3: Viewer role badge
    ...(currentUserRole === 'viewer' ? [
 h('span', { className: 'collab-viewer-badge' }, '◇ Viewing'),
    ] : []),

    // Branch selector (Phase 1)
    createBranchSelector(),

    // Participant avatars
    renderParticipantAvatars(participants),

    // Presence bar (Phase 3)
    renderPresenceBar(),

    // Core panel buttons
    ...coreButtons,

    // Pinned overflow panels
    ...pinnedButtons,

    // Overflow dropdown with remaining panels
    ...(remainingOverflow.length > 0 ? [overflowDropdown] : []),

    // Share button — D1: One-click copy with fallback to modal
    h('button', {
      className: 'collab-btn collab-share-btn',
      onClick: () => {
        if (currentSessionId && typeof navigator !== 'undefined' && navigator.clipboard) {
          const url = new URL(window.location.href);
          url.searchParams.set('collab', currentSessionId);
          navigator.clipboard.writeText(url.toString()).then(() => {
            showToast('Invite link copied to clipboard!', 'success');
          }).catch(() => {
            showShareModal();
          });
        } else {
          showShareModal();
        }
      },
      title: 'Copy invite link (one-click)',
 }, '∞ Copy Link'),

    // End/Leave button
    ownerToken
      ? h('button', {
          className: 'collab-btn collab-end-btn',
          onClick: () => endCollabSession(),
          title: 'End session for all participants',
 }, ' End')
      : h('button', {
          className: 'collab-btn collab-leave-btn',
          onClick: () => leaveCollabSession(),
          title: 'Leave session',
 }, ' Leave'),
  );

  // Wire up the chat badge
  setChatBadgeElement(chatBadge);

  // Close overflow on outside click
  if (overflowOpen) {
    const closeOverflow = (e: MouseEvent) => {
      const wrapper = toolbar.querySelector('.collab-overflow-wrapper');
      if (wrapper && !wrapper.contains(e.target as Node)) {
        overflowOpen = false;
        renderToolbar();
        document.removeEventListener('click', closeOverflow);
      }
    };
    // Defer to avoid closing immediately
    requestAnimationFrame(() => document.addEventListener('click', closeOverflow));
  }
}

function renderConnectionBadge(state: CollabConnectionState): HTMLElement {
  const statusMap: Record<CollabConnectionState, { dot: string; label: string; cls: string }> = {
 connected: { dot: '●', label: 'Connected', cls: 'collab-status-connected' },
 connecting: { dot: '◐', label: 'Connecting...', cls: 'collab-status-connecting' },
 reconnecting: { dot: '◐', label: 'Reconnecting...', cls: 'collab-status-reconnecting' },
 disconnected: { dot: '●', label: 'Disconnected', cls: 'collab-status-disconnected' },
  };

  const info = statusMap[state];
  return h('span', { className: `collab-status ${info.cls}` },
    h('span', { className: 'collab-status-dot' }, info.dot),
    ` ${info.label}`,
  );
}

function renderParticipantAvatars(participants: CollabParticipant[]): HTMLElement {
  const container = h('div', { className: 'collab-participants' });

  for (const p of participants.slice(0, 8)) {
 const roleIcon = p.role === 'owner' ? ' ★' : p.role === 'viewer' ? ' ◇' : '';
    const titleText = `${p.name}${roleIcon}${p.userId ? ' (signed in)' : ''}`;

    let avatarEl: HTMLElement;
    if (p.avatarUrl) {
      // Use GitHub avatar image
      avatarEl = h('img', {
        className: 'collab-avatar collab-avatar-img',
        src: p.avatarUrl,
        alt: p.name,
        title: titleText,
        style: `border-color:${p.color};`,
      });
    } else {
      // Fallback to initial letter
      const initial = p.name.charAt(0).toUpperCase();
      avatarEl = h('span', {
        className: 'collab-avatar',
        style: `background:${p.color};`,
        title: titleText,
      }, initial);
    }

    // G3: Owner can right-click non-owner participants for ownership transfer + role actions
    if (ownerToken && p.role !== 'owner') {
      avatarEl.style.cursor = 'pointer';
      avatarEl.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        showParticipantContextMenu(e, p);
      });
    }

    container.appendChild(avatarEl);
  }

  if (participants.length > 8) {
    container.appendChild(
      h('span', { className: 'collab-avatar collab-avatar-more' },
        `+${participants.length - 8}`),
    );
  }

  return container;
}

/**
 * G3: Show a context menu for a participant (owner only).
 * Options: Transfer Ownership, Set Editor, Set Viewer.
 */
function showParticipantContextMenu(e: MouseEvent, participant: CollabParticipant): void {
  // Remove any existing context menu
  document.querySelectorAll('.collab-participant-menu').forEach((m) => m.remove());

  const menu = h('div', { className: 'collab-participant-menu' },
    h('div', { className: 'collab-participant-menu-header' }, `${participant.name} (${participant.role})`),
    h('button', {
      className: 'collab-participant-menu-item collab-participant-menu-transfer',
      onClick: () => {
        menu.remove();
        confirmTransferOwnership(participant);
      },
 }, ' Transfer Ownership'),
    ...(participant.role !== 'editor' ? [
      h('button', {
        className: 'collab-participant-menu-item',
        onClick: () => {
          menu.remove();
          getCollabManager().sendRoleAssign(participant.id, 'editor');
          showToast(`Set ${participant.name} to editor.`, 'info');
        },
 }, ' Set as Editor'),
    ] : []),
    ...(participant.role !== 'viewer' ? [
      h('button', {
        className: 'collab-participant-menu-item',
        onClick: () => {
          menu.remove();
          getCollabManager().sendRoleAssign(participant.id, 'viewer');
          showToast(`Set ${participant.name} to viewer.`, 'info');
        },
 }, '◇ Set as Viewer'),
    ] : []),
  );

  // Position at click location
  menu.style.position = 'fixed';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.style.zIndex = '9999';

  document.body.appendChild(menu);

  // Close on outside click
  const closeMenu = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  requestAnimationFrame(() => document.addEventListener('click', closeMenu));
}

/**
 * G3: Confirm and execute ownership transfer via confirm modal or toast.
 */
async function confirmTransferOwnership(participant: CollabParticipant): Promise<void> {
  // Use dynamic import for confirm modal to avoid circular deps
  const { showConfirmModal } = await import('./confirm-modal.js');
  const confirmed = await showConfirmModal({
    title: 'Transfer Session Ownership',
    message: `Transfer ownership to ${participant.name}? You will become an editor and lose owner privileges (end session, manage roles).`,
    confirmLabel: 'Transfer',
    cancelLabel: 'Cancel',
    danger: true,
  });

  if (!confirmed) return;

  getCollabManager().sendTransferOwnership(participant.id);
  // Locally update: we are no longer owner
  ownerToken = null;
  currentUserRole = 'editor';
  showToast(`Ownership transferred to ${participant.name}. You are now an editor.`, 'info');
  addActivity('ownership-transfer', getDisplayName(), `transferred ownership to ${participant.name}`);
  renderToolbar();
}

// ───── Share Modal ─────

function showShareModal(): void {
  if (!currentSessionId) return;

  // Build share URL
  const shareUrl = new URL(window.location.href);
  shareUrl.searchParams.set('collab', currentSessionId);

  const overlay = h('div', {
    className: 'collab-modal-overlay',
    onClick: (e: Event) => {
      if (e.target === overlay) overlay.remove();
    },
  },
    h('div', { className: 'collab-modal' },
 h('h3', { className: 'collab-modal-title' }, '∞ Share Session'),
      h('p', { className: 'collab-modal-desc' }, 'Share this link with others to collaborate on this deck in real-time:'),

      h('div', { className: 'collab-share-url-row' },
        h('input', {
          type: 'text',
          className: 'collab-share-input',
          value: shareUrl.toString(),
          readonly: true,
        }),
        h('button', {
          className: 'collab-btn collab-copy-btn',
          onClick: () => {
            navigator.clipboard.writeText(shareUrl.toString()).then(() => {
              showToast('Link copied to clipboard!', 'success');
              overlay.remove();
            }).catch(() => {
              showToast('Failed to copy link', 'error');
            });
          },
        }, 'Copy'),
      ),

      h('div', { className: 'collab-modal-info' },
        h('span', { className: 'muted' }, `Session ID: ${currentSessionId}`),
      ),

      h('button', {
        className: 'collab-btn',
        style: 'margin-top:12px;',
        onClick: () => overlay.remove(),
      }, 'Close'),
    ),
  );

  document.body.appendChild(overlay);

  // Auto-select the URL input
  const input = overlay.querySelector<HTMLInputElement>('.collab-share-input');
  if (input) {
    input.focus();
    input.select();
  }
}

// ───── Toast Notifications (unified — uses toast.ts) ─────

export function showToast(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
  showEditorToast({ message, type });
}

/** Show a toast with an action button (e.g. "View" to open a panel) */
function showToastWithAction(
  message: string,
  type: 'info' | 'success' | 'error',
  action?: { label: string; onClick: () => void },
): void {
  showEditorToast({ message, type, action });
}

// ───── Event Handlers ─────

const onStateChange: CollabEventHandler = (event: CollabEvent) => {
  // D4: Track when we disconnect for activity digest
  const data = event.data as { state?: string } | undefined;
  const mgr = getCollabManager();
  if (mgr.state === 'disconnected' || mgr.state === 'reconnecting') {
    if (!lastDisconnectTime) lastDisconnectTime = Date.now();
  }
  renderToolbar();
};

const onSync: CollabEventHandler = (event: CollabEvent) => {
  updateCurrentUserRole(); // D3: Track role on sync
  renderToolbar();
  applyViewerModeUI(); // D3: Apply viewer restrictions

  // D4: Show activity digest if we were away for > 5 minutes
  if (lastDisconnectTime) {
    const awayMs = Date.now() - lastDisconnectTime;
    lastDisconnectTime = null;
    if (awayMs >= DIGEST_THRESHOLD_MS) {
      const digest = buildActivityDigest(getRecentActivity(50), awayMs);
      if (digest) {
        showEditorToast({
          message: digest,
          type: 'info',
          duration: 15000,
          action: {
            label: 'View Activity',
            onClick: () => exclusiveToggle(isActivityPanelOpen, toggleActivityPanel),
          },
        });
      }
    }
  }

  // The editor-main.ts integration handles deck state sync
  addActivity('joined', getDisplayName(), 'connected to session');

  // Initialize all collab modules with the session/deck ID
  if (currentSessionId) {
    // Phase 1 modules
    initTimeline(currentSessionId, null, (boards: unknown) => {
      const evt = new CustomEvent('collab-restore-snapshot', { detail: { boards } });
      document.dispatchEvent(evt);
    });

    // Phase 2 modules
    initProposals(currentSessionId, (changes: unknown) => {
      const evt = new CustomEvent('collab-accept-proposal', { detail: { changes } });
      document.dispatchEvent(evt);
    });
    initThreads(currentSessionId);
    initDecisions(currentSessionId);
    initTasks(currentSessionId);

    // Phase 4 modules
    initTeamCollection(currentSessionId);
    initConstraints(currentSessionId);
    initPackages((cards: string[]) => {
      // Apply package callback — dispatch event for editor-main to handle
      const evt = new CustomEvent('collab-apply-package', { detail: { cards } });
      document.dispatchEvent(evt);
    });

    // Phase 5 modules
    initTestLog(currentSessionId);
    initSideboardPlans(currentSessionId);
  }
};

const onParticipantJoined: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { participant: CollabParticipant };
  showBatchableToast({ message: `${data.participant.name} joined the session`, type: 'info', batchKey: 'participant-join' });
  addActivity('joined', data.participant.name, 'joined the session');
  renderToolbar();
};

const onParticipantLeft: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { participantId: string };
  showBatchableToast({ message: 'A participant left the session', type: 'info', batchKey: 'participant-leave' });
  addActivity('left', 'Someone', 'left the session');
  renderToolbar();
};

const onError: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { message?: string };
  showToast(data.message || 'Connection error', 'error');
};

// ───── Helpers ─────

/**
 * D4: Build a human-readable activity digest for reconnection.
 * Aggregates recent activity entries into a summary string.
 */
function buildActivityDigest(activities: ActivityEntry[], awayMs: number): string | null {
  if (activities.length === 0) return null;

  const awayMinutes = Math.round(awayMs / 60000);
  const counts = { added: 0, removed: 0, updated: 0, proposals: 0, joined: 0, left: 0, other: 0 };
  const users = new Set<string>();

  for (const a of activities) {
    users.add(a.userName);
    if (a.action === 'card-add') counts.added++;
    else if (a.action === 'card-remove') counts.removed++;
    else if (a.action === 'card-update') counts.updated++;
    else if (a.action.includes('proposal')) counts.proposals++;
    else if (a.action === 'joined') counts.joined++;
    else if (a.action === 'left') counts.left++;
    else counts.other++;
  }

  const total = counts.added + counts.removed + counts.updated + counts.proposals + counts.other;
  if (total === 0) return null;

  const parts: string[] = [];
  if (counts.added > 0) parts.push(`+${counts.added} added`);
  if (counts.removed > 0) parts.push(`-${counts.removed} removed`);
  if (counts.updated > 0) parts.push(`${counts.updated} updated`);
  if (counts.proposals > 0) parts.push(`${counts.proposals} proposal${counts.proposals > 1 ? 's' : ''}`);

  const userCount = users.size;
  const prefix = awayMinutes >= 2 ? `While you were away (${awayMinutes}m): ` : 'While you were away: ';
  const userSuffix = userCount > 0 ? ` \u00B7 ${userCount} user${userCount > 1 ? 's' : ''} active` : '';

  return prefix + parts.join(', ') + userSuffix;
}

function getDisplayName(): string {
  // Use authenticated name if available
  const user = getUser();
  if (user) return user.displayName;

  // Try to get from localStorage, or generate a random one
  const stored = localStorage.getItem('decklens_collab_name');
  if (stored) return stored;

  const adjectives = ['Swift', 'Arcane', 'Mystic', 'Bold', 'Golden', 'Shadow', 'Iron', 'Silver'];
  const nouns = ['Mage', 'Knight', 'Dragon', 'Phoenix', 'Wizard', 'Forge', 'Blade', 'Owl'];
  const name = `${adjectives[Math.floor(Math.random() * adjectives.length)]}${nouns[Math.floor(Math.random() * nouns.length)]}`;
  localStorage.setItem('decklens_collab_name', name);
  return name;
}

/** Check if collab is currently active */
export function isCollabActive(): boolean {
  return collabActive;
}

/** Get the current session ID */
export function getSessionId(): string | null {
  return currentSessionId;
}

// ───── Auth UI ─────

/** Render the auth button in the deck editor header */
function renderAuthButton(): void {
  const container = byId('authButtonContainer');
  if (!container) return;

  const user = getUser();

  if (user) {
    // Logged in: show avatar + dropdown
    const avatarEl = user.avatarUrl
      ? h('img', {
          src: user.avatarUrl,
          className: 'auth-avatar-img',
          alt: user.displayName,
          title: `${user.displayName} (@${user.username})`,
        })
      : h('span', {
          className: 'auth-avatar-initial',
          title: `${user.displayName} (@${user.username})`,
        }, user.displayName.charAt(0).toUpperCase());

    const dropdown = h('div', { className: 'auth-dropdown' },
      h('div', { className: 'auth-dropdown-header' },
        h('strong', {}, user.displayName),
        h('span', { className: 'auth-dropdown-username' }, `@${user.username}`),
      ),
      h('button', {
        className: 'auth-dropdown-item',
        onClick: async () => {
          await logout();
          renderAuthButton();
        },
      }, 'Sign Out'),
    );

    const wrapper = h('div', { className: 'auth-avatar-wrapper' },
      avatarEl,
      dropdown,
    );

    wrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      wrapper.classList.toggle('auth-dropdown-open');
    });

    // Close dropdown on click outside
    document.addEventListener('click', () => {
      wrapper.classList.remove('auth-dropdown-open');
    });

    container.replaceChildren(wrapper);
  } else {
    // Not logged in: show login button with provider dropdown
    const loginDropdown = h('div', { className: 'auth-login-dropdown' },
      h('button', {
        className: 'auth-login-provider-btn auth-login-github',
        onClick: () => loginWithGitHub(),
 }, '◆ GitHub'),
      h('button', {
        className: 'auth-login-provider-btn auth-login-google',
        onClick: () => loginWithGoogle(),
 }, ' Google'),
    );

    const loginWrapper = h('div', { className: 'auth-login-wrapper' },
      h('button', {
        className: 'auth-login-btn',
        title: 'Sign in',
 }, '→ Sign In'),
      loginDropdown,
    );

    loginWrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      loginWrapper.classList.toggle('auth-login-open');
    });

    document.addEventListener('click', () => {
      loginWrapper.classList.remove('auth-login-open');
    });

    container.replaceChildren(loginWrapper);
  }
}

/** Send auth identity to collab session after sync */
const onSyncSendAuthIdentify: CollabEventHandler = () => {
  const user = getUser();
  if (user) {
    getCollabManager().sendAuthIdentify(user.id, user.username, user.displayName, user.avatarUrl);
  }
};

/** Handle auth-identified event (re-render toolbar to show avatars) */
const onAuthIdentified: CollabEventHandler = () => {
  renderToolbar();
};

/** Handle role-changed event */
const onRoleChanged: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { participantId: string; newRole: string; by: string };
  updateCurrentUserRole(); // D3: Re-check our role
  showToast(`Role changed to ${data.newRole} by ${data.by}`, 'info');
  renderToolbar();
  applyViewerModeUI(); // D3: Update viewer restrictions
};

/** G3: Handle ownership-transferred event — new owner receives their ownerToken */
const onOwnershipTransferred: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { ownerToken: string; previousOwner: string; newOwner: string };
  if (data.ownerToken) {
    // We are the new owner — store the token
    ownerToken = data.ownerToken;
 showToast(` You are now the session owner!`, 'success');
  }
  updateCurrentUserRole();
  renderToolbar();
  applyViewerModeUI();
  addActivity('ownership-transfer', data.previousOwner || 'Unknown', `transferred ownership to ${data.newOwner || 'another participant'}`);
};

/** Handle activity-logged event (Phase 1) */
const onActivityLogged: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { action: string; userName: string; detail: string };
  addActivity(data.action, data.userName, data.detail);
};

/** Handle snapshot-created event (Phase 1) */
const onSnapshotCreated: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { snapshotId: string; label: string; by: string };
 showToast(`◆ Snapshot "${data.label}" created by ${data.by}`, 'info');
  addActivity('snapshot-create', data.by, `created snapshot "${data.label}"`);
};

// ───── Decision Tools Event Handlers (Phase 2) ─────

const onProposalEvent: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { action: string; proposalId: string; title?: string; by: string };
  const labels: Record<string, string> = { created: 'created proposal', voted: 'voted on proposal', resolved: 'resolved proposal' };
  if (!isProposalPanelOpen()) unreadCounts.proposals++;
  showToastWithAction(
 `▥ ${data.by} ${labels[data.action] || data.action} "${data.title || ''}"`, 'info',
    { label: 'View', onClick: () => exclusiveToggleWithBadge('proposals', isProposalPanelOpen, toggleProposalPanel) },
  );
  addActivity('proposal-' + data.action, data.by, `${labels[data.action] || data.action} "${data.title || data.proposalId}"`);
  refreshProposals();
  renderToolbar();
};

const onThreadEvent: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { board: string; cardName: string; text: string; by: string };
  if (!isThreadPanelOpen()) unreadCounts.threads++;
  showToastWithAction(
 `❝ ${data.by} commented on ${data.cardName}`, 'info',
    { label: 'View', onClick: () => exclusiveToggleWithBadge('threads', isThreadPanelOpen, toggleThreadPanel) },
  );
  addActivity('thread-post', data.by, `commented on ${data.cardName}`);
  refreshThreads();
  renderToolbar();
};

const onDecisionEvent: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { cardName?: string; rationale: string; by: string };
  if (!isDecisionPanelOpen()) unreadCounts.decisions++;
  showToastWithAction(
 `▤ ${data.by} added decision${data.cardName ? ` for ${data.cardName}` : ''}`, 'info',
    { label: 'View', onClick: () => exclusiveToggleWithBadge('decisions', isDecisionPanelOpen, toggleDecisionPanel) },
  );
  addActivity('decision-add', data.by, `added decision${data.cardName ? ` for ${data.cardName}` : ''}`);
  refreshDecisions();
  renderToolbar();
};

const onTaskEvent: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { action: string; taskId: string; title?: string; by: string };
  const labels: Record<string, string> = { created: 'created task', updated: 'updated task', deleted: 'deleted task' };
  if (!isTaskPanelOpen()) unreadCounts.tasks++;
  showToastWithAction(
 `✓ ${data.by} ${labels[data.action] || data.action} "${data.title || ''}"`, 'info',
    { label: 'View', onClick: () => exclusiveToggleWithBadge('tasks', isTaskPanelOpen, toggleTaskPanel) },
  );
  addActivity('task-' + data.action, data.by, `${labels[data.action] || data.action} "${data.title || data.taskId}"`);
  refreshTasks();
  renderToolbar();
};

// ── Team Intelligence (Phase 4) ──

const onCollectionShared: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { participantName: string; cardCount: number };
 showToast(`▢ ${data.participantName} shared their collection (${data.cardCount} cards)`, 'info');
  addActivity('collection-shared', data.participantName, `shared their collection (${data.cardCount} cards)`);
  refreshTeamCollection();
};

const onConstraintEvent: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { action: string; constraintType: string; constraintValue?: string; by: string };
  const verb = data.action === 'set' ? 'set' : 'removed';
 showToast(` ${data.by} ${verb} ${data.constraintType} constraint${data.constraintValue ? `: ${data.constraintValue}` : ''}`, 'info');
  addActivity('constraint-' + data.action, data.by, `${verb} ${data.constraintType}${data.constraintValue ? `: ${data.constraintValue}` : ''}`);
  refreshConstraints();
};

// ── Collaborative Testing (Phase 5) ──

const onGoldfishStarted: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { by: string; deckName: string };
 showToast(` ${data.by} started goldfish testing "${data.deckName}"`, 'info');
  addActivity('goldfish-start', data.by, `started goldfish testing "${data.deckName}"`);
};

const onGoldfishEnded: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { by: string; result: string; turnCount: number };
 showToast(`✓ ${data.by} finished goldfish: ${data.result} (turn ${data.turnCount})`, 'info');
  addActivity('goldfish-end', data.by, `finished goldfish: ${data.result} (turn ${data.turnCount})`);
};

const onSideboardPlanEvent: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { action: string; matchup: string; by: string };
  const labels: Record<string, string> = { created: 'created', updated: 'updated', deleted: 'deleted' };
  if (!isSideboardPanelOpen()) unreadCounts.sideboard++;
  showToastWithAction(
 `■ ${data.by} ${labels[data.action] || data.action} sideboard plan for "${data.matchup}"`, 'info',
    { label: 'View', onClick: () => exclusiveToggleWithBadge('sideboard', isSideboardPanelOpen, toggleSideboardPanel) },
  );
  addActivity('sideboard-' + data.action, data.by, `${labels[data.action] || data.action} sideboard plan for "${data.matchup}"`);
  refreshSideboardPlans();
  renderToolbar();
};

const onTestSessionEvent: CollabEventHandler = (event: CollabEvent) => {
  const data = event.data as { action: string; sessionId: string; by: string };
  if (!isTestLogPanelOpen()) unreadCounts.tests++;
  showToastWithAction(
 `▤ ${data.by} logged a test session result`, 'info',
    { label: 'View', onClick: () => exclusiveToggleWithBadge('tests', isTestLogPanelOpen, toggleTestLogPanel) },
  );
  addActivity('test-session-logged', data.by, `logged a test session result`);
  refreshTestLog();
  renderToolbar();
};

// ───── D3: Viewer Role UI Filtering ─────

/**
 * Apply or remove viewer-mode restrictions on the editor UI.
 * When role === 'viewer': disable search, gray out +/- controls, show banner.
 * When role !== 'viewer': restore normal editing.
 */
function applyViewerModeUI(): void {
  const isViewer = currentUserRole === 'viewer';

  // 1. Persistent "Viewing" banner
  let banner = document.getElementById('viewerModeBanner');
  if (isViewer && !banner) {
    banner = document.createElement('div');
    banner.id = 'viewerModeBanner';
    banner.className = 'viewer-mode-banner';
 banner.textContent = '◇ Viewing — you have read-only access to this session';
    const toolbar = byId('collabToolbar');
    if (toolbar) toolbar.insertAdjacentElement('afterend', banner);
  } else if (!isViewer && banner) {
    banner.remove();
  }

  // 2. Disable/enable search input
  const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
  if (searchInput) {
    searchInput.disabled = isViewer;
    searchInput.placeholder = isViewer ? 'Search disabled (viewer mode)' : 'Search for cards…';
  }

  // 3. Toggle .viewer-mode class on editor body for CSS-driven disabling
  document.body.classList.toggle('collab-viewer-mode', isViewer);

  // 4. Disable +/- quantity buttons and remove buttons in card rows
  const qtyBtns = document.querySelectorAll<HTMLButtonElement>('.qty-btn, .card-remove-btn');
  qtyBtns.forEach((btn) => { btn.disabled = isViewer; });
}
