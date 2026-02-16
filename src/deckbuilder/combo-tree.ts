/**
 * Combo Tree — Interactive SVG Force-Graph in a Floating Window.
 *
 * Visualises the combo network: card-nodes orbit combo-hub hexagons,
 * shared cards bridge multiple hubs. Force-directed layout, draggable
 * nodes, pan, zoom, hover-highlight, click-to-open Spellbook link.
 *
 * Zero runtime dependencies — vanilla SVG + DOM only.
 */

import type { DeckCoach, ComboPiece } from './goldfish-coach.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

interface GraphNode {
  id: string;
  type: 'card' | 'combo';
  label: string;
  // Card-specific
  cardName?: string;
  imageUrl?: string;
  inDeck?: boolean;
  // Combo-specific
  comboName?: string;
  source?: 'spellbook' | 'catalog' | 'community';
  matchLevel?: 'complete' | 'near-miss' | 'partial';
  produces?: string[];
  resultTags?: string[];
  spellbookUrl?: string;
  hasTemplateReqs?: boolean;
  description?: string;
  // Layout
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
  radius: number;
}

interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: 'combo-piece' | 'missing-piece';
}

interface ComboGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type FilterMode = 'all' | 'complete' | 'near-miss' | 'partial';

// ═══════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════

const NS = 'http://www.w3.org/2000/svg';
const CARD_RADIUS = 16;
const COMBO_RADIUS = 24;
const FORCE_ITERATIONS = 65;
const REPULSION = 3200;
const ATTRACTION = 0.008;
const GRAVITY = 0.02;
const DAMPING = 0.82;
const MAX_VELOCITY = 20;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3.0;

const WIN_WIDTH = 620;
const WIN_HEIGHT = 480;

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function norm(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function shortLabel(name: string, max = 14): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + '\u2026';
}

/** Build hexagon points string for an SVG <polygon> centered at (cx,cy) */
function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
  }
  return pts.join(' ');
}

// ═══════════════════════════════════════════════════════
// 1. Build Graph from Coach Data
// ═══════════════════════════════════════════════════════

function buildComboGraph(
  coach: DeckCoach,
  filter: FilterMode,
): ComboGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const cardNodeMap = new Map<string, GraphNode>();

  // Filter combo pieces
  let pieces = coach.comboPieces;
  if (filter !== 'all') {
    pieces = pieces.filter((cp) => {
      const level = cp.matchLevel || 'complete';
      return level === filter;
    });
  }

  // Cap at 25 combos for readability
  pieces = pieces.slice(0, 25);

  for (const cp of pieces) {
    // Combo hub node
    const comboId = `combo:${norm(cp.comboName)}`;
    const comboNode: GraphNode = {
      id: comboId,
      type: 'combo',
      label: shortLabel(cp.comboName, 20),
      comboName: cp.comboName,
      source: cp.source,
      matchLevel: cp.matchLevel || 'complete',
      produces: cp.produces,
      resultTags: cp.resultTags,
      spellbookUrl: cp.spellbookUrl,
      hasTemplateReqs: cp.hasTemplateReqs,
      description: cp.description,
      x: 0, y: 0, vx: 0, vy: 0,
      pinned: false,
      radius: COMBO_RADIUS,
    };
    nodes.push(comboNode);

    // Card nodes (deduplicated across combos)
    const missingSet = new Set((cp.missingCards || []).map(norm));

    for (const cardName of cp.cards) {
      const key = norm(cardName);
      let cardNode = cardNodeMap.get(key);

      if (!cardNode) {
        const inDeck = coach.deckCardNames.has(key);
        const isMissing = missingSet.has(key) || !inDeck;
        const cardData = coach.cardByName[key];
        const imageUrl = cardData?.image_uris?.small || '';

        cardNode = {
          id: `card:${key}`,
          type: 'card',
          label: shortLabel(cardName, 14),
          cardName,
          imageUrl,
          inDeck: !isMissing,
          x: 0, y: 0, vx: 0, vy: 0,
          pinned: false,
          radius: CARD_RADIUS,
        };
        cardNodeMap.set(key, cardNode);
        nodes.push(cardNode);
      }

      // Edge: card → combo
      edges.push({
        sourceId: cardNode.id,
        targetId: comboId,
        type: missingSet.has(key) || !cardNode.inDeck ? 'missing-piece' : 'combo-piece',
      });
    }
  }

  return { nodes, edges };
}

// ═══════════════════════════════════════════════════════
// 2. Force-Directed Layout
// ═══════════════════════════════════════════════════════

function forceLayout(graph: ComboGraph, width: number, height: number): void {
  const { nodes, edges } = graph;
  if (nodes.length === 0) return;

  const cx = width / 2;
  const cy = height / 2;

  // Initial positions: combos in a ring, cards near their first combo
  const combos = nodes.filter((n) => n.type === 'combo');
  const cards = nodes.filter((n) => n.type === 'card');

  // Place combos in a circle
  const comboRing = Math.min(width, height) * 0.28;
  combos.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(combos.length, 1);
    n.x = cx + comboRing * Math.cos(angle);
    n.y = cy + comboRing * Math.sin(angle);
  });

  // Place cards near their first connected combo
  const comboPos = new Map<string, { x: number; y: number }>();
  for (const c of combos) comboPos.set(c.id, { x: c.x, y: c.y });

  for (const card of cards) {
    const edge = edges.find((e) => e.sourceId === card.id);
    const hub = edge ? comboPos.get(edge.targetId) : null;
    if (hub) {
      const jitter = () => (Math.random() - 0.5) * 60;
      card.x = hub.x + jitter();
      card.y = hub.y + jitter();
    } else {
      card.x = cx + (Math.random() - 0.5) * width * 0.5;
      card.y = cy + (Math.random() - 0.5) * height * 0.5;
    }
  }

  // Build adjacency
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.sourceId)) adj.set(e.sourceId, new Set());
    if (!adj.has(e.targetId)) adj.set(e.targetId, new Set());
    adj.get(e.sourceId)!.add(e.targetId);
    adj.get(e.targetId)!.add(e.sourceId);
  }

  // Simulate
  for (let iter = 0; iter < FORCE_ITERATIONS; iter++) {
    const alpha = 1 - iter / FORCE_ITERATIONS;

    // Repulsion (all pairs — O(n^2), fine for n < 100)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist2 = dx * dx + dy * dy + 1;
        const force = REPULSION * alpha / dist2;
        const dist = Math.sqrt(dist2);
        dx /= dist;
        dy /= dist;
        if (!a.pinned) { a.vx -= dx * force; a.vy -= dy * force; }
        if (!b.pinned) { b.vx += dx * force; b.vy += dy * force; }
      }
    }

    // Attraction (connected pairs)
    for (const e of edges) {
      const a = nodes.find((n) => n.id === e.sourceId);
      const b = nodes.find((n) => n.id === e.targetId);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      // Target distance based on node sizes
      const ideal = a.radius + b.radius + 40;
      const force = (dist - ideal) * ATTRACTION * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.pinned) { a.vx += fx; a.vy += fy; }
      if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
    }

    // Gravity toward center
    for (const n of nodes) {
      if (n.pinned) continue;
      n.vx += (cx - n.x) * GRAVITY * alpha;
      n.vy += (cy - n.y) * GRAVITY * alpha;
    }

    // Apply velocities with damping
    for (const n of nodes) {
      if (n.pinned) continue;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      // Clamp velocity
      const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (speed > MAX_VELOCITY) {
        n.vx = (n.vx / speed) * MAX_VELOCITY;
        n.vy = (n.vy / speed) * MAX_VELOCITY;
      }
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  // Zero out velocities after layout
  for (const n of nodes) { n.vx = 0; n.vy = 0; }
}

// ═══════════════════════════════════════════════════════
// 3. SVG Rendering
// ═══════════════════════════════════════════════════════

function renderGraph(
  svg: SVGSVGElement,
  graph: ComboGraph,
  state: TreeState,
): void {
  // Clear
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const { nodes, edges } = graph;
  if (nodes.length === 0) {
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', '50%');
    text.setAttribute('y', '50%');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', '#475569');
    text.setAttribute('font-size', '14');
    text.textContent = 'No combos to display';
    svg.appendChild(text);
    return;
  }

  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  // ── Edges ──
  const edgeGroup = document.createElementNS(NS, 'g');
  edgeGroup.setAttribute('class', 'ct-edges-group');

  for (const e of edges) {
    const src = nodeMap.get(e.sourceId);
    const tgt = nodeMap.get(e.targetId);
    if (!src || !tgt) continue;

    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String(src.x));
    line.setAttribute('y1', String(src.y));
    line.setAttribute('x2', String(tgt.x));
    line.setAttribute('y2', String(tgt.y));
    line.setAttribute('class', `ct-edge ct-edge-${e.type}`);
    line.dataset.source = e.sourceId;
    line.dataset.target = e.targetId;
    edgeGroup.appendChild(line);
  }
  svg.appendChild(edgeGroup);

  // ── Nodes ──
  const nodeGroup = document.createElementNS(NS, 'g');
  nodeGroup.setAttribute('class', 'ct-nodes-group');

  for (const n of nodes) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'ct-node-group');
    g.dataset.nodeId = n.id;
    g.setAttribute('transform', `translate(${n.x},${n.y})`);

    if (n.type === 'combo') {
      // Hexagon
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', hexPoints(0, 0, n.radius));
      let cls = 'ct-node-combo';
      if (n.matchLevel === 'near-miss') cls += ' ct-near';
      else if (n.matchLevel === 'partial') cls += ' ct-partial';
      poly.setAttribute('class', cls);
      g.appendChild(poly);

      // Label
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('class', 'ct-label ct-label-combo');
      text.setAttribute('y', '4');
      text.setAttribute('text-anchor', 'middle');
      text.textContent = n.label;
      g.appendChild(text);

      // Source badge
      if (n.source) {
        const badge = document.createElementNS(NS, 'text');
        badge.setAttribute('class', 'ct-badge');
        badge.setAttribute('y', String(-n.radius - 5));
        badge.setAttribute('text-anchor', 'middle');
        badge.setAttribute('font-size', '8');
        badge.textContent = n.source === 'spellbook' ? 'CS' : n.source === 'catalog' ? 'DL' : 'COM';
        g.appendChild(badge);
      }
    } else {
      // Card circle
      const circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('r', String(n.radius));
      let cls = 'ct-node-card';
      if (!n.inDeck) cls += ' ct-missing';
      circle.setAttribute('class', cls);
      g.appendChild(circle);

      // Label
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('class', 'ct-label');
      text.setAttribute('y', String(n.radius + 12));
      text.setAttribute('text-anchor', 'middle');
      text.textContent = n.label;
      g.appendChild(text);
    }

    // ── Interactions ──
    setupNodeInteractions(g, n, svg, graph, state);

    nodeGroup.appendChild(g);
  }
  svg.appendChild(nodeGroup);
}

// ═══════════════════════════════════════════════════════
// 4. Interactions
// ═══════════════════════════════════════════════════════

interface TreeState {
  zoom: number;
  panX: number;
  panY: number;
  width: number;
  height: number;
  dragNode: GraphNode | null;
  dragOffset: { x: number; y: number } | null;
  tooltip: HTMLElement | null;
}

function applyViewBox(svg: SVGSVGElement, state: TreeState): void {
  const vw = state.width / state.zoom;
  const vh = state.height / state.zoom;
  const vx = -state.panX / state.zoom;
  const vy = -state.panY / state.zoom;
  svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
}

function setupNodeInteractions(
  g: SVGGElement,
  node: GraphNode,
  svg: SVGSVGElement,
  graph: ComboGraph,
  state: TreeState,
): void {
  // Drag
  g.style.cursor = 'grab';

  g.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    g.style.cursor = 'grabbing';
    state.dragNode = node;
    node.pinned = true;

    const pt = svgPoint(svg, e, state);
    state.dragOffset = { x: pt.x - node.x, y: pt.y - node.y };
  });

  // Hover highlight
  g.addEventListener('mouseenter', (e: MouseEvent) => {
    highlightConnected(svg, node, graph, true);
    showTooltip(state.tooltip, node, e);
  });
  g.addEventListener('mouseleave', () => {
    highlightConnected(svg, node, graph, false);
    if (state.tooltip) state.tooltip.style.display = 'none';
  });

  // Click — open Spellbook link for combos
  g.addEventListener('click', (e: MouseEvent) => {
    if (node.type === 'combo' && node.spellbookUrl) {
      e.preventDefault();
      window.open(node.spellbookUrl, '_blank', 'noopener,noreferrer');
    }
  });
}

function svgPoint(svg: SVGSVGElement, e: MouseEvent, state: TreeState): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  const scaleX = state.width / state.zoom / rect.width;
  const scaleY = state.height / state.zoom / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX + (-state.panX / state.zoom),
    y: (e.clientY - rect.top) * scaleY + (-state.panY / state.zoom),
  };
}

function highlightConnected(
  svg: SVGSVGElement,
  node: GraphNode,
  graph: ComboGraph,
  on: boolean,
): void {
  // Find connected node IDs
  const connectedIds = new Set<string>();
  connectedIds.add(node.id);
  for (const e of graph.edges) {
    if (e.sourceId === node.id) connectedIds.add(e.targetId);
    if (e.targetId === node.id) connectedIds.add(e.sourceId);
  }

  // Toggle classes on edges
  const edgeEls = svg.querySelectorAll<SVGLineElement>('.ct-edge');
  for (const line of edgeEls) {
    const src = line.dataset.source || '';
    const tgt = line.dataset.target || '';
    const connected = connectedIds.has(src) && connectedIds.has(tgt);
    line.classList.toggle('ct-highlight', on && connected);
    line.classList.toggle('ct-dimmed', on && !connected);
  }

  // Toggle classes on nodes
  const nodeEls = svg.querySelectorAll<SVGGElement>('.ct-node-group');
  for (const g of nodeEls) {
    const nid = g.dataset.nodeId || '';
    g.classList.toggle('ct-highlight', on && connectedIds.has(nid));
    g.classList.toggle('ct-dimmed', on && !connectedIds.has(nid));
  }
}

function showTooltip(tooltip: HTMLElement | null, node: GraphNode, e: MouseEvent): void {
  if (!tooltip) return;

  const lines: string[] = [];
  if (node.type === 'combo') {
    lines.push(node.comboName || node.label);
    if (node.description) lines.push(node.description.slice(0, 120) + (node.description.length > 120 ? '\u2026' : ''));
    if (node.produces && node.produces.length > 0) lines.push('\u2192 ' + node.produces.join(', '));
    if (node.source) lines.push('Source: ' + (node.source === 'spellbook' ? 'Commander Spellbook' : node.source === 'catalog' ? 'DeckLens' : 'Community'));
    if (node.hasTemplateReqs) lines.push('\u26A0 Requires template card(s)');
    if (node.spellbookUrl) lines.push('\uD83D\uDD17 Click to open Spellbook');
  } else {
    lines.push(node.cardName || node.label);
    if (!node.inDeck) lines.push('\u274C Not in deck (missing piece)');
  }

  tooltip.textContent = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    tooltip.appendChild(div);
  }

  tooltip.style.display = 'block';
  tooltip.style.left = `${e.clientX + 14}px`;
  tooltip.style.top = `${e.clientY + 14}px`;

  // Keep on screen
  const rect = tooltip.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    tooltip.style.left = `${e.clientX - rect.width - 10}px`;
  }
  if (rect.bottom > window.innerHeight) {
    tooltip.style.top = `${e.clientY - rect.height - 10}px`;
  }
}

function updateEdgePositions(svg: SVGSVGElement, graph: ComboGraph): void {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodeMap.set(n.id, n);

  const edgeEls = svg.querySelectorAll<SVGLineElement>('.ct-edge');
  let i = 0;
  for (const e of graph.edges) {
    if (i >= edgeEls.length) break;
    const src = nodeMap.get(e.sourceId);
    const tgt = nodeMap.get(e.targetId);
    if (!src || !tgt) { i++; continue; }
    edgeEls[i].setAttribute('x1', String(src.x));
    edgeEls[i].setAttribute('y1', String(src.y));
    edgeEls[i].setAttribute('x2', String(tgt.x));
    edgeEls[i].setAttribute('y2', String(tgt.y));
    i++;
  }
}

// ═══════════════════════════════════════════════════════
// 5. Floating Window
// ═══════════════════════════════════════════════════════

let activeWindow: HTMLElement | null = null;

/**
 * Open the Combo Tree floating window.
 * Only one window at a time — re-opens if already open.
 */
export function openComboTree(coach: DeckCoach): void {
  if (activeWindow) {
    activeWindow.remove();
    activeWindow = null;
  }

  let currentFilter: FilterMode = 'all';
  const graph = buildComboGraph(coach, currentFilter);

  // Use a decent content-area for layout
  const layoutW = WIN_WIDTH - 20;
  const layoutH = WIN_HEIGHT - 100;
  forceLayout(graph, layoutW, layoutH);

  // ── State ──
  const treeState: TreeState = {
    zoom: 1,
    panX: 0,
    panY: 0,
    width: layoutW,
    height: layoutH,
    dragNode: null,
    dragOffset: null,
    tooltip: null,
  };

  // ── Window container ──
  const win = document.createElement('div');
  win.className = 'combo-tree-window';
  win.style.width = `${WIN_WIDTH}px`;
  win.style.height = `${WIN_HEIGHT}px`;
  // Position: upper right
  win.style.right = '24px';
  win.style.top = '80px';

  // ── Header (draggable) ──
  const header = document.createElement('div');
  header.className = 'combo-tree-header';

  const title = document.createElement('span');
  title.className = 'combo-tree-title';
  title.textContent = '\uD83C\uDF33 Combo Tree';
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'combo-tree-close';
  closeBtn.textContent = '\u2715';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', () => closeComboTree());
  header.appendChild(closeBtn);

  // Header drag
  let headerDrag = false;
  let headerDragStart = { x: 0, y: 0 };
  let winStartPos = { x: 0, y: 0 };

  header.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    headerDrag = true;
    headerDragStart = { x: e.clientX, y: e.clientY };
    const rect = win.getBoundingClientRect();
    winStartPos = { x: rect.left, y: rect.top };
    e.preventDefault();
  });

  win.appendChild(header);

  // ── Filter bar ──
  const filters = document.createElement('div');
  filters.className = 'combo-tree-filters';

  const filterOpts: Array<{ label: string; value: FilterMode }> = [
    { label: 'All', value: 'all' },
    { label: 'Complete', value: 'complete' },
    { label: 'Near-Miss', value: 'near-miss' },
    { label: 'Partial', value: 'partial' },
  ];

  function rebuildGraph(): void {
    const newGraph = buildComboGraph(coach, currentFilter);
    forceLayout(newGraph, layoutW, layoutH);
    graph.nodes = newGraph.nodes;
    graph.edges = newGraph.edges;
    treeState.zoom = 1;
    treeState.panX = 0;
    treeState.panY = 0;
    applyViewBox(svgEl, treeState);
    renderGraph(svgEl, graph, treeState);
  }

  for (const opt of filterOpts) {
    const btn = document.createElement('button');
    btn.className = `combo-tree-filter-btn${opt.value === currentFilter ? ' active' : ''}`;
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      currentFilter = opt.value;
      // Update active states
      for (const b of filters.querySelectorAll<HTMLElement>('.combo-tree-filter-btn')) {
        b.classList.toggle('active', b.textContent === opt.label);
      }
      rebuildGraph();
    });
    filters.appendChild(btn);
  }

  // Node count
  const countLabel = document.createElement('span');
  countLabel.className = 'combo-tree-count';
  countLabel.textContent = `${graph.nodes.filter((n) => n.type === 'combo').length} combos`;
  filters.appendChild(countLabel);

  win.appendChild(filters);

  // ── SVG Body ──
  const body = document.createElement('div');
  body.className = 'combo-tree-body';

  const svgEl = document.createElementNS(NS, 'svg');
  svgEl.setAttribute('width', '100%');
  svgEl.setAttribute('height', '100%');
  applyViewBox(svgEl, treeState);

  renderGraph(svgEl, graph, treeState);
  body.appendChild(svgEl);
  win.appendChild(body);

  // ── Tooltip ──
  const tooltip = document.createElement('div');
  tooltip.className = 'ct-tooltip';
  tooltip.style.display = 'none';
  treeState.tooltip = tooltip;
  win.appendChild(tooltip);

  // ── Global mouse handlers ──
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let panStartOffset = { x: 0, y: 0 };

  function onMouseMove(e: MouseEvent): void {
    // Header drag
    if (headerDrag) {
      const dx = e.clientX - headerDragStart.x;
      const dy = e.clientY - headerDragStart.y;
      win.style.left = `${winStartPos.x + dx}px`;
      win.style.top = `${winStartPos.y + dy}px`;
      win.style.right = 'auto';
      return;
    }

    // Node drag
    if (treeState.dragNode && treeState.dragOffset) {
      const pt = svgPoint(svgEl, e, treeState);
      treeState.dragNode.x = pt.x - treeState.dragOffset.x;
      treeState.dragNode.y = pt.y - treeState.dragOffset.y;
      // Update node position
      const g = svgEl.querySelector(`[data-node-id="${CSS.escape(treeState.dragNode.id)}"]`) as SVGGElement | null;
      if (g) g.setAttribute('transform', `translate(${treeState.dragNode.x},${treeState.dragNode.y})`);
      updateEdgePositions(svgEl, graph);
      return;
    }

    // Pan
    if (isPanning) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      treeState.panX = panStartOffset.x + dx;
      treeState.panY = panStartOffset.y + dy;
      applyViewBox(svgEl, treeState);
    }
  }

  function onMouseUp(): void {
    if (headerDrag) {
      headerDrag = false;
      return;
    }
    if (treeState.dragNode) {
      treeState.dragNode.pinned = false;
      treeState.dragNode = null;
      treeState.dragOffset = null;
      // Reset cursors
      const groups = svgEl.querySelectorAll<SVGGElement>('.ct-node-group');
      for (const g of groups) g.style.cursor = 'grab';
      return;
    }
    if (isPanning) {
      isPanning = false;
      svgEl.style.cursor = '';
    }
  }

  // Pan: mousedown on empty SVG area
  svgEl.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    // Only pan if not clicking a node
    const target = e.target as SVGElement;
    if (target.closest('.ct-node-group')) return;
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY };
    panStartOffset = { x: treeState.panX, y: treeState.panY };
    svgEl.style.cursor = 'grabbing';
    e.preventDefault();
  });

  // Zoom
  body.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    treeState.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, treeState.zoom * delta));
    applyViewBox(svgEl, treeState);
  }, { passive: false });

  // Keyboard
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') closeComboTree();
  }

  // Attach global listeners
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);

  // Cleanup function
  (win as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown);
  };

  // ── Mount ──
  activeWindow = win;
  document.body.appendChild(win);
}

/**
 * Close the Combo Tree floating window.
 */
export function closeComboTree(): void {
  if (!activeWindow) return;
  const cleanup = (activeWindow as HTMLElement & { _cleanup?: () => void })._cleanup;
  if (typeof cleanup === 'function') cleanup();
  activeWindow.remove();
  activeWindow = null;
}
