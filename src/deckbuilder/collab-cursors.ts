/**
 * CollabCursors — Live remote cursor rendering for collaborative editing.
 *
 * Tracks local mouse movement (throttled to ~100ms) and renders
 * coloured cursor dots + name labels for each remote participant.
 * All coordinates are normalised 0–1 (relative to viewport) so
 * different screen sizes work correctly.
 */

import { h } from '../shared/dom.js';
import { getCollabManager, type CollabEvent } from './collab-manager.js';
import { isCollabActive } from './collab-ui.js';

// ───── State ─────

interface RemoteCursor {
  el: HTMLElement;
  lastSeen: number;
}

const remoteCursors: Map<string, RemoteCursor> = new Map();
let cursorContainer: HTMLElement | null = null;
let localTrackingActive = false;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let fadeCheckTimer: ReturnType<typeof setInterval> | null = null;

const THROTTLE_MS = 80;
const FADE_AFTER_MS = 5000;
const FADE_CHECK_INTERVAL_MS = 1000;

// ───── Initialization ─────

/** Call once after DOM is ready. Wires up CollabManager events. */
export function initCollabCursors(): void {
  const mgr = getCollabManager();
  mgr.on('remote-cursor-move', onRemoteCursorMove);
  mgr.on('participant-left', onParticipantLeft);
  mgr.on('connected', onConnected);
  mgr.on('disconnected', onDisconnected);
}

// ───── Local Cursor Tracking ─────

function startLocalTracking(): void {
  if (localTrackingActive) return;
  localTrackingActive = true;
  document.addEventListener('mousemove', onLocalMouseMove, { passive: true });

  // Start fade-check interval
  fadeCheckTimer = setInterval(checkFadedCursors, FADE_CHECK_INTERVAL_MS);
}

function stopLocalTracking(): void {
  localTrackingActive = false;
  document.removeEventListener('mousemove', onLocalMouseMove);
  if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
  if (fadeCheckTimer) { clearInterval(fadeCheckTimer); fadeCheckTimer = null; }
  cleanupAllCursors();
}

function onLocalMouseMove(e: MouseEvent): void {
  if (throttleTimer) return;
  throttleTimer = setTimeout(() => { throttleTimer = null; }, THROTTLE_MS);

  if (!isCollabActive()) return;

  const x = e.clientX / window.innerWidth;
  const y = e.clientY / window.innerHeight;
  getCollabManager().sendCursorMove(x, y);
}

// ───── Remote Cursor Rendering ─────

function ensureContainer(): HTMLElement {
  if (cursorContainer && document.body.contains(cursorContainer)) return cursorContainer;
  cursorContainer = h('div', { id: 'collabCursorContainer' });
  document.body.appendChild(cursorContainer);
  return cursorContainer;
}

/** D5: Hide cursors during drawing mode (avoids visual clutter) */
let hiddenDuringDrawing = false;
export function setCursorsHiddenDuringDrawing(hidden: boolean): void {
  hiddenDuringDrawing = hidden;
  if (cursorContainer) {
    cursorContainer.style.display = hidden ? 'none' : '';
  }
}

function onRemoteCursorMove(event: CollabEvent): void {
  if (hiddenDuringDrawing) return;
  const data = event.data as {
    participantId: string;
    name: string;
    color: string;
    x: number;
    y: number;
  };

  const container = ensureContainer();
  let cursor = remoteCursors.get(data.participantId);

  if (!cursor) {
    // Create new cursor element
    const el = h('div', { className: 'collab-cursor' },
      h('div', { className: 'collab-cursor-dot', style: `background:${data.color};` }),
      h('span', { className: 'collab-cursor-label', style: `color:${data.color};` }, data.name),
    );
    container.appendChild(el);
    cursor = { el, lastSeen: Date.now() };
    remoteCursors.set(data.participantId, cursor);
  }

  // Update position using transform for GPU acceleration
  const px = data.x * window.innerWidth;
  const py = data.y * window.innerHeight;
  cursor.el.style.transform = `translate(${px}px, ${py}px)`;
  cursor.lastSeen = Date.now();
  cursor.el.classList.remove('collab-cursor-faded');
}

function checkFadedCursors(): void {
  const now = Date.now();
  for (const [id, cursor] of remoteCursors) {
    if (now - cursor.lastSeen > FADE_AFTER_MS) {
      cursor.el.classList.add('collab-cursor-faded');
    }
  }
}

// ───── Cleanup ─────

function onParticipantLeft(event: CollabEvent): void {
  const data = event.data as { participantId: string };
  const cursor = remoteCursors.get(data.participantId);
  if (cursor) {
    cursor.el.remove();
    remoteCursors.delete(data.participantId);
  }
}

function cleanupAllCursors(): void {
  for (const [, cursor] of remoteCursors) {
    cursor.el.remove();
  }
  remoteCursors.clear();
}

// ───── Connection Events ─────

function onConnected(): void {
  startLocalTracking();
}

function onDisconnected(): void {
  stopLocalTracking();
}

/** Tear down cursors completely (e.g. when leaving session) */
export function destroyCollabCursors(): void {
  stopLocalTracking();
  if (cursorContainer) {
    cursorContainer.remove();
    cursorContainer = null;
  }
}
