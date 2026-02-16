import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';

interface ColorManaProfile {
  color: string;
  colorName: string;
  pips: number;
  sources: number;
  needed: number;
  deficit: number;
  status: 'ok' | 'tight' | 'deficit';
}

interface ManaBaseAnalysis {
  totalLands: number;
  landTarget: number;
  colors: ColorManaProfile[];
  recommendedLands: string[];
}

const COLOR_NAMES: Record<string, string> = {
  W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green',
};

const COLOR_DOT: Record<string, string> = {
  W: '#f9faf4', U: '#0e68ab', B: '#5a5053', R: '#d3202a', G: '#00733e',
};

// Commonly recommended dual lands by color pair
const DUAL_LAND_SUGGESTIONS: Record<string, string[]> = {
  WU: ['Hallowed Fountain', 'Adarkar Wastes', 'Sea of Clouds'],
  WB: ['Godless Shrine', 'Caves of Koilos', 'Vault of Champions'],
  WR: ['Sacred Foundry', 'Battlefield Forge', 'Spectator Seating'],
  WG: ['Temple Garden', 'Brushland', 'Bountiful Promenade'],
  UB: ['Watery Grave', 'Underground River', 'Morphic Pool'],
  UR: ['Steam Vents', 'Shivan Reef', 'Training Center'],
  UG: ['Breeding Pool', 'Yavimaya Coast', 'Rejuvenating Springs'],
  BR: ['Blood Crypt', 'Sulfurous Springs', 'Luxury Suite'],
  BG: ['Overgrown Tomb', 'Llanowar Wastes', 'Undergrowth Stadium'],
  RG: ['Stomping Ground', 'Karplusan Forest', 'Spire Garden'],
};

const UTILITY_LANDS = ['Command Tower', 'Exotic Orchard', 'Mana Confluence', 'City of Brass', 'Path of Ancestry'];

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function countPips(manaCost: string): Record<string, number> {
  const pips: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const matches = manaCost.match(/\{([WUBRG])}/g) || [];
  for (const m of matches) {
    const c = m[1];
    if (c in pips) pips[c]++;
  }
  return pips;
}

function analyzeManaBase(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): ManaBaseAnalysis {
  const mainboard = deck.boards.mainboard;
  const colorDemand: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const colorSources: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let totalLands = 0;

  // Also count commander pips
  for (const entry of deck.boards.commander) {
    const card = cardByName[normalizeKey(entry.name)];
    if (card?.mana_cost) {
      const pips = countPips(card.mana_cost);
      for (const [c, n] of Object.entries(pips)) colorDemand[c] += n * entry.qty;
    }
  }

  for (const entry of mainboard) {
    const card = cardByName[normalizeKey(entry.name)];
    if (!card) continue;
    const typeLine = (card.type_line || '').toLowerCase();
    const oracle = (card.oracle_text || '').toLowerCase();

    if (typeLine.includes('land')) {
      totalLands += entry.qty;
      for (const c of ['W', 'U', 'B', 'R', 'G']) {
        if (oracle.includes(`add {${c.toLowerCase()}}`) || oracle.includes(`add {${c}}`)) {
          colorSources[c] += entry.qty;
        }
      }
      if (oracle.includes('any color') || oracle.includes('mana of any color') || oracle.includes('mana of any one color')) {
        for (const c of ['W', 'U', 'B', 'R', 'G']) colorSources[c] += entry.qty;
      }
    }

    // Non-land mana sources (mana rocks, dorks)
    if (!typeLine.includes('land') && oracle.includes('add {')) {
      for (const c of ['W', 'U', 'B', 'R', 'G']) {
        if (oracle.includes(`add {${c.toLowerCase()}}`) || oracle.includes(`add {${c}}`)) {
          colorSources[c] += entry.qty;
        }
      }
      if (oracle.includes('any color') || oracle.includes('mana of any color')) {
        for (const c of ['W', 'U', 'B', 'R', 'G']) colorSources[c] += entry.qty;
      }
    }

    // Count demand pips
    if (card.mana_cost) {
      const pips = countPips(card.mana_cost);
      for (const [c, n] of Object.entries(pips)) colorDemand[c] += n * entry.qty;
    }
  }

  // Frank Karsten simplified formula: sources_needed ≈ ceil(pips × 1.1)
  // For commander (100 cards, 37 lands), we use a softer ratio
  const activeColors: ColorManaProfile[] = [];
  for (const c of ['W', 'U', 'B', 'R', 'G']) {
    if (colorDemand[c] === 0) continue;
    const needed = Math.ceil(colorDemand[c] * 1.1);
    const deficit = needed - colorSources[c];
    let status: 'ok' | 'tight' | 'deficit' = 'ok';
    if (deficit > 2) status = 'deficit';
    else if (deficit > 0) status = 'tight';
    activeColors.push({
      color: c,
      colorName: COLOR_NAMES[c],
      pips: colorDemand[c],
      sources: colorSources[c],
      needed,
      deficit: Math.max(0, deficit),
      status,
    });
  }

  // Recommend lands
  const recommendedLands: string[] = [];
  const deckCardNames = new Set(
    [...mainboard, ...deck.boards.commander].map((e) => normalizeKey(e.name)),
  );

  // If multi-color and missing Command Tower
  if (activeColors.length >= 2 && !deckCardNames.has('command tower')) {
    recommendedLands.push('Command Tower');
  }

  // Find color pairs with deficits
  const deficitColors = activeColors.filter((c) => c.status !== 'ok').map((c) => c.color);
  if (deficitColors.length >= 2) {
    for (let i = 0; i < deficitColors.length; i++) {
      for (let j = i + 1; j < deficitColors.length; j++) {
        const pair = [deficitColors[i], deficitColors[j]].sort().join('');
        const duals = DUAL_LAND_SUGGESTIONS[pair] || [];
        for (const land of duals) {
          if (!deckCardNames.has(normalizeKey(land)) && !recommendedLands.includes(land)) {
            recommendedLands.push(land);
          }
        }
      }
    }
  } else if (deficitColors.length === 1) {
    // Find pairs that include the deficit color
    for (const c of activeColors.map((ac) => ac.color)) {
      if (c === deficitColors[0]) continue;
      const pair = [deficitColors[0], c].sort().join('');
      const duals = DUAL_LAND_SUGGESTIONS[pair] || [];
      for (const land of duals) {
        if (!deckCardNames.has(normalizeKey(land)) && !recommendedLands.includes(land)) {
          recommendedLands.push(land);
        }
      }
    }
  }

  // Always suggest utility lands if missing
  for (const land of UTILITY_LANDS) {
    if (!deckCardNames.has(normalizeKey(land)) && activeColors.length >= 2 && !recommendedLands.includes(land)) {
      recommendedLands.push(land);
    }
  }

  return { totalLands, landTarget: 37, colors: activeColors, recommendedLands: recommendedLands.slice(0, 8) };
}

export function renderManaCalc(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): void {
  container.textContent = '';
  if (deck.boards.mainboard.length === 0) return;

  const analysis = analyzeManaBase(deck, cardByName);

  // Land count summary
  const landRow = document.createElement('div');
  landRow.className = 'mana-calc-summary';
  const landDiff = analysis.totalLands - analysis.landTarget;
  const landColor = Math.abs(landDiff) <= 2 ? '#34d399' : Math.abs(landDiff) <= 4 ? '#e8c84a' : '#ef4444';
  landRow.innerHTML = `<span>Lands: <strong style="color:${landColor}">${analysis.totalLands}</strong> / ${analysis.landTarget} target</span>`;
  if (landDiff < -2) {
    landRow.innerHTML += `<span class="mana-calc-warn">Need ${Math.abs(landDiff)} more lands</span>`;
  } else if (landDiff > 4) {
    landRow.innerHTML += `<span class="mana-calc-warn">Consider cutting ${landDiff - 2} lands</span>`;
  }
  container.appendChild(landRow);

  if (analysis.colors.length === 0) return;

  // Color table
  const table = document.createElement('div');
  table.className = 'mana-calc-table';

  // Header
  const headerRow = document.createElement('div');
  headerRow.className = 'mana-calc-row mana-calc-header';
  headerRow.innerHTML = '<span>Color</span><span>Pips</span><span>Sources</span><span>Need</span><span>Status</span>';
  table.appendChild(headerRow);

  for (const color of analysis.colors) {
    const row = document.createElement('div');
    row.className = `mana-calc-row mana-calc-${color.status}`;

    const dot = document.createElement('span');
    dot.className = 'mana-calc-color';
    dot.innerHTML = `<span class="mana-dot" style="background:${COLOR_DOT[color.color]}"></span>${color.colorName}`;

    const pips = document.createElement('span');
    pips.textContent = String(color.pips);

    const sources = document.createElement('span');
    sources.textContent = String(color.sources);

    const needed = document.createElement('span');
    needed.textContent = String(color.needed);

    const status = document.createElement('span');
    status.className = 'mana-calc-status';
    if (color.status === 'ok') {
      status.textContent = 'OK';
      status.style.color = '#34d399';
    } else if (color.status === 'tight') {
      status.textContent = `-${color.deficit}`;
      status.style.color = '#e8c84a';
    } else {
      status.textContent = `-${color.deficit}`;
      status.style.color = '#ef4444';
    }

    row.append(dot, pips, sources, needed, status);
    table.appendChild(row);
  }

  container.appendChild(table);

  // ── Pip Distribution Donut ──
  const totalPips = analysis.colors.reduce((s, c) => s + c.pips, 0);
  if (totalPips > 0) {
    const pipSection = document.createElement('div');
    pipSection.className = 'mana-pip-section';

    const pipHeader = document.createElement('div');
    pipHeader.className = 'mana-calc-recs-label';
    pipHeader.textContent = 'Color Pip Distribution';
    pipSection.appendChild(pipHeader);

    const pipChart = document.createElement('div');
    pipChart.className = 'mana-pip-chart';

    // SVG donut (reusing pattern from renderColorDonut)
    const size = 80;
    const radius = 30;
    const circumference = 2 * Math.PI * radius;
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

    let offset = 0;
    for (const color of analysis.colors) {
      const pct = color.pips / totalPips;
      const dash = pct * circumference;
      const circle = document.createElementNS(svgNs, 'circle');
      circle.setAttribute('cx', '40');
      circle.setAttribute('cy', '40');
      circle.setAttribute('r', String(radius));
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', COLOR_DOT[color.color] || '#666');
      circle.setAttribute('stroke-width', '10');
      circle.setAttribute('stroke-dasharray', `${dash} ${circumference - dash}`);
      circle.setAttribute('stroke-dashoffset', String(-offset));
      circle.setAttribute('transform', 'rotate(-90 40 40)');
      svg.appendChild(circle);
      offset += dash;
    }

    // Center total
    const centerText = document.createElementNS(svgNs, 'text');
    centerText.setAttribute('x', '40');
    centerText.setAttribute('y', '40');
    centerText.setAttribute('text-anchor', 'middle');
    centerText.setAttribute('dominant-baseline', 'central');
    centerText.setAttribute('fill', 'var(--text, #e0e0e0)');
    centerText.setAttribute('font-size', '13');
    centerText.setAttribute('font-weight', '700');
    centerText.setAttribute('font-family', "'JetBrains Mono', monospace");
    centerText.textContent = String(totalPips);
    svg.appendChild(centerText);

    pipChart.appendChild(svg);

    // Legend
    const pipLegend = document.createElement('div');
    pipLegend.className = 'mana-pip-legend';
    for (const color of analysis.colors) {
      const pct = Math.round((color.pips / totalPips) * 100);
      const item = document.createElement('div');
      item.className = 'mana-pip-legend-item';
      item.innerHTML = `<span class="mana-dot" style="background:${COLOR_DOT[color.color]}"></span>` +
        `<span class="mana-pip-legend-name">${color.colorName}</span>` +
        `<span class="mana-pip-legend-val">${color.pips} pips (${pct}%)</span>`;
      pipLegend.appendChild(item);
    }
    pipChart.appendChild(pipLegend);
    pipSection.appendChild(pipChart);
    container.appendChild(pipSection);
  }

  // ── Source vs Demand Comparison Bars ──
  if (analysis.colors.length > 0) {
    const compareSection = document.createElement('div');
    compareSection.className = 'mana-compare-section';

    const compareHeader = document.createElement('div');
    compareHeader.className = 'mana-calc-recs-label';
    compareHeader.textContent = 'Mana Sources vs Demand';
    compareSection.appendChild(compareHeader);

    const maxVal = Math.max(
      ...analysis.colors.map((c) => Math.max(c.pips, c.sources, c.needed)),
      1,
    );

    for (const color of analysis.colors) {
      const row = document.createElement('div');
      row.className = 'mana-compare-row';

      // Color label
      const label = document.createElement('div');
      label.className = 'mana-compare-label';
      label.innerHTML = `<span class="mana-dot" style="background:${COLOR_DOT[color.color]}"></span>${color.colorName}`;

      // Bars container
      const bars = document.createElement('div');
      bars.className = 'mana-compare-bars';

      // Demand bar (pips)
      const demandRow = document.createElement('div');
      demandRow.className = 'mana-compare-bar-row';
      const demandLabel = document.createElement('span');
      demandLabel.className = 'mana-compare-bar-label';
      demandLabel.textContent = 'Demand';
      const demandTrack = document.createElement('div');
      demandTrack.className = 'mana-compare-bar-track';
      const demandFill = document.createElement('div');
      demandFill.className = 'mana-compare-bar-fill mana-compare-demand';
      demandFill.style.width = `${(color.pips / maxVal) * 100}%`;
      const demandVal = document.createElement('span');
      demandVal.className = 'mana-compare-bar-val';
      demandVal.textContent = `${color.pips} pips`;
      demandTrack.appendChild(demandFill);
      demandRow.append(demandLabel, demandTrack, demandVal);

      // Supply bar (sources)
      const supplyRow = document.createElement('div');
      supplyRow.className = 'mana-compare-bar-row';
      const supplyLabel = document.createElement('span');
      supplyLabel.className = 'mana-compare-bar-label';
      supplyLabel.textContent = 'Supply';
      const supplyTrack = document.createElement('div');
      supplyTrack.className = 'mana-compare-bar-track';
      const supplyFill = document.createElement('div');
      const supplyStatusColor =
        color.status === 'ok' ? '#34d399' : color.status === 'tight' ? '#e8c84a' : '#ef4444';
      supplyFill.className = 'mana-compare-bar-fill';
      supplyFill.style.width = `${(color.sources / maxVal) * 100}%`;
      supplyFill.style.background = supplyStatusColor;
      const supplyVal = document.createElement('span');
      supplyVal.className = 'mana-compare-bar-val';
      supplyVal.textContent = `${color.sources} sources`;
      supplyTrack.appendChild(supplyFill);
      supplyRow.append(supplyLabel, supplyTrack, supplyVal);

      bars.append(demandRow, supplyRow);
      row.append(label, bars);
      compareSection.appendChild(row);
    }

    container.appendChild(compareSection);
  }

  // ── Enhanced Recommendation Cards ──
  const deficitColors = analysis.colors.filter((c) => c.status !== 'ok');
  if (deficitColors.length > 0) {
    const recCardsSection = document.createElement('div');
    recCardsSection.className = 'mana-rec-cards';

    for (const color of deficitColors) {
      const totalSrc = analysis.colors.reduce((s, c) => s + c.sources, 0) || 1;
      const demandPct = Math.round((color.pips / totalPips) * 100);
      const supplyPct = Math.round((color.sources / totalSrc) * 100);

      const card = document.createElement('div');
      card.className = `mana-rec-card mana-rec-${color.status}`;
      card.innerHTML =
        `<div class="mana-rec-card-header">` +
        `<span class="mana-dot" style="background:${COLOR_DOT[color.color]};width:12px;height:12px"></span>` +
        `<strong>${color.colorName}</strong>` +
        `</div>` +
        `<div class="mana-rec-card-body">` +
        `${demandPct}% of pips need ${color.colorName.toLowerCase()}, but only ${supplyPct}% of sources produce it. ` +
        `Add <strong>${color.deficit} more</strong> ${color.colorName.toLowerCase()} source${color.deficit !== 1 ? 's' : ''}.` +
        `</div>`;
      recCardsSection.appendChild(card);
    }

    container.appendChild(recCardsSection);
  }

  // Recommended lands
  if (analysis.recommendedLands.length > 0) {
    const recsLabel = document.createElement('div');
    recsLabel.className = 'mana-calc-recs-label';
    recsLabel.textContent = 'Recommended Lands';
    container.appendChild(recsLabel);

    const recsList = document.createElement('div');
    recsList.className = 'mana-calc-recs';
    for (const land of analysis.recommendedLands) {
      const tag = document.createElement('span');
      tag.className = 'mana-calc-rec-tag';
      tag.textContent = land;
      recsList.appendChild(tag);
    }
    container.appendChild(recsList);
  }
}

// Export analysis function for external use
export { analyzeManaBase, type ManaBaseAnalysis, type ColorManaProfile };
