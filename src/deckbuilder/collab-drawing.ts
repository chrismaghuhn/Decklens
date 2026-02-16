/**
 * CollabDrawing — Full-page canvas overlay for collaborative drawing annotations.
 *
 * Supports pen, line, arrow, circle, and eraser tools. All coordinates are
 * normalised 0–1 relative to the viewport for cross-device compatibility.
 * Strokes are scoped per board+branch and broadcast via WebSocket.
 */

import { h } from '../shared/dom.js';
import { getCollabManager, type CollabEvent } from './collab-manager.js';
import { getCurrentBranchId } from './collab-branches.js';
import { getActiveBoard } from './editor-main.js';

// ───── Types ─────

type DrawTool = 'pen' | 'line' | 'arrow' | 'circle' | 'eraser';

interface StrokeData {
  color: string;
  tool: string;
  points: [number, number][];
  lineWidth: number;
}

interface LocalStroke extends StrokeData {
  id: string;
}

interface RemoteStroke {
  participantId: string;
  color: string;
  stroke: { id: string; tool: string; points: [number, number][]; lineWidth: number };
  board?: string;
  branchId?: string;
}

// ───── Constants ─────

const DRAW_COLORS = ['#e2b340', '#ef4444', '#3b82f6', '#22c55e', '#e8e2d6', '#a855f7'];
const LINE_WIDTHS = [
  { label: 'Thin', value: 2 },
  { label: 'Medium', value: 4 },
  { label: 'Thick', value: 8 },
];

// ───── State ─────

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let toolbar: HTMLElement | null = null;
let isDrawingMode = false;
let currentTool: DrawTool = 'pen';
let currentLineWidth = 3;
let isDrawing = false;
let currentStroke: LocalStroke | null = null;
let localColor = '#e2b340'; // gold default, updated on connect

// Board+branch scoped stroke storage
const strokesByScope = new Map<string, StrokeData[]>();
const localStrokesByScope = new Map<string, LocalStroke[]>();

// ───── Scope Helpers ─────

function getScopeKey(): string {
  const branchId = getCurrentBranchId() || 'default';
  const board = getActiveBoard();
  return `${branchId}:${board}`;
}

function getScopedStrokes(): StrokeData[] {
  const key = getScopeKey();
  if (!strokesByScope.has(key)) strokesByScope.set(key, []);
  return strokesByScope.get(key)!;
}

function getScopedLocalStrokes(): LocalStroke[] {
  const key = getScopeKey();
  if (!localStrokesByScope.has(key)) localStrokesByScope.set(key, []);
  return localStrokesByScope.get(key)!;
}

function getStrokesForScope(board?: string, branchId?: string): StrokeData[] {
  const key = `${branchId || 'default'}:${board || getActiveBoard()}`;
  if (!strokesByScope.has(key)) strokesByScope.set(key, []);
  return strokesByScope.get(key)!;
}

// ───── Initialization ─────

/** Call once after DOM is ready. Wires up CollabManager events. */
export function initCollabDrawing(): void {
  const mgr = getCollabManager();
  mgr.on('remote-draw-stroke', onRemoteDrawStroke);
  mgr.on('remote-draw-clear', onRemoteDrawClear);
  mgr.on('sync', onSync);
  mgr.on('disconnected', onDisconnected);

  // Redraw when board or branch changes
  window.addEventListener('deckbuilder-board-changed', () => redrawAll());
  mgr.on('remote-branch-switch', () => redrawAll());
}

// ───── Toggle Drawing Mode ─────

/** Toggle drawing mode on/off */
export function toggleDrawingMode(): void {
  if (isDrawingMode) {
    deactivateDrawing();
  } else {
    activateDrawing();
  }
}

/** Check if drawing mode is active */
export function isDrawingActive(): boolean {
  return isDrawingMode;
}

function activateDrawing(): void {
  if (!canvas) createCanvas();
  if (!toolbar) createToolbar();

  isDrawingMode = true;
  canvas!.style.pointerEvents = 'auto';
  canvas!.style.background = 'rgba(10,14,23,0.08)';
  canvas!.classList.add('collab-draw-active');
  toolbar!.classList.add('collab-draw-toolbar-visible');
  updateToolbarActiveState();

  // Resize canvas to viewport
  resizeCanvas();
  redrawAll();
}

function deactivateDrawing(): void {
  isDrawingMode = false;
  if (canvas) {
    canvas.style.pointerEvents = 'none';
    canvas.style.background = 'transparent';
    canvas.classList.remove('collab-draw-active');
  }
  toolbar?.classList.remove('collab-draw-toolbar-visible');
}

// ───── Canvas Setup ─────

function createCanvas(): void {
  canvas = document.createElement('canvas');
  canvas.id = 'collabDrawCanvas';
  canvas.className = 'collab-draw-canvas';
  ctx = canvas.getContext('2d')!;
  document.body.appendChild(canvas);

  // Wire up pointer events
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  // Handle resize
  window.addEventListener('resize', () => {
    if (canvas) {
      resizeCanvas();
      redrawAll();
    }
  });

  resizeCanvas();
}

function resizeCanvas(): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ───── Drawing Toolbar ─────

function createToolbar(): void {
  const tools: { tool: DrawTool; label: string; icon: string }[] = [
    { tool: 'pen', label: 'Pen', icon: '\u270F\uFE0F' },
    { tool: 'line', label: 'Line', icon: '\uD83D\uDCCF' },
    { tool: 'arrow', label: 'Arrow', icon: '\u27A1\uFE0F' },
    { tool: 'circle', label: 'Circle', icon: '\u2B55' },
    { tool: 'eraser', label: 'Eraser', icon: '\uD83E\uDDF9' },
  ];

  const toolButtons = tools.map(({ tool, label, icon }) =>
    h('button', {
      className: `collab-draw-btn`,
      'data-tool': tool,
      title: label,
      onClick: () => {
        currentTool = tool;
        updateToolbarActiveState();
      },
    }, icon),
  );

  const separator = h('span', { className: 'collab-draw-separator' }, '|');

  // Color swatches
  const colorSwatches = DRAW_COLORS.map((color) =>
    h('button', {
      className: 'collab-draw-color',
      'data-color': color,
      style: `background:${color};`,
      title: color,
      onClick: () => {
        localColor = color;
        updateToolbarActiveState();
      },
    }),
  );

  const separator1b = h('span', { className: 'collab-draw-separator' }, '|');

  // Line width buttons
  const widthButtons = LINE_WIDTHS.map(({ label, value }) =>
    h('button', {
      className: 'collab-draw-width-btn',
      'data-width': String(value),
      title: label,
      onClick: () => {
        currentLineWidth = value;
        updateToolbarActiveState();
      },
    }, label),
  );

  const separator2 = h('span', { className: 'collab-draw-separator' }, '|');

  const undoBtn = h('button', {
    className: 'collab-draw-btn',
    title: 'Undo last stroke',
    onClick: undoLastStroke,
  }, '\u21A9\uFE0F');

  const clearBtn = h('button', {
    className: 'collab-draw-btn',
    title: 'Clear all drawings',
    onClick: clearAllDrawings,
  }, '\uD83D\uDDD1\uFE0F');

  const separator3 = h('span', { className: 'collab-draw-separator' }, '|');

  const closeBtn = h('button', {
    className: 'collab-draw-btn collab-draw-close',
    title: 'Close drawing mode',
    onClick: () => deactivateDrawing(),
  }, '\u2715');

  toolbar = h('div', { className: 'collab-draw-toolbar' },
    ...toolButtons,
    separator,
    ...colorSwatches,
    separator1b,
    ...widthButtons,
    separator2,
    undoBtn,
    clearBtn,
    separator3,
    closeBtn,
  );

  document.body.appendChild(toolbar);
}

function updateToolbarActiveState(): void {
  if (!toolbar) return;
  toolbar.querySelectorAll<HTMLElement>('.collab-draw-btn[data-tool]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === currentTool);
  });
  toolbar.querySelectorAll<HTMLElement>('.collab-draw-color').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.color === localColor);
  });
  toolbar.querySelectorAll<HTMLElement>('.collab-draw-width-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.width === String(currentLineWidth));
  });
}

// ───── Pointer Events ─────

function onPointerDown(e: PointerEvent): void {
  if (!isDrawingMode || !canvas) return;
  isDrawing = true;
  canvas.setPointerCapture(e.pointerId);

  const x = e.clientX / window.innerWidth;
  const y = e.clientY / window.innerHeight;

  const strokeColor = currentTool === 'eraser' ? '#000000' : localColor;
  const strokeWidth = currentTool === 'eraser' ? 10 : currentLineWidth;

  currentStroke = {
    id: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    tool: currentTool,
    points: [[x, y]],
    lineWidth: strokeWidth,
    color: strokeColor,
  };
}

function onPointerMove(e: PointerEvent): void {
  if (!isDrawing || !currentStroke || !ctx) return;

  const x = e.clientX / window.innerWidth;
  const y = e.clientY / window.innerHeight;
  currentStroke.points.push([x, y]);

  // Live preview
  redrawAll();
  renderStroke(ctx, currentStroke.color, currentStroke.tool, currentStroke.points, currentStroke.lineWidth);
}

function onPointerUp(_e: PointerEvent): void {
  if (!isDrawing || !currentStroke) return;
  isDrawing = false;

  // Only send if we have meaningful points
  if (currentStroke.points.length >= 2) {
    const scopedAll = getScopedStrokes();
    const scopedLocal = getScopedLocalStrokes();

    // Add to scoped strokes
    scopedLocal.push(currentStroke);
    scopedAll.push({
      color: currentStroke.color,
      tool: currentStroke.tool,
      points: currentStroke.points,
      lineWidth: currentStroke.lineWidth,
    });

    // Send to server with board + branch scope
    const board = getActiveBoard();
    const branchId = getCurrentBranchId() || undefined;
    getCollabManager().sendDrawStroke({
      id: currentStroke.id,
      tool: currentStroke.tool,
      points: currentStroke.points,
      lineWidth: currentStroke.lineWidth,
    }, board, branchId);
  }

  currentStroke = null;
  redrawAll();
}

// ───── Rendering ─────

function redrawAll(): void {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const scopedStrokes = getScopedStrokes();
  for (const stroke of scopedStrokes) {
    renderStroke(ctx, stroke.color, stroke.tool, stroke.points, stroke.lineWidth);
  }
}

function renderStroke(
  c: CanvasRenderingContext2D,
  color: string,
  tool: string,
  points: [number, number][],
  lineWidth: number,
): void {
  if (points.length < 1) return;
  const w = window.innerWidth;
  const vh = window.innerHeight;

  // Eraser uses destination-out composite
  const isEraser = tool === 'eraser';
  if (isEraser) {
    c.globalCompositeOperation = 'destination-out';
    c.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    c.globalCompositeOperation = 'source-over';
    c.strokeStyle = color;
  }
  c.lineWidth = lineWidth;
  c.lineCap = 'round';
  c.lineJoin = 'round';

  if (tool === 'pen' || isEraser) {
    c.beginPath();
    c.moveTo(points[0][0] * w, points[0][1] * vh);
    for (let i = 1; i < points.length; i++) {
      c.lineTo(points[i][0] * w, points[i][1] * vh);
    }
    c.stroke();
  } else if (tool === 'line' || tool === 'arrow') {
    const start = points[0];
    const end = points[points.length - 1];
    c.beginPath();
    c.moveTo(start[0] * w, start[1] * vh);
    c.lineTo(end[0] * w, end[1] * vh);
    c.stroke();

    // Arrow head
    if (tool === 'arrow') {
      drawArrowHead(c, start[0] * w, start[1] * vh, end[0] * w, end[1] * vh, color, lineWidth);
    }
  } else if (tool === 'circle') {
    const start = points[0];
    const end = points[points.length - 1];
    const cx = ((start[0] + end[0]) / 2) * w;
    const cy = ((start[1] + end[1]) / 2) * vh;
    const rx = Math.abs(end[0] - start[0]) / 2 * w;
    const ry = Math.abs(end[1] - start[1]) / 2 * vh;
    c.beginPath();
    c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    c.stroke();
  }

  // Reset composite mode
  if (isEraser) {
    c.globalCompositeOperation = 'source-over';
  }
}

function drawArrowHead(
  c: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  color: string, lineWidth: number,
): void {
  const headLen = Math.max(12, lineWidth * 4);
  const angle = Math.atan2(y2 - y1, x2 - x1);

  c.fillStyle = color;
  c.beginPath();
  c.moveTo(x2, y2);
  c.lineTo(
    x2 - headLen * Math.cos(angle - Math.PI / 6),
    y2 - headLen * Math.sin(angle - Math.PI / 6),
  );
  c.lineTo(
    x2 - headLen * Math.cos(angle + Math.PI / 6),
    y2 - headLen * Math.sin(angle + Math.PI / 6),
  );
  c.closePath();
  c.fill();
}

// ───── Actions ─────

function undoLastStroke(): void {
  const scopedLocal = getScopedLocalStrokes();
  const scopedAll = getScopedStrokes();
  if (scopedLocal.length === 0) return;
  scopedLocal.pop();
  scopedAll.pop();
  redrawAll();
}

function clearAllDrawings(): void {
  const scopedLocal = getScopedLocalStrokes();
  const scopedAll = getScopedStrokes();
  scopedLocal.length = 0;
  scopedAll.length = 0;
  const board = getActiveBoard();
  const branchId = getCurrentBranchId() || undefined;
  getCollabManager().sendDrawClear(board, branchId);
  redrawAll();
}

// ───── Event Handlers ─────

function onRemoteDrawStroke(event: CollabEvent): void {
  const data = event.data as RemoteStroke;
  const strokes = getStrokesForScope(data.board, data.branchId);
  strokes.push({
    color: data.color,
    tool: data.stroke.tool,
    points: data.stroke.points,
    lineWidth: data.stroke.lineWidth,
  });
  // Only redraw if the stroke is for the current scope
  const remoteKey = `${data.branchId || 'default'}:${data.board || getActiveBoard()}`;
  if (remoteKey === getScopeKey()) redrawAll();
}

function onRemoteDrawClear(event: CollabEvent): void {
  const data = event.data as { by: string; board?: string; branchId?: string };
  const strokes = getStrokesForScope(data.board, data.branchId);
  strokes.length = 0;
  // Also clear local strokes for that scope
  const key = `${data.branchId || 'default'}:${data.board || getActiveBoard()}`;
  const local = localStrokesByScope.get(key);
  if (local) local.length = 0;
  if (key === getScopeKey()) redrawAll();
}

function onSync(event: CollabEvent): void {
  // Get local color from participants list
  const data = event.data as { participants?: Array<{ id: string; color: string }> };
  if (data.participants && data.participants.length > 0) {
    // Our color is from the last participant (we just joined)
    localColor = data.participants[data.participants.length - 1].color;
  }
}

function onDisconnected(): void {
  deactivateDrawing();
  strokesByScope.clear();
  localStrokesByScope.clear();
  if (ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

/** Destroy drawing canvas and toolbar */
export function destroyCollabDrawing(): void {
  deactivateDrawing();
  canvas?.remove();
  canvas = null;
  ctx = null;
  toolbar?.remove();
  toolbar = null;
  strokesByScope.clear();
  localStrokesByScope.clear();
}
