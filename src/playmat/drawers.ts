// ==================== Playmat Drawers ====================
// Floating action buttons (Analyse · Goldfish · Teilen · Import) plus the
// sortbar HUD. Reuses the deckbuilder analyse/export/import libraries;
// only the small curve/color tally lives here.

import { iconSvg } from '../shared/icons.js';
import { showToast } from '../deckbuilder/toast.js';
import { renderHealthScore, calculateDeckHealth } from '../deckbuilder/health-score.js';
import { renderSynergyMap } from '../deckbuilder/synergy-map.js';
import { renderDrawProbability } from '../deckbuilder/draw-probability.js';
import { evaluateEdhRules } from '../deckbuilder/edh-rules.js';
import { getFormatRules } from '../deckbuilder/live-validation.js';
import { classifyRole, ROLE_PROB_KEYS } from '../deckbuilder/role-classifier.js';
import { openGoldfishPlaytest } from '../deckbuilder/goldfish.js';
import { serializeDeckForExport, type DeckExportFormat } from '../shared/deck-export.js';
import { generateShareUrl } from '../shared/deck-sharing.js';
import { generatePrintHTML } from '../shared/features/print-proxy.js';
import { downloadDeckImage } from '../deckbuilder/deck-image.js';
import {
  parseDeckbuilderImportText,
  resolveParsedImportLines,
  toBoardsFromResolvedImport,
  mergeBoards,
  type ImportResolvedLine,
} from '../deckbuilder/import-resolver.js';
import { resolveDeckbuilderCards, fetchDeckbuilderAutocomplete } from '../shared/scryfall-client.js';
import type { DeckbuilderImportUnresolved } from '../deckbuilder/types.js';
import type { DeckEntry } from '../shared/types.js';
import {
  EV_DECK_CHANGED, EV_CARDS_RESOLVED, EV_SORT_CHANGED, mutateDeck, resolveMissing,
  normalizeNameKey, type PlaymatState,
} from './state.js';

type DrawerKind = 'analyse' | 'share' | 'import';

let stateRef: PlaymatState;
let drawerEl: HTMLElement;
let openDrawer: DrawerKind | null = null;
let unresolvedRows: DeckbuilderImportUnresolved[] = [];

// ── small local tallies ──

const CURVE_BUCKETS = ['0', '1', '2', '3', '4', '5', '6', '7+'] as const;
const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'] as const;
const COLOR_HEX: Record<string, string> = {
  W: '#e8e2c8', U: '#5a8fc0', B: '#8a7a96', R: '#d06a4a', G: '#6a9a6a',
};

function curveTally(state: PlaymatState): number[] {
  const buckets = new Array(CURVE_BUCKETS.length).fill(0);
  for (const entry of state.deck.boards.mainboard) {
    const card = state.cardByName[normalizeNameKey(entry.name)];
    if (!card || (card.type_line || '').toLowerCase().includes('land')) continue;
    const slot = Math.min(Math.max(Math.round(card.cmc), 0), 7);
    buckets[slot] += entry.qty;
  }
  return buckets;
}

function colorTally(state: PlaymatState): Record<string, number> {
  const counts: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const entry of state.deck.boards.mainboard) {
    const card = state.cardByName[normalizeNameKey(entry.name)];
    for (const c of card?.color_identity || []) {
      if (c in counts) counts[c] += entry.qty;
    }
  }
  return counts;
}

function deckStats(state: PlaymatState): { total: number; avgMv: number; lands: number } {
  let total = 0;
  let lands = 0;
  let mvSum = 0;
  let mvCount = 0;
  for (const entry of state.deck.boards.mainboard) {
    total += entry.qty;
    const card = state.cardByName[normalizeNameKey(entry.name)];
    if (!card) continue;
    if ((card.type_line || '').toLowerCase().includes('land')) {
      lands += entry.qty;
    } else {
      mvSum += card.cmc * entry.qty;
      mvCount += entry.qty;
    }
  }
  return { total, avgMv: mvCount > 0 ? mvSum / mvCount : 0, lands };
}

function roleTagTally(state: PlaymatState): Record<string, number> {
  const tags: Record<string, number> = {};
  for (const entry of state.deck.boards.mainboard) {
    const card = state.cardByName[normalizeNameKey(entry.name)];
    if (!card) continue;
    const label = ROLE_PROB_KEYS[classifyRole(card)];
    tags[label] = (tags[label] || 0) + entry.qty;
  }
  return tags;
}

function toExportEntries(entries: Array<{ name: string; qty: number; set?: string | null; collectorNumber?: string | null }>): DeckEntry[] {
  return entries.map((e) => ({ name: e.name, qty: e.qty, set: e.set ?? null, num: e.collectorNumber ?? null }));
}

// ── drawer shell ──

function closeDrawer(): void {
  openDrawer = null;
  drawerEl.classList.remove('open');
  drawerEl.setAttribute('aria-hidden', 'true');
  drawerEl.textContent = '';
  document.querySelectorAll('.pm-action-btn.active').forEach((b) => b.classList.remove('active'));
}

function openDrawerPanel(kind: DrawerKind): void {
  if (openDrawer === kind) { closeDrawer(); return; }
  closeDrawer();
  openDrawer = kind;
  drawerEl.classList.add('open');
  drawerEl.setAttribute('aria-hidden', 'false');
  document.querySelector(`.pm-action-btn[data-drawer="${kind}"]`)?.classList.add('active');

  const titles: Record<DrawerKind, string> = { analyse: 'Analytics', share: 'Share & Export', import: 'Import' };
  const head = document.createElement('div');
  head.className = 'pm-drawer-head';
  head.innerHTML = `<h2>${titles[kind]}</h2>`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pm-drawer-close';
  close.innerHTML = iconSvg('x');
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeDrawer);
  head.appendChild(close);

  const body = document.createElement('div');
  body.className = 'pm-drawer-body';
  drawerEl.append(head, body);

  if (kind === 'analyse') renderAnalyse(body);
  else if (kind === 'share') renderShare(body);
  else renderImport(body);
}

// ── Analyse ──

function renderAnalyse(body: HTMLElement): void {
  const stats = deckStats(stateRef);

  const cards = document.createElement('div');
  cards.className = 'pm-stat-cards';
  const statCard = (label: string, value: string): string =>
    `<div class="pm-stat-card"><span class="pm-stat-value">${value}</span><span class="pm-stat-label">${label}</span></div>`;
  cards.innerHTML =
    statCard('Cards', String(stats.total)) +
    statCard('Avg Mana Value', stats.avgMv.toFixed(1)) +
    statCard('Lands', String(stats.lands));
  body.appendChild(cards);

  // Curve
  const curve = curveTally(stateRef);
  const maxCurve = Math.max(...curve, 1);
  const curveBox = document.createElement('div');
  curveBox.className = 'pm-analyse-section';
  curveBox.innerHTML = '<h3>Mana Curve</h3>';
  const bars = document.createElement('div');
  bars.className = 'pm-curve';
  curve.forEach((count, i) => {
    const col = document.createElement('div');
    col.className = 'pm-curve-col';
    col.innerHTML = `
      <span class="pm-curve-count">${count || ''}</span>
      <div class="pm-curve-bar" style="height:${Math.round((count / maxCurve) * 72)}px"></div>
      <span class="pm-curve-mv">${CURVE_BUCKETS[i]}</span>`;
    bars.appendChild(col);
  });
  curveBox.appendChild(bars);
  body.appendChild(curveBox);

  // Colors
  const colors = colorTally(stateRef);
  const colorTotal = COLOR_ORDER.reduce((s, c) => s + colors[c], 0);
  const colorBox = document.createElement('div');
  colorBox.className = 'pm-analyse-section';
  colorBox.innerHTML = '<h3>Colors</h3>';
  const dots = document.createElement('div');
  dots.className = 'pm-colors';
  for (const c of COLOR_ORDER) {
    if (colors[c] === 0) continue;
    const pct = colorTotal > 0 ? Math.round((colors[c] / colorTotal) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'pm-color-row';
    row.innerHTML = `
      <span class="pm-color-dot" style="background:${COLOR_HEX[c]}"></span>
      <span class="pm-color-name">${c}</span>
      <div class="pm-color-track"><div class="pm-color-fill" style="width:${pct}%;background:${COLOR_HEX[c]}"></div></div>
      <span class="pm-color-pct">${pct}%</span>`;
    dots.appendChild(row);
  }
  if (colorTotal === 0) dots.innerHTML = '<span class="pm-muted">No color data yet.</span>';
  colorBox.appendChild(dots);
  body.appendChild(colorBox);

  // Health
  const healthBox = document.createElement('div');
  healthBox.className = 'pm-analyse-section';
  healthBox.innerHTML = '<h3>Deck Health</h3>';
  const healthHost = document.createElement('div');
  renderHealthScore(healthHost, stateRef.deck, stateRef.cardByName);
  healthBox.appendChild(healthHost);
  body.appendChild(healthBox);

  // Mehr: synergy map + draw probability
  const more = document.createElement('details');
  more.className = 'pm-analyse-more';
  more.innerHTML = '<summary>More analytics</summary>';
  const moreBody = document.createElement('div');
  more.appendChild(moreBody);
  let moreRendered = false;
  more.addEventListener('toggle', () => {
    if (!more.open || moreRendered) return;
    moreRendered = true;
    const syn = document.createElement('div');
    syn.className = 'pm-analyse-section';
    syn.innerHTML = '<h3>Synergies</h3>';
    const synHost = document.createElement('div');
    renderSynergyMap(synHost, stateRef.deck, stateRef.cardByName);
    syn.appendChild(synHost);
    const draw = document.createElement('div');
    draw.className = 'pm-analyse-section';
    draw.innerHTML = '<h3>Draw Probability</h3>';
    const drawHost = document.createElement('div');
    renderDrawProbability(drawHost, roleTagTally(stateRef), deckStats(stateRef).total, stateRef.deck.boards.mainboard);
    draw.appendChild(drawHost);
    moreBody.append(syn, draw);
  });
  body.appendChild(more);
}

// ── Teilen ──

function currentExportText(format: DeckExportFormat): string {
  const b = stateRef.deck.boards;
  return serializeDeckForExport(
    { main: toExportEntries(b.mainboard), sideboard: toExportEntries(b.sideboard), commander: toExportEntries(b.commander) },
    { format, deckName: stateRef.deck.name },
  );
}

async function copyText(text: string, okMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast({ message: okMessage, type: 'success', duration: 1800 });
  } catch {
    showToast({ message: 'Copy failed — please select the text manually.', type: 'error' });
  }
}

function renderShare(body: HTMLElement): void {
  body.innerHTML = `
    <div class="pm-share-row">
      <label for="pmExportFormat">Format</label>
      <select id="pmExportFormat">
        <option value="text">Text</option>
        <option value="arena">Arena</option>
        <option value="mtgo">MTGO</option>
        <option value="moxfield">Moxfield</option>
        <option value="csv">CSV</option>
        <option value="json">JSON</option>
      </select>
    </div>
    <textarea id="pmExportText" class="pm-export-text" readonly rows="14" aria-label="Deck export"></textarea>
    <div class="pm-share-actions">
      <button type="button" id="pmCopyExport" class="pm-btn">${iconSvg('clipboard')} Copy</button>
      <button type="button" id="pmShareLink" class="pm-btn">${iconSvg('link')} Share link</button>
      <button type="button" id="pmDeckImage" class="pm-btn">${iconSvg('image')} Image (PNG)</button>
      <button type="button" id="pmPrintProxies" class="pm-btn">${iconSvg('printer')} Print</button>
    </div>`;

  const select = body.querySelector<HTMLSelectElement>('#pmExportFormat')!;
  const textarea = body.querySelector<HTMLTextAreaElement>('#pmExportText')!;
  const refresh = (): void => { textarea.value = currentExportText(select.value as DeckExportFormat); };
  select.addEventListener('change', refresh);
  refresh();

  body.querySelector('#pmCopyExport')!.addEventListener('click', () => {
    void copyText(textarea.value, 'Deck list copied.');
  });

  body.querySelector('#pmShareLink')!.addEventListener('click', () => {
    const b = stateRef.deck.boards;
    try {
      const result = generateShareUrl({
        name: stateRef.deck.name,
        main: toExportEntries(b.mainboard),
        sideboard: toExportEntries(b.sideboard),
        commander: toExportEntries(b.commander),
      }, 'mtg');
      void copyText(result.url, 'Share link copied.');
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : 'Could not create share link.', type: 'error' });
    }
  });

  body.querySelector('#pmDeckImage')!.addEventListener('click', () => {
    showToast({ message: 'Creating image …', type: 'info', duration: 1500 });
    downloadDeckImage(stateRef.deck, stateRef.cardByName).catch((err) => {
      showToast({ message: err instanceof Error ? err.message : 'Image export failed.', type: 'error' });
    });
  });

  body.querySelector('#pmPrintProxies')!.addEventListener('click', () => {
    const b = stateRef.deck.boards;
    const entries = [...b.commander, ...b.mainboard].map((e) => ({
      name: e.name,
      qty: e.qty,
      imageUrl: stateRef.cardByName[normalizeNameKey(e.name)]?.image_uris?.normal,
    }));
    if (entries.length === 0) {
      showToast({ message: 'No cards to print.', type: 'info' });
      return;
    }
    const win = window.open('', '_blank');
    if (!win) {
      showToast({ message: 'Popup blocked — please allow popups.', type: 'error' });
      return;
    }
    win.document.write(generatePrintHTML(entries, { showNames: true }));
    win.document.close();
  });
}

// ── Import ──

function renderImport(body: HTMLElement): void {
  body.innerHTML = `
    <p class="pm-muted">One card per line, e.g. <code>1 Sol Ring</code>. Section headers like <code>Commander:</code> or <code>Sideboard:</code> are recognized.</p>
    <textarea id="pmImportText" class="pm-import-text" rows="12" placeholder="4 Lightning Bolt&#10;1 Sol Ring&#10;Sideboard:&#10;2 Negate"></textarea>
    <div class="pm-share-actions">
      <label class="pm-btn pm-file-btn">${iconSvg('file')} Load file
        <input type="file" id="pmImportFile" accept=".txt,.dec,.dek,.csv" hidden>
      </label>
      <button type="button" id="pmImportRun" class="pm-btn pm-btn-primary">${iconSvg('import')} Import</button>
    </div>
    <div id="pmImportUnresolved" class="pm-import-unresolved"></div>`;

  const textarea = body.querySelector<HTMLTextAreaElement>('#pmImportText')!;
  const fileInput = body.querySelector<HTMLInputElement>('#pmImportFile')!;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file.text().then((text) => { textarea.value = text; });
  });
  textarea.addEventListener('dragover', (e) => e.preventDefault());
  textarea.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    void file.text().then((text) => { textarea.value = text; });
  });

  body.querySelector('#pmImportRun')!.addEventListener('click', () => {
    void runImport(textarea.value);
  });
}

async function runImport(raw: string): Promise<void> {
  const parsed = parseDeckbuilderImportText(raw);
  if (parsed.errors.length > 0) {
    showToast({ message: parsed.errors.slice(0, 3).join(' | '), type: 'error' });
  }
  if (parsed.lines.length === 0) {
    showToast({ message: 'No import lines found.', type: 'info' });
    return;
  }

  const names = Array.from(new Set(parsed.lines.map((line) => line.name)));
  let resolvedResponse: Awaited<ReturnType<typeof resolveDeckbuilderCards>>;
  try {
    resolvedResponse = await resolveDeckbuilderCards(names);
  } catch (error) {
    showToast({
      message: error instanceof Error ? error.message : 'Could not load card data.',
      type: 'error',
      duration: 6000,
    });
    return;
  }

  const suggestionsByName: Record<string, string[]> = {};
  for (const missing of resolvedResponse.missing.slice(0, 20)) {
    try {
      const suggestions = await fetchDeckbuilderAutocomplete(missing);
      suggestionsByName[normalizeNameKey(missing)] = suggestions.slice(0, 8);
    } catch {
      suggestionsByName[normalizeNameKey(missing)] = [];
    }
  }

  const resolution = resolveParsedImportLines({
    lines: parsed.lines,
    resolvedByName: resolvedResponse.resolved,
    suggestionsByName,
  });

  for (const [apiKey, value] of Object.entries(resolvedResponse.resolved)) {
    stateRef.cardByName[normalizeNameKey(apiKey)] = value;
  }

  if (resolution.resolved.length > 0) {
    mutateDeck(stateRef, (d) => {
      d.boards = mergeBoards(d.boards, toBoardsFromResolvedImport(resolution.resolved));
    });
    void resolveMissing(stateRef);
  }

  unresolvedRows = resolution.unresolved;
  renderUnresolvedRows();
  showToast({
    message: `${resolution.resolved.length} lines imported${resolution.unresolved.length > 0 ? `, ${resolution.unresolved.length} unresolved` : ''}.`,
    type: resolution.unresolved.length > 0 ? 'info' : 'success',
  });
}

function renderUnresolvedRows(): void {
  const container = document.getElementById('pmImportUnresolved');
  if (!container) return;
  container.textContent = '';
  if (unresolvedRows.length === 0) return;

  const head = document.createElement('h3');
  head.textContent = `Unresolved (${unresolvedRows.length})`;
  container.appendChild(head);

  for (const row of unresolvedRows) {
    const box = document.createElement('div');
    box.className = 'pm-unresolved-row';
    const label = document.createElement('span');
    label.textContent = `${row.qty}× ${row.name}`;
    const select = document.createElement('select');
    select.dataset.lineNumber = String(row.lineNumber);
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = row.reason === 'missing' ? 'No match' : 'Choose a card';
    select.appendChild(empty);
    for (const candidate of row.candidates) {
      const option = document.createElement('option');
      option.value = candidate;
      option.textContent = candidate;
      select.appendChild(option);
    }
    box.append(label, select);
    container.appendChild(box);
  }

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'pm-btn pm-btn-primary';
  apply.textContent = 'Apply selection';
  apply.addEventListener('click', applyUnresolvedSelection);
  container.appendChild(apply);
}

function applyUnresolvedSelection(): void {
  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('#pmImportUnresolved select[data-line-number]'));
  const chosen: ImportResolvedLine[] = [];
  const remaining: DeckbuilderImportUnresolved[] = [];

  for (const row of unresolvedRows) {
    const select = selects.find((item) => item.dataset.lineNumber === String(row.lineNumber));
    const selected = select?.value.trim() || '';
    if (!selected) {
      remaining.push(row);
      continue;
    }
    chosen.push({
      lineNumber: row.lineNumber,
      board: row.board,
      qty: row.qty,
      originalName: row.name,
      resolvedName: selected,
    });
  }

  if (chosen.length > 0) {
    mutateDeck(stateRef, (d) => {
      d.boards = mergeBoards(d.boards, toBoardsFromResolvedImport(chosen));
    });
    void resolveMissing(stateRef);
  }
  unresolvedRows = remaining;
  renderUnresolvedRows();
}

// ── HUD ──

function renderHud(): void {
  const hud = document.getElementById('pmHud');
  if (!hud) return;
  const stats = deckStats(stateRef);
  const health = calculateDeckHealth(stateRef.deck, stateRef.cardByName);

  let legalityText: string;
  let legalityOk: boolean;
  const format = stateRef.deck.format || 'commander';
  if (format === 'commander') {
    const result = evaluateEdhRules(stateRef.deck, stateRef.cardByName);
    const errors = result.issues.filter((i) => i.severity === 'error');
    legalityOk = errors.length === 0;
    legalityText = legalityOk ? 'Legal' : `${errors.length} rule issue${errors.length === 1 ? '' : 's'}`;
  } else if (format !== 'none') {
    const rules = getFormatRules(format);
    legalityOk = stats.total >= rules.minDeckSize;
    legalityText = legalityOk ? 'Legal' : `Min. ${rules.minDeckSize} cards`;
  } else {
    legalityOk = true;
    legalityText = 'Open';
  }

  hud.innerHTML = `
    <span class="pm-hud-item">Health <strong>${health.total}</strong></span>
    <span class="pm-hud-item">Avg MV <strong>${stats.avgMv.toFixed(1)}</strong></span>
    <span class="pm-hud-item">Lands <strong>${stats.lands}</strong></span>
    <span class="pm-hud-item ${legalityOk ? 'pm-hud-ok' : 'pm-hud-warn'}">${legalityOk ? iconSvg('check') : iconSvg('warn')} ${legalityText}</span>`;
  hud.title = 'Click to open analytics';
}

// ── init ──

export function initDrawers(state: PlaymatState): void {
  stateRef = state;
  drawerEl = document.getElementById('pmDrawer')!;

  const actions = document.getElementById('pmActions')!;
  actions.textContent = '';
  const actionBtn = (kind: string, icon: string, label: string): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pm-action-btn';
    btn.dataset.drawer = kind;
    btn.innerHTML = `${iconSvg(icon)}<span>${label}</span>`;
    return btn;
  };

  const analyseBtn = actionBtn('analyse', 'chart', 'Analytics');
  analyseBtn.addEventListener('click', () => openDrawerPanel('analyse'));
  const goldfishBtn = actionBtn('goldfish', 'dice', 'Goldfish');
  goldfishBtn.addEventListener('click', () => openGoldfishPlaytest(state.deck, state.cardByName));
  const shareBtn = actionBtn('share', 'export', 'Share');
  shareBtn.addEventListener('click', () => openDrawerPanel('share'));
  const importBtn = actionBtn('import', 'import', 'Import');
  importBtn.addEventListener('click', () => openDrawerPanel('import'));
  actions.append(analyseBtn, goldfishBtn, shareBtn, importBtn);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openDrawer) closeDrawer();
  });

  // #pmHud is re-created by every sortbar render — delegate the click.
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest?.('#pmHud')) openDrawerPanel('analyse');
  });

  const refresh = (): void => {
    renderHud();
    if (openDrawer === 'analyse') {
      const body = drawerEl.querySelector<HTMLElement>('.pm-drawer-body');
      if (body) { body.textContent = ''; renderAnalyse(body); }
    }
  };
  document.addEventListener(EV_DECK_CHANGED, refresh);
  document.addEventListener(EV_CARDS_RESOLVED, refresh);
  document.addEventListener(EV_SORT_CHANGED, refresh);
  renderHud();
}
