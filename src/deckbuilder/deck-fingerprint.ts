import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import { analyzeDeckDNA, calculateSaltAnalysis, type AnalyzerCardView } from '../mtg/engine/analyzers.js';

interface FingerprintAxis {
  label: string;
  value: number; // 0-100
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function toResolverView(card: DeckbuilderSearchCard): AnalyzerCardView {
  return { name: card.name, cmc: card.cmc, type_line: card.type_line, oracle_text: card.oracle_text };
}

export function computeFingerprint(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): FingerprintAxis[] {
  const entries = deck.boards.mainboard.map((e) => ({ name: e.name, qty: e.qty }));
  const resolver = (name: string): AnalyzerCardView | undefined => {
    const card = cardByName[normalizeKey(name)];
    return card ? toResolverView(card) : undefined;
  };

  const dna = analyzeDeckDNA(entries, resolver);
  const salt = calculateSaltAnalysis(entries, resolver);

  // Compute per-axis values
  const totalQty = entries.reduce((s, e) => s + e.qty, 0);

  // 1. Aggression: lower avg CMC = more aggressive
  let totalCmc = 0;
  let nonlandCount = 0;
  let interactionCount = 0;
  let rampCount = 0;
  let drawCount = 0;
  let protectionCount = 0;

  for (const entry of entries) {
    const card = cardByName[normalizeKey(entry.name)];
    if (!card) continue;
    const typeLine = (card.type_line || '').toLowerCase();
    const text = (card.oracle_text || '').toLowerCase();

    if (!typeLine.includes('land')) {
      totalCmc += (card.cmc || 0) * entry.qty;
      nonlandCount += entry.qty;
    }

    if (text.includes('destroy target') || text.includes('exile target') ||
        text.includes('counter target') || text.includes('deals damage to')) {
      interactionCount += entry.qty;
    }
    if (text.includes('add {') || (text.includes('search your library') && text.includes('land'))) {
      rampCount += entry.qty;
    }
    if (text.includes('draw a card') || text.includes('draw cards') || text.includes('draw two')) {
      drawCount += entry.qty;
    }
    if (text.includes('hexproof') || text.includes('indestructible') || text.includes('protection from') ||
        text.includes('can\'t be countered') || text.includes('return') && text.includes('from your graveyard')) {
      protectionCount += entry.qty;
    }
  }

  const avgCmc = nonlandCount > 0 ? totalCmc / nonlandCount : 3;
  // Map avg CMC to aggression: 1.5→100, 4.5→0
  const aggression = Math.max(0, Math.min(100, Math.round((4.5 - avgCmc) / 3 * 100)));

  // 2. Control: from DNA (already 0-100)
  const control = Math.round(dna.normalized.control);

  // 3. Combo: from DNA (already 0-100)
  const combo = Math.round(dna.normalized.combo);

  // 4. Ramp: density
  const ramp = Math.min(100, Math.round((rampCount / Math.max(1, totalQty)) * 800));

  // 5. Card Advantage: draw density
  const cardAdvantage = Math.min(100, Math.round((drawCount / Math.max(1, totalQty)) * 800));

  // 6. Resilience: protection + recursion density
  const resilience = Math.min(100, Math.round((protectionCount / Math.max(1, totalQty)) * 800));

  // 7. Synergy: approximate based on ETB/counter/sacrifice keyword overlaps
  let synergySignals = 0;
  const oracleTexts = entries.map((e) => {
    const card = cardByName[normalizeKey(e.name)];
    return (card?.oracle_text || '').toLowerCase();
  });
  const etbCount = oracleTexts.filter((t) => t.includes('enters') && t.includes('when')).length;
  const counterCount = oracleTexts.filter((t) => t.includes('+1/+1 counter')).length;
  const sacrificeCount = oracleTexts.filter((t) => t.includes('sacrifice')).length;
  synergySignals = etbCount + counterCount + sacrificeCount;
  const synergy = Math.min(100, Math.round((synergySignals / Math.max(1, entries.length)) * 250));

  // 8. Salt: inverted (low salt = high friendliness)
  const friendliness = Math.max(0, Math.round(100 - salt.score * 10));

  return [
    { label: 'Aggression', value: aggression },
    { label: 'Control', value: control },
    { label: 'Combo', value: combo },
    { label: 'Ramp', value: ramp },
    { label: 'Card Draw', value: cardAdvantage },
    { label: 'Resilience', value: resilience },
    { label: 'Synergy', value: synergy },
    { label: 'Friendly', value: friendliness },
  ];
}

function getDominantTraits(axes: FingerprintAxis[]): string {
  const sorted = [...axes].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 2).filter((a) => a.value > 30);
  const bottom = sorted.filter((a) => a.value < 20).slice(0, 1);

  let desc = '';
  if (top.length >= 2) {
    desc = `High ${top[0].label} + ${top[1].label}`;
  } else if (top.length === 1) {
    desc = `High ${top[0].label}`;
  } else {
    desc = 'Balanced build';
  }
  if (bottom.length > 0) {
    desc += `, Low ${bottom[0].label}`;
  }
  return desc;
}

export function renderDeckFingerprint(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): void {
  container.textContent = '';
  if (deck.boards.mainboard.length === 0) return;

  const axes = computeFingerprint(deck, cardByName);
  const n = axes.length;
  const size = 280;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = 75;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.style.display = 'block';
  svg.style.margin = '0 auto';

  // Draw guide rings (25%, 50%, 75%, 100%)
  for (const pct of [0.25, 0.5, 0.75, 1.0]) {
    const r = maxR * pct;
    const points: string[] = [];
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      points.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
    }
    const polygon = document.createElementNS(svgNs, 'polygon');
    polygon.setAttribute('points', points.join(' '));
    polygon.setAttribute('fill', 'none');
    polygon.setAttribute('stroke', 'rgba(255,255,255,0.06)');
    polygon.setAttribute('stroke-width', '1');
    svg.appendChild(polygon);
  }

  // Draw axis lines
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const line = document.createElementNS(svgNs, 'line');
    line.setAttribute('x1', String(cx));
    line.setAttribute('y1', String(cy));
    line.setAttribute('x2', String(cx + maxR * Math.cos(angle)));
    line.setAttribute('y2', String(cy + maxR * Math.sin(angle)));
    line.setAttribute('stroke', 'rgba(255,255,255,0.08)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
  }

  // Draw data polygon
  const dataPoints: string[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const r = maxR * (axes[i].value / 100);
    dataPoints.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
  }

  const dataPoly = document.createElementNS(svgNs, 'polygon');
  dataPoly.setAttribute('points', dataPoints.join(' '));
  dataPoly.setAttribute('fill', 'rgba(201,168,76,0.15)');
  dataPoly.setAttribute('stroke', '#c9a84c');
  dataPoly.setAttribute('stroke-width', '2');
  svg.appendChild(dataPoly);

  // Draw data points (circles)
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const r = maxR * (axes[i].value / 100);
    const circle = document.createElementNS(svgNs, 'circle');
    circle.setAttribute('cx', String(cx + r * Math.cos(angle)));
    circle.setAttribute('cy', String(cy + r * Math.sin(angle)));
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', '#e8c84a');
    svg.appendChild(circle);
  }

  // Draw axis labels
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const labelR = maxR + 22;
    const x = cx + labelR * Math.cos(angle);
    const y = cy + labelR * Math.sin(angle);

    const text = document.createElementNS(svgNs, 'text');
    text.setAttribute('x', String(x));
    text.setAttribute('y', String(y));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('fill', 'var(--text-dim)');
    text.setAttribute('font-family', "'Outfit', sans-serif");
    text.setAttribute('font-size', '9');
    text.setAttribute('font-weight', '500');
    text.textContent = axes[i].label;
    svg.appendChild(text);
  }

  // Wrap SVG for HTML tooltip overlays
  const chartWrap = document.createElement('div');
  chartWrap.className = 'fingerprint-chart-wrap';
  chartWrap.appendChild(svg);

  const axisDescs: Record<string, string> = {
    'Aggression': 'How fast your deck kills. Based on low-CMC creatures, haste, and direct damage.',
    'Control': 'Disruption density. Counterspells, removal, and exile effects.',
    'Combo': 'Reliance on card combinations. Tutors, draw, and untap effects.',
    'Ramp': 'Mana acceleration. Mana rocks, dorks, and land fetching.',
    'Card Draw': 'Card advantage engines and draw spells.',
    'Resilience': 'Recovery from setbacks. Hexproof, indestructible, recursion.',
    'Synergy': 'How cards interact. ETB triggers, counters, sacrifice themes.',
    'Friendly': 'How pleasant to play against. Inverse of salt score.',
  };

  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const labelR = maxR + 22;
    const x = cx + labelR * Math.cos(angle);
    const y = cy + labelR * Math.sin(angle);

    const hitArea = document.createElement('div');
    hitArea.className = 'fp-axis-hit';
    hitArea.style.left = `${x - 30}px`;
    hitArea.style.top = `${y - 8}px`;

    const tip = document.createElement('div');
    tip.className = 'fp-axis-tooltip';

    const tipTitle = document.createElement('div');
    tipTitle.className = 'fp-axis-title';
    tipTitle.textContent = `${axes[i].label}: ${axes[i].value}/100`;

    const tipDesc = document.createElement('div');
    tipDesc.className = 'fp-axis-desc';
    tipDesc.textContent = axisDescs[axes[i].label] || '';

    tip.append(tipTitle, tipDesc);
    hitArea.appendChild(tip);
    chartWrap.appendChild(hitArea);
  }

  // Description text
  const desc = document.createElement('div');
  desc.className = 'fingerprint-desc';
  desc.textContent = getDominantTraits(axes);

  container.append(chartWrap, desc);
}
