import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';

interface SynergyEdge {
  a: string;
  b: string;
  reason: string;
}

interface SynergyNode {
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  edges: number;
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function detectStructuredSynergies(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): SynergyEdge[] {
  const entries = [...deck.boards.commander, ...deck.boards.mainboard];
  const edges: SynergyEdge[] = [];
  const seen = new Set<string>();

  const cards = entries.map((e) => {
    const c = cardByName[normalizeKey(e.name)];
    return c ? { name: e.name, type: (c.type_line || '').toLowerCase(), text: (c.oracle_text || '').toLowerCase() } : null;
  }).filter(Boolean) as { name: string; type: string; text: string }[];

  function addEdge(a: string, b: string, reason: string) {
    const key = [a, b].sort().join('||');
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, reason });
  }

  // ETB synergies
  const etbCreatures = cards.filter((c) => c.type.includes('creature') && c.text.includes('enters'));
  const blinkCards = cards.filter((c) => c.text.includes('exile') && c.text.includes('return') && !c.type.includes('land'));
  for (const blink of blinkCards) {
    for (const etb of etbCreatures) {
      if (blink.name !== etb.name) addEdge(blink.name, etb.name, 'Blink + ETB');
    }
  }

  // Counter synergies
  const counterGivers = cards.filter((c) => c.text.includes('+1/+1 counter') && c.text.includes('put'));
  const counterBenefits = cards.filter((c) => c.text.includes('+1/+1 counter') && (c.text.includes('whenever') || c.text.includes('each time')));
  for (const giver of counterGivers) {
    for (const ben of counterBenefits) {
      if (giver.name !== ben.name) addEdge(giver.name, ben.name, 'Counter synergy');
    }
  }

  // Sacrifice synergies
  const sacOutlets = cards.filter((c) => c.text.includes('sacrifice a') || c.text.includes('sacrifice another'));
  const deathTriggers = cards.filter((c) => c.text.includes('when') && (c.text.includes('dies') || c.text.includes('put into a graveyard')));
  for (const sac of sacOutlets) {
    for (const dt of deathTriggers) {
      if (sac.name !== dt.name) addEdge(sac.name, dt.name, 'Sacrifice + Death trigger');
    }
  }

  // Token synergies
  const tokenMakers = cards.filter((c) => c.text.includes('create') && c.text.includes('token'));
  const tokenBenefits = cards.filter((c) => c.text.includes('whenever') && (c.text.includes('enters') || c.text.includes('creature you control')));
  for (const maker of tokenMakers) {
    for (const ben of tokenBenefits) {
      if (maker.name !== ben.name) addEdge(maker.name, ben.name, 'Token synergy');
    }
  }

  // Draw synergies
  const drawTriggers = cards.filter((c) => c.text.includes('whenever you draw') || c.text.includes('whenever a player draws'));
  const drawEngines = cards.filter((c) => c.text.includes('draw') && (c.text.includes('card') || c.text.includes('cards')) && !c.type.includes('land'));
  for (const trigger of drawTriggers) {
    for (const engine of drawEngines) {
      if (trigger.name !== engine.name) addEdge(trigger.name, engine.name, 'Draw synergy');
    }
  }

  // Tribal synergies: creatures sharing a type + tribal payoffs
  const creatureTypeMap = new Map<string, { name: string; type: string; text: string }[]>();
  const tribalPayoffs: { name: string; type: string; text: string }[] = [];
  const MTG_TYPES = [
    'elf', 'goblin', 'zombie', 'vampire', 'wizard', 'dragon', 'merfolk', 'warrior',
    'soldier', 'angel', 'demon', 'human', 'elemental', 'spirit', 'sliver', 'dinosaur',
    'pirate', 'knight', 'cleric', 'shaman', 'rogue', 'cat', 'bird', 'faerie', 'rat',
    'werewolf', 'phyrexian', 'construct', 'golem', 'sphinx', 'hydra', 'horror', 'insect',
    'druid', 'artificer', 'beast', 'fungus', 'treefolk',
  ];
  for (const c of cards) {
    for (const ct of MTG_TYPES) {
      if (c.type.includes(ct)) {
        if (!creatureTypeMap.has(ct)) creatureTypeMap.set(ct, []);
        creatureTypeMap.get(ct)!.push(c);
      }
    }
    if (/each .* you control|all .* get|other .* you control get|choose a creature type/.test(c.text)) {
      tribalPayoffs.push(c);
    }
  }
  for (const payoff of tribalPayoffs) {
    for (const [, creatures] of creatureTypeMap) {
      if (creatures.length >= 3) {
        for (const creature of creatures) {
          if (creature.name !== payoff.name) addEdge(payoff.name, creature.name, 'Tribal synergy');
        }
      }
    }
  }

  // Landfall synergies
  const landfallCards = cards.filter((c) => c.text.includes('landfall') || c.text.includes('whenever a land enters') || c.text.includes('whenever a land you control enters'));
  const landFetchers = cards.filter((c) =>
    /search your library for a (basic )?land/.test(c.text) ||
    c.text.includes('put a land card') ||
    c.text.includes('you may play an additional land')
  );
  for (const lf of landfallCards) {
    for (const fetcher of landFetchers) {
      if (lf.name !== fetcher.name) addEdge(lf.name, fetcher.name, 'Landfall synergy');
    }
  }

  // Graveyard synergies
  const graveyardPayoffs = cards.filter((c) =>
    c.text.includes('from your graveyard') ||
    c.text.includes('from a graveyard') ||
    c.text.includes('cards in your graveyard') ||
    /\bdelve\b/.test(c.text) || /\bescape\b/.test(c.text)
  );
  const graveyardFillers = cards.filter((c) =>
    c.text.includes('mill') || c.text.includes('put the top') ||
    c.text.includes('discard a card') || /\bdredge\b/.test(c.text)
  );
  for (const gp of graveyardPayoffs) {
    for (const gf of graveyardFillers) {
      if (gp.name !== gf.name) addEdge(gp.name, gf.name, 'Graveyard synergy');
    }
  }

  // Voltron / Equipment synergies
  const equipAndAuras = cards.filter((c) => c.type.includes('equipment') || (c.type.includes('aura') && c.text.includes('enchant creature')));
  const voltronPayoffs = cards.filter((c) =>
    c.text.includes('equipped creature') || c.text.includes('whenever you attach') ||
    c.text.includes('enchanted creature gets') || (c.type.includes('creature') && /\bdouble strike\b/.test(c.text))
  );
  for (const eq of equipAndAuras) {
    for (const vp of voltronPayoffs) {
      if (eq.name !== vp.name) addEdge(eq.name, vp.name, 'Voltron synergy');
    }
  }

  // Enchantress synergies
  const enchantressTriggers = cards.filter((c) =>
    c.text.includes('whenever you cast an enchantment') ||
    c.text.includes('whenever an enchantment enters') ||
    c.text.includes('constellation')
  );
  const enchantments = cards.filter((c) => c.type.includes('enchantment') && !c.type.includes('creature'));
  for (const et of enchantressTriggers) {
    for (const en of enchantments) {
      if (et.name !== en.name) addEdge(et.name, en.name, 'Enchantress synergy');
    }
  }

  // Stax / Tax synergies
  const staxPieces = cards.filter((c) =>
    /opponents can't/.test(c.text) || /spells cost .* more to cast/.test(c.text) ||
    c.text.includes("nonland permanents don't untap") || c.text.includes("players can't")
  );
  if (staxPieces.length >= 2) {
    for (let i = 0; i < staxPieces.length; i++) {
      for (let j = i + 1; j < staxPieces.length; j++) {
        addEdge(staxPieces[i].name, staxPieces[j].name, 'Stax synergy');
      }
    }
  }

  // Commander synergy: cards that mention similar keywords
  const commander = deck.boards.commander[0];
  if (commander) {
    const cmdCard = cardByName[normalizeKey(commander.name)];
    if (cmdCard?.oracle_text) {
      const cmdText = cmdCard.oracle_text.toLowerCase();
      for (const card of cards) {
        if (card.name === commander.name) continue;
        if (cmdText.includes('whenever you cast') && cmdText.includes('creature') && card.type.includes('creature')) {
          addEdge(commander.name, card.name, 'Commander trigger');
        }
        if (cmdText.includes('whenever') && cmdText.includes('enters') && card.type.includes('creature')) {
          addEdge(commander.name, card.name, 'Commander ETB');
        }
      }
    }
  }

  return edges;
}

function forceLayout(nodes: SynergyNode[], edges: SynergyEdge[], width: number, height: number): void {
  const nodeMap = new Map<string, SynergyNode>();
  for (const n of nodes) nodeMap.set(n.name, n);

  const iterations = 200;
  const repulsion = 5000;
  const attraction = 0.02;
  const damping = 0.9;

  for (let iter = 0; iter < iterations; iter++) {
    // Repulsion between all nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.max(10, Math.sqrt(dx * dx + dy * dy));
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        nodes[i].vx -= fx;
        nodes[i].vy -= fy;
        nodes[j].vx += fx;
        nodes[j].vy += fy;
      }
    }

    // Attraction along edges
    for (const edge of edges) {
      const a = nodeMap.get(edge.a);
      const b = nodeMap.get(edge.b);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = Math.sqrt(dist) * attraction;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Center gravity
    for (const n of nodes) {
      n.vx += (width / 2 - n.x) * 0.015;
      n.vy += (height / 2 - n.y) * 0.015;
    }

    // Apply velocity with damping
    for (const n of nodes) {
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
      // Clamp to bounds
      n.x = Math.max(40, Math.min(width - 40, n.x));
      n.y = Math.max(25, Math.min(height - 25, n.y));
    }
  }
}

export function renderSynergyMap(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): void {
  container.textContent = '';
  if (deck.boards.mainboard.length < 5) return;

  const edges = detectStructuredSynergies(deck, cardByName);
  if (edges.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.fontSize = '0.78rem';
    empty.textContent = 'No synergies detected. Add more cards with complementary abilities.';
    container.appendChild(empty);
    return;
  }

  // Build nodes from edges (only show connected cards)
  const nodeNames = new Set<string>();
  for (const e of edges) { nodeNames.add(e.a); nodeNames.add(e.b); }

  const width = 460;
  const height = 320;

  const nodes: SynergyNode[] = Array.from(nodeNames).map((name) => ({
    name,
    x: width / 2 + (Math.random() - 0.5) * 300,
    y: height / 2 + (Math.random() - 0.5) * 220,
    vx: 0,
    vy: 0,
    edges: edges.filter((e) => e.a === name || e.b === name).length,
  }));

  forceLayout(nodes, edges, width, height);

  const nodeMap = new Map<string, SynergyNode>();
  for (const n of nodes) nodeMap.set(n.name, n);

  // Wrapper for positioning the tooltip relative to SVG
  container.style.position = 'relative';

  // Rich tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'synergy-tooltip';
  tooltip.style.display = 'none';

  function showTooltip(node: SynergyNode, circleEl: SVGCircleElement) {
    const connectedEdges = edges.filter((e) => e.a === node.name || e.b === node.name);
    let html = `<div class="synergy-tooltip-name">${escapeHtmlSyn(node.name)}</div>`;
    html += `<div class="synergy-tooltip-count">${node.edges} connection${node.edges !== 1 ? 's' : ''}</div>`;
    for (const edge of connectedEdges) {
      const other = edge.a === node.name ? edge.b : edge.a;
      html += `<div class="synergy-tooltip-edge">\u2194 ${escapeHtmlSyn(other)} <span class="synergy-tooltip-reason">\u2014 ${escapeHtmlSyn(edge.reason)}</span></div>`;
    }
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';

    // Position: map SVG coords to container-relative pixel coords
    const scaleX = svg.clientWidth / width;
    const scaleY = svg.clientHeight / height;
    let tx = node.x * scaleX + 16;
    let ty = node.y * scaleY - 10;

    // Clamp to stay within container
    const cw = container.clientWidth;
    const tooltipW = tooltip.offsetWidth || 240;
    if (tx + tooltipW > cw) tx = tx - tooltipW - 32;
    if (ty < 0) ty = 4;
    if (tx < 0) tx = 4;

    tooltip.style.left = `${tx}px`;
    tooltip.style.top = `${ty}px`;
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
  }

  // SVG
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.display = 'block';

  // Edges
  for (const edge of edges) {
    const a = nodeMap.get(edge.a);
    const b = nodeMap.get(edge.b);
    if (!a || !b) continue;

    const line = document.createElementNS(svgNs, 'line');
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x));
    line.setAttribute('y2', String(b.y));
    line.setAttribute('stroke', 'rgba(201,168,76,0.25)');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('data-a', edge.a);
    line.setAttribute('data-b', edge.b);
    svg.appendChild(line);
  }

  // Nodes
  const nodeRadii = new Map<string, number>();
  for (const node of nodes) {
    const r = Math.min(18, 6 + node.edges * 2);
    nodeRadii.set(node.name, r);

    const circle = document.createElementNS(svgNs, 'circle');
    circle.setAttribute('cx', String(node.x));
    circle.setAttribute('cy', String(node.y));
    circle.setAttribute('r', String(r));
    circle.setAttribute('fill', 'rgba(201,168,76,0.15)');
    circle.setAttribute('stroke', '#c9a84c');
    circle.setAttribute('stroke-width', '1.5');
    circle.setAttribute('data-node', node.name);
    circle.style.cursor = 'pointer';
    circle.style.transition = 'opacity 0.15s';

    circle.addEventListener('mouseenter', () => {
      // Compute connected set
      const connected = new Set<string>();
      connected.add(node.name);
      for (const edge of edges) {
        if (edge.a === node.name || edge.b === node.name) {
          connected.add(edge.a);
          connected.add(edge.b);
        }
      }

      // Dim all edges
      svg.querySelectorAll('line').forEach((l) => {
        const la = l.getAttribute('data-a') || '';
        const lb = l.getAttribute('data-b') || '';
        if (connected.has(la) && connected.has(lb)) {
          l.setAttribute('stroke', 'rgba(201,168,76,0.5)');
          l.setAttribute('stroke-width', '2.5');
        } else {
          l.setAttribute('stroke', 'rgba(201,168,76,0.06)');
          l.setAttribute('stroke-width', '1');
        }
      });

      // Dim non-connected nodes
      svg.querySelectorAll('circle').forEach((c) => {
        const cn = c.getAttribute('data-node') || '';
        if (connected.has(cn)) {
          c.setAttribute('fill', cn === node.name ? 'rgba(201,168,76,0.45)' : 'rgba(201,168,76,0.25)');
          (c as SVGElement).style.opacity = '1';
        } else {
          c.setAttribute('fill', 'rgba(201,168,76,0.04)');
          (c as SVGElement).style.opacity = '0.3';
        }
      });

      // Dim non-connected labels
      svg.querySelectorAll('text').forEach((t) => {
        const tn = t.getAttribute('data-node') || '';
        (t as SVGElement).style.opacity = connected.has(tn) ? '1' : '0.2';
      });

      circle.setAttribute('r', String(r + 2));
      showTooltip(node, circle);
    });
    circle.addEventListener('mouseleave', () => {
      // Restore all edges
      svg.querySelectorAll('line').forEach((l) => {
        l.setAttribute('stroke', 'rgba(201,168,76,0.25)');
        l.setAttribute('stroke-width', '1.5');
      });

      // Restore all nodes
      svg.querySelectorAll('circle').forEach((c) => {
        const cn = c.getAttribute('data-node') || '';
        const origR = nodeRadii.get(cn);
        c.setAttribute('fill', 'rgba(201,168,76,0.15)');
        if (origR !== undefined) c.setAttribute('r', String(origR));
        (c as SVGElement).style.opacity = '1';
      });

      // Restore all labels
      svg.querySelectorAll('text').forEach((t) => {
        (t as SVGElement).style.opacity = '1';
      });

      circle.setAttribute('r', String(r));
      hideTooltip();
    });
    svg.appendChild(circle);

    // Label
    const label = document.createElementNS(svgNs, 'text');
    label.setAttribute('x', String(node.x));
    label.setAttribute('y', String(node.y + r + 10));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', 'var(--text-dim)');
    label.setAttribute('font-size', '7');
    label.setAttribute('font-family', "'Outfit', sans-serif");
    label.setAttribute('data-node', node.name);
    label.style.transition = 'opacity 0.15s';
    label.textContent = node.name.length > 16 ? node.name.slice(0, 15) + '\u2026' : node.name;
    svg.appendChild(label);
  }

  // Summary text
  const summary = document.createElement('div');
  summary.className = 'muted';
  summary.style.cssText = 'font-size:0.72rem; margin-top:6px;';
  summary.textContent = `${edges.length} synergies between ${nodes.length} cards`;

  // Synergy type badges
  const types = new Set(edges.map((e) => e.reason));
  const badgeRow = document.createElement('div');
  badgeRow.className = 'synergy-badges';
  for (const type of types) {
    const badge = document.createElement('span');
    badge.className = 'synergy-badge';
    badge.textContent = type;
    badgeRow.appendChild(badge);
  }

  container.append(svg, summary, badgeRow, tooltip);
}

function escapeHtmlSyn(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
