// ============================================================
// Engine Graph — SVG-based combo/synergy DAG visualization
// ============================================================
// Visualizes card relationships as a directed graph.
// Nodes = cards, edges = synergy/combo connections.
// ============================================================

import { h } from '../shared/dom.js';
import type { DeckbuilderCardEntry, DeckBoard } from './types.js';

// ==================== Types ====================

export interface GraphNode {
  id: string;
  name: string;
  board: DeckBoard;
  tags: string[];
  x: number;
  y: number;
  radius: number;
  color: string;
}

export interface GraphEdge {
  source: string;    // card name
  target: string;    // card name
  type: 'combo' | 'synergy' | 'enables' | 'payoff';
  label?: string;
  strength: number;  // 0-1
}

export interface EngineGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ComboLineData {
  name: string;
  cards: string[];
  tags: string[];
}

// ==================== Graph Construction ====================

/**
 * Build a graph from deck cards and their relationships.
 */
export function buildEngineGraph(
  cards: { board: DeckBoard; entries: DeckbuilderCardEntry[] }[],
  combos: ComboLineData[] = [],
  tagSynergies: Record<string, string[]> = {}
): EngineGraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const cardSet = new Set<string>();

  // Create nodes for all cards
  for (const { board, entries } of cards) {
    for (const entry of entries) {
      if (cardSet.has(entry.name)) continue;
      cardSet.add(entry.name);

      nodes.push({
        id: entry.name,
        name: entry.name,
        board,
        tags: entry.tags,
        x: 0,
        y: 0,
        radius: 8 + Math.min(entry.qty * 2, 8),
        color: getNodeColor(board, entry.tags),
      });
    }
  }

  // Add edges from combos
  for (const combo of combos) {
    for (let i = 0; i < combo.cards.length; i++) {
      for (let j = i + 1; j < combo.cards.length; j++) {
        if (cardSet.has(combo.cards[i]) && cardSet.has(combo.cards[j])) {
          edges.push({
            source: combo.cards[i],
            target: combo.cards[j],
            type: 'combo',
            label: combo.name,
            strength: 1.0,
          });
        }
      }
    }
  }

  // Add edges from tag synergies (e.g. "ramp enables payoff")
  for (const [sourceTag, targetTags] of Object.entries(tagSynergies)) {
    const sourceCards = nodes.filter(n => n.tags.includes(sourceTag));
    const targetCards = nodes.filter(n => targetTags.some(t => n.tags.includes(t)));

    for (const src of sourceCards) {
      for (const tgt of targetCards) {
        if (src.id !== tgt.id) {
          // Avoid duplicate edges
          const exists = edges.some(e =>
            (e.source === src.id && e.target === tgt.id) ||
            (e.source === tgt.id && e.target === src.id)
          );
          if (!exists) {
            edges.push({
              source: src.id,
              target: tgt.id,
              type: 'synergy',
              strength: 0.5,
            });
          }
        }
      }
    }
  }

  // Apply force-directed layout
  applyForceLayout(nodes, edges);

  return { nodes, edges };
}

// ==================== Force-Directed Layout ====================

function applyForceLayout(nodes: GraphNode[], edges: GraphEdge[]): void {
  const width = 800;
  const height = 600;
  const iterations = 100;

  // Initialize positions in a circle
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    node.x = width / 2 + (width / 3) * Math.cos(angle);
    node.y = height / 2 + (height / 3) * Math.sin(angle);
  });

  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  for (let iter = 0; iter < iterations; iter++) {
    const cooling = 1 - iter / iterations;

    // Repulsive force between all nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = (500 / (dist * dist)) * cooling;

        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        nodes[i].x -= fx;
        nodes[i].y -= fy;
        nodes[j].x += fx;
        nodes[j].y += fy;
      }
    }

    // Attractive force along edges
    for (const edge of edges) {
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);
      if (!src || !tgt) continue;

      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const force = ((dist - 100) / 10) * cooling * edge.strength;

      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      src.x += fx;
      src.y += fy;
      tgt.x -= fx;
      tgt.y -= fy;
    }

    // Center gravity
    for (const node of nodes) {
      node.x += (width / 2 - node.x) * 0.01 * cooling;
      node.y += (height / 2 - node.y) * 0.01 * cooling;
    }
  }

  // Clamp to bounds
  for (const node of nodes) {
    node.x = Math.max(30, Math.min(width - 30, node.x));
    node.y = Math.max(30, Math.min(height - 30, node.y));
  }
}

// ==================== SVG Rendering ====================

/**
 * Render the engine graph as an SVG element.
 */
export function renderEngineGraph(
  data: EngineGraphData,
  onNodeClick?: (cardName: string) => void
): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 800 600');
  svg.setAttribute('class', 'engine-graph');
  svg.style.width = '100%';
  svg.style.height = '100%';

  const nodeMap = new Map(data.nodes.map(n => [n.id, n]));

  // Render edges
  for (const edge of data.edges) {
    const src = nodeMap.get(edge.source);
    const tgt = nodeMap.get(edge.target);
    if (!src || !tgt) continue;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(src.x));
    line.setAttribute('y1', String(src.y));
    line.setAttribute('x2', String(tgt.x));
    line.setAttribute('y2', String(tgt.y));
    line.setAttribute('class', `engine-graph__edge engine-graph__edge--${edge.type}`);
    line.setAttribute('stroke-width', String(edge.strength * 3));
    line.setAttribute('stroke-opacity', String(0.3 + edge.strength * 0.4));
    svg.appendChild(line);
  }

  // Render nodes
  for (const node of data.nodes) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'engine-graph__node');
    group.style.cursor = 'pointer';

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(node.x));
    circle.setAttribute('cy', String(node.y));
    circle.setAttribute('r', String(node.radius));
    circle.setAttribute('fill', node.color);
    circle.setAttribute('stroke', '#fff');
    circle.setAttribute('stroke-width', '1.5');
    group.appendChild(circle);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', String(node.x));
    text.setAttribute('y', String(node.y + node.radius + 14));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'engine-graph__label');
    text.setAttribute('font-size', '10');
    text.setAttribute('fill', '#ccc');
    text.textContent = node.name.length > 20 ? node.name.slice(0, 18) + '...' : node.name;
    group.appendChild(text);

    if (onNodeClick) {
      group.addEventListener('click', () => onNodeClick(node.name));
    }

    svg.appendChild(group);
  }

  return svg;
}

// ==================== Helpers ====================

function getNodeColor(board: DeckBoard, tags: string[]): string {
  if (board === 'commander') return '#c9a84c'; // gold
  if (tags.includes('ramp') || tags.includes('land')) return '#34d399'; // green
  if (tags.includes('draw') || tags.includes('card_advantage')) return '#60a5fa'; // blue
  if (tags.includes('removal') || tags.includes('board_wipe')) return '#f87171'; // red
  if (tags.includes('combo') || tags.includes('wincon')) return '#f472b6'; // pink
  if (tags.includes('protection') || tags.includes('counterspell')) return '#a78bfa'; // purple
  return '#94a3b8'; // gray
}

/**
 * Default tag synergy map for EDH decks.
 */
export function getDefaultTagSynergies(): Record<string, string[]> {
  return {
    'ramp': ['payoff', 'bomb', 'wincon'],
    'draw': ['combo', 'wincon', 'value'],
    'tutor': ['combo', 'wincon'],
    'enabler': ['combo', 'payoff'],
    'sacrifice': ['death_trigger', 'token', 'recursion'],
    'token': ['anthem', 'sacrifice', 'swarm'],
  };
}
