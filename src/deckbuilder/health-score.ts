import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';

interface HealthRecommendation {
  text: string;
  searchQuery?: string;
}

interface HealthComponent {
  label: string;
  score: number;
  weight: number;
  detail: string;
  recommendations: HealthRecommendation[];
}

interface HealthResult {
  total: number;
  components: HealthComponent[];
}

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

export function calculateDeckHealth(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): HealthResult {
  const mainboard = deck.boards.mainboard;
  const commander = deck.boards.commander;
  const allEntries = [...commander, ...mainboard];
  const totalCards = allEntries.reduce((s, e) => s + e.qty, 0);

  // ── 1. Mana Base (25%) ──
  let landCount = 0;
  const colorSources: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const colorDemand: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };

  for (const entry of mainboard) {
    const card = cardByName[normalizeKey(entry.name)];
    if (!card) continue;
    const typeLine = (card.type_line || '').toLowerCase();
    const oracle = (card.oracle_text || '').toLowerCase();

    if (typeLine.includes('land')) {
      landCount += entry.qty;
      // Count which colors this land produces
      for (const c of ['W', 'U', 'B', 'R', 'G']) {
        if (oracle.includes(`add {${c.toLowerCase()}}`) || oracle.includes(`add {${c}}`)) {
          colorSources[c] += entry.qty;
        }
      }
      if (oracle.includes('mana of any color') || oracle.includes('any color')) {
        for (const c of ['W', 'U', 'B', 'R', 'G']) colorSources[c] += entry.qty;
      }
    }

    // Count pips for demand
    if (card.mana_cost) {
      const pips = countPips(card.mana_cost);
      for (const [c, n] of Object.entries(pips)) {
        colorDemand[c] += n * entry.qty;
      }
    }
  }

  const landTarget = 37;
  const landDiff = Math.abs(landCount - landTarget);
  const landScore = Math.max(0, 100 - landDiff * 8);

  // Color source adequacy
  const activeColors = Object.entries(colorDemand).filter(([, v]) => v > 0);
  let colorAdequacy = 100;
  if (activeColors.length > 0) {
    let totalRatio = 0;
    for (const [c, demand] of activeColors) {
      const needed = Math.ceil(demand * 0.8);
      const have = colorSources[c] || 0;
      totalRatio += Math.min(1, have / Math.max(1, needed));
    }
    colorAdequacy = Math.round((totalRatio / activeColors.length) * 100);
  }
  const manaBaseScore = Math.round(landScore * 0.6 + colorAdequacy * 0.4);

  // ── 2. Curve Efficiency (20%) ──
  let totalCmc = 0;
  let nonlandCards = 0;
  let lowCmcCount = 0; // CMC 0-2
  for (const entry of mainboard) {
    const card = cardByName[normalizeKey(entry.name)];
    if (!card) continue;
    const typeLine = (card.type_line || '').toLowerCase();
    if (typeLine.includes('land')) continue;
    totalCmc += (card.cmc || 0) * entry.qty;
    nonlandCards += entry.qty;
    if ((card.cmc || 0) <= 2) lowCmcCount += entry.qty;
  }
  const avgCmc = nonlandCards > 0 ? totalCmc / nonlandCards : 0;
  // Optimal avg CMC for EDH: 2.8-3.5
  let curveScore = 100;
  if (avgCmc < 2.0) curveScore -= 20;
  else if (avgCmc < 2.5) curveScore -= 5;
  else if (avgCmc > 4.0) curveScore -= 30;
  else if (avgCmc > 3.5) curveScore -= 15;
  // Penalty for no early plays
  if (lowCmcCount < 8) curveScore -= (8 - lowCmcCount) * 3;
  curveScore = Math.max(0, Math.min(100, curveScore));

  // ── 3. Interaction Density (20%) ──
  let interactionCount = 0;
  for (const entry of mainboard) {
    const card = cardByName[normalizeKey(entry.name)];
    if (!card?.oracle_text) continue;
    const text = card.oracle_text.toLowerCase();
    const isInteraction =
      text.includes('destroy target') ||
      text.includes('exile target') ||
      text.includes('counter target') ||
      text.includes('return target') ||
      text.includes('deals damage to') ||
      text.includes('each opponent sacrifices') ||
      text.includes('protection from');
    if (isInteraction) interactionCount += entry.qty;
  }
  const interactionTarget = 13;
  const interactionScore = Math.min(100, Math.round((interactionCount / interactionTarget) * 100));

  // ── 4. Role Coverage (20%) ──
  let rampCount = 0;
  let drawCount = 0;
  for (const entry of mainboard) {
    const card = cardByName[normalizeKey(entry.name)];
    if (!card?.oracle_text) continue;
    const text = card.oracle_text.toLowerCase();
    if (text.includes('search your library for a') && text.includes('land')) rampCount += entry.qty;
    else if (text.includes('add {') || (text.includes('mana') && text.includes('add'))) rampCount += entry.qty;
    if (text.includes('draw a card') || text.includes('draw cards') || text.includes('draw two')) drawCount += entry.qty;
  }
  const rampTarget = 10;
  const drawTarget = 10;
  const rampRatio = Math.min(1, rampCount / rampTarget);
  const drawRatio = Math.min(1, drawCount / drawTarget);
  const interactionRatio = Math.min(1, interactionCount / interactionTarget);
  const roleCoverageScore = Math.round(((rampRatio + drawRatio + interactionRatio) / 3) * 100);

  // ── 5. Deck Size Compliance (15%) ──
  let sizeScore = 100;
  if (totalCards !== 100) {
    sizeScore -= Math.abs(totalCards - 100) * 5;
  }
  // Check singleton
  const basicLands = new Set(['plains', 'island', 'swamp', 'mountain', 'forest',
    'wastes', 'snow-covered plains', 'snow-covered island', 'snow-covered swamp',
    'snow-covered mountain', 'snow-covered forest']);
  const seen = new Map<string, number>();
  for (const entry of mainboard) {
    const key = normalizeKey(entry.name);
    if (basicLands.has(key)) continue;
    const prev = seen.get(key) || 0;
    seen.set(key, prev + entry.qty);
    if (prev + entry.qty > 1) sizeScore -= 10;
  }
  sizeScore = Math.max(0, Math.min(100, sizeScore));

  // ── Generate Recommendations ──
  const manaRecs: HealthRecommendation[] = [];
  if (landCount < landTarget - 2) {
    manaRecs.push({ text: `Add ${landTarget - landCount} more lands`, searchQuery: 'type:land' });
  } else if (landCount > landTarget + 3) {
    manaRecs.push({ text: `Consider cutting ${landCount - landTarget} lands` });
  }
  const colorNames: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
  for (const [c, demand] of activeColors) {
    const needed = Math.ceil(demand * 0.8);
    const have = colorSources[c] || 0;
    if (have < needed) {
      manaRecs.push({
        text: `Need more ${colorNames[c]} sources (${have}/${needed})`,
        searchQuery: `type:land oracle:"add {${c}}"`,
      });
    }
  }

  const curveRecs: HealthRecommendation[] = [];
  if (avgCmc > 3.8) {
    curveRecs.push({ text: 'Average CMC is high \u2014 add more low-cost spells', searchQuery: 'cmc<=2' });
  } else if (avgCmc < 2.2 && nonlandCards > 20) {
    curveRecs.push({ text: 'Average CMC is very low \u2014 consider higher-impact cards' });
  }
  if (lowCmcCount < 8) {
    curveRecs.push({ text: `Add ${8 - lowCmcCount} more early plays (CMC 0\u20132)`, searchQuery: 'cmc<=2' });
  }

  const interactionRecs: HealthRecommendation[] = [];
  if (interactionCount < interactionTarget) {
    interactionRecs.push({
      text: `Add ${interactionTarget - interactionCount} more interaction pieces`,
      searchQuery: 'oracle:"destroy target" OR oracle:"exile target" OR oracle:"counter target"',
    });
  }

  const roleRecs: HealthRecommendation[] = [];
  if (rampCount < rampTarget) {
    roleRecs.push({ text: `Add ${rampTarget - rampCount} more ramp cards`, searchQuery: 'oracle:"add {" type:artifact OR oracle:"search your library" oracle:land' });
  }
  if (drawCount < drawTarget) {
    roleRecs.push({ text: `Add ${drawTarget - drawCount} more card draw`, searchQuery: 'oracle:"draw a card"' });
  }

  const sizeRecs: HealthRecommendation[] = [];
  if (totalCards < 100) {
    sizeRecs.push({ text: `Need ${100 - totalCards} more cards to reach 100` });
  } else if (totalCards > 100) {
    sizeRecs.push({ text: `Cut ${totalCards - 100} cards to reach 100` });
  }

  // ── Composite ──
  const components: HealthComponent[] = [
    { label: 'Mana Base', score: manaBaseScore, weight: 0.25, detail: `${landCount} lands, ${activeColors.length} colors`, recommendations: manaRecs },
    { label: 'Curve', score: curveScore, weight: 0.20, detail: `Avg CMC ${avgCmc.toFixed(1)}, ${lowCmcCount} low-cost`, recommendations: curveRecs },
    { label: 'Interaction', score: interactionScore, weight: 0.20, detail: `${interactionCount}/${interactionTarget} interaction pieces`, recommendations: interactionRecs },
    { label: 'Role Coverage', score: roleCoverageScore, weight: 0.20, detail: `Ramp ${rampCount}, Draw ${drawCount}`, recommendations: roleRecs },
    { label: 'Deck Size', score: sizeScore, weight: 0.15, detail: `${totalCards}/100 cards`, recommendations: sizeRecs },
  ];

  const total = Math.round(components.reduce((s, c) => s + c.score * c.weight, 0));

  return { total, components };
}

export function renderHealthScore(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): void {
  container.textContent = '';
  if (deck.boards.mainboard.length === 0) return;

  const result = calculateDeckHealth(deck, cardByName);
  const score = result.total;

  // Color based on score
  let color: string;
  if (score >= 70) color = '#34d399';
  else if (score >= 40) color = '#e8c84a';
  else color = '#ef4444';

  // SVG Gauge
  const size = 80;
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const dashLen = (score / 100) * circumference * 0.75; // 270deg arc
  const gapLen = circumference - dashLen;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

  // Background track (270deg arc)
  const track = document.createElementNS(svgNs, 'circle');
  track.setAttribute('cx', '40');
  track.setAttribute('cy', '40');
  track.setAttribute('r', String(radius));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'rgba(255,255,255,0.06)');
  track.setAttribute('stroke-width', '6');
  track.setAttribute('stroke-dasharray', `${circumference * 0.75} ${circumference * 0.25}`);
  track.setAttribute('stroke-linecap', 'round');
  track.setAttribute('transform', 'rotate(135 40 40)');
  svg.appendChild(track);

  // Score arc
  const arc = document.createElementNS(svgNs, 'circle');
  arc.setAttribute('cx', '40');
  arc.setAttribute('cy', '40');
  arc.setAttribute('r', String(radius));
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', color);
  arc.setAttribute('stroke-width', '6');
  arc.setAttribute('stroke-dasharray', `${dashLen} ${gapLen}`);
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('transform', 'rotate(135 40 40)');
  svg.appendChild(arc);

  // Score text in center
  const text = document.createElementNS(svgNs, 'text');
  text.setAttribute('x', '40');
  text.setAttribute('y', '42');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('fill', color);
  text.setAttribute('font-family', "'JetBrains Mono', monospace");
  text.setAttribute('font-weight', '700');
  text.setAttribute('font-size', '16');
  text.textContent = String(score);
  svg.appendChild(text);

  // Label below gauge
  const labelText = document.createElementNS(svgNs, 'text');
  labelText.setAttribute('x', '40');
  labelText.setAttribute('y', '62');
  labelText.setAttribute('text-anchor', 'middle');
  labelText.setAttribute('fill', 'var(--text-dim)');
  labelText.setAttribute('font-family', "'Outfit', sans-serif");
  labelText.setAttribute('font-size', '8');
  labelText.setAttribute('font-weight', '500');
  labelText.textContent = 'HEALTH';
  svg.appendChild(labelText);

  // Wrapper with tooltip
  const wrapper = document.createElement('div');
  wrapper.className = 'health-gauge';

  // Tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'health-tooltip';
  for (const comp of result.components) {
    const row = document.createElement('div');
    row.className = 'health-tooltip-row';

    const name = document.createElement('span');
    name.textContent = comp.label;

    const bar = document.createElement('div');
    bar.className = 'health-tooltip-bar';
    const fill = document.createElement('div');
    fill.className = 'health-tooltip-fill';
    fill.style.width = `${comp.score}%`;
    fill.style.background = comp.score >= 70 ? '#34d399' : comp.score >= 40 ? '#e8c84a' : '#ef4444';
    bar.appendChild(fill);

    const val = document.createElement('span');
    val.textContent = String(comp.score);

    row.append(name, bar, val);
    tooltip.appendChild(row);

    // Actionable recommendations for this component
    if (comp.recommendations.length > 0) {
      for (const rec of comp.recommendations) {
        const recEl = document.createElement('div');
        recEl.className = 'health-rec';
        recEl.textContent = rec.text;
        if (rec.searchQuery) {
          recEl.style.cursor = 'pointer';
          recEl.title = 'Click to search';
          recEl.addEventListener('click', () => {
            const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
            if (searchInput) {
              searchInput.value = rec.searchQuery!;
              searchInput.dispatchEvent(new Event('input', { bubbles: true }));
              searchInput.focus();
            }
          });
        }
        tooltip.appendChild(recEl);
      }
    }
  }

  wrapper.append(svg, tooltip);
  container.appendChild(wrapper);
}
