import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import { showHoverPreview, hideHoverPreview } from './card-preview.js';

interface HandTesterState {
  library: string[];
  hand: string[];
  mulliganCount: number;
  mulliganPicks: Set<number>;
  inMulliganMode: boolean;
  sortMode: 'draw' | 'cmc' | 'type';
}

let state: HandTesterState | null = null;
let resolvedMap: Record<string, DeckbuilderSearchCard | undefined> = {};

// ── Mulligan Session Statistics ──
interface MulliganStats {
  handsDrawn: number;
  totalMulligans: number;
  handsKept: number;
}
let sessionStats: MulliganStats = { handsDrawn: 0, totalMulligans: 0, handsKept: 0 };

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function normalizeNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function shuffle(arr: string[]): string[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Type hierarchy for sorting ──
const TYPE_ORDER: Record<string, number> = {
  land: 0, creature: 1, planeswalker: 2, artifact: 3,
  enchantment: 4, instant: 5, sorcery: 6, battle: 7,
};

function getCardTypePriority(card: DeckbuilderSearchCard | undefined): number {
  if (!card?.type_line) return 8;
  const lower = card.type_line.toLowerCase();
  for (const [key, val] of Object.entries(TYPE_ORDER)) {
    if (lower.includes(key)) return val;
  }
  return 8;
}

/** Returns array of original indices in sorted display order. */
function getSortedIndices(hand: string[], mode: 'draw' | 'cmc' | 'type'): number[] {
  const indices = hand.map((_, i) => i);
  if (mode === 'draw') return indices;
  if (mode === 'cmc') {
    indices.sort((a, b) => {
      const ca = resolvedMap[normalizeNameKey(hand[a])];
      const cb = resolvedMap[normalizeNameKey(hand[b])];
      return (ca?.cmc ?? 99) - (cb?.cmc ?? 99);
    });
  } else {
    // type, then CMC
    indices.sort((a, b) => {
      const ca = resolvedMap[normalizeNameKey(hand[a])];
      const cb = resolvedMap[normalizeNameKey(hand[b])];
      const diff = getCardTypePriority(ca) - getCardTypePriority(cb);
      if (diff !== 0) return diff;
      return (ca?.cmc ?? 99) - (cb?.cmc ?? 99);
    });
  }
  return indices;
}

function buildLibrary(deck: DeckbuilderDeck): string[] {
  const cards: string[] = [];
  for (const entry of deck.boards.mainboard) {
    for (let i = 0; i < entry.qty; i++) cards.push(entry.name);
  }
  for (const entry of deck.boards.commander) {
    for (let i = 0; i < entry.qty; i++) cards.push(entry.name);
  }
  return shuffle(cards);
}

function drawCards(count: number): string[] {
  if (!state) return [];
  const drawn = state.library.splice(0, count);
  return drawn;
}

function renderHandQuality(): void {
  if (!state) return;
  let qualityBar = document.getElementById('handQualityBar');
  if (!qualityBar) {
    qualityBar = document.createElement('div');
    qualityBar.id = 'handQualityBar';
    qualityBar.className = 'hand-quality';
    const cards = byId<HTMLDivElement>('handTesterCards');
    cards.parentNode?.insertBefore(qualityBar, cards.nextSibling);
  }
  qualityBar.textContent = '';

  const hand = state.hand;
  let landCount = 0;
  let cmcSum = 0;
  let nonLandCount = 0;
  const colorsAvailable = new Set<string>();

  for (const name of hand) {
    const card = resolvedMap[normalizeNameKey(name)];
    const typeLine = card?.type_line?.toLowerCase() || '';
    if (typeLine.includes('land')) {
      landCount++;
      // Land colors from color_identity
      if (card?.color_identity) {
        for (const c of card.color_identity) colorsAvailable.add(c);
      }
    } else {
      nonLandCount++;
      cmcSum += card?.cmc ?? 0;
    }
  }

  // Verdict
  let verdict = '';
  let verdictClass = '';
  if (hand.length === 0) return;
  if (landCount === 0) {
    verdict = 'No lands!'; verdictClass = 'quality-bad';
  } else if (landCount === 1) {
    verdict = 'Risky — 1 land'; verdictClass = 'quality-warn';
  } else if (landCount >= 2 && landCount <= 4) {
    verdict = 'Keepable'; verdictClass = 'quality-good';
  } else if (landCount === 5) {
    verdict = 'Land-heavy'; verdictClass = 'quality-warn';
  } else {
    verdict = 'Flooded!'; verdictClass = 'quality-bad';
  }

  const verdictEl = document.createElement('span');
  verdictEl.className = `hand-verdict ${verdictClass}`;
  verdictEl.textContent = verdict;

  const stats: string[] = [];
  stats.push(`${landCount} land${landCount !== 1 ? 's' : ''}`);
  if (nonLandCount > 0) stats.push(`Avg CMC ${(cmcSum / nonLandCount).toFixed(1)}`);
  if (colorsAvailable.size > 0) stats.push(`Colors: ${Array.from(colorsAvailable).sort().join('')}`);

  const statsEl = document.createElement('span');
  statsEl.className = 'hand-stat';
  statsEl.textContent = stats.join(' · ');

  qualityBar.append(verdictEl, statsEl);
}

function renderSessionStats(): void {
  let statsBar = document.getElementById('handSessionStats');
  if (!statsBar) {
    statsBar = document.createElement('div');
    statsBar.id = 'handSessionStats';
    statsBar.className = 'hand-session-stats';
    const actions = document.querySelector('.hand-tester-actions');
    if (actions) actions.parentNode?.insertBefore(statsBar, actions);
  }
  if (sessionStats.handsDrawn < 2) {
    statsBar.style.display = 'none';
    return;
  }
  statsBar.style.display = '';
  const avgMulls = sessionStats.handsDrawn > 0
    ? (sessionStats.totalMulligans / sessionStats.handsDrawn).toFixed(1) : '0';
  const keepPct = sessionStats.handsDrawn > 0
    ? Math.round((sessionStats.handsKept / sessionStats.handsDrawn) * 100) : 0;
  statsBar.textContent = `Session: ${sessionStats.handsDrawn} hands | Avg mulls: ${avgMulls} | Kept: ${keepPct}%`;
}

function renderHand(): void {
  if (!state) return;
  const container = byId<HTMLDivElement>('handTesterCards');
  container.textContent = '';

  const sortedIndices = getSortedIndices(state.hand, state.sortMode);

  for (const origIndex of sortedIndices) {
    const name = state.hand[origIndex];
    const card = resolvedMap[normalizeNameKey(name)];
    const imgSrc = card?.image_uris?.normal || card?.image_uris?.small || '';

    const el = document.createElement('div');
    el.className = 'hand-card';
    if (state.inMulliganMode && state.mulliganPicks.has(origIndex)) {
      el.classList.add('mulligan-pick');
    }

    if (imgSrc) {
      const img = document.createElement('img');
      img.src = imgSrc;
      img.alt = name;
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        const ph = document.createElement('div');
        ph.className = 'hand-card-placeholder';
        ph.textContent = name;
        img.replaceWith(ph);
      });
      el.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'hand-card-placeholder';
      ph.textContent = name;
      el.appendChild(ph);
    }

    // Click: in mulligan mode, toggle bottom pick; otherwise hover preview
    el.addEventListener('click', () => {
      if (state?.inMulliganMode) {
        if (state.mulliganPicks.has(origIndex)) state.mulliganPicks.delete(origIndex);
        else state.mulliganPicks.add(origIndex);
        renderHand();
        updateInfo();
      }
    });

    if (card) {
      el.addEventListener('mouseenter', (e) => showHoverPreview(card, e));
      el.addEventListener('mouseleave', () => hideHoverPreview());
    }

    container.appendChild(el);
  }

  renderHandQuality();
}

function updateInfo(): void {
  if (!state) return;
  const infoEl = byId<HTMLSpanElement>('handTesterInfo');
  infoEl.textContent = `${state.library.length} cards remaining`;

  const mulliganInfo = byId<HTMLSpanElement>('handMulliganInfo');
  if (state.inMulliganMode) {
    const needed = state.mulliganCount;
    const picked = state.mulliganPicks.size;
    mulliganInfo.textContent = `Click ${needed - picked} card(s) to put on bottom, then click Mulligan again`;
    mulliganInfo.style.color = picked >= needed ? 'var(--cobalt)' : 'var(--warn)';
  } else if (state.mulliganCount > 0) {
    mulliganInfo.textContent = `Mulliganed to ${7 - state.mulliganCount}`;
    mulliganInfo.style.color = '';
  } else {
    mulliganInfo.textContent = '';
  }
}

export function openHandTester(deck: DeckbuilderDeck, cardByName: Record<string, DeckbuilderSearchCard | undefined>): void {
  resolvedMap = cardByName;
  const library = buildLibrary(deck);
  const hand = library.splice(0, 7);

  // Track: if previous hand existed and wasn't mulliganed, count as "kept"
  if (state && !state.inMulliganMode) {
    sessionStats.handsKept++;
  }
  // First open = reset session stats
  if (!state) {
    sessionStats = { handsDrawn: 0, totalMulligans: 0, handsKept: 0 };
  }
  sessionStats.handsDrawn++;

  state = {
    library,
    hand,
    mulliganCount: 0,
    mulliganPicks: new Set(),
    inMulliganMode: false,
    sortMode: state?.sortMode || 'draw',
  };

  byId<HTMLDivElement>('handTesterOverlay').style.display = '';
  renderHand();
  renderSessionStats();
  updateInfo();
}

export function closeHandTester(): void {
  state = null;
  byId<HTMLDivElement>('handTesterOverlay').style.display = 'none';
}

function initSortButtons(): void {
  const header = document.querySelector('.hand-tester-header');
  if (!header || document.getElementById('handSortGroup')) return;

  const group = document.createElement('div');
  group.id = 'handSortGroup';
  group.className = 'hand-sort-group';

  const modes: Array<{ label: string; value: 'draw' | 'cmc' | 'type' }> = [
    { label: 'Draw', value: 'draw' },
    { label: 'CMC', value: 'cmc' },
    { label: 'Type', value: 'type' },
  ];

  for (const m of modes) {
    const btn = document.createElement('button');
    btn.className = `btn hand-sort-btn${m.value === 'draw' ? ' active' : ''}`;
    btn.textContent = m.label;
    btn.dataset.sortMode = m.value;
    btn.addEventListener('click', () => {
      if (!state) return;
      state.sortMode = m.value;
      group.querySelectorAll('.hand-sort-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderHand();
    });
    group.appendChild(btn);
  }

  // Insert before close button
  const closeBtn = header.querySelector('.search-sidebar-close');
  if (closeBtn) header.insertBefore(group, closeBtn);
  else header.appendChild(group);
}

function runMonteCarloSim(deck: DeckbuilderDeck, runs: number = 1000): void {
  const cards: string[] = [];
  for (const entry of deck.boards.mainboard) {
    for (let i = 0; i < entry.qty; i++) cards.push(entry.name);
  }
  for (const entry of deck.boards.commander) {
    for (let i = 0; i < entry.qty; i++) cards.push(entry.name);
  }
  if (cards.length < 7) return;

  // Pre-classify card types
  const isLand = new Set<string>();
  for (const name of cards) {
    const card = resolvedMap[normalizeNameKey(name)];
    if (card?.type_line?.toLowerCase().includes('land')) isLand.add(name);
  }

  let hands2Plus = 0;
  let hands3Plus = 0;
  let totalLands = 0;
  let totalCmc = 0;

  for (let r = 0; r < runs; r++) {
    // Fisher-Yates shuffle (inline for perf)
    const lib = [...cards];
    for (let i = lib.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lib[i], lib[j]] = [lib[j], lib[i]];
    }
    const hand = lib.slice(0, 7);
    let landCount = 0;
    let cmcSum = 0;
    let nonLandCount = 0;
    for (const name of hand) {
      if (isLand.has(name)) {
        landCount++;
      } else {
        nonLandCount++;
        const card = resolvedMap[normalizeNameKey(name)];
        cmcSum += card?.cmc ?? 0;
      }
    }
    if (landCount >= 2) hands2Plus++;
    if (landCount >= 3) hands3Plus++;
    totalLands += landCount;
    totalCmc += nonLandCount > 0 ? cmcSum / nonLandCount : 0;
  }

  // Render results
  let grid = document.getElementById('simResultsGrid');
  if (!grid) {
    grid = document.createElement('div');
    grid.id = 'simResultsGrid';
    grid.className = 'sim-results-grid';
    const actions = document.querySelector('.hand-tester-actions');
    if (actions) actions.after(grid);
  }
  grid.innerHTML = '';

  const stats = [
    { label: '≥2 Lands', value: `${Math.round((hands2Plus / runs) * 100)}%` },
    { label: '≥3 Lands', value: `${Math.round((hands3Plus / runs) * 100)}%` },
    { label: 'Avg Lands', value: (totalLands / runs).toFixed(1) },
    { label: 'Avg CMC', value: (totalCmc / runs).toFixed(1) },
  ];

  for (const s of stats) {
    const stat = document.createElement('div');
    stat.className = 'sim-stat';
    const val = document.createElement('span');
    val.className = 'sim-stat-value';
    val.textContent = s.value;
    const lbl = document.createElement('span');
    lbl.className = 'sim-stat-label';
    lbl.textContent = s.label;
    stat.append(val, lbl);
    grid.appendChild(stat);
  }
}

export function initHandTester(getDeck: () => DeckbuilderDeck | null, getCardByName: () => Record<string, DeckbuilderSearchCard | undefined>): void {
  byId<HTMLButtonElement>('btnTestHand').addEventListener('click', () => {
    const deck = getDeck();
    if (!deck) return;
    openHandTester(deck, getCardByName());
  });

  byId<HTMLButtonElement>('handTesterClose').addEventListener('click', closeHandTester);

  byId<HTMLDivElement>('handTesterOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeHandTester();
  });

  initSortButtons();

  byId<HTMLButtonElement>('btnNewHand').addEventListener('click', () => {
    const deck = getDeck();
    if (!deck) return;
    openHandTester(deck, getCardByName());
  });

  byId<HTMLButtonElement>('btnMulligan').addEventListener('click', () => {
    if (!state) return;

    if (state.inMulliganMode) {
      // Finish mulligan: put picked cards on bottom
      const pickedIndices = Array.from(state.mulliganPicks).sort((a, b) => b - a);
      const bottomCards: string[] = [];
      for (const idx of pickedIndices) {
        bottomCards.push(state.hand.splice(idx, 1)[0]);
      }
      state.library.push(...bottomCards);
      state.inMulliganMode = false;
      state.mulliganPicks.clear();
      renderHand();
      updateInfo();
      return;
    }

    // Start London mulligan: reshuffle all, draw 7, then pick N to bottom
    const deck = getDeck();
    if (!deck) return;
    resolvedMap = getCardByName();
    const library = buildLibrary(deck);
    const hand = library.splice(0, 7);
    state.mulliganCount++;
    sessionStats.totalMulligans++;
    state.library = library;
    state.hand = hand;
    state.inMulliganMode = true;
    state.mulliganPicks = new Set();
    renderHand();
    renderSessionStats();
    updateInfo();
  });

  byId<HTMLButtonElement>('btnDrawCard').addEventListener('click', () => {
    if (!state || state.inMulliganMode) return;
    if (state.library.length === 0) return;
    const drawn = drawCards(1);
    state.hand.push(...drawn);
    renderHand();
    updateInfo();
  });

  // Monte Carlo simulation button (injected dynamically)
  const actions = document.querySelector('.hand-tester-actions');
  if (actions && !document.getElementById('btnSimulate1000')) {
    const simBtn = document.createElement('button');
    simBtn.id = 'btnSimulate1000';
    simBtn.className = 'btn';
    simBtn.textContent = 'Simulate 1000';
    simBtn.style.marginLeft = 'auto';
    simBtn.addEventListener('click', () => {
      const deck = getDeck();
      if (!deck) return;
      resolvedMap = getCardByName();
      runMonteCarloSim(deck, 1000);
    });
    actions.appendChild(simBtn);
  }
}
